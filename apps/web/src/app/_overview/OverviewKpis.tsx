import { Card } from "@/components/Card";
import { Kpi } from "@/components/Kpi";
import { EMPTY, formatCount, formatPercent, formatSignedCount } from "@/lib/format";
import { deltaCount, deltaPoint, deltaRate } from "@/lib/metrics";
import type { Period } from "@/lib/period";
import { getDailyTotals, getFollowerChange, getPostTotals, type DailySum } from "@/lib/queries/period-summary";
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

function join(...parts: (string | null | undefined)[]): string {
  return parts.filter((p): p is string => typeof p === "string" && p !== "").join("・");
}

/** 数字タイル 6 枚（3.2 節「数字タイル」）。読み出しに失敗したら、タイルの代わりにカードの中で理由を出す */
export async function OverviewKpis({ accountId, cur, prev }: OverviewKpisProps) {
  const [dailyCur, dailyPrev, follCur, follPrev, postsCur, postsPrev] = await Promise.all([
    getDailyTotals(accountId, cur.from, cur.to),
    getDailyTotals(accountId, prev.from, prev.to),
    getFollowerChange(accountId, cur.from, cur.to),
    getFollowerChange(accountId, prev.from, prev.to),
    getPostTotals(accountId, cur.from, cur.to),
    getPostTotals(accountId, prev.from, prev.to),
  ]);
  const failed = [dailyCur, dailyPrev, follCur, follPrev, postsCur, postsPrev].find((r) => !r.ok);
  if (failed && !failed.ok) {
    return (
      <Card>
        <LoadError reason={failed.reason} />
      </Card>
    );
  }
  if (!dailyCur.ok || !dailyPrev.ok || !follCur.ok || !follPrev.ok || !postsCur.ok || !postsPrev.ok) return null;

  const dc = dailyCur.data;
  const dp = dailyPrev.data;
  const fc = follCur.data;
  const fp = follPrev.data;
  const pc = postsCur.data;
  const pp = postsPrev.data;
  const noPosts = pc.posts === 0;
  const noPrevPosts = pp.posts === 0;

  // ER（分母はリーチに固定）
  const erCur = pc.er;
  const erPrev = pp.er;

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
        denom={join(
          `現在 ${formatCount(fc.latest?.followers_count)}・日本時間の記録`,
          fc.net === null && fc.firstCapturedOn !== null ? `記録は ${fc.firstCapturedOn} から` : null,
        )}
      />
      <Kpi
        label={DEF.er.label}
        hint={DEF.er.hint}
        value={noPosts ? EMPTY : formatPercent(erCur.value, 2)}
        delta={noPrevPosts ? null : deltaPoint(erCur.value, erPrev.value)}
        denom={noPosts ? "期間中の投稿なし" : join("分母: リーチ", `期間中の投稿 ${erCur.total} 件中 ${erCur.used} 件で計算`)}
      />
      <Kpi
        label={DEF.save_rate.label}
        hint={DEF.save_rate.hint}
        value={noPosts ? EMPTY : formatPercent(pc.saveRate.value, 2)}
        delta={noPrevPosts ? null : deltaPoint(pc.saveRate.value, pp.saveRate.value)}
        denom={
          noPosts
            ? "期間中の投稿なし"
            : join("分母: リーチ", `${pc.saveRate.total} 件中 ${pc.saveRate.used} 件`, "目安 2〜3%")
        }
      />
      <Kpi
        label={DEF.profile_visits.label}
        hint={DEF.profile_visits.hint}
        value={noPosts ? EMPTY : formatCount(pc.profileVisits.sum)}
        delta={noPrevPosts ? null : deltaRate(pc.profileVisits.sum, pp.profileVisits.sum)}
        denom={noPosts ? "期間中の投稿なし" : "フィード（カルーセルを含む）の投稿単位の合計。リールとアカウント全体は含まない"}
      />
    </div>
  );
}
