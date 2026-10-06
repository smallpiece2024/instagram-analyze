/**
 * 接続状態のカード（R1 設計 1.1 章、1.6 章、R3 設計 3.6 節。見本の `S.connection` の「接続状態」）。
 * 見本の「再接続」「トークンを確認」のボタンは置かない（ユーザーの決定）。再接続が要るときだけ `/connect` への案内を出す。
 * `_components` は Next.js の private folder で、ルートにならない。
 */
import Link from "next/link";
import { Callout } from "@/components/Callout";
import { Card } from "@/components/Card";
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
import { DATA_ACCESS_SPAN_DAYS, expiryState } from "./schedule";

/** 再接続を促す帯の理由（R1 設計 1.1 章、1.6 章）。固定文言と DB の `last_error`（ワーカーがマスク済み）だけ */
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

function expiryLabel(d: Date | null, left: number | undefined): string {
  if (d === null) return EMPTY;
  if (left === undefined) return formatJst(d);
  return `${formatJst(d)}（${left < 0 ? "期限切れ" : `あと ${left} 日`}）`;
}

export function AccountStatusBody({ s, now }: { s: ConnectionStatus; now: Date }) {
  const reconnect = needsReconnect({
    credential_status: s.credential_status,
    data_access_expires_at: s.data_access_expires_at,
    now,
  });
  const left = daysLeft(s.data_access_expires_at, now);
  const missing = missingScopes(s.scopes);
  const state = s.credential_status === "valid" ? (reconnect ? "warn" : "ok") : "bad";
  const width = left === undefined ? 0 : Math.min(100, Math.max(0, (left / DATA_ACCESS_SPAN_DAYS) * 100));
  return (
    <div className="stack">
      {reconnect && (
        <Callout state={s.credential_status === "valid" ? "warn" : "bad"}>
          再接続が必要です: {reconnectReason(s, now)}。<Link href="/connect">接続設定へ</Link>
        </Callout>
      )}
      <dl className="dl">
        <dt>状態</dt>
        <dd>
          <span className="status" data-state={state}>
            {credentialStatusLabel(s.credential_status)}
          </span>
        </dd>
        <dt>Instagram</dt>
        <dd>
          {s.username ? `@${s.username}` : EMPTY}
          {s.name ? `（${s.name}）` : ""}
        </dd>
        <dt>アカウント</dt>
        <dd>{accountStatusLabel(s.account_status)}</dd>
        <dt>トークン</dt>
        <dd>
          {tokenTypeLabel(s.token_type)}
          {s.token_type === null ? "" : s.token_expires_at === null ? "・期限なし" : `・期限 ${formatJst(s.token_expires_at)}`}
        </dd>
        <dt>データアクセス期限</dt>
        <dd>{expiryLabel(s.data_access_expires_at, left)}</dd>
        <dt>不足している権限</dt>
        <dd>{s.credential_status === null ? EMPTY : missing.length === 0 ? "なし" : missing.join(", ")}</dd>
        <dt>最終確認</dt>
        <dd>{formatJst(s.last_checked_at)}</dd>
        <dt>最終収集</dt>
        <dd>{formatJst(s.last_collected_at)}</dd>
        <dt>最終エラー</dt>
        <dd>{s.last_error ?? EMPTY}</dd>
      </dl>
      {left !== undefined && (
        <div
          className="progress"
          data-state={expiryState(left)}
          role="img"
          aria-label={`データアクセス期限まで ${Math.max(0, left)} 日`}
        >
          <i style={{ width: `${width.toFixed(0)}%` }} />
        </div>
      )}
    </div>
  );
}

/** 接続状態のカード（読み出し、失敗、未登録の表示を含む）。async Server Component */
export async function ConnectionStatusList({ accountId, className }: { accountId: string; className?: string }) {
  const status = await getConnectionStatus(accountId);
  const now = new Date();
  return (
    <Card title="接続状態" sub="Meta Graph API" className={className}>
      {!status.ok ? (
        <Callout state="bad">読み出せません（{status.reason}）</Callout>
      ) : status.data === null ? (
        <Callout state="warn">
          認証情報が登録されていません。<Link href="/connect">接続設定へ</Link>
        </Callout>
      ) : (
        <AccountStatusBody s={status.data} now={now} />
      )}
    </Card>
  );
}
