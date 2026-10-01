/**
 * `/connect`: Meta との接続（F-COL-01。設計 1.1 章、2.6 章）。
 *
 * - 「Meta と接続する」は `<form method="post" action="/api/meta/login">`（Route Handler。JS 不要）
 * - `?result=` は `reasonMessage` で固定文言にする。値そのものは描画しない
 * - 現在の状態は `getConnectionStatus()`（`account_connection_status`）から。トークンは含まれない
 * - 環境変数が足りなければ状態は読まず、変数名を示してボタンを無効にする
 */
import { markDynamic } from "@/lib/dynamic";
import { configMissingReason, readEnv } from "@/lib/env";
import { accountStatusLabel, credentialStatusLabel, formatJst, missingScopes } from "@/lib/format";
import { OAUTH_SCOPES, reasonMessage } from "@/lib/meta-oauth";
import { getConnectionStatus, type ConnectionStatus } from "@/lib/queries/connection-status";

function StatusTable({ rows }: { rows: ConnectionStatus[] }) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-neutral-300 text-left">
            <th className="py-2 pr-3 font-semibold">ユーザー名</th>
            <th className="py-2 pr-3 font-semibold">アカウント</th>
            <th className="py-2 pr-3 font-semibold">認証情報</th>
            <th className="py-2 pr-3 font-semibold">データアクセス期限</th>
            <th className="py-2 pr-3 font-semibold">不足する権限</th>
            <th className="py-2 pr-3 font-semibold">最終確認</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const missing = missingScopes(row.scopes);
            return (
              <tr key={row.account_id} className="border-b border-neutral-200 align-top">
                <td className="py-2 pr-3">{row.username ?? "—"}</td>
                <td className="py-2 pr-3">{accountStatusLabel(row.account_status)}</td>
                <td className="py-2 pr-3">
                  {credentialStatusLabel(row.credential_status)}
                  {row.last_error ? <span className="block text-xs text-red-700">{row.last_error}</span> : null}
                </td>
                <td className="py-2 pr-3">{formatJst(row.data_access_expires_at)}</td>
                <td className="py-2 pr-3">
                  {row.credential_status === null ? "—" : missing.length === 0 ? "なし" : missing.join(", ")}
                </td>
                <td className="py-2 pr-3">{formatJst(row.last_checked_at)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default async function ConnectPage({ searchParams }: PageProps<"/connect">) {
  await markDynamic();
  const { result } = await searchParams;
  // 配列（同じキーが複数）は未知の値として汎用の文言にする
  const message = reasonMessage(Array.isArray(result) ? "" : result);
  const isOk = result === "ok";
  const envResult = readEnv();
  // 設定が足りないときは状態の読み出しも設定不足で失敗するので、読まずに「接続する」の節だけで案内する
  const status = envResult.ok ? await getConnectionStatus() : undefined;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10">
      <h1 className="text-2xl font-bold">Meta との接続</h1>
      <p className="mt-2 text-sm text-neutral-500">
        Facebook ログインで、Instagram プロアカウントに接続された Facebook ページのアクセストークンを取得し、DB（Vault）に保存します。
      </p>

      {status === undefined ? null : (
        <section className="mt-8">
          <h2 className="text-lg font-semibold">現在の状態</h2>
          {!status.ok ? (
            <p className="mt-3 rounded border border-red-300 bg-red-50 p-4 text-sm text-red-900">
              接続状態を読み出せませんでした（{status.reason}）。
            </p>
          ) : status.data.length === 0 ? (
            <p className="mt-3 text-sm text-neutral-600">アカウントはまだ登録されていません。下のボタンから接続してください。</p>
          ) : (
            <StatusTable rows={status.data} />
          )}
        </section>
      )}

      {message ? (
        <p
          role="status"
          className={
            isOk
              ? "mt-6 rounded border border-green-300 bg-green-50 p-4 text-sm text-green-900"
              : "mt-6 rounded border border-amber-400 bg-amber-50 p-4 text-sm text-amber-900"
          }
        >
          {message}
        </p>
      ) : null}

      <section className="mt-8">
        <h2 className="text-lg font-semibold">接続する</h2>
        {!envResult.ok ? (
          <p className="mt-3 rounded border border-amber-400 bg-amber-50 p-4 text-sm text-amber-900">
            {configMissingReason(envResult.missing)}。apps/web/.env.local に設定してから再読み込みしてください。
          </p>
        ) : null}
        <form method="post" action="/api/meta/login" className="mt-3">
          <button
            type="submit"
            disabled={!envResult.ok}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-neutral-400"
          >
            Meta と接続する
          </button>
        </form>
        <p className="mt-2 text-xs text-neutral-500">
          登録済みのアカウントがあるときは、同じボタンで再接続（トークンの差し替え）になります。
        </p>

        <h3 className="mt-6 text-base font-semibold">接続で起きること</h3>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-neutral-700">
          <li>Facebook の認可画面に移動し、このアプリに権限（{OAUTH_SCOPES.join("、")}）を許可します。</li>
          <li>
            Instagram プロアカウントに接続された Facebook ページを探します。複数見つかった場合は登録せず、対象のページだけを選んでやり直してもらいます。
          </li>
          <li>
            そのページのアクセストークン（期限なし。データアクセス期限は約 90 日）を確認し、DB の Vault に暗号化して保存します。ブラウザには残しません。
          </li>
          <li>収集ワーカーが次の実行からこのトークンを使います。</li>
        </ol>
      </section>
    </main>
  );
}
