/**
 * Facebook Login の開始とコールバックの処理（設計 2.1 章、2.3 章、2.5 章）。
 *
 * Route Handler は Cookie の読み書きとリダイレクトだけを行い、流れはここに置く。`fetch`、`db`、`env`、`random`、
 * 登録関数、ログの出力先を `deps` で受け取り、偽の `fetch` と偽の登録関数でテストできるようにしている。
 *
 * - `handleCallback` は例外を投げない。何が起きても理由コードを返す
 * - ログは `console.warn`（既定）に 1 行。設計 2.5 章の内容だけ（Graph のコード、件数、固定語、変数名）。
 *   トークン、`code`、URL、ID、例外オブジェクト、`error_description` を含めない
 */
import type { Db } from "@/lib/db";
import { debugToken, exchangeCode, exchangeLongLived, getPageToken, listPages } from "@/lib/meta-graph";
import {
  buildAuthorizeUrl,
  generateState,
  isLoggableErrorReason,
  parseTokenResponse,
  redirectUri,
  selectCandidates,
  toCredentialInfo,
  validateCode,
  verifyState,
  type ReasonCode,
} from "@/lib/meta-oauth";
import { registerCredential, type RegisterCredentialInput, type RegisterCredentialResult } from "@/lib/queries/register-credential";

/** `readEnv()` の結果のうち、接続に要る項目（`WebEnv` がそのまま当てはまる） */
export interface ConnectEnv {
  metaAppId: string;
  metaAppSecret: string;
  graphApiVersion: string;
  appUrl: string;
  targetIgUserId: string | undefined;
}

export interface ConnectDeps {
  fetch: typeof fetch;
  db: Db;
  env: ConnectEnv;
  /** テスト用。`state` の乱数 */
  random?: (bytes: number) => Uint8Array;
  /** テスト用。既定は `registerCredential` */
  register?: (db: Db, input: RegisterCredentialInput) => Promise<RegisterCredentialResult>;
  /** テスト用。既定は `console.warn` */
  log?: (line: string) => void;
}

export interface CallbackInput {
  code?: string;
  state?: string;
  cookieState?: string;
  error?: string;
  errorReason?: string;
}

export interface CallbackOutcome {
  result: ReasonCode;
  /** `ok` のとき、登録したアカウント（ユーザー名だけ） */
  registered?: { username: string | null }[];
}

const LOG_PREFIX = "[meta-connect]";

/** 認可 URL と `state` を作る。Cookie への保存とリダイレクトは Route Handler が行う */
export function startLogin(deps: Pick<ConnectDeps, "env" | "random">): { url: string; state: string } {
  const state = generateState(deps.random);
  const url = buildAuthorizeUrl(
    { appId: deps.env.metaAppId, graphApiVersion: deps.env.graphApiVersion, appUrl: deps.env.appUrl },
    state,
  );
  return { url, state };
}

function fail(log: (line: string) => void, result: ReasonCode, detail?: string): CallbackOutcome {
  log(`${LOG_PREFIX} result=${result}${detail ? ` ${detail}` : ""}`);
  return { result };
}

function graphDetail(failure: { status: number; code?: number }): string {
  return `status=${failure.status} code=${failure.code ?? "none"}`;
}

/**
 * コールバックの処理。設計 2.1 章の順序で検査と呼び出しを行い、理由コードを返す。
 * 例外は `unknown` にして固定文言だけをログに出す
 */
export async function handleCallback(input: CallbackInput, deps: ConnectDeps): Promise<CallbackOutcome> {
  const log = deps.log ?? ((line: string) => console.warn(line));
  try {
    return await run(input, deps, log);
  } catch {
    return fail(log, "unknown", "例外");
  }
}

async function run(input: CallbackInput, deps: ConnectDeps, log: (line: string) => void): Promise<CallbackOutcome> {
  const { env } = deps;
  const graph = { graphApiVersion: env.graphApiVersion, fetchImpl: deps.fetch };

  // 1. state（CSRF）
  if (typeof input.state !== "string" || input.state.length === 0) return fail(log, "invalid_request", "state なし");
  if (!verifyState(input.cookieState, input.state)) {
    return fail(log, "state_mismatch", input.cookieState ? "不一致" : "cookie なし");
  }

  // 2. ユーザーが許可しなかった（内容を問わず denied。error_description は見ない）
  if (input.error !== undefined && input.error !== "") {
    return fail(log, "denied", isLoggableErrorReason(input.errorReason) ? `error_reason=${input.errorReason}` : undefined);
  }

  // 3. code の形
  if (!validateCode(input.code)) return fail(log, "invalid_request", "code の形が不正");

  // 4. code → 短期ユーザートークン
  const short = await exchangeCode(
    { appId: env.metaAppId, appSecret: env.metaAppSecret, redirectUri: redirectUri(env.appUrl), code: input.code },
    graph,
  );
  if (!short.ok) return fail(log, "token_exchange_failed", `step=code ${graphDetail(short)}`);
  const shortToken = parseTokenResponse(short.data);
  if (!shortToken.ok) return fail(log, "token_exchange_failed", `step=code code=${shortToken.code ?? "none"}`);

  // 5. 短期 → 長期ユーザートークン
  const long = await exchangeLongLived(
    { appId: env.metaAppId, appSecret: env.metaAppSecret, shortLivedToken: shortToken.accessToken },
    graph,
  );
  if (!long.ok) return fail(log, "token_exchange_failed", `step=long ${graphDetail(long)}`);
  const longToken = parseTokenResponse(long.data);
  if (!longToken.ok) return fail(log, "token_exchange_failed", `step=long code=${longToken.code ?? "none"}`);

  // 6. me/accounts → 候補
  const pages = await listPages(longToken.accessToken, graph);
  if (!pages.ok) return fail(log, "accounts_failed", graphDetail(pages));
  const candidates = selectCandidates(pages.data, env.targetIgUserId);
  if (candidates.length === 0) {
    // target 指定があり、Instagram 付きのページはあるのに一致しない → target_mismatch（ログは件数だけ）
    const linked = env.targetIgUserId ? selectCandidates(pages.data).length : 0;
    if (linked > 0) return fail(log, "target_mismatch", `count=${linked}`);
    return fail(log, "no_instagram_account");
  }
  if (candidates.length > 1) return fail(log, "multiple_accounts", `count=${candidates.length}`);
  const candidate = candidates[0];

  // 7. ページトークン
  const pageToken = await getPageToken(candidate.pageId, longToken.accessToken, graph);
  if (!pageToken.ok) return fail(log, "page_token_failed", graphDetail(pageToken));

  // 8. debug_token で種類、期限、権限、app_id、profile_id を確認
  const debug = await debugToken(pageToken.data, `${env.metaAppId}|${env.metaAppSecret}`, graph);
  if (!debug.ok) return fail(log, "debug_token_failed", graphDetail(debug));
  const parsed = toCredentialInfo(debug.data, { appId: env.metaAppId, pageId: candidate.pageId });
  if (!parsed.ok) return fail(log, "token_invalid", `detail=${parsed.detail}`);

  // 9. DB に登録（1 トランザクション）
  const register = deps.register ?? registerCredential;
  const registered = await register(deps.db, {
    igUserId: candidate.igUserId,
    username: candidate.username,
    name: candidate.name,
    fbPageId: candidate.pageId,
    token: pageToken.data,
    credential: parsed.credential,
  });
  if (!registered.ok) return fail(log, "db_failed", registered.reason);

  return { result: "ok", registered: [{ username: candidate.username }] };
}
