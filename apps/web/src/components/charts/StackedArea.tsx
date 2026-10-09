import { formatAxis, formatPercent } from "@/lib/format";
import { coord, labelStep, segments, ticks } from "./scale";

export interface StackedAreaSeries {
  label: string;
  /** 点ごとの値（割合など）。各点で全系列の合計を 100% に直して積む */
  values: readonly (number | null)[];
  /** 面の色（`var(--chart-1)` など） */
  color: string;
}

export interface StackedAreaProps {
  /** グラフの説明（`aria-label`） */
  title: string;
  labels: readonly string[];
  /** 下から積む順 */
  series: readonly StackedAreaSeries[];
  width?: number;
  height?: number;
}

/** 前後に点がない 1 点だけの区間を描く柱の幅の上限（px） */
const LONE_W = 16;

/**
 * 100% 積み上げ面（オーディエンスの性別と年齢の推移）。`series` の順に下から積み、上端は常に 100%。
 * 全系列が null の点は記録がないとみなして面を切る。値のある点で null の系列は 0 として積む。
 * 前後に点がない 1 点は細い柱で描く。点ごとの内訳は透明な縦の帯の `<title>` に出す
 */
export function StackedArea({ title, labels, series, width = 760, height = 200 }: StackedAreaProps) {
  const m = { t: 16, r: 14, b: 26, l: 44 };
  const iw = Math.max(1, width - m.l - m.r);
  const ih = Math.max(1, height - m.t - m.b);
  const n = labels.length;
  const x = (i: number) => m.l + (n > 1 ? (iw * i) / (n - 1) : iw / 2);
  const y = (v: number) => m.t + ih - ih * v;
  const step = labelStep(n, iw, 56);
  const tickValues = ticks(0, 1, 4);
  const colW = Math.min(LONE_W, n > 1 ? iw / (n - 1) : LONE_W);

  // 点ごとの積み上げの境目（下端 0 から上端 1 まで、系列の数 + 1 個）。値のない点は null
  const stacks = labels.map((_, i) => {
    const vals = series.map((s) => {
      const v = s.values[i];
      return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
    });
    const hasValue = series.some((s) => {
      const v = s.values[i];
      return typeof v === "number" && Number.isFinite(v);
    });
    const total = vals.reduce((a, v) => a + v, 0);
    if (!hasValue || total <= 0) return null;
    const bounds = [0];
    let acc = 0;
    for (const v of vals) {
      acc += v / total;
      bounds.push(acc);
    }
    return { i, shares: vals.map((v) => v / total), bounds };
  });
  const runs = segments(stacks);

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <g className="chart-grid">
        {tickValues.map((t) => (
          <line key={t} x1={m.l} x2={width - m.r} y1={coord(y(t))} y2={coord(y(t))} />
        ))}
      </g>
      <g className="chart-axis">
        {tickValues.map((t) => (
          <text key={t} x={m.l - 6} y={coord(y(t) + 4)} textAnchor="end">
            {formatAxis(t, "percent")}
          </text>
        ))}
        {labels.map((l, i) =>
          i % step === 0 || (n <= 8 && i === n - 1) ? (
            <text key={i} x={coord(x(i))} y={height - 6} textAnchor="middle">
              {l}
            </text>
          ) : null,
        )}
      </g>
      {runs.map((run) =>
        series.map((s, si) => {
          let d: string;
          if (run.items.length === 1) {
            const p = run.items[0];
            if (!p) return null;
            const lo = p.bounds[si] ?? 0;
            const up = p.bounds[si + 1] ?? 0;
            if (up - lo <= 0) return null;
            const left = Math.max(m.l, x(p.i) - colW / 2);
            const right = Math.min(width - m.r, x(p.i) + colW / 2);
            d = `M${coord(left)} ${coord(y(up))}H${coord(right)}V${coord(y(lo))}H${coord(left)}Z`;
          } else {
            const top = run.items.map((p, k) => `${k ? "L" : "M"}${coord(x(p.i))} ${coord(y(p.bounds[si + 1] ?? 0))}`);
            const bottom = [...run.items].reverse().map((p) => `L${coord(x(p.i))} ${coord(y(p.bounds[si] ?? 0))}`);
            d = `${top.join("")}${bottom.join("")}Z`;
          }
          return (
            <path key={`${run.start}-${si}`} data-part="area" d={d} fill={s.color}>
              <title>{s.label}</title>
            </path>
          );
        }),
      )}
      {stacks.map((p) => {
        if (p === null) return null;
        const half = n > 1 ? iw / (n - 1) / 2 : iw / 2;
        const left = Math.max(m.l, x(p.i) - half);
        const right = Math.min(width - m.r, x(p.i) + half);
        const tip = `${labels[p.i] ?? ""}: ${series.map((s, si) => `${s.label} ${formatPercent(p.shares[si] ?? 0, 1)}`).join("・")}`;
        return (
          <rect
            key={`t${p.i}`}
            data-part="tip"
            x={coord(left)}
            y={m.t}
            width={coord(Math.max(1, right - left))}
            height={ih}
            fill="transparent"
          >
            <title>{tip}</title>
          </rect>
        );
      })}
    </svg>
  );
}
