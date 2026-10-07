import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTENT_TYPE_ERROR, DownloadError, downloadToFile, isAllowedDownloadUrl, type DownloadLimits } from "../src/lib/download.js";

const HOSTS = ["cdninstagram.com", "fbcdn.net"];
const LIMITS: DownloadLimits = { maxBytes: 1024, timeoutMs: 1000, allowedHosts: HOSTS };
const URL_OK = "https://scontent-nrt1-1.cdninstagram.com/v/t50/video.mp4?oe=68F0A1B2&oh=abc";

const encoder = new TextEncoder();

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "worker-test-download-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function expectDownloadError(promise: Promise<unknown>, message: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DownloadError);
  expect((caught as DownloadError).message).toBe(message);
  expect((caught as DownloadError).message).not.toContain("://");
}

describe("isAllowedDownloadUrl", () => {
  it("https で許可リストのホストに後方一致すれば true", () => {
    expect(isAllowedDownloadUrl("https://scontent-nrt1-1.cdninstagram.com/v/x.mp4", HOSTS)).toBe(true);
    expect(isAllowedDownloadUrl("https://scontent-nrt1-1.xx.fbcdn.net/v/x.jpg", HOSTS)).toBe(true);
    expect(isAllowedDownloadUrl("https://cdninstagram.com/x", HOSTS)).toBe(true);
    expect(isAllowedDownloadUrl("https://SCONTENT.CDNINSTAGRAM.COM/x", HOSTS)).toBe(true);
  });

  it("許可リストの要素が *. や . で始まっていてもよい", () => {
    expect(isAllowedDownloadUrl("https://scontent.cdninstagram.com/x", ["*.cdninstagram.com"])).toBe(true);
    expect(isAllowedDownloadUrl("https://scontent.cdninstagram.com/x", [".cdninstagram.com"])).toBe(true);
  });

  it("認証情報や既定以外のポートを含む URL は false。既定のポート（443）は true", () => {
    expect(isAllowedDownloadUrl("https://user:pw@scontent.cdninstagram.com/x", HOSTS)).toBe(false);
    expect(isAllowedDownloadUrl("https://user@scontent.cdninstagram.com/x", HOSTS)).toBe(false);
    expect(isAllowedDownloadUrl("https://scontent.cdninstagram.com:8443/x", HOSTS)).toBe(false);
    expect(isAllowedDownloadUrl("https://scontent.cdninstagram.com:443/x", HOSTS)).toBe(true);
  });

  it("http、別ホスト、cdninstagram.com.evil.example、読めない URL、空の許可リストは false", () => {
    expect(isAllowedDownloadUrl("http://scontent.cdninstagram.com/x", HOSTS)).toBe(false);
    expect(isAllowedDownloadUrl("https://example.com/x", HOSTS)).toBe(false);
    expect(isAllowedDownloadUrl("https://cdninstagram.com.evil.example/x", HOSTS)).toBe(false);
    expect(isAllowedDownloadUrl("https://evilcdninstagram.com/x", HOSTS)).toBe(false);
    expect(isAllowedDownloadUrl("not a url", HOSTS)).toBe(false);
    expect(isAllowedDownloadUrl("https://scontent.cdninstagram.com/x", [])).toBe(false);
    expect(isAllowedDownloadUrl("https://scontent.cdninstagram.com/x", [""])).toBe(false);
    expect(isAllowedDownloadUrl("ftp://scontent.cdninstagram.com/x", HOSTS)).toBe(false);
  });
});

