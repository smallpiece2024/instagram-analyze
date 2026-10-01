/**
 * Meta Graph API の最小クライアント。
 * アクセストークンは `Authorization: Bearer` ヘッダで送り（設計 11.1 章 P11 で確定）、URL、戻り値、エラー、
 * ログには含めない。
 *
 * R1 で足したもの（設計 1.4 章、7.1 章、9.1 章）:
 * - `fetch` の注入（偽の `fetch` でテストするため）
 * - ネットワーク失敗（`status: 0`）と、本文が JSON でない応答の扱い
 * - エラーの分類 `classifyGraphError`、再試行の待ち時間 `backoffDelay`
 * - レート制限ヘッダの読み取り `parseRateUsage`
 */

export interface GraphError {
  message: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  fbtrace_id?: string;
}

export interface RateLimitHeaders {
  /** X-Business-Use-Case-Usage（Instagram Platform 一般のレート制限） */
  businessUseCaseUsage: unknown;
  /** X-App-Usage（Business Discovery / Hashtag Search などのレート制限） */
  appUsage: unknown;
}

export interface GraphResponse<T = unknown> {
  ok: boolean;
  /** レスポンスがなかった（`fetch` が例外を投げた）ときは 0 */
  status: number;
  data: T | undefined;
  error: GraphError | undefined;
  rateLimit: RateLimitHeaders;
}

export type GraphParams = Record<string, string | number | undefined>;

/** `debug_token` の `data`。Meta の仕様どおり、各項目は省略されうる */
export interface DebugTokenData {
  /** `PAGE`、`USER`、`APP` など */
  type?: string;
  is_valid?: boolean;
  /** UNIX 秒。0 は期限なし */
  expires_at?: number;
  /** UNIX 秒 */
  data_access_expires_at?: number;
  scopes?: string[];
  /** ページトークンのときは Facebook ページの ID */
  profile_id?: string;
  app_id?: string;
  user_id?: string;
}

/** `debug_token` の応答（`GraphClient.debugToken`）。`is_valid: false` でも HTTP 200 で返る */
export interface DebugTokenResponse {
  data?: DebugTokenData;
}

/** `fetch` が例外を投げた（レスポンスなし）ときの `GraphError.type`。`status` は 0 になる */
export const NETWORK_ERROR_TYPE = "NetworkError";

/** HTTP は成功したが本文が JSON でなかったときの `GraphError.type` */
export const INVALID_BODY_ERROR_TYPE = "InvalidBody";

