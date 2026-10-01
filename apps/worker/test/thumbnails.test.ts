/**
 * `storage/thumbnails.ts` の単体テスト。偽の `fetch`（ダウンロードと Storage）と偽の `resize` で、
 * Storage REST の呼び方、固定文言、一時ディレクトリの後始末を確かめる。ffmpeg と本物の Storage には触らない
 * （本物の Storage は `test/db/thumbnails.test.ts`）
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TMP_DIR_PREFIX } from "../src/jobs/framework.js";
import { DownloadError, type DownloadLimits } from "../src/lib/download.js";
import {
  deleteObject,
  saveThumbnail,
  StorageError,
  storagePath,
  THUMBNAIL_CONTENT_TYPE,
  ThumbnailError,
  uploadObject,
  type StorageConfig,
} from "../src/storage/thumbnails.js";

const KEY = "FAKE_SERVICE_ROLE_KEY_abcdefghijklmnop";
const CFG: StorageConfig = { url: "http://127.0.0.1:54321", serviceRoleKey: KEY, bucket: "thumbnails" };
const ACCOUNT_ID = "11111111-2222-4333-8444-555555555555";
const PATH = storagePath(ACCOUNT_ID, "000000000000001");
const SOURCE_URL = "https://scontent-nrt1-1.cdninstagram.com/v/t51/a.jpg?_nc_ht=x&oe=68F0A1B2&oh=abc";
const LIMITS: DownloadLimits = { maxBytes: 1024, timeoutMs: 1000, allowedHosts: ["cdninstagram.com"] };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Call {
  url: URL;
  method: string;
  headers: Headers;
  body: string | undefined;
}

function toUrl(input: string | URL | Request): URL {
  return input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
}

function bodyText(body: RequestInit["body"]): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return decoder.decode(body);
  throw new Error("テストが想定しない body の型");
}

/** 呼び出しを記録し、ホストで応答を分ける偽の fetch */
function fakeFetch(handlers: { download?: () => Response; storage?: (call: Call) => Response }, calls: Call[]): typeof fetch {
  return async (input, init) => {
    const url = toUrl(input);
    const call: Call = { url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: bodyText(init?.body) };
    calls.push(call);
    if (url.hostname.endsWith(".cdninstagram.com")) {
      return handlers.download?.() ?? new Response("no download handler", { status: 500 });
    }
    if (url.hostname === "127.0.0.1") {
      return handlers.storage?.(call) ?? new Response("no storage handler", { status: 500 });
    }
    return new Response("unexpected host", { status: 500 });
  };
}

function ok(body = JSON.stringify({ Key: "thumbnails/x" })): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

function image(text = "SOURCE-IMAGE"): Response {
  return new Response(encoder.encode(text), { status: 200, headers: { "content-type": "image/jpeg" } });
}

async function expectRejects<T extends Error>(
  promise: Promise<unknown>,
  type: new (...args: never[]) => T,
  message: string | RegExp,
): Promise<T> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(type);
  const error = caught as T;
  if (typeof message === "string") expect(error.message).toBe(message);
  else expect(error.message).toMatch(message);
  expect(error.message).not.toContain("://");
  expect(error.message).not.toContain(KEY);
  expect(error.message).not.toContain(ACCOUNT_ID);
  return error;
}

