import Link from "next/link";
import { buildHref, type Query } from "./href";

export interface PagerProps {
  page: number;
  pageCount: number;
  /** ページのパス（`/media`） */
  path: string;
  /** 今のクエリ（並べ替えなど）。`page` は上書きする */
  query: Query;
}

/** ページ送り（投稿一覧、収集ログ）。1 ページだけなら何も出さない。1 ページ目の URL には `page` を付けない */
export function Pager({ page, pageCount, path, query }: PagerProps) {
  if (pageCount <= 1) return null;
  const current = Math.min(Math.max(1, page), pageCount);
  const href = (p: number) => buildHref(path, query, { page: p > 1 ? p : undefined });
  const prev = current > 1 ? current - 1 : null;
  const next = current < pageCount ? current + 1 : null;
  return (
    <nav className="pager" aria-label="ページ送り">
      {prev !== null ? (
        <Link className="btn btn--ghost" href={href(prev)} rel="prev">
          前へ
        </Link>
      ) : (
        <span className="btn btn--ghost" aria-disabled="true">
          前へ
        </span>
      )}
      <span className="pager__pos num">
        {current} / {pageCount}
      </span>
      {next !== null ? (
        <Link className="btn btn--ghost" href={href(next)} rel="next">
          次へ
        </Link>
      ) : (
        <span className="btn btn--ghost" aria-disabled="true">
          次へ
        </span>
      )}
    </nav>
  );
}
