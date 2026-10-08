/**
 * `queries/timing.ts`（`getTimingRows`）の結合テスト（R5 設計 6.5 節、7.1 節「画面（結合）」「期間の境目（T10）」）。
 * `TEST_DATABASE_URL` があるときだけ動く。架空のアカウント 2 つに架空の投稿とスナップショットを作り、`afterAll` でアカウントを消す
 * （カスケードで関連行も消える）。手元の DB の本物の行は変えない。
 *
 * 期間の境目は、クエリの `now()` と入れたときの時刻がずれるので「ちょうど」「1 秒前」ではなく ±60 秒で確かめる
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllDb } from "@/lib/db";
import { getTimingRows } from "@/lib/queries/timing";
import { DAY_MS, fakeMediaId, HOUR_MS, insertFakeAccount, insertMedia, insertSnapshot, setWebEnv } from "./fixtures";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** UTC の日付の 0 時（d 日前） */
function utcMidnightDaysAgo(days: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days));
}

/** JS の UTC の曜日（0 = 日）を ISO の曜日（1 = 月〜7 = 日）にする */
function isoDow(utcDay: number): number {
  return ((utcDay + 6) % 7) + 1;
}

describe.skipIf(!TEST_DATABASE_URL)("queries/timing（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  let sql: postgres.Sql;
  let accountA = "";
  let accountB = "";
  let restoreEnv: () => void = () => {};

  const base = utcMidnightDaysAgo(10);
  const ids = {
    jst2359: fakeMediaId(101), // UTC 14:59 → JST 同じ日の 23:59
    jst0000: fakeMediaId(102), // UTC 15:00 → JST 翌日の 0:00
    jst0300: fakeMediaId(103), // UTC 18:00 → JST 翌日の 3:00（時間帯 3-6）
    jst0259: fakeMediaId(104), // UTC 17:59 → JST 翌日の 2:59（時間帯 0-3）
    late: fakeMediaId(105), // 24 時間の値が許容幅の外（31 時間後だけ）
    inside: fakeMediaId(106), // 365 日 − 60 秒前（入る）
    outside: fakeMediaId(107), // 365 日 + 60 秒前（入らない）
    story: fakeMediaId(108), // ストーリーズ（入らない）
    reel: fakeMediaId(109),
    carousel: fakeMediaId(110),
    other: fakeMediaId(111), // 別のアカウント
  };
  const t = {
    jst2359: new Date(base.getTime() + 14 * HOUR_MS + 59 * 60_000),
    jst0000: new Date(base.getTime() + 15 * HOUR_MS),
    jst0300: new Date(base.getTime() + 18 * HOUR_MS),
    jst0259: new Date(base.getTime() + 17 * HOUR_MS + 59 * 60_000),
    late: new Date(base.getTime() - 3 * DAY_MS),
    inside: new Date(Date.now() - 365 * DAY_MS + 60_000),
    outside: new Date(Date.now() - 365 * DAY_MS - 60_000),
    story: new Date(base.getTime() - 2 * DAY_MS),
    reel: new Date(base.getTime() - 4 * DAY_MS),
    carousel: new Date(base.getTime() - 5 * DAY_MS),
    other: new Date(base.getTime() - 6 * DAY_MS),
  };

  beforeAll(async () => {
    restoreEnv = setWebEnv(url);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    accountA = await insertFakeAccount(sql, "fake_timing_a");
    accountB = await insertFakeAccount(sql, "fake_timing_b");

    const feed = ["jst2359", "jst0000", "jst0300", "jst0259", "late", "inside", "outside"] as const;
    for (const k of feed) {
      await insertMedia(sql, { id: ids[k], accountId: accountA, postedAt: t[k] });
    }
    await insertMedia(sql, { id: ids.story, accountId: accountA, postedAt: t.story, productType: "STORY", mediaType: "VIDEO" });
    await insertMedia(sql, { id: ids.reel, accountId: accountA, postedAt: t.reel, productType: "REELS", mediaType: "VIDEO" });
    await insertMedia(sql, { id: ids.carousel, accountId: accountA, postedAt: t.carousel, mediaType: "CAROUSEL_ALBUM" });
    await insertMedia(sql, { id: ids.other, accountId: accountB, postedAt: t.other });

    // 25 時間後（24 時間の許容幅 + 6 時間の内）と 3 日後（最新）
    for (const k of ["jst2359", "jst0000", "jst0300", "jst0259", "reel", "carousel", "other", "story"] as const) {
      await insertSnapshot(sql, { mediaId: ids[k], postedAt: t[k], fetchedAt: new Date(t[k].getTime() + 25 * HOUR_MS), metrics: { reach: 100, views: 300 } });
      await insertSnapshot(sql, { mediaId: ids[k], postedAt: t[k], fetchedAt: new Date(t[k].getTime() + 3 * DAY_MS), metrics: { reach: 150, views: 500 } });
    }
    // 31 時間後だけ（24h の行はあるが within_tolerance が偽）
    await insertSnapshot(sql, { mediaId: ids.late, postedAt: t.late, fetchedAt: new Date(t.late.getTime() + 31 * HOUR_MS), metrics: { reach: 70, views: 90 } });
    // 期間の境目の 2 件は最新の値だけ
    for (const k of ["inside", "outside"] as const) {
      await insertSnapshot(sql, { mediaId: ids[k], postedAt: t[k], fetchedAt: new Date(t[k].getTime() + 2 * DAY_MS), metrics: { reach: 10, views: 20 } });
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

  it("アカウントを分け、ストーリーズと期間外を除き、365 日の内側は入る", async () => {
    const r = await getTimingRows(accountA);
    if (!r.ok) throw new Error(r.reason);
    const got = r.data.rows.map((x) => x.media_id);
    expect(got).toContain(ids.inside);
    expect(got).not.toContain(ids.outside);
    expect(got).not.toContain(ids.story);
    expect(got).not.toContain(ids.other);
    expect(got).toHaveLength(9);
    expect(r.data.last_fetched_at).toBeInstanceOf(Date);

    const rb = await getTimingRows(accountB);
    if (!rb.ok) throw new Error(rb.reason);
    expect(rb.data.rows.map((x) => x.media_id)).toEqual([ids.other]);
  });

  it("JST の 0 時の前後（UTC 14:59 と 15:00）と 3 時の境目", async () => {
    const r = await getTimingRows(accountA);
    if (!r.ok) throw new Error(r.reason);
    const by = new Map(r.data.rows.map((x) => [x.media_id, x]));
    const day = isoDow(base.getUTCDay());
    const next = isoDow((base.getUTCDay() + 1) % 7);
    expect(by.get(ids.jst2359)).toMatchObject({ isodow: day, hour: 23 });
    expect(by.get(ids.jst0000)).toMatchObject({ isodow: next, hour: 0 });
    expect(by.get(ids.jst0300)).toMatchObject({ isodow: next, hour: 3 });
    expect(by.get(ids.jst0259)).toMatchObject({ isodow: next, hour: 2 });
  });

  it("24 時間の値は許容幅の内だけ。最新の値は最後のスナップショット。種類は SQL の media_kind", async () => {
    const r = await getTimingRows(accountA);
    if (!r.ok) throw new Error(r.reason);
    const by = new Map(r.data.rows.map((x) => [x.media_id, x]));
    expect(by.get(ids.jst0000)).toMatchObject({ kind: "feed", reach_24h: 100, views_24h: 300, reach_latest: 150, views_latest: 500 });
    expect(by.get(ids.late)).toMatchObject({ reach_24h: null, views_24h: null, reach_latest: 70, views_latest: 90 });
    expect(by.get(ids.inside)).toMatchObject({ reach_24h: null, reach_latest: 10 });
    expect(by.get(ids.reel)?.kind).toBe("reel");
    expect(by.get(ids.carousel)?.kind).toBe("carousel");
  });
});
