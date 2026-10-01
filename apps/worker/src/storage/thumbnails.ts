/**
 * サムネイルの保存先（Supabase Storage の非公開バケット `thumbnails`。設計 3.6 章、10.2 章、13.1 章 P6）。
 *
 * Storage の REST API を `fetch` で呼ぶ（依存パッケージなし）。実機で通った形:
 * - 保存: `POST {SUPABASE_URL}/storage/v1/object/thumbnails/<path>`、ヘッダ `Authorization: Bearer <key>`、
 *   `apikey: <key>`、`x-upsert: true`、`Content-Type`
 * - 削除: `DELETE .../object/thumbnails/<path>`（テストの後始末用）
 *
 * サービスロールキーはヘッダにだけ載せ、戻り値、例外、ログには出さない。例外のメッセージはすべて固定文言
 * （`StorageError`、`ThumbnailError`、`lib/download.ts` の `DownloadError`）で、URL、パス、キーを含まない。
 * `saveThumbnail` の一時ディレクトリは `mkdtemp` で作り、`finally` で消す（設計 10.5 章）。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerConfig } from "../config.js";
import { TMP_DIR_PREFIX } from "../jobs/framework.js";
import { downloadToFile, type DownloadLimits } from "../lib/download.js";
import { resizeImage } from "../lib/ffmpeg.js";

/** サムネイルのバケット（マイグレーション `20261001100100`。非公開） */
export const THUMBNAIL_BUCKET = "thumbnails";

export interface StorageConfig {
  /** `SUPABASE_URL`。末尾の `/` はあってもよい */
  url: string;
  serviceRoleKey: string;
  bucket: typeof THUMBNAIL_BUCKET;
}

/** 縮小後の形式（`resizeImage` の出力は `.jpg`） */
export const THUMBNAIL_CONTENT_TYPE = "image/jpeg";

/** 元画像のダウンロードの上限。サムネイルの元（画像か動画の代表画像）は数 MB 以内なので、動画の 200MB より小さくする */
export const THUMBNAIL_SOURCE_MAX_BYTES = 20 * 1024 * 1024;

/** 元画像のダウンロードの制限時間（設計 3.7 章） */
export const THUMBNAIL_DOWNLOAD_TIMEOUT_MS = 60_000;

/** Storage の 1 回の呼び出しの制限時間 */
const STORAGE_TIMEOUT_MS = 30_000;

/** Storage の REST の失敗。`message` は固定文言（`Storage へのアップロードに失敗（HTTP 400）` など） */
export class StorageError extends Error {
  override readonly name = "StorageError";
}

/** 縮小と一時ファイルの失敗。`message` は固定文言（ffmpeg の stderr やパスを含めない） */
export class ThumbnailError extends Error {
  override readonly name = "ThumbnailError";
}

/** `WorkerConfig` から `StorageConfig` を作る */
export function storageConfigFrom(config: Pick<WorkerConfig, "supabaseUrl" | "supabaseServiceRoleKey">): StorageConfig {
  return { url: config.supabaseUrl, serviceRoleKey: config.supabaseServiceRoleKey, bucket: THUMBNAIL_BUCKET };
}

/** サムネイルの元画像の `DownloadLimits`。`allowedHosts` は `config.downloadAllowedHosts` */
export function thumbnailDownloadLimits(allowedHosts: string[]): DownloadLimits {
  return { maxBytes: THUMBNAIL_SOURCE_MAX_BYTES, timeoutMs: THUMBNAIL_DOWNLOAD_TIMEOUT_MS, allowedHosts };
}

/** バケット内のパス `{account_id}/{media_id}.jpg`。`account_id` は内部の uuid、`media_id` は Instagram のメディア ID */
export function storagePath(accountId: string, mediaId: string): string {
  return `${accountId}/${mediaId}.jpg`;
}

