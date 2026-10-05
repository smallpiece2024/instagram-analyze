import Link from "next/link";
import type { SortOrder } from "@/lib/params";
import { buildHref, type Query } from "./href";

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
}

/**
 * 並べ替えのできる列の見出し。今の列には `aria-sort`。
 * 押すと、同じ列なら向きを反転、ほかの列なら降順から始める。並べ替えたら 1 ページ目に戻す
 */
export function SortHeader({ label, sortKey, sort, order, path, query, numeric }: SortHeaderProps) {
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
      <Link href={href} className="sort-link">
        {label}
      </Link>
    </th>
  );
}
