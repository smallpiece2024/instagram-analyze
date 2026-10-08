/**
 * タグ分析（`/tags`）の読み出し（R5 設計 6.1 節「クエリ」）。
 *
 * - 期間は過去 1 年間（365 日）の固定。対象はストーリーズを除く投稿（`media_list_metrics` がストーリーズを含まない）
 * - 値は各投稿の最新の値（R3 の Q21）。リーチ率だけは 7 日時点
 * - `numeric` と `bigint` は SQL で `float8`／`text` にして返す
 * - 中央値と帯は `lib/tags.ts` で計算する
 */
import "server-only";
import { cache } from "react";
import type { QueryResult } from "@/lib/db-errors";
import type { HashtagPostRow, TagAxis, TagPostRow, TagValue } from "@/lib/tags";
import { runQuery } from "./run";

/** 期間の日数（4 章の期間の境目） */
export const TAGS_PERIOD_DAYS = 365;

/** 対象のアカウントの軸（並び順の `sort_order`、同じなら id） */
export const getTagAxes = cache(async (accountId: string): Promise<QueryResult<TagAxis[]>> =>
  runQuery(async (db) =>
    db<TagAxis[]>`
      select a.id::text as id, a.name, a.sort_order
      from public.tag_axes a
      where a.account_id = ${accountId}
      order by a.sort_order, a.id
    `,
  ),
);

export interface TagAnalysisData {
  rows: TagPostRow[];
  /** 選んだ軸の値の全件（投稿が 0 件の値を含む）。軸がなければ空 */
  values: TagValue[];
  /** 最新のスナップショットの取得時刻の最大（最終更新）。なければ null */
  last_fetched_at: Date | null;
}

/**
 * 期間内の投稿を 1 行ずつ返し、選んだ軸の値の id を添える。
 * 軸の条件は `on` 句に置く（`where` に置くと「タグなし」の投稿が落ちる）。主キーが `(media_id, axis_id)` なので投稿は重ならない（T3）。
 * `axisId` が null（軸が 0 件）なら、どの投稿にも値を付けない
 */
export const getTagAnalysis = cache(async (accountId: string, axisId: string | null): Promise<QueryResult<TagAnalysisData>> =>
  runQuery(async (db) => {
    const rows = await db<(TagPostRow & { latest_fetched_at: Date | null })[]>`
      select
        l.media_id, l.kind, l.posted_at, l.caption, l.latest_fetched_at,
        (extract(epoch from (now() - l.posted_at)) / 3600)::float8 as elapsed_hours,
        l.reach::float8 as reach, l.views::float8 as views, l.er::float8 as er,
        l.save_rate::float8 as save_rate, l.share_rate::float8 as share_rate, l.reach_rate::float8 as reach_rate,
        t.value_id::text as value_id
      from public.media_list_metrics l
      left join public.media_tags t
        on t.media_id = l.media_id and t.axis_id = ${axisId}::bigint and t.account_id = ${accountId}
      where l.account_id = ${accountId}
        and l.posted_at >= now() - make_interval(days => ${TAGS_PERIOD_DAYS})
      order by l.posted_at desc, l.media_id desc
    `;
    const values =
      axisId === null
        ? []
        : await db<TagValue[]>`
            select v.id::text as id, v.name, v.sort_order
            from public.tag_values v
            join public.tag_axes a on a.id = v.axis_id
            where v.axis_id = ${axisId}::bigint and a.account_id = ${accountId}
            order by v.sort_order, v.id
          `;
    let last: Date | null = null;
    const out: TagPostRow[] = rows.map(({ latest_fetched_at, ...r }) => {
      if (latest_fetched_at !== null && (last === null || latest_fetched_at.getTime() > last.getTime())) {
        last = latest_fetched_at;
      }
      return { ...r };
    });
    return { rows: out, values: [...values], last_fetched_at: last };
  }),
);

/** 期間内の投稿のハッシュタグ（1 投稿 1 タグ 1 行）と、その投稿の指標 */
export const getHashtagStats = cache(async (accountId: string): Promise<QueryResult<HashtagPostRow[]>> =>
  runQuery(async (db) => {
    const rows = await db<HashtagPostRow[]>`
      select
        h.tag, l.media_id, l.kind, l.posted_at,
        l.reach::float8 as reach, l.views::float8 as views, l.er::float8 as er,
        l.save_rate::float8 as save_rate, l.share_rate::float8 as share_rate, l.reach_rate::float8 as reach_rate
      from public.media_hashtags h
      join public.media_list_metrics l on l.media_id = h.media_id and l.account_id = h.account_id
      where h.account_id = ${accountId}
        and l.posted_at >= now() - make_interval(days => ${TAGS_PERIOD_DAYS})
      order by h.tag, l.posted_at desc, l.media_id desc
    `;
    return [...rows];
  }),
);
