/**
 * 期間比較（`/compare`）と日次の CSV（`/export/daily`）の読み出し（R3 設計 3.5 節、4.5 節、7 章）。
 *
 * - 期間の集計は `period-summary.ts` を組み合わせる（概要と同じ関数。合計の比の欠損の扱いも同じ）
 * - 投稿の基準値は、期間に投稿した投稿（投稿日時の日本時間の日付）の各投稿の最新の値で計算する（3.1 節「比較の値」）。
 *   経過日数の条件は付けない
 * - `bigint` と `numeric` は SQL で `float8`／`int` にして数で返す
 * - すべての関数は `accountId` を第 1 引数に取り、SQL で `account_id = ${accountId}` を付ける（4.1 節）
 */
import "server-only";
import { cache } from "react";
import { dbFromEnv } from "@/lib/db";
import { errorCode, type QueryResult } from "@/lib/db-errors";
import { markDynamic } from "@/lib/dynamic";
import { readEnv } from "@/lib/env";
import type { DailyCsvRow } from "@/lib/csv";
import type { Period } from "@/lib/period";
import {
  getDailyTotals,
  getFollowerChange,
  getPostTotals,
  type DailyTotals,
  type FollowerChange,
  type PostTotals,
} from "@/lib/queries/period-summary";
import { runQuery } from "./run";

/* ------------------------------------------------------------------
 * 主要指標（期間 A と B）
 * ------------------------------------------------------------------ */

export interface PeriodSide {
  period: Period;
  /** 日次指標の合計（太平洋時間の日付） */
  daily: DailyTotals;
  /** フォロワー純増（日本時間の日付の記録） */
  followers: FollowerChange;
  /** 投稿単位の集計（投稿日時の日本時間の日付） */
  posts: PostTotals;
}

export interface PeriodComparison {
  a: PeriodSide;
  b: PeriodSide;
}

async function getSide(accountId: string, period: Period): Promise<QueryResult<PeriodSide>> {
  const [daily, followers, posts] = await Promise.all([
    getDailyTotals(accountId, period.from, period.to),
    getFollowerChange(accountId, period.from, period.to),
    getPostTotals(accountId, period.from, period.to),
  ]);
  if (!daily.ok) return daily;
  if (!followers.ok) return followers;
  if (!posts.ok) return posts;
  return { ok: true, data: { period, daily: daily.data, followers: followers.data, posts: posts.data } };
}

/** 2 つの期間の主要指標。どちらかの読み出しが失敗すれば失敗を返す */
export async function getPeriodComparison(
  accountId: string,
  a: Period,
  b: Period,
): Promise<QueryResult<PeriodComparison>> {
  const [sa, sb] = await Promise.all([getSide(accountId, a), getSide(accountId, b)]);
  if (!sa.ok) return sa;
  if (!sb.ok) return sb;
  return { ok: true, data: { a: sa.data, b: sb.data } };
}

/* ------------------------------------------------------------------
 * 投稿の基準値（F-UI-24。期間に投稿した投稿の最新の値）
 * ------------------------------------------------------------------ */

/** 1 つの指標の分布。n はその指標で値のある投稿の数 */
export interface BaselineStat {
  n: number;
  mean: number | null;
  median: number | null;
  /** 上位 25%（75 パーセンタイル） */
  p75: number | null;
  /** 下位 25%（25 パーセンタイル） */
  p25: number | null;
  min: number | null;
  max: number | null;
}

export const BASELINE_METRICS = ["reach", "save_rate", "er"] as const;
export type BaselineMetric = (typeof BASELINE_METRICS)[number];

export interface PeriodBaselines {
  /** 期間中の投稿の件数（ストーリーズを除く） */
  posts: number;
  stats: Record<BaselineMetric, BaselineStat>;
}

interface BaselineRow {
  posts: number;
  reach_n: number;
  reach_mean: number | null;
  reach_q: number[] | null;
  reach_min: number | null;
  reach_max: number | null;
  save_rate_n: number;
  save_rate_mean: number | null;
  save_rate_q: number[] | null;
  save_rate_min: number | null;
  save_rate_max: number | null;
  er_n: number;
  er_mean: number | null;
  er_q: number[] | null;
  er_min: number | null;
  er_max: number | null;
}

function toStat(
  n: number,
  mean: number | null,
  q: number[] | null,
  min: number | null,
  max: number | null,
): BaselineStat {
  if (n === 0) return { n: 0, mean: null, median: null, p75: null, p25: null, min: null, max: null };
  return { n, mean, p25: q?.[0] ?? null, median: q?.[1] ?? null, p75: q?.[2] ?? null, min, max };
}

