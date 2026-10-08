/**
 * `queries/audience.ts` の結合テスト（R5 設計 6.4 節、7.1 節「画面（結合）」）。
 * `TEST_DATABASE_URL` があるときだけ動く。架空のアカウントを 2 つ作り、`afterAll` で消す（カスケードで記録も消える）。
 * 区分の名前と人数は架空（S6）
 *
 *   A: 今週の follower の性別（ok）と都市（ok）、今週の follower の年齢（empty）、51 週前と 52 週前の follower の性別、
 *      今週の engaged の性別、今週の this_week の性別
 *   B: 今週の follower の性別（A と分かれることを確かめる）
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, buildAudienceView } from "@/lib/audience";
import { closeAllDb } from "@/lib/db";
import { getAudience } from "@/lib/queries/audience";
import { insertAudienceCapture, insertFakeAccount, jstWeekStart, setWebEnv } from "./fixtures";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("queries/audience（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  let sql: postgres.Sql;
  let accountA = "";
  let accountB = "";
  let restoreEnv: () => void = () => {};
  const thisWeek = jstWeekStart(new Date());
  const week51 = addDays(thisWeek, -51 * 7);
  const week52 = addDays(thisWeek, -52 * 7);

  beforeAll(async () => {
    restoreEnv = setWebEnv(url);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    accountA = await insertFakeAccount(sql, "fake_audience_a");
    accountB = await insertFakeAccount(sql, "fake_audience_b");
    await insertAudienceCapture(sql, { accountId: accountA, breakdown: "gender", weekStart: thisWeek, values: { F: 30, M: 10 } });
    await insertAudienceCapture(sql, {
      accountId: accountA,
      breakdown: "city",
      weekStart: thisWeek,
      values: { "CityA, PrefA": 7, "CityB, PrefB": 3 },
    });
    await insertAudienceCapture(sql, { accountId: accountA, breakdown: "age", weekStart: thisWeek, values: {} });
    await insertAudienceCapture(sql, { accountId: accountA, breakdown: "gender", weekStart: week51, values: { F: 1 } });
    await insertAudienceCapture(sql, { accountId: accountA, breakdown: "gender", weekStart: week52, values: { F: 2 } });
    await insertAudienceCapture(sql, {
      accountId: accountA,
      metric: "engaged_audience_demographics",
      breakdown: "gender",
      weekStart: thisWeek,
      values: { F: 4 },
    });
    await insertAudienceCapture(sql, {
      accountId: accountA,
      timeframe: "this_week",
      breakdown: "gender",
      weekStart: thisWeek,
      values: { U: 9 },
    });
    await insertAudienceCapture(sql, { accountId: accountB, breakdown: "gender", weekStart: thisWeek, values: { M: 5 } });
  });

  afterAll(async () => {
    if (sql) {
      if (accountA) await sql`delete from public.accounts where id = ${accountA}`;
      if (accountB) await sql`delete from public.accounts where id = ${accountB}`;
      await sql.end();
    }
    await closeAllDb();
    restoreEnv();
  });

  it("指標と timeframe とアカウントで絞り、直近 52 週だけを返す", async () => {
    const r = await getAudience(accountA, "follower_demographics", "this_month");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const weeks = [...new Set(r.data.map((row) => row.week_start))].sort();
    expect(weeks).toEqual([week51, thisWeek]);
    // 別のアカウント（M: 5）、this_week（U）、engaged の行は入らない
    const genderNow = r.data.filter((row) => row.week_start === thisWeek && row.breakdown === "gender");
    expect(genderNow.map((row) => [row.value_key, row.value])).toEqual([
      ["F", 30],
      ["M", 10],
    ]);
  });

  it("empty の記録は value_key と value が null の 1 行", async () => {
    const r = await getAudience(accountA, "follower_demographics", "this_month");
    if (!r.ok) throw new Error(r.reason);
    const age = r.data.filter((row) => row.breakdown === "age");
    expect(age).toHaveLength(1);
    expect(age[0]).toMatchObject({ status: "empty", value_key: null, value: null, week_start: thisWeek });
    expect(age[0]?.fetched_at).toBeInstanceOf(Date);
  });

  it("人数は数で返り、画面の値を作れる", async () => {
    const r = await getAudience(accountA, "follower_demographics", "this_month");
    if (!r.ok) throw new Error(r.reason);
    const view = buildAudienceView(r.data);
    expect(view.latestWeek).toBe(thisWeek);
    expect(view.weekCount).toBe(2);
    const city = view.cards.find((c) => c.breakdown === "city");
    expect(city?.kind).toBe("ok");
    if (city?.kind === "ok") expect(city.rows.map((x) => [x.label, x.value, x.share])).toEqual([
      ["CityA, PrefA", 7, 0.7],
      ["CityB, PrefB", 3, 0.3],
    ]);
    expect(view.cards.find((c) => c.breakdown === "age")?.kind).toBe("missing");
  });

  it("2 アカウントのデータを分ける", async () => {
    const b = await getAudience(accountB, "follower_demographics", "this_month");
    if (!b.ok) throw new Error(b.reason);
    expect(b.data.map((row) => [row.breakdown, row.value_key, row.value])).toEqual([["gender", "M", 5]]);
    const be = await getAudience(accountB, "engaged_audience_demographics", "this_month");
    if (!be.ok) throw new Error(be.reason);
    expect(be.data).toEqual([]);
  });

  it("engaged は engaged の記録だけ", async () => {
    const r = await getAudience(accountA, "engaged_audience_demographics", "this_month");
    if (!r.ok) throw new Error(r.reason);
    expect(r.data.map((row) => [row.breakdown, row.value_key, row.value])).toEqual([["gender", "F", 4]]);
  });
});
