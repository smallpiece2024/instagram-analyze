/**
 * `queries/overview.ts` のテスト（R3 設計 3.2 節、6 章）。
 * - `erFor`（ER の分母の切り替え）は純粋関数なので DB なしで動く
 * - 読み出し関数は `TEST_DATABASE_URL` があるときだけ動く結合テスト。架空のアカウント 2 件（A を読み、B は分離の確認用）を作り、
 *   `afterAll` で消す（カスケードで関連行も消える）。`metric_definitions` は全体で 1 つの表なので読むだけにする
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllDb } from "@/lib/db";
import { erFor, getMetricChangeDates, getOverviewUpdatedAt, getPostMarkers } from "@/lib/queries/overview";
import type { FollowerChange, PostTotals } from "@/lib/queries/period-summary";
import { fakeIgUserId, fakeMediaId, setWebEnv } from "./fixtures";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

function totals(over: Partial<PostTotals> = {}): PostTotals {
  const empty = { sum: null, used: 0, total: 0 };
  const kind = { posts: 0, reach: empty, saved: empty };
  return {
    posts: 4,
    byKind: { feed: kind, carousel: kind, reel: kind },
    er: { value: 0.05, used: 3, total: 4 },
    erByViews: { value: 0.02, used: 2, total: 4 },
    interactions: { sum: 60, used: 3, total: 4 },
    saveRate: { value: null, used: 0, total: 4 },
    shareRate: { value: null, used: 0, total: 4 },
    profileVisits: empty,
    ...over,
  };
}

function followers(endCount: number | null): FollowerChange {
  return {
    end: endCount === null ? null : { captured_on: "2026-09-30", followers_count: endCount },
    start: null,
    net: null,
    firstCapturedOn: null,
    latest: null,
  };
}

describe("erFor（ER の分母の切り替え）", () => {
  it("reach と views は合計の比をそのまま返す", () => {
    expect(erFor("reach", totals(), null)).toEqual({ value: 0.05, used: 3, total: 4 });
    expect(erFor("views", totals(), null)).toEqual({ value: 0.02, used: 2, total: 4 });
  });

  it("followers は 1 投稿あたりの反応 ÷ 期間末のフォロワー数", () => {
    // 60 ÷ 3 = 20、20 ÷ 1000 = 0.02
    expect(erFor("followers", totals(), followers(1000))).toEqual({ value: 0.02, used: 3, total: 4 });
  });

  it("followers は期間末の記録がない、0 人、使える投稿が 0 件なら null", () => {
    expect(erFor("followers", totals(), followers(null)).value).toBeNull();
    expect(erFor("followers", totals(), null).value).toBeNull();
    expect(erFor("followers", totals(), followers(0)).value).toBeNull();
    const none = totals({ interactions: { sum: null, used: 0, total: 4 } });
    expect(erFor("followers", none, followers(1000))).toEqual({ value: null, used: 0, total: 4 });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("queries/overview（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  const ids = {
    p1: fakeMediaId(11), // フィード。UTC 09-03 01:00 = 太平洋時間 09-02（夏時間 -7）
    p2: fakeMediaId(12), // リール。UTC 09-04 20:00 = 太平洋時間 09-04
    p3: fakeMediaId(13), // 期間外（太平洋時間 09-20）
    p4: fakeMediaId(14), // ストーリーズ（印に入らない）
    b1: fakeMediaId(15), // B の投稿
  };
  let sql: postgres.Sql;
  let accountA = "";
  let accountB = "";
  let accountEmpty = "";
  let restoreEnv: () => void = () => {};

  beforeAll(async () => {
    restoreEnv = setWebEnv(url);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    const igA = fakeIgUserId();
    const igB = fakeIgUserId();
    const igE = fakeIgUserId();
    const accounts = await sql<{ id: string; ig_user_id: string }[]>`
      insert into public.accounts (ig_user_id, username, name)
      values (${igA}, 'fake_overview_a', null), (${igB}, 'fake_overview_b', null), (${igE}, 'fake_overview_empty', null)
      returning id, ig_user_id
    `;
    accountA = accounts.find((r) => r.ig_user_id === igA)?.id ?? "";
    accountB = accounts.find((r) => r.ig_user_id === igB)?.id ?? "";
    accountEmpty = accounts.find((r) => r.ig_user_id === igE)?.id ?? "";
    expect(accountA).not.toBe("");

    await sql`
      insert into public.account_daily_metrics (account_id, metric_date, metric, breakdown, breakdown_value, value, fetched_at)
      values
        (${accountA}, '2026-09-01', 'reach', '', '', 100, '2026-09-02T10:00:00Z'),
        (${accountA}, '2026-09-02', 'reach', '', '', 200, '2026-09-03T10:00:00Z'),
        (${accountB}, '2026-09-02', 'reach', '', '', 999, '2026-09-30T10:00:00Z')
    `;
    const media = [
      { id: ids.p1, account_id: accountA, media_type: "IMAGE", media_product_type: "FEED", posted_at: "2026-09-03T01:00:00Z" },
      { id: ids.p2, account_id: accountA, media_type: "VIDEO", media_product_type: "REELS", posted_at: "2026-09-04T20:00:00Z" },
      { id: ids.p3, account_id: accountA, media_type: "IMAGE", media_product_type: "FEED", posted_at: "2026-09-20T20:00:00Z" },
      { id: ids.p4, account_id: accountA, media_type: "VIDEO", media_product_type: "STORY", posted_at: "2026-09-03T03:00:00Z" },
      { id: ids.b1, account_id: accountB, media_type: "IMAGE", media_product_type: "FEED", posted_at: "2026-09-03T03:00:00Z" },
    ];
    await sql`
      insert into public.media (id, account_id, media_type, media_product_type, posted_at)
      select * from jsonb_to_recordset(${sql.json(media as unknown as postgres.JSONValue)})
        as r(id text, account_id uuid, media_type text, media_product_type text, posted_at timestamptz)
    `;
    await sql`
      insert into public.media_insight_snapshots (media_id, fetched_at, elapsed_seconds, metrics)
      values
        (${ids.p1}, '2026-09-05T00:00:00Z', 86400, ${sql.json({ reach: 10 })}),
        (${ids.p2}, '2026-09-06T00:00:00Z', 86400, ${sql.json({ reach: 20 })}),
        (${ids.b1}, '2026-10-01T00:00:00Z', 86400, ${sql.json({ reach: 30 })})
    `;
  });

  afterAll(async () => {
    for (const id of [accountA, accountB, accountEmpty]) {
      if (id !== "") await sql`delete from public.accounts where id = ${id}`;
    }
    await closeAllDb();
    await sql.end({ timeout: 5 });
    restoreEnv();
  });

  it("getOverviewUpdatedAt: 日次指標と投稿の指標の取得時刻の最大。B の行に影響されない", async () => {
    const result = await getOverviewUpdatedAt(accountA);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.daily?.toISOString()).toBe("2026-09-03T10:00:00.000Z");
    expect(result.data.media?.toISOString()).toBe("2026-09-06T00:00:00.000Z");
    expect(result.data.latest?.toISOString()).toBe("2026-09-06T00:00:00.000Z");
  });

  it("getOverviewUpdatedAt: データがなければすべて null", async () => {
    expect(await getOverviewUpdatedAt(accountEmpty)).toEqual({ ok: true, data: { daily: null, media: null, latest: null } });
  });

  it("getPostMarkers: 太平洋時間の日付で期間に入る投稿だけ。ストーリーズと B の投稿を含めない", async () => {
    const result = await getPostMarkers(accountA, "2026-09-01", "2026-09-10");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.map((m) => m.posted_date_pt)).toEqual(["2026-09-02", "2026-09-04"]);
    expect(result.data[0]?.posted_at.toISOString()).toBe("2026-09-03T01:00:00.000Z");
  });

  it("getMetricChangeDates: 範囲に入る定義の変更日だけ（views の 2025-04-21）", async () => {
    const hit = await getMetricChangeDates("2025-04-01", "2025-04-30");
    expect(hit.ok && hit.data).toEqual(["2025-04-21"]);
    const miss = await getMetricChangeDates("2026-09-01", "2026-09-30");
    expect(miss).toEqual({ ok: true, data: [] });
  });
});
