import { formatSignedCount, formatSignedPercent, formatSignedPt } from "@/lib/format";
import type { Delta as DeltaValue } from "@/lib/metrics";

const ARROW = { up: "▲", down: "▼", flat: "" } as const;

/**
 * 前期間比（見本の `delta`、`deltaPt`）。件数は増減率、率はポイント差、人数は差。
 * 前期間が 0 か null の件数は「前期 0」。null は何も出さない
 */
export function Delta({ delta }: { delta: DeltaValue | null }) {
  if (delta === null) return null;
  if (delta.kind === "prev_zero") {
    return (
      <span className="delta" data-dir="flat">
        前期 0
      </span>
    );
  }
  const text =
    delta.kind === "rate"
      ? formatSignedPercent(delta.value)
      : delta.kind === "pt"
        ? formatSignedPt(delta.value)
        : formatSignedCount(delta.value);
  // 変化なしは文字に「±」が入るので矢印を付けない
  const body = delta.dir === "flat" ? text : `${ARROW[delta.dir]} ${text}`;
  return (
    <span className="delta" data-dir={delta.dir}>
      {body}
    </span>
  );
}
