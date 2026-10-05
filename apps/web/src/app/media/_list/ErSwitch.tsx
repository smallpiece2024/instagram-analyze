/**
 * ER の分母の切り替え（R3 設計 3.1 節、3.3 節。概要と同じ 3 つ）。URL の `er` に持ち、並べ替えは保ったまま 1 ページ目に戻す
 */
import Link from "next/link";
import { buildHref, type Query } from "@/components/href";
import { ER_DENOMINATORS, type ErDenominator } from "@/lib/params";

const LABEL: Record<ErDenominator, string> = {
  reach: "リーチ",
  views: "閲覧数",
  followers: "フォロワー数",
};

export function ErSwitch({ er, query }: { er: ErDenominator; query: Query }) {
  return (
    <span className="small muted">
      ER の分母{" "}
      <span className="seg">
        {ER_DENOMINATORS.map((d) => (
          <Link
            key={d}
            href={buildHref("/media", query, { er: d === "reach" ? undefined : d, page: undefined })}
            aria-current={d === er ? "true" : undefined}
          >
            {LABEL[d]}
          </Link>
        ))}
      </span>
    </span>
  );
}
