/**
 * `queries/connection-status.ts` と `queries/jobs.ts` の結合テスト（R1 設計 4.3 章。R3 段階 0 で `queries.test.ts` から分けた）。
 * `TEST_DATABASE_URL` があるときだけ動く。架空のアカウント 2 件（ig_user_id の先頭 6 桁が 0。1 件は認証情報つき、
 * 1 件は name も認証情報もなし）と実行記録を作り、`afterAll` でアカウントを消す（カスケードで関連行と Vault の秘密も消える）。
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllDb } from "@/lib/db";
import { getConnectionStatus } from "@/lib/queries/connection-status";
import { getLatestRuns, listRecentRuns, RECENT_RUNS_LIMIT } from "@/lib/queries/jobs";
import { DAY_MS, fakeIgUserId, HOUR_MS, MINUTE_MS, setWebEnv } from "./fixtures";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

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
        ('stories', ${accountId}, ${storiesStarted}, ${storiesFinished}, 'failed', 0, 1, 'テスト用の失敗', null),
        ('media_snapshot', ${accountId}, ${runningStarted}, null, 'running', null, null, null, null)
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

  it("getConnectionStatus: accounts.name を補い、最終収集は token_check と失敗・実行中を除く。partial は含む", async () => {
    const result = await getConnectionStatus();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const s = result.data.find((r) => r.account_id === accountId);
    expect(s).toBeDefined();
    if (!s) return;
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
    const s2 = result.data.find((r) => r.account_id === accountId2);
    expect(s2).toBeDefined();
    if (!s2) return;
    expect(s2.username).toBe("fake_web_user_2");
    expect(s2.name).toBeNull();
    expect(s2.token_type).toBeNull();
    expect(s2.scopes).toBeNull();
    expect(s2.credential_status).toBeNull();
    expect(s2.last_collected_at).toBeNull();

    // partial を最後に入れると最終収集に含まれる
    await sql`
      insert into public.job_runs (job_name, account_id, started_at, finished_at, status, items_fetched, api_calls, error)
      values ('account_backfill', ${accountId}, ${partialStarted}, ${partialFinished}, 'partial', 5, 6, '一部失敗')
    `;
    const after = await getConnectionStatus();
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.data.find((r) => r.account_id === accountId)?.last_collected_at?.getTime()).toBe(partialFinished.getTime());
  });

  it("getLatestRuns: 実行順に並び、数値と JSON の型が合う", async () => {
    const result = await getLatestRuns();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mine = result.data.filter((r) => r.account_id === accountId);
    expect(mine.map((r) => r.job_name)).toEqual(["token_check", "media_sync", "media_snapshot", "stories", "account_backfill"]);
    const mediaSync = mine[1];
    expect(typeof mediaSync?.id).toBe("string");
    expect(mediaSync?.username).toBe("fake_web_user");
    expect(mediaSync?.items_fetched).toBe(3);
    expect(mediaSync?.api_calls).toBe(2);
    expect(mediaSync?.rate_usage).toEqual(rateUsage);
    expect(mediaSync?.started_at).toBeInstanceOf(Date);
    expect(mediaSync?.finished_at?.getTime()).toBe(mediaSyncFinished.getTime());
    const running = mine[2];
    expect(running?.status).toBe("running");
    expect(running?.finished_at).toBeNull();
    expect(running?.items_fetched).toBeNull();
    expect(mine[3]?.error).toBe("テスト用の失敗");
    expect(mine[3]?.rate_usage).toBeNull();
    expect(mine[4]?.status).toBe("partial");
  });

  it("listRecentRuns: 絞り込みと上限", async () => {
    const stories = await listRecentRuns("stories");
    expect(stories.ok).toBe(true);
    if (!stories.ok) return;
    expect(stories.data.every((r) => r.job_name === "stories")).toBe(true);
    expect(stories.data.some((r) => r.account_id === accountId)).toBe(true);

    const all = await listRecentRuns();
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.data.length).toBeLessThanOrEqual(RECENT_RUNS_LIMIT);
    expect(all.data.some((r) => r.account_id === accountId && r.job_name === "media_sync")).toBe(true);
    // 新しい順
    for (let i = 1; i < all.data.length; i += 1) {
      const prev = all.data[i - 1];
      const cur = all.data[i];
      if (prev && cur) expect(prev.started_at.getTime()).toBeGreaterThanOrEqual(cur.started_at.getTime());
    }
  });

  it("設定が足りなければ変数名だけの固定文言", async () => {
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "";
    try {
      const result = await getConnectionStatus();
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
      const result = await getLatestRuns();
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toMatch(/^DB 接続に失敗（[A-Z_]+）$/);
      expect(result.reason).not.toContain("127.0.0.1");
      expect(result.reason).not.toContain("postgres");
    } finally {
      process.env.DATABASE_URL = saved;
    }
  });
});
