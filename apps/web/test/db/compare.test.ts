/**
 * 期間比較の期間の決定（純粋関数）と、`queries/compare.ts` の結合テスト（R3 設計 3.5 節、7.3 節）。
 * 結合テストは `TEST_DATABASE_URL` があるときだけ動く。架空のアカウントを作り、`afterAll` で消す（カスケードで関連行も消える）。
 *
 * 架空のアカウントの日次指標（太平洋時間の日付）:
 *   08-01 reach 100（FOLLOWER 60、NON_FOLLOWER 40）、views 10
 *   08-02 reach 200、views 20
 *   08-03 reach 300、views 30（フォロワー数の記録 1000 が同じ日付にある）
 *   08-04 行なし（欠け）
 *   08-05 reach 500、views 50
 * 投稿（日本時間の日付。各投稿の最新の値）:
 *   p1 フィード 08-02 reach 100 → ER 0.2、保存率 0.1
 *   p2 フィード 08-03 reach 300 → ER 0.1、保存率 0.1
 *   p3 リール   08-04 reach 200 → ER 0.05、保存率 0
 *   p4 フィード 07-20 reach 50（保存のキーなし → 保存率と ER は null）
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveCompare } from "@/app/compare/_compare/periods";
import { closeAllDb } from "@/lib/db";
import { getCompareUpdatedAt, getPeriodBaselines, getPeriodComparison, listDailyCsvRows } from "@/lib/queries/compare";
import { fakeIgUserId, fakeMediaId, setWebEnv } from "./fixtures";

const LATEST = "2026-10-04";

describe("resolveCompare（期間の決定）", () => {
  it("指定なしは前 30 日", () => {
    expect(resolveCompare({}, LATEST)).toEqual({
      preset: "30d",
      a: { from: "2026-09-05", to: "2026-10-04" },
      b: { from: "2026-08-06", to: "2026-09-04" },
    });
  });

  it("任意の期間のクエリは無視してプリセットで決める", () => {
    expect(resolveCompare({ a: "2026-09-01..2026-09-30", preset: "7d" }, LATEST).preset).toBe("7d");
  });

  it("プリセット。不明な値は前 30 日", () => {
    expect(resolveCompare({ preset: "7d" }, LATEST)).toMatchObject({
      preset: "7d",
      a: { from: "2026-09-28", to: "2026-10-04" },
      b: { from: "2026-09-21", to: "2026-09-27" },
    });
    expect(resolveCompare({ preset: "90d" }, LATEST)).toMatchObject({
      preset: "90d",
      a: { from: "2026-07-07", to: "2026-10-04" },
      b: { from: "2026-04-08", to: "2026-07-06" },
    });
    expect(resolveCompare({ preset: "month" }, LATEST)).toMatchObject({
      a: { from: "2026-09-01", to: "2026-09-30" },
      b: { from: "2026-08-01", to: "2026-08-31" },
    });
    expect(resolveCompare({ preset: "yoy" }, LATEST)).toMatchObject({
      a: { from: "2026-09-01", to: "2026-09-30" },
      b: { from: "2025-09-01", to: "2025-09-30" },
    });
    expect(resolveCompare({ preset: "xx" }, LATEST).preset).toBe("30d");
    expect(resolveCompare({ preset: ["7d", "30d"] }, LATEST).preset).toBe("30d");
  });
});

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("queries/compare（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  const igUserId = fakeIgUserId();
  const ids = { p1: fakeMediaId(1), p2: fakeMediaId(2), p3: fakeMediaId(3), p4: fakeMediaId(4) };
  let sql: postgres.Sql;
  let accountId = "";
  let restoreEnv: () => void = () => {};

  beforeAll(async () => {
    restoreEnv = setWebEnv(url);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    const [acc] = await sql<{ id: string }[]>`
      insert into public.accounts (ig_user_id, username, name) values (${igUserId}, 'fake_compare', null) returning id
    `;
    accountId = acc?.id ?? "";
    expect(accountId).not.toBe("");

    const d = (metric_date: string, metric: string, value: number | null, breakdown = "", breakdown_value = "") => ({
      account_id: accountId,
      metric_date,
      metric,
      breakdown,
      breakdown_value,
      value,
    });
    const daily = [
      d("2026-08-01", "reach", 100),
      d("2026-08-01", "reach", 100, "follow_type", ""),
      d("2026-08-01", "reach", 60, "follow_type", "FOLLOWER"),
      d("2026-08-01", "reach", 40, "follow_type", "NON_FOLLOWER"),
      d("2026-08-01", "views", 10),
      d("2026-08-02", "reach", 200),
      d("2026-08-02", "views", 20),
      d("2026-08-03", "reach", 300),
      d("2026-08-03", "views", 30),
      d("2026-08-05", "reach", 500),
      d("2026-08-05", "views", 50),
    ];
    await sql`
      insert into public.account_daily_metrics (account_id, metric_date, metric, breakdown, breakdown_value, value)
      select * from jsonb_to_recordset(${sql.json(daily as unknown as postgres.JSONValue)})
        as r(account_id uuid, metric_date date, metric text, breakdown text, breakdown_value text, value bigint)
    `;
    await sql`
      insert into public.profile_daily (account_id, captured_on, captured_at, followers_count)
      values (${accountId}, '2026-08-03', '2026-08-03T03:00:00Z', 1000)
    `;
    const media = [
      { id: ids.p1, media_type: "IMAGE", media_product_type: "FEED", posted_at: "2026-08-02T03:00:00Z" },
      { id: ids.p2, media_type: "IMAGE", media_product_type: "FEED", posted_at: "2026-08-03T03:00:00Z" },
      { id: ids.p3, media_type: "VIDEO", media_product_type: "REELS", posted_at: "2026-08-04T03:00:00Z" },
      { id: ids.p4, media_type: "IMAGE", media_product_type: "FEED", posted_at: "2026-07-20T03:00:00Z" },
    ].map((m) => ({ ...m, account_id: accountId }));
    await sql`
      insert into public.media (id, account_id, media_type, media_product_type, posted_at)
      select id, account_id, media_type, media_product_type, posted_at
      from jsonb_to_recordset(${sql.json(media as unknown as postgres.JSONValue)})
        as r(id text, account_id uuid, media_type text, media_product_type text, posted_at timestamptz)
    `;
    const snapshots: [string, Record<string, number>][] = [
      [ids.p1, { reach: 100, views: 150, likes: 5, comments: 1, saved: 10, shares: 4, profile_visits: 2 }],
      [ids.p2, { reach: 300, views: 400, likes: 0, comments: 0, saved: 30, shares: 0, profile_visits: 3 }],
      [ids.p3, { reach: 200, views: 900, likes: 10, comments: 0, saved: 0, shares: 0 }],
      [ids.p4, { reach: 50, views: 60, likes: 1, comments: 0, shares: 0, profile_visits: 1 }],
    ];
    for (const [mediaId, metrics] of snapshots) {
      await sql`
        insert into public.media_insight_snapshots (media_id, fetched_at, elapsed_seconds, metrics)
        values (${mediaId}, '2026-08-20T00:00:00Z', 86400 * 10, ${sql.json(metrics)})
      `;
    }
  });

  afterAll(async () => {
    if (accountId !== "") await sql`delete from public.accounts where id = ${accountId}`;
    await closeAllDb();
    await sql.end({ timeout: 5 });
    restoreEnv();
  });

  it("getPeriodComparison: A は欠けた日を除いた合計と日数、B（データの始まりより前）は値なし", async () => {
    const r = await getPeriodComparison(
      accountId,
      { from: "2026-08-01", to: "2026-08-05" },
      { from: "2026-07-15", to: "2026-07-25" },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { a, b } = r.data;
    expect(a.daily.periodDays).toBe(5);
    expect(a.daily.reach).toEqual({ sum: 1100, days: 4 });
    expect(a.daily.views).toEqual({ sum: 110, days: 4 });
    expect(a.daily.nonFollowerReachRate).toEqual({ value: 0.4, used: 1, total: 5 });
    expect(a.posts.posts).toBe(3);
    expect(a.posts.byKind.feed.posts).toBe(2);
    expect(a.posts.byKind.reel.posts).toBe(1);
    expect(a.posts.saveRate.value).toBeCloseTo(40 / 600);
    expect(b.daily.reach).toEqual({ sum: null, days: 0 });
    expect(b.daily.periodDays).toBe(11);
    expect(b.posts.posts).toBe(1);
    expect(b.posts.er).toEqual({ value: null, used: 0, total: 1 });
  });

  it("getPeriodBaselines: 各投稿の最新の値の平均、分位、最小と最大、指標ごとの n", async () => {
    const r = await getPeriodBaselines(accountId, "2026-08-01", "2026-08-05");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.posts).toBe(3);
    const { reach, save_rate, er } = r.data.stats;
    expect(reach).toEqual({ n: 3, mean: 200, p25: 150, median: 200, p75: 250, min: 100, max: 300 });
    expect(save_rate.n).toBe(3);
    expect(save_rate.p25).toBeCloseTo(0.05);
    expect(save_rate.median).toBeCloseTo(0.1);
    expect(save_rate.p75).toBeCloseTo(0.1);
    expect(save_rate.min).toBeCloseTo(0);
    expect(save_rate.max).toBeCloseTo(0.1);
    expect(er.n).toBe(3);
    expect(er.mean).toBeCloseTo((0.2 + 0.1 + 0.05) / 3);
    expect(er.p25).toBeCloseTo(0.075);
    expect(er.median).toBeCloseTo(0.1);
    expect(er.p75).toBeCloseTo(0.15);
    expect(er.min).toBeCloseTo(0.05);
    expect(er.max).toBeCloseTo(0.2);
  });

  it("getPeriodBaselines: 値のない指標は n = 0 で null、投稿のない期間は posts = 0", async () => {
    const b = await getPeriodBaselines(accountId, "2026-07-15", "2026-07-25");
    expect(b).toEqual({
      ok: true,
      data: {
        posts: 1,
        stats: {
          reach: { n: 1, mean: 50, p25: 50, median: 50, p75: 50, min: 50, max: 50 },
          save_rate: { n: 0, mean: null, p25: null, median: null, p75: null, min: null, max: null },
          er: { n: 0, mean: null, p25: null, median: null, p75: null, min: null, max: null },
        },
      },
    });
    const empty = await getPeriodBaselines(accountId, "2026-06-01", "2026-06-30");
    expect(empty.ok && empty.data.posts).toBe(0);
    expect(empty.ok && empty.data.stats.reach.n).toBe(0);
  });

  it("getCompareUpdatedAt: 日次指標とスナップショットの取得時刻の最大値", async () => {
    const r = await getCompareUpdatedAt(accountId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toBeInstanceOf(Date);
    expect(r.data!.getTime()).toBeGreaterThanOrEqual(Date.parse("2026-08-20T00:00:00Z"));
  });

  it("listDailyCsvRows: 全期間と期間指定。フォロワー数は同じ日付の記録を横に付ける", async () => {
    const all = await listDailyCsvRows(accountId, null);
    expect(all.map((r) => r.metric_date_pt)).toEqual(["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-05"]);
    expect(all[0]).toMatchObject({ reach: 100, reach_follower: 60, reach_non_follower: 40, views: 10 });
    expect(typeof all[0]?.reach).toBe("number");
    expect(all[0]?.fetched_at_jst).toBeInstanceOf(Date);
    expect(all[2]).toMatchObject({ reach: 300, followers_count_jst_day: 1000 });
    expect(all[1]?.followers_count_jst_day).toBeNull();

    const part = await listDailyCsvRows(accountId, { from: "2026-08-02", to: "2026-08-03" });
    expect(part.map((r) => r.metric_date_pt)).toEqual(["2026-08-02", "2026-08-03"]);
  });
});
