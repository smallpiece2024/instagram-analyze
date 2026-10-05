/**
 * ジョブの実行記録のカード（R3 設計 3.6 節。見本の `S.connection` の `log`）。
 * 絞り込みのチップはクエリ `?job=&status=` のリンク。50 件ずつページ送り。見本のカードの説明文は置かない（ユーザーの決定）。
 * `job_runs.error` はワーカーがトークンや取得データを含めない決まりなので、そのまま出す（R1 と同じ）。
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { Callout } from "@/components/Callout";
import { Card } from "@/components/Card";
import { buildHref, type Query } from "@/components/href";
import { Pager } from "@/components/Pager";
import { EMPTY, formatCount, formatJst, JOB_ORDER, jobRowView, type JobName, type JobStatus } from "@/lib/format";
import { listRecentRuns, type JobRunView } from "@/lib/queries/jobs";
import { runState } from "./schedule";

const PATH = "/jobs";

function Chip({ href, active, children }: { href: string; active: boolean; children: ReactNode }) {
  return (
    <Link className="chip" href={href} aria-current={active ? "true" : undefined}>
      {children}
    </Link>
  );
}

function RunRow({ r, now }: { r: JobRunView; now: Date }) {
  const v = jobRowView(r, now);
  const { state, label } = runState(r.status);
  const parts = [v.errorText, r.api_calls === null ? null : `API 呼び出し ${formatCount(r.api_calls)} 回`, v.usageLabel === EMPTY ? null : v.usageLabel];
  const text = parts.filter((p): p is string => p !== null).join("・");
  return (
    <tr data-state={state === "bad" || state === "warn" ? state : undefined}>
      <td className="nowrap small">{formatJst(r.started_at)}</td>
      <td>
        <code>{r.job_name}</code>
      </td>
      <td>
        <span className="status" data-state={state}>
          {label}
        </span>
      </td>
      <td className="num hide-m">{v.durationLabel}</td>
      <td className="num hide-m">{formatCount(r.items_fetched)}</td>
      <td>
        {text === "" ? (
          <span className="muted">—</span>
        ) : v.errorIsLong ? (
          <details>
            <summary className="log-msg">{text}</summary>
            <p className="xs">{text}</p>
          </details>
        ) : (
          <span className="log-msg">{text}</span>
        )}
      </td>
    </tr>
  );
}

export async function RunsCard({
  accountId,
  job,
  status,
  page,
  className,
}: {
  accountId: string;
  job?: JobName;
  status?: JobStatus;
  page: number;
  className?: string;
}) {
  const result = await listRecentRuns(accountId, { job, status, page });
  const now = new Date();
  const query: Query = { job, status };
  const failedOnly = status === "failed";
  return (
    <Card title="ジョブの実行記録" sub={result.ok ? `${formatCount(result.data.total)} 件` : undefined} className={className}>
      <div className="stack">
        <nav className="chips" aria-label="絞り込み">
          <Chip href={PATH} active={job === undefined && status === undefined}>
            すべて
          </Chip>
          <Chip href={buildHref(PATH, query, { status: failedOnly ? undefined : "failed" })} active={failedOnly}>
            失敗のみ
          </Chip>
          {JOB_ORDER.map((name) => (
            <Chip key={name} href={buildHref(PATH, query, { job: job === name ? undefined : name })} active={job === name}>
              {name}
            </Chip>
          ))}
        </nav>
        {!result.ok ? (
          <Callout state="bad">読み出せません（{result.reason}）</Callout>
        ) : result.data.rows.length === 0 ? (
          <p className="small muted">記録がありません。</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>時刻</th>
                  <th>ジョブ</th>
                  <th>結果</th>
                  <th className="num hide-m">所要</th>
                  <th className="num hide-m">件数</th>
                  <th>内容</th>
                </tr>
              </thead>
              <tbody>
                {result.data.rows.map((r) => (
                  <RunRow key={r.id} r={r} now={now} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {result.ok && <Pager page={result.data.page} pageCount={result.data.pageCount} path={PATH} query={query} />}
    </Card>
  );
}
