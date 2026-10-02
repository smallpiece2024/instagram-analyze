/**
 * `src/proxy.ts` 用の Supabase クライアント（R2 設計 4.3 章）。`server-only` は付けない（Proxy からは使えない）。
 *
 * - リクエストの Cookie で client を作る
 * - `setAll` はリクエストとレスポンス（`NextResponse.next({ request })`）の両方に Cookie を書き、レスポンスを作り直す。
 *   `response()` はその最後のレスポンスを返す。proxy はこれを返す（別のレスポンスを返すと更新済みの Cookie が落ちて
 *   次の要求でログアウトする）
 * - `setAll` の第 2 引数（`Cache-Control` など。認証 Cookie を持つ応答を CDN に置かせない）もレスポンスに付ける
 */
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import type { AuthEnv } from "@/lib/auth-env";
import { authCookieOptions } from "@/lib/supabase/cookie-options";

export interface ProxySupabase {
  supabase: SupabaseClient;
  /** `setAll` が最後に作ったレスポンス（Cookie が書かれていなければ最初の `NextResponse.next`） */
  response: () => NextResponse;
}

export function createProxySupabaseClient(request: NextRequest, env: AuthEnv): ProxySupabase {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(env.supabaseUrl, env.publishableKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet, headers) => {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
      },
    },
    cookieOptions: authCookieOptions(env.appUrl),
  });
  return { supabase, response: () => response };
}
