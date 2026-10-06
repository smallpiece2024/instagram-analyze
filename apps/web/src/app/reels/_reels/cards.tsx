/**
 * リール分析のカード（R4 設計 6.2 節「カード」）。計算は `lib/reels.ts` の `buildReelsView` で済ませ、ここは描画だけ。
 * 各カードに母集団の件数 n を添える（除いた理由ごとの説明の文言は出さない）
 */
import Link from "next/link";
import { Card } from "@/components/Card";
import { Forest } from "@/components/charts/Forest";
import { Legend } from "@/components/charts/Legend";
import { Scatter } from "@/components/charts/Scatter";
import { VBars } from "@/components/charts/VBars";
import { MetricHint } from "@/components/MetricHint";
import { Thumb } from "@/components/Thumb";
import { formatPercent, formatValue, mediaTitle, type ValueFormat } from "@/lib/format";
import { METRIC_DEFINITIONS } from "@/lib/metric-definitions";
import { kindColor } from "@/lib/metrics";
import {
  FACTORS,
  formatFactor,
  GROUP_FAINT_MIN,
  groupFactorSummary,
  isEdgeCutFactor,
  groupObjectiveMedian,
  OBJECTIVE_LABEL,
  type FactorDef,
  type GroupBar,
  type Objective,
  type ReelRow,
  type ReelsView,
  type ResponseMetric,
  type ScatterPointData,
} from "@/lib/reels";

const COLOR = kindColor("reel");

export function objectiveFormat(y: Objective): ValueFormat {
  return y === "reach_rate" ? "percent" : "count";
}

export function objectiveHint(y: Objective): string {
  if (y === "reach_rate") return METRIC_DEFINITIONS.reach_rate.hint;
  if (y === "reach") return METRIC_DEFINITIONS.reach.hint;
  return METRIC_DEFINITIONS.views.hint;
}

/** 要因の散布図の X の書式 */
function factorAxisFormat(f: FactorDef): ValueFormat {
  return f.unit === "seconds" ? "seconds" : "count";
}

/** 解析済みが 0 件のとき（6.2 節「空のとき」） */
export function NoAnalysis({ title, className = "col-12" }: { title: string; className?: string }) {
  return (
    <Card title={title} className={className}>
      <p>
        <span className="muted">—</span> <Link href="/jobs">収集ログ</Link>
      </p>
    </Card>
  );
}

/* ------------------------------------------------------------------
 * 要因との関係
 * ------------------------------------------------------------------ */

/** 半幅のカード（上位と下位と横に並べる）で描くフォレストの幅 */
const FOREST_WIDTH = 280;

export function CorrelationCard({ view }: { view: ReelsView }) {
  const label = OBJECTIVE_LABEL[view.y];
  const rows = view.correlations.map((c) => {
    const f = FACTORS.find((d) => d.key === c.key) as FactorDef;
    return { key: c.key, label: f.label, hint: f.hint, n: c.n, r: c.r, lo: c.lo, hi: c.hi };
  });
  return (
    <Card
      title={`${label}と結び付いている要因`}
      sub={`n = ${view.analyzedN}`}
      className="col-6"
      foot={`右（+）ほど、その値が大きいリールほど${label}が高い。左（−）ほど、その値が小さいリールほど${label}が高い。線は 95% の幅。`}
    >
      <Legend
        items={[
          { label: "順位相関", color: "var(--color-primary)" },
          { label: "幅が 0 をまたぐ（まだわからない）", color: "var(--chart-axis)" },
        ]}
      />
      <Forest rows={rows} width={FOREST_WIDTH} />
    </Card>
  );
}

/* ------------------------------------------------------------------
 * 上位と下位
 * ------------------------------------------------------------------ */

function Thumbs({ rows, urls, y }: { rows: readonly ReelRow[]; urls: ReadonlyMap<string, string>; y: Objective }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 6, margin: "6px 0 0" }}>
      {rows.map((r) => {
        const title = mediaTitle(r.caption);
        const tip = `${title}（${OBJECTIVE_LABEL[y]} ${formatValue(r[y], objectiveFormat(y))}）`;
        return (
          <Link key={r.media_id} href={`/media/${r.media_id}`} aria-label={tip}>
            <Thumb src={r.thumbnail_path ? (urls.get(r.thumbnail_path) ?? null) : null} kind="reel" />
          </Link>
        );
      })}
    </div>
  );
}

