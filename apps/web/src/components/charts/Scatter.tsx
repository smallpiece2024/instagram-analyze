import { formatAxis, type ValueFormat } from "@/lib/format";
import { coord, finiteValues, MARKER_HIT } from "./scale";

export interface ScatterPoint {
  x: number;
  y: number;
  /** 点のヒント（`<title>` と `aria-label`） */
  tip: string;
  /** 点のリンク（投稿詳細） */
  href?: string;
}

export interface ScatterProps {
  /** グラフの説明（`aria-label`） */
  title: string;
  points: readonly ScatterPoint[];
  xFormat?: ValueFormat;
  yFormat?: ValueFormat;
  color?: string;
  /** 横の破線（目的変数の中央値など） */
  refY?: number | null;
  width?: number;
  height?: number;
}

/** 目盛の間隔（1、2、2.5、5 × 10 のべき） */
export function niceStep(v: number): number {
  if (!(v > 0) || !Number.isFinite(v)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / p;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * p;
}

/**
 * 軸の範囲と目盛をデータから決める（下端を 0 に固定しない。上限も固定しない）。
 * 値がない、1 個、全部同じ値でも幅を持たせ、`NaN` を出さない
 */
export function scatterDomain(values: readonly number[], count = 4): { min: number; max: number; ticks: number[] } {
  const v = finiteValues(values);
  let lo = v.length ? Math.min(...v) : 0;
  let hi = v.length ? Math.max(...v) : 1;
  if (!(hi > lo)) {
    const pad = Math.abs(lo) > 0 ? Math.abs(lo) * 0.1 : 1;
    lo -= pad;
    hi += pad;
  }
  const step = niceStep((hi - lo) / count);
  const min = Math.floor(lo / step) * step;
  let max = Math.ceil(hi / step) * step;
  if (!(max > min)) max = min + step;
  const ticks: number[] = [];
  // 浮動小数の誤差で端が抜けないように、間隔の半分の余裕を持たせる
  for (let t = min; t <= max + step / 2; t += step) ticks.push(Math.round(t / step) * step);
  return { min, max, ticks };
}

/**
 * 散布図（見本の `scatter`。R4 設計 6.2 節）。点は投稿詳細へのリンク。
 * 当たり判定は R3 の `MARKER_HIT` 相当の透明な円。値は `<title>` と `aria-label` で持つ
 */
export function Scatter({
  title,
  points,
  xFormat = "count",
  yFormat = "count",
  color = "var(--chart-3)",
  refY,
  width = 360,
  height = 200,
}: ScatterProps) {
  const m = { t: 10, r: 12, b: 22, l: 44 };
  const iw = Math.max(1, width - m.l - m.r);
  const ih = Math.max(1, height - m.t - m.b);
  const xd = scatterDomain(points.map((p) => p.x));
  const yd = scatterDomain([...points.map((p) => p.y), ...(typeof refY === "number" && Number.isFinite(refY) ? [refY] : [])]);
  const x = (v: number) => m.l + (iw * (v - xd.min)) / (xd.max - xd.min);
  const y = (v: number) => m.t + ih - (ih * (v - yd.min)) / (yd.max - yd.min);
  const aria = `${title}（${points.length} 件）`;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={aria}
    >
      <title>{aria}</title>
      <g className="chart-grid">
        {xd.ticks.map((t) => (
          <line key={`x${t}`} x1={coord(x(t))} x2={coord(x(t))} y1={m.t} y2={m.t + ih} />
        ))}
        {yd.ticks.map((t) => (
          <line key={`y${t}`} x1={m.l} x2={width - m.r} y1={coord(y(t))} y2={coord(y(t))} />
        ))}
      </g>
      <g className="chart-axis">
        {xd.ticks.map((t) => (
          <text key={`x${t}`} x={coord(x(t))} y={m.t + ih + 14} textAnchor="middle">
            {formatAxis(t, xFormat)}
          </text>
        ))}
        {yd.ticks.map((t) => (
          <text key={`y${t}`} x={m.l - 6} y={coord(y(t) + 4)} textAnchor="end">
            {formatAxis(t, yFormat)}
          </text>
        ))}
      </g>
      {typeof refY === "number" && Number.isFinite(refY) && (
        <line className="chart-ref" data-part="ref" x1={m.l} x2={width - m.r} y1={coord(y(refY))} y2={coord(y(refY))} />
      )}
      {points.map((p, i) => {
        const cx = coord(x(p.x));
        const cy = coord(y(p.y));
        const dot = (
          <>
            <circle className="chart-dot" data-part="point" cx={cx} cy={cy} r="4" fill={color} opacity=".85" />
            <circle cx={cx} cy={cy} r={MARKER_HIT / 2} fill="transparent" aria-label={p.tip}>
              <title>{p.tip}</title>
            </circle>
          </>
        );
        return p.href ? (
          <a key={i} href={p.href} aria-label={p.tip}>
            {dot}
          </a>
        ) : (
          <g key={i}>{dot}</g>
        );
      })}
    </svg>
  );
}
