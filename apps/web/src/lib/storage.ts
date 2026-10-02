/**
 * サムネイルの署名付き URL（設計 1.4 章。R2 設計 3.3 章）。
 *
 * バケット `thumbnails` は非公開。ログインした本人のセッション（`@supabase/ssr` のサーバークライアント、利用者の JWT）で
 * `storage.from('thumbnails').createSignedUrls(paths, ttl)` を呼び、1 ページ分（最大 50 件）を 1 回で署名する。
 * 読めるのは `storage.objects` の RLS ポリシー（`private.web_users` にある利用者）だけ。サービスロールキーは使わない。
 *
 * 応答は要素ごとに `{ error, path, signedURL }`（`signedURL` は `/object/sign/thumbnails/<path>?token=...` の相対パス。
 * `${SUPABASE_URL}/storage/v1` を前置する）。存在しないパス、読めないパスは `error` が入り `signedURL` は null。
 *
 * `createSignedUrls` を持つ最小のインターフェースを注入できる形にして単体テストする。
 * 失敗した要素は結果に入れない（画像なし）。例外は投げない。トークンを含む URL をログに出さない
 */
import "server-only";

export const THUMBNAIL_BUCKET = "thumbnails";
/** 署名の有効期間（秒） */
export const SIGNED_URL_TTL_SECONDS = 3600;
/** Storage の 1 回の呼び出しの制限時間 */
const STORAGE_TIMEOUT_MS = 10_000;
/** バケット内のパス `{accounts.id}/{media_id}.jpg`（ワーカーの `storagePath` と同じ形）。これ以外は署名しない */
const PATH_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/\d{1,40}\.jpg$/;

/** `createSignedUrls` の応答の 1 要素（supabase-js の `StorageFileApi` の形。`signedUrl` は絶対 URL） */
export interface SignedUrlItem {
  error: string | null;
  path: string | null;
  signedURL: string | null;
  signedUrl?: string | null;
}

export type SignedUrlsResponse = { data: SignedUrlItem[] | null; error: unknown | null };

/** `supabase.storage.from('thumbnails')` が当てはまる最小のインターフェース */
export interface ThumbnailSigner {
  createSignedUrls(paths: string[], expiresIn: number): Promise<SignedUrlsResponse>;
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

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * パスごとの署名付き URL。署名できなかったパスは含まれない。
 * `signer` は利用者のセッションで作った `supabase.storage.from(THUMBNAIL_BUCKET)`。`supabaseUrl` は絶対 URL の基点
 */
export async function signThumbnailUrls(
  signer: ThumbnailSigner,
  supabaseUrl: string,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const valid = [...new Set(paths.filter((p) => PATH_PATTERN.test(p)))];
  if (valid.length === 0) return result;
  const base = supabaseUrl.replace(/\/+$/, "");
  try {
    const res = await withTimeout(signer.createSignedUrls(valid, SIGNED_URL_TTL_SECONDS), STORAGE_TIMEOUT_MS);
    if (res.error || !Array.isArray(res.data)) return result;
    for (const item of res.data) {
      if (typeof item !== "object" || item === null) continue;
      const { error, path, signedURL, signedUrl } = item as Partial<SignedUrlItem>;
      if (error) continue;
      const raw = typeof signedURL === "string" ? signedURL : signedUrl;
      if (typeof path !== "string" || typeof raw !== "string") continue;
      if (!valid.includes(path)) continue;
      const absolute = toAbsoluteSignedUrl(base, raw);
      if (absolute === undefined) continue;
      result.set(path, absolute);
    }
  } catch {
    // 接続の失敗、タイムアウト、形の違う応答は「画像なし」。例外のメッセージ（URL を含みうる）は使わない
  }
  return result;
}