describe("downloadToFile", () => {
  it("本文をストリームで書き、バイト数と Content-Type を返す。リダイレクトは追わず、タイムアウトを付ける", async () => {
    await withTempDir(async (dir) => {
      const inits: (RequestInit | undefined)[] = [];
      const fetchImpl: typeof fetch = async (_input, init) => {
        inits.push(init);
        return new Response(streamOf([encoder.encode("hello "), encoder.encode("world")]), {
          status: 200,
          headers: { "content-type": "video/mp4" },
        });
      };
      const dest = join(dir, "video.mp4");
      const result = await downloadToFile(URL_OK, dest, LIMITS, fetchImpl);
      expect(result).toEqual({ bytes: 11, contentType: "video/mp4" });
      expect(await readFile(dest, "utf8")).toBe("hello world");
      expect(inits[0]?.redirect).toBe("error");
      expect(inits[0]?.signal).toBeInstanceOf(AbortSignal);
    });
  });

  it("Content-Type がなければ undefined", async () => {
    await withTempDir(async (dir) => {
      const fetchImpl: typeof fetch = async () => new Response(streamOf([encoder.encode("x")]), { status: 200 });
      const result = await downloadToFile(URL_OK, join(dir, "a.bin"), LIMITS, fetchImpl);
      expect(result).toEqual({ bytes: 1, contentType: undefined });
    });
  });

  it("受信バイト数が上限を超えたら中断し、ファイルを残さない", async () => {
    await withTempDir(async (dir) => {
      const chunk = new Uint8Array(400);
      const fetchImpl: typeof fetch = async () =>
        new Response(streamOf([chunk, chunk, chunk, chunk]), { status: 200 });
      const dest = join(dir, "big.mp4");
      await expectDownloadError(downloadToFile(URL_OK, dest, LIMITS, fetchImpl), "サイズ上限を超過");
      expect(await exists(dest)).toBe(false);
    });
  });

  it("上限ちょうどは成功する", async () => {
    await withTempDir(async (dir) => {
      const fetchImpl: typeof fetch = async () => new Response(streamOf([new Uint8Array(1024)]), { status: 200 });
      const result = await downloadToFile(URL_OK, join(dir, "exact.bin"), LIMITS, fetchImpl);
      expect(result.bytes).toBe(1024);
    });
  });

  it("Content-Length が上限ちょうどなら成功し、数値でなければ無視する", async () => {
    await withTempDir(async (dir) => {
      const exact: typeof fetch = async () =>
        new Response(streamOf([new Uint8Array(1024)]), { status: 200, headers: { "content-length": "1024" } });
      expect((await downloadToFile(URL_OK, join(dir, "exact.bin"), LIMITS, exact)).bytes).toBe(1024);

      const invalid: typeof fetch = async () =>
        new Response(streamOf([new Uint8Array(3)]), { status: 200, headers: { "content-length": "abc" } });
      expect((await downloadToFile(URL_OK, join(dir, "invalid.bin"), LIMITS, invalid)).bytes).toBe(3);
    });
  });

  it("本文がなければ DownloadError('本文がない')。空のファイルを作らない", async () => {
    await withTempDir(async (dir) => {
      const fetchImpl: typeof fetch = async () => new Response(null, { status: 200 });
      const dest = join(dir, "empty.bin");
      await expectDownloadError(downloadToFile(URL_OK, dest, LIMITS, fetchImpl), "本文がない");
      expect(await exists(dest)).toBe(false);
    });
  });

  it("保存先のディレクトリがなければ DownloadError('ファイルの書き込みに失敗')", async () => {
    await withTempDir(async (dir) => {
      const fetchImpl: typeof fetch = async () => new Response(streamOf([encoder.encode("x")]), { status: 200 });
      const dest = join(dir, "missing-dir", "x.bin");
      await expectDownloadError(downloadToFile(URL_OK, dest, LIMITS, fetchImpl), "ファイルの書き込みに失敗");
      expect(await exists(dest)).toBe(false);
    });
  });

  it("本文の読み取り中に制限時間を過ぎたら DownloadError('タイムアウト') でファイルを残さない", async () => {
    await withTempDir(async (dir) => {
      const fetchImpl: typeof fetch = async (_input, init) => {
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("partial"));
            signal?.addEventListener("abort", () => controller.error(signal.reason));
          },
        });
        return new Response(body, { status: 200 });
      };
      const dest = join(dir, "stalled.mp4");
      await expectDownloadError(
        downloadToFile(URL_OK, dest, { ...LIMITS, timeoutMs: 20 }, fetchImpl),
        "タイムアウト",
      );
      expect(await exists(dest)).toBe(false);
    });
  });

  it("Content-Length が上限を超えていれば本文を読まずに中断する", async () => {
    await withTempDir(async (dir) => {
      const fetchImpl: typeof fetch = async () =>
        new Response(streamOf([new Uint8Array(1)]), { status: 200, headers: { "content-length": "999999" } });
      const dest = join(dir, "declared.bin");
      await expectDownloadError(downloadToFile(URL_OK, dest, LIMITS, fetchImpl), "サイズ上限を超過");
      expect(await exists(dest)).toBe(false);
    });
  });

  it("HTTP 404 は DownloadError('HTTP 404')。ファイルを作らない", async () => {
    await withTempDir(async (dir) => {
      const fetchImpl: typeof fetch = async () => new Response("not found", { status: 404 });
      const dest = join(dir, "missing.jpg");
      await expectDownloadError(downloadToFile(URL_OK, dest, LIMITS, fetchImpl), "HTTP 404");
      expect(await exists(dest)).toBe(false);
    });
  });

  it("許可されていないホストと http は fetch を呼ばずに拒む", async () => {
    await withTempDir(async (dir) => {
      let calls = 0;
      const fetchImpl: typeof fetch = async () => {
        calls += 1;
        return new Response("x");
      };
      const dest = join(dir, "x.bin");
      await expectDownloadError(
        downloadToFile("https://example.com/x.mp4", dest, LIMITS, fetchImpl),
        "許可されていない URL",
      );
      await expectDownloadError(
        downloadToFile("http://scontent.cdninstagram.com/x.mp4", dest, LIMITS, fetchImpl),
        "許可されていない URL",
      );
      expect(calls).toBe(0);
      expect(await exists(dest)).toBe(false);
    });
  });

  it("制限時間を過ぎたら DownloadError('タイムアウト')", async () => {
    await withTempDir(async (dir) => {
      const fetchImpl: typeof fetch = (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("signal がない"));
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason as unknown));
        });
      const dest = join(dir, "slow.mp4");
      await expectDownloadError(
        downloadToFile(URL_OK, dest, { ...LIMITS, timeoutMs: 20 }, fetchImpl),
        "タイムアウト",
      );
      expect(await exists(dest)).toBe(false);
    });
  });

  it("本文の途中で中断されたらファイルを消して DownloadError にする", async () => {
    await withTempDir(async (dir) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("partial"));
          controller.error(new TypeError("terminated"));
        },
      });
      const fetchImpl: typeof fetch = async () => new Response(body, { status: 200 });
      const dest = join(dir, "partial.mp4");
      await expectDownloadError(downloadToFile(URL_OK, dest, LIMITS, fetchImpl), "ネットワークエラー");
      expect(await exists(dest)).toBe(false);
    });
  });

  it("fetch の例外（リダイレクトを含む）は DownloadError('ネットワークエラー') にし、URL を含めない", async () => {
    await withTempDir(async (dir) => {
      const fetchImpl: typeof fetch = async () => {
        throw new TypeError(`unexpected redirect from ${URL_OK}`);
      };
      const dest = join(dir, "redirect.mp4");
      await expectDownloadError(downloadToFile(URL_OK, dest, LIMITS, fetchImpl), "ネットワークエラー");
      expect(await exists(dest)).toBe(false);
    });
  });
});

