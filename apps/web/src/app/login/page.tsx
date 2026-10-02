/**
 * `/login`: メールアドレスとパスワードでのログイン（R2 設計 4.3 章。F-SYS-13）。Server Component のフォームと Server Action。
 *
 * - `?result=` は `signInResultMessage` で固定文言にする。値そのものは描画しない
 * - 認証の環境変数が足りなければ固定文言だけを出してフォームを出さない（変数名はサーバーのログにだけ出す。未認証の訪問者に設定の中身を見せない）
 * - ログイン済みならフォームの代わりにトップへの案内を出す
 */
import Link from "next/link";
import { readAuthEnv } from "@/lib/auth-env";
import { currentClaims } from "@/lib/auth";
import { signInResultMessage } from "@/lib/login";
import { signInAction } from "./actions";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const resultParam = params.result;
  const message = signInResultMessage(Array.isArray(resultParam) ? resultParam[0] : resultParam);
  const authEnv = readAuthEnv();
  if (!authEnv.ok) console.warn(`[auth] result=config_missing missing=${authEnv.missing.join(",")}`);
  const claims = authEnv.ok ? await currentClaims() : undefined;

  return (
    <main className="mx-auto w-full max-w-md flex-1 px-4 py-8">
      <h1 className="text-2xl font-bold">ログイン</h1>
      <p className="mt-1 text-sm text-neutral-500">このツールは本人だけが使います。</p>

      {message && (
        <p role="status" className="mt-4 rounded border border-amber-400 bg-amber-50 p-3 text-sm text-amber-900">
          {message}
        </p>
      )}

      {!authEnv.ok ? (
        <p className="mt-6 rounded border border-red-400 bg-red-50 p-4 text-sm text-red-900">
          設定が完了していません。管理者はサーバーのログを確認してください。
        </p>
      ) : claims ? (
        <p className="mt-6 rounded border border-neutral-200 p-4 text-sm">
          ログイン済みです。{" "}
          <Link href="/" className="font-semibold text-blue-700 underline-offset-2 hover:underline">
            接続状態へ
          </Link>
        </p>
      ) : (
        <form action={signInAction} className="mt-6 space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium">
              メールアドレス
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
              maxLength={254}
              className="mt-1 w-full rounded border border-neutral-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="password" className="block text-sm font-medium">
              パスワード
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={256}
              className="mt-1 w-full rounded border border-neutral-300 px-3 py-2 text-sm"
            />
          </div>
          <button type="submit" className="rounded bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800">
            ログイン
          </button>
        </form>
      )}
    </main>
  );
}
