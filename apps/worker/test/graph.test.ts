import { describe, expect, it } from "vitest";
import {
  backoffDelay,
  classifyGraphError,
  formatGraphError,
  GraphClient,
  INVALID_BODY_ERROR_TYPE,
  MAX_ATTEMPTS,
  NETWORK_ERROR_TYPE,
  parseCdnExpiry,
  parseRateUsage,
  type GraphError,
} from "../src/lib/graph.js";

describe("parseCdnExpiry", () => {
  it("oe パラメータ（16 進の UNIX 秒）を日時にする", () => {
    const url = "https://scontent.cdninstagram.com/v/t50/video.mp4?_nc_ht=x&oe=68F0A1B2&oh=abc";
    expect(parseCdnExpiry(url)?.getTime()).toBe(0x68f0a1b2 * 1000);
  });

  it("oe がない、または不正なら undefined", () => {
    expect(parseCdnExpiry("https://example.com/video.mp4")).toBeUndefined();
    expect(parseCdnExpiry("https://example.com/video.mp4?oe=zz")).toBeUndefined();
    expect(parseCdnExpiry("not a url")).toBeUndefined();
  });
});

describe("GraphClient.describe", () => {
  it("アクセストークンを含まないリクエスト表記を返す", () => {
    const client = new GraphClient("SECRET_TOKEN", "v25.0");
    const text = client.describe("123/insights", { metric: "reach", period: "day", since: undefined });
    expect(text).toBe("123/insights?metric=reach&period=day");
    expect(text).not.toContain("SECRET_TOKEN");
  });
});

