import { LoadError } from "@/app/_overview/states";
import { Card } from "@/components/Card";
import { HBars } from "@/components/charts/HBars";
import { MetricHint } from "@/components/MetricHint";
import { EMPTY, formatCount, formatPercent } from "@/lib/format";
import { ACCOUNT_METRIC_DEFINITIONS as DEF } from "@/lib/metric-definitions";
import type { Period } from "@/lib/period";
import { getMonthFunnel } from "@/lib/queries/report";
import { funnelStages, type FunnelStage } from "@/lib/report";
import { SECTION_TITLES } from "./titles";

const TITLE = SECTION_TITLES.funnel;

function pct(v: number | null) {
  return v === null ? <span className="muted">{EMPTY}</span> : formatPercent(v, 1);
}

/**
 * 1 組のファネル。横棒（`share` は 1 段目に対する割合）と、棒の下の小さな表（段、値、前段比、1 段目比、件数。U16）。
 * `sequential` が偽（ストーリーズ）なら、2 段目以降はどれも 1 段目に対する割合なので前段比の列を出さない
 */
function FunnelBlock({ label, hint, stages, sequential }: { label: string; hint: string; stages: readonly FunnelStage[]; sequential: boolean }) {
  return (
    <section aria-label={label}>
      <p className="small muted">
        <MetricHint label={label} text={hint} />
      </p>
      <div className="chart">
        <HBars
          title={`${label}の横棒グラフ`}
          rows={stages.map((s) => ({ label: s.label, value: s.value, share: s.shareOfFirst }))}
          labelWidth={120}
        />
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">段</th>
              <th scope="col" className="num">
                値
              </th>
              {sequential && (
                <th scope="col" className="num">
                  前段比
                </th>
              )}
              <th scope="col" className="num">
                1 段目比
              </th>
              <th scope="col" className="num">
                件数
              </th>
            </tr>
          </thead>
          <tbody>
            {stages.map((s) => (
              <tr key={s.label}>
                <td>{s.label}</td>
                <td className="num">{formatCount(s.value)}</td>
                {sequential && <td className="num">{pct(s.stepRate)}</td>}
                <td className="num">{pct(s.shareOfFirst)}</td>
                <td className="num">
                  {s.used}/{s.total} 件
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * 8 節: 2 組のファネル（R6 設計 6.1 節、T16）。
 * 投稿（フィードとカルーセル）: Σリーチ → Σプロフィール訪問 → Σフォロー（3 つがそろう投稿だけ。Σリーチは 5 節の数と違う）。
 * ストーリーズ: Σ閲覧数 → Σ離脱と Σ次へ（どちらも閲覧数に対する割合）。アカウント単位の値が API にないための近似（`MetricHint` の説明）
 */
export async function FunnelCard({ accountId, period }: { accountId: string; period: Period }) {
  const r = await getMonthFunnel(accountId, period.from, period.to);
  if (!r.ok) {
    return (
      <Card title={TITLE}>
        <LoadError reason={r.reason} />
      </Card>
    );
  }
  const { posts, stories } = r.data;
  const postStages = funnelStages([
    { label: "リーチ数", sum: posts.reach },
    { label: "プロフィール訪問", sum: posts.profileVisits },
    { label: "フォロー", sum: posts.follows },
  ]);
  const storyStages = funnelStages([
    { label: "閲覧数", sum: stories.views },
    { label: "離脱", sum: stories.tapExit },
    { label: "次へ", sum: stories.swipeForward },
  ]);
  return (
    <Card
      title={TITLE}
      foot={<>投稿は日本時間の投稿日で {period.from} 〜 {period.to}・件数は「全件のうち 3 つの値がそろう件数」・投稿ごとの値の合計による近似</>}
    >
      <div className="stack">
        <FunnelBlock label={DEF.post_funnel.label} hint={DEF.post_funnel.hint} stages={postStages} sequential />
        <FunnelBlock label={DEF.story_funnel.label} hint={DEF.story_funnel.hint} stages={storyStages} sequential={false} />
      </div>
    </Card>
  );
}
