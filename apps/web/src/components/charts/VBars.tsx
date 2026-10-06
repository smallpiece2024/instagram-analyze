import { formatAxis, formatValue, type ValueFormat } from "@/lib/format";
import { barVPath, coord, labelStep, MARKER_HIT, niceMax, ticks } from "./scale";

export interface VBarsProps {
  /** グラフの説明（`aria-label`） */
  title: string;
  values: readonly (number | null)[];
  labels: readonly string[];
  /** 全部の棒の色（`var(--chart-1)` など）。`colors` があればそちらを使う */
  color?: string;
  colors?: readonly string[];
  format?: ValueFormat;
  /** `viewBox` の幅。`width: 100%` で縮める（設計 5.3 節） */
  width?: number;
  height?: number;
  /** 棒の上に値を書く（`all` か index の配列。黄と緑の系列には付ける） */
  valueLabels?: "all" | readonly number[];
  /** 薄くする棒（件数が少ない区分） */
  dim?: readonly number[];
  /** X 軸の下に ▲ を置く index（投稿の印）。`markerTips` はその印のヒント（`markers` と同じ順） */
  markers?: readonly number[];
  markerTips?: readonly string[];
  /** 縦の破線とラベル（指標変更の日など。`LineChart` と同じ形） */
  refLines?: readonly { index: number; label: string }[];
  /** 2 行目のラベル（`n=12`） */
  nLabels?: readonly number[];
  /** 棒ごとのヒント（`<title>`）。省略時は「ラベル: 値」 */
  tips?: readonly string[];
  noAxis?: boolean;
  maxBar?: number;
}

/** 縦棒（見本の `vbars`）。値が null の棒は「—」を書く */
export function VBars({
  title,
  values,
  labels,
  color = "var(--chart-1)",
  colors,
  format = "count",
  width = 760,
  height = 180,
  valueLabels,
  dim,
  markers,
  markerTips,
  refLines,
  nLabels,
  tips,
  noAxis,
  maxBar = 26,
}: VBarsProps) {
  const m = { t: 18, r: 8, b: nLabels ? 40 : 26, l: noAxis ? 8 : 44 };
  const iw = Math.max(1, width - m.l - m.r);
  const ih = Math.max(1, height - m.t - m.b);
  const vals = values.map((v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0));
  const max = niceMax(Math.max(0, ...vals) * 1.1);
  const n = values.length;
  const slot = n > 0 ? iw / n : iw;
  const bw = Math.min(maxBar, slot * 0.62);
  const y = (v: number) => m.t + ih - (ih * v) / max;
  const step = labelStep(n, iw, 44);
  const showValue = (i: number) => valueLabels === "all" || (Array.isArray(valueLabels) && valueLabels.includes(i));

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={title}
    >
      {noAxis ? (
        <g className="chart-axis">
          <line x1={m.l} x2={width - m.r} y1={m.t + ih} y2={m.t + ih} />
        </g>
      ) : (
        <>
          <g className="chart-grid">
            {ticks(0, max, 4).map((t) => (
              <line key={t} x1={m.l} x2={width - m.r} y1={coord(y(t))} y2={coord(y(t))} />
            ))}
          </g>
          <g className="chart-axis">
            {ticks(0, max, 4).map((t) => (
              <text key={t} x={m.l - 6} y={coord(y(t) + 4)} textAnchor="end">
                {formatAxis(t, format)}
              </text>
            ))}
          </g>
        </>
      )}
      <g className="chart-axis">
        {labels.map((l, i) => {
          const cx = coord(m.l + slot * i + slot / 2);
          return (
            <g key={i}>
              {i % step === 0 && (
                <text x={cx} y={height - (nLabels ? 18 : 6)} textAnchor="middle">
                  {l}
                </text>
              )}
              {nLabels && (
                <text x={cx} y={height - 4} textAnchor="middle" opacity=".6">
                  n={nLabels[i] ?? 0}
                </text>
              )}
            </g>
          );
        })}
      </g>
      {vals.map((v, i) => {
        const x = m.l + slot * i + (slot - bw) / 2;
        const raw = values[i];
        const fill = colors?.[i] ?? color;
        const tip = tips?.[i] ?? `${labels[i] ?? ""}: ${formatValue(raw, format)}`;
        return (
          <g key={i}>
            {v > 0 ? (
              <path d={barVPath(x, y(v), bw, (ih * v) / max, 4)} fill={fill} opacity={dim?.includes(i) ? ".35" : undefined}>
                <title>{tip}</title>
              </path>
            ) : raw == null ? (
              <text className="chart-label chart-label--muted" x={coord(x + bw / 2)} y={m.t + ih - 6} textAnchor="middle">
                —<title>{tip}</title>
              </text>
            ) : null}
            {showValue(i) && raw != null && (
              <text className="chart-label" x={coord(x + bw / 2)} y={coord(y(v) - 5)} textAnchor="middle">
                {formatValue(raw, format)}
              </text>
            )}
            {/* ヒントを出す範囲。低い棒でも出せるように、棒の列の全体を透明な四角で覆う */}
            <rect x={coord(m.l + slot * i)} y={m.t} width={coord(slot)} height={ih} fill="transparent">
              <title>{tip}</title>
            </rect>
          </g>
        );
      })}
      {(refLines ?? []).map((r) => {
        const rx = m.l + slot * r.index + slot / 2;
        return (
          <g key={`r${r.index}`}>
            <line className="chart-ref" x1={coord(rx)} x2={coord(rx)} y1={m.t} y2={m.t + ih} />
            <text className="chart-label chart-label--muted" x={coord(rx + 4)} y={m.t + 10}>
              {r.label}
            </text>
          </g>
        );
      })}
      {(markers ?? []).map((i, k) => {
        const cx = m.l + slot * i + slot / 2;
        return (
          <g key={`m${i}`}>
            <path d={`M${coord(cx)} ${m.t + ih + 2}l-3 5h6z`} fill="var(--chart-marker)" />
            {/* ヒントを出す範囲。小さな ▲ だけでは合わせにくいので、周りを透明な四角で覆う */}
            {markerTips?.[k] && (
              <rect x={coord(cx - MARKER_HIT / 2)} y={m.t + ih} width={MARKER_HIT} height={MARKER_HIT} fill="transparent">
                <title>{markerTips[k]}</title>
              </rect>
            )}
          </g>
        );
      })}
    </svg>
  );
}
