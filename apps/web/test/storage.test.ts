/**
 * `src/lib/storage.ts` の単体テスト（R2 設計 10.1 章）。`createSignedUrls` を持つ最小のインターフェースを注入する。
 */
import { describe, expect, it, vi } from "vitest";
import { SIGNED_URL_TTL_SECONDS, signThumbnailUrls, toAbsoluteSignedUrl, type SignedUrlsResponse, type ThumbnailSigner } from "@/lib/storage";

const BASE = "http://127.0.0.1:54321";
const ACCOUNT = "00000000-0000-4000-8000-000000000000";
const PATH_A = `${ACCOUNT}/1.jpg`;
const PATH_B = `${ACCOUNT}/2.jpg`;

function signed(path: string): string {
  return `/object/sign/thumbnails/${path}?token=signed-token`;
}

/** 応答を 1 つ返す偽の signer。呼び出しを記録する */
function fakeSigner(response: SignedUrlsResponse | (() => Promise<SignedUrlsResponse>)) {
  const createSignedUrls = vi.fn<ThumbnailSigner["createSignedUrls"]>(async () =>
    typeof response === "function" ? response() : response,
  );
  const signer: ThumbnailSigner = { createSignedUrls };
  return { signer, createSignedUrls };
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
  it("形式外のパスは送らず、重複は除き、TTL は 1 時間。相対の signedURL を絶対にする", async () => {
    const { signer, createSignedUrls } = fakeSigner({
      data: [
        { error: null, path: PATH_A, signedURL: signed(PATH_A) },
        { error: null, path: PATH_B, signedURL: signed(PATH_B) },
      ],
      error: null,
    });
    const result = await signThumbnailUrls(signer, BASE, [
      PATH_A,
      "../etc/passwd",
      "not-a-uuid/1.jpg",
      `${ACCOUNT}/abc.jpg`,
      PATH_A,
      PATH_B,
      `${ACCOUNT}/1.png`,
    ]);
    expect(createSignedUrls).toHaveBeenCalledTimes(1);
    expect(createSignedUrls).toHaveBeenCalledWith([PATH_A, PATH_B], SIGNED_URL_TTL_SECONDS);
    expect(SIGNED_URL_TTL_SECONDS).toBe(3600);
    expect(result.get(PATH_A)).toBe(`${BASE}/storage/v1${signed(PATH_A)}`);
    expect(result.get(PATH_B)).toBe(`${BASE}/storage/v1${signed(PATH_B)}`);
    expect(result.size).toBe(2);
  });

  it("有効なパスがなければ signer を呼ばず空", async () => {
    const { signer, createSignedUrls } = fakeSigner({ data: [], error: null });
    const result = await signThumbnailUrls(signer, BASE, ["bad", ""]);
    expect(createSignedUrls).not.toHaveBeenCalled();
    expect(result.size).toBe(0);
  });

  it("error 付きの要素、未知の path、外部の絶対 URL、形の違う要素は無視する", async () => {
    const { signer } = fakeSigner({
      data: [
        { error: "Either the object does not exist or you do not have access to it", path: PATH_A, signedURL: null },
        { error: null, path: `${ACCOUNT}/999.jpg`, signedURL: signed(`${ACCOUNT}/999.jpg`) },
        { error: null, path: PATH_B, signedURL: "https://evil.example/object/sign/thumbnails/x?token=t" },
        { error: null, path: null, signedURL: signed(PATH_B) },
      ],
      error: null,
    });
    const result = await signThumbnailUrls(signer, BASE, [PATH_A, PATH_B]);
    expect(result.size).toBe(0);
  });

  it("signedURL がなく signedUrl（絶対）だけでも base で始まれば受け付ける", async () => {
    const { signer } = fakeSigner({
      data: [{ error: null, path: PATH_A, signedURL: null, signedUrl: `${BASE}/storage/v1${signed(PATH_A)}` }],
      error: null,
    });
    const result = await signThumbnailUrls(signer, BASE, [PATH_A]);
    expect(result.get(PATH_A)).toBe(`${BASE}/storage/v1${signed(PATH_A)}`);
  });

  it("error 応答、data が配列でない、例外は空（投げない）", async () => {
    const paths = [PATH_A];
    expect((await signThumbnailUrls(fakeSigner({ data: null, error: { message: "unauthorized" } }).signer, BASE, paths)).size).toBe(0);
    expect(
      (await signThumbnailUrls(fakeSigner({ data: { signedURL: signed(PATH_A) } as unknown as never, error: null }).signer, BASE, paths))
        .size,
    ).toBe(0);
    const throwing = fakeSigner(async () => {
      throw new Error(`connect ECONNREFUSED ${BASE}`);
    });
    expect((await signThumbnailUrls(throwing.signer, BASE, paths)).size).toBe(0);
  });

  it("supabaseUrl の末尾のスラッシュは落として連結する", async () => {
    const { signer } = fakeSigner({ data: [{ error: null, path: PATH_A, signedURL: signed(PATH_A) }], error: null });
    const result = await signThumbnailUrls(signer, `${BASE}/`, [PATH_A]);
    expect(result.get(PATH_A)).toBe(`${BASE}/storage/v1${signed(PATH_A)}`);
  });
});
