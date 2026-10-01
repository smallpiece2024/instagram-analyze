/**
 * Facebook Login（OAuth）の純粋な部品（設計 2 章、4.1 章）。I/O はしない。`server-only` も付けない。
 *
 * - `state` の生成と照合、認可 URL の組み立て、トークン応答の読み取り、候補ページの選定、
 *   `debug_token` の結果から `private.credentials` に入れる値を組み立てる規則（ワーカーの `toCredentialInfo` を複製し、
 *   `app_id`／`profile_id`／`is_valid`／`type` の確認を足したもの）
 * - 失敗の理由コードは閉じた列挙（設計 2.5 章）。画面の文言は固定で、値を反射しない
 * - トークン、`code`、`client_secret` を含む文字列をここで作るのは認可 URL（`client_secret` を含まない）だけ
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { REQUIRED_SCOPES } from "@/lib/format";

export { REQUIRED_SCOPES };

// ---------------------------------------------------------------------------
// 理由コード（設計 2.5 章）
// ---------------------------------------------------------------------------

export const REASON_CODES = [
  "ok",
  "state_mismatch",
  "denied",
  "invalid_request",
  "token_exchange_failed",
  "accounts_failed",
  "no_instagram_account",
  "target_mismatch",
  "multiple_accounts",
  "page_token_failed",
  "debug_token_failed",
  "token_invalid",
  "db_failed",
  "config_missing",
  "unknown",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/** 画面に出す固定の文言。トークン、URL、ID を含めない */
export const REASON_MESSAGES: Readonly<Record<ReasonCode, string>> = {
  ok: "接続しました。登録したアカウントは上の表のとおりです。",
  state_mismatch: "接続をやり直してください（確認用の値が一致しません）。",
  denied: "接続が許可されませんでした。",
  invalid_request: "接続をやり直してください（要求が不正です）。",
  token_exchange_failed: "Meta からトークンを取得できませんでした。",
  accounts_failed: "Facebook ページの一覧を取得できませんでした。",
  no_instagram_account: "Instagram プロアカウントに接続された Facebook ページが見つかりません。",
  target_mismatch:
    "指定した Instagram アカウントの付いた Facebook ページが見つかりません（META_TARGET_IG_USER_ID を確認してください）。",
  multiple_accounts: "対象の Facebook ページだけを選んで接続し直してください（複数見つかりました）。",
  page_token_failed: "ページのトークンを取得できませんでした。",
  debug_token_failed: "トークンの確認に失敗しました。",
  token_invalid: "取得したトークンが有効ではありません。",
  db_failed: "登録に失敗しました（DB）。",
  config_missing: "設定が足りません。",
  unknown: "接続に失敗しました。",
};

/** 未知のコードに使う汎用の文言 */
export const GENERIC_REASON_MESSAGE = "接続に失敗しました。";

export function isReasonCode(value: unknown): value is ReasonCode {
  return typeof value === "string" && (REASON_CODES as readonly string[]).includes(value);
}

/**
 * `?result=` の値を文言にする。値そのものは返さない。
 * - undefined（パラメータなし）→ undefined（何も出さない）
 * - 既知のコード → 対応する固定文言
 * - それ以外（空文字、未知の文字列）→ 汎用の文言
 */
export function reasonMessage(code: string | undefined): string | undefined {
  if (code === undefined) return undefined;
  return isReasonCode(code) ? REASON_MESSAGES[code] : GENERIC_REASON_MESSAGE;
}

// ---------------------------------------------------------------------------
// state（CSRF 対策）
// ---------------------------------------------------------------------------

/** `state` を入れる Cookie の名前。`/api/meta/login` が置き、`/api/meta/callback` が読んで消す */
export const STATE_COOKIE_NAME = "meta_oauth_state";
/** Cookie の寿命（秒）。認可画面での操作に十分で、放置しても残らない長さ */
export const STATE_COOKIE_MAX_AGE = 600;

export interface StateCookieOptions {
  httpOnly: true;
  sameSite: "lax";
  path: "/api/meta";
  maxAge: number;
  secure: boolean;
}

/**
 * `state` の Cookie の属性。httpOnly、SameSite=Lax、`path=/api/meta`、`secure` は `APP_URL` が https のときだけ。
 * `clear: true` で `maxAge: 0`（削除用。属性をそろえないとブラウザが同じ Cookie と見なさない）
 */
export function stateCookieOptions(appUrl: string | undefined, options: { clear?: boolean } = {}): StateCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/api/meta",
    maxAge: options.clear ? 0 : STATE_COOKIE_MAX_AGE,
    secure: appUrl?.startsWith("https:") ?? false,
  };
}

const STATE_BYTES = 32;
/** `verifyState` が受け付ける最大長。base64url の 32 バイトは 43 文字 */
const STATE_MAX_LENGTH = 256;

