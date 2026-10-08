/**
 * `queries/stories.ts` の結合テスト（R5 設計 6.3 節、7.1 節「画面（結合）」「期間の境目（T10）」）。
 * `TEST_DATABASE_URL` があるときだけ動く。架空のアカウント 2 つに架空のストーリーズを作り、`afterAll` でアカウントを消す
 * （カスケードで関連行も消える）。手元の DB の本物の行は変えない。
 *
 * 時刻は DB の now()（N）から決める。S = N - 30 日（期間の始まり）。
 *   A: old（S - 20 時間。前のまとまりから 10 時間空くので返らない）
 *      lead1（S - 10 時間）→ lead2（S - 5 時間）→ out1s（S - 1 秒）→ in1（S + 1 分）: 5 時間以内の鎖。期間の前の 3 件も返る
 *      in2（N - 1 日。手で削除と判定済み。フォロワー数 400 の記録あり、閲覧 100）
 *   B: 期間内に 1 件（A の結果に入らない）
 * 境目のちょうど（S ちょうど）は、問い合わせの now() が入れたときより後になるので確かめられない。
 * 1 分後が入り、1 秒前が期間外になることを確かめる
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllDb } from "@/lib/db";
import { getStories } from "@/lib/queries/stories";
import { buildStoriesView } from "@/lib/stories";
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  fakeMediaId,
  insertFakeAccount,
  insertProfileDaily,
  insertStory,
  setWebEnv,
  storyMetrics,
} from "./fixtures";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("queries/stories（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  const ids = {
    old: fakeMediaId(1),
    lead1: fakeMediaId(2),
    lead2: fakeMediaId(3),
    out1s: fakeMediaId(4),
    in1: fakeMediaId(5),
    in2: fakeMediaId(6),
    b1: fakeMediaId(7),
  };
  let sql: postgres.Sql;
  let accountA = "";
  let accountB = "";
  let restoreEnv: () => void = () => {};
  let in2FetchedAt = new Date(0);

  beforeAll(async () => {
    restoreEnv = setWebEnv(url);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    accountA = await insertFakeAccount(sql, "fake_stories_a");
    accountB = await insertFakeAccount(sql, "fake_stories_b");
    const [row] = await sql<{ now: Date }[]>`select now() as now`;
    const now = (row as { now: Date }).now.getTime();
    const start = now - 30 * DAY_MS;

    const put = (id: string, accountId: string, postedAt: number, views: number, fetchedAt?: Date) =>
      insertStory(sql, {
        id,
        accountId,
        postedAt: new Date(postedAt),
        fetchedAt,
        metrics: storyMetrics({ views, tapExit: Math.round(views / 4), linkClicks: 1 }),
      });
    await put(ids.old, accountA, start - 20 * HOUR_MS, 500);
    await put(ids.lead1, accountA, start - 10 * HOUR_MS, 300);
    await put(ids.lead2, accountA, start - 5 * HOUR_MS, 200);
    await put(ids.out1s, accountA, start - 1000, 150);
    await put(ids.in1, accountA, start + MINUTE_MS, 120);
    in2FetchedAt = new Date(now - HOUR_MS);
    await put(ids.in2, accountA, now - DAY_MS, 100, in2FetchedAt);
    await sql`update public.media set gone_at = now() where id = ${ids.in2}`;
    await insertProfileDaily(sql, { accountId: accountA, capturedAt: new Date(now - DAY_MS - 2 * HOUR_MS), followersCount: 400 });
    await put(ids.b1, accountB, now - 2 * DAY_MS, 999);
  });

  afterAll(async () => {
    if (accountA !== "") await sql`delete from public.accounts where id = ${accountA}`;
    if (accountB !== "") await sql`delete from public.accounts where id = ${accountB}`;
    await closeAllDb();
    await sql.end({ timeout: 5 });
    restoreEnv();
  });

  it("期間内の行と、期間の始まりを含むまとまりの期間の前の行を、古い順に返す", async () => {
    const r = await getStories(accountA, 30);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.reason);
    expect(r.data.rows.map((x) => x.media_id)).toEqual([ids.lead1, ids.lead2, ids.out1s, ids.in1, ids.in2]);
    expect(r.data.rows.map((x) => x.in_range)).toEqual([false, false, false, true, true]);
  });

  it("別のアカウントの行は入らない", async () => {
    const a = await getStories(accountA, 365);
    const b = await getStories(accountB, 365);
    if (!a.ok || !b.ok) throw new Error("query failed");
    expect(a.data.rows.map((x) => x.media_id)).not.toContain(ids.b1);
    expect(b.data.rows.map((x) => x.media_id)).toEqual([ids.b1]);
  });

  it("期間 365 日では全部が期間内", async () => {
    const r = await getStories(accountA, 365);
    if (!r.ok) throw new Error(r.reason);
    expect(r.data.rows).toHaveLength(6);
    expect(r.data.rows.every((x) => x.in_range)).toBe(true);
  });

  it("数は number で返り、閲覧率と離脱率は整数の割り算にならない。gone_at のある行も含める", async () => {
    const r = await getStories(accountA, 30);
    if (!r.ok) throw new Error(r.reason);
    const in2 = r.data.rows.find((x) => x.media_id === ids.in2);
    expect(in2?.views).toBe(100);
    expect(in2?.followers_at_post).toBe(400);
    expect(in2?.view_rate).toBeCloseTo(0.25, 10);
    expect(in2?.exit_rate).toBeCloseTo(0.25, 10);
    expect(in2?.gone_at).toBeInstanceOf(Date);
    const in1 = r.data.rows.find((x) => x.media_id === ids.in1);
    expect(in1?.view_rate).toBeNull();
  });

  it("最終更新は期間内の行の metrics_fetched_at の最大", async () => {
    const r = await getStories(accountA, 30);
    if (!r.ok) throw new Error(r.reason);
    expect(r.data.last_fetched_at?.getTime()).toBe(in2FetchedAt.getTime());
  });

  it("ファネルは期間の前から続くまとまりを 1 件目から描く（Q10）", async () => {
    const r = await getStories(accountA, 30);
    if (!r.ok) throw new Error(r.reason);
    const v = buildStoriesView(r.data.rows);
    expect(v.rows.map((x) => x.media_id)).toEqual([ids.in1, ids.in2]);
    expect(v.funnel?.count).toBe(4);
    expect(v.funnel?.values).toEqual([1, 200 / 300, 150 / 300, 120 / 300]);
  });
});
