import { formatValue, type ValueFormat } from "@/lib/format";
import { baselineDisplay, baselineNote, type BaselineDisplay } from "@/lib/metrics";
import { coord, finiteValues } from "./scale";

/** 比較相手の分布（DB の `percentile_cont` の結果）。n は自分を含めない、その指標で値のある投稿の数 */
export interface BandStats {
  n: number;
  min: number | null;
  max: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
}

export interface BandRowProps {
  /** 指標名（`aria-label` に使う） */
  label: string;
  /** この投稿の値。null は点を描かない */
  value: number | null;
  stats: BandStats;
  format?: ValueFormat;
  width?: number;
  /** 系列の色（自分の点） */
  color?: string;
}

const H = 34;
const PAD = 10;

/**
 * 帯グラフの 1 行（見本の `cmpRow`）。最小〜最大の線、25〜75% の帯、中央値の縦線、自分の点。
 * 比較相手の数 n で出し方を変える（設計 3.1 節「基準値」）:
 * 0 は何も描かない、1〜2 は線と中央値だけ、3〜9 は薄く、10 以上は通常
 */
export function BandRow({ label, value, stats, format = "count", width = 520, color = "var(--chart-1)" }: BandRowProps) {
  const display: BaselineDisplay = baselineDisplay(stats.n);
  const domainValues = finiteValues([
    value,
    ...(display === "none" ? [] : [stats.min, stats.max, stats.p25, stats.p75, stats.median]),
  ]);
  let lo = domainValues.length ? Math.min(...domainValues) : 0;
  let hi = domainValues.length ? Math.max(...domainValues) : 1;
  if (!(hi > lo)) {
    const pad = Math.abs(lo) > 0 ? Math.abs(lo) * 0.1 : 1;
    lo -= pad;
    hi += pad;
  }
  const iw = Math.max(1, width - PAD * 2);
  const x = (v: number) => PAD + (iw * (v - lo)) / (hi - lo);
  const mid = H / 2;
  const fin = (v: number | null): v is number => typeof v === "number" && Number.isFinite(v);
  const opacity = display === "faint" ? ".45" : undefined;
  const fmt = (v: number | null) => formatValue(v, format);
  const aria =
    display === "none"
      ? `${label}: この投稿 ${fmt(value)}。${baselineNote(stats.n)}`
      : `${label}: この投稿 ${fmt(value)}、中央値 ${fmt(stats.median)}、範囲 ${fmt(stats.min)}〜${fmt(stats.max)}` +
        (display === "range_only" ? "" : `、25〜75% ${fmt(stats.p25)}〜${fmt(stats.p75)}`) +
        `（${baselineNote(stats.n)}）`;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${width} ${H}`}
      width={width}
      height={H}
      role="img"
      aria-label={aria}
      data-display={display}
    >
      <title>{aria}</title>
      {display !== "none" && (
        <g opacity={opacity} data-part="peers">
          {fin(stats.min) && fin(stats.max) && (
            <line className="chart-marker" x1={coord(x(stats.min))} x2={coord(x(stats.max))} y1={mid} y2={mid} strokeWidth="2" />
          )}
          {display !== "range_only" && fin(stats.p25) && fin(stats.p75) && (
            <rect
              className="chart-band"
              data-part="band"
              x={coord(x(stats.p25))}
              y={mid - 7}
              width={coord(Math.max(1, x(stats.p75) - x(stats.p25)))}
              height="14"
              rx="4"
            />
          )}
          {fin(stats.median) && (
            <line
              data-part="median"
              x1={coord(x(stats.median))}
              x2={coord(x(stats.median))}
              y1={mid - 9}
              y2={mid + 9}
              stroke="var(--chart-ref)"
              strokeWidth="2"
            />
          )}
        </g>
      )}
      {fin(value) && (
        <circle className="chart-dot" data-part="self" cx={coord(x(value))} cy={mid} r="5" fill={color} />
      )}
    </svg>
  );
}
