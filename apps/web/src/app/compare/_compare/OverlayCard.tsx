import { Callout } from "@/components/Callout";
import { Card } from "@/components/Card";
import { Legend } from "@/components/charts/Legend";
import { LineChart } from "@/components/charts/LineChart";
import { eachDay, periodLength, type Period } from "@/lib/period";
import { getDailySeries, type DailyPoint } from "@/lib/queries/period-summary";
import { periodLabel } from "./labels";

/** 期間の 1 日目からの並びにしたリーチ（行のない日は null） */
function alignedReach(period: Period, points: readonly DailyPoint[]): (number | null)[] {
  const byDate = new Map(points.map((p) => [p.metric_date, p.reach]));
  return eachDay(period).map((d) => byDate.get(d) ?? null);
}

function pad<T>(values: readonly T[], length: number, fill: T): T[] {
  return [...values, ...Array.from({ length: Math.max(0, length - values.length) }, () => fill)];
}

/** 日次の重ね合わせ（3.5 節「表示」の 2）。期間の 1 日目をそろえ、A は実線、B は破線 */
export async function OverlayCard({ accountId, a, b }: { accountId: string; a: Period; b: Period }) {
  const [ra, rb] = await Promise.all([getDailySeries(accountId, a.from, a.to), getDailySeries(accountId, b.from, b.to)]);
  const failed = !ra.ok ? ra : !rb.ok ? rb : null;
  if (failed !== null || !ra.ok || !rb.ok) {
    return (
      <Card title="リーチの日次の重ね合わせ" className="col-12">
        <Callout state="bad">読み出せません（{failed?.reason}）</Callout>
      </Card>
    );
  }
  const len = Math.max(periodLength(a), periodLength(b));
  const labels = Array.from({ length: len }, (_, i) => `${i + 1} 日目`);
  const valuesA = pad(alignedReach(a, ra.data), len, null);
  const valuesB = pad(alignedReach(b, rb.data), len, null);
  const series = [
    { label: `A（${periodLabel(a)}）`, values: valuesA, color: "var(--color-primary)", dots: len <= 31 },
    { label: `B（${periodLabel(b)}）`, values: valuesB, color: "var(--color-neutral)", dashed: true },
  ];
  const title = `リーチの日次。A ${periodLabel(a)} と B ${periodLabel(b)} を 1 日目をそろえて重ねた折れ線`;

  return (
    <Card
      title="リーチの日次の重ね合わせ"
      className="col-12"
      foot={`日付は米国太平洋時間の日付。X 軸は各期間の何日目か（A の 1 日目は ${a.from}、B の 1 日目は ${b.from}）。`}
    >
      <Legend
        items={[
          { label: `A ${periodLabel(a)}`, color: "var(--color-primary)", shape: "line" },
          { label: `B ${periodLabel(b)}`, shape: "dash" },
        ]}
      />
      <div className="chart only-d">
        <LineChart title={title} labels={labels} series={series} width={1140} height={240} />
      </div>
      <div className="chart only-m">
        <LineChart title={title} labels={labels} series={series} width={340} height={200} />
      </div>
    </Card>
  );
}
