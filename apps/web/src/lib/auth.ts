/**
 * 要求の中でのログイン状態の確認（R2 設計 4.3 章）。Server Component、Server Action、Route Handler が使う
 * （proxy の matcher の漏れに備えて、Route Handler の中でも再確認する）。
 *
 * - `currentClaims()`: `getClaims()` で署名を検証した JWT のクレーム。失敗（期限切れ、Supabase に届かない、設定不足）は
 *   undefined（claims なし）。`getSession()` はサーバーで信用しない
 * - `checkAccess(pathname)`: `decideAccess` の結果
 * - ログを出さない。例外のメッセージを使わない
 */
import "server-only";
import { decideAccess, type AccessClaims, type AccessDecision } from "@/lib/access";
import { readAuthEnv } from "@/lib/auth-env";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function currentClaims(): Promise<AccessClaims | undefined> {
  const authEnv = readAuthEnv();
  if (!authEnv.ok) return undefined;
  try {
    const supabase = await createSupabaseServerClient(authEnv.env);
    const { data, error } = await supabase.auth.getClaims();
    if (error || !data) return undefined;
    return { sub: data.claims.sub };
  } catch {
    return undefined;
  }
}

export async function checkAccess(pathname: string): Promise<AccessDecision> {
  const authEnv = readAuthEnv();
  const claims = await currentClaims();
  return decideAccess(pathname, claims, authEnv.ok ? authEnv.env.allowedUserId : undefined);
}
