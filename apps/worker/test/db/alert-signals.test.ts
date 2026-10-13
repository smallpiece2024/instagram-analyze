/**
 * `db/alert-signals.ts` の結合テスト（R6 設計 4.3 節、4.5 節。T7 の境目の列挙）。本物の DB（ローカル Supabase）で、
 * ビュー `account_daily_wide` の基点と窓の境目、`media` の太平洋時間の境目、`profile_daily` の null の飛ばし方、
 * 2 アカウントの分離を確かめる。架空のアカウント 2 つを作り、終了時に消す（CASCADE で関連する行も消える）。
 *
 * 日付は 2030 年 6 月に固定する（太平洋時間は PDT = UTC−7。他のテストと重ならない）。値はすべて架空
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAlertAccounts } from "../../src/commands/check-alerts.js";
import { countRecentPosts, readFollowerPair, readNonFollowerReachWindows } from "../../src/db/alert-signals.js";
import { closeDb, connectDb, type Db } from "../../src/db/client.js";
import type { AccountRow } from "../../src/db/types.js";
import { evaluateAlerts } from "../../src/jobs/alerts.js";
import { createFixtureAccount, deleteFixtureAccount, insertDailyReach, insertFollowers, insertPost } from "./alert-signals-fixtures.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** 基点の日（`reach` のある最新の日） */
const LATEST = "2030-06-15";

