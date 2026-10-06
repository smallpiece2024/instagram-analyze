/**
 * 概要（`/`）だけで使う読み出しと組み立て（R3 設計 3.2 節、4.5 節、6 章）。
 * 期間の集計そのものは `period-summary.ts` を使い、ここには概要に固有のもの（最終更新、投稿の印、指標変更の日）
 * だけを置く。
 *
 * - すべての読み出し関数は `accountId` を第 1 引数に取り、SQL で `account_id = ${accountId}` を付ける（4.1 節）
 * - 日付の変換（日本時間、太平洋時間）はビューの列（`posted_date_pt`）で済ませ、JS では変換しない（6 章）
 */
import "server-only";
import { cache } from "react";
import type { QueryResult } from "@/lib/db-errors";
import type { Ymd } from "@/lib/period";
import { runQuery } from "./run";

/* ------------------------------------------------------------------
 * 最終更新（F-UI-26）
 * ------------------------------------------------------------------ */

export interface OverviewUpdatedAt {
  /** 日次指標の取得時刻の最大（`account_daily_metrics.fetched_at`） */
  daily: Date | null;
  /** 投稿の指標の取得時刻の最大（`media_insight_snapshots.fetched_at`） */
  media: Date | null;
  /** 2 つのうち新しい方（見出しの「最終更新」） */
  latest: Date | null;
}

/** 概要が使うデータの取得時刻 */
export const getOverviewUpdatedAt = cache(
  async (accountId: string): Promise<QueryResult<OverviewUpdatedAt>> =>
    runQuery(async (db) => {
      const [row] = await db<{ daily: Date | null; media: Date | null }[]>`
        select
          (select max(d.fetched_at) from public.account_daily_metrics d where d.account_id = ${accountId}) as daily,
          (
            select max(s.fetched_at)
            from public.media_insight_snapshots s
            join public.media m on m.id = s.media_id
            where m.account_id = ${accountId}
          ) as media
      `;
      const daily = row?.daily ?? null;
      const media = row?.media ?? null;
      const latest = daily === null ? media : media === null ? daily : daily > media ? daily : media;
      return { daily, media, latest };
    }),
);

/* ------------------------------------------------------------------
 * 日次推移のグラフの投稿の印と指標変更の日
 * ------------------------------------------------------------------ */

export interface PostMarker {
  /** 投稿日時を太平洋時間の日付に直したもの（グラフの X 軸の位置。6 章） */
  posted_date_pt: Ymd;
  /** 投稿日時（ヒントに日本時間で書く） */
  posted_at: Date;
  /** キャプション（ヒントに題名として 1 行目を書く） */
  caption: string | null;
}

/** 期間（両端を含む。太平洋時間の日付）に投稿した投稿の印。ストーリーズはビューに入らないので含まない。日時の古い順 */
export const getPostMarkers = cache(
  async (accountId: string, from: Ymd, to: Ymd): Promise<QueryResult<PostMarker[]>> =>
    runQuery(async (db) => {
      const rows = await db<PostMarker[]>`
        select posted_date_pt, posted_at, caption
        from public.media_list_metrics
        where account_id = ${accountId}
          and posted_date_pt between ${from}::date and ${to}::date
        order by posted_at
      `;
      return [...rows];
    }),
);

/**
 * 期間（両端を含む）に入る、アカウント日次指標の定義が変わった日（`available_from`、`deprecated_on`）。
 * 日付の古い順、重複なし（3.1 節「指標変更の注記」）
 */
export const getMetricChangeDates = cache(
  async (from: Ymd, to: Ymd): Promise<QueryResult<Ymd[]>> =>
    runQuery(async (db) => {
      const rows = await db<{ on: Ymd }[]>`
        select distinct d as "on"
        from public.metric_definitions md
        cross join lateral (values (md.available_from), (md.deprecated_on)) as v(d)
        where md.scope = 'account_daily'
          and d between ${from}::date and ${to}::date
        order by d
      `;
      return rows.map((r) => r.on);
    }),
);
