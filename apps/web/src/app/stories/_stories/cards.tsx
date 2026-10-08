/**
 * ストーリーズのカード（R5 設計 6.3 節、見本 `S.stories`）。計算は `lib/stories.ts`、ここは描画だけ
 */
import { Card } from "@/components/Card";
import { HStack } from "@/components/charts/HStack";
import { Legend } from "@/components/charts/Legend";
import { LineChart } from "@/components/charts/LineChart";
import { heatColor } from "@/components/charts/scale";
import { VBars } from "@/components/charts/VBars";
import { MetricHint } from "@/components/MetricHint";
import { formatCount, formatPercent } from "@/lib/format";
import { STORY_OPS, type StoriesView, type ValueWithN } from "@/lib/stories";
import { STORY_HINTS } from "./StoryTable";

const STORY_COLOR = "var(--chart-4)";

function Metric({ label, hint, value, n }: { label: string; hint: string; value: string; n?: number }) {
  return (
    <div>
      <span style={{ display: "block" }}>
        <MetricHint label={label} text={hint} />
      </span>
      <b>{value}</b>
      {n !== undefined && <span>n = {n}</span>}
    </div>
  );
}

function sumText(v: ValueWithN): string {
  return formatCount(v.value);
}

/** 期間全体の指標（見本の `metrics-row`） */
export function SummaryCard({ view }: { view: StoriesView }) {
  const s = view.summary;
  return (
    <Card>
      <div className="metrics-row" style={{ margin: 0, gridTemplateColumns: "repeat(auto-fit, minmax(9em, 1fr))" }}>
        <Metric label="件数" hint={STORY_HINTS.count} value={`${formatCount(s.count)} 件`} />
        <Metric label="閲覧率の中央値" hint={STORY_HINTS.view_rate} value={formatPercent(s.viewRate.value, 0)} n={s.viewRate.n} />
        <Metric label="離脱率の中央値" hint={STORY_HINTS.exit_rate} value={formatPercent(s.exitRate.value, 1)} n={s.exitRate.n} />
        <Metric label="リンクの合計" hint={STORY_HINTS.link_clicks} value={sumText(s.linkClicks)} n={s.linkClicks.n} />
        <Metric label="返信の合計" hint={STORY_HINTS.replies} value={sumText(s.replies)} n={s.replies.n} />
      </div>
    </Card>
  );
}

/** 閲覧率の推移（全幅）。横軸は投稿の順（古い順） */
export function TrendCard({ view }: { view: StoriesView }) {
  const { trend } = view;
  return (
    <Card title="閲覧率の推移" className="col-12">
      <div className="chart">
        <LineChart
          title="閲覧率の推移"
          labels={trend.labels}
          series={[{ label: "閲覧率", values: trend.values, color: STORY_COLOR, dots: true, pointTips: trend.tips }]}
          format="percent"
          width={760}
          height={180}
          align
        />
      </div>
    </Card>
  );
}

const OPS_SEGMENTS = STORY_OPS.map((o) => ({ label: o.label, color: heatColor(o.heat) }));

/** 操作の内訳（半幅）。直近 10 件の横の 100% 積み上げ棒 */
export function OpsCard({ view }: { view: StoriesView }) {
  return (
    <Card title="操作の内訳（直近 10 件）" className="col-6">
      <Legend items={OPS_SEGMENTS} />
      <div className="chart">
        <HStack title="操作の内訳（直近 10 件）" segments={OPS_SEGMENTS} rows={view.ops} />
      </div>
    </Card>
  );
}

/** 離脱ファネル（半幅）。続けて 2 件以上出したまとまりがあるときだけ棒を描く */
export function FunnelCard({ view }: { view: StoriesView }) {
  const f = view.funnel;
  if (f === null) {
    return (
      <Card title="離脱ファネル" className="col-6">
        <p className="small muted">期間中に、続けて 2 件以上出したストーリーズはありません。</p>
      </Card>
    );
  }
  const title = `離脱ファネル（${f.startLabel} から続けて ${f.count} 件）`;
  return (
    <Card title={title} className="col-6">
      <div className="chart">
        <VBars
          title={title}
          values={f.values}
          labels={f.labels}
          tips={f.tips}
          color={STORY_COLOR}
          format="percent"
          valueLabels="all"
          maxBar={40}
          width={520}
          height={200}
        />
      </div>
    </Card>
  );
}
