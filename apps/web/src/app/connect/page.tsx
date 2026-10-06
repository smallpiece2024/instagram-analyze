/**
 * `/connect`: Meta との接続（F-COL-01。R1 設計 1.1 章、2.6 章）。R3 では処理を変えず、見た目だけデザインシステムに合わせた（R3 設計 3.6 節）。
 *
 * - 「Meta と接続する」は `<form method="post" action="/api/meta/login">`（Route Handler。JS 不要）
 * - `?result=` は `reasonMessage` で固定文言にする。値そのものは描画しない
 * - 現在の状態は対象のアカウント（`getTargetAccount`。R3 設計 4.1 節）の `getConnectionStatus(accountId)` から。トークンは含まれない。
 *   対象のアカウントがまだなければ（接続前）未登録として案内する
 * - 環境変数が足りなければ状態は読まず、変数名を示してボタンを無効にする
 */
import { Callout } from "@/components/Callout";
import { Card } from "@/components/Card";
import { PageHead } from "@/components/PageHead";
import type { QueryResult } from "@/lib/db-errors";
import { markDynamic } from "@/lib/dynamic";
import { configMissingReason, readEnv } from "@/lib/env";
import { accountStatusLabel, credentialStatusLabel, EMPTY, formatJst, missingScopes } from "@/lib/format";
import { OAUTH_SCOPES, reasonMessage } from "@/lib/meta-oauth";
import { getTargetAccount, TARGET_ACCOUNT_NOT_SET } from "@/lib/queries/account";
import { getConnectionStatus, type ConnectionStatus } from "@/lib/queries/connection-status";

function StatusList({ row }: { row: ConnectionStatus }) {
  const missing = missingScopes(row.scopes);
  return (
    <dl className="dl">
      <dt>ユーザー名</dt>
      <dd>{row.username ? `@${row.username}` : EMPTY}</dd>
      <dt>アカウント</dt>
      <dd>{accountStatusLabel(row.account_status)}</dd>
      <dt>認証情報</dt>
      <dd>
        <span className="status" data-state={row.credential_status === "valid" ? "ok" : "bad"}>
          {credentialStatusLabel(row.credential_status)}
        </span>
        {row.last_error ? <span className="xs"> {row.last_error}</span> : null}
      </dd>
      <dt>データアクセス期限</dt>
      <dd>{formatJst(row.data_access_expires_at)}</dd>
      <dt>不足する権限</dt>
      <dd>{row.credential_status === null ? EMPTY : missing.length === 0 ? "なし" : missing.join(", ")}</dd>
      <dt>最終確認</dt>
      <dd>{formatJst(row.last_checked_at)}</dd>
    </dl>
  );
}

/** 対象のアカウントの接続状態。対象のアカウントがまだなければ（接続前）null */
async function readStatus(): Promise<QueryResult<ConnectionStatus | null>> {
  const account = await getTargetAccount();
  if (!account.ok) return account.reason === TARGET_ACCOUNT_NOT_SET ? { ok: true, data: null } : account;
  return getConnectionStatus(account.data.id);
}

export default async function ConnectPage({ searchParams }: PageProps<"/connect">) {
  await markDynamic();
  const { result } = await searchParams;
  // 配列（同じキーが複数）は未知の値として汎用の文言にする
  const message = reasonMessage(Array.isArray(result) ? "" : result);
  const isOk = result === "ok";
  const envResult = readEnv();
  // 設定が足りないときは状態の読み出しも設定不足で失敗するので、読まずに「接続する」の節だけで案内する
  const status = envResult.ok ? await readStatus() : undefined;

  return (
    <main className="main stack">
      <PageHead
        title="Meta との接続"
        sub="Facebook ログインで、Instagram プロアカウントに接続された Facebook ページのアクセストークンを取得し、DB（Vault）に保存します。"
      />

      {message ? (
        <div role="status">
          <Callout state={isOk ? "ok" : "warn"}>{message}</Callout>
        </div>
      ) : null}

      <div className="grid">
        {status === undefined ? null : (
          <Card title="現在の状態" className="col-6">
            {!status.ok ? (
              <Callout state="bad">接続状態を読み出せませんでした（{status.reason}）。</Callout>
            ) : status.data === null ? (
              <p className="small muted">アカウントはまだ登録されていません。下のボタンから接続してください。</p>
            ) : (
              <StatusList row={status.data} />
            )}
          </Card>
        )}

        <Card title="接続する" className={status === undefined ? "col-12" : "col-6"}>
          <div className="stack">
            {!envResult.ok ? (
              <Callout state="warn">
                {configMissingReason(envResult.missing)}。apps/web/.env.local に設定してから再読み込みしてください。
              </Callout>
            ) : null}
            <form method="post" action="/api/meta/login">
              <button type="submit" className="btn" disabled={!envResult.ok} aria-disabled={!envResult.ok ? "true" : undefined}>
                Meta と接続する
              </button>
            </form>
            <p className="xs muted">登録済みのアカウントがあるときは、同じボタンで再接続（トークンの差し替え）になります。</p>
          </div>
        </Card>

        <Card title="接続で起きること" className="col-12">
          <ol className="small list-decimal space-y-1 pl-5">
            <li>Facebook の認可画面に移動し、このアプリに権限（{OAUTH_SCOPES.join("、")}）を許可します。</li>
            <li>
              Instagram プロアカウントに接続された Facebook ページを探します。複数見つかった場合は登録せず、対象のページだけを選んでやり直してもらいます。
            </li>
            <li>
              そのページのアクセストークン（期限なし。データアクセス期限は約 90 日）を確認し、DB の Vault に暗号化して保存します。ブラウザには残しません。
            </li>
            <li>収集ワーカーが次の実行からこのトークンを使います。</li>
          </ol>
        </Card>
      </div>
    </main>
  );
}
