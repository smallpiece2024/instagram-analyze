/**
 * Meta Graph API の最小クライアント。
 * アクセストークンはクエリに付けるが、戻り値・エラー・ログには含めない。
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
  status: number;
  data: T | undefined;
  error: GraphError | undefined;
  rateLimit: RateLimitHeaders;
}

export type GraphParams = Record<string, string | number | undefined>;

function parseJsonHeader(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export class GraphClient {
  private readonly baseUrl: string;

  constructor(
    private readonly accessToken: string,
    readonly apiVersion: string,
    private readonly requestIntervalMs = 200,
  ) {
    this.baseUrl = `https://graph.facebook.com/${apiVersion}`;
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

  async get<T = unknown>(
    path: string,
    params: GraphParams = {},
    tokenOverride?: string,
  ): Promise<GraphResponse<T>> {
    const url = new URL(`${this.baseUrl}/${path.replace(/^\//, "")}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    url.searchParams.set("access_token", tokenOverride ?? this.accessToken);

    await sleep(this.requestIntervalMs);
    const res = await fetch(url);
    const body = (await res.json().catch(() => undefined)) as
      | (T & { error?: GraphError })
      | undefined;
    const rateLimit: RateLimitHeaders = {
      businessUseCaseUsage: parseJsonHeader(res.headers.get("x-business-use-case-usage")),
      appUsage: parseJsonHeader(res.headers.get("x-app-usage")),
    };
    if (!res.ok || body?.error) {
      return {
        ok: false,
        status: res.status,
        data: undefined,
        error: body?.error ?? { message: `HTTP ${res.status}` },
        rateLimit,
      };
    }
    return { ok: true, status: res.status, data: body, error: undefined, rateLimit };
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
