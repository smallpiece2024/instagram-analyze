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
  /** 向きのクエリの名前。既定は `order`（投稿一覧）。リール分析は `dir`（R4 設計 6.2 節） */
  orderParam?: string;
  /** 見出しのセルに足すクラス（`hide-m` など） */
  className?: string;
}

/** 見出しのリンク先。同じ列なら向きを反転、ほかの列なら降順から。ほかのクエリ（`y` など）は保ち、`page` は外す */
export function sortHeaderHref({
  sortKey,
  sort,
  order,
  path,
  query,
  orderParam = "order",
}: Pick<SortHeaderProps, "sortKey" | "sort" | "order" | "path" | "query" | "orderParam">): string {
  const nextOrder: SortOrder = sort === sortKey && order === "desc" ? "asc" : "desc";
  return buildHref(path, query, { sort: sortKey, [orderParam]: nextOrder, page: undefined });
}

/**
 * 並べ替えのできる列の見出し。今の列には `aria-sort`。
 * 押すと、同じ列なら向きを反転、ほかの列なら降順から始める。並べ替えたら 1 ページ目に戻す
 */
export function SortHeader({ label, sortKey, sort, order, path, query, numeric, hint, orderParam = "order", className }: SortHeaderProps) {
  const current = sort === sortKey;
  const href = sortHeaderHref({ sortKey, sort, order, path, query, orderParam });
  return (
    <th
      scope="col"
      className={[numeric ? "num" : undefined, className].filter(Boolean).join(" ") || undefined}
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
