import { MetricHint } from "@/components/MetricHint";
import { coord } from "./scale";

export interface ForestRow {
  key: string;
  label: string;
  hint: string;
  n: number;
  /** 順位相関。null は「—」で幅も描かない */
  r: number | null;
  lo: number | null;
  hi: number | null;
}

const H = 22;
const PAD = 8;
const AXIS_TICKS = [-1, -0.5, 0, 0.5, 1] as const;

/** 範囲は -1〜1 の固定 */
function fx(v: number, width: number): number {
  const c = Math.max(-1, Math.min(1, v));
  return PAD + ((c + 1) / 2) * (width - PAD * 2);
}

function signed(r: number): string {
  return `${r > 0 ? "+" : ""}${r.toFixed(2)}`;
}

/** 幅が 0 をまたがない */
function clear(row: ForestRow): boolean {
  return row.lo !== null && row.hi !== null && (row.lo > 0 || row.hi < 0);
}

export function forestTip(row: ForestRow): string {
  if (row.r === null) return `${row.label}: 順位相関 —（n = ${row.n}）`;
  const range = row.lo !== null && row.hi !== null ? `、幅（95%） ${row.lo.toFixed(2)}〜${row.hi.toFixed(2)}` : "";
  return `${row.label}: 順位相関 ${signed(row.r)}${range}（n = ${row.n}）${clear(row) ? "" : "。幅が 0 をまたぐので、まだわからない"}`;
}

/** 1 行の幅のグラフ */
export function ForestBar({ row, width }: { row: ForestRow; width: number }) {
  const ok = clear(row);
  const col = ok ? "var(--color-primary)" : "var(--chart-axis)";
  const tip = forestTip(row);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${width} ${H}`}
      width={width}
      height={H}
      role="img"
      aria-label={tip}
      data-clear={ok ? "true" : "false"}
    >
      <title>{tip}</title>
      <line className="chart-ref" x1={coord(fx(0, width))} x2={coord(fx(0, width))} y1="0" y2={H} />
      {row.r !== null && row.lo !== null && row.hi !== null && (
        <line
          data-part="interval"
          x1={coord(fx(row.lo, width))}
          x2={coord(fx(row.hi, width))}
          y1={H / 2}
          y2={H / 2}
          stroke={col}
          strokeWidth="3"
          strokeLinecap="round"
          opacity={ok ? undefined : ".55"}
        />
      )}
      {row.r !== null && (
        <circle
          data-part="r"
          cx={coord(fx(row.r, width))}
          cy={H / 2}
          r="5"
          fill={col}
          stroke="var(--color-surface)"
          strokeWidth="2"
          opacity={ok ? undefined : ".55"}
        />
      )}
    </svg>
  );
}

function ForestAxis({ width }: { width: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${width} 16`} width={width} height={16} aria-hidden="true">
      <g className="chart-axis">
        {AXIS_TICKS.map((t) => (
          <text key={t} x={coord(fx(t, width))} y="12" textAnchor="middle">
            {t}
          </text>
        ))}
      </g>
    </svg>
  );
}

/**
 * フォレストプロット（見本の `forest`。R4 設計 6.2 節）。範囲は -1〜1 の固定。r が null の行は「—」。
 * 幅が 0 をまたぐ行は薄く。スマートフォンではラベルを上の行に、その下に数値と幅のグラフ（CSS の `.forest`）
 */
export function Forest({ rows, width = 640, widthM = 220 }: { rows: readonly ForestRow[]; width?: number; widthM?: number }) {
  return (
    <div className="forest">
      <div className="forest__row forest__row--axis">
        <span className="forest__label" />
        <span className="forest__value" />
        <div className="chart">
          <div className="only-d">
            <ForestAxis width={width} />
          </div>
          <div className="only-m">
            <ForestAxis width={widthM} />
          </div>
        </div>
      </div>
      {rows.map((row) => {
        const faint = !clear(row);
        return (
          <div key={row.key} className="forest__row" data-faint={faint ? "true" : undefined}>
            <span className="forest__label small">
              <MetricHint label={row.label} text={row.hint} />
            </span>
            <span className="forest__value num">
              <b style={faint ? { opacity: 0.55 } : undefined}>{row.r === null ? "—" : signed(row.r)}</b>
            </span>
            <div className="chart">
              <div className="only-d">
                <ForestBar row={row} width={width} />
              </div>
              <div className="only-m">
                <ForestBar row={row} width={widthM} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
