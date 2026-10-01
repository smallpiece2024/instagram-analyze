import { describe, expect, it } from "vitest";
import {
  AuthError,
  authErrorMessage,
  createJobGraphClient,
  stripSecretParams,
  stripVolatileFields,
  type JobGraphClient,
  type Page,
  type PersistRawInput,
} from "../src/jobs/graph-client.js";
import { RateLimitExceeded, RateMonitor } from "../src/jobs/rate.js";
import { GraphClient, MAX_ATTEMPTS, type GraphError, type RateUsage } from "../src/lib/graph.js";

// ---------------------------------------------------------------------------
// 偽の fetch と JobGraphClient の組み立て
// ---------------------------------------------------------------------------

type Reply = (() => Response) | Error;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function graphError(error: GraphError, status = 400): () => Response {
  return () => jsonResponse({ error }, { status });
}

function ok(body: unknown, headers: Record<string, string> = {}): () => Response {
  return () => jsonResponse(body, { headers: { "content-type": "application/json", ...headers } });
}

function usageHeader(callCount: number): Record<string, string> {
  return {
    "x-business-use-case-usage": JSON.stringify({
      "17841400000000000": [{ type: "instagram", call_count: callCount, total_cputime: 1, total_time: 1 }],
    }),
  };
}

interface Harness {
  client: JobGraphClient;
  calls: URL[];
  /** `calls` と同じ順の Authorization ヘッダ */
  auths: (string | null)[];
  persisted: PersistRawInput[];
  sleeps: number[];
  authCodes: number[];
  apiCalls: () => number;
  rate: RateMonitor;
}

const APP_TOKEN = "APP_ID|APP_SECRET";

const FIXED_NOW = new Date("2026-10-01T12:00:00.000Z");

interface HarnessOptions {
  threshold?: number;
  initial?: RateUsage;
  maskText?: (text: string) => string;
  /** 省略時は配列に積んで連番の id を返す */
  persistRaw?: (row: PersistRawInput) => Promise<string>;
  /** `authCodes` に積んだあとに呼ぶ（reject の試験用） */
  onAuthError?: (code: number) => Promise<void>;
}

function harness(replies: Reply[], opts: HarnessOptions = {}): Harness {
  const queue = [...replies];
  const calls: URL[] = [];
  const auths: (string | null)[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push(input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url));
    auths.push(new Headers(init?.headers).get("authorization"));
    const reply = queue.shift();
    // 用意した応答を使い切ったら fatal のエラーにして、テストが気づけるようにする
    if (!reply) return jsonResponse({ error: { message: "応答の用意がない", code: 999_999 } }, { status: 400 });
    if (reply instanceof Error) throw reply;
    return reply();
  };
  const graph = new GraphClient("SECRET_TOKEN", "v25.0", 0, fetchImpl);
  const rate = new RateMonitor(opts.initial);
  const persisted: PersistRawInput[] = [];
  const sleeps: number[] = [];
  const authCodes: number[] = [];
  let apiCalls = 0;
  const client = createJobGraphClient({
    graph,
    rate,
    rateThreshold: opts.threshold ?? 90,
    appToken: APP_TOKEN,
    persistRaw:
      opts.persistRaw ??
      (async (row) => {
        persisted.push(row);
        return String(persisted.length);
      }),
    onApiCall: () => {
      apiCalls += 1;
    },
    onAuthError: async (code) => {
      authCodes.push(code);
      await opts.onAuthError?.(code);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
    now: () => FIXED_NOW,
    maskText: opts.maskText,
  });
  return { client, calls, auths, persisted, sleeps, authCodes, apiCalls: () => apiCalls, rate };
}

// ---------------------------------------------------------------------------
// JobGraphClient.get
// ---------------------------------------------------------------------------