export function TopBottomCard({ view, urls }: { view: ReelsView; urls: ReadonlyMap<string, string> }) {
  const label = OBJECTIVE_LABEL[view.y];
  const tb = view.topBottom;
  if (tb === null) {
    return (
      <Card title={`${label}の上位と下位`} sub={`n = ${view.analyzedN}`} className="col-6">
        <p className="small muted">n = {view.analyzedN}</p>
      </Card>
    );
  }
  const fmt = objectiveFormat(view.y);
  return (
    <Card
      title={`${label}の上位と下位`}
      sub={`n = ${tb.n}`}
      className="col-6"
      foot={'値は各群の中央値。"冒頭 3 秒の画面変化"と"最後 3 秒の画面変化"は 1 回以上のリールの割合。'}
    >
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col" style={{ verticalAlign: "top" }}>
                項目
              </th>
              <th scope="col" className="num" style={{ verticalAlign: "top" }}>
                上位 25%（{tb.q} 件）
                <Thumbs rows={tb.top} urls={urls} y={view.y} />
              </th>
              <th scope="col" className="num" style={{ verticalAlign: "top" }}>
                下位 25%（{tb.q} 件）
                <Thumbs rows={tb.bottom} urls={urls} y={view.y} />
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row" className="row-head">
                <MetricHint label={label} text={objectiveHint(view.y)} />
              </th>
              <td className="num">{formatValue(groupObjectiveMedian(tb.top, view.y), fmt)}</td>
              <td className="num">{formatValue(groupObjectiveMedian(tb.bottom, view.y), fmt)}</td>
            </tr>
            {FACTORS.map((f) => {
              const show = (g: readonly ReelRow[]) => {
                const v = groupFactorSummary(g, f.key);
                return isEdgeCutFactor(f.key) ? (v === null ? "—" : `${formatPercent(v, 0)} が 1 回以上`) : formatFactor(v, f.unit);
              };
              return (
                <tr key={f.key}>
                  <th scope="row" className="row-head">
                    <MetricHint label={f.label} text={f.hint} />
                  </th>
                  <td className="num">{show(tb.top)}</td>
                  <td className="num">{show(tb.bottom)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------
 * 散布図
 * ------------------------------------------------------------------ */

function points(
  data: readonly ScatterPointData[],
  xLabel: string,
  xText: (v: number) => string,
  y: Objective,
): { x: number; y: number; tip: string; href: string }[] {
  return data.map((p) => ({
    x: p.x,
    y: p.y,
    tip: `${mediaTitle(p.caption)}（${xLabel} ${xText(p.x)}、${OBJECTIVE_LABEL[y]} ${formatValue(p.y, objectiveFormat(y))}）`,
    href: `/media/${p.media_id}`,
  }));
}

function ScatterCell({
  label,
  hint,
  pts,
  xFormat,
  y,
  refY,
  className,
  width,
}: {
  label: string;
  hint: string;
  pts: ReturnType<typeof points>;
  xFormat: ValueFormat;
  y: Objective;
  refY: number | null;
  className: string;
  width: number;
}) {
  const title = `${label}と${OBJECTIVE_LABEL[y]}`;
  const common = { title, points: pts, xFormat, yFormat: objectiveFormat(y), color: COLOR, refY };
  return (
    <div className={`${className} scatter-cell`}>
      <div className="small muted">
        <MetricHint label={label} text={hint} />
      </div>
      <div className="chart only-d">
        <Scatter {...common} width={width} height={190} />
      </div>
      <div className="chart only-m">
        <Scatter {...common} width={170} height={150} />
      </div>
    </div>
  );
}

export function FactorScatterCard({ view }: { view: ReelsView }) {
  const label = OBJECTIVE_LABEL[view.y];
  return (
    <Card
      title={`数値の要因と${label}`}
      sub={`n = ${view.analyzedN}`}
      className="col-12"
      foot={`点線は${label}の中央値。点を押すと投稿詳細を開く。`}
    >
      <div className="grid">
        {view.factorScatter.map((s) => {
          const f = FACTORS.find((d) => d.key === s.key) as FactorDef;
          return (
            <ScatterCell
              key={s.key}
              label={f.label}
              hint={f.hint}
              pts={points(s.points, f.label, (v) => formatFactor(v, f.unit), view.y)}
              xFormat={factorAxisFormat(f)}
              y={view.y}
              refY={view.analyzedMedian}
              className="col-4"
              width={360}
            />
          );
        })}
      </div>
    </Card>
  );
}

const RESPONSE_LABEL: Record<ResponseMetric, { label: string; hint: string }> = {
  retention_rate: METRIC_DEFINITIONS.retention_rate,
  skip_rate: METRIC_DEFINITIONS.skip_rate,
  share_rate: METRIC_DEFINITIONS.share_rate,
  save_rate: METRIC_DEFINITIONS.save_rate,
};

export function ResponseScatterCard({ view }: { view: ReelsView }) {
  const label = OBJECTIVE_LABEL[view.y];
  return (
    <Card
      title={`視聴と反応の指標と${label}`}
      sub={`n = ${view.objectiveN}`}
      className="col-12"
      foot={`点線は${label}の中央値。視聴維持率は 100% を超えることがある（繰り返し再生）。`}
    >
      <div className="grid">
        {view.responseScatter.map((s) => {
          const d = RESPONSE_LABEL[s.key];
          return (
            <ScatterCell
              key={s.key}
              label={d.label}
              hint={d.hint}
              pts={points(s.points, d.label, (v) => formatPercent(v), view.y)}
              xFormat="percent"
              y={view.y}
              refY={view.objectiveMedian}
              className="col-3"
              width={270}
            />
          );
        })}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------
 * 区分
 * ------------------------------------------------------------------ */

/** 区分の棒グラフの viewBox の幅。PC の 3 等分と 2 等分のマス、スマートフォンの全幅（文字の大きさをそろえるため） */
const GROUP_WIDTH_THIRD = 380;
const GROUP_WIDTH_HALF = 580;
const GROUP_WIDTH_MOBILE = 340;

function GroupCell({
  label,
  bars,
  y,
  className,
}: {
  label: string;
  bars: readonly GroupBar[];
  y: Objective;
  className: string;
}) {
  const fmt = objectiveFormat(y);
  const common = {
    title: `${label}ごとの${OBJECTIVE_LABEL[y]}の中央値`,
    values: bars.map((b) => b.value),
    labels: bars.map((b) => b.label),
    nLabels: bars.map((b) => b.n),
    dim: bars.flatMap((b, i) => (b.n < GROUP_FAINT_MIN ? [i] : [])),
    tips: bars.map((b) => `${b.label}: ${formatValue(b.value, fmt)}（n=${b.n}）`),
    valueLabels: "all" as const,
    color: COLOR,
    format: fmt,
    height: 180,
    noAxis: true,
  };
  // 図はマスの幅に近い大きさで描き、それより大きくは拡大しない（拡大すると、幅の違うマスで文字の大きさがそろわない）
  const width = className === "col-6" ? GROUP_WIDTH_HALF : GROUP_WIDTH_THIRD;
  return (
    <div className={className}>
      <p className="small muted">{label}</p>
      <div className="chart only-d" style={{ maxWidth: width }}>
        <VBars {...common} width={width} />
      </div>
      <div className="chart only-m">
        <VBars {...common} width={GROUP_WIDTH_MOBILE} />
      </div>
    </div>
  );
}

export function GroupsCard({ view, analyzed }: { view: ReelsView; analyzed: boolean }) {
  const label = OBJECTIVE_LABEL[view.y];
  return (
    <Card
      title={`グループ別${label}`}
      className="col-12"
      foot={`棒は${label}の中央値。n は件数で、3 件未満のグループは薄く表示する。曜日と時間帯は日本時間（朝は 11 時より前、昼は 11〜17 時、夜は 17 時以降）。`}
    >
      <div className="grid">
        {analyzed ? (
          <>
            <GroupCell label="動画の長さ" bars={view.groups.length} y={view.y} className="col-4" />
            <GroupCell label="冒頭 3 秒の画面変化" bars={view.groups.first3s} y={view.y} className="col-4" />
            <GroupCell label="最後 3 秒の画面変化" bars={view.groups.last3s} y={view.y} className="col-4" />
          </>
        ) : (
          <div className="col-6">
            <p>
              <span className="muted">—</span> <Link href="/jobs">収集ログ</Link>
            </p>
          </div>
        )}
        <GroupCell label="投稿の曜日" bars={view.groups.day} y={view.y} className="col-6" />
        <GroupCell label="投稿の時間帯" bars={view.groups.band} y={view.y} className="col-6" />
      </div>
    </Card>
  );
}
