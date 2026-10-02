/**
 * アクセスの判定（R2 設計 4.3 章）。純粋関数。I/O はしない。`src/proxy.ts`、Route Handler、Server Action が使う。
 *
 * - `/login` と静的資産（`/_next/static`、`/favicon.ico`）は `pass`
 * - それ以外で claims がなければ `login`（`getClaims()` の失敗も claims なしとして扱う）
 * - `allowedUserId` が未設定・空なら `forbid`（フェイルクローズ）
 * - `claims.sub` が `allowedUserId` と違えば `forbid`。一致すれば `pass`
 */

export type AccessDecision = "pass" | "login" | "forbid";

/** JWT のクレームのうち判定に使うもの（`sub` = Supabase Auth の利用者 `id`） */
export interface AccessClaims {
  sub?: string | undefined;
}

export const LOGIN_PATH = "/login";

/** 認証なしで通す経路。`/login` 配下（Server Action の POST も同じ経路に届く）と静的資産（`next/image` は使っていないので含めない） */
const PUBLIC_PATHS: readonly string[] = [LOGIN_PATH, "/favicon.ico"];
const PUBLIC_PREFIXES: readonly string[] = ["/_next/static/"];

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) return true;
  if (pathname.startsWith(`${LOGIN_PATH}/`)) return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function decideAccess(
  pathname: string,
  claims: AccessClaims | undefined,
  allowedUserId: string | undefined,
): AccessDecision {
  if (isPublicPath(pathname)) return "pass";
  if (claims === undefined) return "login";
  const allowed = allowedUserId?.trim();
  if (allowed === undefined || allowed === "") return "forbid";
  if (typeof claims.sub !== "string" || claims.sub === "" || claims.sub !== allowed) return "forbid";
  return "pass";
}