describe("uploadObject", () => {
  it("POST {url}/storage/v1/object/thumbnails/{path} に Authorization、apikey、x-upsert、Content-Type と本文を送る", async () => {
    const calls: Call[] = [];
    const fetchImpl = fakeFetch({ storage: () => ok() }, calls);
    await uploadObject(CFG, PATH, encoder.encode("JPEG-BYTES"), THUMBNAIL_CONTENT_TYPE, fetchImpl);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url.href).toBe(`http://127.0.0.1:54321/storage/v1/object/thumbnails/${ACCOUNT_ID}/000000000000001.jpg`);
    expect(call?.method).toBe("POST");
    expect(call?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(call?.headers.get("apikey")).toBe(KEY);
    expect(call?.headers.get("x-upsert")).toBe("true");
    expect(call?.headers.get("content-type")).toBe("image/jpeg");
    expect(call?.body).toBe("JPEG-BYTES");
  });

  it("URL の末尾の / は重ねない。パスの各部分は URL エンコードする", async () => {
    const calls: Call[] = [];
    const fetchImpl = fakeFetch({ storage: () => ok() }, calls);
    await uploadObject({ ...CFG, url: "http://127.0.0.1:54321/" }, "a b/c#d.jpg", encoder.encode("x"), "image/jpeg", fetchImpl);
    expect(calls[0]?.url.href).toBe("http://127.0.0.1:54321/storage/v1/object/thumbnails/a%20b/c%23d.jpg");
  });

  it("HTTP の失敗は固定文言の StorageError（URL、キー、パスを含まない）", async () => {
    const fetchImpl = fakeFetch({ storage: () => new Response(JSON.stringify({ error: "x" }), { status: 400 }) }, []);
    await expectRejects(
      uploadObject(CFG, PATH, encoder.encode("x"), "image/jpeg", fetchImpl),
      StorageError,
      "Storage へのアップロードに失敗（HTTP 400）",
    );
  });

  it("fetch の例外（接続失敗。メッセージにホストが入りうる）は固定文言", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:54321");
    };
    await expectRejects(uploadObject(CFG, PATH, encoder.encode("x"), "image/jpeg", fetchImpl), StorageError, "Storage への接続に失敗");
  });
});