function objectUrl(cfg: StorageConfig, path: string): string {
  const base = cfg.url.replace(/\/+$/, "");
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${base}/storage/v1/object/${cfg.bucket}/${encoded}`;
}

/** Storage の REST を 1 回呼ぶ。接続の失敗（例外にホスト名が入りうる）と HTTP の失敗を固定文言にする */
async function callStorage(
  cfg: StorageConfig,
  method: "POST" | "DELETE",
  path: string,
  failure: string,
  fetchImpl: typeof fetch,
  upload?: { body: Uint8Array; contentType: string },
): Promise<void> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.serviceRoleKey}`,
    apikey: cfg.serviceRoleKey,
  };
  if (upload) {
    headers["x-upsert"] = "true";
    headers["Content-Type"] = upload.contentType;
  }
  let res: Response;
  try {
    res = await fetchImpl(objectUrl(cfg, path), {
      method,
      headers,
      body: upload?.body,
      signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
    });
  } catch {
    throw new StorageError("Storage への接続に失敗");
  }
  await res.body?.cancel().catch(() => undefined);
  if (!res.ok) throw new StorageError(`${failure}（HTTP ${res.status}）`);
}

/** `path` にオブジェクトを置く（`x-upsert: true` で上書き）。失敗は `StorageError`（固定文言） */
export async function uploadObject(
  cfg: StorageConfig,
  path: string,
  body: Uint8Array,
  contentType: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await callStorage(cfg, "POST", path, "Storage へのアップロードに失敗", fetchImpl, { body, contentType });
}

/** `path` のオブジェクトを消す（テストの後始末用）。失敗は `StorageError`（固定文言） */
export async function deleteObject(cfg: StorageConfig, path: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await callStorage(cfg, "DELETE", path, "Storage からの削除に失敗", fetchImpl);
}

export interface SaveThumbnailDeps {
  /** テスト用。ダウンロードと Storage の両方に使う。省略時はグローバルの `fetch` */
  fetchImpl?: typeof fetch;
  /** テスト用。省略時は `lib/ffmpeg.ts` の `resizeImage`（ホストに ffmpeg がないテストでは「入力をコピーする」偽物を渡す） */
  resize?: (input: string, output: string) => Promise<void>;
  /** テスト用。一時ディレクトリを作る親。省略時は `os.tmpdir()` */
  tmpRoot?: string;
}

/**
 * 元画像を `sourceUrl` からダウンロード → 縮小 → `path` に保存する。
 * 一時ディレクトリは `mkdtemp(join(tmpdir(), TMP_DIR_PREFIX + "thumb-"))` で作り、成功・失敗とも `finally` で消す。
 * 失敗は `DownloadError`（許可されていない URL、HTTP 404 など）、`ThumbnailError`（縮小、読み込み、一時ディレクトリ）、
 * `StorageError`（アップロード）のいずれかで、`message` は固定文言。呼び出し側は投稿の行を残して次回に再試行する
 */
export async function saveThumbnail(
  cfg: StorageConfig,
  sourceUrl: string,
  path: string,
  limits: DownloadLimits,
  deps: SaveThumbnailDeps = {},
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const resize = deps.resize ?? resizeImage;
  let dir: string;
  try {
    dir = await mkdtemp(join(deps.tmpRoot ?? tmpdir(), TMP_DIR_PREFIX + "thumb-"));
  } catch {
    throw new ThumbnailError("一時ディレクトリの作成に失敗");
  }
  try {
    // 入力は拡張子なし（ffmpeg は中身で形式を判定する）。出力は拡張子で JPEG になる
    const input = join(dir, "source");
    const output = join(dir, "thumbnail.jpg");
    await downloadToFile(sourceUrl, input, limits, fetchImpl);
    try {
      await resize(input, output);
    } catch {
      // `runOrThrow` の例外には stderr の末尾（パスを含みうる）が入るので固定文言に置き換える
      throw new ThumbnailError("サムネイルの縮小に失敗");
    }
    let body: Uint8Array;
    try {
      body = await readFile(output);
    } catch {
      throw new ThumbnailError("サムネイルの読み込みに失敗");
    }
    await uploadObject(cfg, path, body, THUMBNAIL_CONTENT_TYPE, fetchImpl);
  } finally {
    // 消せなくても元の例外を隠さない（起動時の掃除 `cleanOldTempDirs` が拾う）
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
