/**
 * リール分析（`/reels`）の読み出し（R4 設計 6.2 節）。
 *
 * - 期間は過去 1 年間（365 日）の固定。対象はリールだけ
 * - 指標は `media_list_metrics`（最新の値。リーチ率は 7 日時点）、動画の特徴量は `media_video_features`（今の条件の解析だけ）
 * - `error` 列は読まない。`numeric` と `bigint` は SQL で `float8`／`int` にして数で返す
 * - 計算（順位相関、分位）は `lib/reels.ts` で行う（件数が数十件なので、並べ替えのたびにページ全体を計算し直す）
 */
import "server-only";
import { cache } from "react";
import type { QueryResult } from "@/lib/db-errors";
import type { ReelRow } from "@/lib/reels";
import { runQuery } from "./run";

/** 期間の日数（要件 4.5 章） */
export const REELS_PERIOD_DAYS = 365;

export interface ReelsData {
  rows: ReelRow[];
  /** 最新のスナップショットの取得時刻の最大（最終更新）。なければ null */
  last_fetched_at: Date | null;
}

/** 期間内のリール（投稿日時の新しい順） */
export const getReels = cache(async (accountId: string): Promise<QueryResult<ReelsData>> =>
  runQuery(async (db) => {
    const rows = await db<(ReelRow & { latest_fetched_at: Date | null })[]>`
      select
        l.media_id, l.posted_at, l.caption, l.thumbnail_path, l.gone_at, l.latest_fetched_at,
        (extract(epoch from (now() - l.posted_at)) / 3600)::float8 as elapsed_hours,
        char_length(coalesce(l.caption, ''))::int as caption_chars,
        f.analysis_status,
        f.duration_ms, f.cut_count, f.avg_scene_ms, f.first_cut_ms, f.cuts_in_first_3s,
        l.reach::float8 as reach, l.views::float8 as views, l.avg_watch_time_ms::float8 as avg_watch_time_ms,
        f.retention_rate::float8 as retention_rate, l.skip_rate::float8 as skip_rate,
        l.share_rate::float8 as share_rate, l.save_rate::float8 as save_rate, l.reach_rate::float8 as reach_rate
      from public.media_list_metrics l
      left join public.media_video_features f on f.media_id = l.media_id
      where l.account_id = ${accountId}
        and l.kind = 'reel'
        and l.posted_at >= now() - make_interval(days => ${REELS_PERIOD_DAYS})
      order by l.posted_at desc, l.media_id desc
    `;
    let last: Date | null = null;
    const out: ReelRow[] = rows.map(({ latest_fetched_at, ...r }) => {
      if (latest_fetched_at !== null && (last === null || latest_fetched_at.getTime() > last.getTime())) {
        last = latest_fetched_at;
      }
      return { ...r };
    });
    return { rows: out, last_fetched_at: last };
  }),
);
