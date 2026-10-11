/**
 * 文字で探す（F-VID-32。R4.1 設計 6.3 節）。`/reels` の一覧のカードの上に置く。位置は `q` の有無で動かさない。
 *
 * - 入力は `<form method="get">` の 1 欄（`q`）。`y`、`sort`、`dir` は hidden で保ち、`page` は持たない（1 ページ目に戻る）
 * - 結果は一致した投稿の一覧（サムネイル、題名、投稿日、一致した区間の文字と開始秒を 3 つまで）。強調（`<mark>`）はしない
 * - 0 件は「—」。入力が空ならカードは入力欄だけ。読み取った文字は外部由来の値なので JSX の自動エスケープに任せる
 */
import Link from "next/link";
import { Callout } from "@/components/Callout";
import { Card } from "@/components/Card";
import { Thumb } from "@/components/Thumb";
import type { QueryResult } from "@/lib/db-errors";
import { formatJst, mediaTitle } from "@/lib/format";
import { TEXT_SEARCH_LIMIT, type TextSearchData } from "@/lib/queries/reels";
import { reelsQuery, type ReelsParams } from "@/lib/reels";
import { SEARCH_MAX_CODE_POINTS } from "@/lib/text-search";

const TITLE = "文字で探す";

function sec(ms: number): string {
  return `${(Math.round(ms / 100) / 10).toFixed(1)} 秒`;
}

export function TextSearchCard({
  params,
  result,
  urls,
}: {
  params: ReelsParams;
  /** `q` がなければ null */
  result: QueryResult<TextSearchData> | null;
  urls: ReadonlyMap<string, string>;
}) {
  // hidden で保つのは `q` 以外（既定の値は出さない）
  const keep = Object.entries(reelsQuery({ ...params, q: null })).filter((e): e is [string, string] => e[1] !== undefined);
  const sub =
    result !== null && result.ok
      ? result.data.total > TEXT_SEARCH_LIMIT
        ? `${result.data.total} 件中 ${TEXT_SEARCH_LIMIT} 件`
        : `${result.data.total} 件`
      : undefined;
  return (
    <Card title={TITLE} sub={sub} className="col-12">
      <div className="stack">
        <form method="get" action="/reels" className="field-row" aria-label={TITLE}>
          {keep.map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <input
            className="input"
            type="search"
            name="q"
            defaultValue={params.q ?? ""}
            maxLength={SEARCH_MAX_CODE_POINTS * 2}
            aria-label="探す文字"
          />
          <button type="submit" className="btn">
            探す
          </button>
        </form>
        {result === null ? null : !result.ok ? (
          <Callout state="bad">読み出せません（{result.reason}）</Callout>
        ) : result.data.hits.length === 0 ? (
          <p>
            <span className="muted">—</span>
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">
                    <span className="sr-only">サムネイル</span>
                  </th>
                  <th scope="col">投稿</th>
                  <th scope="col" className="num">
                    投稿日
                  </th>
                  <th scope="col">文字</th>
                </tr>
              </thead>
              <tbody>
                {result.data.hits.map((h) => {
                  const href = `/media/${h.media_id}`;
                  const title = mediaTitle(h.caption);
                  return (
                    <tr key={h.media_id} className={h.gone_at ? "dim" : undefined}>
                      <td>
                        <Link href={href} aria-label={title}>
                          <Thumb src={h.thumbnail_path ? (urls.get(h.thumbnail_path) ?? null) : null} kind={h.kind} />
                        </Link>
                      </td>
                      <td>
                        <Link href={href}>{title}</Link>
                      </td>
                      <td className="num">{formatJst(h.posted_at).slice(0, 10)}</td>
                      <td style={{ overflowWrap: "anywhere", maxWidth: "28em" }}>
                        {h.segments.map((s) => (
                          <div key={s.seq}>
                            <span className="small muted num">{sec(s.start_ms)}</span> {s.text}
                          </div>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}
