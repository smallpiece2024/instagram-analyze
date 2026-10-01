/**
 * 要求の出どころの純粋な判定（設計 3 章）。`proxy.ts` と `/api/meta/login` が使う。I/O はしない。
 *
 * - `isAllowedHost`: `Host` が `APP_URL` のホストか、ローカルの既定（`127.0.0.1:3000`、`[::1]:3000`、`localhost:3000`）
 *   以外なら拒否する（DNS リバインディング対策）
 * - `isSameOriginPost`: `Sec-Fetch-Site` が `same-origin`／`none` 以外、または `Origin` が `APP_URL` のオリジンと
 *   違えば拒否する（Route Handler には Next.js の Origin 検査がないため）。`Origin` がない要求も拒否する
 *   （フォーム送信ではブラウザが付ける。ただし文書の `Referrer-Policy` が `no-referrer` だと同一オリジンでも
 *   `Origin: null` になるので、`next.config.ts` は `same-origin` にしている）
 */

/** `-H 127.0.0.1` で待ち受ける開発サーバーに届く、既定で許すホスト */
const LOCAL_HOSTS: readonly string[] = ["127.0.0.1:3000", "[::1]:3000", "localhost:3000"];

/** `APP_URL` のオリジン（`http://localhost:3000` の形）。読めなければ undefined */
export function appOrigin(appUrl: string | undefined): string | undefined {
  if (!appUrl) return undefined;
  try {
    return new URL(appUrl).origin;
  } catch {
    return undefined;
  }
}

/** `APP_URL` のホスト（ポート付き）。読めなければ undefined */
function appHost(appUrl: string | undefined): string | undefined {
  if (!appUrl) return undefined;
  try {
    return new URL(appUrl).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/** `Host` ヘッダが許可リストにあるか。`appUrl` が不正でもローカルの既定は許す */
export function isAllowedHost(host: string | null | undefined, appUrl: string | undefined): boolean {
  if (!host) return false;
  const normalized = host.trim().toLowerCase();
  if (normalized.length === 0) return false;
  if (LOCAL_HOSTS.includes(normalized)) return true;
  const expected = appHost(appUrl);
  return expected !== undefined && normalized === expected;
}

export interface OriginHeaders {
  secFetchSite: string | null | undefined;
  origin: string | null | undefined;
}

/**
 * 同じオリジンからのフォーム送信か。
 * - `Sec-Fetch-Site` があれば `same-origin` か `none` だけを許す
 * - `Origin` は必須で、`APP_URL` のオリジンと完全一致
 */
export function isSameOriginPost(headers: OriginHeaders, appUrl: string): boolean {
  const site = headers.secFetchSite?.trim().toLowerCase();
  if (site !== undefined && site !== "" && site !== "same-origin" && site !== "none") return false;
  const expected = appOrigin(appUrl);
  if (!expected) return false;
  const origin = headers.origin?.trim().toLowerCase();
  return origin !== undefined && origin === expected.toLowerCase();
}
