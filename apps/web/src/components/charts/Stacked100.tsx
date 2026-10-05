import { formatCount, formatPercent } from "@/lib/format";
import { KIND_LABEL, kindColor, type MediaKind } from "@/lib/metrics";
import { coord } from "./scale";

export interface Stacked100Row {
  label: string;
  parts: readonly { kind: MediaKind; value: number | null }[];
}

export interface Stacked100Props {
  /** グラフの説明（`aria-label`） */
  title: string;
  rows: readonly Stacked100Row[];
  width?: number;
}

const ROW_H = 40;
const LABEL_W = 64;
const GAP = 2;

/**
 * 100% 積み上げの横棒（見本の `stacked100`）。区切りは 2px の隙間、割合は棒の下に書く。
 * 合計が 0 の行は棒を描かず「—」を書く
 */
export function Stacked100({ title, rows, width = 520 }: Stacked100Props) {
  const height = Math.max(ROW_H, ROW_H * rows.length);
  const bw = Math.max(1, width - LABEL_W);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={title}
    >
      {rows.map((r, ri) => {
        const parts = r.parts.map((p) => ({
          kind: p.kind,
          value: typeof p.value === "number" && Number.isFinite(p.value) && p.value > 0 ? p.value : 0,
        }));
        const total = parts.reduce((a, p) => a + p.value, 0);
        const y = ri * ROW_H + 4;
        const lastDrawn = parts.reduce((acc, p, i) => (p.value > 0 ? i : acc), -1);
        // 各区分の左端（前の区分の幅の累計）
        const starts = parts.map((_, i) => LABEL_W + parts.slice(0, i).reduce((a, p) => a + (total ? (bw * p.value) / total : 0), 0));
        return (
          <g key={ri}>
            <text className="chart-label" x="0" y={y + 13}>
              {r.label}
            </text>
            {total === 0 ? (
              <text className="chart-label chart-label--muted" x={LABEL_W} y={y + 13}>
                —
              </text>
            ) : (
              parts.map((p, pi) => {
                const pw = (bw * p.value) / total;
                if (pw <= 0) return null;
                const rw = Math.max(0, pw - (pi < lastDrawn ? GAP : 0));
                const share = p.value / total;
                const x = starts[pi];
                return (
                  <g key={pi}>
                    <rect x={coord(x)} y={y} width={coord(rw)} height="16" rx={pi === lastDrawn ? 4 : 0} fill={kindColor(p.kind)}>
                      <title>{`${KIND_LABEL[p.kind]}: ${formatCount(p.value)}（${formatPercent(share, 0)}）`}</title>
                    </rect>
                    {rw >= 30 && (
                      <text className="chart-label chart-label--muted" x={coord(x + rw / 2)} y={y + 30} textAnchor="middle">
                        {formatPercent(share, 0)}
                      </text>
                    )}
                  </g>
                );
              })
            )}
          </g>
        );
      })}
    </svg>
  );
}