/** 32 バイトの乱数を base64url にした `state`（43 文字）。`random` はテスト用の注入 */
export function generateState(random: (bytes: number) => Uint8Array = (n) => randomBytes(n)): string {
  return Buffer.from(random(STATE_BYTES)).toString("base64url");
}

/**
 * `state` を照合する。両方が空でない文字列で、長さが同じときだけ `timingSafeEqual` で比べる。
 * 長さが違うときは false（長さの比較は定数時間でなくてよい。長さは秘密でない）
 */
export function verifyState(a: string | undefined, b: string | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length === 0 || a.length > STATE_MAX_LENGTH || a.length !== b.length) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// 認可 URL（設計 2.2 章）
// ---------------------------------------------------------------------------

/**
 * 要求する権限。収集に必要な 3 つ（`REQUIRED_SCOPES`。`src/lib/format.ts`）に、`me/accounts` にだけ要る
 * `pages_show_list` を足したもの（収集ジョブは使わない）
 */
export const OAUTH_SCOPES: readonly string[] = [...REQUIRED_SCOPES, "pages_show_list"];

export const CALLBACK_PATH = "/api/meta/callback";

export interface AuthorizeConfig {
  appId: string;
  /** `v25.0` の形 */
  graphApiVersion: string;
  /** オリジンだけ（末尾スラッシュなし） */
  appUrl: string;
}

/** `redirect_uri`。認可 URL とトークン交換で完全に同じ文字列を使う */
export function redirectUri(appUrl: string): string {
  return `${appUrl}${CALLBACK_PATH}`;
}

/** Facebook の認可画面の URL。`client_secret` は含めない */
export function buildAuthorizeUrl(config: AuthorizeConfig, state: string): string {
  const url = new URL(`https://www.facebook.com/${config.graphApiVersion}/dialog/oauth`);
  url.searchParams.set("client_id", config.appId);
  url.searchParams.set("redirect_uri", redirectUri(config.appUrl));
  url.searchParams.set("state", state);
  url.searchParams.set("scope", OAUTH_SCOPES.join(","));
  url.searchParams.set("response_type", "code");
  return url.toString();
}

// ---------------------------------------------------------------------------
// コールバックの入力の検査（設計 2.1 章）
// ---------------------------------------------------------------------------

const CODE_MAX_LENGTH = 512;
const CODE_PATTERN = /^[A-Za-z0-9_-]+$/;
const ERROR_REASON_PATTERN = /^[a-z_]{1,40}$/;

/** 認可コードの形。空、512 文字超、英数字と `_`、`-` 以外を含むものは不正 */
export function validateCode(code: unknown): code is string {
  return typeof code === "string" && code.length > 0 && code.length <= CODE_MAX_LENGTH && CODE_PATTERN.test(code);
}

/** `error_reason` をログに出してよい形か（`^[a-z_]{1,40}$`） */
export function isLoggableErrorReason(reason: unknown): reason is string {
  return typeof reason === "string" && ERROR_REASON_PATTERN.test(reason);
}

// ---------------------------------------------------------------------------
// トークン応答
// ---------------------------------------------------------------------------

