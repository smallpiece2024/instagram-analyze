/**
 * 「上限」（`/jobs`。課題 ia-6ui）の読み出し。
 *
 * - `capacity_daily`（1 日 1 行。DB 全体の値でアカウントの列はない）の直近 40 日
 * - `collect_run_durations`（収集 1 回ごとに 1 行。アカウントの列はない）の直近 14 日（JST の日の区切り）
 * - `job_runs` の `rate_usage`（null でない行だけ）の直近 14 日。`account_id` で必ず絞る
 */
import "server-only";
import { cache } from "react";
import type { CapacityDailyRow, RateUsageRow, RunDurationRow } from "@/lib/capacity";
import type { QueryResult } from "@/lib/db-errors";
import { runQuery } from "./run";

export interface CapacityData {
  /** 新しい順 */
  capacity: CapacityDailyRow[];
  runs: RunDurationRow[];
  rates: RateUsageRow[];
}

export const getCapacity = cache(async (accountId: string): Promise<QueryResult<CapacityData>> =>
  runQuery(async (db) => {
    const [capacity, runs, rates] = await Promise.all([
      db<CapacityDailyRow[]>`
        select
          to_char(captured_on, 'YYYY-MM-DD') as captured_on,
          db_bytes::float8 as db_bytes,
          storage_bytes::float8 as storage_bytes,
          storage_objects::int as storage_objects
        from public.capacity_daily
        where captured_on >= current_date - 40
        order by captured_on desc
      `,
      db<RunDurationRow[]>`
        select began_at, duration_seconds::float8 as duration_seconds
        from public.collect_run_durations
        where began_at >= (date_trunc('day', now() at time zone 'Asia/Tokyo') - interval '13 days') at time zone 'Asia/Tokyo'
        order by began_at desc
      `,
      db<RateUsageRow[]>`
        select started_at, rate_usage
        from public.job_runs
        where account_id = ${accountId}
          and rate_usage is not null
          and started_at >= (date_trunc('day', now() at time zone 'Asia/Tokyo') - interval '13 days') at time zone 'Asia/Tokyo'
        order by started_at desc
      `,
    ]);
    return {
      capacity: capacity.map((r) => ({ ...r })),
      runs: runs.map((r) => ({ ...r })),
      rates: rates.map((r) => ({ ...r })),
    };
  }),
);