/** 期間（両端を含む。日本時間の日付）に投稿した投稿の、リーチ、保存率、ER の平均、分位（`percentile_cont`）、最小と最大 */
export const getPeriodBaselines = cache(
  async (accountId: string, from: string, to: string): Promise<QueryResult<PeriodBaselines>> =>
    runQuery(async (db) => {
      const [row] = await db<BaselineRow[]>`
        select
          count(*)::int as posts,
          count(reach)::int as reach_n,
          avg(reach)::float8 as reach_mean,
          (percentile_cont(array[0.25, 0.5, 0.75]) within group (order by reach::float8))::float8[] as reach_q,
          min(reach)::float8 as reach_min,
          max(reach)::float8 as reach_max,
          count(save_rate)::int as save_rate_n,
          avg(save_rate)::float8 as save_rate_mean,
          (percentile_cont(array[0.25, 0.5, 0.75]) within group (order by save_rate::float8))::float8[] as save_rate_q,
          min(save_rate)::float8 as save_rate_min,
          max(save_rate)::float8 as save_rate_max,
          count(er)::int as er_n,
          avg(er)::float8 as er_mean,
          (percentile_cont(array[0.25, 0.5, 0.75]) within group (order by er::float8))::float8[] as er_q,
          min(er)::float8 as er_min,
          max(er)::float8 as er_max
        from public.media_list_metrics
        where account_id = ${accountId}
          and posted_date_jst between ${from}::date and ${to}::date
      `;
      return {
        posts: row?.posts ?? 0,
        stats: {
          reach: toStat(row?.reach_n ?? 0, row?.reach_mean ?? null, row?.reach_q ?? null, row?.reach_min ?? null, row?.reach_max ?? null),
          save_rate: toStat(row?.save_rate_n ?? 0, row?.save_rate_mean ?? null, row?.save_rate_q ?? null, row?.save_rate_min ?? null, row?.save_rate_max ?? null),
          er: toStat(row?.er_n ?? 0, row?.er_mean ?? null, row?.er_q ?? null, row?.er_min ?? null, row?.er_max ?? null),
        },
      };
    }),
);

/* ------------------------------------------------------------------
 * 最終更新（F-UI-26）
 * ------------------------------------------------------------------ */

/** 期間比較が使うデータの取得時刻の最大値（日次指標とスナップショット）。なければ null */
export const getCompareUpdatedAt = cache(
  async (accountId: string): Promise<QueryResult<Date | null>> =>
    runQuery(async (db) => {
      const [row] = await db<{ at: Date | null }[]>`
        select greatest(
          (select max(fetched_at) from public.account_daily_metrics where account_id = ${accountId}),
          (select max(s.fetched_at)
             from public.media_insight_snapshots s
             join public.media m on m.id = s.media_id
            where m.account_id = ${accountId})
        ) as at
      `;
      return row?.at ?? null;
    }),
);

/* ------------------------------------------------------------------
 * 日次の CSV（7.3 節）
 * ------------------------------------------------------------------ */

/** 日次の CSV の読み出しの失敗。`code` は DB のエラーコード（SQLSTATE）。ログにはこれだけを書く（4.7 節） */
export class DailyCsvError extends Error {
  constructor(readonly code: string) {
    super("daily csv query failed");
    this.name = "DailyCsvError";
  }
}

/**
 * 日次の CSV の行（`account_daily_wide` に `profile_daily` を同じ日付で横に付ける）。
 * `period` が null なら全期間。日付の古い順。
 * Route Handler がログに SQLSTATE を書けるように、失敗は `QueryResult` ではなく `DailyCsvError` で投げる
 */
export async function listDailyCsvRows(accountId: string, period: Period | null): Promise<DailyCsvRow[]> {
  await markDynamic();
  const env = readEnv();
  if (!env.ok) throw new DailyCsvError("config_missing");
  try {
    const db = dbFromEnv(env.env);
    const range = period === null ? db`` : db`and w.metric_date between ${period.from}::date and ${period.to}::date`;
    const rows = await db<DailyCsvRow[]>`
      select
        w.metric_date as metric_date_pt,
        w.reach::float8 as reach,
        w.reach_follower::float8 as reach_follower,
        w.reach_non_follower::float8 as reach_non_follower,
        w.views::float8 as views,
        w.views_follower::float8 as views_follower,
        w.views_non_follower::float8 as views_non_follower,
        w.accounts_engaged::float8 as accounts_engaged,
        w.total_interactions::float8 as total_interactions,
        w.likes::float8 as likes,
        w.comments::float8 as comments,
        w.shares::float8 as shares,
        w.saved::float8 as saved,
        w.new_followers::float8 as new_followers,
        p.followers_count::float8 as followers_count_jst_day,
        w.fetched_at as fetched_at_jst
      from public.account_daily_wide w
      left join public.profile_daily p
        on p.account_id = w.account_id and p.captured_on = w.metric_date
      where w.account_id = ${accountId}
        ${range}
      order by w.metric_date
    `;
    return [...rows];
  } catch (e) {
    // 形を確かめたコードだけをログに乗せる（投稿の CSV の `describeDbError` と同じ扱い）
    throw new DailyCsvError(errorCode(e) ?? "unknown");
  }
}