describe("downloadToFile の content-type の検査（R4 設計 3.5 節）", () => {
  const VIDEO_LIMITS: DownloadLimits = { ...LIMITS, contentTypePrefix: "video/" };

  it("video/ で始まらなければ本文を読まずに DownloadError（固定文言）で、ファイルを作らない", async () => {
    await withTempDir(async (dir) => {
      const dest = join(dir, "video.mp4");
      for (const type of ["text/html", "application/vnd.apple.mpegurl", undefined]) {
        const fetchImpl: typeof fetch = async () =>
          new Response(streamOf([encoder.encode("#EXTM3U")]), { status: 200, headers: type ? { "content-type": type } : {} });
        const error = await downloadToFile(URL_OK, dest, VIDEO_LIMITS, fetchImpl).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DownloadError);
        expect((error as Error).message).toBe(CONTENT_TYPE_ERROR);
        await expect(stat(dest)).rejects.toThrow();
      }
    });
  });

  it("Video/MP4 のような大文字でも通り、contentTypePrefix がなければ検査しない（サムネイル）", async () => {
    await withTempDir(async (dir) => {
      const fetchImpl: typeof fetch = async () =>
        new Response(streamOf([encoder.encode("abc")]), { status: 200, headers: { "content-type": "Video/MP4" } });
      expect((await downloadToFile(URL_OK, join(dir, "a.mp4"), VIDEO_LIMITS, fetchImpl)).bytes).toBe(3);
      const html: typeof fetch = async () =>
        new Response(streamOf([encoder.encode("abc")]), { status: 200, headers: { "content-type": "image/jpeg" } });
      expect((await downloadToFile(URL_OK, join(dir, "b.jpg"), LIMITS, html)).bytes).toBe(3);
    });
  });
});
