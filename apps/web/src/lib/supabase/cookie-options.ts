/**
 * Supabase の認証 Cookie の属性（R2 設計 4.3 章）。純粋関数。
 *
 * ブラウザで supabase-js を使わない（サーバーだけが Cookie を読む）ので `httpOnly`。
 * Meta からクロスサイトのトップレベル GET で戻るときに Cookie が要るので `sameSite` は `lax`（`strict` にしない）。
 * `secure` は `APP_URL` が https のときだけ（ローカルは http）。寿命は 7 日
 */

export const AUTH_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export interface AuthCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: "/";
  maxAge: number;
}

export function isHttps(appUrl: string | undefined): boolean {
  return appUrl?.startsWith("https:") ?? false;
}

export function authCookieOptions(appUrl: string | undefined): AuthCookieOptions {
  return { httpOnly: true, secure: isHttps(appUrl), sameSite: "lax", path: "/", maxAge: AUTH_COOKIE_MAX_AGE_SECONDS };
}
