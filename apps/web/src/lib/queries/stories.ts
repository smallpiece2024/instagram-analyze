/**
 * ストーリーズ（`/stories`）の読み出し（R5 設計 6.3 節）。
 *
 * - 値は `story_list_metrics`（確定値 = 消える前の最後の取得）。手で削除と判定されたもの（`gone_at` あり）も含める
 * - 期間は「過去 N 日」= `posted_at >= now() - make_interval(days => N)`（4 章の期間の境目。T10）
 * - 離脱ファネルのまとまりを期間の境目で切らないように、期間内の最も古い行を含むまとまりの、期間の前の行も返す
 *   （`in_range = false`。確認事項 Q10）。まとまりの判定の規則（6 時間以上空いたら別、投稿日時と id の順）は
 *   `lib/stories.ts` の `groupStories` と同じ。SQL は返す行を選ぶだけで、画面のまとまりは `groupStories` が決める
 * - `numeric` と `bigint` は SQL で `float8` にして数で返す。最終更新は `metrics_fetched_at` の最大
 */
import "server-only";
import { cache } from "react";
import type { QueryResult } from "@/lib/db-errors";
import type { StoryRow } from "@/lib/stories";
import { runQuery } from "./run";

export interface StoriesData {
  /** 期間内の行と、期間の前から続くまとまりの行（投稿日時、id の古い順） */
  rows: StoryRow[];
  /** `metrics_fetched_at` の最大（期間内の行）。なければ null */
  last_fetched_at: Date | null;
}

export const getStories = cache(async (accountId: string, rangeDays: number): Promise<QueryResult<StoriesData>> =>
  runQuery(async (db) => {
    const rows = await db<StoryRow[]>`
      with s as (
        select
          v.*,
          v.posted_at >= now() - make_interval(days => ${rangeDays}) as in_range,
          case
            when lag(v.posted_at) over w is null or v.posted_at - lag(v.posted_at) over w >= interval '6 hours' then 1
            else 0
          end as brk
        from public.story_list_metrics v
        where v.account_id = ${accountId}
        window w as (order by v.posted_at, v.media_id)
      ),
      g as (
        select s.*, sum(s.brk) over (order by s.posted_at, s.media_id rows unbounded preceding) as grp
        from s
      )
      select
        g.media_id, g.posted_at, g.media_type, g.thumbnail_path, g.gone_at, g.metrics_fetched_at,
        g.views::float8 as views, g.reach::float8 as reach,
        g.tap_forward::float8 as tap_forward, g.tap_back::float8 as tap_back,
        g.tap_exit::float8 as tap_exit, g.swipe_forward::float8 as swipe_forward,
        g.link_clicks::float8 as link_clicks, g.replies::float8 as replies,
        g.followers_at_post::float8 as followers_at_post,
        g.view_rate::float8 as view_rate, g.exit_rate::float8 as exit_rate,
        g.in_range
      from g
      where g.in_range
         or g.grp = (select min(g2.grp) from g g2 where g2.in_range)
      order by g.posted_at, g.media_id
    `;
    let last: Date | null = null;
    for (const r of rows) {
      const t = r.metrics_fetched_at;
      if (r.in_range && t !== null && (last === null || t.getTime() > last.getTime())) last = t;
    }
    return { rows: rows.map((r) => ({ ...r })), last_fetched_at: last };
  }),
);
