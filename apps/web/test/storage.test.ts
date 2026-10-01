import { describe, expect, it } from "vitest";
import { SIGNED_URL_TTL_SECONDS, signThumbnailUrls, toAbsoluteSignedUrl } from "@/lib/storage";

const BASE = "http://127.0.0.1:54321";
const KEY = "service-role-secret-value";
const ENV = { supabaseUrl: BASE, supabaseServiceRoleKey: KEY };
const ACCOUNT = "00000000-0000-4000-8000-000000000000";
const PATH_A = `${ACCOUNT}/1.jpg`;
const PATH_B = `${ACCOUNT}/2.jpg`;

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** 応答を 1 つ返す偽の fetch。呼び出しを記録する */
function fakeFetch(calls: Call[], status: number, body: unknown, options: { throws?: boolean; raw?: string } = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (options.throws) throw new Error(`connect ECONNREFUSED ${BASE}`);
    const text = options.raw ?? JSON.stringify(body);
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function signed(path: string): string {
  return `/object/sign/thumbnails/${path}?token=signed-token`;
}

describe("toAbsoluteSignedUrl", () => {
  it("相対パス 3 形を base に付ける", () => {
    expect(toAbsoluteSignedUrl(BASE, "/object/sign/thumbnails/a/1.jpg?token=t")).toBe(
      `${BASE}/storage/v1/object/sign/thumbnails/a/1.jpg?token=t`,
    );
    expect(toAbsoluteSignedUrl(BASE, "object/sign/thumbnails/a/1.jpg?token=t")).toBe(
      `${BASE}/storage/v1/object/sign/thumbnails/a/1.jpg?token=t`,
    );
    expect(toAbsoluteSignedUrl(BASE, "/storage/v1/object/sign/thumbnails/a/1.jpg?token=t")).toBe(
      `${BASE}/storage/v1/object/sign/thumbnails/a/1.jpg?token=t`,
    );
  });

  it("絶対 URL は base で始まるものだけ。外部のホストやスキーム違いは捨てる", () => {
    expect(toAbsoluteSignedUrl(BASE, `${BASE}/storage/v1/object/sign/thumbnails/a/1.jpg?token=t`)).toBe(
      `${BASE}/storage/v1/object/sign/thumbnails/a/1.jpg?token=t`,
    );
    expect(toAbsoluteSignedUrl(BASE, "https://evil.example/object/sign/thumbnails/a/1.jpg")).toBeUndefined();
    expect(toAbsoluteSignedUrl(BASE, "http://127.0.0.1:54321.evil.example/x")).toBeUndefined();
    expect(toAbsoluteSignedUrl(BASE, "//evil.example/x")).toBeUndefined();
    expect(toAbsoluteSignedUrl(BASE, "javascript:alert(1)")).toBeUndefined();
    expect(toAbsoluteSignedUrl(BASE, "http://127.0.0.1:543210/x")).toBeUndefined();
  });
});

describe("signThumbnailUrls", () => {
  it("形式外のパスは送らず、重複は除き、ヘッダと本文が設計どおり。戻り値にキーを含まない", async () => {
    const calls: Call[] = [];
    const fetchImpl = fakeFetch(calls, 200, [
      { error: null, path: PATH_A, signedURL: signed(PATH_A) },
      { error: null, path: PATH_B, signedURL: signed(PATH_B) },
    ]);
    const result = await signThumbnailUrls(
      ENV,
      [PATH_A, "../etc/passwd", "not-a-uuid/1.jpg", `${ACCOUNT}/abc.jpg`, PATH_A, PATH_B, `${ACCOUNT}/1.png`],
      fetchImpl,
    );
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe(`${BASE}/storage/v1/object/sign/thumbnails`);
    expect(call?.init?.method).toBe("POST");
    const headers = call?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers.apikey).toBe(KEY);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(call?.init?.body))).toEqual({ expiresIn: SIGNED_URL_TTL_SECONDS, paths: [PATH_A, PATH_B] });
    expect(call?.init?.cache).toBe("no-store");
    expect(result.get(PATH_A)).toBe(`${BASE}/storage/v1${signed(PATH_A)}`);
    expect(result.get(PATH_B)).toBe(`${BASE}/storage/v1${signed(PATH_B)}`);
    expect(result.size).toBe(2);
    for (const value of result.values()) expect(value).not.toContain(KEY);
  });

  it("有効なパスがなければ fetch を呼ばず空", async () => {
    const calls: Call[] = [];
    const result = await signThumbnailUrls(ENV, ["bad", ""], fakeFetch(calls, 200, []));
    expect(calls).toHaveLength(0);
    expect(result.size).toBe(0);
  });

  it("error 付きの要素、未知の path、外部の絶対 URL、形の違う要素は無視する", async () => {
    const calls: Call[] = [];
    const fetchImpl = fakeFetch(calls, 200, [
      { error: "Either the object does not exist or you do not have access to it", path: PATH_A, signedURL: null },
      { error: null, path: `${ACCOUNT}/999.jpg`, signedURL: signed(`${ACCOUNT}/999.jpg`) },
      { error: null, path: PATH_B, signedURL: "https://evil.example/object/sign/thumbnails/x?token=t" },
      { error: null, path: 42, signedURL: signed(PATH_B) },
      null,
      "text",
    ]);
    const result = await signThumbnailUrls(ENV, [PATH_A, PATH_B], fetchImpl);
    expect(result.size).toBe(0);
  });

  it("非 2xx、配列でない本文、JSON でない本文、例外は空（投げない）", async () => {
    const paths = [PATH_A];
    expect((await signThumbnailUrls(ENV, paths, fakeFetch([], 401, { message: "unauthorized" }))).size).toBe(0);
    expect((await signThumbnailUrls(ENV, paths, fakeFetch([], 200, { signedURL: signed(PATH_A) }))).size).toBe(0);
    expect((await signThumbnailUrls(ENV, paths, fakeFetch([], 200, null, { raw: "<html>" }))).size).toBe(0);
    expect((await signThumbnailUrls(ENV, paths, fakeFetch([], 200, [], { throws: true }))).size).toBe(0);
  });

  it("SUPABASE_URL の末尾のスラッシュは落として連結する", async () => {
    const calls: Call[] = [];
    const fetchImpl = fakeFetch(calls, 200, [{ error: null, path: PATH_A, signedURL: signed(PATH_A) }]);
    const result = await signThumbnailUrls({ ...ENV, supabaseUrl: `${BASE}/` }, [PATH_A], fetchImpl);
    expect(calls[0]?.url).toBe(`${BASE}/storage/v1/object/sign/thumbnails`);
    expect(result.get(PATH_A)).toBe(`${BASE}/storage/v1${signed(PATH_A)}`);
  });
});
