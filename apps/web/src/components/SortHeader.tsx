import Link from "next/link";
import type { SortOrder } from "@/lib/params";
import { buildHref, type Query } from "./href";
import { MetricHint } from "./MetricHint";

export interface SortHeaderProps {
  label: string;
  /** この列の並べ替えのキー */
  sortKey: string;
  /** 今の並べ替え */
  sort: string;
  order: SortOrder;
  path: string;
  /** 今のクエリ。`sort`、`order` を上書きし、`page` は外す */
  query: Query;
  numeric?: boolean;
  /**
   * 指標の定義のヒント（F-UI-29）。あれば列名を `MetricHint` で包み、並べ替えのリンクは列名の右の印にする
   * （ボタンをリンクの中に入れられないため）
   */
  hint?: string;
}

/**
 * 並べ替えのできる列の見出し。今の列には `aria-sort`。
 * 押すと、同じ列なら向きを反転、ほかの列なら降順から始める。並べ替えたら 1 ページ目に戻す
 */
export function SortHeader({ label, sortKey, sort, order, path, query, numeric, hint }: SortHeaderProps) {
  const current = sort === sortKey;
  const nextOrder: SortOrder = current && order === "desc" ? "asc" : "desc";
  const href = buildHref(path, query, { sort: sortKey, order: nextOrder, page: undefined });
  return (
    <th
      scope="col"
      className={numeric ? "num" : undefined}
      aria-sort={current ? (order === "asc" ? "ascending" : "descending") : undefined}
      data-order={current ? order : undefined}
    >
      {hint ? (
        <span className="sort-head">
          <MetricHint label={label} text={hint} />
          <Link href={href} className="sort-link" aria-label={`${label}で並べ替え`}>
            ⇅
          </Link>
        </span>
      ) : (
        <Link href={href} className="sort-link">
          {label}
        </Link>
      )}
    </th>
  );
}