describe("JobGraphClient.get", () => {
  it("成功したら ok: true で data を返し、生レスポンスを 1 回保存して id を返す", async () => {
    const h = harness([ok({ id: "1", username: "x" })]);
    const res = await h.client.get<{ id: string }>("me", { fields: "id,username", limit: 50, since: undefined });
    expect(res).toEqual({
      ok: true,
      status: 200,
      data: { id: "1", username: "x" },
      error: undefined,
      errorClass: undefined,
      rawResponseId: "1",
      fetchedAt: FIXED_NOW,
    });
    expect(h.apiCalls()).toBe(1);
    expect(h.persisted).toEqual([
      {
        endpoint: "me",
        params: { fields: "id,username", limit: 50 },
        fetchedAt: FIXED_NOW,
        httpStatus: 200,
        body: { id: "1", username: "x" },
      },
    ]);
    expect(h.sleeps).toEqual([]);
  });

  it("transient は合計 MAX_ATTEMPTS 回試し、待ち時間は 2000ms と 8000ms。使い切ったら ok: false, errorClass: transient を返す", async () => {
    const h = harness([
      () => new Response(null, { status: 500 }),
      () => new Response(null, { status: 503 }),
      () => new Response(null, { status: 502 }),
    ]);
    const res = await h.client.get("me");
    expect(MAX_ATTEMPTS).toBe(3);
    expect(h.calls).toHaveLength(3);
    expect(h.apiCalls()).toBe(3);
    expect(h.sleeps).toEqual([2000, 8000]);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(502);
    expect(res.errorClass).toBe("transient");
    expect(res.error).toEqual({ message: "HTTP 502" });
    // 試行ごとに保存し、rawResponseId は最後の試行のもの
    expect(h.persisted.map((p) => p.httpStatus)).toEqual([500, 503, 502]);
    expect(res.rawResponseId).toBe("3");
  });

  it("transient のあと成功すれば ok: true。待ちは 1 回だけ", async () => {
    const h = harness([() => new Response(null, { status: 500 }), ok({ id: "1" })]);
    const res = await h.client.get<{ id: string }>("me");
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ id: "1" });
    expect(res.rawResponseId).toBe("2");
    expect(h.sleeps).toEqual([2000]);
    expect(h.apiCalls()).toBe(2);
  });

  it("レスポンスなし（fetch の例外）は status 0 で、保存せず rawResponseId は undefined。呼び出しは数える", async () => {
    const boom = new TypeError("fetch failed: https://graph.facebook.com/v25.0/me?access_token=SECRET_TOKEN");
    const h = harness([boom, boom, boom]);
    const res = await h.client.get("me");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(0);
    expect(res.errorClass).toBe("transient");
    expect(res.rawResponseId).toBeUndefined();
    expect(h.persisted).toEqual([]);
    expect(h.apiCalls()).toBe(3);
    expect(JSON.stringify(res)).not.toContain("SECRET_TOKEN");
  });

  it("本文が JSON でない応答も transient として再試行する", async () => {
    const h = harness([() => new Response("<html>", { status: 200 }), ok({ id: "1" })]);
    const res = await h.client.get("me");
    expect(res.ok).toBe(true);
    expect(h.calls).toHaveLength(2);
  });

  it("rate のコードは再試行せず RateLimitExceeded を投げる。エラー応答は保存する", async () => {
    const h = harness([graphError({ message: "Application request limit reached", code: 4 })]);
    await expect(h.client.get("me")).rejects.toThrow(RateLimitExceeded);
    await expect(harness([graphError({ message: "x", code: 4 })]).client.get("me")).rejects.toThrow(
      "レート制限のエラー（コード 4）",
    );
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
    expect(h.persisted).toHaveLength(1);
    expect(h.persisted[0]?.body).toEqual({ error: { message: "Application request limit reached", code: 4 } });
  });

  it("HTTP 429 で本文がなければ HTTP 429 の文言。estimated_time_to_regain_access をヘッダから引き継ぐ", async () => {
    const h = harness([
      () =>
        new Response(null, {
          status: 429,
          headers: {
            "x-business-use-case-usage": JSON.stringify({
              "1": [{ call_count: 100, total_cputime: 1, total_time: 1, estimated_time_to_regain_access: 7 }],
            }),
          },
        }),
    ]);
    const error = await h.client.get("me").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitExceeded);
    expect((error as RateLimitExceeded).message).toBe("レート制限のエラー（HTTP 429）");
    expect((error as RateLimitExceeded).estimatedMinutes).toBe(7);
  });

  it("呼び出しの前に使用率がしきい値以上なら、API を呼ばずに RateLimitExceeded を投げる", async () => {
    const h = harness([ok({ id: "1" })], {
      threshold: 90,
      initial: { call_count: 90, total_cputime: 1, total_time: 1, estimated_time_to_regain_access: 3 },
    });
    const error = await h.client.get("me").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitExceeded);
    expect((error as RateLimitExceeded).message).toBe("レート制限の使用率がしきい値を超えた（使用率 90%、しきい値 90%）");
    expect((error as RateLimitExceeded).estimatedMinutes).toBe(3);
    expect(h.calls).toHaveLength(0);
    expect(h.apiCalls()).toBe(0);
  });

  it("呼び出しのたびにヘッダで使用率を更新し、次の呼び出しの前にしきい値を超えていれば止まる", async () => {
    const h = harness([ok({ id: "1" }, usageHeader(95)), ok({ id: "2" })]);
    const first = await h.client.get("me");
    expect(first.ok).toBe(true);
    expect(h.rate.percent()).toBe(95);
    await expect(h.client.get("me")).rejects.toThrow(RateLimitExceeded);
    expect(h.calls).toHaveLength(1);
  });

  it("transient の応答のヘッダでしきい値を超えていれば、再試行の待ちに入らずに止める", async () => {
    const h = harness([() => new Response(null, { status: 500, headers: usageHeader(99) })]);
    await expect(h.client.get("me")).rejects.toThrow(RateLimitExceeded);
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  it("コード 1／2 の本文つきエラーは transient として再試行し、各試行の本文を保存する", async () => {
    const h = harness([
      graphError({ message: "An unknown error occurred", code: 1 }, 500),
      graphError({ message: "Service temporarily unavailable", code: 2 }, 400),
      ok({ id: "1" }),
    ]);
    const res = await h.client.get<{ id: string }>("me");
    expect(res.ok).toBe(true);
    expect(res.rawResponseId).toBe("3");
    expect(h.calls).toHaveLength(3);
    expect(h.sleeps).toEqual([2000, 8000]);
    expect(h.persisted.map((p) => p.body)).toEqual([
      { error: { message: "An unknown error occurred", code: 1 } },
      { error: { message: "Service temporarily unavailable", code: 2 } },
      { id: "1" },
    ]);
  });

  it("persistRaw が reject したら get も reject する。呼び出しは数えられている", async () => {
    const h = harness([ok({ id: "1" })], {
      persistRaw: async () => {
        throw new Error("raw_api_responses の insert に失敗");
      },
    });
    await expect(h.client.get("me")).rejects.toThrow("raw_api_responses の insert に失敗");
    expect(h.apiCalls()).toBe(1);
  });

  it("auth（190）は onAuthError を呼んでから AuthError を投げる。再試行しない", async () => {
    const h = harness([graphError({ message: "Invalid OAuth access token", code: 190, error_subcode: 463 })]);
    const error = await h.client.get("me").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).code).toBe(190);
    expect((error as AuthError).message).toBe("トークンが無効（コード 190）");
    expect(h.authCodes).toEqual([190]);
    expect(h.calls).toHaveLength(1);
    expect(h.persisted).toHaveLength(1);
  });

  it("onAuthError が完了してから AuthError を投げる（順序）", async () => {
    const events: string[] = [];
    const h = harness([graphError({ message: "x", code: 190 })], {
      onAuthError: async () => {
        events.push("onAuthError:start");
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push("onAuthError:end");
      },
    });
    await h.client.get("me").catch(() => events.push("caught"));
    expect(events).toEqual(["onAuthError:start", "onAuthError:end", "caught"]);
  });

  it("onAuthError が reject しても AuthError を投げる", async () => {
    const h = harness([graphError({ message: "x", code: 190 })], {
      onAuthError: async () => {
        throw new Error("private.credentials の更新に失敗");
      },
    });
    const error = await h.client.get("me").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).code).toBe(190);
    expect(h.authCodes).toEqual([190]);
  });

  it("権限不足（10、200〜299）は固定文言の AuthError", async () => {
    for (const code of [10, 200, 299]) {
      const h = harness([graphError({ message: "permission", code }, 403)]);
      const error = await h.client.get("me").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AuthError);
      expect((error as AuthError).message).toBe(`権限が足りない（コード ${code}）`);
      expect(h.authCodes).toEqual([code]);
    }
    expect(authErrorMessage(190)).toBe("トークンが無効（コード 190）");
    expect(authErrorMessage(10)).toBe("権限が足りない（コード 10）");
  });

  it("fatal は再試行せず ok: false, errorClass: fatal を返す。エラー応答は保存する", async () => {
    const error: GraphError = { message: "Invalid parameter", type: "OAuthException", code: 100, error_subcode: 33 };
    const h = harness([graphError(error)]);
    const res = await h.client.get("me");
    expect(res).toEqual({
      ok: false,
      status: 400,
      data: undefined,
      error,
      errorClass: "fatal",
      rawResponseId: "1",
      fetchedAt: FIXED_NOW,
    });
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
    expect(h.persisted[0]?.body).toEqual({ error });
  });

  it("persist: false なら保存せず rawResponseId は undefined", async () => {
    const h = harness([ok({ data: { is_valid: true } })]);
    const res = await h.client.get("debug_token", { input_token: "SECRET_TOKEN" }, { persist: false });
    expect(res.ok).toBe(true);
    expect(res.rawResponseId).toBeUndefined();
    expect(h.persisted).toEqual([]);
    expect(h.apiCalls()).toBe(1);
  });

  it("保存する params から秘密のキーを除き、body の期限付き URL と paging.next を落とす", async () => {
    const h = harness([
      ok({
        data: [{ id: "1", media_url: "https://scontent.cdninstagram.com/a.jpg?oe=1", children: { data: [{ media_url: "https://x/b.jpg" }] } }],
        paging: { cursors: { before: "B", after: "A" }, next: "https://graph.facebook.com/x?access_token=SECRET_TOKEN" },
      }),
    ]);
    await h.client.get("x/media", { fields: "id,media_url", access_token: "SECRET_TOKEN", appsecret_proof: "p", input_token: "t" });
    const row = h.persisted[0];
    expect(row?.params).toEqual({ fields: "id,media_url" });
    expect(row?.body).toEqual({
      data: [{ id: "1", media_url: "<omitted>", children: { data: [{ media_url: "<omitted>" }] } }],
      paging: { cursors: { before: "B", after: "A" }, next: "<omitted>" },
    });
    expect(JSON.stringify(row)).not.toContain("SECRET_TOKEN");
    expect(JSON.stringify(row)).not.toContain("cdninstagram.com");
  });

  it("エラー応答の message は出所でマスクし、保存にも戻り値にもマスク済みを使う（既定はパターン、maskText で差し替え）", async () => {
    const message = "Bad https://graph.facebook.com/x?access_token=SECRET_TOKEN id 17841400000000000";
    const h = harness([graphError({ message, code: 100 })]);
    const res = await h.client.get("me");
    expect(res.error?.message).toBe("Bad <url> id ***");
    const stored = h.persisted[0]?.body as { error: GraphError };
    expect(stored.error.message).toBe("Bad <url> id ***");
    expect(stored.error.code).toBe(100);
    expect(JSON.stringify(res)).not.toContain("SECRET_TOKEN");

    const masked = harness([graphError({ message: "token SECRET_TOKEN here", code: 100 })], {
      maskText: (text) => text.replaceAll("SECRET_TOKEN", "***"),
    });
    const res2 = await masked.client.get("me");
    expect(res2.error?.message).toBe("token *** here");
    expect((masked.persisted[0]?.body as { error: GraphError }).error.message).toBe("token *** here");
  });

  it("保存と戻り値のエラーは許可リストのキーだけ（error_user_msg などの自由文は落とす）", async () => {
    const apiError = {
      message: "Invalid parameter",
      type: "OAuthException",
      code: 100,
      error_subcode: 33,
      fbtrace_id: "AbCdEf",
      error_user_title: "見てね",
      error_user_msg: "詳しくは https://developers.facebook.com/x?access_token=SECRET_TOKEN を参照",
      is_transient: false,
    } as GraphError;
    const h = harness([graphError(apiError)]);
    const res = await h.client.get("me");
    const expected: GraphError = {
      message: "Invalid parameter",
      type: "OAuthException",
      code: 100,
      error_subcode: 33,
      fbtrace_id: "AbCdEf",
    };
    expect(res.error).toStrictEqual(expected);
    expect(h.persisted[0]?.body).toStrictEqual({ error: expected });
    const text = JSON.stringify(h.persisted[0]) + JSON.stringify(res);
    expect(text).not.toContain("error_user_msg");
    expect(text).not.toContain("error_user_title");
    expect(text).not.toContain("is_transient");
    expect(text).not.toContain("://");
    expect(text).not.toContain("SECRET_TOKEN");
  });
});

