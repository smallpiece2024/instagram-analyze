import { formatAxis, formatValue, type ValueFormat } from "@/lib/format";
import { coord, dimRuns, finiteValues, labelStep, segments, ticks, yDomain } from "./scale";

/** 件数が少ない区分を薄く描くときの不透明度（`BandRow` と同じ） */
const DIM_OPACITY = ".45";

export interface LineSeries {
  label: string;
  values: readonly (number | null)[];
  /** 線の色（`var(--chart-1)` など）。`dashed` の系列で省略すると `--chart-ref` の破線 */
  color?: string;
  dashed?: boolean;
  /** 点（8px）を描く */
  dots?: boolean;
  /** 線の右端に書くラベル（直接ラベル） */
  endLabel?: string;
  /**
   * 点ごとのヒント（`<title>`）。省略時は「系列名 ラベル: 値」。`dots` がない系列では、ヒントを付けるための
   * 透明な点を置く
   */
  pointTips?: readonly (string | null | undefined)[];
  /** 薄く描く index（件数が少ない区分）。その点と、その点につながる線を薄くする */
  dimIndexes?: readonly number[];
}

export interface LineChartProps {
  /** グラフの説明（`aria-label`） */
  title: string;
  labels: readonly string[];
  /**
   * X 軸のラベルの 2 段目（期間比較の B の日付など）。あれば `labels` を 1 段目、これを 2 段目に描く。
   * 空文字の位置にはラベルを出さない
   */
  labels2?: readonly string[];
  /** 2 段のラベルの行の頭に太字で書く名前（`["A", "B"]` など）。`labels2` があるときだけ使う */
  rowNames?: readonly [string, string];
  /** 2 段のラベルの文字の色（1 段目、2 段目）。`labels2` があるときだけ使う */
  rowColors?: readonly [string, string];
  series: readonly LineSeries[];
  /** 帯（25〜75% など）。下側と上側。どちらかが null の点は帯を切る */
  band?: {
    lower: readonly (number | null)[];
    upper: readonly (number | null)[];
    label: string;
    /** 薄く描く index（件数が少ない区分） */
    dimIndexes?: readonly number[];
  };
  /** X 軸の下に ▲ を置く index（投稿の印）。`markerTips` はその印のヒント */
  markers?: readonly number[];
  markerTips?: readonly string[];
  /** 縦の破線とラベル（指標変更の日など） */
  refLines?: readonly { index: number; label: string }[];
  format?: ValueFormat;
  width?: number;
  height?: number;
  min?: number;
  max?: number;
  /** 棒グラフと X を揃える（各点を区間の中央に置く） */
  align?: boolean;
}

