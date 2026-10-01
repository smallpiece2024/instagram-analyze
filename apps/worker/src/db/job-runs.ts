/**
 * `job_runs`、`job_state`、アドバイザリロック（設計 1.2 章、3.4 章、6.2 章）。
 *
 * - `job_runs` の insert と update は自動コミット（トランザクションの外）で行い、途中で落ちても
 *   `running` → `failed` の記録が残るようにする
 * - ロックは `db.reserve()` で固定した 1 本の接続（`ReservedSql`）で取り、ジョブの間その接続を保持する。
 *   セッション単位のロックなので、プロセスが落ちて接続が切れれば自動で外れる。
 *   `max: 2` のため、ロック保持中にジョブが使える接続は残り 1 本。`db.begin` の中で `db` を使うと
 *   空き接続を待ち続けるので、`tx` だけを使うこと
 */
import type { RateUsage } from "../lib/graph.js";
import { jsonb, type Db, type ReservedSql } from "./client.js";
import type { JobName, JobStatus } from "./types.js";

/** `failRunningRuns` が `job_runs.error` に入れる固定文言 */
export const INTERRUPTED_RUN_ERROR = "中断（プロセスが終了した）";

export interface JobRunResult {
  status: Exclude<JobStatus, "running">;
  items_fetched: number;
  api_calls: number;
  /** 省略か null なら null */
  error?: string | null;
  /** 省略か null なら null */
  rate_usage?: RateUsage | null;
}

/**
 * `running` の行を insert して id を返す。
 * `init` があれば（二重起動の見送りなど）、`status`、`error`、`finished_at = now()` も同時に書く
 */
export async function startJobRun(
  db: Db,
  jobName: JobName,
  accountId: string,
  init?: { status: "skipped"; error: string },
): Promise<string> {
  const rows = init
    ? await db<{ id: string }[]>`
        insert into public.job_runs (job_name, account_id, status, error, finished_at)
        values (${jobName}, ${accountId}, ${init.status}, ${init.error}, now())
        returning id
      `
    : await db<{ id: string }[]>`
        insert into public.job_runs (job_name, account_id)
        values (${jobName}, ${accountId})
        returning id
      `;
  const row = rows[0];
  if (!row) throw new Error("job_runs の insert が id を返さなかった");
  return row.id;
}

/** 終了時の記録。`finished_at = now()` */
export async function finishJobRun(db: Db, id: string, r: JobRunResult): Promise<void> {
  await db`
    update public.job_runs set
      status = ${r.status},
      finished_at = now(),
      items_fetched = ${r.items_fetched},
      api_calls = ${r.api_calls},
      error = ${r.error ?? null},
      rate_usage = ${jsonb(db, r.rate_usage ?? null)}
    where id = ${id}
  `;
}

/**
 * 同じ `job_name` と `account_id` で `running` のままの行をすべて `failed` にする（取り残しの整理）。
 * ロックを取った直後に呼ぶ。更新した件数を返す
 */
export async function failRunningRuns(db: Db, jobName: JobName, accountId: string): Promise<number> {
  const result = await db`
    update public.job_runs set
      status = 'failed',
      error = ${INTERRUPTED_RUN_ERROR},
      finished_at = now()
    where job_name = ${jobName} and account_id = ${accountId} and status = 'running'
  `;
  return result.count;
}

/**
 * `finished_at >= since` で `rate_usage` が入っていて、API を 1 回以上呼んだ（`api_calls > 0`）最新の 1 行。
 * アカウントやジョブで絞らない。
 * API を呼ばずに見送った実行（前回の値を書き戻しただけの行）を拾い続けると、しきい値を超えたまま収集が
 * 自己回復しないため、`api_calls > 0` で除く（枠組み側の「`api_calls = 0` なら `rate_usage` を書き戻さない」との二重の防御）
 */
export async function latestRateUsage(db: Db, since: Date): Promise<RateUsage | undefined> {
  const rows = await db<{ rate_usage: RateUsage }[]>`
    select rate_usage from public.job_runs
    where finished_at is not null and finished_at >= ${since} and rate_usage is not null and api_calls > 0
    order by finished_at desc
    limit 1
  `;
  return rows[0]?.rate_usage;
}

/** `job_state.state`。行がなければ undefined。型は呼び出し側が指定する（検証はしない） */
export async function getJobState<T>(db: Db, accountId: string, jobName: JobName): Promise<T | undefined> {
  const rows = await db<{ state: unknown }[]>`
    select state from public.job_state where account_id = ${accountId} and job_name = ${jobName}
  `;
  const row = rows[0];
  return row === undefined ? undefined : (row.state as T);
}

/** `job_state` を upsert する。`updated_at` はトリガーが更新する */
export async function setJobState<T>(db: Db, accountId: string, jobName: JobName, state: T): Promise<void> {
  await db`
    insert into public.job_state (account_id, job_name, state)
    values (${accountId}, ${jobName}, ${jsonb(db, state)})
    on conflict (account_id, job_name) do update set state = excluded.state
  `;
}

/**
 * アドバイザリロック（2 キー版）を試みる。取れたら true。
 * 同じセッションで 2 回取ると 2 回とも true になり、`unlock` も 2 回要る（Postgres の仕様）
 */
export async function tryLock(conn: ReservedSql, jobName: JobName, accountId: string): Promise<boolean> {
  const rows = await conn<{ locked: boolean }[]>`
    select pg_try_advisory_lock(hashtext(${jobName}), hashtext(${accountId})) as locked
  `;
  return rows[0]?.locked === true;
}

/** `tryLock` と同じ接続で呼ぶ。持っていないロックを外そうとしても例外にはならない（Postgres は警告を出すだけ） */
export async function unlock(conn: ReservedSql, jobName: JobName, accountId: string): Promise<void> {
  await conn`select pg_advisory_unlock(hashtext(${jobName}), hashtext(${accountId}))`;
}
