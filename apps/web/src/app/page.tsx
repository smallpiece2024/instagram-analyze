import Link from "next/link";
import {
  accountStatusLabel,
  credentialStatusLabel,
  daysLeft,
  EMPTY,
  formatJst,
  missingScopes,
  needsReconnect,
  tokenTypeLabel,
} from "@/lib/format";
import { getConnectionStatus, type ConnectionStatus } from "@/lib/queries/connection-status";
import { checkSupabaseHealth } from "@/lib/supabase-health";

/** 再接続を促す帯の理由（設計 1.1 章、1.6 章）。固定文言と DB の `last_error`（ワーカーがマスク済み）だけ */
function reconnectReason(s: ConnectionStatus, now: Date): string {
  if (s.credential_status === null) return "認証情報が登録されていません";
  if (s.credential_status !== "valid") {
    const base = `認証情報の状態が「${credentialStatusLabel(s.credential_status)}」です`;
    return s.last_error ? `${base}（${s.last_error}）` : base;
  }
  const left = daysLeft(s.data_access_expires_at, now);
  if (left !== undefined && left < 0) return "データアクセス期限を過ぎています";
  return `データアクセス期限まで残り ${left ?? EMPTY} 日です`;
}

function AccountCard({ s, now }: { s: ConnectionStatus; now: Date }) {
  const reconnect = needsReconnect({
    credential_status: s.credential_status,
    data_access_expires_at: s.data_access_expires_at,
    now,
  });
  const left = daysLeft(s.data_access_expires_at, now);
  const missing = missingScopes(s.scopes);
  const rows: [string, string][] = [
    ["ユーザー名", s.username ?? EMPTY],
    ["表示名", s.name ?? EMPTY],
    ["アカウントの状態", accountStatusLabel(s.account_status)],
    ["トークンの種類", tokenTypeLabel(s.token_type)],
    ["トークンの有効期限", s.token_type === null ? EMPTY : s.token_expires_at === null ? "期限なし" : formatJst(s.token_expires_at)],
    [
      "データアクセス期限",
      s.data_access_expires_at === null
        ? EMPTY
        : `${formatJst(s.data_access_expires_at)}（${left !== undefined && left < 0 ? "期限切れ" : `残り ${left ?? EMPTY} 日`}）`,
    ],
    ["権限", s.scopes && s.scopes.length > 0 ? s.scopes.join(", ") : EMPTY],
    ["不足している権限", missing.length === 0 ? "なし" : missing.join(", ")],
    ["認証情報の状態", credentialStatusLabel(s.credential_status)],
    ["最後のエラー", s.last_error ?? EMPTY],
    ["最終確認", formatJst(s.last_checked_at)],
    ["最終収集", formatJst(s.last_collected_at)],
  ];
  return (
    <section className="rounded border border-neutral-200 p-4">
      <h2 className="text-lg font-semibold">{s.username ? `@${s.username}` : "（ユーザー名なし）"}</h2>
      {reconnect && (
        <p className="mt-3 rounded border border-amber-400 bg-amber-50 p-3 text-sm text-amber-900">
          再接続が必要です: {reconnectReason(s, now)}。最終確認 {formatJst(s.last_checked_at)}。{" "}
          <Link href="/connect" className="font-semibold underline">
            接続設定へ
          </Link>
        </p>
      )}
      <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[12rem_1fr]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-neutral-500">{label}</dt>
            <dd className="break-words">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export default async function Home() {
  const [status, health] = await Promise.all([getConnectionStatus(), checkSupabaseHealth(2000)]);
  const now = new Date();
  const allOk = health.configured && health.services.every((s) => s.ok);

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
      <h1 className="text-2xl font-bold">接続状態</h1>
      <p className="mt-1 text-sm text-neutral-500">Meta との接続と、収集の最終時刻。</p>

      <div className="mt-6 space-y-4">
        {!status.ok ? (
          <p className="rounded border border-red-400 bg-red-50 p-4 text-sm text-red-900">
            接続状態を読み出せません（{status.reason}）。
          </p>
        ) : status.data.length === 0 ? (
          <p className="rounded border border-amber-400 bg-amber-50 p-4 text-sm text-amber-900">
            アカウントが登録されていません。{" "}
            <Link href="/connect" className="font-semibold underline">
              接続設定
            </Link>{" "}
            から Meta と接続してください。
          </p>
        ) : (
          status.data.map((s) => <AccountCard key={s.account_id} s={s} now={now} />)
        )}
      </div>

      <section className="mt-10 border-t border-neutral-200 pt-6">
        <h2 className="text-base font-semibold text-neutral-700">開発環境: Supabase の接続状態</h2>
        <p className="mt-1 text-sm text-neutral-500">接続先: {health.url ?? "未設定"}</p>
        {!health.configured ? (
          <p className="mt-3 rounded border border-amber-400 bg-amber-50 p-3 text-sm text-amber-900">
            環境変数が設定されていません。apps/web/.env.example を .env.local にコピーし、値を入れてください。
          </p>
        ) : (
          <>
            <ul className="mt-3 divide-y divide-neutral-200 rounded border border-neutral-200 text-sm">
              {health.services.map((s) => (
                <li key={s.path} className="flex items-center justify-between gap-4 px-4 py-2">
                  <span>{s.name}</span>
                  <span
                    className={
                      s.ok
                        ? "rounded bg-green-100 px-2 py-0.5 text-green-800"
                        : "rounded bg-red-100 px-2 py-0.5 text-red-800"
                    }
                  >
                    {s.ok ? "OK" : "NG"}・{s.detail}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-sm text-neutral-600">
              {allOk
                ? "すべてのサービスに接続できています。"
                : "接続できないサービスがあります。ルートで npm run db:start を実行したか確認してください。"}
            </p>
          </>
        )}
      </section>
    </main>
  );
}
