import { formatAxis, formatValue, type ValueFormat } from "@/lib/format";
import { coord, finiteValues, labelStep, segments, ticks, yDomain } from "./scale";

export interface LineSeries {
  label: string;
  values: readonly (number | null)[];
  /** 線の色（`var(--chart-1)` など）。`dashed` の系列は `--chart-ref` の破線 */
  color?: string;
  dashed?: boolean;
  /** 点（8px）を描く */
  dots?: boolean;
  /** 線の右端に書くラベル（直接ラベル） */
  endLabel?: string;
}

export interface LineChartProps {
  /** グラフの説明（`aria-label`） */
  title: string;
  labels: readonly string[];
  series: readonly LineSeries[];
  /** 帯（25〜75% など）。下側と上側。どちらかが null の点は帯を切る */
  band?: { lower: readonly (number | null)[]; upper: readonly (number | null)[]; label: string };
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
  const m = { t: 16, r: align ? 8 : 14, b: 26, l: 44 };
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
        {labels.map((l, i) =>
          i % step === 0 || (!align && n <= 8 && i === n - 1) ? (
            <text key={i} x={coord(x(i))} y={height - 6} textAnchor="middle">
              {l}
            </text>
          ) : null,
        )}
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
      {bandPolys.map((seg) => {
        const up = seg.items.map((p) => `${coord(x(p.i))},${coord(y(p.up))}`);
        const lo = seg.items.map((p) => `${coord(x(p.i))},${coord(y(p.lo))}`).reverse();
        return (
          <polygon key={`b${seg.start}`} className="chart-band" points={[...up, ...lo].join(" ")}>
            <title>{band?.label ?? ""}</title>
          </polygon>
        );
      })}
      {series.map((se, si) => {
        const pts = se.values.map((v, i) => (typeof v === "number" && Number.isFinite(v) ? { i, v } : null));
        const segs = segments(pts);
        const d = segs
          .map((seg) => seg.items.map((p, k) => `${k ? "L" : "M"}${coord(x(p.i))} ${coord(y(p.v))}`).join(""))
          .join("");
        const present = pts.filter((p): p is { i: number; v: number } => p !== null);
        const last = present[present.length - 1];
        return (
          <g key={si}>
            {d && (
              <path className={se.dashed ? "chart-ref" : "chart-line"} d={d} style={se.dashed ? undefined : { stroke: se.color }}>
                <title>{se.label}</title>
              </path>
            )}
            {se.dots &&
              present.map((p) => (
                <circle key={p.i} className="chart-dot" cx={coord(x(p.i))} cy={coord(y(p.v))} r="4" fill={se.color}>
                  <title>{`${se.label} ${labels[p.i] ?? ""}: ${formatValue(p.v, format)}`}</title>
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