describe("formatGraphError", () => {
  it("コードとサブコードを付けて整形する", () => {
    expect(formatGraphError({ message: "Invalid metric", code: 100, error_subcode: 2108006 })).toBe(
      "[100/2108006] Invalid metric",
    );
    expect(formatGraphError({ message: "HTTP 500" })).toBe("HTTP 500");
    expect(formatGraphError(undefined)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// GraphClient.get（偽の fetch）
// ---------------------------------------------------------------------------

function toUrl(input: Parameters<typeof fetch>[0]): URL {
  if (input instanceof URL) return input;
  return new URL(typeof input === "string" ? input : input.url);
}

interface Captured {
  url: URL;
  authorization: string | null;
  signal: AbortSignal | null | undefined;
}

/** 偽の fetch が受け取った URL、Authorization ヘッダ、signal を記録する */
function capturing(respond: () => Response): { calls: Captured[]; fetchImpl: typeof fetch } {
  const calls: Captured[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: toUrl(input),
      authorization: new Headers(init?.headers).get("authorization"),
      signal: init?.signal,
    });
    return respond();
  };
  return { calls, fetchImpl };
}

/** `init.signal` の中断を待って reject する偽の fetch（タイムアウトの検証用） */
const fetchUntilAbort: typeof fetch = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) {
      reject(new Error("signal がない"));
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason as unknown));
  });

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("GraphClient.get", () => {
  it("成功したら data を返す。トークンは Authorization ヘッダで送り、URL には載せない（P11）", async () => {
    const { calls, fetchImpl } = capturing(() => jsonResponse({ id: "1" }));
    const client = new GraphClient("SECRET_TOKEN", "v25.0", 0, fetchImpl);
    const res = await client.get<{ id: string }>("/me", { fields: "id", limit: 50, since: undefined });
    expect(res).toEqual({
      ok: true,
      status: 200,
      data: { id: "1" },
      error: undefined,
      rateLimit: { businessUseCaseUsage: undefined, appUsage: undefined },
    });
    const call = calls[0];
    expect(call?.url.origin).toBe("https://graph.facebook.com");
    expect(call?.url.pathname).toBe("/v25.0/me");
    expect(call?.url.searchParams.get("fields")).toBe("id");
    expect(call?.url.searchParams.get("limit")).toBe("50");
    expect(call?.url.searchParams.has("since")).toBe(false);
    expect(call?.url.searchParams.has("access_token")).toBe(false);
    expect(call?.url.href).not.toContain("SECRET_TOKEN");
    expect(call?.authorization).toBe("Bearer SECRET_TOKEN");
    expect(call?.signal).toBeInstanceOf(AbortSignal);
  });

  it("requestTimeoutMs を過ぎたら中断し、status 0 の NetworkError を返す", async () => {
    const client = new GraphClient("t", "v25.0", 0, fetchUntilAbort, 20);
    const res = await client.get("me");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(0);
    expect(res.error).toEqual({ message: "ネットワークエラー", type: NETWORK_ERROR_TYPE });
    expect(classifyGraphError(res.status, res.error)).toBe("transient");
  });

  it("tokenOverride（debug_token のアプリトークン）もヘッダで送り、input_token はクエリのまま", async () => {
    const { calls, fetchImpl } = capturing(() => jsonResponse({ data: {} }));
    const client = new GraphClient("SECRET_TOKEN", "v25.0", 0, fetchImpl);
    await client.get("debug_token", { input_token: "SECRET_TOKEN" }, "APP_ID|APP_SECRET");
    const call = calls[0];
    expect(call?.authorization).toBe("Bearer APP_ID|APP_SECRET");
    expect(call?.url.searchParams.get("input_token")).toBe("SECRET_TOKEN");
    expect(call?.url.searchParams.has("access_token")).toBe(false);
    expect(call?.url.href).not.toContain("APP_SECRET");
  });

  it("debugToken は input_token に自分のトークンをクエリで、Authorization にアプリトークンを付け、URL に自分のトークンを含まない", async () => {
    const body = { data: { type: "PAGE", is_valid: true, expires_at: 0, data_access_expires_at: 1_798_761_600, scopes: ["instagram_basic"] } };
    const { calls, fetchImpl } = capturing(() => jsonResponse(body));
    const client = new GraphClient("SECRET_TOKEN", "v25.0", 0, fetchImpl);
    const res = await client.debugToken("APP_ID|APP_SECRET");
    expect(res.ok).toBe(true);
    expect(res.data?.data?.is_valid).toBe(true);
    expect(res.data?.data?.type).toBe("PAGE");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url.pathname).toBe("/v25.0/debug_token");
    expect(call?.url.searchParams.get("input_token")).toBe("SECRET_TOKEN");
    expect(call?.url.searchParams.has("access_token")).toBe(false);
    expect(call?.authorization).toBe("Bearer APP_ID|APP_SECRET");
    expect(call?.url.href).not.toContain("APP_SECRET");
    // URL のクエリ以外（パス）に自分のトークンは出ない
    expect(call?.url.pathname).not.toContain("SECRET_TOKEN");
  });

  it("fetch が例外を投げたら status 0 の NetworkError を返し、例外の内容（URL）を含めない", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError("fetch failed: https://graph.facebook.com/v25.0/me?access_token=SECRET_TOKEN");
    };
    const client = new GraphClient("SECRET_TOKEN", "v25.0", 0, fetchImpl);
    const res = await client.get("me");
    expect(res).toEqual({
      ok: false,
      status: 0,
      data: undefined,
      error: { message: "ネットワークエラー", type: NETWORK_ERROR_TYPE },
      rateLimit: { businessUseCaseUsage: undefined, appUsage: undefined },
    });
    expect(JSON.stringify(res)).not.toContain("SECRET_TOKEN");
  });

  it("HTTP 200 で本文が JSON でなければ InvalidBody", async () => {
    const fetchImpl: typeof fetch = async () => new Response("<html>maintenance</html>", { status: 200 });
    const client = new GraphClient("t", "v25.0", 0, fetchImpl);
    const res = await client.get("me");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(200);
    expect(res.data).toBeUndefined();
    expect(res.error).toEqual({ message: "レスポンスが JSON でない", type: INVALID_BODY_ERROR_TYPE });
  });

  it("HTTP 500 で本文がなければ error は HTTP 500", async () => {
    const fetchImpl: typeof fetch = async () => new Response(null, { status: 500 });
    const client = new GraphClient("t", "v25.0", 0, fetchImpl);
    const res = await client.get("me");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
    expect(res.error).toEqual({ message: "HTTP 500" });
  });

  it("HTTP 400 で Graph のエラー本文があればそれを返す", async () => {
    const error: GraphError = { message: "Invalid parameter", type: "OAuthException", code: 100, error_subcode: 33 };
    const fetchImpl: typeof fetch = async () => jsonResponse({ error }, { status: 400 });
    const client = new GraphClient("t", "v25.0", 0, fetchImpl);
    const res = await client.get("me");
    expect(res).toMatchObject({ ok: false, status: 400, data: undefined, error });
  });

  it("本文に error があれば HTTP 200 でも ok: false", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ error: { message: "oops", code: 1 } });
    const client = new GraphClient("t", "v25.0", 0, fetchImpl);
    const res = await client.get("me");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe(1);
  });

  it("error の message が文字列でなくても code が数値ならエラー。message は固定文言に置き換える", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ error: { message: 123, code: 190 } }, { status: 400 });
    const client = new GraphClient("t", "v25.0", 0, fetchImpl);
    const res = await client.get("me");
    expect(res.ok).toBe(false);
    expect(res.error).toEqual({ message: "メッセージなし", code: 190 });
    expect(classifyGraphError(res.status, res.error)).toBe("auth");
  });

  it("error に message（文字列）も code（数値）もなければエラーと見なさない", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ error: { foo: "bar" } });
    const client = new GraphClient("t", "v25.0", 0, fetchImpl);
    const res = await client.get("me");
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ error: { foo: "bar" } });
  });

  it("本文が JSON の null や配列なら ok: true で data はそのまま", async () => {
    const nullClient = new GraphClient("t", "v25.0", 0, async () => new Response("null", { status: 200 }));
    const nullRes = await nullClient.get("me");
    expect(nullRes.ok).toBe(true);
    expect(nullRes.data).toBeNull();
    expect(nullRes.error).toBeUndefined();

    const arrayClient = new GraphClient("t", "v25.0", 0, async () => new Response("[1,2]", { status: 200 }));
    const arrayRes = await arrayClient.get("me");
    expect(arrayRes.ok).toBe(true);
    expect(arrayRes.data).toEqual([1, 2]);
  });

  it("4xx で本文が HTML なら error は HTTP <status> で fatal", async () => {
    const fetchImpl: typeof fetch = async () => new Response("<html>forbidden</html>", { status: 403 });
    const client = new GraphClient("t", "v25.0", 0, fetchImpl);
    const res = await client.get("me");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
    expect(res.error).toEqual({ message: "HTTP 403" });
    expect(classifyGraphError(res.status, res.error)).toBe("fatal");
  });

  it("レート制限のヘッダを JSON として読む。JSON でなければ文字列のまま", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(
        { id: "1" },
        {
          headers: {
            "content-type": "application/json",
            "x-business-use-case-usage": JSON.stringify({ "123": [{ type: "instagram", call_count: 3 }] }),
            "x-app-usage": "not json",
          },
        },
      );
    const client = new GraphClient("t", "v25.0", 0, fetchImpl);
    const res = await client.get("me");
    expect(res.rateLimit.businessUseCaseUsage).toEqual({ "123": [{ type: "instagram", call_count: 3 }] });
    expect(res.rateLimit.appUsage).toBe("not json");
  });
});

