/**
 * Server Component／Server Action／Route Handler 用の Supabase クライアント（R2 設計 4.3 章）。
 * `next/headers` の `cookies()` で Cookie を読み書きする。
 *
 * - Server Component からは Cookie を書けない（`cookies().set` が例外になる）ので `setAll` の例外は捨てる。
 *   セッションの更新は `src/proxy.ts` が済ませている
 * - 要求ごとに新しく作る（使い回さない）
 */
import "server-only";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { AuthEnv } from "@/lib/auth-env";
import { authCookieOptions } from "@/lib/supabase/cookie-options";

export async function createSupabaseServerClient(env: AuthEnv): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  return createServerClient(env.supabaseUrl, env.publishableKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // Server Component から呼ばれたとき。proxy がセッションを更新するので無視してよい
        }
      },
    },
    cookieOptions: authCookieOptions(env.appUrl),
  });
}
