/**
 * `/login`: メールアドレスとパスワードでのログイン（R2 設計 4.3 章。F-SYS-13）。Server Component のフォームと Server Action。
 *
 * - `?result=` は `signInResultMessage` で固定文言にする。値そのものは描画しない
 * - 認証の環境変数が足りなければ固定文言だけを出してフォームを出さない（変数名はサーバーのログにだけ出す。未認証の訪問者に設定の中身を見せない）
 * - ログイン済みならフォームの代わりにトップ（概要）への案内を出す
 * - 見た目は R3 のデザインシステムのクラス（R3 設計 3.6 節）。処理は変えない
 */
import Link from "next/link";
import { readAuthEnv } from "@/lib/auth-env";
import { currentClaims } from "@/lib/auth";
import { signInResultMessage } from "@/lib/login";
import { signInAction } from "./actions";
import { Callout } from "@/components/Callout";
import { Card } from "@/components/Card";
import { PageHead } from "@/components/PageHead";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const resultParam = params.result;
  const message = signInResultMessage(Array.isArray(resultParam) ? resultParam[0] : resultParam);
  const authEnv = readAuthEnv();
  if (!authEnv.ok) console.warn(`[auth] result=config_missing missing=${authEnv.missing.join(",")}`);
  const claims = authEnv.ok ? await currentClaims() : undefined;

  return (
    <main className="main stack max-w-md">
      <PageHead title="ログイン" sub="このツールは本人だけが使います。" />

      {message && (
        <div role="status">
          <Callout state="warn">{message}</Callout>
        </div>
      )}

      {!authEnv.ok ? (
        <Callout state="bad">設定が完了していません。管理者はサーバーのログを確認してください。</Callout>
      ) : claims ? (
        <Card>
          <p className="small">
            ログイン済みです。 <Link href="/">概要へ</Link>
          </p>
        </Card>
      ) : (
        <Card>
          <form action={signInAction} className="space-y-4">
            <div>
              <label htmlFor="email" className="small block">
                メールアドレス
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                required
                maxLength={254}
                className="input input--block mt-1"
              />
            </div>
            <div>
              <label htmlFor="password" className="small block">
                パスワード
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                maxLength={256}
                className="input input--block mt-1"
              />
            </div>
            <button type="submit" className="btn">
              ログイン
            </button>
          </form>
        </Card>
      )}
    </main>
  );
}