// ---------------------------------------------------------------------------
// classifyGraphError
// ---------------------------------------------------------------------------

describe("classifyGraphError", () => {
  it("transient: レスポンスなし、HTTP 5xx、本文が JSON でない、コード 1／2", () => {
    expect(classifyGraphError(0, { message: "ネットワークエラー", type: NETWORK_ERROR_TYPE })).toBe("transient");
    expect(classifyGraphError(0, undefined)).toBe("transient");
    expect(classifyGraphError(500, { message: "HTTP 500" })).toBe("transient");
    expect(classifyGraphError(503, undefined)).toBe("transient");
    expect(classifyGraphError(200, { message: "レスポンスが JSON でない", type: INVALID_BODY_ERROR_TYPE })).toBe(
      "transient",
    );
    expect(classifyGraphError(500, { message: "An unknown error occurred", code: 1 })).toBe("transient");
    expect(classifyGraphError(400, { message: "Service temporarily unavailable", code: 2 })).toBe("transient");
    // HTTP 5xx はコードが未知でも transient（分類の順序を固定する）
    expect(classifyGraphError(503, { message: "x", code: 100 })).toBe("transient");
  });

  it("rate: コード 4／17／32／613／80000〜80009、HTTP 429", () => {
    for (const code of [4, 17, 32, 613, 80000, 80004, 80009]) {
      expect(classifyGraphError(400, { message: "rate", code })).toBe("rate");
    }
    expect(classifyGraphError(429, undefined)).toBe("rate");
    expect(classifyGraphError(429, { message: "x", code: 100 })).toBe("rate");
    // HTTP 5xx でもレート制限のコードが優先
    expect(classifyGraphError(500, { message: "x", code: 4 })).toBe("rate");
    expect(classifyGraphError(400, { message: "x", code: 79999 })).toBe("fatal");
    expect(classifyGraphError(400, { message: "x", code: 80010 })).toBe("fatal");
  });

  it("auth: コード 190、10、200〜299", () => {
    expect(classifyGraphError(400, { message: "Invalid OAuth access token", code: 190, error_subcode: 463 })).toBe(
      "auth",
    );
    expect(classifyGraphError(403, { message: "permission", code: 10 })).toBe("auth");
    expect(classifyGraphError(403, { message: "permission", code: 200 })).toBe("auth");
    expect(classifyGraphError(403, { message: "permission", code: 299 })).toBe("auth");
    expect(classifyGraphError(500, { message: "permission", code: 190 })).toBe("auth");
  });

  it("fatal: それ以外（コード 100、300、未知、エラーなしの 4xx）", () => {
    expect(classifyGraphError(400, { message: "Invalid parameter", code: 100, error_subcode: 33 })).toBe("fatal");
    expect(classifyGraphError(400, { message: "x", code: 300 })).toBe("fatal");
    expect(classifyGraphError(400, { message: "x", code: 999999 })).toBe("fatal");
    expect(classifyGraphError(400, { message: "HTTP 400" })).toBe("fatal");
    expect(classifyGraphError(404, undefined)).toBe("fatal");
    expect(classifyGraphError(400, { message: "x", code: 3 })).toBe("fatal");
  });
});