export type TokenResponse = { ok: true; accessToken: string } | { ok: false; code?: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 本文に Graph API のエラーがあればそのコード（数値のときだけ） */
export function graphErrorCode(body: unknown): number | undefined {
  if (!isRecord(body)) return undefined;
  const error = body["error"];
  if (!isRecord(error)) return undefined;
  const code = error["code"];
  return typeof code === "number" && Number.isFinite(code) ? code : undefined;
}

/** `oauth/access_token` の本文から `access_token` を取り出す。`error` 本文、JSON でない、`access_token` なしは失敗 */
export function parseTokenResponse(body: unknown): TokenResponse {
  if (!isRecord(body)) return { ok: false };
  const code = graphErrorCode(body);
  if (code !== undefined || "error" in body) return { ok: false, code };
  const token = body["access_token"];
  if (typeof token !== "string" || token.length === 0) return { ok: false };
  return { ok: true, accessToken: token };
}

// ---------------------------------------------------------------------------
// 候補ページの選定（設計 2.3 章）
// ---------------------------------------------------------------------------

/** Facebook ページと Instagram アカウントの ID の形。数字だけ（URL のパスに入れるため） */
const ID_PATTERN = /^\d{1,40}$/;

export interface PageCandidate {
  /** Facebook ページの ID */
  pageId: string;
  /** Instagram プロアカウントの ID */
  igUserId: string;
  username: string | null;
  name: string | null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toCandidate(page: unknown): PageCandidate | undefined {
  if (!isRecord(page)) return undefined;
  const pageId = page["id"];
  if (typeof pageId !== "string" || !ID_PATTERN.test(pageId)) return undefined;
  const ig = page["instagram_business_account"];
  if (!isRecord(ig)) return undefined;
  const igUserId = ig["id"];
  if (typeof igUserId !== "string" || !ID_PATTERN.test(igUserId)) return undefined;
  return { pageId, igUserId, username: optionalString(ig["username"]), name: optionalString(ig["name"]) };
}

/**
 * `me/accounts` の `data` から、Instagram プロアカウントが接続されたページを候補にする。
 * - `ig_user_id` で重複を除く（先に出たものを残す）
 * - `targetIgUserId` があれば、候補の数にかかわらず一致するものだけを返す（最大 1 件。2026-10-02 のユーザー回答で
 *   「1 つでも一致しなければ登録しない」に決定）
 * 戻り値の件数で 0（`no_instagram_account` か `target_mismatch`）、1（登録）、複数（`multiple_accounts`）を判断する
 */
export function selectCandidates(pages: unknown, targetIgUserId?: string): PageCandidate[] {
  if (!Array.isArray(pages)) return [];
  const seen = new Set<string>();
  const candidates: PageCandidate[] = [];
  for (const page of pages) {
    const candidate = toCandidate(page);
    if (!candidate || seen.has(candidate.igUserId)) continue;
    seen.add(candidate.igUserId);
    candidates.push(candidate);
  }
  if (targetIgUserId) return candidates.filter((c) => c.igUserId === targetIgUserId);
  return candidates;
}

// ---------------------------------------------------------------------------
// debug_token の結果 → 認証情報（ワーカーの `toCredentialInfo` を複製し、確認を足したもの）
// ---------------------------------------------------------------------------

/** `debug_token` の `data`。Meta の仕様どおり各項目は省略されうる。型も信用しない */
export interface DebugTokenData {
  type?: unknown;
  is_valid?: unknown;
  /** UNIX 秒。0 は期限なし */
  expires_at?: unknown;
  /** UNIX 秒 */
  data_access_expires_at?: unknown;
  scopes?: unknown;
  /** ページトークンのときは Facebook ページの ID */
  profile_id?: unknown;
  app_id?: unknown;
  user_id?: unknown;
}

/** `private.credentials` に入れる値（トークン本体と内部の ID を除く） */
export interface CredentialInfo {
  token_type: "PAGE";
  /** トークンの有効期限。期限なしは null */
  expires_at: Date | null;
  data_access_expires_at: Date | null;
  scopes: string[];
  status: "valid" | "insufficient_scope";
}

/** `token_invalid` の理由の種別（ログに出す固定語） */
export type TokenInvalidDetail = "not_valid" | "not_page_token" | "app_id_mismatch" | "profile_id_mismatch";

export type ParsedCredential =
  | { ok: true; credential: CredentialInfo; missing: string[] }
  | { ok: false; reason: "token_invalid"; detail: TokenInvalidDetail };

/** UNIX 秒を `Date` に。0、undefined、数値でないものは null（期限なし／不明） */
function unixToDate(seconds: unknown): Date | null {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null;
}

/**
 * `debug_token` の結果を確認して `CredentialInfo` を組み立てる。
 * - `is_valid` が true でない → `not_valid`
 * - `type` が `PAGE` でない → `not_page_token`（長期ユーザートークンは保存しない）
 * - `app_id` が `expected.appId` と違う → `app_id_mismatch`
 * - `profile_id` が `expected.pageId` と違う → `profile_id_mismatch`
 * 必要な 3 権限がそろえば `valid`、欠ければ `insufficient_scope`（登録はする）
 */
export function toCredentialInfo(data: DebugTokenData, expected: { appId: string; pageId: string }): ParsedCredential {
  if (data.is_valid !== true) return { ok: false, reason: "token_invalid", detail: "not_valid" };
  if (data.type !== "PAGE") return { ok: false, reason: "token_invalid", detail: "not_page_token" };
  if (typeof data.app_id !== "string" || data.app_id !== expected.appId) {
    return { ok: false, reason: "token_invalid", detail: "app_id_mismatch" };
  }
  if (typeof data.profile_id !== "string" || data.profile_id !== expected.pageId) {
    return { ok: false, reason: "token_invalid", detail: "profile_id_mismatch" };
  }
  const scopes = Array.isArray(data.scopes) ? data.scopes.filter((s): s is string => typeof s === "string") : [];
  const missing = REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope));
  return {
    ok: true,
    credential: {
      token_type: "PAGE",
      expires_at: unixToDate(data.expires_at),
      data_access_expires_at: unixToDate(data.data_access_expires_at),
      scopes,
      status: missing.length === 0 ? "valid" : "insufficient_scope",
    },
    missing,
  };
}
