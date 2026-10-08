import { formatValue, type ValueFormat } from "@/lib/format";
import { percentileCont } from "@/lib/metrics";
import { coord, finiteValues } from "./scale";

/** 投稿 1 件の点。`href` は投稿詳細などのアプリ内の経路（`/` で始まるものだけをリンクにする） */
export interface StripPoint {
  value: number | null;
  href?: string;
  /** 点のヒント（`<title>`）。省略時は値だけ */
  tip?: string;
}

/** 目盛（行で共通にする横軸の範囲） */
export interface StripDomain {
  min: number;
  max: number;
}

export interface StripProps {
  /** 行の名前（「月 9-12 時」「テーマ: 旅行」など。`aria-label` に使う） */
  label: string;
  points: readonly StripPoint[];
  /** 行で共通の目盛。`stripDomain` で作る */
  domain: StripDomain;
  /** 全投稿の中央値（灰色の縦線）。null なら描かない */
  overall?: number | null;
  format?: ValueFormat;
  width?: number;
  /** 点の色 */
  color?: string;
  /** 行全体を薄く描く（件数が少ない行） */
  dim?: boolean;
}

const H = 28;
const PAD = 8;
const MID = 14;

/**
 * 行で共通の目盛を作る。全行の点の値と、全投稿の中央値を含める。
 * 値がない、全部同じ値（幅 0）でも上端 > 下端にする（0 で割らない）
 */
export function stripDomain(
  rows: readonly (readonly StripPoint[])[],
  overall?: number | null,
): StripDomain {
  const values = finiteValues([...rows.flatMap((r) => r.map((p) => p.value)), overall]);
  let min = values.length ? Math.min(...values) : 0;
  let max = values.length ? Math.max(...values) : 1;
  if (!(max > min)) {
    const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 1;
    min -= pad;
    max += pad;
  }
  return { min, max };
}

/** 点の値の 25%、50%、75%（`percentile_cont` と同じ線形補間。R5 設計 6 章の共通） */
export function stripStats(points: readonly StripPoint[]): {
  n: number;
  min: number | null;
  max: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
} {
  const sorted = finiteValues(points.map((p) => p.value)).sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted.length ? (sorted[0] as number) : null,
    max: sorted.length ? (sorted[sorted.length - 1] as number) : null,
    p25: percentileCont(sorted, 0.25),
    median: percentileCont(sorted, 0.5),
    p75: percentileCont(sorted, 0.75),
  };
}

/** アプリ内の経路だけをリンクにする（`//host` や `javascript:` を通さない） */
function internalHref(href: string | undefined): string | undefined {
  return href !== undefined && href.startsWith("/") && !href.startsWith("//") ? href : undefined;
}

/**
 * 帯グラフの 1 行（見本の投稿時刻「上位の組み合わせ」の `strip`。R5 設計 6.6 節）。
 * 最小〜最大の線、25〜75% の帯、この行の中央値の縦の破線、投稿ごとの点、全投稿の中央値の灰色の線。
 * 目盛は `domain` で行どうし共通にする。点が 0 個なら全投稿の中央値の線だけを描く。
 * 分位は点の値から計算する（表の中央値と同じ関数 `percentileCont`）
 */
export function Strip({
  label,
  points,
  domain,
  overall = null,
  format = "count",
  width = 420,
  color = "var(--chart-3)",
  dim = false,
}: StripProps) {
  const lo = Number.isFinite(domain.min) ? domain.min : 0;
  const hiRaw = Number.isFinite(domain.max) ? domain.max : lo + 1;
  const hi = hiRaw > lo ? hiRaw : lo + 1;
  const iw = Math.max(1, width - PAD * 2);
  const x = (v: number) => PAD + (iw * (v - lo)) / (hi - lo);
  const s = stripStats(points);
  const fmt = (v: number | null) => formatValue(v, format);
  const fin = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
  const drawn = points.filter((p): p is StripPoint & { value: number } => fin(p.value));
  const aria =
    s.n === 0
      ? `${label}: 投稿なし`
      : `${label}: 中央値 ${fmt(s.median)}、範囲 ${fmt(s.min)}〜${fmt(s.max)}、25〜75% ${fmt(s.p25)}〜${fmt(s.p75)}（n=${s.n}）` +
        (fin(overall) ? `。全投稿の中央値 ${fmt(overall)}` : "");

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${width} ${H}`}
      width={width}
      height={H}
      role="img"
      aria-label={aria}
      data-dim={dim ? "true" : undefined}
    >
      <title>{aria}</title>
      {fin(overall) && (
        <line
          data-part="overall"
          x1={coord(x(overall))}
          x2={coord(x(overall))}
          y1="0"
          y2={H}
          stroke="var(--color-text-muted)"
          strokeWidth="1"
          opacity=".5"
        />
      )}
      <g opacity={dim ? ".45" : undefined}>
        {fin(s.min) && fin(s.max) && (
          <line x1={coord(x(s.min))} x2={coord(x(s.max))} y1={MID} y2={MID} stroke="var(--chart-grid)" strokeWidth="2" />
        )}
        {fin(s.p25) && fin(s.p75) && (
          <rect
            className="chart-band"
            data-part="band"
            x={coord(x(s.p25))}
            y={MID - 7}
            width={coord(Math.max(1, x(s.p75) - x(s.p25)))}
            height="14"
            rx="3"
          />
        )}
        {fin(s.median) && (
          <line className="chart-ref" data-part="median" x1={coord(x(s.median))} x2={coord(x(s.median))} y1="4" y2="24" />
        )}
        {drawn.map((p, i) => {
          const cx = coord(x(p.value));
          const tip = p.tip ?? fmt(p.value);
          const dot = (
            <>
              <title>{tip}</title>
              <circle cx={cx} cy={MID} r="10" fill="transparent" />
              <circle data-part="point" cx={cx} cy={MID} r="5" fill={color} stroke="var(--color-surface)" strokeWidth="2" />
            </>
          );
          const href = internalHref(p.href);
          return href ? (
            <a key={i} href={href} aria-label={tip}>
              {dot}
            </a>
          ) : (
            <g key={i}>{dot}</g>
          );
        })}
      </g>
    </svg>
  );
}
