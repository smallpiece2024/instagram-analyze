/**
 * 収集スケジュールのカード（R3 設計 3.6 節。見本の `S.connection` の「収集スケジュール」）。
 * ジョブごとの予定（定数）と直近の実行結果（`job_latest_runs`）を並べる。
 */
import { Callout } from "@/components/Callout";
import { Card } from "@/components/Card";
import { formatJst, JOB_ORDER } from "@/lib/format";
import { getLatestRuns } from "@/lib/queries/jobs";
import { JOB_SCHEDULE, runState } from "./schedule";

export async function ScheduleCard({ accountId, className }: { accountId: string; className?: string }) {
  const latest = await getLatestRuns(accountId);
  return (
    <Card title="収集スケジュール" className={className}>
      {!latest.ok ? (
        <Callout state="bad">読み出せません（{latest.reason}）</Callout>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>ジョブ</th>
                <th>予定</th>
                <th>直近の結果</th>
              </tr>
            </thead>
            <tbody>
              {JOB_ORDER.map((job) => {
                const run = latest.data.find((r) => r.job_name === job);
                const view = run ? runState(run.status) : null;
                return (
                  <tr key={job}>
                    <td>
                      <code>{job}</code>
                    </td>
                    <td className="small">{JOB_SCHEDULE[job]}</td>
                    <td className="nowrap small">
                      {run && view ? (
                        <>
                          <span className="status" data-state={view.state}>
                            {view.label}
                          </span>{" "}
                          {formatJst(run.started_at)}
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="xs muted">実行環境: GitHub Actions（Supabase の pg_cron が起動）</p>
    </Card>
  );
}