// ---------------------------------------------------------------------------
// backoffDelay
// ---------------------------------------------------------------------------

describe("backoffDelay", () => {
  it("合計 3 回の試行（再試行は 2 回）", () => {
    expect(MAX_ATTEMPTS).toBe(3);
  });

  it("1 回目は 2000〜3000ms、2 回目は 8000〜9000ms（乱数を注入）", () => {
    expect(backoffDelay(1, () => 0)).toBe(2000);
    expect(backoffDelay(1, () => 0.5)).toBe(2500);
    expect(backoffDelay(1, () => 0.999)).toBe(2999);
    expect(backoffDelay(2, () => 0)).toBe(8000);
    expect(backoffDelay(2, () => 0.999)).toBe(8999);
  });

  it("既定の乱数でも範囲に収まる", () => {
    for (let i = 0; i < 20; i += 1) {
      const first = backoffDelay(1);
      expect(first).toBeGreaterThanOrEqual(2000);
      expect(first).toBeLessThan(3000);
      const second = backoffDelay(2);
      expect(second).toBeGreaterThanOrEqual(8000);
      expect(second).toBeLessThan(9000);
    }
  });

  it("3 回目以降と 0 以下、整数でない回数は RangeError", () => {
    expect(() => backoffDelay(3)).toThrow(RangeError);
    expect(() => backoffDelay(0)).toThrow(RangeError);
    expect(() => backoffDelay(-1)).toThrow(RangeError);
    expect(() => backoffDelay(1.5)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// parseRateUsage
// ---------------------------------------------------------------------------

describe("parseRateUsage", () => {
  const business = {
    "17841400000000000": [
      { type: "instagram", call_count: 5, total_cputime: 10, total_time: 3, estimated_time_to_regain_access: 0 },
    ],
  };

  it("2 つのヘッダの最大値を取り、ID を含めない", () => {
    const usage = parseRateUsage({
      businessUseCaseUsage: business,
      appUsage: { call_count: 7, total_cputime: 1, total_time: 9 },
    });
    expect(usage).toEqual({ call_count: 7, total_cputime: 10, total_time: 9, estimated_time_to_regain_access: 0 });
    expect(JSON.stringify(usage)).not.toContain("17841400000000000");
    expect(JSON.stringify(usage)).not.toContain("instagram");
  });

  it("配列が複数要素でも全要素の最大。estimated_time_to_regain_access は最大を保持", () => {
    const usage = parseRateUsage({
      businessUseCaseUsage: {
        a: [
          { call_count: 1, total_cputime: 50, total_time: 2, estimated_time_to_regain_access: 5 },
          { call_count: 20, total_cputime: 3, total_time: 4, estimated_time_to_regain_access: 12 },
        ],
        b: [{ call_count: 2, total_cputime: 2, total_time: 60 }],
      },
      appUsage: undefined,
    });
    expect(usage).toEqual({ call_count: 20, total_cputime: 50, total_time: 60, estimated_time_to_regain_access: 12 });
  });

  it("片方だけでも読める。estimated_time_to_regain_access がなければキーを作らない", () => {
    const usage = parseRateUsage({ businessUseCaseUsage: undefined, appUsage: { call_count: 1, total_cputime: 2, total_time: 3 } });
    expect(usage).toEqual({ call_count: 1, total_cputime: 2, total_time: 3 });
    expect(usage && "estimated_time_to_regain_access" in usage).toBe(false);
  });

  it("ヘッダなし、JSON でない文字列、数値でない値は無視し、何も取れなければ undefined", () => {
    expect(parseRateUsage({ businessUseCaseUsage: undefined, appUsage: undefined })).toBeUndefined();
    expect(parseRateUsage({ businessUseCaseUsage: "garbage", appUsage: "also garbage" })).toBeUndefined();
    expect(
      parseRateUsage({ businessUseCaseUsage: { a: [{ call_count: "5" }] }, appUsage: { total_time: null } }),
    ).toBeUndefined();
    expect(parseRateUsage({ businessUseCaseUsage: { a: { call_count: 5 } }, appUsage: undefined })).toBeUndefined();
    // 数値でない値だけを無視し、残りは読む
    expect(
      parseRateUsage({ businessUseCaseUsage: undefined, appUsage: { call_count: "5", total_cputime: 4, total_time: NaN } }),
    ).toEqual({ call_count: 0, total_cputime: 4, total_time: 0 });
  });
});
