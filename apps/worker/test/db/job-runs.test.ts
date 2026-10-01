import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RateUsage } from "../../src/lib/graph.js";
import { upsertAccount } from "../../src/db/accounts.js";
import { closeDb, connectDb, jsonb, type Db } from "../../src/db/client.js";
import {
  INTERRUPTED_RUN_ERROR,
  failRunningRuns,
  finishJobRun,
  getJobState,
  latestRateUsage,
  setJobState,
  startJobRun,
  tryLock,
  unlock,
} from "../../src/db/job-runs.js";
import type { JobRunRow } from "../../src/db/types.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

function fakeIgUserId(): string {
  return "000000" + Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, "0");
}

describe.skipIf(!TEST_DATABASE_URL)("db/job-runs（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  let db: Db;
  let accountId: string;

  async function readRun(id: string): Promise<JobRunRow | undefined> {
    const rows = await db<JobRunRow[]>`select * from public.job_runs where id = ${id}`;
    return rows[0];
  }

  beforeAll(async () => {
    db = connectDb(url);
    const account = await db.begin((tx) => upsertAccount(tx, { ig_user_id: fakeIgUserId() }));
    accountId = account.id;
  });

  afterAll(async () => {
    await db`delete from public.accounts where id = ${accountId}`;
    const [runs] = await db<{ n: number }[]>`
      select count(*)::int as n from public.job_runs where account_id = ${accountId}
    `;
    expect(runs?.n).toBe(0);
    await closeDb(db);
  });

  it("startJobRun → finishJobRun で status、finished_at、件数、rate_usage が入る", async () => {
    const id = await startJobRun(db, "profile_daily", accountId);
    expect(typeof id).toBe("string");

    const running = await readRun(id);
    expect(running?.status).toBe("running");
    expect(running?.job_name).toBe("profile_daily");
    expect(running?.account_id).toBe(accountId);
    expect(running?.started_at).toBeInstanceOf(Date);
    expect(running?.finished_at).toBeNull();
    expect(running?.rate_usage).toBeNull();

    const usage: RateUsage = { call_count: 3, total_cputime: 1, total_time: 2 };
    await finishJobRun(db, id, { status: "success", items_fetched: 1, api_calls: 1, rate_usage: usage });
    const finished = await readRun(id);
    expect(finished?.status).toBe("success");
    expect(finished?.finished_at).toBeInstanceOf(Date);
    expect(finished?.items_fetched).toBe(1);
    expect(finished?.api_calls).toBe(1);
    expect(finished?.error).toBeNull();
    expect(finished?.rate_usage).toEqual(usage);
  });

  it("finishJobRun は error を書け、rate_usage を省略すると null", async () => {
    const id = await startJobRun(db, "media_sync", accountId);
    await finishJobRun(db, id, { status: "partial", items_fetched: 10, api_calls: 4, error: "一部のページで失敗" });
    const row = await readRun(id);
    expect(row?.status).toBe("partial");
    expect(row?.error).toBe("一部のページで失敗");
    expect(row?.rate_usage).toBeNull();
  });

  it("skipped を開始と同時に書ける", async () => {
    const id = await startJobRun(db, "stories", accountId, { status: "skipped", error: "同じジョブが実行中" });
    const row = await readRun(id);
    expect(row?.status).toBe("skipped");
    expect(row?.error).toBe("同じジョブが実行中");
    expect(row?.finished_at).toBeInstanceOf(Date);
  });

  it("failRunningRuns は同じキーの running をすべて failed にして件数を返す", async () => {
    const a = await startJobRun(db, "media_snapshot", accountId);
    const b = await startJobRun(db, "media_snapshot", accountId);
    const other = await startJobRun(db, "account_daily", accountId);

    expect(await failRunningRuns(db, "media_snapshot", accountId)).toBe(2);
    for (const id of [a, b]) {
      const row = await readRun(id);
      expect(row?.status).toBe("failed");
      expect(row?.error).toBe(INTERRUPTED_RUN_ERROR);
      expect(row?.finished_at).toBeInstanceOf(Date);
    }
    expect((await readRun(other))?.status).toBe("running");
    expect(await failRunningRuns(db, "media_snapshot", accountId)).toBe(0);

    await finishJobRun(db, other, { status: "success", items_fetched: 0, api_calls: 0 });
  });

  it("latestRateUsage は since より古い行と rate_usage が null の行を返さない", async () => {
    const base = Date.now();
    const older: RateUsage = { call_count: 10, total_cputime: 5, total_time: 5 };
    const newer: RateUsage = { call_count: 20, total_cputime: 6, total_time: 7, estimated_time_to_regain_access: 0 };

    const olderId = await startJobRun(db, "stories", accountId);
    await finishJobRun(db, olderId, { status: "success", items_fetched: 1, api_calls: 1, rate_usage: older });
    const newerId = await startJobRun(db, "stories", accountId);
    await finishJobRun(db, newerId, { status: "success", items_fetched: 1, api_calls: 1, rate_usage: newer });
    const nullId = await startJobRun(db, "stories", accountId);
    await finishJobRun(db, nullId, { status: "failed", items_fetched: 0, api_calls: 0, rate_usage: null });

    // finished_at を未来にずらして、他のテストの行より新しくし、順序を決める
    await db`update public.job_runs set finished_at = ${new Date(base + 1 * 3_600_000)} where id = ${olderId}`;
    await db`update public.job_runs set finished_at = ${new Date(base + 2 * 3_600_000)} where id = ${newerId}`;
    await db`update public.job_runs set finished_at = ${new Date(base + 3 * 3_600_000)} where id = ${nullId}`;

    expect(await latestRateUsage(db, new Date(base))).toEqual(newer);
    expect(await latestRateUsage(db, new Date(base + 90 * 60_000))).toEqual(newer);
    expect(await latestRateUsage(db, new Date(base + 150 * 60_000))).toBeUndefined();
  });

  it("getJobState と setJobState の往復。upsert で 1 行のまま", async () => {
    interface State {
      next_date: string;
      done: boolean;
      failed_dates: { date: string; attempts: number }[];
    }
    expect(await getJobState<State>(db, accountId, "account_backfill")).toBeUndefined();

    const first: State = { next_date: "2026-09-30", done: false, failed_dates: [] };
    await setJobState(db, accountId, "account_backfill", first);
    expect(await getJobState<State>(db, accountId, "account_backfill")).toEqual(first);

    const second: State = { next_date: "2026-09-29", done: true, failed_dates: [{ date: "2026-09-30", attempts: 1 }] };
    await setJobState(db, accountId, "account_backfill", second);
    expect(await getJobState<State>(db, accountId, "account_backfill")).toEqual(second);

    const [count] = await db<{ n: number }[]>`
      select count(*)::int as n from public.job_state
      where account_id = ${accountId} and job_name = 'account_backfill'
    `;
    expect(count?.n).toBe(1);
    expect(await getJobState<State>(db, accountId, "media_sync")).toBeUndefined();
  });

  it("tryLock を取ると別の接続では取れず、unlock 後に取れる。保持中も同じ Db のもう 1 本でクエリと begin が完了する", async () => {
    const conn = await db.reserve();
    const db2 = connectDb(url);
    const conn2 = await db2.reserve();
    try {
      expect(await tryLock(conn, "stories", accountId)).toBe(true);
      expect(await tryLock(conn2, "stories", accountId)).toBe(false);
      // 別のキー（別のジョブ名）は取れる
      expect(await tryLock(conn2, "media_sync", accountId)).toBe(true);
      await unlock(conn2, "media_sync", accountId);

      // ロック保持中、同じ Db（max: 2）の残り 1 本で通常のクエリと begin が完了する
      const [plain] = await db<{ n: number }[]>`select 1 as n`;
      expect(plain?.n).toBe(1);
      const inTx = await db.begin(async (tx) => {
        const [row] = await tx<{ n: number }[]>`select 2 as n`;
        return row?.n;
      });
      expect(inTx).toBe(2);

      // 同時に投げても直列に処理されて完了する
      const [concurrentPlain, concurrentTx] = await Promise.all([
        db<{ n: number }[]>`select 3 as n`.then((rows) => rows[0]?.n),
        db.begin(async (tx) => {
          const [row] = await tx<{ n: number }[]>`select 4 as n`;
          return row?.n;
        }),
      ]);
      expect(concurrentPlain).toBe(3);
      expect(concurrentTx).toBe(4);

      await unlock(conn, "stories", accountId);
      expect(await tryLock(conn2, "stories", accountId)).toBe(true);
      expect(await tryLock(conn, "stories", accountId)).toBe(false);
      await unlock(conn2, "stories", accountId);
      expect(await tryLock(conn, "stories", accountId)).toBe(true);
      await unlock(conn, "stories", accountId);
    } finally {
      conn.release();
      conn2.release();
      await closeDb(db2);
    }
  });

  it("finishJobRun の rate_usage: null は SQL の NULL になる", async () => {
    const id = await startJobRun(db, "token_check", accountId);
    await finishJobRun(db, id, { status: "success", items_fetched: 1, api_calls: 1, rate_usage: null });
    const [row] = await db<{ is_null: boolean }[]>`
      select rate_usage is null as is_null from public.job_runs where id = ${id}
    `;
    expect(row?.is_null).toBe(true);
  });

  it("latestRateUsage は running（finished_at が null）の行を返さない", async () => {
    const id = await startJobRun(db, "account_backfill", accountId);
    const marker: RateUsage = { call_count: 999, total_cputime: 99, total_time: 99 };
    // running のまま rate_usage だけ入れる（finished_at は null のまま）。
    // NULL は order by desc で先頭に並ぶので、finished_at の絞り込みがなければこの行が返る
    await db`update public.job_runs set rate_usage = ${jsonb(db, marker)} where id = ${id}`;
    const latest = await latestRateUsage(db, new Date(0));
    expect(latest?.call_count).not.toBe(999);
    await finishJobRun(db, id, { status: "success", items_fetched: 0, api_calls: 0 });
  });

  it("latestRateUsage は api_calls = 0 で rate_usage がある行（API を呼ばずに見送った実行）を返さない", async () => {
    const base = Date.now();
    const id = await startJobRun(db, "media_snapshot", accountId);
    const marker: RateUsage = { call_count: 888, total_cputime: 88, total_time: 88 };
    await finishJobRun(db, id, { status: "skipped", items_fetched: 0, api_calls: 0, rate_usage: marker });
    // 他のテストの行より新しくする
    await db`update public.job_runs set finished_at = ${new Date(base + 10 * 3_600_000)} where id = ${id}`;

    const latest = await latestRateUsage(db, new Date(base));
    expect(latest?.call_count).not.toBe(888);
    // since をこの行だけが満たす時刻にすると、何も返らない
    expect(await latestRateUsage(db, new Date(base + 9 * 3_600_000))).toBeUndefined();
  });

  it("同じセッションでは tryLock が再入でき（2 回とも true）、unlock も同じ回数要る", async () => {
    const conn = await db.reserve();
    const db2 = connectDb(url);
    const conn2 = await db2.reserve();
    try {
      expect(await tryLock(conn, "token_check", accountId)).toBe(true);
      expect(await tryLock(conn, "token_check", accountId)).toBe(true);
      expect(await tryLock(conn2, "token_check", accountId)).toBe(false);

      await unlock(conn, "token_check", accountId);
      expect(await tryLock(conn2, "token_check", accountId)).toBe(false);

      await unlock(conn, "token_check", accountId);
      expect(await tryLock(conn2, "token_check", accountId)).toBe(true);
      await unlock(conn2, "token_check", accountId);
    } finally {
      conn.release();
      conn2.release();
      await closeDb(db2);
    }
  });
});
