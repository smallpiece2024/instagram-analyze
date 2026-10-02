"use server";
/**
 * ログインとログアウトの Server Action（R2 設計 4.3 章）。
 *
 * - `signInAction`: `signInWithPassword`。成功で `/` へ、失敗は `/login?result=failed`（固定文言。1 秒の固定遅延は
 *   `signInWithForm` の中）。設定不足は `/login?result=failed`（画面側が変数名を出す）
 * - `signOutAction`: `signOut({ scope: 'global' })` → `/login`
 * - Server Action は Next.js が `Origin` を検査する。例外は固定文言だけをログに出す
 */
import { redirect } from "next/navigation";
import { LOGIN_PATH } from "@/lib/access";
import { readAuthEnv } from "@/lib/auth-env";
import { ensureFailureDelay, signInWithForm, signOutEverywhere } from "@/lib/login";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function signInAction(formData: FormData): Promise<void> {
  const startedAt = Date.now();
  let result: "ok" | "failed" = "failed";
  try {
    const authEnv = readAuthEnv();
    if (authEnv.ok) {
      const supabase = await createSupabaseServerClient(authEnv.env);
      result = await signInWithForm(supabase.auth, formData);
    }
  } catch {
    console.error("[auth] result=sign_in_error 例外");
    result = "failed";
  }
  // 設定不足や例外で早く失敗した経路でも、応答時間から状態を推測されないよう同じだけ待つ
  if (result !== "ok") await ensureFailureDelay(startedAt);
  redirect(result === "ok" ? "/" : `${LOGIN_PATH}?result=failed`);
}

export async function signOutAction(): Promise<void> {
  try {
    const authEnv = readAuthEnv();
    if (authEnv.ok) {
      const supabase = await createSupabaseServerClient(authEnv.env);
      await signOutEverywhere(supabase.auth);
    }
  } catch {
    console.error("[auth] result=sign_out_error 例外");
  }
  redirect(LOGIN_PATH);
}
