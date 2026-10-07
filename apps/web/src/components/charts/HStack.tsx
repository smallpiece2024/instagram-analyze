import { formatCount, formatPercent } from "@/lib/format";
import { coord } from "./scale";

export interface HStackSegment {
  /** 区分の名前（「次へ」など） */
  label: string;
  /** 色（`heatColor(90)`、`var(--chart-1)` など） */
  color: string;
}

export interface HStackRow {
  /** 行の名前（「9/1 12:00」など） */
  label: string;
  /** 区分ごとの値（`segments` と同じ順）。null と 0 以下は 0 として数える */
  values: readonly (number | null)[];
}

export interface HStackProps {
  /** グラフの説明（`aria-label`） */
  title: string;
  segments: readonly HStackSegment[];
  rows: readonly HStackRow[];
  width?: number;
  /** 行の名前の列の幅（px） */
  labelWidth?: number;
}

const ROW_H = 30;
const BAR_H = 18;
const GAP = 2;

/**
 * 横の 100% 積み上げ棒（ストーリーズの操作の内訳。見本 `S.stories` の 3。R5 設計 6.3 節、6.6 節）。
 * 分母は行の区分の合計。合計が 0（全部 null を含む）の行は棒を描かず「—」を書く。
 * 区分の値と割合は `<title>` と `aria-label` に出す（凡例は呼び出し側で `Legend` を置く）
 */
export function HStack({ title, segments, rows, width = 520, labelWidth = 78 }: HStackProps) {
  const height = Math.max(ROW_H, ROW_H * rows.length);
  const bw = Math.max(1, width - labelWidth);

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
      {rows.map((r, ri) => {
        const vals = segments.map((_, si) => {
          const v = r.values[si];
          return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
        });
        const total = vals.reduce((a, v) => a + v, 0);
        const y = ri * ROW_H + (ROW_H - BAR_H) / 2;
        const lastDrawn = vals.reduce((acc, v, i) => (v > 0 ? i : acc), -1);
        let x = labelWidth;
        return (
          <g key={ri}>
            <text className="chart-label" x="0" y={y + 13}>
              {r.label}
            </text>
            {total === 0 ? (
              <text className="chart-label chart-label--muted" x={labelWidth} y={y + 13}>
                —<title>{`${r.label}: —`}</title>
              </text>
            ) : (
              vals.map((v, si) => {
                const pw = (bw * v) / total;
                const left = x;
                x += pw;
                if (pw <= 0) return null;
                const rw = Math.max(0, pw - (si < lastDrawn ? GAP : 0));
                const seg = segments[si] as HStackSegment;
                const tip = `${r.label} ${seg.label}: ${formatCount(v)}（${formatPercent(v / total, 0)}）`;
                return (
                  <rect
                    key={si}
                    data-part="segment"
                    x={coord(left)}
                    y={y}
                    width={coord(rw)}
                    height={BAR_H}
                    rx={si === lastDrawn ? 4 : 0}
                    fill={seg.color}
                    aria-label={tip}
                  >
                    <title>{tip}</title>
                  </rect>
                );
              })
            )}
          </g>
        );
      })}
    </svg>
  );
}