describe("deleteObject", () => {
  it("DELETE を認証ヘッダだけで送る", async () => {
    const calls: Call[] = [];
    const fetchImpl = fakeFetch({ storage: () => ok(JSON.stringify({ message: "Successfully deleted" })) }, calls);
    await deleteObject(CFG, PATH, fetchImpl);
    const call = calls[0];
    expect(call?.method).toBe("DELETE");
    expect(call?.url.href).toBe(`http://127.0.0.1:54321/storage/v1/object/thumbnails/${PATH}`);
    expect(call?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(call?.headers.get("apikey")).toBe(KEY);
    expect(call?.headers.get("x-upsert")).toBeNull();
    expect(call?.body).toBeUndefined();
  });

  it("失敗は固定文言", async () => {
    const fetchImpl = fakeFetch({ storage: () => new Response("", { status: 404 }) }, []);
    await expectRejects(deleteObject(CFG, PATH, fetchImpl), StorageError, "Storage からの削除に失敗（HTTP 404）");
  });
});

describe("saveThumbnail", () => {
  let tmpRoot = "";
  const resizeCalls: { input: string; output: string }[] = [];

  /** 偽の縮小: 入力の内容に印を付けて出力に書く */
  const resize = async (input: string, output: string): Promise<void> => {
    resizeCalls.push({ input, output });
    const source = await readFile(input, "utf8");
    await writeFile(output, `RESIZED:${source}`);
  };

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "worker-test-thumb-root-"));
    resizeCalls.length = 0;
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function leftovers(): Promise<string[]> {
    return readdir(tmpRoot);
  }

  it("ダウンロード → 縮小 → アップロードの順に進み、縮小後の本文を image/jpeg で送り、一時ディレクトリを消す", async () => {
    const calls: Call[] = [];
    const fetchImpl = fakeFetch({ download: () => image("SOURCE-IMAGE"), storage: () => ok() }, calls);
    await saveThumbnail(CFG, SOURCE_URL, PATH, LIMITS, { fetchImpl, resize, tmpRoot });

    expect(calls.map((c) => `${c.method} ${c.url.hostname}`)).toEqual(["GET scontent-nrt1-1.cdninstagram.com", "POST 127.0.0.1"]);
    expect(calls[0]?.url.href).toBe(SOURCE_URL);
    const upload = calls[1];
    expect(upload?.url.pathname).toBe(`/storage/v1/object/thumbnails/${PATH}`);
    expect(upload?.headers.get("content-type")).toBe(THUMBNAIL_CONTENT_TYPE);
    expect(upload?.headers.get("x-upsert")).toBe("true");
    expect(upload?.body).toBe("RESIZED:SOURCE-IMAGE");

    expect(resizeCalls).toHaveLength(1);
    const call = resizeCalls[0];
    expect(basename(dirname(call?.input ?? ""))).toMatch(new RegExp(`^${TMP_DIR_PREFIX}thumb-`));
    expect(dirname(call?.input ?? "")).toBe(dirname(call?.output ?? ""));
    expect(call?.output.endsWith(".jpg")).toBe(true);
    expect(await leftovers()).toEqual([]);
  });

  it("ダウンロードの失敗（HTTP 404）は DownloadError のまま。縮小もアップロードもせず、一時ディレクトリを消す", async () => {
    const calls: Call[] = [];
    const fetchImpl = fakeFetch({ download: () => new Response("not found", { status: 404 }) }, calls);
    await expectRejects(saveThumbnail(CFG, SOURCE_URL, PATH, LIMITS, { fetchImpl, resize, tmpRoot }), DownloadError, "HTTP 404");
    expect(calls).toHaveLength(1);
    expect(resizeCalls).toHaveLength(0);
    expect(await leftovers()).toEqual([]);
  });

  it("許可されていない URL は fetch を呼ばずに DownloadError。一時ディレクトリを消す", async () => {
    const calls: Call[] = [];
    const fetchImpl = fakeFetch({}, calls);
    await expectRejects(
      saveThumbnail(CFG, "https://example.com/a.jpg", PATH, LIMITS, { fetchImpl, resize, tmpRoot }),
      DownloadError,
      "許可されていない URL",
    );
    expect(calls).toHaveLength(0);
    expect(await leftovers()).toEqual([]);
  });

  it("縮小の失敗は固定文言の ThumbnailError（ffmpeg の stderr やパスを含めない）。アップロードせず、一時ディレクトリを消す", async () => {
    const calls: Call[] = [];
    const fetchImpl = fakeFetch({ download: () => image(), storage: () => ok() }, calls);
    let seenInput = "";
    const failing = async (input: string): Promise<void> => {
      seenInput = input;
      throw new Error(`ffmpeg が終了コード 1 で失敗しました:\n${input}: Invalid data found when processing input`);
    };
    const error = await expectRejects(
      saveThumbnail(CFG, SOURCE_URL, PATH, LIMITS, { fetchImpl, resize: failing, tmpRoot }),
      ThumbnailError,
      "サムネイルの縮小に失敗",
    );
    expect(error.message).not.toContain(seenInput);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    expect(await leftovers()).toEqual([]);
  });

  it("縮小が出力を作らなければ固定文言の ThumbnailError", async () => {
    const fetchImpl = fakeFetch({ download: () => image(), storage: () => ok() }, []);
    await expectRejects(
      saveThumbnail(CFG, SOURCE_URL, PATH, LIMITS, { fetchImpl, resize: async () => {}, tmpRoot }),
      ThumbnailError,
      "サムネイルの読み込みに失敗",
    );
    expect(await leftovers()).toEqual([]);
  });

  it("アップロードの失敗は StorageError。一時ディレクトリを消す", async () => {
    const fetchImpl = fakeFetch({ download: () => image(), storage: () => new Response("", { status: 500 }) }, []);
    await expectRejects(
      saveThumbnail(CFG, SOURCE_URL, PATH, LIMITS, { fetchImpl, resize, tmpRoot }),
      StorageError,
      "Storage へのアップロードに失敗（HTTP 500）",
    );
    expect(resizeCalls).toHaveLength(1);
    expect(await leftovers()).toEqual([]);
  });

  it("サイズ上限を超えた元画像は DownloadError（サイズ上限を超過）", async () => {
    const fetchImpl = fakeFetch({ download: () => image("x".repeat(2048)), storage: () => ok() }, []);
    await expectRejects(
      saveThumbnail(CFG, SOURCE_URL, PATH, LIMITS, { fetchImpl, resize, tmpRoot }),
      DownloadError,
      "サイズ上限を超過",
    );
    expect(resizeCalls).toHaveLength(0);
    expect(await leftovers()).toEqual([]);
  });
});
