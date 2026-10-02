/**
 * すべての要求に先立つ検査（R1 設計 3 章、R2 設計 4.3 章）。
 *
 * 1. `Host` の検査（DNS リバインディング対策）。`APP_URL` のホストとローカルの既定以外は 403
 * 2. Supabase のセッションを更新し、`getClaims()` で JWT を検証する（失敗は claims なし）
 * 3. `decideAccess`。`login` なら `/login` へ 303、`forbid` なら 403。通過は `setAll` が最後に作ったレスポンス
 *    （別のレスポンスを返すと更新済みの Cookie が落ちる。リダイレクトと 403 には Cookie を写す）
 *
 * `readEnv()` は `server-only` で Proxy からは使えないため、`process.env` を直接読む（設計 1.2 章の例外。`readAuthEnv` も同じ）。
 * `/api/meta/callback` も保護対象（Meta からの戻りはクロスサイトのトップレベル GET で、`SameSite=Lax` の Cookie が付く）。
 */
import { NextResponse, type NextRequest } from "next/server";
import { decideAccess, LOGIN_PATH, type AccessClaims } from "@/lib/access";
import { readAuthEnv } from "@/lib/auth-env";
import { isAllowedHost } from "@/lib/request-guard";
import { createProxySupabaseClient } from "@/lib/supabase/proxy";

/** `from` に書かれた Cookie とキャッシュ系のヘッダを `to` に写す */
function carryCookies(from: NextResponse, to: NextResponse): NextResponse {
  for (const cookie of from.cookies.getAll()) to.cookies.set(cookie);
  for (const name of ["cache-control", "expires", "pragma"]) {
    const value = from.headers.get(name);
    if (value !== null) to.headers.set(name, value);
  }
  return to;
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  if (!isAllowedHost(request.headers.get("host"), process.env.APP_URL)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const authEnv = readAuthEnv(process.env);
  let claims: AccessClaims | undefined;
  let response = NextResponse.next({ request });
  if (authEnv.ok) {
    const { supabase, response: latest } = createProxySupabaseClient(request, authEnv.env);
    try {
      const { data, error } = await supabase.auth.getClaims();
      if (!error && data) claims = { sub: data.claims.sub };
    } catch {
      claims = undefined;
    }
    response = latest();
  }

  const decision = decideAccess(request.nextUrl.pathname, claims, authEnv.ok ? authEnv.env.allowedUserId : undefined);
  if (decision === "login") {
    // Proxy のリダイレクトは絶対 URL が要る（相対の Location は `Invalid URL` で 500 になる。2026-10-02 の実機）。
    // 基点は `APP_URL`（コールバックと同じ基準）。認証の設定が足りないときだけ要求の URL（Host 検査は通っている）
    const base = authEnv.ok ? authEnv.env.appUrl : request.nextUrl;
    return carryCookies(response, NextResponse.redirect(new URL(LOGIN_PATH, base), 303));
  }
  if (decision === "forbid") {
    // 許可外の利用者には更新済みの Cookie を写さない（セッションを延命しない）
    return new NextResponse("Forbidden", { status: 403 });
  }
  return response;
}

/** 静的資産以外のすべての要求に適用する（ルートを足したときに漏れないよう、列挙しない。`next/image` は使っていない） */
export const config = {
  matcher: ["/((?!_next/static|favicon\\.ico).*)"],
};
