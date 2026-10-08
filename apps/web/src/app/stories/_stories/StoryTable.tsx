/**
 * ストーリーズの一覧（R5 設計 6.3 節、見本 `S.stories` の 1）。列の見出しで並べ替え（`sort`、`dir`。`range` は保つ）。
 * スマートフォンでは次へ、戻る、次のアカウントへ、返信を隠す（見本の `hide-m`）。値のない欄は理由つきの「—」
 */
import { MissingValue } from "@/components/MissingValue";
import { SortHeader } from "@/components/SortHeader";
import { Thumb } from "@/components/Thumb";
import type { Query } from "@/components/href";
import { formatCount, formatJst, formatPercent } from "@/lib/format";
import type { Missing } from "@/lib/metrics";
import type { SortOrder } from "@/lib/params";
import {
  countMissing,
  exitRateMissing,
  storyKindLabel,
  viewRateMissing,
  type StoryRow,
  type StorySortKey,
} from "@/lib/stories";

/** 指標の定義（見本の `DEF`） */
export const STORY_HINTS = {
  count: "件数 = 期間中に出したストーリーズの数",
  views: "閲覧 = そのストーリーズが表示された回数",
  view_rate: "閲覧率 = 閲覧 ÷ 投稿したときのフォロワー数。フォロワー数の増減の影響を取り除いて比べるための値",
  exit_rate: "離脱率 = 離脱 ÷ 閲覧",
  tap_forward: "次へ = 次のストーリーズへ進んだ回数",
  tap_back: "戻る = 前のストーリーズへ戻った回数",
  swipe_forward: "次のアカウントへ = 次のアカウントのストーリーズへ移った回数",
  link_clicks: "リンク = リンクのスタンプが押された回数",
  replies: "返信 = ストーリーズへの返信（メッセージ）の数",
} as const;

interface Column {
  key: Exclude<StorySortKey, "posted">;
  label: string;
  hideM?: boolean;
  /** 「—」の理由（値があれば null） */
  missing: (r: StoryRow) => Missing | null;
  text: (r: StoryRow) => string;
}

function countColumn(key: "views" | "tap_forward" | "tap_back" | "swipe_forward" | "link_clicks" | "replies", label: string, hideM?: boolean): Column {
  return { key, label, hideM, missing: (r) => countMissing(r[key]), text: (r) => formatCount(r[key]) };
}

/** 数値の列（6.3 節「一覧」の順） */
export const STORY_COLUMNS: readonly Column[] = [
  countColumn("views", "閲覧"),
  { key: "view_rate", label: "閲覧率", missing: viewRateMissing, text: (r) => formatPercent(r.view_rate, 0) },
  { key: "exit_rate", label: "離脱率", missing: exitRateMissing, text: (r) => formatPercent(r.exit_rate, 1) },
  countColumn("tap_forward", "次へ", true),
  countColumn("tap_back", "戻る", true),
  countColumn("swipe_forward", "次のアカウントへ", true),
  countColumn("link_clicks", "リンク"),
  countColumn("replies", "返信", true),
];

export interface StoryTableProps {
  rows: readonly StoryRow[];
  urls: ReadonlyMap<string, string>;
  sort: StorySortKey;
  dir: SortOrder;
  query: Query;
}

export function StoryTable({ rows, urls, sort, dir, query }: StoryTableProps) {
  const sortProps = { sort, order: dir, path: "/stories", query, orderParam: "dir" };
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">サムネイル</span>
            </th>
            <SortHeader label="投稿日時" sortKey="posted" {...sortProps} />
            <th scope="col">種類</th>
            {STORY_COLUMNS.map((c) => (
              <SortHeader
                key={c.key}
                label={c.label}
                hint={STORY_HINTS[c.key]}
                sortKey={c.key}
                numeric
                className={c.hideM ? "hide-m" : undefined}
                {...sortProps}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.media_id} className={r.gone_at ? "dim" : undefined}>
              <td>
                <Thumb src={r.thumbnail_path ? (urls.get(r.thumbnail_path) ?? null) : null} kind="story" />
              </td>
              <td className="nowrap small">{formatJst(r.posted_at)}</td>
              <td>{storyKindLabel(r.media_type)}</td>
              {STORY_COLUMNS.map((c) => {
                const m = c.missing(r);
                return (
                  <td key={c.key} className={c.hideM ? "num hide-m" : "num"}>
                    {m ? <MissingValue missing={m} /> : c.text(r)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
