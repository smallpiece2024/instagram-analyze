/**
 * 投稿時刻のカード（R5 設計 6.5 節、見本 `render.js` の `S.timing`）。計算は `lib/timing.ts` の `buildTimingView` で済ませ、ここは描画だけ。
 * 見本は文字列で SVG を組み立てているが、ここは JSX の子と属性で出す（S11）
 */
import { Card } from "@/components/Card";
import { Heatmap, HeatmapLegend } from "@/components/charts/Heatmap";
import { Legend } from "@/components/charts/Legend";
import { Strip, stripDomain, type StripPoint } from "@/components/charts/Strip";
import { VBars } from "@/components/charts/VBars";
import { formatJst, formatValue } from "@/lib/format";
import { kindColor } from "@/lib/metrics";
import {
  BAND_LABELS,
  DAY_LABELS,
  faintIndexes,
  TIMING_METRIC_LABEL,
  type TimingView,
  type TopCombination,
} from "@/lib/timing";

const COLOR = "var(--heat)";
const HEAT_WIDTH = 760;
const HEAT_WIDTH_MOBILE = 360;
const BARS_WIDTH = 580;
const BARS_WIDTH_MOBILE = 340;
const STRIP_WIDTH = 420;
const STRIP_COLOR = kindColor("reel");

/** 見出しで「の」の後ろに続けるとき、数字で始まる指標の名前の前に空白を入れる（「時間帯の 24 時間リーチ」「時間帯の最新のリーチ」） */
export function spaced(label: string): string {
  return /^\d/.test(label) ? ` ${label}` : label;
}

/** 対象が 0 件のとき、全カードの代わりに出す（文言は足さない。件数は選択の文言で分かる） */
export function NoTiming() {
  return (
    <Card className="col-12">
      <p className="muted">—</p>
    </Card>
  );
}

export function HeatCard({ view }: { view: TimingView }) {
  const label = TIMING_METRIC_LABEL[view.m];
  const common = {
    title: `曜日 × 時間帯の${spaced(label)}（中央値）`,
    rows: DAY_LABELS,
    cols: BAND_LABELS,
    values: view.heat.median,
    counts: view.heat.n,
    colSuffix: " 時",
  };
  return (
    <Card
      title={`曜日 × 時間帯の${spaced(label)}（中央値）`}
      className="col-12"
      foot="※: n=1"
    >
      <HeatmapLegend values={view.heat.median} counts={view.heat.n} />
      <div className="chart only-d" style={{ maxWidth: HEAT_WIDTH }}>
        <Heatmap {...common} width={HEAT_WIDTH} />
      </div>
      <div className="chart only-m">
        <Heatmap {...common} width={HEAT_WIDTH_MOBILE} />
      </div>
    </Card>
  );
}

function BarsCard({
  title,
  labels,
  median,
  n,
  suffix,
}: {
  title: string;
  labels: readonly string[];
  median: readonly (number | null)[];
  n: readonly number[];
  suffix: string;
}) {
  const common = {
    title,
    values: median,
    labels,
    nLabels: n,
    dim: faintIndexes(n),
    tips: labels.map((l, i) => `${l}${suffix}: ${formatValue(median[i] ?? null, "count")}（n=${n[i] ?? 0}）`),
    valueLabels: "all" as const,
    color: COLOR,
    height: 220,
    noAxis: true,
  };
  return (
    <Card title={title} className="col-6">
      <div className="chart only-d" style={{ maxWidth: BARS_WIDTH }}>
        <VBars {...common} width={BARS_WIDTH} />
      </div>
      <div className="chart only-m">
        <VBars {...common} width={BARS_WIDTH_MOBILE} />
      </div>
    </Card>
  );
}

export function BandCard({ view }: { view: TimingView }) {
  return (
    <BarsCard
      title={`時間帯別の${spaced(TIMING_METRIC_LABEL[view.m])}（中央値）`}
      labels={BAND_LABELS}
      median={view.byBand.median}
      n={view.byBand.n}
      suffix=" 時"
    />
  );
}

export function DayCard({ view }: { view: TimingView }) {
  return (
    <BarsCard
      title={`曜日別の${spaced(TIMING_METRIC_LABEL[view.m])}（中央値）`}
      labels={DAY_LABELS}
      median={view.byDay.median}
      n={view.byDay.n}
      suffix=""
    />
  );
}

function comboLabel(c: Pick<TopCombination, "day" | "band">): string {
  return `${DAY_LABELS[c.day] ?? ""} ${BAND_LABELS[c.band] ?? ""} 時`;
}

/** 帯グラフの点（投稿詳細へのリンク。ヒントは投稿日時と値だけ） */
export function comboPoints(c: TopCombination): StripPoint[] {
  return c.points.map((p) => ({
    value: p.value,
    href: `/media/${encodeURIComponent(p.media_id)}`,
    tip: `${formatJst(p.posted_at)}: ${formatValue(p.value, "count")}`,
  }));
}

export function TopCard({ view }: { view: TimingView }) {
  const label = TIMING_METRIC_LABEL[view.m];
  const rows = view.top.map((c) => ({ c, points: comboPoints(c) }));
  const domain = stripDomain(
    rows.map((r) => r.points),
    view.overallMedian,
  );
  return (
    <Card title="上位の組み合わせ" sub="件数 1 件の組み合わせは除く" className="col-12">
      <Legend
        items={[
          { label: "投稿", color: STRIP_COLOR },
          { label: "組み合わせの中央値", shape: "dash" },
          { label: "25〜75% の範囲", color: "color-mix(in oklab, #3aa6dd 22%, var(--color-surface))" },
          { label: `全投稿の中央値（${formatValue(view.overallMedian, "count")}）`, color: "var(--color-text-muted)" },
        ]}
      />
      {rows.length === 0 ? (
        <p className="muted">—</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>曜日</th>
                <th>時間帯</th>
                <th className="num">中央値</th>
                <th className="num">件数</th>
                <th>投稿ごとの{spaced(label)}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ c, points }) => (
                <tr key={`${c.day}-${c.band}`}>
                  <td>{DAY_LABELS[c.day]}</td>
                  <td>{BAND_LABELS[c.band]} 時</td>
                  <td className="num">{formatValue(c.median, "count")}</td>
                  <td className="num">{c.n}</td>
                  <td>
                    <Strip
                      label={comboLabel(c)}
                      points={points}
                      domain={domain}
                      overall={view.overallMedian}
                      width={STRIP_WIDTH}
                      color={STRIP_COLOR}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
