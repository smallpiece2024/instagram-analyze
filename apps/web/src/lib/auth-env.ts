/**
 * ログインと署名付き URL に使う環境変数（R2 設計 4.2 章の段 1）。純粋関数。`server-only` は付けない
 * （`src/proxy.ts` が使う。`readEnv` と同じく `process.env` を読む例外として設計 1.2 章に数える）。
 *
 * - `NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`: ブラウザに出てよい値。Auth と Storage の API
 * - `APP_URL`: 認証 Cookie の `secure` の判定（https のときだけ）
 * - `WEB_ALLOWED_USER_ID`: ログインを許す利用者の `id`。未設定なら `allowedUserId` は undefined
 *   （`decideAccess` が `forbid` にする。フェイルクローズ）
 * - 段 2（`DATABASE_URL` など）が未設定でもログインは動くよう、`readEnv` とは別に読む
 * - 欠落は変数名だけを `missing` に入れる。値は外に出さない
 */

export interface AuthEnv {
  /** 末尾のスラッシュなし */
  supabaseUrl: string;
  publishableKey: string;
  /** オリジンだけ */
  appUrl: string;
  allowedUserId: string | undefined;
}

export type AuthEnvResult = { ok: true; env: AuthEnv } | { ok: false; missing: string[] };

type Source = Record<string, string | undefined>;

function nonEmpty(source: Source, name: string): string | undefined {
  const value = source[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** http(s) の URL として読めるときだけ返す。例外は外に出さない */
function parseHttpUrl(value: string | undefined): URL | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

export function readAuthEnv(source: Source = process.env): AuthEnvResult {
  const missing: string[] = [];

  const supabaseUrlRaw = nonEmpty(source, "NEXT_PUBLIC_SUPABASE_URL");
  if (parseHttpUrl(supabaseUrlRaw) === undefined) missing.push("NEXT_PUBLIC_SUPABASE_URL");

  const publishableKey = nonEmpty(source, "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  if (publishableKey === undefined) missing.push("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");

  const appUrlRaw = nonEmpty(source, "APP_URL");
  const appUrl = parseHttpUrl(appUrlRaw);
  if (appUrl === undefined || appUrl.origin !== appUrlRaw) missing.push("APP_URL");

  const allowedUserId = nonEmpty(source, "WEB_ALLOWED_USER_ID");

  if (missing.length > 0 || supabaseUrlRaw === undefined || publishableKey === undefined || appUrlRaw === undefined) {
    return { ok: false, missing };
  }
  return {
    ok: true,
    env: { supabaseUrl: supabaseUrlRaw.replace(/\/+$/, ""), publishableKey, appUrl: appUrlRaw, allowedUserId },
  };
}