/** `LATEST` から `n` 日ずらした日付（UTC で計算。`YYYY-MM-DD`） */
function day(n: number): string {
  const d = new Date(`${LATEST}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

describe.skipIf(!TEST_DATABASE_URL)("db/alert-signals（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  let db: Db;
  let a: AccountRow;
  let b: AccountRow;

  beforeAll(async () => {
    db = connectDb(url);
    a = await createFixtureAccount(db, "fake_alert_a");
    b = await createFixtureAccount(db, "fake_alert_b");

    // --- A の日次指標 ---
    // 基点の翌日: reach が null（follower_count だけの日）。基点にしない。非フォロワーの値があっても使わない
    await insertDailyReach(db, a.id, day(1), null, 5);
    // 直近 7 日のうち 6 日（day(-3) は欠け）。基点の日だけ非フォロワー 40、他は 30
    await insertDailyReach(db, a.id, day(0), 100, 40);
    await insertDailyReach(db, a.id, day(-1), 100, 30);
    await insertDailyReach(db, a.id, day(-2), 100, 30);
    await insertDailyReach(db, a.id, day(-4), 100, 30);
    await insertDailyReach(db, a.id, day(-5), 100, 30);
    await insertDailyReach(db, a.id, day(-6), 100, 30);
    // 基準の境目: day(-7) は基準に入る
    await insertDailyReach(db, a.id, day(-7), 100, 50);
    // 非フォロワーが null（行なし）、null（値が null）、reach が null の日は分子にも分母にも入らない
    await insertDailyReach(db, a.id, day(-8), 100, "absent");
    await insertDailyReach(db, a.id, day(-9), 100, null);
    await insertDailyReach(db, a.id, day(-10), null, 50);
    // 窓の端: day(-34) は入り、day(-35) は入らない
    await insertDailyReach(db, a.id, day(-34), 100, 50);
    await insertDailyReach(db, a.id, day(-35), 100, 50);

    // --- A の投稿（太平洋時間 PDT = UTC−7）---
    await insertPost(db, a.id, new Date("2030-06-16T06:59:59Z")); // PT 06-15 23:59:59 → 基点の日。数える
    await insertPost(db, a.id, new Date("2030-06-16T07:00:00Z")); // PT 06-16 → 基点の翌日。数えない
    await insertPost(db, a.id, new Date("2030-06-09T07:00:00Z")); // PT 06-09 00:00 → day(-6)。数える
    await insertPost(db, a.id, new Date("2030-06-09T06:59:59Z")); // PT 06-08 → day(-7)。数えない
    await insertPost(db, a.id, new Date("2030-06-12T12:00:00Z"), "REELS"); // 数える
    await insertPost(db, a.id, new Date("2030-06-12T12:00:00Z"), "STORY"); // ストーリーズは数えない

    // --- A のフォロワー数（day(-1) は null なので飛ばされ、previous は 2 日前になる）---
    await insertFollowers(db, a.id, day(0), 1000);
    await insertFollowers(db, a.id, day(-1), null);
    await insertFollowers(db, a.id, day(-2), 1100);
  });

  afterAll(async () => {
    await deleteFixtureAccount(db, a.id);
    await deleteFixtureAccount(db, b.id);
    const [rows] = await db<{ n: number }[]>`
      select count(*)::int as n from public.account_daily_metrics where account_id in (${a.id}, ${b.id})
    `;
    expect(rows?.n).toBe(0);
    await closeDb(db);
  });

  it("readNonFollowerReachWindows: reach が null の日を基点にせず、窓の境目と欠けた日・null の日を正しく扱う", async () => {
    const windows = await readNonFollowerReachWindows(db, a.id);
    expect(windows).toEqual({
      latest: LATEST,
      // day(0) 〜 day(-6) のうち 6 日。非フォロワー 40 + 30 × 5
      recent: { numerator: 190, denominator: 600, days: 6 },
      // day(-7) と day(-34) の 2 日。day(-8)、day(-9)、day(-10)、day(-35) は入らない
      base: { numerator: 100, denominator: 200, days: 2 },
    });
    // 合計は number（postgres.js の bigint の文字列ではない）
    expect(typeof windows?.recent.numerator).toBe("number");
    expect(typeof windows?.base.days).toBe("number");
  });

  it("readNonFollowerReachWindows: 日次指標がなければ undefined。reach だけで非フォロワーがない日しかなければ 0 と日数 0", async () => {
    expect(await readNonFollowerReachWindows(db, b.id)).toBeUndefined();
    await insertDailyReach(db, b.id, day(0), 100, "absent");
    expect(await readNonFollowerReachWindows(db, b.id)).toEqual({
      latest: LATEST,
      recent: { numerator: 0, denominator: 0, days: 0 },
      base: { numerator: 0, denominator: 0, days: 0 },
    });
  });

  it("countRecentPosts: 太平洋時間の日付で latest − 6 〜 latest。ストーリーズは除く", async () => {
    expect(await countRecentPosts(db, a.id, LATEST)).toBe(3);
    // 基点を 1 日ずらすと、06-16 07:00Z の投稿が入り、06-09 の投稿が外れる
    expect(await countRecentPosts(db, a.id, day(1))).toBe(3);
    // 窓から外れた基点なら 0
    expect(await countRecentPosts(db, a.id, day(-20))).toBe(0);
    expect(await countRecentPosts(db, b.id, LATEST)).toBe(0);
  });

  it("readFollowerPair: followers_count が null の記録を飛ばすので previous は前日でなくなる。記録がなければ undefined", async () => {
    expect(await readFollowerPair(db, a.id)).toEqual({
      latest: { capturedOn: day(0), count: 1000 },
      previous: { capturedOn: day(-2), count: 1100 },
    });
    expect(await readFollowerPair(db, b.id)).toBeUndefined();
    await insertFollowers(db, b.id, day(0), 5);
    expect(await readFollowerPair(db, b.id)).toEqual({ latest: { capturedOn: day(0), count: 5 }, previous: null });
  });

  it("2 アカウントのデータを分ける（B の行を足しても A の結果は変わらない）", async () => {
    await insertDailyReach(db, b.id, day(-1), 100, 10);
    await insertPost(db, b.id, new Date("2030-06-14T12:00:00Z"));
    expect(await readNonFollowerReachWindows(db, a.id)).toEqual({
      latest: LATEST,
      recent: { numerator: 190, denominator: 600, days: 6 },
      base: { numerator: 100, denominator: 200, days: 2 },
    });
    expect(await countRecentPosts(db, a.id, LATEST)).toBe(3);
    expect((await readNonFollowerReachWindows(db, b.id))?.recent).toEqual({ numerator: 10, denominator: 100, days: 1 });
    expect(await countRecentPosts(db, b.id, LATEST)).toBe(1);
  });

  it("loadAlertAccounts: daily は 3 つを読んで入力に載せ、hourly は載せない。評価すると A は no_history（直近 6 日は足りるが基準 2 日）", async () => {
    const daily = await loadAlertAccounts(db, [a, b], "daily", new Date("2030-06-16T00:00:00Z"));
    expect(daily[0]?.nonFollowerReach).toEqual({
      recent: { numerator: 190, denominator: 600, days: 6 },
      base: { numerator: 100, denominator: 200, days: 2 },
      recentPosts: 3,
    });
    expect(daily[0]?.followers).toEqual({
      latest: { capturedOn: day(0), count: 1000 },
      previous: { capturedOn: day(-2), count: 1100 },
    });
    expect(daily[1]?.nonFollowerReach?.recentPosts).toBe(1);
    expect(daily[1]?.followers).toEqual({ latest: { capturedOn: day(0), count: 5 }, previous: null });

    const hourly = await loadAlertAccounts(db, [a, b], "hourly", new Date("2030-06-16T00:00:00Z"));
    expect(hourly[0]?.nonFollowerReach).toBeUndefined();
    expect(hourly[0]?.followers).toBeUndefined();
    expect(hourly[1]?.nonFollowerReach).toBeUndefined();
    expect(hourly[1]?.followers).toBeUndefined();

    // A: 基準 2 日で no_history、previous が 2 日前で no_history。B: 直近 1 日で no_history、previous なしで no_history。
    // credential がないので token も鳴るが、低下の 2 種類は鳴らない
    const result = evaluateAlerts({ accounts: daily }, new Date("2030-06-16T00:00:00Z"), "daily", false);
    expect(result.alerts.map((alert) => alert.kind)).toEqual(["token", "token"]);
    expect(result.noHistoryKinds).toEqual(["non_follower_reach_drop", "follower_drop", "stories"]);
    expect(result.noPosts).toBe(false);
  });
});
