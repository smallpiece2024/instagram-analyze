/**
 * `register-token`: `.env` のトークンを `debug_token` で調べ、`accounts`、`private.credentials`、Vault に登録する
 * （設計 4.1 章）。
 *
 * - `.env` の `META_ACCESS_TOKEN` を読むのはこのコマンドと `verify-api` だけ。登録が済めば `.env` から消してよい
 * - `debug_token` の呼び出しは `raw_api_responses` に保存しない（生の `GraphClient.get` を使う）
 * - 出力は種類、有効期限の有無、データアクセス期限の残り日数、権限だけ。トークン、ID、ユーザー名は出さない
 * - 同じトークンで 2 回実行しても結果は同じ（upsert）
 * - `accounts` → Vault → `private.credentials` は同じトランザクションでこの順に書く（`accounts` の行ロックで
 *   同時実行時の `vault.secrets.name` の競合が直列化される）
 */
import { parseArgs } from "node:util";
import { loadRegisterTokenConfig } from "../config.js";
import { upsertAccount, upsertCredential, type CredentialInfo } from "../db/accounts.js";
import type { TokenType } from "../db/types.js";
import { GraphClient, type DebugTokenData } from "../lib/graph.js";
import { closeJobDeps, createJobDeps, describeError } from "../jobs/framework.js";

/** `debug_token` の `data`（`lib/graph.ts` の型をそのまま使う） */
export type { DebugTokenData } from "../lib/graph.js";

/** 収集に必要な権限（設計 4.1 章。`pages_show_list` は `me/accounts` にだけ要るので含めない） */
export const REQUIRED_SCOPES: readonly string[] = [
  "instagram_basic",
  "instagram_manage_insights",
  "pages_read_engagement",
];

/** `toCredentialInfo` の結果 */
export interface ParsedCredential {
  credential: CredentialInfo;
  /** 足りない権限 */
  missing: string[];
  /** ページトークンなら `profile_id`（Facebook ページの ID）、それ以外は null */
  fbPageId: string | null;
}

/** テスト用の注入。`env` は `process.env` の代わり */
export interface RegisterTokenDeps {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

interface IgUserData {
  id?: string;
  username?: string;
  name?: string;
}

const COMMAND = "register-token";
const DAY_MS = 24 * 60 * 60 * 1000;

function toTokenType(type: string | undefined): TokenType | undefined {
  return type === "PAGE" || type === "USER" ? type : undefined;
}

/** UNIX 秒を `Date` に。0、undefined、数値でないものは null（期限なし／不明） */
function unixToDate(seconds: unknown): Date | null {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null;
}

function daysLeft(until: Date | null, now: Date): number | undefined {
  return until ? Math.floor((until.getTime() - now.getTime()) / DAY_MS) : undefined;
}

/**
 * `debug_token` の結果から `private.credentials` に入れる値を組み立てる純粋関数。
 * 種類が `PAGE`／`USER` 以外（`APP` など）なら undefined。必要な権限がそろえば `valid`、欠ければ `insufficient_scope`
 */
export function toCredentialInfo(info: DebugTokenData): ParsedCredential | undefined {
  const tokenType = toTokenType(info.type);
  if (!tokenType) return undefined;
  const scopes = Array.isArray(info.scopes) ? info.scopes.filter((s): s is string => typeof s === "string") : [];
  const missing = REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope));
  return {
    credential: {
      token_type: tokenType,
      expires_at: unixToDate(info.expires_at),
      data_access_expires_at: unixToDate(info.data_access_expires_at),
      scopes,
      status: missing.length === 0 ? "valid" : "insufficient_scope",
    },
    missing,
    fbPageId: tokenType === "PAGE" && typeof info.profile_id === "string" && info.profile_id ? info.profile_id : null,
  };
}

export async function registerToken(args: string[], deps: RegisterTokenDeps = {}): Promise<boolean> {
  try {
    parseArgs({ args, options: {}, strict: true, allowPositionals: false });
  } catch {
    throw new Error(`${COMMAND} は引数を取らない`);
  }

  const config = loadRegisterTokenConfig(deps.env);
  const jobDeps = createJobDeps(config, { secretsToAdd: [config.accessToken], fetchImpl: deps.fetchImpl, now: deps.now });
  const { db, log, secrets } = jobDeps;
  const now = deps.now?.() ?? new Date();

  try {
    const graph = new GraphClient(config.accessToken, config.graphApiVersion, 200, deps.fetchImpl);

    // 1. debug_token（アプリトークンで。生レスポンスは保存しない）
    const debug = await graph.debugToken(`${config.metaAppId}|${config.metaAppSecret}`);
    const info = debug.data?.data;
    if (!debug.ok || !info) {
      log.warn({ command: COMMAND, status: "failed", error: "debug_token に失敗", error_code: debug.error?.code ?? "none" });
      return false;
    }
    if (!info.is_valid) {
      log.warn({ command: COMMAND, status: "failed", error: "トークンが無効（debug_token）" });
      return false;
    }
    const parsed = toCredentialInfo(info);
    if (!parsed) {
      log.warn({ command: COMMAND, status: "failed", error: "対応していないトークンの種類（PAGE か USER のみ）" });
      return false;
    }

    // 2. 登録するトークンでアカウントに届くことを確かめる
    const me = await graph.get<IgUserData>(config.igUserId, { fields: "id,username,name" });
    if (!me.ok || !me.data?.id) {
      log.warn({
        command: COMMAND,
        status: "failed",
        error: "Instagram アカウントに届かない（IG_USER_ID とトークンの組み合わせを確認する）",
        error_code: me.error?.code ?? "none",
      });
      return false;
    }
    const profile = me.data;

    // 3. 1 つのトランザクションで accounts → Vault → private.credentials を upsert
    const { credential, missing, fbPageId } = parsed;
    await db.begin(async (tx) => {
      const account = await upsertAccount(tx, {
        ig_user_id: config.igUserId,
        username: profile.username ?? null,
        name: profile.name ?? null,
        fb_page_id: fbPageId,
      });
      await upsertCredential(tx, account.id, config.accessToken, credential);
    });

    log.info({
      command: COMMAND,
      status: "registered",
      token_type: credential.token_type,
      expires: credential.expires_at ? "あり" : "なし",
      expires_days_left: daysLeft(credential.expires_at, now),
      data_access_days_left: daysLeft(credential.data_access_expires_at, now),
      scopes: credential.scopes.join(","),
      credential_status: credential.status,
    });
    if (missing.length > 0) {
      log.warn({
        command: COMMAND,
        status: "insufficient_scope",
        missing_scopes: missing.join(","),
        hint: "登録はしたが、収集に必要な権限が足りない。再承認して register-token をやり直す",
      });
    }
    return true;
  } catch (error) {
    const failure = describeError(error, secrets);
    log.warn({ command: COMMAND, status: "failed", error_code: failure.code ?? "none", class: failure.errorClass });
    log.debug({ command: COMMAND, error: failure.message });
    return false;
  } finally {
    await closeJobDeps(jobDeps);
  }
}
