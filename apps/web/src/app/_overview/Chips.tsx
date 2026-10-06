import Link from "next/link";
import { buildHref } from "@/components/href";
import { PendingMark } from "@/components/PendingMark";
import { RANGES, type Range } from "@/lib/params";

/**
 * 期間の切り替え（3.2 節「期間」）。`<select>` ではなく 3 つのリンクにし、JS なしで動かす。
 * 既定の値（30 日）は URL に付けない
 */
export function RangeChips({ range }: { range: Range }) {
  return (
    <nav className="chips" aria-label="期間">
      {RANGES.map((r) => (
        <Link
          key={r}
          className="chip"
          href={buildHref("/", { range: r === 30 ? undefined : r })}
          aria-current={r === range ? "true" : undefined}
        >
          過去 {r} 日
          <PendingMark />
        </Link>
      ))}
    </nav>
  );
}
