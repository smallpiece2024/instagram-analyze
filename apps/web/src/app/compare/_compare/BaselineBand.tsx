import { coord } from "@/components/charts/scale";
import { formatValue, type ValueFormat } from "@/lib/format";
import { baselineDisplay } from "@/lib/metrics";
import type { BaselineStat } from "@/lib/queries/compare";

const W = 420;
const H = 28;
const PAD = 8;

/** 指標ごとの A と B で共通の目盛（値のある期間の最小と最大）。どちらも値がなければ 0〜1 */
export function bandDomain(stats: readonly BaselineStat[]): { lo: number; hi: number } {
  const mins = stats.flatMap((s) => (s.n > 0 && s.min !== null ? [s.min] : []));
  const maxs = stats.flatMap((s) => (s.n > 0 && s.max !== null ? [s.max] : []));
  if (mins.length === 0 || maxs.length === 0) return { lo: 0, hi: 1 };
  return { lo: Math.min(...mins), hi: Math.max(...maxs) };
}

export interface BaselineBandProps {
  stat: BaselineStat;
  format: ValueFormat;
  /** 期間の色（A は `--color-primary`、B は `--color-neutral`） */
  color: string;
  /** 目盛の左端と右端（`bandDomain`） */
  lo: number;
  hi: number;
}

/**
 * 期間比較の投稿の基準値の帯（見本 v4 の `bandSvg`）。細い線 = 最小〜最大、帯 = 25〜75%、縦線 = 中央値。
 * 投稿が 1〜2 件のときは帯と線を出さず中央値の縦線だけ。投稿詳細の `BandRow`（自分の点と薄い表示がある）とは別の部品
 */
export function BaselineBand({ stat, format, color, lo, hi }: BaselineBandProps) {
  const span = hi - lo;
  const x = (v: number) => (span > 0 ? PAD + ((v - lo) / span) * (W - PAD * 2) : W / 2);
  const display = baselineDisplay(stat.n);
  const showRange = display === "faint" || display === "normal";
  const fmt = (v: number | null) => formatValue(v, format);
  const tip = [
    `平均: ${fmt(stat.mean)}`,
    `中央値: ${fmt(stat.median)}`,
    ...(showRange
      ? [`上位 25%: ${fmt(stat.p75)}`, `下位 25%: ${fmt(stat.p25)}`, `最小〜最大: ${fmt(stat.min)}〜${fmt(stat.max)}`]
      : []),
  ].join("\n");

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      height={H}
      preserveAspectRatio="none"
      role="img"
      aria-label={tip}
    >
      <title>{tip}</title>
      {showRange && stat.min !== null && stat.max !== null && (
        <line
          data-part="range"
          x1={coord(x(stat.min))}
          x2={coord(x(stat.max))}
          y1="14"
          y2="14"
          stroke={color}
          strokeOpacity=".45"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {showRange && stat.p25 !== null && stat.p75 !== null && (
        <rect
          data-part="band"
          x={coord(x(stat.p25))}
          y="7"
          width={coord(Math.max(2, x(stat.p75) - x(stat.p25)))}
          height="14"
          rx="3"
          fill={`color-mix(in oklab, ${color} 28%, var(--color-surface))`}
        />
      )}
      {stat.median !== null && (
        <line
          data-part="median"
          x1={coord(x(stat.median))}
          x2={coord(x(stat.median))}
          y1="3"
          y2="25"
          stroke={color}
          strokeWidth="2.5"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}
