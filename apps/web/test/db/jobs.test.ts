/**
 * `queries/connection-status.ts` と `queries/jobs.ts` の結合テスト（R1 設計 4.3 章、R3 設計 3.6 節、4.5 節）と、
 * `/jobs` の収集スケジュールの純粋関数（`app/jobs/_components/schedule.ts`）の単体テスト。
 * 結合テストは `TEST_DATABASE_URL` があるときだけ動く。架空のアカウント 2 件（ig_user_id の先頭 6 桁が 0。1 件は認証情報、
 * 実行記録、投稿、日次指標つき、1 件は name も認証情報もなし）を作り、`afterAll` でアカウントを消す
 * （カスケードで関連行と Vault の秘密も消える）。
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ALERT_FAILED_RUNS,
  earliestExpiry,
  expiryState,
  JOB_SCHEDULE,
  nextCollectAt,
  runState,
} from "@/app/jobs/_components/schedule";
import { closeAllDb } from "@/lib/db";
import { JOB_ORDER } from "@/lib/format";
import { getConnectionStatus } from "@/lib/queries/connection-status";
import { getJobStats, getLatestRuns, listRecentRuns, RUNS_PAGE_SIZE } from "@/lib/queries/jobs";
import { DAY_MS, fakeIgUserId, fakeMediaId, HOUR_MS, MINUTE_MS, setWebEnv } from "./fixtures";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe("jobs/_components/schedule（純粋関数）", () => {
  it("JOB_SCHEDULE は JOB_ORDER と同じジョブの一覧", () => {
    expect(Object.keys(JOB_SCHEDULE).sort()).toEqual([...JOB_ORDER].sort());
    expect(ALERT_FAILED_RUNS).toBe(2);
  });

  it("nextCollectAt: now より後の、UTC の分が 17 の時刻", () => {
    expect(nextCollectAt(new Date("2026-10-05T03:10:00Z")).toISOString()).toBe("2026-10-05T03:17:00.000Z");
    expect(nextCollectAt(new Date("2026-10-05T03:17:00Z")).toISOString()).toBe("2026-10-05T04:17:00.000Z");
    expect(nextCollectAt(new Date("2026-10-05T23:40:30Z")).toISOString()).toBe("2026-10-06T00:17:00.000Z");
  });

  it("runState: 見本の 3 段階と実行中に寄せる", () => {
    expect(runState("success")).toEqual({ state: "ok", label: "成功" });
    expect(runState("partial")).toEqual({ state: "warn", label: "注意" });
    expect(runState("skipped")).toEqual({ state: "warn", label: "注意" });
    expect(runState("failed")).toEqual({ state: "bad", label: "失敗" });
    expect(runState("running")).toEqual({ state: "run", label: "実行中" });
  });

  it("expiryState: 14 日前から注意、7 日前から重大", () => {
    expect(expiryState(14)).toBe("ok");
    expect(expiryState(13)).toBe("warn");
    expect(expiryState(7)).toBe("warn");
    expect(expiryState(6)).toBe("bad");
    expect(expiryState(-1)).toBe("bad");
  });

  it("earliestExpiry: 早いほう。片方が null ならもう片方", () => {
    const a = new Date("2026-10-10T00:00:00Z");
    const b = new Date("2026-12-01T00:00:00Z");
    expect(earliestExpiry(a, b)).toBe(a);
    expect(earliestExpiry(b, a)).toBe(a);
    expect(earliestExpiry(null, b)).toBe(b);
    expect(earliestExpiry(a, null)).toBe(a);
    expect(earliestExpiry(null, null)).toBeNull();
  });
});

describe.skipIf(!TEST_DATABASE_URL)("queries/jobs と connection-status（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  const igUserId = fakeIgUserId();
  const igUserId2 = fakeIgUserId();
  const now = new Date();
  const t0 = new Date(now.getTime() - 6 * HOUR_MS);
  const mediaSyncFinished = new Date(t0.getTime() + 1 * HOUR_MS);
  const tokenCheckFinished = new Date(t0.getTime() + 2 * HOUR_MS);
  const storiesStarted = new Date(t0.getTime() + 2 * HOUR_MS + 30 * MINUTE_MS);
  const storiesFinished = new Date(t0.getTime() + 2 * HOUR_MS + 31 * MINUTE_MS);
  // 24 時間より前の stories の失敗（連続失敗には数え、24 時間の集計には数えない）
  const oldStoriesStarted = new Date(now.getTime() - 30 * HOUR_MS);
  const runningStarted = new Date(t0.getTime() + 3 * HOUR_MS);
  const partialStarted = new Date(t0.getTime() + 3 * HOUR_MS + 30 * MINUTE_MS);
  const partialFinished = new Date(t0.getTime() + 3 * HOUR_MS + 31 * MINUTE_MS);
  const rateUsage = { call_count: 1, total_cputime: 2, total_time: 3, estimated_time_to_regain_access: 12 };
  let sql: postgres.Sql;
  let accountId = "";
  let accountId2 = "";
  let restoreEnv: () => void = () => {};

  beforeAll(async () => {
    restoreEnv = setWebEnv(url);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    const [account] = await sql<{ id: string }[]>`
      insert into public.accounts (ig_user_id, username, name)
      values (${igUserId}, 'fake_web_user', 'Fake Web')
      returning id
    `;
    accountId = account?.id ?? "";
    expect(accountId).not.toBe("");
    const [account2] = await sql<{ id: string }[]>`
      insert into public.accounts (ig_user_id, username, name)
      values (${igUserId2}, 'fake_web_user_2', null)
      returning id
    `;
    accountId2 = account2?.id ?? "";
    expect(accountId2).not.toBe("");

    const [secret] = await sql<{ id: string }[]>`
      select vault.create_secret('fake-token', ${`ig-token-${accountId}`}, 'test') as id
    `;
    await sql`
      insert into private.credentials
        (account_id, token_type, token_secret_id, expires_at, data_access_expires_at, scopes, status, last_checked_at)
      values
        (${accountId}, 'PAGE', ${secret?.id ?? ""}, null, ${new Date(now.getTime() + 90 * DAY_MS)},
         ${sql.array(["instagram_basic", "instagram_manage_insights"])}, 'valid', now())
    `;
    // media_sync の成功より後に token_check の成功、stories の失敗、media_snapshot の実行中を置く
    await sql`
      insert into public.job_runs (job_name, account_id, started_at, finished_at, status, items_fetched, api_calls, error, rate_usage)
      values
        ('media_sync', ${accountId}, ${t0}, ${mediaSyncFinished}, 'success', 3, 2, null, ${sql.json(rateUsage)}),
        ('token_check', ${accountId}, ${t0}, ${tokenCheckFinished}, 'success', 0, 1, null, null),
        ('stories', ${accountId}, ${oldStoriesStarted}, ${new Date(oldStoriesStarted.getTime() + MINUTE_MS)}, 'failed', 0, 1, '古い失敗', null),
        ('stories', ${accountId}, ${storiesStarted}, ${storiesFinished}, 'failed', 0, 1, 'テスト用の失敗', null),
        ('media_snapshot', ${accountId}, ${runningStarted}, null, 'running', null, null, null, null)
    `;
    await sql`
      insert into public.media (id, account_id, media_type, media_product_type, posted_at)
      values
        (${fakeMediaId(1)}, ${accountId}, 'IMAGE', 'FEED', ${t0}),
        (${fakeMediaId(2)}, ${accountId}, 'VIDEO', 'REELS', ${t0})
    `;
    await sql`
      insert into public.account_daily_metrics (account_id, metric_date, metric, breakdown, breakdown_value, value)
      values
        (${accountId}, '2026-09-01', 'reach', '', '', 100),
        (${accountId}, '2026-09-01', 'views', '', '', 150),
        (${accountId}, '2026-09-02', 'reach', '', '', 200)
    `;
  });

  afterAll(async () => {
    for (const id of [accountId, accountId2]) {
      if (id === "") continue;
      await sql`delete from public.accounts where id = ${id}`;
      const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from vault.secrets where name = ${`ig-token-${id}`}
      `;
      expect(row?.n).toBe(0);
    }
    await closeAllDb();
    await sql.end({ timeout: 5 });
    restoreEnv();
  });

  it("getConnectionStatus: 対象のアカウント 1 件。accounts.name を補い、最終収集は token_check と失敗・実行中を除く。partial は含む", async () => {
    const result = await getConnectionStatus(accountId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const s = result.data;
    expect(s).not.toBeNull();
    if (s === null) return;
    expect(s.account_id).toBe(accountId);
    expect(s.username).toBe("fake_web_user");
    expect(s.name).toBe("Fake Web");
    expect(s.account_status).toBe("active");
    expect(s.token_type).toBe("PAGE");
    expect(s.token_expires_at).toBeNull();
    expect(s.data_access_expires_at).toBeInstanceOf(Date);
    expect(s.scopes).toEqual(["instagram_basic", "instagram_manage_insights"]);
    expect(s.credential_status).toBe("valid");
    expect(s.last_checked_at).toBeInstanceOf(Date);
    expect(s.last_error).toBeNull();
    // token_check（後の成功）、stories（後の失敗）、media_snapshot（実行中）があっても media_sync の時刻
    expect(s.last_collected_at?.getTime()).toBe(mediaSyncFinished.getTime());

    // name も認証情報もないアカウント
    const r2 = await getConnectionStatus(accountId2);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    const s2 = r2.data;
    expect(s2?.account_id).toBe(accountId2);
    expect(s2?.username).toBe("fake_web_user_2");
    expect(s2?.name).toBeNull();
    expect(s2?.token_type).toBeNull();
    expect(s2?.scopes).toBeNull();
    expect(s2?.credential_status).toBeNull();
    expect(s2?.last_collected_at).toBeNull();

    // 存在しないアカウントは null（ほかのアカウントを返さない）
    const none = await getConnectionStatus(randomUUID());
    expect(none).toEqual({ ok: true, data: null });

    // partial を最後に入れると最終収集に含まれる
    await sql`
      insert into public.job_runs (job_name, account_id, started_at, finished_at, status, items_fetched, api_calls, error)
      values ('account_backfill', ${accountId}, ${partialStarted}, ${partialFinished}, 'partial', 5, 6, '一部失敗')
    `;
    const after = await getConnectionStatus(accountId);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.data?.last_collected_at?.getTime()).toBe(partialFinished.getTime());
  });

  it("getLatestRuns: 対象のアカウントだけ、実行順に並び、数値と JSON の型が合う", async () => {
    const result = await getLatestRuns(accountId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.every((r) => r.account_id === accountId)).toBe(true);
    const mine = result.data;
    expect(mine.map((r) => r.job_name)).toEqual(["token_check", "media_sync", "media_snapshot", "stories", "account_backfill"]);
    const mediaSync = mine[1];
    expect(typeof mediaSync?.id).toBe("string");
    expect(mediaSync?.items_fetched).toBe(3);
    expect(mediaSync?.api_calls).toBe(2);
    expect(mediaSync?.rate_usage).toEqual(rateUsage);
    expect(mediaSync?.started_at).toBeInstanceOf(Date);
    expect(mediaSync?.finished_at?.getTime()).toBe(mediaSyncFinished.getTime());
    const running = mine[2];
    expect(running?.status).toBe("running");
    expect(running?.finished_at).toBeNull();
    expect(running?.items_fetched).toBeNull();
    // stories は新しいほう
    expect(mine[3]?.error).toBe("テスト用の失敗");
    expect(mine[3]?.rate_usage).toBeNull();
    expect(mine[4]?.status).toBe("partial");

    const empty = await getLatestRuns(accountId2);
    expect(empty).toEqual({ ok: true, data: [] });
  });

  it("listRecentRuns: 対象のアカウントだけ、新しい順。job と status の絞り込み、ページの丸め", async () => {
    const all = await listRecentRuns(accountId, { page: 1 });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.data.total).toBe(6);
    expect(all.data.page).toBe(1);
    expect(all.data.pageCount).toBe(1);
    expect(all.data.rows).toHaveLength(6);
    expect(all.data.rows.every((r) => r.account_id === accountId)).toBe(true);
    for (let i = 1; i < all.data.rows.length; i += 1) {
      const prev = all.data.rows[i - 1];
      const cur = all.data.rows[i];
      if (prev && cur) expect(prev.started_at.getTime()).toBeGreaterThanOrEqual(cur.started_at.getTime());
    }

    const stories = await listRecentRuns(accountId, { job: "stories", page: 1 });
    expect(stories.ok && stories.data.rows.map((r) => r.error)).toEqual(["テスト用の失敗", "古い失敗"]);

    const failed = await listRecentRuns(accountId, { status: "failed", page: 1 });
    expect(failed.ok && failed.data.total).toBe(2);
    expect(failed.ok && failed.data.rows.every((r) => r.status === "failed")).toBe(true);

    const both = await listRecentRuns(accountId, { job: "media_sync", status: "failed", page: 1 });
    expect(both.ok && both.data).toEqual({ rows: [], total: 0, page: 1, pageCount: 1 });

    // 総ページ数を超えたページは最後のページに丸める
    const far = await listRecentRuns(accountId, { page: 99 });
    expect(far.ok && far.data.page).toBe(1);
    expect(far.ok && far.data.rows).toHaveLength(6);
    expect(RUNS_PAGE_SIZE).toBe(50);

    const other = await listRecentRuns(accountId2, { page: 1 });
    expect(other.ok && other.data).toEqual({ rows: [], total: 0, page: 1, pageCount: 1 });
  });

  it("getJobStats: 24 時間の内訳、最新の失敗、連続失敗、最終成功、API 使用率、投稿と日次指標の数", async () => {
    const result = await getJobStats(accountId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const s = result.data;
    // 24 時間より前の stories の失敗は数えない
    expect(s.last24h).toEqual({ total: 5, success: 2, warn: 1, failed: 1, running: 1 });
    expect(s.latestFailure?.job_name).toBe("stories");
    expect(s.latestFailure?.started_at.getTime()).toBe(storiesStarted.getTime());
    expect(s.latestFailure?.error).toBe("テスト用の失敗");
    expect(s.consecutiveFailures).toEqual({ count: 2, job_name: "stories" });
    expect(s.lastSuccessAt?.getTime()).toBe(tokenCheckFinished.getTime());
    expect(s.latestRateUsage?.rate_usage).toEqual(rateUsage);
    expect(s.latestRateUsage?.finished_at?.getTime()).toBe(mediaSyncFinished.getTime());
    expect(s.mediaCount).toBe(2);
    expect(s.dailyDays).toBe(2);

    // 実行記録のないアカウント
    const empty = await getJobStats(accountId2);
    expect(empty).toEqual({
      ok: true,
      data: {
        last24h: { total: 0, success: 0, warn: 0, failed: 0, running: 0 },
        latestFailure: null,
        consecutiveFailures: { count: 0, job_name: null },
        lastSuccessAt: null,
        latestRateUsage: null,
        mediaCount: 0,
        dailyDays: 0,
      },
    });
  });

  it("設定が足りなければ変数名だけの固定文言", async () => {
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "";
    try {
      const result = await getConnectionStatus(accountId);
      expect(result).toEqual({ ok: false, reason: "設定が足りません（DATABASE_URL）" });
    } finally {
      process.env.DATABASE_URL = saved;
    }
  });

  it("DB に繋がらなければ固定文言（接続先を含まない）", async () => {
    const saved = process.env.DATABASE_URL;
    const bad = "postgresql://postgres:postgres@127.0.0.1:1/postgres";
    process.env.DATABASE_URL = bad;
    try {
      for (const result of [await getLatestRuns(accountId), await getJobStats(accountId)]) {
        expect(result.ok).toBe(false);
        if (result.ok) continue;
        expect(result.reason).toMatch(/^DB 接続に失敗（[A-Z_]+）$/);
        expect(result.reason).not.toContain("127.0.0.1");
        expect(result.reason).not.toContain("postgres");
      }
    } finally {
      process.env.DATABASE_URL = saved;
    }
  });
});
