/**
 * 収集ログの読み出し（設計 1.1 章、1.7 章）。`job_latest_runs` と `job_runs` に `accounts` を結合してユーザー名を補う。
 */
import "server-only";
import { cache } from "react";
import { dbFromEnv } from "@/lib/db";
import { describeDbError, type QueryResult } from "@/lib/db-errors";
import { markDynamic } from "@/lib/dynamic";
import { configMissingReason, readEnv } from "@/lib/env";
import { JOB_ORDER, type JobName, type RateUsage } from "@/lib/format";

export interface JobRunView {
  /** `job_runs.id`（bigint。文字列のまま） */
  id: string;
  job_name: string;
  account_id: string | null;
  username: string | null;
  started_at: Date;
  finished_at: Date | null;
  status: string;
  items_fetched: number | null;
  api_calls: number | null;
  /** ワーカーがマスク済みの固定文言か API の文言 */
  error: string | null;
  rate_usage: RateUsage | null;
}

/** 直近 100 件の上限 */
export const RECENT_RUNS_LIMIT = 100;

function orderIndex(jobName: string): number {
  const i = (JOB_ORDER as readonly string[]).indexOf(jobName);
  return i === -1 ? JOB_ORDER.length : i;
}

/** ジョブごとの直近の実行（実行順、同じジョブはユーザー名順） */
export const getLatestRuns = cache(async (): Promise<QueryResult<JobRunView[]>> => {
  await markDynamic();
  const env = readEnv();
  if (!env.ok) return { ok: false, reason: configMissingReason(env.missing) };
  try {
    const db = dbFromEnv(env.env);
    const rows = await db<JobRunView[]>`
      select
        l.id, l.job_name, l.account_id, a.username, l.started_at, l.finished_at, l.status,
        l.items_fetched, l.api_calls, l.error, l.rate_usage
      from public.job_latest_runs l
      left join public.accounts a on a.id = l.account_id
    `;
    const data = [...rows].sort(
      (x, y) =>
        orderIndex(x.job_name) - orderIndex(y.job_name) ||
        (x.username ?? "").localeCompare(y.username ?? "") ||
        (x.account_id ?? "").localeCompare(y.account_id ?? ""),
    );
    return { ok: true, data };
  } catch (e) {
    return { ok: false, reason: describeDbError(e) };
  }
});

/** 直近 100 件の実行（新しい順）。`job` は許可リストで検証済みのジョブ名 */
export const listRecentRuns = cache(async (job?: JobName): Promise<QueryResult<JobRunView[]>> => {
  await markDynamic();
  const env = readEnv();
  if (!env.ok) return { ok: false, reason: configMissingReason(env.missing) };
  try {
    const db = dbFromEnv(env.env);
    const rows = await db<JobRunView[]>`
      select
        r.id, r.job_name, r.account_id, a.username, r.started_at, r.finished_at, r.status,
        r.items_fetched, r.api_calls, r.error, r.rate_usage
      from public.job_runs r
      left join public.accounts a on a.id = r.account_id
      where ${job === undefined ? db`true` : db`r.job_name = ${job}`}
      order by r.started_at desc, r.id desc
      limit ${RECENT_RUNS_LIMIT}
    `;
    return { ok: true, data: [...rows] };
  } catch (e) {
    return { ok: false, reason: describeDbError(e) };
  }
});
