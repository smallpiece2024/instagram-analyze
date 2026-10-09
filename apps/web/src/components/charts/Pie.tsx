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
}

export interface PieProps {
  /** グラフの説明（`aria-label`） */
  title: string;
  slices: readonly PieSlice[];
  /** 直径（px） */
  size?: number;
}

/** 扇の間の線の太さ（面の色で描いて区切る） */
const SEPARATOR_W = 1.5;

/**
 * 円グラフ（オーディエンスの性別と年齢の割合）。12 時から時計回りに `slices` の順に並べる。
 * 角度は割合の合計で割って決める（合計が 1 でなくても円が閉じる）。割合のある扇が 1 つだけなら円を描く。
 * 割合のある扇が 0 なら空の SVG。値と割合は扇ごとの `<title>` に出す（凡例は呼び出し側で置く）
 */
export function Pie({ title, slices, size = 180 }: PieProps) {
  const r = size / 2 - 1;
  const c = size / 2;
  const shares = slices.map((s) => (typeof s.share === "number" && Number.isFinite(s.share) && s.share > 0 ? s.share : 0));
  const total = shares.reduce((a, v) => a + v, 0);
  const drawn = shares.filter((v) => v > 0).length;

  let angle = -Math.PI / 2;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      {total > 0 &&
        slices.map((s, i) => {
          const share = shares[i] ?? 0;
          if (share <= 0) return null;
          const tip = `${s.label}: ${formatCount(s.value)}（${formatPercent(s.share, 1)}）`;
          if (drawn === 1) {
            return (
              <circle key={i} data-part="slice" cx={coord(c)} cy={coord(c)} r={coord(r)} fill={s.color} aria-label={tip}>
                <title>{tip}</title>
              </circle>
            );
          }
          const start = angle;
          const sweep = (2 * Math.PI * share) / total;
          angle += sweep;
          const x1 = c + r * Math.cos(start);
          const y1 = c + r * Math.sin(start);
          const x2 = c + r * Math.cos(angle);
          const y2 = c + r * Math.sin(angle);
          const large = sweep > Math.PI ? 1 : 0;
          const d = `M${coord(c)} ${coord(c)} L${coord(x1)} ${coord(y1)} A${coord(r)} ${coord(r)} 0 ${large} 1 ${coord(x2)} ${coord(y2)} Z`;
          return (
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
            </path>
          );
        })}
    </svg>
  );
}
