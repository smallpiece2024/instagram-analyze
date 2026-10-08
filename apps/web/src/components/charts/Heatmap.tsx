import { formatValue, type ValueFormat } from "@/lib/format";
import { Legend } from "./Legend";
import { coord, finiteValues, heatColor } from "./scale";

export interface HeatmapProps {
  /** グラフの説明（`aria-label`） */
  title: string;
  /** 行の名前（曜日など） */
  rows: readonly string[];
  /** 列の名前（時間帯など） */
  cols: readonly string[];
  /** `values[行][列]`。null は空欄 */
  values: readonly (readonly (number | null)[])[];
  /** `counts[行][列]`。0 は空欄、1 は数字に「※」 */
  counts: readonly (readonly number[])[];
  format?: ValueFormat;
  width?: number;
  /** セルのヒントで列の名前の後ろに付ける語（「 時」など） */
  colSuffix?: string;
  /** セルのヒントの値の名前（既定「中央値」） */
  valueName?: string;
}

const LABEL_W = 28;
const CELL_H = 30;
const HEAD_H = 22;
/** 色の濃さ（%）の下端と上端。見本の `12 + 88 × 割合` */
const P_MIN = 12;
const P_SPAN = 88;

/** 表示しているセル（件数 1 以上で値がある）の値の範囲。なければ null */
export function heatmapRange(
  values: readonly (readonly (number | null)[])[],
  counts: readonly (readonly number[])[],
): { min: number; max: number } | null {
  const shown = finiteValues(values.flatMap((row, ri) => row.map((v, ci) => ((counts[ri]?.[ci] ?? 0) > 0 ? v : null))));
  if (shown.length === 0) return null;
  return { min: Math.min(...shown), max: Math.max(...shown) };
}

/**
 * 値の色の濃さ（%）。範囲の最小〜最大で決める。最小と最大が同じなら全部同じ色（上端）にし、0 で割らない（T16）
 */
export function heatPercent(v: number, range: { min: number; max: number }): number {
  const span = range.max - range.min;
  if (!(span > 0)) return P_MIN + P_SPAN;
  return P_MIN + (P_SPAN * (v - range.min)) / span;
}

/**
 * ヒートマップ（見本の `heatmap`。R5 設計 6.5 節、6.6 節）。色は表示している値の最小〜最大で決める。
 * 件数 0 か値が null のセルは空欄（数字なし）。件数 1 のセルは数字に「※」を添える（注記はカードの下に呼び出し側で書く）
 */
export function Heatmap({
  title,
  rows,
  cols,
  values,
  counts,
  format = "count",
  width = 760,
  colSuffix = "",
  valueName = "中央値",
}: HeatmapProps) {
  const nc = Math.max(1, cols.length);
  const cellW = Math.max(1, (width - LABEL_W) / nc);
  const height = CELL_H * rows.length + HEAD_H;
  const range = heatmapRange(values, counts);
  const showText = cellW >= 34;

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
      <g className="chart-axis">
        {cols.map((c, ci) => (
          <text key={`c${ci}`} x={coord(LABEL_W + cellW * ci + cellW / 2)} y="12" textAnchor="middle">
            {c}
          </text>
        ))}
        {rows.map((r, ri) => (
          <text key={`r${ri}`} x={LABEL_W - 8} y={HEAD_H + CELL_H * ri + CELL_H / 2 + 4} textAnchor="end">
            {r}
          </text>
        ))}
      </g>
      {rows.map((r, ri) =>
        cols.map((c, ci) => {
          const v = values[ri]?.[ci] ?? null;
          const cnt = counts[ri]?.[ci] ?? 0;
          const x = LABEL_W + cellW * ci;
          const y = HEAD_H + CELL_H * ri;
          const key = `${ri}-${ci}`;
          const cellW1 = coord(Math.max(0, cellW - 2));
          if (cnt <= 0 || typeof v !== "number" || !Number.isFinite(v) || range === null) {
            return (
              <rect
                key={key}
                data-part="empty"
                x={coord(x)}
                y={y}
                width={cellW1}
                height={CELL_H - 2}
                rx="3"
                fill="var(--color-surface-alt)"
              >
                <title>{`${r} ${c}${colSuffix}: 投稿なし`}</title>
              </rect>
            );
          }
          const p = heatPercent(v, range);
          const text = `${formatValue(v, format)}${cnt === 1 ? "※" : ""}`;
          return (
            <g key={key}>
              <rect data-part="cell" x={coord(x)} y={y} width={cellW1} height={CELL_H - 2} rx="3" fill={heatColor(p)}>
                <title>{`${r} ${c}${colSuffix}: ${valueName} ${formatValue(v, format)}（n=${cnt}）`}</title>
              </rect>
              {showText && (
                <text
                  x={coord(x + cellW / 2 - 1)}
                  y={y + CELL_H / 2 + 3}
                  textAnchor="middle"
                  fontSize="10.5"
                  fill={p > 70 ? "var(--color-surface)" : "var(--color-text)"}
                  pointerEvents="none"
                >
                  {text}
                </text>
              )}
            </g>
          );
        }),
      )}
    </svg>
  );
}

/** ヒートマップの凡例（値の範囲。R5 設計 6.5 節「凡例に値の範囲を書く」）。範囲がなければ何も出さない */
export function HeatmapLegend({
  values,
  counts,
  format = "count",
}: {
  values: HeatmapProps["values"];
  counts: HeatmapProps["counts"];
  format?: ValueFormat;
}) {
  const range = heatmapRange(values, counts);
  if (range === null) return null;
  // 最小と最大が同じでも同じ形で出す（端の場合の文言を足さない）。色はセルと同じ決め方
  return (
    <Legend
      items={[
        { label: `最小 ${formatValue(range.min, format)}`, color: heatColor(heatPercent(range.min, range)) },
        { label: `最大 ${formatValue(range.max, format)}`, color: heatColor(heatPercent(range.max, range)) },
      ]}
    />
  );
}
