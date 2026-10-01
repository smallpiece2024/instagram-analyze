/**
 * サムネイルの署名付き URL（設計 1.4 章）。
 *
 * バケット `thumbnails` は非公開。`POST {SUPABASE_URL}/storage/v1/object/sign/thumbnails` に
 * `{ expiresIn, paths }` を送り、1 ページ分（最大 50 件）を 1 回で署名する。
 * 応答は要素ごとに `{ error, path, signedURL }` で、`signedURL` は `/object/sign/thumbnails/<path>?token=...` の相対パス
 * （実機で確認済み。`${SUPABASE_URL}/storage/v1` を前置する）。存在しないパスは `error` が入り `signedURL` は null。
 *
 * サービスロールキーはヘッダにだけ載せ、戻り値、例外、ログに出さない。失敗した要素は結果に入れない（画像なし）。例外は投げない
 */
import "server-only";

export const THUMBNAIL_BUCKET = "thumbnails";
/** 署名の有効期間（秒） */
export const SIGNED_URL_TTL_SECONDS = 3600;
/** Storage の 1 回の呼び出しの制限時間 */
const STORAGE_TIMEOUT_MS = 10_000;
/** バケット内のパス `{accounts.id}/{media_id}.jpg`（ワーカーの `storagePath` と同じ形）。これ以外は署名しない */
const PATH_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/\d{1,40}\.jpg$/;

export interface StorageEnv {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
}

/**
 * 応答の `signedURL` を絶対 URL にする。相対パス（`/object/sign/...`）には `${base}/storage/v1` を前置する。
 * 絶対 URL は `${base}/` で始まるものだけ受け付け、それ以外（外部のホスト）は undefined（画像なし）
 */
export function toAbsoluteSignedUrl(base: string, signedURL: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(signedURL) || signedURL.startsWith("//")) {
    return signedURL.startsWith(`${base}/`) ? signedURL : undefined;
  }
  const rel = signedURL.startsWith("/") ? signedURL : `/${signedURL}`;
  return rel.startsWith("/storage/v1/") ? `${base}${rel}` : `${base}/storage/v1${rel}`;
}

/**
 * パスごとの署名付き URL。署名できなかったパスは含まれない。
 * `fetchImpl` はテスト用の注入
 */
export async function signThumbnailUrls(
  env: StorageEnv,
  paths: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const valid = [...new Set(paths.filter((p) => PATH_PATTERN.test(p)))];
  if (valid.length === 0) return result;
  const base = env.supabaseUrl.replace(/\/+$/, "");
  try {
    const res = await fetchImpl(`${base}/storage/v1/object/sign/${THUMBNAIL_BUCKET}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
        apikey: env.supabaseServiceRoleKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SECONDS, paths: valid }),
      cache: "no-store",
      signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
    });
    if (!res.ok) return result;
    const body: unknown = await res.json();
    if (!Array.isArray(body)) return result;
    for (const item of body) {
      if (typeof item !== "object" || item === null) continue;
      const { error, path, signedURL } = item as { error?: unknown; path?: unknown; signedURL?: unknown };
      if (error) continue;
      if (typeof path !== "string" || typeof signedURL !== "string") continue;
      if (!valid.includes(path)) continue;
      const absolute = toAbsoluteSignedUrl(base, signedURL);
      if (absolute === undefined) continue;
      result.set(path, absolute);
    }
  } catch {
    // 接続の失敗や JSON でない応答は「画像なし」。例外のメッセージ（URL を含みうる）は使わない
  }
  return result;
}
