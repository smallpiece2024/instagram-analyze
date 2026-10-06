import Link from "next/link";
import { formatCount } from "@/lib/format";
import { PendingMark } from "./PendingMark";
import { buildHref, type Query } from "./href";

export interface PagerProps {
  page: number;
  pageCount: number;
  /** ページのパス（`/media`） */
  path: string;
  /** 今のクエリ（並べ替えなど）。`page` は上書きする */
  query: Query;
  /** 全件数と 1 ページの件数。両方あれば「1〜50 件目（全 n 件）」を添える */
  total?: number;
  pageSize?: number;
}

/** ページ番号の並び。数字はページ、`gap` は省略（…） */
export type PagerItem = number | "gap";

/**
 * 出すページ番号（見本の「‹ 前へ 1 2 3 … 24 次へ ›」）。最初と最後のページ、今のページと前後 1 ページを出し、
 * 間が 2 ページ以上空くところを「…」にする（1 ページだけ空くならその番号を出す）
 */
export function pagerItems(current: number, pageCount: number): PagerItem[] {
  if (pageCount < 1) return [];
  const c = Math.min(Math.max(1, current), pageCount);
  const shown = new Set([1, pageCount, c - 1, c, c + 1].filter((p) => p >= 1 && p <= pageCount));
  const pages = [...shown].sort((a, b) => a - b);
  const items: PagerItem[] = [];
  let prev = 0;
  for (const p of pages) {
    if (p - prev === 2) items.push(p - 1);
    else if (p - prev > 2) items.push("gap");
    items.push(p);
    prev = p;
  }
  return items;
}

/** ページ送り（投稿一覧、収集ログ）。1 ページだけでも出す（前へと次へは押せない）。1 ページ目の URL には `page` を付けない */
export function Pager({ page, pageCount: rawPageCount, path, query, total, pageSize }: PagerProps) {
  const pageCount = Math.max(1, rawPageCount);
  const current = Math.min(Math.max(1, page), pageCount);
  const href = (p: number) => buildHref(path, query, { page: p > 1 ? p : undefined });
  const prev = current > 1 ? current - 1 : null;
  const next = current < pageCount ? current + 1 : null;
  const range =
    typeof total === "number" && typeof pageSize === "number" && total > 0
      ? { first: (current - 1) * pageSize + 1, last: Math.min(total, current * pageSize) }
      : null;
  return (
    <div>
      <nav className="pager" aria-label="ページ送り">
        {prev !== null ? (
          <Link className="btn btn--ghost" href={href(prev)} rel="prev">
            ‹ 前へ
            <PendingMark />
          </Link>
        ) : (
          <span className="btn btn--ghost" aria-disabled="true">
            ‹ 前へ
          </span>
        )}
        <span className="pager__pages num">
          {pagerItems(current, pageCount).map((item, i) =>
            item === "gap" ? (
              <span key={`gap${i}`} className="pager__gap" aria-hidden="true">
                …
              </span>
            ) : item === current ? (
              <span key={item} className="pager__page" aria-current="page">
                {item}
              </span>
            ) : (
              <Link key={item} className="pager__page" href={href(item)}>
                {item}
                <PendingMark />
              </Link>
            ),
          )}
        </span>
        {next !== null ? (
          <Link className="btn btn--ghost" href={href(next)} rel="next">
            次へ ›
            <PendingMark />
          </Link>
        ) : (
          <span className="btn btn--ghost" aria-disabled="true">
            次へ ›
          </span>
        )}
      </nav>
      {range && (
        <p className="pager__pos num">
          {formatCount(range.first)}〜{formatCount(range.last)} 件目（全 {formatCount(total)} 件）
        </p>
      )}
    </div>
  );
}
