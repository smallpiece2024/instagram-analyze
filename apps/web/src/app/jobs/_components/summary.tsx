/**
 * `/jobs` の見出しの下の 1 行、失敗の警告、数字タイル（R3 設計 3.6 節。見本の `S.connection` の `head`、`alert`、`kpis`）。
 * 値は `getJobStats` と `getConnectionStatus`（どちらも `React.cache` で 1 リクエスト 1 回）。
 */
import { Callout } from "@/components/Callout";
import { Kpi } from "@/components/Kpi";
import { daysLeft, EMPTY, formatCount, formatJst, usagePercent } from "@/lib/format";
import { getConnectionStatus } from "@/lib/queries/connection-status";
import { getJobStats } from "@/lib/queries/jobs";
import { ALERT_FAILED_RUNS, earliestExpiry, nextCollectAt } from "./schedule";

/** 見出しの下の 1 行: 「最終成功 … ・次回 … ごろ」 */
export async function JobsHeadSub({ accountId }: { accountId: string }) {
  const stats = await getJobStats(accountId);
  const next = `次回 ${formatJst(nextCollectAt(new Date()))} ごろ`;
  if (!stats.ok) return <>{next}</>;
  return (
    <>
      最終成功 {formatJst(stats.data.lastSuccessAt)}・{next}
    </>
  );
}

/** 直近 24 時間の失敗の警告と数字タイル */
export async function JobsSummary({ accountId }: { accountId: string }) {
  const [stats, conn] = await Promise.all([getJobStats(accountId), getConnectionStatus(accountId)]);
  if (!stats.ok) return <Callout state="bad">読み出せません（{stats.reason}）</Callout>;
  const s = stats.data;
  const now = new Date();
  const c = conn.ok ? conn.data : null;
  const expiry = c === null ? null : earliestExpiry(c.token_expires_at, c.data_access_expires_at);
  const left = daysLeft(expiry, now);
  const usage = s.latestRateUsage === null ? undefined : usagePercent(s.latestRateUsage.rate_usage);
  const breakdown = [`成功 ${s.last24h.success}`, `注意 ${s.last24h.warn}`, `失敗 ${s.last24h.failed}`];
  if (s.last24h.running > 0) breakdown.push(`実行中 ${s.last24h.running}`);
  const f = s.latestFailure;
  return (
    <>
      {s.last24h.failed > 0 && (
        <Callout state="bad">
          <b>直近 24 時間に失敗が {s.last24h.failed} 件。</b>
          {f && (
            <>
              {" "}
              最新は <code>{f.job_name}</code>（{formatJst(f.started_at)}）
              {f.error ? `: ${f.error}` : ""}
            </>
          )}
        </Callout>
      )}
      <div className="kpis">
        <Kpi label="24 時間の実行" value={formatCount(s.last24h.total)} denom={breakdown.join("・")} />
        <Kpi
          label="連続失敗"
          value={formatCount(s.consecutiveFailures.count)}
          denom={`通知のしきい値 ${ALERT_FAILED_RUNS}${s.consecutiveFailures.job_name ? `・${s.consecutiveFailures.job_name}` : ""}`}
        />
        <Kpi
          label="トークン期限まで"
          value={left === undefined ? EMPTY : String(Math.max(0, left))}
          unit={left === undefined ? undefined : "日"}
          denom={expiry === null ? undefined : formatJst(expiry)}
        />
        <Kpi
          label="API 使用率"
          value={usage === undefined ? EMPTY : `${usage}%`}
          denom={s.latestRateUsage?.finished_at ? `${formatJst(s.latestRateUsage.finished_at)} の実行` : undefined}
        />
        <Kpi label="保存した投稿" value={formatCount(s.mediaCount)} />
        <Kpi label="保存した日次指標" value={formatCount(s.dailyDays)} unit="日分" />
      </div>
    </>
  );
}
