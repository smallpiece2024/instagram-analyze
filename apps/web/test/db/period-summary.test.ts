/**
 * `queries/period-summary.ts` の結合テスト（R3 設計 3.2 節、6 章、9.2 節）。`TEST_DATABASE_URL` があるときだけ動く。
 * 架空のアカウント 2 件（A を集計し、B は分離の確認用）に、日次指標、フォロワー数の記録、投稿とスナップショットを作り、
 * `afterAll` でアカウントを消す（カスケードで関連行も消える）。日付は架空のデータの中だけで閉じる。
 *
 * A の日次指標（太平洋時間の日付）:
 *   09-01 reach 100（FOLLOWER 60、NON_FOLLOWER 40）、views 10
 *   09-02 reach 200（印の値が正で区分の行なし → 内訳は null）、views 20
 *   09-03 行なし（欠け）
 *   09-04 reach 400（NON_FOLLOWER 400 だけ → FOLLOWER は 0）、views の行はあるが value が null
 *   09-05 reach 500（内訳の印なし → null）、views 50
 *   09-06 follower_count だけ（reach が null。最新の日に含めない）
 * A のフォロワー数（日本時間の日付。captured_at は UTC 03:00 = 日本時間 12:00）:
 *   08-29 1000、08-31 1010、09-03 1030、09-05 null、09-06 1050
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllDb } from "@/lib/db";
import {
  getDailyRange,
  getDailySeries,
  getDailyTotals,
  getFollowerChange,
  getFollowerSeries,
  getPostTotals,
} from "@/lib/queries/period-summary";
import { fakeIgUserId, fakeMediaId, setWebEnv } from "./fixtures";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

interface DailyRow {
  account_id: string;
  metric_date: string;
  metric: string;
  breakdown: string;
  breakdown_value: string;
  value: number | null;
}

describe.skipIf(!TEST_DATABASE_URL)("queries/period-summary（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  const igUserIdA = fakeIgUserId();
  const igUserIdB = fakeIgUserId();
  const ids = {
    p1: fakeMediaId(1), // フィード。UTC 09-02 14:59 = 日本時間 09-02 23:59
    p2: fakeMediaId(2), // カルーセル。UTC 09-02 15:00 = 日本時間 09-03 00:00（太平洋時間は 09-02）
    p3: fakeMediaId(3), // リール。日本時間 09-04
    p4: fakeMediaId(4), // 期間外（日本時間 09-10）
    p5: fakeMediaId(5), // ストーリーズ（集計に入らない）
    b1: fakeMediaId(6), // B の投稿
  };
  let sql: postgres.Sql;
  let accountA = "";
  let accountB = "";
  let restoreEnv: () => void = () => {};

  beforeAll(async () => {
    restoreEnv = setWebEnv(url);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    const accounts = await sql<{ id: string; ig_user_id: string }[]>`
      insert into public.accounts (ig_user_id, username, name)
      values (${igUserIdA}, 'fake_period_a', null), (${igUserIdB}, 'fake_period_b', null)
      returning id, ig_user_id
    `;
    accountA = accounts.find((r) => r.ig_user_id === igUserIdA)?.id ?? "";
    accountB = accounts.find((r) => r.ig_user_id === igUserIdB)?.id ?? "";
    expect(accountA).not.toBe("");
    expect(accountB).not.toBe("");

    const d = (account_id: string, metric_date: string, metric: string, value: number | null, breakdown = "", breakdown_value = ""): DailyRow => ({
      account_id,
      metric_date,
      metric,
      breakdown,
      breakdown_value,
      value,
    });
    const A = accountA;
    const daily: DailyRow[] = [
      d(A, "2026-09-01", "reach", 100),
      d(A, "2026-09-01", "reach", 100, "follow_type", ""),
      d(A, "2026-09-01", "reach", 60, "follow_type", "FOLLOWER"),
      d(A, "2026-09-01", "reach", 40, "follow_type", "NON_FOLLOWER"),
      d(A, "2026-09-01", "views", 10),
      d(A, "2026-09-01", "likes", 3),
      d(A, "2026-09-01", "comments", 1),
      d(A, "2026-09-01", "saves", 2),
      d(A, "2026-09-01", "shares", 1),
      d(A, "2026-09-02", "reach", 200),
      d(A, "2026-09-02", "reach", 200, "follow_type", ""),
      d(A, "2026-09-02", "views", 20),
      d(A, "2026-09-04", "reach", 400),
      d(A, "2026-09-04", "reach", 400, "follow_type", ""),
      d(A, "2026-09-04", "reach", 400, "follow_type", "NON_FOLLOWER"),
      d(A, "2026-09-04", "views", null),
      d(A, "2026-09-05", "reach", 500),
      d(A, "2026-09-05", "views", 50),
      d(A, "2026-09-05", "saves", 7),
      d(A, "2026-09-06", "follower_count", 3),
      // B（A の集計に混ざらないこと、A の範囲を広げないこと）
      d(accountB, "2026-08-01", "reach", 9999),
      d(accountB, "2026-09-01", "reach", 9999),
      d(accountB, "2026-09-20", "reach", 9999),
    ];
    await sql`
      insert into public.account_daily_metrics (account_id, metric_date, metric, breakdown, breakdown_value, value)
      select * from jsonb_to_recordset(${sql.json(daily as unknown as postgres.JSONValue)})
        as r(account_id uuid, metric_date date, metric text, breakdown text, breakdown_value text, value bigint)
    `;

    const profile = [
      { account_id: A, captured_on: "2026-08-29", followers_count: 1000 },
      { account_id: A, captured_on: "2026-08-31", followers_count: 1010 },
      { account_id: A, captured_on: "2026-09-03", followers_count: 1030 },
      { account_id: A, captured_on: "2026-09-05", followers_count: null },
      { account_id: A, captured_on: "2026-09-06", followers_count: 1050 },
      { account_id: accountB, captured_on: "2026-09-04", followers_count: 99999 },
    ];
    await sql`
      insert into public.profile_daily (account_id, captured_on, captured_at, followers_count)
      select r.account_id, r.captured_on, (r.captured_on + time '03:00') at time zone 'UTC', r.followers_count
      from jsonb_to_recordset(${sql.json(profile as unknown as postgres.JSONValue)})
        as r(account_id uuid, captured_on date, followers_count int)
    `;

    const media = [
      { id: ids.p1, account_id: A, media_type: "IMAGE", media_product_type: "FEED", posted_at: "2026-09-02T14:59:00Z" },
      { id: ids.p2, account_id: A, media_type: "CAROUSEL_ALBUM", media_product_type: "FEED", posted_at: "2026-09-02T15:00:00Z" },
      { id: ids.p3, account_id: A, media_type: "VIDEO", media_product_type: "REELS", posted_at: "2026-09-04T03:00:00Z" },
      { id: ids.p4, account_id: A, media_type: "IMAGE", media_product_type: "FEED", posted_at: "2026-09-10T03:00:00Z" },
      { id: ids.p5, account_id: A, media_type: "VIDEO", media_product_type: "STORY", posted_at: "2026-09-03T03:00:00Z" },
      { id: ids.b1, account_id: accountB, media_type: "IMAGE", media_product_type: "FEED", posted_at: "2026-09-03T03:00:00Z" },
    ];
    await sql`
      insert into public.media (id, account_id, media_type, media_product_type, posted_at)
      select * from jsonb_to_recordset(${sql.json(media as unknown as postgres.JSONValue)})
        as r(id text, account_id uuid, media_type text, media_product_type text, posted_at timestamptz)
    `;
    const snapshots: [string, Record<string, number | null>][] = [
      [ids.p1, { reach: 100, views: 150, likes: 5, comments: 1, saved: 3, shares: 1, profile_visits: 4 }],
      // 保存のキーがない（ER と保存率から外れ、シェア率には入る）
      [ids.p2, { reach: 200, views: 300, likes: 10, comments: 2, shares: 2, profile_visits: 6 }],
      // リールはプロフィール訪問がない
      [ids.p3, { reach: 300, views: 900, likes: 20, comments: 0, saved: 6, shares: 4 }],
      [ids.p4, { reach: 7777, views: 1, likes: 1, comments: 1, saved: 1, shares: 1, profile_visits: 1 }],
      [ids.p5, { reach: 8888, profile_visits: 9 }],
      [ids.b1, { reach: 5000, views: 1, likes: 1, comments: 1, saved: 1, shares: 1, profile_visits: 1 }],
    ];
    for (const [mediaId, metrics] of snapshots) {
      await sql`
        insert into public.media_insight_snapshots (media_id, fetched_at, elapsed_seconds, metrics)
        values (${mediaId}, now(), 86400 * 30, ${sql.json(metrics)})
      `;
    }
  });

  afterAll(async () => {
    for (const id of [accountA, accountB]) {
      if (id !== "") await sql`delete from public.accounts where id = ${id}`;
    }
    await closeAllDb();
    await sql.end({ timeout: 5 });
    restoreEnv();
  });

  it("getDailyRange: 最新の日に follower_count しかない日（reach が null）を含めず、B の日付に影響されない", async () => {
    expect(await getDailyRange(accountA)).toEqual({ ok: true, data: { start: "2026-09-01", end: "2026-09-05" } });
  });

  it("getDailyRange: 日次指標がなければ null", async () => {
    const [row] = await sql<{ id: string }[]>`
      insert into public.accounts (ig_user_id, username) values (${fakeIgUserId()}, 'fake_period_empty') returning id
    `;
    try {
      expect(await getDailyRange(row?.id ?? "")).toEqual({ ok: true, data: null });
    } finally {
      await sql`delete from public.accounts where id = ${row?.id ?? ""}`;
    }
  });

  it("getDailySeries: 期間の行だけを日付順に数で返し、欠けた日は返さない。内訳の 0 と null を区別する", async () => {
    const result = await getDailySeries(accountA, "2026-09-01", "2026-09-06");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.map((p) => p.metric_date)).toEqual(["2026-09-01", "2026-09-02", "2026-09-04", "2026-09-05", "2026-09-06"]);
    const [d1, d2, d4, d5, d6] = result.data;
    expect(d1).toMatchObject({ reach: 100, views: 10, reach_follower: 60, reach_non_follower: 40 });
    expect(typeof d1?.reach).toBe("number");
    expect(d2).toMatchObject({ reach: 200, reach_follower: null, reach_non_follower: null });
    expect(d4).toMatchObject({ reach: 400, views: null, reach_follower: 0, reach_non_follower: 400 });
    expect(d5).toMatchObject({ reach: 500, saved: 7, reach_non_follower: null });
    expect(d6).toMatchObject({ reach: null, views: null });

    const narrow = await getDailySeries(accountA, "2026-09-02", "2026-09-02");
    expect(narrow.ok && narrow.data.map((p) => p.reach)).toEqual([200]);
  });

  it("getDailyTotals: ある日だけの合計と日数。非フォロワーリーチ比率は内訳のある日だけで計算する", async () => {
    const result = await getDailyTotals(accountA, "2026-09-01", "2026-09-05");
    expect(result).toEqual({
      ok: true,
      data: {
        periodDays: 5,
        reach: { sum: 1200, days: 4 },
        views: { sum: 80, days: 3 },
        // 09-01（40 / 100）と 09-04（400 / 400）だけ
        nonFollowerReachRate: { value: 440 / 500, used: 2, total: 5 },
        // 反応の 4 指標がそろうのは 09-01 だけ（(3 + 1 + 2 + 1) / 100）
        er: { value: 7 / 100, used: 1, total: 5 },
        // 保存のある 09-01（2 / 100）と 09-05（7 / 500）
        saveRate: { value: 9 / 600, used: 2, total: 5 },
      },
    });
  });

  it("getDailyTotals: データのない期間は合計が null、日数が 0", async () => {
    expect(await getDailyTotals(accountA, "2025-09-01", "2025-09-30")).toEqual({
      ok: true,
      data: {
        periodDays: 30,
        reach: { sum: null, days: 0 },
        views: { sum: null, days: 0 },
        nonFollowerReachRate: { value: null, used: 0, total: 30 },
        er: { value: null, used: 0, total: 30 },
        saveRate: { value: null, used: 0, total: 30 },
      },
    });
  });

  it("getFollowerSeries: 期間の記録を日付順に返す（null の記録も返す）", async () => {
    const result = await getFollowerSeries(accountA, "2026-08-30", "2026-09-05");
    expect(result).toEqual({
      ok: true,
      data: [
        { captured_on: "2026-08-31", followers_count: 1010 },
        { captured_on: "2026-09-03", followers_count: 1030 },
        { captured_on: "2026-09-05", followers_count: null },
      ],
    });
  });

  it("getFollowerChange: 端の記録が 1 日以内なら純増を出す", async () => {
    // 終わり 09-04 → 09-03 の記録（1 日前）、始まりの前日 08-31 → 08-31 の記録
    expect(await getFollowerChange(accountA, "2026-09-01", "2026-09-04")).toEqual({
      ok: true,
      data: {
        end: { captured_on: "2026-09-03", followers_count: 1030 },
        start: { captured_on: "2026-08-31", followers_count: 1010 },
        net: 20,
        firstCapturedOn: "2026-08-29",
        latest: { captured_on: "2026-09-06", followers_count: 1050 },
      },
    });
  });

  it("getFollowerChange: 1 日を超えて離れた記録と、値が null の記録は使わない", async () => {
    // 終わり 09-05: 09-05 は null なので 09-03（2 日前）になり、使わない
    const end = await getFollowerChange(accountA, "2026-09-01", "2026-09-05");
    expect(end.ok).toBe(true);
    if (!end.ok) return;
    expect(end.data.end).toBeNull();
    expect(end.data.start).toEqual({ captured_on: "2026-08-31", followers_count: 1010 });
    expect(end.data.net).toBeNull();

    // 始まり 09-03 の前日 09-02 → 08-31（2 日前）は使わない
    const start = await getFollowerChange(accountA, "2026-09-03", "2026-09-03");
    expect(start.ok && start.data.start).toBeNull();
    expect(start.ok && start.data.end).toEqual({ captured_on: "2026-09-03", followers_count: 1030 });
    expect(start.ok && start.data.net).toBeNull();

    // 記録より前の期間
    const before = await getFollowerChange(accountA, "2026-08-01", "2026-08-10");
    expect(before.ok && before.data).toMatchObject({ end: null, start: null, net: null, firstCapturedOn: "2026-08-29" });
  });

  it("getPostTotals: 合計の比は欠損のない投稿だけで計算し、n 件中 m 件を返す（ストーリーズ、期間外、B を含めない）", async () => {
    const result = await getPostTotals(accountA, "2026-09-02", "2026-09-04");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const t = result.data;
    expect(t.posts).toBe(3);
    expect(t.byKind).toEqual({
      feed: { posts: 1, reach: { sum: 100, used: 1, total: 1 }, saved: { sum: 3, used: 1, total: 1 } },
      carousel: { posts: 1, reach: { sum: 200, used: 1, total: 1 }, saved: { sum: null, used: 0, total: 1 } },
      reel: { posts: 1, reach: { sum: 300, used: 1, total: 1 }, saved: { sum: 6, used: 1, total: 1 } },
    });
    // p1（10 / 100）と p3（30 / 300）。p2 は保存がないので分子からも分母からも外す
    expect(t.er).toEqual({ value: 40 / 400, used: 2, total: 3 });
    expect(t.erByViews).toEqual({ value: 40 / 1050, used: 2, total: 3 });
    expect(t.interactions).toEqual({ sum: 40, used: 2, total: 3 });
    expect(t.saveRate).toEqual({ value: 9 / 400, used: 2, total: 3 });
    expect(t.shareRate).toEqual({ value: 7 / 600, used: 3, total: 3 });
    expect(t.profileVisits).toEqual({ sum: 10, used: 2, total: 3 });
  });

  it("getPostTotals: 投稿は日本時間の日付で期間に入れる（UTC 14:59 と 15:00 の境目）", async () => {
    const d2 = await getPostTotals(accountA, "2026-09-02", "2026-09-02");
    expect(d2.ok && d2.data.posts).toBe(1);
    expect(d2.ok && d2.data.byKind.feed.posts).toBe(1);
    const d3 = await getPostTotals(accountA, "2026-09-03", "2026-09-03");
    expect(d3.ok && d3.data.posts).toBe(1);
    expect(d3.ok && d3.data.byKind.carousel.posts).toBe(1);
  });

  it("getPostTotals: 期間中の投稿が 0 件なら件数 0 と null", async () => {
    expect(await getPostTotals(accountA, "2026-08-01", "2026-08-31")).toEqual({
      ok: true,
      data: {
        posts: 0,
        byKind: {
          feed: { posts: 0, reach: { sum: null, used: 0, total: 0 }, saved: { sum: null, used: 0, total: 0 } },
          carousel: { posts: 0, reach: { sum: null, used: 0, total: 0 }, saved: { sum: null, used: 0, total: 0 } },
          reel: { posts: 0, reach: { sum: null, used: 0, total: 0 }, saved: { sum: null, used: 0, total: 0 } },
        },
        er: { value: null, used: 0, total: 0 },
        erByViews: { value: null, used: 0, total: 0 },
        interactions: { sum: null, used: 0, total: 0 },
        saveRate: { value: null, used: 0, total: 0 },
        shareRate: { value: null, used: 0, total: 0 },
        profileVisits: { sum: null, used: 0, total: 0 },
      },
    });
  });

  it("B の集計に A が混ざらない", async () => {
    const totals = await getDailyTotals(accountB, "2026-09-01", "2026-09-05");
    expect(totals.ok && totals.data.reach).toEqual({ sum: 9999, days: 1 });
    const posts = await getPostTotals(accountB, "2026-09-02", "2026-09-04");
    expect(posts.ok && posts.data.posts).toBe(1);
    expect(posts.ok && posts.data.byKind.feed.reach.sum).toBe(5000);
    const change = await getFollowerChange(accountB, "2026-09-01", "2026-09-04");
    expect(change.ok && change.data.end).toEqual({ captured_on: "2026-09-04", followers_count: 99999 });
    expect(change.ok && change.data.firstCapturedOn).toBe("2026-09-04");
  });

  it("media_list_metrics: 投稿時のフォロワー数は投稿より前で 3 日以内の記録だけ。日本時間と太平洋時間の日付", async () => {
    const rows = await sql<
      { media_id: string; posted_date_jst: string; posted_date_pt: string; followers_at_post: number | null }[]
    >`
      select media_id, posted_date_jst::text, posted_date_pt::text, followers_at_post
      from public.media_list_metrics
      where account_id = ${accountA}
    `;
    const byId = new Map(rows.map((r) => [r.media_id, r]));
    // ストーリーズはビューに入らない
    expect(byId.has(ids.p5)).toBe(false);
    expect(byId.get(ids.p1)).toMatchObject({ posted_date_jst: "2026-09-02", posted_date_pt: "2026-09-02", followers_at_post: 1010 });
    expect(byId.get(ids.p2)).toMatchObject({ posted_date_jst: "2026-09-03", posted_date_pt: "2026-09-02", followers_at_post: 1010 });
    // 投稿の後の記録（09-05、09-06）ではなく、投稿の前の 09-03
    expect(byId.get(ids.p3)).toMatchObject({ posted_date_jst: "2026-09-04", followers_at_post: 1030 });
    // 投稿の前の最も近い記録（09-06 03:00）が 4 日前なので使わない
    expect(byId.get(ids.p4)?.followers_at_post).toBeNull();
  });
});
