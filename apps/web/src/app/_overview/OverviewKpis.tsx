import { Card } from "@/components/Card";
import { Kpi } from "@/components/Kpi";
import { EMPTY, formatCount, formatPercent, formatSignedCount } from "@/lib/format";
import { deltaCount, deltaPoint, deltaRate, type RatioOfSums } from "@/lib/metrics";
import type { Period } from "@/lib/period";
import { getDailyTotals, getFollowerChange, type DailySum } from "@/lib/queries/period-summary";
import { LoadError } from "./states";
import { ACCOUNT_METRIC_DEFINITIONS as DEF } from "@/lib/metric-definitions";

export interface OverviewKpisProps {
  accountId: string;
  /** 今の期間と前期間（太平洋時間の日付。投稿単位の値は同じ日付の範囲を日本時間の投稿日で数える） */
  cur: Period;
  prev: Period;
}

/** 「30 日中 28 日分」。欠けがなければ出さない */
function coverage(sum: DailySum, periodDays: number, prefix = ""): string | null {
  return sum.days < periodDays ? `${prefix}${periodDays} 日中 ${sum.days} 日分` : null;
}

/** 率の「30 日中 28 日分」。欠けがなければ出さない */
function rateCoverage(r: RatioOfSums, prefix = ""): string | null {
  return r.used < r.total ? `${prefix}${r.total} 日中 ${r.used} 日分` : null;
}

function join(...parts: (string | null | undefined)[]): string {
  return parts.filter((p): p is string => typeof p === "string" && p !== "").join("・");
}

/** 数字タイル 6 枚（3.2 節「数字タイル」）。読み出しに失敗したら、タイルの代わりにカードの中で理由を出す */
export async function OverviewKpis({ accountId, cur, prev }: OverviewKpisProps) {
  const [dailyCur, dailyPrev, follCur, follPrev] = await Promise.all([
    getDailyTotals(accountId, cur.from, cur.to),
    getDailyTotals(accountId, prev.from, prev.to),
    getFollowerChange(accountId, cur.from, cur.to),
    getFollowerChange(accountId, prev.from, prev.to),
  ]);
  const failed = [dailyCur, dailyPrev, follCur, follPrev].find((r) => !r.ok);
  if (failed && !failed.ok) {
    return (
      <Card>
        <LoadError reason={failed.reason} />
      </Card>
    );
  }
  if (!dailyCur.ok || !dailyPrev.ok || !follCur.ok || !follPrev.ok) return null;

  const dc = dailyCur.data;
  const dp = dailyPrev.data;
  const fc = follCur.data;
  const fp = follPrev.data;

  return (
    <div className="kpis">
      <Kpi
        label={DEF.reach.label}
        hint={DEF.reach.hint}
        value={formatCount(dc.reach.sum)}
        delta={dp.reach.days === 0 ? null : deltaRate(dc.reach.sum, dp.reach.sum)}
        denom={join(
          "日別の合計（期間の重複を除いた人数ではない）",
          coverage(dc.reach, dc.periodDays),
          coverage(dp.reach, dp.periodDays, "前期 "),
        )}
      />
      <Kpi
        label={DEF.views.label}
        hint={DEF.views.hint}
        value={formatCount(dc.views.sum)}
        delta={dp.views.days === 0 ? null : deltaRate(dc.views.sum, dp.views.sum)}
        denom={join(
          `前期 ${formatCount(dp.views.sum)}`,
          coverage(dc.views, dc.periodDays),
          coverage(dp.views, dp.periodDays, "前期 "),
        )}
      />
      <Kpi
        label={DEF.follower_gain.label}
        hint={DEF.follower_gain.hint}
        value={fc.net === null ? EMPTY : formatSignedCount(fc.net)}
        delta={deltaCount(fc.net, fp.net)}
        denom={fc.net === null && fc.firstCapturedOn !== null ? `記録は ${fc.firstCapturedOn} から` : undefined}
      />
      <Kpi
        label={DEF.er.label}
        hint={DEF.er.hint}
        value={formatPercent(dc.er.value, 2)}
        delta={dp.er.used === 0 ? null : deltaPoint(dc.er.value, dp.er.value)}
        denom={join("日別の合計で計算", rateCoverage(dc.er), rateCoverage(dp.er, "前期 "))}
      />
      <Kpi
        label={DEF.save_rate.label}
        hint={DEF.save_rate.hint}
        value={formatPercent(dc.saveRate.value, 2)}
        delta={dp.saveRate.used === 0 ? null : deltaPoint(dc.saveRate.value, dp.saveRate.value)}
        denom={join("日別の合計で計算", rateCoverage(dc.saveRate), rateCoverage(dp.saveRate, "前期 "))}
      />
      <Kpi
        label={DEF.followers.label}
        hint={DEF.followers.hint}
        value={formatCount(fc.latest?.followers_count)}
        denom={fc.latest ? `${fc.latest.captured_on} 時点` : undefined}
      />
    </div>
  );
}
