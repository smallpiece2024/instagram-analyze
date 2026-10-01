import Link from "next/link";
import { EMPTY, formatCount, formatJst, JOB_ORDER, jobRowView, parseJobFilter } from "@/lib/format";
import { getLatestRuns, listRecentRuns, RECENT_RUNS_LIMIT, type JobRunView } from "@/lib/queries/jobs";

const TH = "whitespace-nowrap px-3 py-2 text-left font-medium text-neutral-600";
const TD = "whitespace-nowrap px-3 py-2 align-top";

function statusClass(status: string): string {
  switch (status) {
    case "success":
      return "text-green-800";
    case "running":
      return "text-blue-800";
    case "partial":
    case "skipped":
      return "text-amber-800";
    case "failed":
      return "text-red-800";
    default:
      return "";
  }
}

function RunsTable({ rows, now }: { rows: JobRunView[]; now: Date }) {
  if (rows.length === 0) return <p className="mt-3 text-sm text-neutral-500">記録がありません。</p>;
  return (
    <div className="mt-3 overflow-x-auto rounded border border-neutral-200">
      <table className="min-w-full text-sm">
        <thead className="bg-neutral-50">
          <tr>
            <th className={TH}>ユーザー名</th>
            <th className={TH}>ジョブ</th>
            <th className={TH}>状態</th>
            <th className={TH}>開始（JST）</th>
            <th className={TH}>所要時間</th>
            <th className={`${TH} text-right`}>取得件数</th>
            <th className={`${TH} text-right`}>API 呼び出し</th>
            <th className={TH}>エラー</th>
            <th className={TH}>使用率</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-200">
          {rows.map((r) => {
            const v = jobRowView(r, now);
            return (
              <tr key={r.id}>
                <td className={TD}>{r.username ?? EMPTY}</td>
                <td className={`${TD} font-mono`}>{r.job_name}</td>
                <td className={`${TD} ${statusClass(r.status)}`}>{v.statusLabel}</td>
                <td className={TD}>{formatJst(r.started_at)}</td>
                <td className={TD}>{v.durationLabel}</td>
                <td className={`${TD} text-right`}>{formatCount(r.items_fetched)}</td>
                <td className={`${TD} text-right`}>{formatCount(r.api_calls)}</td>
                <td className="max-w-md px-3 py-2 align-top">
                  {v.errorText === null ? (
                    EMPTY
                  ) : v.errorIsLong ? (
                    <details>
                      <summary className="cursor-pointer whitespace-nowrap">{v.errorText.slice(0, 40)}…</summary>
                      <p className="mt-1 break-words whitespace-pre-wrap">{v.errorText}</p>
                    </details>
                  ) : (
                    <span className="break-words">{v.errorText}</span>
                  )}
                </td>
                <td className={TD}>{v.usageLabel}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default async function JobsPage(props: PageProps<"/jobs">) {
  const { job } = await props.searchParams;
  const filter = parseJobFilter(job);
  const [latest, recent] = await Promise.all([getLatestRuns(), listRecentRuns(filter)]);
  const now = new Date();

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
      <h1 className="text-2xl font-bold">収集ログ</h1>
      <p className="mt-1 text-sm text-neutral-500">
        ワーカーの実行記録（job_runs）。エラーの文言はワーカーがマスク済みのもの。
      </p>

      <section className="mt-6">
        <h2 className="text-lg font-semibold">ジョブごとの直近の実行</h2>
        {latest.ok ? (
          <RunsTable rows={latest.data} now={now} />
        ) : (
          <p className="mt-3 rounded border border-red-400 bg-red-50 p-3 text-sm text-red-900">
            読み出せません（{latest.reason}）。
          </p>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">
          直近 {RECENT_RUNS_LIMIT} 件の実行{filter ? `（${filter}）` : ""}
        </h2>
        <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm">
          <span className="text-neutral-500">絞り込み:</span>
          <Link href="/jobs" className={filter === undefined ? "font-semibold" : "text-blue-700 hover:underline"}>
            すべて
          </Link>
          {JOB_ORDER.map((name) => (
            <Link
              key={name}
              href={`/jobs?job=${name}`}
              className={filter === name ? "font-mono font-semibold" : "font-mono text-blue-700 hover:underline"}
            >
              {name}
            </Link>
          ))}
        </p>
        {recent.ok ? (
          <RunsTable rows={recent.data} now={now} />
        ) : (
          <p className="mt-3 rounded border border-red-400 bg-red-50 p-3 text-sm text-red-900">
            読み出せません（{recent.reason}）。
          </p>
        )}
      </section>
    </main>
  );
}