/** 折れ線（見本の `lineChart`）。null の点は描かず、線もそこで切る */
export function LineChart({
  title,
  labels,
  labels2,
  rowNames,
  rowColors,
  series,
  band,
  markers,
  markerTips,
  refLines,
  format = "count",
  width = 760,
  height = 200,
  min,
  max,
  align,
}: LineChartProps) {
  const m = { t: 16, r: align ? 8 : 14, b: labels2 ? 42 : 26, l: 44 };
  const iw = Math.max(1, width - m.l - m.r);
  const ih = Math.max(1, height - m.t - m.b);
  const all = finiteValues([...series.flatMap((s) => s.values), ...(band ? band.upper : [])]);
  const dom = yDomain(all, { min, max });
  const n = labels.length;
  const x = align
    ? (i: number) => m.l + (iw / Math.max(1, n)) * i + iw / Math.max(1, n) / 2
    : (i: number) => m.l + (n > 1 ? (iw * i) / (n - 1) : iw / 2);
  const y = (v: number) => m.t + ih - (ih * (v - dom.min)) / (dom.max - dom.min);
  const step = labelStep(n, iw, align ? 44 : 56);
  const tickValues = ticks(dom.min, dom.max, 4);
  // X 軸のラベルの段。2 段のときは 1 段目を上に、2 段目を下に置く。
  // 色は style で付ける（`.chart-axis text` の CSS の fill は、SVG の fill 属性より強い）
  const axisRows: { labels: readonly string[]; y: number; name?: string; color?: string }[] = labels2
    ? [
        { labels, y: height - 22, name: rowNames?.[0], color: rowColors?.[0] },
        { labels: labels2, y: height - 6, name: rowNames?.[1], color: rowColors?.[1] },
      ]
    : [{ labels, y: height - 6 }];

  const bandDim = new Set(band?.dimIndexes ?? []);
  const bandPolys = band
    ? segments(
        labels.map((_, i) => {
          const lo = band.lower[i];
          const up = band.upper[i];
          return typeof lo === "number" && Number.isFinite(lo) && typeof up === "number" && Number.isFinite(up)
            ? { i, lo, up }
            : null;
        }),
      )
    : [];

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={title}
    >
      <g className="chart-grid">
        {tickValues.map((t) => (
          <line key={t} x1={m.l} x2={width - m.r} y1={coord(y(t))} y2={coord(y(t))} />
        ))}
      </g>
      <g className="chart-axis">
        {tickValues.map((t) => (
          <text key={t} x={m.l - 6} y={coord(y(t) + 4)} textAnchor="end">
            {formatAxis(t, format)}
          </text>
        ))}
        {axisRows.map((row, r) => {
          const style = row.color ? { fill: row.color } : undefined;
          return (
            <g key={r}>
              {/* 行の名前は左端に置く（最初のラベルは x = m.l を中心に描くので、m.l の近くに置くと重なる） */}
              {row.name && (
                <text x={m.l - 18} y={row.y} textAnchor="end" fontWeight="700" style={style}>
                  {row.name}
                </text>
              )}
              {row.labels.map((l, i) =>
                l !== "" && (i % step === 0 || (!align && n <= 8 && i === n - 1)) ? (
                  <text key={i} x={coord(x(i))} y={row.y} textAnchor="middle" style={style}>
                    {l}
                  </text>
                ) : null,
              )}
            </g>
          );
        })}
      </g>
      {(markers ?? []).map((i, k) => (
        <g key={`m${i}`}>
          <line className="chart-marker" x1={coord(x(i))} x2={coord(x(i))} y1={m.t} y2={m.t + ih} />
          <path d={`M${coord(x(i))} ${m.t + ih + 2}l-3 5h6z`} fill="var(--chart-marker)">
            {markerTips?.[k] && <title>{markerTips[k]}</title>}
          </path>
        </g>
      ))}
      {(refLines ?? []).map((r) => (
        <g key={`r${r.index}`}>
          <line className="chart-ref" x1={coord(x(r.index))} x2={coord(x(r.index))} y1={m.t} y2={m.t + ih} />
          <text className="chart-label chart-label--muted" x={coord(x(r.index) + 4)} y={m.t + 10}>
            {r.label}
          </text>
        </g>
      ))}
      {bandPolys.flatMap((seg) =>
        dimRuns(seg.items, bandDim).map((run) => {
          const up = run.items.map((p) => `${coord(x(p.i))},${coord(y(p.up))}`);
          const lo = run.items.map((p) => `${coord(x(p.i))},${coord(y(p.lo))}`).reverse();
          return (
            <polygon
              key={`b${run.items[0]?.i ?? seg.start}`}
              className="chart-band"
              points={[...up, ...lo].join(" ")}
              opacity={run.dim ? DIM_OPACITY : undefined}
            >
              <title>{band?.label ?? ""}</title>
            </polygon>
          );
        }),
      )}
      {series.map((se, si) => {
        const dim = new Set(se.dimIndexes ?? []);
        const pts = se.values.map((v, i) => (typeof v === "number" && Number.isFinite(v) ? { i, v } : null));
        const runs = segments(pts).flatMap((seg) => dimRuns(seg.items, dim));
        const lineClass = se.dashed ? "chart-ref" : "chart-line";
        // 破線の系列も `color` があればその色（ないときは `.chart-ref` の色）
        const lineStyle = se.color ? { stroke: se.color } : undefined;
        const present = pts.filter((p): p is { i: number; v: number } => p !== null);
        const last = present[present.length - 1];
        const tipOf = (p: { i: number; v: number }) =>
          se.pointTips?.[p.i] ?? `${se.label} ${labels[p.i] ?? ""}: ${formatValue(p.v, format)}`;
        return (
          <g key={si}>
            {[false, true].map((isDim) => {
              const d = runs
                .filter((run) => run.dim === isDim)
                .map((run) => run.items.map((p, k) => `${k ? "L" : "M"}${coord(x(p.i))} ${coord(y(p.v))}`).join(""))
                .join("");
              return d ? (
                <path
                  key={isDim ? "dim" : "line"}
                  className={lineClass}
                  d={d}
                  style={lineStyle}
                  opacity={isDim ? DIM_OPACITY : undefined}
                >
                  <title>{se.label}</title>
                </path>
              ) : null;
            })}
            {se.dots &&
              present.map((p) => (
                <circle
                  key={p.i}
                  className="chart-dot"
                  cx={coord(x(p.i))}
                  cy={coord(y(p.v))}
                  r="4"
                  fill={se.color}
                  opacity={dim.has(p.i) ? DIM_OPACITY : undefined}
                >
                  <title>{tipOf(p)}</title>
                </circle>
              ))}
            {!se.dots &&
              se.pointTips &&
              present.map((p) => (
                <circle key={p.i} data-part="tip" cx={coord(x(p.i))} cy={coord(y(p.v))} r="5" fill="transparent">
                  <title>{tipOf(p)}</title>
                </circle>
              ))}
            {se.endLabel && last && (
              <text className="chart-label chart-label--b" x={coord(x(last.i) - 2)} y={coord(y(last.v) - 8)} textAnchor="end">
                {se.endLabel}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
