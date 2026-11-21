/**
 * `db/capacity.ts` の結合テスト（課題 ia-6ui。マイグレーション `20261121000000_capacity_alerts.sql`）。
 * 本物の DB（ローカル Supabase）で、容量の読み出し、pg_cron のジョブの文、ビュー `collect_run_durations` の
 * 「5 分の区切り」を確かめる。
 *
 * 手元の DB には実データが入っていて、常駐のワーカーも同じ DB で動く。架空の `job_runs` と `capacity_daily` への書き込みは
 * トランザクションの中で行い、最後に必ずロールバックする（他の接続からは見えず、後始末の取りこぼしもない）。
 * 架空の行は未来の時刻に置く（実データより後ろに並ぶので、実データの回と混ざらず、最新の回になる）
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { latestRunDurationSeconds, readCapacity } from "../../src/db/capacity.js";
import { closeDb, connectDb, type Db, type Tx } from "../../src/db/client.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const SECOND_MS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** 架空の実行の `job_name`（実在のジョブ名と重ならない） */
const FAKE_JOB_NAME = "capacity_test_fake";

/** ロールバックの合図（`db.begin` の中で投げると、その中の書き込みがすべて取り消される） */
class Rollback extends Error {}

interface DurationRow {
  began_at: Date;
  ended_at: Date;
  seconds: number;
  job_count: number;
}