function parseJsonHeader(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 本文に Graph API のエラーオブジェクトがあれば取り出す。
 * `message` が文字列か `code` が数値ならエラーと見なす。`message` が文字列でなければ固定文言に置き換え、
 * 呼び出し側の `sanitizeForLog(error.message)` が常に文字列を受け取るようにする。
 */
function extractGraphError(body: unknown): GraphError | undefined {
  if (!isRecord(body)) return undefined;
  const error = body["error"];
  if (!isRecord(error)) return undefined;
  const message = error["message"];
  const code = error["code"];
  if (typeof message !== "string" && typeof code !== "number") return undefined;
  return {
    ...(error as unknown as GraphError),
    message: typeof message === "string" ? message : "メッセージなし",
  };
}

export class GraphClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly accessToken: string,
    readonly apiVersion: string,
    private readonly requestIntervalMs = 200,
    fetchImpl: typeof fetch = fetch,
    /** 接続から本文の読み終わりまでの制限時間（ミリ秒）。超えたら `status: 0`（transient）になる */
    private readonly requestTimeoutMs = 30_000,
  ) {
    this.baseUrl = `https://graph.facebook.com/${apiVersion}`;
    this.fetchImpl = fetchImpl;
  }

  /** 検証などでトークンを伴わない URL を記録したいときに使う */
  describe(path: string, params: GraphParams = {}): string {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) query.set(key, String(value));
    }
    const qs = query.toString();
    return `${path}${qs ? `?${qs}` : ""}`;
  }

  /**
   * GET を 1 回行う。例外は投げない。
   * - ネットワーク失敗（`fetch` の例外、`requestTimeoutMs` の超過）: `ok: false, status: 0`、`error.type` は `NETWORK_ERROR_TYPE`
   * - HTTP エラーまたは本文に `error`: `ok: false`、本文のエラー（なければ `HTTP <status>`）
   * - HTTP は成功したが本文が JSON でない: `ok: false`、`error.type` は `INVALID_BODY_ERROR_TYPE`
   * - HTTP は成功して本文が JSON の `null` や配列: `ok: true`、`data` はそのまま
   */
  async get<T = unknown>(
    path: string,
    params: GraphParams = {},
    tokenOverride?: string,
  ): Promise<GraphResponse<T>> {
    const url = new URL(`${this.baseUrl}/${path.replace(/^\//, "")}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const init: RequestInit = {
      ...this.authorize(tokenOverride ?? this.accessToken),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    };

    await sleep(this.requestIntervalMs);
    const fetchImpl = this.fetchImpl;
    let res: Response;
    try {
      res = await fetchImpl(url, init);
    } catch {
      // 例外のメッセージには URL が入りうるので捨てる。制限時間の超過もここに来る
      return {
        ok: false,
        status: 0,
        data: undefined,
        error: { message: "ネットワークエラー", type: NETWORK_ERROR_TYPE },
        rateLimit: { businessUseCaseUsage: undefined, appUsage: undefined },
      };
    }

    const rateLimit: RateLimitHeaders = {
      businessUseCaseUsage: parseJsonHeader(res.headers.get("x-business-use-case-usage")),
      appUsage: parseJsonHeader(res.headers.get("x-app-usage")),
    };
    let body: unknown;
    let bodyIsJson = true;
    try {
      body = await res.json();
    } catch {
      bodyIsJson = false;
    }
    const graphError = extractGraphError(body);
    if (!res.ok || graphError) {
      return {
        ok: false,
        status: res.status,
        data: undefined,
        error: graphError ?? { message: `HTTP ${res.status}` },
        rateLimit,
      };
    }
    if (!bodyIsJson) {
      return {
        ok: false,
        status: res.status,
        data: undefined,
        error: { message: "レスポンスが JSON でない", type: INVALID_BODY_ERROR_TYPE },
        rateLimit,
      };
    }
    return { ok: true, status: res.status, data: body as T, error: undefined, rateLimit };
  }

  /**
   * `debug_token` でこのクライアントのトークンを調べる（設計 4.1 章、4.2 章）。
   * `input_token` にこのクライアントのトークンをクエリで、`Authorization: Bearer` にアプリトークン
   * （`appId|appSecret`）を付ける。呼び出し側がトークンの値に触れずに済む。
   * `is_valid: false` は HTTP 200 で返るので `ok: true` の `data.data.is_valid` で判断する
   */
  debugToken(appToken: string): Promise<GraphResponse<DebugTokenResponse>> {
    return this.get<DebugTokenResponse>("debug_token", { input_token: this.accessToken }, appToken);
  }

  /**
   * トークンをリクエストに付ける唯一の場所。`Authorization: Bearer` ヘッダで送り、URL（クエリの `access_token`）
   * には載せない（設計 11.1 章 P11、2026-10-01 に実機で確認）。`debug_token` のアプリトークン
   * （`appId|appSecret`）も同じくヘッダで送る。`input_token` はクエリのまま。
   */
  private authorize(token: string): RequestInit {
    return { headers: { Authorization: `Bearer ${token}` } };
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatGraphError(error: GraphError | undefined): string {
  if (!error) return "";
  const code = [error.code, error.error_subcode].filter((v) => v !== undefined).join("/");
  return code ? `[${code}] ${error.message}` : error.message;
}

/**
 * Instagram の CDN URL に含まれる oe パラメータ（16 進の UNIX 秒）から有効期限を読む。
 * 形式は非公開仕様なので、読めなければ undefined を返す。
 */
export function parseCdnExpiry(mediaUrl: string): Date | undefined {
  try {
    const oe = new URL(mediaUrl).searchParams.get("oe");
    if (!oe || !/^[0-9a-fA-F]+$/.test(oe)) return undefined;
    const seconds = Number.parseInt(oe, 16);
    return Number.isFinite(seconds) ? new Date(seconds * 1000) : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// エラーの分類と再試行（設計 1.4 章）
// ---------------------------------------------------------------------------

/**
 * Graph API のエラーの分類。
 * - transient: 再試行する（ネットワーク失敗、HTTP 5xx、本文が JSON でない、コード 1／2）
 * - rate: 再試行せずジョブを止める（レート制限）
 * - auth: 再試行せず `private.credentials` を更新してジョブを止める（トークン無効、権限不足）
 * - fatal: 再試行せずその項目を失敗として次へ進む
 */
export type GraphErrorClass = "transient" | "rate" | "auth" | "fatal";

/** レート制限を表す Graph API のコード（80000〜80009 は Business Use Case。設計 11.1 章 P12） */
const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([4, 17, 32, 613]);

function isRateLimitCode(code: number): boolean {
  return RATE_LIMIT_CODES.has(code) || (code >= 80000 && code <= 80009);
}

function isAuthCode(code: number): boolean {
  return code === 190 || code === 10 || (code >= 200 && code <= 299);
}

/** エラーを 4 つに分類する純粋関数。`status` は HTTP ステータス（レスポンスなしは 0） */
export function classifyGraphError(status: number, error: GraphError | undefined): GraphErrorClass {
  if (status === 0) return "transient";
  if (error?.type === INVALID_BODY_ERROR_TYPE) return "transient";
  if (status === 429) return "rate";
  const code = error?.code;
  if (typeof code === "number") {
    if (isRateLimitCode(code)) return "rate";
    if (isAuthCode(code)) return "auth";
    if (code === 1 || code === 2) return "transient";
  }
  if (status >= 500 && status <= 599) return "transient";
  return "fatal";
}

/** 同じリクエストを試す回数の合計（最初の 1 回 ＋ 再試行 2 回） */
export const MAX_ATTEMPTS = 3;

/** 再試行の前の待ち時間の基本値（ミリ秒）。添字は「何回目の再試行か − 1」 */
const BACKOFF_BASE_MS: readonly number[] = [2000, 8000];

/** 待ち時間に足す乱数の幅（ミリ秒） */
const BACKOFF_JITTER_MS = 1000;

/**
 * `attempt` 回目の再試行の前に待つ時間（ミリ秒）。1 回目は 2000〜3000、2 回目は 8000〜9000。
 * `MAX_ATTEMPTS` 回の試行では再試行は 2 回までなので、それ以外の `attempt` は `RangeError`。
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Number.isInteger(attempt) ? BACKOFF_BASE_MS[attempt - 1] : undefined;
  if (base === undefined) {
    throw new RangeError(`再試行の回数が範囲外（1〜${MAX_ATTEMPTS - 1}）`);
  }
  return base + random() * BACKOFF_JITTER_MS;
}

// ---------------------------------------------------------------------------
// レート制限（設計 7.1 章）
// ---------------------------------------------------------------------------

/**
 * レート制限の使用率（%）。X-Business-Use-Case-Usage と X-App-Usage から ID を除いて取り出したもの。
 * job_runs.rate_usage に入れる形（設計 7.1 章）。
 */
export interface RateUsage {
  call_count: number;
  total_cputime: number;
  total_time: number;
  /** アクセスが回復するまでの見込み（分）。ヘッダにあるときだけ */
  estimated_time_to_regain_access?: number;
}

const USAGE_KEYS = ["call_count", "total_cputime", "total_time"] as const;

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * 2 つのレート制限ヘッダから使用率を読む。
 * X-Business-Use-Case-Usage は `{ "<id>": [ { call_count, ... }, ... ] }`、X-App-Usage は `{ call_count, ... }`。
 * すべての要素について 3 つの百分率それぞれの最大を取る。ID は含めない。
 * JSON でない文字列や数値でない値は無視し、何も取れなければ undefined。
 */
export function parseRateUsage(headers: RateLimitHeaders): RateUsage | undefined {
  const entries: Record<string, unknown>[] = [];
  if (isRecord(headers.businessUseCaseUsage)) {
    for (const perId of Object.values(headers.businessUseCaseUsage)) {
      if (!Array.isArray(perId)) continue;
      for (const item of perId) {
        if (isRecord(item)) entries.push(item);
      }
    }
  }
  if (isRecord(headers.appUsage)) entries.push(headers.appUsage);

  const usage: RateUsage = { call_count: 0, total_cputime: 0, total_time: 0 };
  let regain: number | undefined;
  let found = false;
  for (const entry of entries) {
    for (const key of USAGE_KEYS) {
      const value = finiteNumber(entry[key]);
      if (value === undefined) continue;
      usage[key] = Math.max(usage[key], value);
      found = true;
    }
    const estimated = finiteNumber(entry["estimated_time_to_regain_access"]);
    if (estimated !== undefined) {
      regain = regain === undefined ? estimated : Math.max(regain, estimated);
      found = true;
    }
  }
  if (!found) return undefined;
  if (regain !== undefined) usage.estimated_time_to_regain_access = regain;
  return usage;
}
