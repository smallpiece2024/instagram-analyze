import type { ReactNode } from "react";
import { formatCount, formatPercent } from "@/lib/format";
import { coord } from "./scale";

export interface PieSlice {
  /** 区分の名前（「女性」「18-24」など） */
  label: string;
  /** 人数など。null は「—」 */
  value: number | null;
  /** 割合（0〜1）。扇の角度に使う。null か 0 以下は扇を描かない */
  share: number | null;
  /** 色（`var(--chart-1)` など） */
  color: string;
  /** 扇の中の文字の色。既定は白 */
  textColor?: string;
}

export interface PieProps {
  /** グラフの説明（`aria-label`） */
  title: string;
  slices: readonly PieSlice[];
  /** 円の直径（px） */
  size?: number;
}

/** 円の周りの余白（px） */
const PAD = 16;
/** 扇の間の線の太さ（面の色で描いて区切る） */
const SEPARATOR_W = 1.5;
/** 扇の中に名前と割合を書く割合の下限（これより細い扇は文字が収まらない） */
export const PIE_LABEL_MIN_SHARE = 0.05;
/** 文字を置く位置（中心からの距離。半径に対する比） */
const LABEL_R = 0.62;

/**
 * 円グラフ（オーディエンスの性別と年齢の割合）。12 時から時計回りに `slices` の順に並べる。
 * 角度は割合の合計で割って決める（合計が 1 でなくても円が閉じる）。割合のある扇が 1 つだけなら円を描く。
 * 割合が `PIE_LABEL_MIN_SHARE` 以上の扇には、中に名前と割合を 2 行で書く。
 * 割合のある扇が 0 なら空の SVG。値と割合は扇ごとの `<title>` に出す（凡例は呼び出し側で置く）。
 * 表示の幅は `size` と余白までにする（`.chart svg` の幅 100% で半幅のカードいっぱいに広がらないように）
 */
export function Pie({ title, slices, size = 200 }: PieProps) {
  const full = size + PAD * 2;
  const r = size / 2;
  const c = full / 2;
  const shares = slices.map((s) => (typeof s.share === "number" && Number.isFinite(s.share) && s.share > 0 ? s.share : 0));
  const total = shares.reduce((a, v) => a + v, 0);
  const drawn = shares.filter((v) => v > 0).length;

  const shapes: ReactNode[] = [];
  const labels: ReactNode[] = [];
  let angle = -Math.PI / 2;
  if (total > 0) {
    slices.forEach((s, i) => {
      const share = shares[i] ?? 0;
      if (share <= 0) return;
      const tip = `${s.label}: ${formatCount(s.value)}（${formatPercent(s.share, 1)}）`;
      const start = angle;
      const sweep = (2 * Math.PI * share) / total;
      angle += sweep;
      if (drawn === 1) {
        shapes.push(
          <circle key={i} data-part="slice" cx={coord(c)} cy={coord(c)} r={coord(r)} fill={s.color} aria-label={tip}>
            <title>{tip}</title>
          </circle>,
        );
      } else {
        const x1 = c + r * Math.cos(start);
        const y1 = c + r * Math.sin(start);
        const x2 = c + r * Math.cos(angle);
        const y2 = c + r * Math.sin(angle);
        const large = sweep > Math.PI ? 1 : 0;
        const d = `M${coord(c)} ${coord(c)} L${coord(x1)} ${coord(y1)} A${coord(r)} ${coord(r)} 0 ${large} 1 ${coord(x2)} ${coord(y2)} Z`;
        shapes.push(
          <path
            key={i}
            data-part="slice"
            d={d}
            fill={s.color}
            stroke="var(--color-surface)"
            strokeWidth={SEPARATOR_W}
            strokeLinejoin="round"
            aria-label={tip}
          >
            <title>{tip}</title>
          </path>,
        );
      }
      if ((s.share ?? 0) < PIE_LABEL_MIN_SHARE) return;
      const mid = start + sweep / 2;
      const lx = drawn === 1 ? c : c + r * LABEL_R * Math.cos(mid);
      const ly = drawn === 1 ? c : c + r * LABEL_R * Math.sin(mid);
      // 色は style で付ける（CSS の fill は SVG の fill 属性より強い）
      labels.push(
        <text
          key={i}
          data-part="slice-label"
          x={coord(lx)}
          y={coord(ly)}
          textAnchor="middle"
          fontSize="12"
          style={{ fill: s.textColor ?? "#ffffff" }}
          aria-hidden="true"
          pointerEvents="none"
        >
          <tspan x={coord(lx)} dy="-0.2em">
            {s.label}
          </tspan>
          <tspan x={coord(lx)} dy="1.2em" fontWeight="700">
            {formatPercent(s.share, 1)}
          </tspan>
        </text>,
      );
    });
  }

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${full} ${full}`}
      width={full}
      height={full}
      style={{ maxWidth: full, marginInline: "auto" }}
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      {shapes}
      {labels}
    </svg>
  );
}
