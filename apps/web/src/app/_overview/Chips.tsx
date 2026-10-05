import Link from "next/link";
import { buildHref } from "@/components/href";
import { ER_DENOMINATORS, RANGES, type ErDenominator, type Range } from "@/lib/params";
import { ER_DENOMINATOR_LABEL } from "@/lib/queries/overview";

/**
 * 期間の切り替え（3.2 節「期間」）。`<select>` ではなく 3 つのリンクにし、JS なしで動かす。
 * 既定の値（30 日、分母リーチ）は URL に付けない
 */
export function RangeChips({ range, er }: { range: Range; er: ErDenominator }) {
  return (
    <nav className="chips" aria-label="期間">
      {RANGES.map((r) => (
        <Link
          key={r}
          className="chip"
          href={buildHref("/", { range: r === 30 ? undefined : r, er: er === "reach" ? undefined : er })}
          aria-current={r === range ? "true" : undefined}
        >
          過去 {r} 日
        </Link>
      ))}
    </nav>
  );
}

/** ER の分母の切り替え（F-UI-11。`?er=reach|views|followers`） */
export function ErChips({ range, er }: { range: Range; er: ErDenominator }) {
  return (
    <nav className="chips" aria-label="エンゲージメント率の分母">
      {ER_DENOMINATORS.map((d) => (
        <Link
          key={d}
          className="chip"
          href={buildHref("/", { range: range === 30 ? undefined : range, er: d === "reach" ? undefined : d })}
          aria-current={d === er ? "true" : undefined}
        >
          {ER_DENOMINATOR_LABEL[d]}
        </Link>
      ))}
    </nav>
  );
}
