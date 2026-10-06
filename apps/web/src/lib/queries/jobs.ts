/**
 * 収集ログの読み出し（R1 設計 1.7 章、R3 設計 3.6 節、4.5 節）。すべて対象のアカウント（`accountId`）に絞る。
 */
import "server-only";
import { cache } from "react";
import { dbFromEnv } from "@/lib/db";
import { describeDbError, type QueryResult } from "@/lib/db-errors";
import { markDynamic } from "@/lib/dynamic";
import { configMissingReason, readEnv } from "@/lib/env";
import { JOB_ORDER, type JobName, type JobStatus, type RateUsage } from "@/lib/format";

export interface JobRunView {
  /** `job_runs.id`（bigint。文字列のまま） */
  id: string;
  job_name: string;
  account_id: string | null;
  started_at: Date;
  finished_at: Date | null;
  status: string;
  items_fetched: number | null;
  api_calls: number | null;
  /** ワーカーがマスク済みの固定文言か API の文言 */
  error: string | null;
  rate_usage: RateUsage | null;
}

/** 実行記録の 1 ページの件数（3.6 節。50 件ずつ） */
export const RUNS_PAGE_SIZE = 50;

function orderIndex(jobName: string): number {
  const i = (JOB_ORDER as readonly string[]).indexOf(jobName);
  return i === -1 ? JOB_ORDER.length : i;
}

/** ジョブごとの直近の実行（実行順） */
export const getLatestRuns = cache(async (accountId: string): Promise<QueryResult<JobRunView[]>> => {
  await markDynamic();
  const env = readEnv();
  if (!env.ok) return { ok: false, reason: configMissingReason(env.missing) };
  try {
    const db = dbFromEnv(env.env);
    const rows = await db<JobRunView[]>`
      select
        l.id, l.job_name, l.account_id, l.started_at, l.finished_at, l.status,
        l.items_fetched, l.api_calls, l.error, l.rate_usage
      from public.job_latest_runs l
      where l.account_id = ${accountId}
    `;
    const data = [...rows].sort((x, y) => orderIndex(x.job_name) - orderIndex(y.job_name));
    return { ok: true, data };
  } catch (e) {
    return { ok: false, reason: describeDbError(e) };
  }
});

export interface RunsFilter {
  /** 許可リストで検査済みのジョブ名（`parseJob`） */
  job?: JobName;
  /** 5 値の列挙で検査済みの状態（`parseJobStatus`） */
  status?: JobStatus;
  /** 1 以上（`parsePageNumber`）。総ページ数を超えたら最後のページに丸める */
  page: number;
}

export interface RunsPage {
  rows: JobRunView[];
  /** 絞り込みに合う総件数 */
  total: number;
  /** 丸めたあとのページ */
  page: number;
  /** 1 以上 */
  pageCount: number;
}

/** 実行記録（新しい順、50 件ずつ） */
export const listRecentRuns = cache(
  async (accountId: string, filter: RunsFilter): Promise<QueryResult<RunsPage>> => {
    await markDynamic();
    const env = readEnv();
    if (!env.ok) return { ok: false, reason: configMissingReason(env.missing) };
    try {
      const db = dbFromEnv(env.env);
      const jobCond = filter.job === undefined ? db`` : db`and r.job_name = ${filter.job}`;
      const statusCond = filter.status === undefined ? db`` : db`and r.status = ${filter.status}`;
      const [countRow] = await db<{ n: number }[]>`
        select count(*)::int as n
        from public.job_runs r
        where r.account_id = ${accountId} ${jobCond} ${statusCond}
      `;
      const total = countRow?.n ?? 0;
      const pageCount = Math.max(1, Math.ceil(total / RUNS_PAGE_SIZE));
      const page = Math.min(Math.max(1, filter.page), pageCount);
      const rows = await db<JobRunView[]>`
        select
          r.id, r.job_name, r.account_id, r.started_at, r.finished_at, r.status,
          r.items_fetched, r.api_calls, r.error, r.rate_usage
        from public.job_runs r
        where r.account_id = ${accountId} ${jobCond} ${statusCond}
        order by r.started_at desc, r.id desc
        limit ${RUNS_PAGE_SIZE} offset ${(page - 1) * RUNS_PAGE_SIZE}
      `;
      return { ok: true, data: { rows: [...rows], total, page, pageCount } };
    } catch (e) {
      return { ok: false, reason: describeDbError(e) };
    }
  },
);

