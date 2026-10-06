/**
 * 外部（Instagram の CDN）からのダウンロード（設計 3.7 章）。
 * 動画とサムネイルの元画像の取得を 1 つの関数にまとめ、スキーム、ホスト、リダイレクト、時間、大きさの制限を掛ける。
 *
 * `DownloadError.message` は固定文言のみで、URL を含めない（署名付き URL を記録しないため）。
 */

import { open, rm, type FileHandle } from "node:fs/promises";

export interface DownloadLimits {
  /** 受信バイト数の上限。超えたら中断してファイルを消す */
  maxBytes: number;
  /** 接続から本文の読み終わりまでの制限時間（ミリ秒） */
  timeoutMs: number;
  /** 許可するホスト（後方一致。`cdninstagram.com` は `scontent-xxx.cdninstagram.com` に一致する） */
  allowedHosts: string[];
  /**
   * 応答の `content-type` がこれで始まらなければ本文を読まずに `DownloadError`（R4 設計 3.5 節。動画は `video/`）。
   * 大文字と小文字は区別しない。省略時は検査しない（サムネイル）
   */
  contentTypePrefix?: string;
}

/** `content-type` が `contentTypePrefix` で始まらなかったときの `DownloadError` の文言（値は入れない） */
export const CONTENT_TYPE_ERROR = "content-type が想定外";

/** ダウンロードの失敗。`message` は固定文言で、URL を含まない */
export class DownloadError extends Error {
  override readonly name = "DownloadError";
}

/**
 * ダウンロードしてよい URL か。`https:` のみ。ホストは許可リストの要素と等しいか `.<要素>` で終わる
 * （`cdninstagram.com.evil.example` は拒む）。認証情報（`user:pass@`）や既定以外のポートを含む URL と、
 * URL として読めない文字列は false。許可リストの要素は `*.` や `.` で始まっていてもよい。
 */
export function isAllowedDownloadUrl(url: string, allowedHosts: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.port !== "") return false;
  const host = parsed.hostname.toLowerCase();
  if (!host) return false;
  return allowedHosts.some((allowed) => {
    const suffix = allowed.toLowerCase().replace(/^\*?\./, "");
    return suffix !== "" && (host === suffix || host.endsWith(`.${suffix}`));
  });
}

function toDownloadError(error: unknown): DownloadError {
  if (error instanceof DownloadError) return error;
  const name = typeof error === "object" && error !== null && "name" in error ? error.name : undefined;
  if (name === "TimeoutError" || name === "AbortError") return new DownloadError("タイムアウト");
  return new DownloadError("ネットワークエラー");
}

async function discardBody(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

/**
 * URL の本文をストリームで `destPath` に書く。
 * - リダイレクトは追わない（`redirect: 'error'`）
 * - `limits.timeoutMs` で中断する（`AbortSignal.timeout`）
 * - 受信バイト数が `limits.maxBytes` を超えたら中断して `destPath` を消す
 * 失敗はすべて `DownloadError`（`許可されていない URL`、`サイズ上限を超過`、`タイムアウト`、`HTTP <status>`、
 * `本文がない`、`ネットワークエラー`、`ファイルの書き込みに失敗`、`content-type が想定外`）。
 * - `limits.contentTypePrefix` があれば、`content-type` がそれで始まらない応答を本文を読まずに拒む
 */
export async function downloadToFile(
  url: string,
  destPath: string,
  limits: DownloadLimits,
  fetchImpl: typeof fetch = fetch,
): Promise<{ bytes: number; contentType: string | undefined }> {
  if (!isAllowedDownloadUrl(url, limits.allowedHosts)) {
    throw new DownloadError("許可されていない URL");
  }

  let res: Response;
  try {
    res = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(limits.timeoutMs) });
  } catch (error) {
    throw toDownloadError(error);
  }
  if (!res.ok) {
    await discardBody(res);
    throw new DownloadError(`HTTP ${res.status}`);
  }
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limits.maxBytes) {
    await discardBody(res);
    throw new DownloadError("サイズ上限を超過");
  }
  const contentType = res.headers.get("content-type") ?? undefined;
  if (
    limits.contentTypePrefix !== undefined &&
    !(contentType ?? "").trim().toLowerCase().startsWith(limits.contentTypePrefix.toLowerCase())
  ) {
    await discardBody(res);
    throw new DownloadError(CONTENT_TYPE_ERROR);
  }
  if (!res.body) {
    // 204 などの本文なし。動画や画像のダウンロードでは起きないはずなので失敗にする（空のファイルを作らない）
    throw new DownloadError("本文がない");
  }

  const reader = res.body.getReader();
  let handle: FileHandle;
  try {
    handle = await open(destPath, "w");
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new DownloadError("ファイルの書き込みに失敗");
  }
  let bytes = 0;
  let failed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limits.maxBytes) throw new DownloadError("サイズ上限を超過");
      await writeAll(handle, value);
    }
  } catch (error) {
    failed = true;
    await reader.cancel().catch(() => undefined);
    throw toDownloadError(error);
  } finally {
    await handle.close().catch(() => undefined);
    if (failed) await rm(destPath, { force: true }).catch(() => undefined);
  }
  return { bytes, contentType };
}

/** `write` は要求より少なく書くことがあるので、全部書けるまで繰り返す */
async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  try {
    while (offset < chunk.byteLength) {
      const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
      if (bytesWritten <= 0) throw new Error("書き込みが進まない");
      offset += bytesWritten;
    }
  } catch {
    throw new DownloadError("ファイルの書き込みに失敗");
  }
}
