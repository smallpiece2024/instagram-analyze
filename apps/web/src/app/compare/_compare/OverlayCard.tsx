import { Callout } from "@/components/Callout";
import { Card } from "@/components/Card";
import { Legend } from "@/components/charts/Legend";
import { LineChart } from "@/components/charts/LineChart";
import { formatCount } from "@/lib/format";
import { eachDay, periodLength, type Period } from "@/lib/period";
import { getDailySeries, type DailyPoint } from "@/lib/queries/period-summary";
import { monthDay, periodLabel } from "./labels";

/** 期間の 1 日目からの並びにしたリーチ数（行のない日は null） */
function alignedReach(period: Period, points: readonly DailyPoint[]): (number | null)[] {
  const byDate = new Map(points.map((p) => [p.metric_date, p.reach]));
  return eachDay(period).map((d) => byDate.get(d) ?? null);
}

function pad<T>(values: readonly T[], length: number, fill: T): T[] {
  return [...values, ...Array.from({ length: Math.max(0, length - values.length) }, () => fill)];
}

/** X 軸の 1 段の日付（「9/1」）。期間が短い側は残りを空にする */
function axisLabels(period: Period, length: number): string[] {
  return pad(eachDay(period).map(monthDay), length, "");
}

/** 点のヒント。「A 9/3: 1,234」 */
function pointTips(name: string, period: Period, values: readonly (number | null)[]): string[] {
  const days = eachDay(period);
  return values.map((v, i) => `${name} ${days[i] ? monthDay(days[i]) : ""}: ${formatCount(v)}`);
}

const ROW_NAMES = ["A", "B"] as const;
const ROW_COLORS = ["var(--color-primary)", "var(--color-neutral)"] as const;

/**
 * リーチ数の日次の重ね合わせ（3.5 節「表示」の 2、見本 v4 の `overlayCard`）。期間の 1 日目をそろえ、A は実線、B は破線。
 * X 軸のラベルは 2 段（1 段目 A の日付、2 段目 B の日付）。日付は日次指標の日付（API の区切り。米国太平洋時間）
 */
export async function OverlayCard({ accountId, a, b }: { accountId: string; a: Period; b: Period }) {
  const [ra, rb] = await Promise.all([getDailySeries(accountId, a.from, a.to), getDailySeries(accountId, b.from, b.to)]);
  const failed = !ra.ok ? ra : !rb.ok ? rb : null;
  if (failed !== null || !ra.ok || !rb.ok) {
    return (
      <Card title="リーチ数" className="col-12">
        <Callout state="bad">読み出せません（{failed?.reason}）</Callout>
      </Card>
    );
  }
  const len = Math.max(periodLength(a), periodLength(b));
  const labels = axisLabels(a, len);
  const labels2 = axisLabels(b, len);
  const valuesA = pad(alignedReach(a, ra.data), len, null);
  const valuesB = pad(alignedReach(b, rb.data), len, null);
  const series = [
    {
      label: `A（${periodLabel(a)}）`,
      values: valuesA,
      color: "var(--color-primary)",
      dots: len <= 31,
      pointTips: pointTips("A", a, valuesA),
    },
    {
      label: `B（${periodLabel(b)}）`,
      values: valuesB,
      color: "var(--color-neutral)",
      dashed: true,
      pointTips: pointTips("B", b, valuesB),
    },
  ];
  const title = `リーチ数の日次。A ${periodLabel(a)} と B ${periodLabel(b)} を 1 日目をそろえて重ねた折れ線`;

  return (
    <Card title="リーチ数" className="col-12" foot="1 日は 16 時から翌日の 16 時まで。">
      <Legend
        items={[
          { label: `A ${periodLabel(a)}`, color: "var(--color-primary)", shape: "line" },
          { label: `B ${periodLabel(b)}`, color: "var(--color-neutral)", shape: "dash" },
        ]}
      />
      <div className="chart only-d">
        <LineChart
          title={title}
          labels={labels}
          labels2={labels2}
          rowNames={ROW_NAMES}
          rowColors={ROW_COLORS}
          series={series}
          width={1140}
          height={256}
        />
      </div>
      <div className="chart only-m">
        <LineChart
          title={title}
          labels={labels}
          labels2={labels2}
          rowNames={ROW_NAMES}
          rowColors={ROW_COLORS}
          series={series}
          width={340}
          height={216}
        />
      </div>
    </Card>
  );
}