export interface JobStats {
  /** 直近 24 時間に開始した実行の数（3.6 節の 3 段階と実行中） */
  last24h: { total: number; success: number; warn: number; failed: number; running: number };
  /** 直近 24 時間の最新の失敗。なければ null */
  latestFailure: { job_name: string; started_at: Date; error: string | null } | null;
  /** ジョブごとの、最新から続く `failed` の数（`running` を除く）の最大。0 なら job_name は null */
  consecutiveFailures: { count: number; job_name: string | null };
  /** 最後に `success` で終わった時刻 */
  lastSuccessAt: Date | null;
  /** `rate_usage` のある最新の実行 */
  latestRateUsage: { rate_usage: RateUsage; finished_at: Date | null } | null;
  /** 保存した投稿の数（削除やアーカイブで消えた投稿を含む） */
  mediaCount: number;
  /** 保存した日次指標の日数（`account_daily_metrics` の日付の数） */
  dailyDays: number;
}

interface StatsRow {
  total: number;
  success: number;
  warn: number;
  failed: number;
  running: number;
  failure_job: string | null;
  failure_started_at: Date | null;
  failure_error: string | null;
  consecutive: number;
  consecutive_job: string | null;
  last_success_at: Date | null;
  rate_usage: RateUsage | null;
  rate_finished_at: Date | null;
  media_count: number;
  daily_days: number;
}

/** 数字タイルと警告の値（3.6 節）。同一リクエスト内では 1 回だけ読む */
export const getJobStats = cache(async (accountId: string): Promise<QueryResult<JobStats>> => {
  await markDynamic();
  const env = readEnv();
  if (!env.ok) return { ok: false, reason: configMissingReason(env.missing) };
  try {
    const db = dbFromEnv(env.env);
    const [row] = await db<StatsRow[]>`
      with runs as (
        select * from public.job_runs
        where account_id = ${accountId}
      ),
      recent as (
        select * from runs where started_at >= now() - interval '24 hours'
      ),
      latest_failure as (
        select job_name, started_at, error from recent
        where status = 'failed'
        order by started_at desc, id desc
        limit 1
      ),
      ordered as (
        select job_name, status,
          row_number() over (partition by job_name order by started_at desc, id desc) as rn
        from runs
        where status <> 'running'
      ),
      streaks as (
        -- 最新から続く failed の数 = failed 以外の最初の行の番号 - 1（failed 以外がなければ全件）
        select job_name,
          coalesce(min(rn) filter (where status <> 'failed') - 1, count(*))::int as n
        from ordered
        group by job_name
      ),
      top_streak as (
        select job_name, n from streaks where n > 0 order by n desc, job_name limit 1
      ),
      latest_rate as (
        select rate_usage, finished_at from runs
        where rate_usage is not null
        order by started_at desc, id desc
        limit 1
      )
      select
        (select count(*) from recent)::int as total,
        (select count(*) from recent where status = 'success')::int as success,
        (select count(*) from recent where status in ('partial', 'skipped'))::int as warn,
        (select count(*) from recent where status = 'failed')::int as failed,
        (select count(*) from recent where status = 'running')::int as running,
        (select job_name from latest_failure) as failure_job,
        (select started_at from latest_failure) as failure_started_at,
        (select error from latest_failure) as failure_error,
        coalesce((select n from top_streak), 0)::int as consecutive,
        (select job_name from top_streak) as consecutive_job,
        (select max(finished_at) from runs where status = 'success') as last_success_at,
        (select rate_usage from latest_rate) as rate_usage,
        (select finished_at from latest_rate) as rate_finished_at,
        (select count(*) from public.media where account_id = ${accountId})::int as media_count,
        (
          select count(distinct metric_date) from public.account_daily_metrics where account_id = ${accountId}
        )::int as daily_days
    `;
    if (row === undefined) return { ok: false, reason: "読み出せません" };
    return {
      ok: true,
      data: {
        last24h: { total: row.total, success: row.success, warn: row.warn, failed: row.failed, running: row.running },
        latestFailure:
          row.failure_job !== null && row.failure_started_at !== null
            ? { job_name: row.failure_job, started_at: row.failure_started_at, error: row.failure_error }
            : null,
        consecutiveFailures: { count: row.consecutive, job_name: row.consecutive_job },
        lastSuccessAt: row.last_success_at,
        latestRateUsage:
          row.rate_usage === null ? null : { rate_usage: row.rate_usage, finished_at: row.rate_finished_at },
        mediaCount: row.media_count,
        dailyDays: row.daily_days,
      },
    };
  } catch (e) {
    return { ok: false, reason: describeDbError(e) };
  }
});
