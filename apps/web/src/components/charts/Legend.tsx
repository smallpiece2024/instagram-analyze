import { KIND_LABEL, kindColor, type MediaKind } from "@/lib/metrics";

export interface LegendItem {
  label: string;
  /** 色（`var(--chart-1)` など）。`dash` は不要 */
  color?: string;
  /** 印の形。既定は四角 */
  shape?: "box" | "line" | "dash";
}

/** 凡例（見本の `legend`）。文字は本文色、色は印だけ */
export function Legend({ items }: { items: readonly LegendItem[] }) {
  return (
    <div className="legend">
      {items.map((it) => (
        <span key={it.label}>
          <i
            className={it.shape && it.shape !== "box" ? it.shape : undefined}
            style={it.color && it.shape !== "dash" ? { background: it.color } : undefined}
            aria-hidden="true"
          />
          {it.label}
        </span>
      ))}
    </div>
  );
}

/** 投稿の種類の凡例 */
export function KindLegend({ kinds = ["feed", "carousel", "reel"] }: { kinds?: readonly MediaKind[] }) {
  return <Legend items={kinds.map((k) => ({ label: KIND_LABEL[k], color: kindColor(k) }))} />;
}
