/**
 * `lib/vision-client.ts`（R4.1 設計 3.5 節、3.6 節、8 章）。偽の `fetch` で本物の API は呼ばない。
 * JWT の鍵はテストの中で作る（PEM をコミットしない）
 */
import { createVerify, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GOOGLE_OAUTH_TOKEN_URI } from "../src/config.js";
import {
  ANNOTATE_TIMEOUT_MS,
  authFailedError,
  createServiceAccountJwt,
  createVisionClient,
  parseAnnotateResponse,
  RATE_LIMIT_ERROR,
  requestFailedError,
  RETRY_DELAYS_MS,
  SIGN_ERROR,
  splitRequests,
  TOKEN_REFRESH_MARGIN_S,
  unitsFor,
  VISION_ANNOTATE_URL,
  VISION_SCOPE,
  VisionError,
  type AnnotateAttempt,
} from "../src/lib/vision-client.js";
import { MAX_TEXT_CHARS_PER_FRAME, MAX_WORDS_PER_FRAME } from "../src/lib/video-text.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const KEY = { clientEmail: "worker@fake-project.iam.gserviceaccount.com", privateKey: PEM };
const NOW = new Date("2026-10-11T12:00:00Z");
const TOKEN = "ya29.FAKE_ACCESS_TOKEN_FOR_TEST";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/vision/${name}`, import.meta.url)), "utf8");
}

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("createServiceAccountJwt", () => {
  it("生成した鍵で署名が検証でき、iss・scope・aud・iat・exp が設計どおり", () => {
    const jwt = createServiceAccountJwt(KEY, NOW);
    const [header, claims, signature] = jwt.split(".");
    expect(decode(header ?? "")).toEqual({ alg: "RS256", typ: "JWT" });
    const iat = Math.floor(NOW.getTime() / 1000);
    expect(decode(claims ?? "")).toEqual({ iss: KEY.clientEmail, scope: VISION_SCOPE, aud: GOOGLE_OAUTH_TOKEN_URI, iat, exp: iat + 3600 });
    expect(VISION_SCOPE).toBe("https://www.googleapis.com/auth/cloud-vision");
    const ok = createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, signature ?? "", "base64url");
    expect(ok).toBe(true);
  });

  it("private_key の改行が \\n にエスケープされた JSON から読んだ鍵でも署名できる", () => {
    const json = JSON.stringify({ private_key: PEM });
    const parsed = JSON.parse(json) as { private_key: string };
    expect(parsed.private_key).toBe(PEM);
    expect(() => createServiceAccountJwt({ ...KEY, privateKey: parsed.private_key }, NOW)).not.toThrow();
  });

  it("鍵が壊れていれば例外（クライアントは SIGN_ERROR にする）", () => {
    expect(() => createServiceAccountJwt({ ...KEY, privateKey: "-----BEGIN PRIVATE KEY-----\nbroken\n-----END PRIVATE KEY-----\n" }, NOW)).toThrow();
  });
});

describe("splitRequests", () => {
  const img = (byteLength: number, id: number) => ({ id, byteLength });

  it("8 枚ずつ、6 MB の手前で切る。1 枚で超えるものは tooLarge", () => {
    const frames = Array.from({ length: 10 }, (_, i) => img(100, i));
    const { batches, tooLarge } = splitRequests(frames);
    expect(batches.map((b) => b.length)).toEqual([8, 2]);
    expect(tooLarge).toEqual([]);
    const mb = 1024 * 1024;
    const big = splitRequests([img(3 * mb, 0), img(2 * mb, 1), img(7 * mb, 2), img(1 * mb, 3)], { maxImages: 8, maxBodyBytes: 6 * mb });
    // base64 は 4/3 倍: 3 MB → 4 MB、2 MB → 2.67 MB で合計 6.67 MB > 6 MB なので 2 枚目から新しい要求
    expect(big.batches.map((b) => b.map((f) => f.id))).toEqual([[0], [1, 3]]);
    expect(big.tooLarge.map((f) => f.id)).toEqual([2]);
    expect(splitRequests([])).toEqual({ batches: [], tooLarge: [] });
  });
});

describe("parseAnnotateResponse", () => {
  it("文字あり: 4.1 節の形に切り詰め、座標の省略は 0、confidence 欠落は 0、detectedLanguages 空は null、pages[0] の幅と高さ", () => {
    const frames = parseAnnotateResponse(fixture("annotate-text.json"), 1);
    expect(frames).toHaveLength(1);
    const frame = frames?.[0];
    expect(frame?.ok).toBe(true);
    if (!frame?.ok) return;
    expect(frame.text).toBe("溝口から 徒歩4分\n");
    expect(frame.width).toBe(720);
    expect(frame.height).toBe(1280);
    expect(frame.wordCount).toBe(3);
    expect(frame.words).toEqual([
      { b: 0, p: 0, t: "溝口から", c: 0.991, l: "ja", x0: 200, y0: 300, x1: 360, y1: 345, br: "SPACE" },
      { b: 0, p: 0, t: "徒歩", c: 0.98, l: null, x0: 0, y0: 300, x1: 450, y1: 345, br: null },
      { b: 0, p: 0, t: "4分", c: 0, l: null, x0: 450, y0: 300, x1: 520, y1: 345, br: "LINE_BREAK" },
    ]);
  });

  it("文字なしは text '' と words []。1 枚ごとの error は code だけ（message は持たない）", () => {
    expect(parseAnnotateResponse(fixture("annotate-empty.json"), 1)).toEqual([{ ok: true, text: "", words: [], wordCount: 0, width: null, height: null }]);
    const error = parseAnnotateResponse(fixture("annotate-error.json"), 1);
    expect(error).toEqual([{ ok: false, errorCode: 3 }]);
    expect(JSON.stringify(error)).not.toContain("Bad image data");
  });

  it("枚数の不一致、responses がない、JSON でない本文、型の不正は undefined", () => {
    expect(parseAnnotateResponse(fixture("annotate-empty.json"), 2)).toBeUndefined();
    expect(parseAnnotateResponse("{}", 1)).toBeUndefined();
    expect(parseAnnotateResponse("<html>", 1)).toBeUndefined();
    expect(parseAnnotateResponse('{"responses": "x"}', 1)).toBeUndefined();
    expect(parseAnnotateResponse('{"responses": [1]}', 1)).toBeUndefined();
    expect(parseAnnotateResponse("[]", 0)).toBeUndefined();
  });

  it("語数と文字数の上限で切り詰め、wordCount は切り詰める前の数", () => {
    const words = Array.from({ length: MAX_WORDS_PER_FRAME + 5 }, () => ({ symbols: [{ text: "あ" }], confidence: 0.9 }));
    const text = "あ".repeat(MAX_TEXT_CHARS_PER_FRAME + 10);
    const body = { responses: [{ fullTextAnnotation: { pages: [{ width: 10, height: 20, blocks: [{ paragraphs: [{ words }] }] }], text } }] };
    const frame = parseAnnotateResponse(body, 1)?.[0];
    expect(frame?.ok).toBe(true);
    if (!frame?.ok) return;
    expect(frame.words).toHaveLength(MAX_WORDS_PER_FRAME);
    expect(frame.wordCount).toBe(MAX_WORDS_PER_FRAME + 5);
    expect(Array.from(frame.text)).toHaveLength(MAX_TEXT_CHARS_PER_FRAME);
  });

  it("unitsFor: 429／401／403 は 0、それ以外（応答なしを含む）は枚数", () => {
    expect([429, 401, 403].map((s) => unitsFor(s, 8))).toEqual([0, 0, 0]);
    expect([200, 400, 500, undefined].map((s) => unitsFor(s, 8))).toEqual([8, 8, 8, 8]);
  });
});

/** 偽の fetch。トークンと annotate の応答を順に返す */
function fakeFetch(options: {
  token?: () => Response;
  annotate: (call: { body: string; authorization: string | null; signal: AbortSignal | null | undefined }) => Response | Promise<Response>;
}): { fetchImpl: typeof fetch; calls: { url: string; redirect: string | undefined; authorization: string | null }[] } {
  const calls: { url: string; redirect: string | undefined; authorization: string | null }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    calls.push({ url, redirect: init?.redirect, authorization: headers.get("authorization") });
    if (url === GOOGLE_OAUTH_TOKEN_URI) {
      return options.token?.() ?? new Response(JSON.stringify({ access_token: TOKEN, expires_in: 3599, token_type: "Bearer" }), { status: 200 });
    }
    if (url === VISION_ANNOTATE_URL) {
      return options.annotate({ body: String(init?.body ?? ""), authorization: headers.get("authorization"), signal: init?.signal });
    }
    throw new Error("unexpected url");
  };
  return { fetchImpl, calls };
}

const IMAGES = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])];
const OK_BODY = JSON.stringify({ responses: [{}, {}] });

describe("createVisionClient", () => {
  it("トークンを取り、Bearer で images:annotate に送る。redirect は error。トークンは戻り値に出ない。onToken で登録する", async () => {
    const seen: string[] = [];
    const { fetchImpl, calls } = fakeFetch({ annotate: () => new Response(OK_BODY, { status: 200 }) });
    const client = createVisionClient(KEY, { fetch: fetchImpl, now: () => NOW, onToken: (t) => seen.push(t) });
    const attempts: AnnotateAttempt[] = [];
    const result = await client.annotate(IMAGES, { onAttempt: async (a) => void attempts.push(a) });
    expect(result.ok).toBe(true);
    expect(result.frames).toHaveLength(2);
    expect(result.imageCount).toBe(2);
    expect(result.httpStatus).toBe(200);
    expect(attempts).toHaveLength(1);
    expect(calls.map((c) => c.url)).toEqual([GOOGLE_OAUTH_TOKEN_URI, VISION_ANNOTATE_URL]);
    expect(calls.every((c) => c.redirect === "error")).toBe(true);
    expect(calls[1]?.authorization).toBe(`Bearer ${TOKEN}`);
    // 署名済みの JWT（assertion）とアクセストークンの両方を onToken で登録する（セキュリティレビュー S6）
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(seen[1]).toBe(TOKEN);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("expires_in − 300 秒までトークンを使い回し、過ぎたら取り直す", async () => {
    let now = NOW;
    const { fetchImpl, calls } = fakeFetch({ annotate: () => new Response(OK_BODY, { status: 200 }) });
    const client = createVisionClient(KEY, { fetch: fetchImpl, now: () => now });
    await client.annotate(IMAGES, { onAttempt: async () => {} });
    now = new Date(NOW.getTime() + (3599 - TOKEN_REFRESH_MARGIN_S) * 1000 - 1000);
    await client.annotate(IMAGES, { onAttempt: async () => {} });
    expect(calls.filter((c) => c.url === GOOGLE_OAUTH_TOKEN_URI)).toHaveLength(1);
    now = new Date(NOW.getTime() + (3599 - TOKEN_REFRESH_MARGIN_S) * 1000 + 1000);
    await client.annotate(IMAGES, { onAttempt: async () => {} });
    expect(calls.filter((c) => c.url === GOOGLE_OAUTH_TOKEN_URI)).toHaveLength(2);
  });

  it("トークンの 400／401／403 は auth の VisionError（固定文言）。通信しない鍵の署名の失敗は SIGN_ERROR", async () => {
    for (const status of [400, 401, 403]) {
      const { fetchImpl, calls } = fakeFetch({
        token: () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "secret detail" }), { status }),
        annotate: () => new Response(OK_BODY),
      });
      const client = createVisionClient(KEY, { fetch: fetchImpl, now: () => NOW });
      const error = await client.ensureToken().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(VisionError);
      expect((error as VisionError).kind).toBe("auth");
      expect((error as VisionError).message).toBe(authFailedError(status));
      expect((error as VisionError).message).not.toContain("secret detail");
      expect(calls.map((c) => c.url)).toEqual([GOOGLE_OAUTH_TOKEN_URI]);
    }
    const broken = createVisionClient({ ...KEY, privateKey: "not a key" }, { fetch: fakeFetch({ annotate: () => new Response(OK_BODY) }).fetchImpl });
    await expect(broken.ensureToken()).rejects.toMatchObject({ kind: "auth", message: SIGN_ERROR });
  });

  it("429 と 5xx だけ 2 回まで再送（2 秒、8 秒）。試行ごとに onAttempt。429 の後に成功", async () => {
    const statuses = [429, 503, 200];
    const slept: number[] = [];
    const { fetchImpl } = fakeFetch({
      annotate: () => {
        const status = statuses.shift() ?? 200;
        return new Response(status === 200 ? OK_BODY : "{}", { status });
      },
    });
    const client = createVisionClient(KEY, { fetch: fetchImpl, now: () => NOW, sleep: async (ms) => void slept.push(ms) });
    const attempts: AnnotateAttempt[] = [];
    const result = await client.annotate(IMAGES, { onAttempt: async (a) => void attempts.push(a) });
    expect(result.ok).toBe(true);
    expect(attempts.map((a) => [a.ok, a.httpStatus, a.error?.kind, a.error?.message])).toEqual([
      [false, 429, "rate", RATE_LIMIT_ERROR],
      [false, 503, "transient", requestFailedError(503)],
      [true, 200, undefined, undefined],
    ]);
    expect(slept).toEqual([...RETRY_DELAYS_MS]);
    expect(attempts.map((a) => unitsFor(a.httpStatus, a.imageCount))).toEqual([0, 2, 2]);
  });

  it("3 回とも 429 なら 2 回の再送で止まる。canRetry が偽なら再送しない", async () => {
    const { fetchImpl, calls } = fakeFetch({ annotate: () => new Response("{}", { status: 429 }) });
    const client = createVisionClient(KEY, { fetch: fetchImpl, now: () => NOW, sleep: async () => {} });
    const result = await client.annotate(IMAGES, { onAttempt: async () => {} });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("rate");
    expect(calls.filter((c) => c.url === VISION_ANNOTATE_URL)).toHaveLength(3);
    const noRetry = fakeFetch({ annotate: () => new Response("{}", { status: 500 }) });
    const client2 = createVisionClient(KEY, { fetch: noRetry.fetchImpl, now: () => NOW, sleep: async () => {} });
    await client2.annotate(IMAGES, { onAttempt: async () => {}, canRetry: () => false });
    expect(noRetry.calls.filter((c) => c.url === VISION_ANNOTATE_URL)).toHaveLength(1);
  });

  it("制限時間切れ（TimeoutError）は timeout で再送しない。401／403 は auth、400 は fatal で再送しない。signal に 30 秒の制限がある", async () => {
    let signal: AbortSignal | null | undefined;
    const timeout = fakeFetch({
      annotate: (call) => {
        signal = call.signal;
        throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      },
    });
    const client = createVisionClient(KEY, { fetch: timeout.fetchImpl, now: () => NOW, sleep: async () => {} });
    const result = await client.annotate(IMAGES, { onAttempt: async () => {} });
    expect(result).toMatchObject({ ok: false, httpStatus: undefined, responseBytes: null });
    expect(result.error?.kind).toBe("timeout");
    expect(result.error?.message).toBe(requestFailedError(undefined));
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(ANNOTATE_TIMEOUT_MS).toBe(30_000);
    expect(timeout.calls.filter((c) => c.url === VISION_ANNOTATE_URL)).toHaveLength(1);

    for (const [status, kind] of [[401, "auth"], [403, "auth"], [400, "fatal"]] as const) {
      const f = fakeFetch({ annotate: () => new Response(JSON.stringify({ error: { message: "secret detail" } }), { status }) });
      const c = createVisionClient(KEY, { fetch: f.fetchImpl, now: () => NOW, sleep: async () => {} });
      const r = await c.annotate(IMAGES, { onAttempt: async () => {} });
      expect(r.error?.kind).toBe(kind);
      expect(r.error?.message).not.toContain("secret detail");
      expect(f.calls.filter((x) => x.url === VISION_ANNOTATE_URL)).toHaveLength(1);
    }
  });

  it("onAttempt の例外（利用記録の書き込みの失敗）は再送せずそのまま外へ出す", async () => {
    const { fetchImpl, calls } = fakeFetch({ annotate: () => new Response("{}", { status: 500 }) });
    const client = createVisionClient(KEY, { fetch: fetchImpl, now: () => NOW, sleep: async () => {} });
    await expect(
      client.annotate(IMAGES, {
        onAttempt: async () => {
          throw new Error("db down");
        },
      }),
    ).rejects.toThrow("db down");
    expect(calls.filter((c) => c.url === VISION_ANNOTATE_URL)).toHaveLength(1);
  });
});

describe("createVisionClient（トークンの取得の失敗と応答の形の不正）", () => {
  it("トークンの 5xx、access_token のない JSON、JSON でない本文、通信の失敗は transient の VisionError（固定文言だけ）", async () => {
    const cases: { token: () => Response; status: number }[] = [
      { token: () => new Response("<html>503</html>", { status: 503 }), status: 503 },
      { token: () => new Response(JSON.stringify({ token_type: "Bearer", expires_in: 3599 }), { status: 200 }), status: 200 },
      { token: () => new Response("not json", { status: 200 }), status: 200 },
    ];
    for (const c of cases) {
      const { fetchImpl, calls } = fakeFetch({ token: c.token, annotate: () => new Response(OK_BODY) });
      const client = createVisionClient(KEY, { fetch: fetchImpl, now: () => NOW });
      const error = await client.ensureToken().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(VisionError);
      expect(error).toMatchObject({ kind: "transient", status: c.status, message: requestFailedError(c.status) });
      expect(calls.map((x) => x.url)).toEqual([GOOGLE_OAUTH_TOKEN_URI]);
    }
    const fetchDown: typeof fetch = async () => {
      throw new Error("ECONNRESET");
    };
    const down = createVisionClient(KEY, { fetch: fetchDown, now: () => NOW });
    await expect(down.ensureToken()).rejects.toMatchObject({ kind: "transient", status: undefined, message: requestFailedError(undefined) });
  });

  it("200 でも responses の長さが枚数と違えば transient で再送し、2 回の再送で止まる。units は枚数。トークンは結果に出ない", async () => {
    const { fetchImpl, calls } = fakeFetch({ annotate: () => new Response(JSON.stringify({ responses: [{}] }), { status: 200 }) });
    const client = createVisionClient(KEY, { fetch: fetchImpl, now: () => NOW, sleep: async () => {} });
    const attempts: AnnotateAttempt[] = [];
    const result = await client.annotate(IMAGES, { onAttempt: async (a) => void attempts.push(a) });
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ kind: "transient", status: 200, message: requestFailedError(200) });
    expect(attempts).toHaveLength(3);
    expect(calls.filter((c) => c.url === VISION_ANNOTATE_URL)).toHaveLength(3);
    expect(attempts.map((a) => unitsFor(a.httpStatus, a.imageCount))).toEqual([2, 2, 2]);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(result.error?.message).not.toContain(TOKEN);
  });
});