describe.skipIf(!TEST_DATABASE_URL)("db/capacity（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  let db: Db;

  /** `fn` をトランザクションの中で動かし、必ずロールバックする */
  async function inRollback(fn: (tx: Tx) => Promise<void>): Promise<void> {
    await expect(
      db.begin(async (tx) => {
        await fn(tx);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  }

  /** 架空の実行を 1 件入れる。`base` からの秒で開始と終了を指定する。`endSeconds` が null なら終わっていない行 */
  async function addRun(tx: Tx, base: Date, startSeconds: number, endSeconds: number | null): Promise<void> {
    const startedAt = new Date(base.getTime() + startSeconds * SECOND_MS);
    const finishedAt = endSeconds === null ? null : new Date(base.getTime() + endSeconds * SECOND_MS);
    await tx`
      insert into public.job_runs (job_name, account_id, started_at, finished_at, status)
      values (${FAKE_JOB_NAME}, null, ${startedAt}, ${finishedAt}, ${endSeconds === null ? "running" : "success"})
    `;
  }

  async function durationsFrom(tx: Tx, base: Date): Promise<DurationRow[]> {
    return tx<DurationRow[]>`
      select began_at, ended_at, duration_seconds::float8 as seconds, job_count
      from public.collect_run_durations
      where began_at >= ${base}
      order by began_at
    `;
  }

  beforeAll(() => {
    db = connectDb(url);
  });

  afterAll(async () => {
    // ロールバックしたので、架空の行は残っていない
    const [rest] = await db<{ n: number }[]>`select count(*)::int as n from public.job_runs where job_name = ${FAKE_JOB_NAME}`;
    expect(rest?.n).toBe(0);
    await closeDb(db);
  });

  it("readCapacity は DB と Storage の今の容量を number で返す", async () => {
    const capacity = await readCapacity(db);
    expect(Number.isSafeInteger(capacity.dbBytes)).toBe(true);
    expect(Number.isSafeInteger(capacity.storageBytes)).toBe(true);
    expect(Number.isSafeInteger(capacity.storageObjects)).toBe(true);
    // 空の DB でも数 MB はある
    expect(capacity.dbBytes).toBeGreaterThan(1024 * 1024);
    expect(capacity.storageBytes).toBeGreaterThanOrEqual(0);
    expect(capacity.storageObjects).toBeGreaterThanOrEqual(0);
    const [objects] = await db<{ n: number }[]>`select count(*)::int as n from storage.objects`;
    // 常駐のワーカーが間に保存することがあるので、件数は下限だけを見る
    expect(objects?.n).toBeGreaterThanOrEqual(capacity.storageObjects);
  });

  it("pg_cron のジョブ capacity-daily が毎日 1 回で登録され、その文は今日（UTC）の行を upsert する", async () => {
    const [job] = await db<{ schedule: string; command: string; active: boolean }[]>`
      select schedule, command, active from cron.job where jobname = 'capacity-daily'
    `;
    expect(job?.schedule).toBe("7 15 * * *");
    expect(job?.active).toBe(true);
    await inRollback(async (tx) => {
      await tx`delete from public.capacity_daily where captured_on = (now() at time zone 'utc')::date`;
      // 2 回流しても 1 行（on conflict do update）
      await tx.unsafe(job?.command ?? "");
      await tx.unsafe(job?.command ?? "");
      const rows = await tx<{ db_bytes: string; storage_bytes: string; storage_objects: number }[]>`
        select db_bytes, storage_bytes, storage_objects from public.capacity_daily
        where captured_on = (now() at time zone 'utc')::date
      `;
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]?.db_bytes)).toBeGreaterThan(1024 * 1024);
      expect(Number(rows[0]?.storage_bytes)).toBeGreaterThanOrEqual(0);
    });
  });

  it("collect_run_durations: 間が 5 分ちょうどまでは同じ回、5 分を超えたら新しい回。終わっていない行は入らない", async () => {
    const base = new Date(Date.now() + 10 * DAY_MS);
    await inRollback(async (tx) => {
      // 1 回目: 0〜60、62〜120、420（120 + 300 ちょうど）〜450 → 3 件で 450 秒
      await addRun(tx, base, 0, 60);
      await addRun(tx, base, 62, 120);
      await addRun(tx, base, 420, 450);
      // 2 回目: 751（450 + 301）〜771 → 1 件で 20 秒
      await addRun(tx, base, 751, 771);
      // 終わっていない行（2 回目の直後に始まった）は数えない
      await addRun(tx, base, 772, null);

      const rows = await durationsFrom(tx, base);
      expect(rows.map((row) => ({ seconds: row.seconds, job_count: row.job_count }))).toEqual([
        { seconds: 450, job_count: 3 },
        { seconds: 20, job_count: 1 },
      ]);
      expect(rows[0]?.began_at.getTime()).toBe(base.getTime());
      expect(rows[0]?.ended_at.getTime()).toBe(base.getTime() + 450 * SECOND_MS);
      expect(rows[1]?.began_at.getTime()).toBe(base.getTime() + 751 * SECOND_MS);

      // 最新の回は 2 回目
      await expect(latestRunDurationSeconds(tx)).resolves.toBe(20);
    });
  });

  it("collect_run_durations: 重なって動いた行があっても回は割れない（それまでの finished_at の最大から測る）", async () => {
    const base = new Date(Date.now() + 20 * DAY_MS);
    await inRollback(async (tx) => {
      // 長い行 0〜400 の途中で、短い行 10〜20 が終わり、331（20 + 311）に次が始まる。長い行がまだ動いているので同じ回
      await addRun(tx, base, 0, 400);
      await addRun(tx, base, 10, 20);
      await addRun(tx, base, 331, 1000);
      const rows = await durationsFrom(tx, base);
      expect(rows.map((row) => ({ seconds: row.seconds, job_count: row.job_count }))).toEqual([{ seconds: 1000, job_count: 3 }]);
      // 15 分（900 秒）を超える所要がそのまま読める
      await expect(latestRunDurationSeconds(tx)).resolves.toBe(1000);
    });
  });

  it("collect_run_durations: 35 日より古い行は入らない", async () => {
    const old = new Date(Date.now() - 36 * DAY_MS);
    await inRollback(async (tx) => {
      const [before] = await tx<{ n: number }[]>`select count(*)::int as n from public.collect_run_durations`;
      await addRun(tx, old, 0, 60);
      const [after] = await tx<{ n: number }[]>`select count(*)::int as n from public.collect_run_durations`;
      expect(after?.n).toBe(before?.n);
    });
  });

  it("latestRunDurationSeconds は number か undefined を返す（手元の実データ）", async () => {
    const seconds = await latestRunDurationSeconds(db);
    if (seconds !== undefined) {
      expect(typeof seconds).toBe("number");
      expect(seconds).toBeGreaterThanOrEqual(0);
    }
  });
});
