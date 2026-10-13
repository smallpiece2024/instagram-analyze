import { LoadError } from "@/app/_overview/states";
import { Card } from "@/components/Card";
import { Kpi } from "@/components/Kpi";
import { LineChart, type LineSeries } from "@/components/charts/LineChart";
import { EMPTY, formatCount, formatDateShort, formatPercent } from "@/lib/format";
import { ACCOUNT_METRIC_DEFINITIONS as DEF } from "@/lib/metric-definitions";
import { deltaPoint, deltaRate } from "@/lib/metrics";
import { eachDay, type Period } from "@/lib/period";
import { getDailySeries, getDailyTotals, type DailyPoint, type DailySum } from "@/lib/queries/period-summary";
import { SECTION_TITLES, WIDTHS } from "./titles";

const TITLE = SECTION_TITLES.reachViews;

type BreakdownKey = "reach_follower" | "reach_non_follower" | "views_follower" | "views_non_follower";

/** 「30 日中 28 日分」。欠けがなければ出さない（`OverviewKpis` と同じ形） */
function coverage(sum: DailySum, periodDays: number, prefix = ""): string | undefined {
  return sum.days < periodDays ? `${prefix}${periodDays} 日中 ${sum.days} 日分` : undefined;
}

/** フォロワー（実線）とフォロワー以外（同じ色の破線）の 2 系列。凡例の部品はないので `endLabel` に系列名と値（U8） */
function breakdownSeries(points: readonly (DailyPoint | undefined)[], follower: BreakdownKey, nonFollower: BreakdownKey): LineSeries[] {
  const pick = (key: BreakdownKey) => points.map((p) => p?.[key] ?? null);
  const lastOf = (values: readonly (number | null)[]) => [...values].reverse().find((v): v is number => v !== null);
  const f = pick(follower);
  const n = pick(nonFollower);
  const lf = lastOf(f);
  const ln = lastOf(n);
  return [
    { label: "フォロワー", values: f, color: "var(--chart-1)", endLabel: lf === undefined ? undefined : `フォロワー ${formatCount(lf)}` },
    {
      label: "フォロワー以外",
      values: n,
      color: "var(--chart-1)",
      dashed: true,
      endLabel: ln === undefined ? undefined : `フォロワー以外 ${formatCount(ln)}`,
    },
  ];
}

function hasValue(series: readonly LineSeries[]): boolean {
  return series.some((s) => s.values.some((v) => v !== null));
}

/**
 * 4 節: 日ごとのリーチ（フォロワー／非フォロワー）と閲覧数（同）の 2 つのグラフ、月の合計と非フォロワーリーチ比率（前月比 pt）。
 * 日次指標の日付は太平洋時間（ページの末尾の注記）
 */
export async function ReachViewsTrendCard({ accountId, period, prev }: { accountId: string; period: Period; prev: Period }) {
  const [series, cur, before] = await Promise.all([
    getDailySeries(accountId, period.from, period.to),
    getDailyTotals(accountId, period.from, period.to),
    getDailyTotals(accountId, prev.from, prev.to),
  ]);
  const failed = [series, cur, before].find((r) => !r.ok);
  if (failed && !failed.ok) {
    return (
      <Card title={TITLE}>
        <LoadError reason={failed.reason} />
      </Card>
    );
  }
  if (!series.ok || !cur.ok || !before.ok) return null;

  const dates = eachDay(period);
  const labels = dates.map(formatDateShort);
  const byDate = new Map(series.data.map((p) => [p.metric_date, p]));
  const points = dates.map((d) => byDate.get(d));
  const reach = breakdownSeries(points, "reach_follower", "reach_non_follower");
  const views = breakdownSeries(points, "views_follower", "views_non_follower");
  const dc = cur.data;
  const dp = before.data;

  const chart = (title: string, s: LineSeries[]) =>
    hasValue(s) ? (
      WIDTHS.map(({ width, className }) => (
        <div key={width} className={`chart ${className}`}>
          <LineChart title={title} labels={labels} width={width} height={160} align series={s} />
        </div>
      ))
    ) : (
      <p className="muted">{EMPTY}</p>
    );

  return (
    <Card title={TITLE} foot={<>日次指標: {period.from} 〜 {period.to}・実線はフォロワー、破線はフォロワー以外</>}>
      <div className="kpis">
        <Kpi
          label={DEF.reach.label}
          hint={DEF.reach.hint}
          value={formatCount(dc.reach.sum)}
          delta={dp.reach.days === 0 ? null : deltaRate(dc.reach.sum, dp.reach.sum)}
          denom={coverage(dc.reach, dc.periodDays)}
        />
        <Kpi
          label={DEF.views.label}
          hint={DEF.views.hint}
          value={formatCount(dc.views.sum)}
          delta={dp.views.days === 0 ? null : deltaRate(dc.views.sum, dp.views.sum)}
          denom={coverage(dc.views, dc.periodDays)}
        />
        <Kpi
          label={DEF.non_follower_reach_rate.label}
          hint={DEF.non_follower_reach_rate.hint}
          value={formatPercent(dc.nonFollowerReachRate.value)}
          delta={dp.nonFollowerReachRate.used === 0 ? null : deltaPoint(dc.nonFollowerReachRate.value, dp.nonFollowerReachRate.value)}
          denom={
            dc.nonFollowerReachRate.used < dc.nonFollowerReachRate.total
              ? `${dc.nonFollowerReachRate.total} 日中 ${dc.nonFollowerReachRate.used} 日分`
              : undefined
          }
        />
      </div>
      <p className="small muted mt-6">リーチ数</p>
      {chart("リーチ数の折れ線グラフ（フォロワーとフォロワー以外）", reach)}
      <p className="small muted mt-6">閲覧数</p>
      {chart("閲覧数の折れ線グラフ（フォロワーとフォロワー以外）", views)}
    </Card>
  );
}