// ---------------------------------------------------------------------------
// JobGraphClient.debugToken（設計 4.2 章: token_check 用。生レスポンスは保存しない）
// ---------------------------------------------------------------------------

describe("JobGraphClient.debugToken", () => {
  const validBody = {
    data: { type: "PAGE", is_valid: true, expires_at: 0, data_access_expires_at: 1_798_761_600, scopes: ["instagram_basic"] },
  };

  it("input_token に自分のトークン、Authorization にアプリトークンを使い、persistRaw を呼ばず、呼び出しは数える", async () => {
    const h = harness([ok(validBody, usageHeader(7))]);
    const res = await h.client.debugToken();
    expect(res.ok).toBe(true);
    expect(res.data?.data?.is_valid).toBe(true);
    expect(res.data?.data?.type).toBe("PAGE");
    expect(res.rawResponseId).toBeUndefined();
    expect(res.status).toBe(200);
    expect(res.fetchedAt).toEqual(FIXED_NOW);
    expect(h.persisted).toEqual([]);
    expect(h.apiCalls()).toBe(1);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.pathname).toBe("/v25.0/debug_token");
    expect(h.calls[0]?.searchParams.get("input_token")).toBe("SECRET_TOKEN");
    expect(h.calls[0]?.searchParams.has("access_token")).toBe(false);
    expect(h.auths[0]).toBe(`Bearer ${APP_TOKEN}`);
    // ヘッダで使用率を更新する
    expect(h.rate.percent()).toBe(7);
  });

  it("is_valid: false は HTTP 200 で返るので ok: true の data で判断する", async () => {
    const h = harness([ok({ data: { is_valid: false, scopes: [], error: { code: 190, message: "Error validating access token" } } })]);
    const res = await h.client.debugToken();
    expect(res.ok).toBe(true);
    expect(res.data?.data?.is_valid).toBe(false);
    expect(h.authCodes).toEqual([]);
    expect(h.persisted).toEqual([]);
  });

  it("190（アプリトークンの誤り）は onAuthError を呼ばず、fatal として返す。保存しない", async () => {
    const h = harness([graphError({ message: "Invalid OAuth access token", type: "OAuthException", code: 190, error_subcode: 463 })]);
    const res = await h.client.debugToken();
    expect(res.ok).toBe(false);
    expect(res.errorClass).toBe("fatal");
    expect(res.error).toEqual({ message: "Invalid OAuth access token", type: "OAuthException", code: 190, error_subcode: 463 });
    expect(res.rawResponseId).toBeUndefined();
    expect(h.authCodes).toEqual([]);
    expect(h.persisted).toEqual([]);
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  it("権限不足（10、200）も fatal として返し、onAuthError を呼ばない", async () => {
    for (const code of [10, 200]) {
      const h = harness([graphError({ message: "permission", code }, 403)]);
      const res = await h.client.debugToken();
      expect(res.ok).toBe(false);
      expect(res.errorClass).toBe("fatal");
      expect(res.error?.code).toBe(code);
      expect(h.authCodes).toEqual([]);
    }
  });

  it("HTTP 500 は再試行し、成功すれば ok。使い切れば transient", async () => {
    const h = harness([() => new Response(null, { status: 500 }), ok(validBody)]);
    const res = await h.client.debugToken();
    expect(res.ok).toBe(true);
    expect(h.calls).toHaveLength(2);
    expect(h.sleeps).toEqual([2000]);
    expect(h.apiCalls()).toBe(2);
    expect(h.persisted).toEqual([]);

    const exhausted = harness([
      () => new Response(null, { status: 500 }),
      () => new Response(null, { status: 502 }),
      () => new Response(null, { status: 503 }),
    ]);
    const res2 = await exhausted.client.debugToken();
    expect(res2.ok).toBe(false);
    expect(res2.errorClass).toBe("transient");
    expect(res2.status).toBe(503);
    expect(res2.rawResponseId).toBeUndefined();
    expect(exhausted.calls).toHaveLength(3);
    expect(exhausted.sleeps).toEqual([2000, 8000]);
    expect(exhausted.persisted).toEqual([]);
  });

  it("fatal（コード 100 など）はそのまま fatal", async () => {
    const h = harness([graphError({ message: "Invalid appsecret", code: 100 })]);
    const res = await h.client.debugToken();
    expect(res.ok).toBe(false);
    expect(res.errorClass).toBe("fatal");
    expect(res.error?.code).toBe(100);
  });

  it("rate は投げる。しきい値を超えていれば呼ばずに投げる", async () => {
    const h = harness([graphError({ message: "limit", code: 4 })]);
    await expect(h.client.debugToken()).rejects.toThrow(RateLimitExceeded);
    expect(h.calls).toHaveLength(1);

    const over = harness([ok(validBody)], { initial: { call_count: 95, total_cputime: 1, total_time: 1 } });
    await expect(over.client.debugToken()).rejects.toThrow(RateLimitExceeded);
    expect(over.calls).toHaveLength(0);
    expect(over.apiCalls()).toBe(0);
  });

  it("戻り値にアプリトークンも自分のトークンも含まない", async () => {
    const h = harness([graphError({ message: `bad token SECRET_TOKEN ${APP_TOKEN}`, code: 190 })], {
      maskText: (text) => text.replaceAll("SECRET_TOKEN", "***").replaceAll(APP_TOKEN, "***"),
    });
    const res = await h.client.debugToken();
    const text = JSON.stringify(res);
    expect(text).not.toContain("SECRET_TOKEN");
    expect(text).not.toContain("APP_SECRET");
  });
});

// ---------------------------------------------------------------------------
// JobGraphClient.pages（設計 11.1 章 P8: 最終ページでも cursors.after が付くので paging.next の有無で止める）
// ---------------------------------------------------------------------------

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("JobGraphClient.pages", () => {
  it("paging.next があれば cursors.after を after に渡して次のページを取り、next がないページで止まる", async () => {
    const h = harness([
      ok({ data: [{ id: "1" }], paging: { cursors: { before: "b1", after: "A1" }, next: "https://graph.facebook.com/x?after=A1" } }),
      ok({ data: [{ id: "2" }], paging: { cursors: { before: "b2", after: "A2" }, next: "https://graph.facebook.com/x?after=A2" } }),
      ok({ data: [{ id: "3" }], paging: { cursors: { before: "b3", after: "A3" } } }),
    ]);
    const pages = await collect(h.client.pages<{ id: string }>("x/media", { fields: "id", limit: 50 }));
    expect(pages.map((p) => p.data?.data.map((d) => d.id))).toEqual([["1"], ["2"], ["3"]]);
    expect(pages.every((p) => p.ok)).toBe(true);
    expect(h.calls).toHaveLength(3);
    expect(h.calls[0]?.searchParams.has("after")).toBe(false);
    expect(h.calls[0]?.searchParams.get("limit")).toBe("50");
    expect(h.calls[1]?.searchParams.get("after")).toBe("A1");
    expect(h.calls[2]?.searchParams.get("after")).toBe("A2");
    // paging.next の URL は使わない
    for (const call of h.calls) expect(call.pathname).toBe("/v25.0/x/media");
    // 保存した params にも after が入り、next は落ちる
    expect(h.persisted[1]?.params).toEqual({ fields: "id", limit: 50, after: "A1" });
    expect((h.persisted[0]?.body as Page<unknown>).paging?.next).toBe("<omitted>");
  });

  it("最終ページに cursors.after が付いていても next がなければ止まる（P8）", async () => {
    const h = harness([ok({ data: [{ id: "1" }], paging: { cursors: { before: "b", after: "A1" } } })]);
    const pages = await collect(h.client.pages("x/media"));
    expect(pages).toHaveLength(1);
    expect(h.calls).toHaveLength(1);
  });

  it("next はあるが cursors.after がなければ止まる", async () => {
    const h = harness([ok({ data: [{ id: "1" }], paging: { next: "https://graph.facebook.com/x" } })]);
    expect(await collect(h.client.pages("x/media"))).toHaveLength(1);
    expect(h.calls).toHaveLength(1);
  });

  it("data が空なら next があっても止まる", async () => {
    const h = harness([ok({ data: [], paging: { cursors: { after: "A1" }, next: "https://graph.facebook.com/x" } })]);
    const pages = await collect(h.client.pages("x/media"));
    expect(pages).toHaveLength(1);
    expect(pages[0]?.data?.data).toEqual([]);
    expect(h.calls).toHaveLength(1);
  });

  it("2 ページ目が fatal なら、そのページ（ok: false）を yield して止まる", async () => {
    const h = harness([
      ok({ data: [{ id: "1" }], paging: { cursors: { after: "A1" }, next: "https://graph.facebook.com/x" } }),
      graphError({ message: "Invalid cursor", code: 100 }),
      ok({ data: [{ id: "3" }] }),
    ]);
    const pages = await collect(h.client.pages("x/media"));
    expect(pages).toHaveLength(2);
    expect(pages[0]?.ok).toBe(true);
    expect(pages[1]?.ok).toBe(false);
    expect(pages[1]?.errorClass).toBe("fatal");
    expect(h.calls).toHaveLength(2);
  });

  it("2 ページ目が transient を使い切っても、そのページを yield して止まる", async () => {
    const h = harness([
      ok({ data: [{ id: "1" }], paging: { cursors: { after: "A1" }, next: "https://graph.facebook.com/x" } }),
      () => new Response(null, { status: 500 }),
      () => new Response(null, { status: 500 }),
      () => new Response(null, { status: 500 }),
    ]);
    const pages = await collect(h.client.pages("x/media"));
    expect(pages).toHaveLength(2);
    expect(pages[1]?.errorClass).toBe("transient");
    expect(h.calls).toHaveLength(4);
  });

  it("2 ページ目で rate なら RateLimitExceeded が反復の中から投げられる", async () => {
    const h = harness([
      ok({ data: [{ id: "1" }], paging: { cursors: { after: "A1" }, next: "https://graph.facebook.com/x" } }),
      graphError({ message: "limit", code: 4 }),
    ]);
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const page of h.client.pages<{ id: string }>("x/media")) {
          seen.push(...(page.data?.data.map((d) => d.id) ?? []));
        }
      })(),
    ).rejects.toThrow(RateLimitExceeded);
    expect(seen).toEqual(["1"]);
  });

  it("呼び出し側の params は変わらない。params.after を事前に渡せば 1 ページ目に使う", async () => {
    const h = harness([
      ok({ data: [{ id: "1" }], paging: { cursors: { after: "A1" }, next: "https://graph.facebook.com/x" } }),
      ok({ data: [{ id: "2" }], paging: { cursors: { after: "A2" } } }),
    ]);
    const params = { fields: "id", limit: 50, after: "PRE" };
    const copy = { ...params };
    const pages = await collect(h.client.pages("x/media", params));
    expect(pages).toHaveLength(2);
    expect(params).toEqual(copy);
    expect(h.calls[0]?.searchParams.get("after")).toBe("PRE");
    expect(h.calls[1]?.searchParams.get("after")).toBe("A1");
    expect(h.persisted[0]?.params).toEqual({ fields: "id", limit: 50, after: "PRE" });
  });

  it("2 ページ目で auth なら AuthError が反復の中から投げられ、onAuthError も呼ばれる", async () => {
    const h = harness([
      ok({ data: [{ id: "1" }], paging: { cursors: { after: "A1" }, next: "https://graph.facebook.com/x" } }),
      graphError({ message: "Invalid OAuth access token", code: 190 }),
    ]);
    await expect(collect(h.client.pages("x/media"))).rejects.toThrow(AuthError);
    expect(h.authCodes).toEqual([190]);
    expect(h.calls).toHaveLength(2);
  });

  it("同じ after が返り続けても無限に回らない", async () => {
    const same = () => ok({ data: [{ id: "1" }], paging: { cursors: { after: "SAME" }, next: "https://graph.facebook.com/x" } });
    const h = harness([same(), same(), same()]);
    const pages = await collect(h.client.pages("x/media"));
    expect(pages).toHaveLength(2);
    expect(h.calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// stripSecretParams、stripVolatileFields
// ---------------------------------------------------------------------------

describe("stripSecretParams", () => {
  it("access_token、input_token、appsecret_proof と undefined の値を除き、入力を変えない", () => {
    const params = {
      fields: "id",
      limit: 50,
      since: undefined,
      access_token: "SECRET_TOKEN",
      input_token: "SECRET_TOKEN",
      appsecret_proof: "abc",
    };
    const copy = { ...params };
    const out = stripSecretParams(params);
    expect(out).toEqual({ fields: "id", limit: 50 });
    expect(params).toEqual(copy);
    expect(JSON.stringify(out)).not.toContain("SECRET_TOKEN");
    expect(stripSecretParams({})).toEqual({});
  });
});

describe("stripVolatileFields", () => {
  const body = {
    data: [
      {
        id: "1",
        media_url: "https://scontent.cdninstagram.com/v/a.mp4?oe=1",
        thumbnail_url: "https://scontent.cdninstagram.com/v/a.jpg",
        children: { data: [{ id: "2", media_url: "https://scontent.cdninstagram.com/v/b.jpg" }] },
      },
      { id: "3", caption: "キャプション", like_count: 0 },
    ],
    paging: {
      cursors: { before: "BEFORE", after: "AFTER" },
      next: "https://graph.facebook.com/v25.0/x/media?access_token=SECRET_TOKEN&after=AFTER",
      previous: "https://graph.facebook.com/v25.0/x/media?access_token=SECRET_TOKEN&before=BEFORE",
    },
    profile_picture_url: "https://scontent.cdninstagram.com/p.jpg",
    access_token: "SECRET_TOKEN",
    nested: { deeper: [{ access_token: "SECRET_TOKEN", keep: 1 }] },
  };

  it("期限付き URL、トークン、paging の next と previous を <omitted> にし、cursors は残す", () => {
    const out = stripVolatileFields(body);
    expect(out).toEqual({
      data: [
        {
          id: "1",
          media_url: "<omitted>",
          thumbnail_url: "<omitted>",
          children: { data: [{ id: "2", media_url: "<omitted>" }] },
        },
        { id: "3", caption: "キャプション", like_count: 0 },
      ],
      paging: { cursors: { before: "BEFORE", after: "AFTER" }, next: "<omitted>", previous: "<omitted>" },
      profile_picture_url: "<omitted>",
      access_token: "<omitted>",
      nested: { deeper: [{ access_token: "<omitted>", keep: 1 }] },
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain("SECRET_TOKEN");
    expect(text).not.toContain("cdninstagram.com");
    expect(text).not.toContain("access_token=");
  });

  it("入力を変えない", () => {
    const snapshot = JSON.stringify(body);
    stripVolatileFields(body);
    expect(JSON.stringify(body)).toBe(snapshot);
  });

  it("paging.next がない、paging がない、cursors だけ、でも壊れない", () => {
    expect(stripVolatileFields({ data: [], paging: { cursors: { after: "A" } } })).toEqual({
      data: [],
      paging: { cursors: { after: "A" } },
    });
    expect(stripVolatileFields({ data: [{ id: "1" }] })).toEqual({ data: [{ id: "1" }] });
  });

  it("paging の外の next と previous は残す。paging の中の cursors の next は paging 直下ではないので残す", () => {
    expect(stripVolatileFields({ next: "keep", paging: { cursors: { next: "keep-too" }, next: "drop" } })).toEqual({
      next: "keep",
      paging: { cursors: { next: "keep-too" }, next: "<omitted>" },
    });
  });

  it("data[] の要素の next は残り、children.paging.next は落ちる", () => {
    const input = {
      data: [
        {
          id: "1",
          next: "keep",
          children: { data: [{ id: "2" }], paging: { cursors: { after: "c" }, next: "drop", previous: "drop" } },
        },
      ],
    };
    expect(stripVolatileFields(input)).toEqual({
      data: [
        {
          id: "1",
          next: "keep",
          children: { data: [{ id: "2" }], paging: { cursors: { after: "c" }, next: "<omitted>", previous: "<omitted>" } },
        },
      ],
    });
  });

  it("null の値は null のまま。プリミティブと配列はそのまま", () => {
    expect(stripVolatileFields({ media_url: null, thumbnail_url: undefined })).toEqual({ media_url: null, thumbnail_url: undefined });
    expect(stripVolatileFields(null)).toBeNull();
    expect(stripVolatileFields("text")).toBe("text");
    expect(stripVolatileFields(42)).toBe(42);
    expect(stripVolatileFields([1, { media_url: "x" }])).toEqual([1, { media_url: "<omitted>" }]);
  });
});
