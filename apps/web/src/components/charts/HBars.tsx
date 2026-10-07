import { formatCount, formatPercent } from "@/lib/format";
import { coord } from "./scale";

export interface HBarsRow {
  /** 区分の名前（国コード、都市名など。API の値をそのまま文字として出す） */
  label: string;
  /** 人数など。null は「—」 */
  value: number | null;
  /** 割合（0〜1）。棒の長さに使う。null は棒を描かない */
  share: number | null;
}

export interface HBarsProps {
  /** グラフの説明（`aria-label`） */
  title: string;
  rows: readonly HBarsRow[];
  width?: number;
  color?: string;
  /** 名前の列の幅（px） */
  labelWidth?: number;
  /** 名前を切り詰める長さ（コードポイント）。切ったときは末尾を「…」にし、全体は `<title>` に出す */
  maxLabelChars?: number;
}

const ROW_H = 24;
const BAR_H = 14;
const VALUE_W = 112;

function shorten(s: string, max: number): string {
  const cps = [...s];
  return cps.length > max ? `${cps.slice(0, Math.max(1, max - 1)).join("")}…` : s;
}

/**
 * 横棒（割合。オーディエンスの区分ごとの人数と割合。R5 設計 6.4 節、6.6 節）。
 * 棒の長さは割合で、行の中で最も大きい割合を全幅にする。右に「人数（割合）」を書く。
 * 割合が null か 0 以下の行は棒を描かない。行が 0 件なら空の SVG
 */
export function HBars({
  title,
  rows,
  width = 520,
  color = "var(--chart-1)",
  labelWidth = 120,
  maxLabelChars = 14,
}: HBarsProps) {
  const height = Math.max(ROW_H, ROW_H * rows.length);
  const bw = Math.max(1, width - labelWidth - VALUE_W);
  const shares = rows.map((r) => (typeof r.share === "number" && Number.isFinite(r.share) && r.share > 0 ? r.share : 0));
  const maxShare = Math.max(0, ...shares);

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
      {rows.map((r, i) => {
        const y = i * ROW_H + (ROW_H - BAR_H) / 2;
        const share = shares[i] ?? 0;
        const w = maxShare > 0 ? (bw * share) / maxShare : 0;
        const valueText = `${formatCount(r.value)}（${formatPercent(r.share, 1)}）`;
        const tip = `${r.label}: ${valueText}`;
        return (
          <g key={i} aria-label={tip}>
            <title>{tip}</title>
            <text className="chart-label" x="0" y={coord(y + BAR_H - 3)}>
              {shorten(r.label, maxLabelChars)}
            </text>
            {w > 0 && (
              <rect data-part="bar" x={labelWidth} y={coord(y)} width={coord(Math.max(1, w))} height={BAR_H} rx="3" fill={color} />
            )}
            <text
              className={r.value === null ? "chart-label chart-label--muted" : "chart-label"}
              x={coord(labelWidth + w + 6)}
              y={coord(y + BAR_H - 3)}
            >
              {valueText}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
