/**
 * 投稿時刻（`/timing`）の読み出し（R5 設計 6.5 節）。
 *
 * - 対象は過去 1 年間（365 日）の投稿（ストーリーズを除く。`media_list_metrics` が除く）
 * - 曜日（ISO）と時は SQL で JST に変換して返す（JS で二重に持たない。R3 6 章）
 * - 24 時間の値は `media_horizon_metrics` の `horizon = '24h'` かつ `within_tolerance` のときだけ。最新の値は `media_list_metrics`
 * - 指標と種類の切り替えは `lib/timing.ts` でする（取得は 1 回）
 */
import "server-only";
import { cache } from "react";
import type { QueryResult } from "@/lib/db-errors";
import { TIMING_PERIOD_DAYS, type TimingRow } from "@/lib/timing";
import { runQuery } from "./run";

export interface TimingData {
  rows: TimingRow[];
  /** 最新のスナップショットの取得時刻の最大（最終更新）。なければ null */
  last_fetched_at: Date | null;
}

/** 期間内の投稿（投稿日時の新しい順） */
export const getTimingRows = cache(async (accountId: string): Promise<QueryResult<TimingData>> =>
  runQuery(async (db) => {
    const rows = await db<(TimingRow & { latest_fetched_at: Date | null })[]>`
      select
        l.media_id, l.kind, l.posted_at, l.latest_fetched_at,
        extract(isodow from l.posted_at at time zone 'Asia/Tokyo')::int as isodow,
        extract(hour from l.posted_at at time zone 'Asia/Tokyo')::int as hour,
        h.reach::float8 as reach_24h,
        h.views::float8 as views_24h,
        l.reach::float8 as reach_latest,
        l.views::float8 as views_latest
      from public.media_list_metrics l
      left join public.media_horizon_metrics h
        on h.media_id = l.media_id and h.horizon = '24h' and h.within_tolerance
      where l.account_id = ${accountId}
        and l.kind <> 'story'
        and l.posted_at >= now() - make_interval(days => ${TIMING_PERIOD_DAYS})
      order by l.posted_at desc, l.media_id desc
    `;
    let last: Date | null = null;
    const out: TimingRow[] = rows.map(({ latest_fetched_at, ...r }) => {
      if (latest_fetched_at !== null && (last === null || latest_fetched_at.getTime() > last.getTime())) {
        last = latest_fetched_at;
      }
      return { ...r };
    });
    return { rows: out, last_fetched_at: last };
  }),
);
