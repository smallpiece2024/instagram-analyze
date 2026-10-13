import { LoadError } from "@/app/_overview/states";
import { Card } from "@/components/Card";
import { LineChart } from "@/components/charts/LineChart";
import { EMPTY, formatCount, formatDateShort, formatSignedCount } from "@/lib/format";
import { eachDay, type Period } from "@/lib/period";
import { getFollowerChange, getFollowerSeries } from "@/lib/queries/period-summary";
import { SECTION_TITLES, WIDTHS } from "./titles";

const TITLE = SECTION_TITLES.followers;

/**
 * 3 節: 月内の日ごとのフォロワー数の折れ線と、月初・月末の値と純増（R6 設計 6.1 節）。
 * フォロワー数は日本時間の日付（`captured_on`）で、同じ日付の位置に置く。月初は前日以前の最も新しい記録、月末は `to` 以前の最も新しい記録
 */
export async function FollowerTrendCard({ accountId, period }: { accountId: string; period: Period }) {
  const [series, change] = await Promise.all([
    getFollowerSeries(accountId, period.from, period.to),
    getFollowerChange(accountId, period.from, period.to),
  ]);
  if (!series.ok) {
    return (
      <Card title={TITLE}>
        <LoadError reason={series.reason} />
      </Card>
    );
  }
  if (!change.ok) {
    return (
      <Card title={TITLE}>
        <LoadError reason={change.reason} />
      </Card>
    );
  }
  const dates = eachDay(period);
  const labels = dates.map(formatDateShort);
  const byDate = new Map(series.data.map((p) => [p.captured_on, p.followers_count]));
  const values = dates.map((d) => byDate.get(d) ?? null);
  const last = [...values].reverse().find((v): v is number => v !== null);
  const fc = change.data;

  return (
    <Card title={TITLE} foot={<>フォロワー数の記録: {period.from} 〜 {period.to}</>}>
      <p className="small muted">
        月初 {fc.start ? `${formatCount(fc.start.followers_count)}（${fc.start.captured_on} 時点）` : EMPTY}・月末{" "}
        {fc.end ? `${formatCount(fc.end.followers_count)}（${fc.end.captured_on} 時点）` : EMPTY}・純増{" "}
        {fc.net === null ? EMPTY : formatSignedCount(fc.net)}
      </p>
      {last === undefined ? (
        <p className="muted">{EMPTY}</p>
      ) : (
        WIDTHS.map(({ width, className }) => (
          <div key={width} className={`chart ${className}`}>
            <LineChart
              autoMin
              title="フォロワー数の折れ線グラフ"
              labels={labels}
              width={width}
              height={160}
              align
              series={[{ label: "フォロワー数", values, color: "var(--chart-1)", endLabel: formatCount(last) }]}
            />
          </div>
        ))
      )}
    </Card>
  );
}
