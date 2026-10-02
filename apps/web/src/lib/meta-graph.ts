/**
 * Facebook Login とページトークンの取得に使う Graph API の呼び出し（設計 2.1 章）。サーバー側専用。
 *
 * - 例外を投げない。戻り値は `{ ok: true, data } | { ok: false, status, code? }`（`code` は Graph API のエラーコード）
 * - トークン交換（短期、長期化）は POST の本文（`application/x-www-form-urlencoded`）で送り、`client_secret` と
 *   `code` を URL に載せない
 * - ユーザートークンとアプリトークンは `Authorization: Bearer` で送る。`debug_token` の `input_token` だけはクエリ
 * - トークン交換以外の呼び出しには `appsecret_proof`（そのリクエストのトークンで計算）をクエリに付ける（R2 設計 Q6）
 * - `cache: 'no-store'`、タイムアウト 15 秒。`fetch` の例外は捨てる（メッセージに URL が入りうる）
 * - ログを出さない。URL やトークンを含む文字列を戻り値に入れない
 */
import "server-only";
import { createHmac } from "node:crypto";
import { graphErrorCode, type DebugTokenData } from "@/lib/meta-oauth";

const GRAPH_ORIGIN = "https://graph.facebook.com";
const TIMEOUT_MS = 15_000;
/** `me/accounts` のページングで追う最大ページ数 */
const MAX_PAGES = 10;
const PAGE_LIMIT = 100;

export type GraphResult<T> = { ok: true; data: T } | { ok: false; status: number; code?: number };

export interface GraphOptions {
  /** `v25.0` の形（`readEnv` で検証済み） */
  graphApiVersion: string;
  /** `appsecret_proof` の鍵（`META_APP_SECRET`） */
  appSecret: string;
  /** テスト用。省略時はグローバルの `fetch` */
  fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function endpoint(version: string, path: string): URL {
  return new URL(`${GRAPH_ORIGIN}/${version}/${path}`);
}

/**
 * `appsecret_proof`（R2 設計 5.6 章、Q6）: `HMAC-SHA256(key = app_secret, message = そのリクエストに使うトークン)` の 16 進。
 * 呼び出しごとに、そのリクエストの Bearer に使うトークンで計算する（ユーザートークンの呼び出しはユーザートークン、
 * `debug_token` はアプリトークン）。トークン交換（`oauth/access_token`）には付けない（`client_secret` を送る）
 */
export function appSecretProof(appSecret: string, token: string): string {
  return createHmac("sha256", appSecret).update(token).digest("hex");
}

/** 1 回の呼び出し。HTTP の失敗、本文に `error`、JSON でない本文はすべて `ok: false` */
async function call(url: URL, init: RequestInit, options: GraphOptions): Promise<GraphResult<unknown>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return { ok: false, status: 0 };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, status: res.status };
  }
  const code = graphErrorCode(body);
  if (!res.ok || code !== undefined || (isRecord(body) && "error" in body)) {
    return { ok: false, status: res.status, code };
  }
  return { ok: true, data: body };
}

function bearer(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

/** POST の本文（`application/x-www-form-urlencoded`） */
function postForm(url: URL, fields: Record<string, string>, options: GraphOptions): Promise<GraphResult<unknown>> {
  const body = new URLSearchParams(fields);
  return call(
    url,
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() },
    options,
  );
}

export interface CodeExchangeInput {
  appId: string;
  appSecret: string;
  /** 認可 URL と同じ文字列 */
  redirectUri: string;
  code: string;
}

/** 認可コード → 短期ユーザートークン（本文はそのまま返す。`parseTokenResponse` で読む） */
export function exchangeCode(input: CodeExchangeInput, options: GraphOptions): Promise<GraphResult<unknown>> {
  return postForm(
    endpoint(options.graphApiVersion, "oauth/access_token"),
    { client_id: input.appId, client_secret: input.appSecret, redirect_uri: input.redirectUri, code: input.code },
    options,
  );
}

export interface LongLivedExchangeInput {
  appId: string;
  appSecret: string;
  shortLivedToken: string;
}

/** 短期ユーザートークン → 長期ユーザートークン */
export function exchangeLongLived(input: LongLivedExchangeInput, options: GraphOptions): Promise<GraphResult<unknown>> {
  return postForm(
    endpoint(options.graphApiVersion, "oauth/access_token"),
    {
      grant_type: "fb_exchange_token",
      client_id: input.appId,
      client_secret: input.appSecret,
      fb_exchange_token: input.shortLivedToken,
    },
    options,
  );
}

/**
 * `me/accounts` を最大 10 ページまで読み、`data` を連結して返す。`access_token` は要求しない。
 * `paging.next` があり `paging.cursors.after` が文字列なら続きを読む。`data` が配列でなければ失敗
 */
export async function listPages(userToken: string, options: GraphOptions): Promise<GraphResult<unknown[]>> {
  const pages: unknown[] = [];
  let after: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const url = endpoint(options.graphApiVersion, "me/accounts");
    url.searchParams.set("fields", "id,name,instagram_business_account{id,username,name}");
    url.searchParams.set("limit", String(PAGE_LIMIT));
    url.searchParams.set("appsecret_proof", appSecretProof(options.appSecret, userToken));
    if (after !== undefined) url.searchParams.set("after", after);
    const result = await call(url, { method: "GET", headers: bearer(userToken) }, options);
    if (!result.ok) return result;
    if (!isRecord(result.data) || !Array.isArray(result.data["data"])) return { ok: false, status: 200 };
    pages.push(...result.data["data"]);
    const paging = result.data["paging"];
    if (!isRecord(paging) || typeof paging["next"] !== "string") break;
    const cursors = paging["cursors"];
    const next = isRecord(cursors) ? cursors["after"] : undefined;
    if (typeof next !== "string" || next.length === 0) break;
    after = next;
  }
  return { ok: true, data: pages };
}

/** 選んだページのアクセストークン（`{page_id}?fields=access_token`）。`pageId` は数字だけに検証済みのものを渡す */
export async function getPageToken(pageId: string, userToken: string, options: GraphOptions): Promise<GraphResult<string>> {
  const url = endpoint(options.graphApiVersion, pageId);
  url.searchParams.set("fields", "access_token");
  url.searchParams.set("appsecret_proof", appSecretProof(options.appSecret, userToken));
  const result = await call(url, { method: "GET", headers: bearer(userToken) }, options);
  if (!result.ok) return result;
  const token = isRecord(result.data) ? result.data["access_token"] : undefined;
  if (typeof token !== "string" || token.length === 0) return { ok: false, status: 200 };
  return { ok: true, data: token };
}

/**
 * `debug_token`。アプリトークン（`appId|appSecret`）を Bearer に、調べるトークンを `input_token` のクエリに。
 * `is_valid: false` でも HTTP 200 で返るので、呼び出し側が `toCredentialInfo` で判断する
 */
export async function debugToken(
  inputToken: string,
  appToken: string,
  options: GraphOptions,
): Promise<GraphResult<DebugTokenData>> {
  const url = endpoint(options.graphApiVersion, "debug_token");
  url.searchParams.set("input_token", inputToken);
  url.searchParams.set("appsecret_proof", appSecretProof(options.appSecret, appToken));
  const result = await call(url, { method: "GET", headers: bearer(appToken) }, options);
  if (!result.ok) return result;
  const data = isRecord(result.data) ? result.data["data"] : undefined;
  if (!isRecord(data)) return { ok: false, status: 200 };
  return { ok: true, data: data as DebugTokenData };
}
