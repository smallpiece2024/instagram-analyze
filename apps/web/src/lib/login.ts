/**
 * ログインとログアウトの流れ（R2 設計 4.3 章）。Supabase の Auth クライアントを注入できる形にして、
 * Server Action（`src/app/login/actions.ts`）から呼ぶ。`server-only` は付けない（単体テストで使う）。
 *
 * - 失敗は理由を区別せず固定の結果 `failed` にし、固定の遅延（1 秒）を入れる（総当たりと利用者の存在の推測を遅らせる）
 * - 入力の値、Supabase のエラーの `message` をログに出さない
 * - ログアウトは `signOut({ scope: 'global' })`（すべてのセッションを無効にする）
 */

/** `signInWithPassword` と `signOut` を持つ最小のインターフェース（`SupabaseClient['auth']` が当てはまる） */
export interface AuthApi {
  signInWithPassword(credentials: { email: string; password: string }): Promise<{ error: unknown | null }>;
  signOut(options: { scope: "global" }): Promise<{ error: unknown | null }>;
}

export type SignInResult = "ok" | "failed";

/** 失敗時の固定の遅延 */
export const SIGN_IN_FAILURE_DELAY_MS = 1000;
const EMAIL_MAX_LENGTH = 254;
const PASSWORD_MAX_LENGTH = 256;

/** `/login?result=` の固定文言。値を反射しない */
export const SIGN_IN_RESULT_MESSAGES: Readonly<Record<SignInResult, string>> = {
  ok: "ログインしました。",
  failed: "ログインできませんでした（メールアドレスかパスワードが違います）。",
};

/** `?result=` を文言にする。未知の値は失敗の文言。パラメータなしは undefined */
export function signInResultMessage(result: string | undefined): string | undefined {
  if (result === undefined) return undefined;
  return result === "ok" ? SIGN_IN_RESULT_MESSAGES.ok : SIGN_IN_RESULT_MESSAGES.failed;
}

export interface SignInForm {
  email: string;
  password: string;
}

/** フォームの値を取り出す。文字列でない、空、長すぎるものは undefined */
export function readSignInForm(formData: FormData): SignInForm | undefined {
  const email = formData.get("email");
  const password = formData.get("password");
  if (typeof email !== "string" || typeof password !== "string") return undefined;
  const trimmedEmail = email.trim();
  if (trimmedEmail === "" || trimmedEmail.length > EMAIL_MAX_LENGTH) return undefined;
  if (password === "" || password.length > PASSWORD_MAX_LENGTH) return undefined;
  return { email: trimmedEmail, password };
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * パスワードでサインインする。形が不正でも Supabase が拒否しても例外でも `failed`（1 秒の遅延のあと）。
 * `sleep` はテスト用の注入
 */
export async function signInWithForm(
  auth: AuthApi,
  formData: FormData,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<SignInResult> {
  const form = readSignInForm(formData);
  let ok = false;
  if (form !== undefined) {
    try {
      const { error } = await auth.signInWithPassword(form);
      ok = error === null || error === undefined;
    } catch {
      ok = false;
    }
  }
  if (ok) return "ok";
  await sleep(SIGN_IN_FAILURE_DELAY_MS);
  return "failed";
}

/**
 * 失敗の応答が `startedAt` から少なくとも `SIGN_IN_FAILURE_DELAY_MS` 後になるよう待つ。
 * `signInWithForm` に届く前の失敗（設定不足、クライアント生成の例外）でも応答時間が変わらないようにする
 */
export async function ensureFailureDelay(startedAt: number, sleep: (ms: number) => Promise<void> = defaultSleep): Promise<void> {
  const remaining = SIGN_IN_FAILURE_DELAY_MS - (Date.now() - startedAt);
  if (remaining > 0) await sleep(remaining);
}

/** すべてのセッションからサインアウトする。失敗しても例外を投げない（Cookie の削除は `setAll` で済む） */
export async function signOutEverywhere(auth: AuthApi): Promise<void> {
  try {
    await auth.signOut({ scope: "global" });
  } catch {
    // 失敗しても `/login` へ送る。理由は出さない
  }
}
