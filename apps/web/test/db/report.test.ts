/**
 * `queries/report.ts` の結合テスト（R6 設計 7.1 節「画面（結合）」）。
 * `TEST_DATABASE_URL` があるときだけ動く。架空のアカウント 2 つに架空の投稿、ストーリーズ、タグ、日次指標を作り、`afterAll` で
 * アカウントを消す（カスケードで関連行も消える）。手元の DB の本物の行は変えない。
 *
 *   アカウント A（2026 年 9 月〜10 月）
 *     p1 フィード  JST 9/30 23:59 → 9 月
 *     p2 フィード  JST 10/1 0:00  → 10 月（reach 100、profile_visits 10、follows 2、タグ v1）
 *     p3 カルーセル 10/5           （reach 200、profile_visits 20、follows 4、タグなし）
 *     p5 フィード  10/7            （reach null → シェア率 null）
 *     リール 9 件（比較対象 8 + 外れ値 1。10/12〜10/20。外れ値は share_flag = high）
 *     s1 ストーリーズ JST 10/1 0:00 → 10 月、s2 ストーリーズ JST 9/30 23:59 → 9 月
 *     日次指標 metric_date 9/30（reach 30）、10/1（reach 10）
 *   アカウント B
 *     b1 フィード 10/3、B の軸
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllDb } from "@/lib/db";
import { getDailyTotals } from "@/lib/queries/period-summary";
import { getKindSummary, getMonthFunnel, getMonthHighlights, getStorySummary, getTagMonthly } from "@/lib/queries/report";
import { splitHighlights } from "@/lib/report";
import { tagGroupRows, UNTAGGED_LABEL } from "@/lib/tags";
import {
  fakeMediaId,
  insertAccountDailyMetrics,
  insertFakeAccount,
  insertMedia,
  insertMediaTag,
  insertOutlierPeerSet,
  insertSnapshot,
  insertStory,
  insertTagAxis,
  insertTagValue,
  postMetrics,
  setWebEnv,
  storyMetrics,
} from "./fixtures";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const OCT = { from: "2026-10-01", to: "2026-10-31" } as const;
const SEP = { from: "2026-09-01", to: "2026-09-30" } as const;

describe.skipIf(!TEST_DATABASE_URL)("queries/report（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  let seq = 610;
  const nextId = () => fakeMediaId(seq++);
  const ids = {
    p1: nextId(),
    p2: nextId(),
    p3: nextId(),
    p5: nextId(),
    s1: nextId(),
    s2: nextId(),
    b1: nextId(),
  };
  let sql: postgres.Sql;
  let accountA = "";
  let accountB = "";
  let axisA = "";
  let valueA = "";
  let outlierId = "";
  let peerIds: string[] = [];
  let restoreEnv: () => void = () => {};

  beforeAll(async () => {
    restoreEnv = setWebEnv(url);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    accountA = await insertFakeAccount(sql, "fake_report_a");
    accountB = await insertFakeAccount(sql, "fake_report_b");
    const fetched = (postedAt: Date) => new Date(postedAt.getTime() + 7 * 24 * 60 * 60 * 1000);

    const posts = [
      // JST 9/30 23:59 = UTC 9/30 14:59
      { id: ids.p1, acc: accountA, at: new Date("2026-09-30T14:59:00Z"), type: "IMAGE" as const, metrics: { ...postMetrics({ reach: 100, shares: 1 }), profile_visits: 1, follows: 0 } },
      // JST 10/1 0:00 = UTC 9/30 15:00
      {
        id: ids.p2,
        acc: accountA,
        at: new Date("2026-09-30T15:00:00Z"),
        type: "IMAGE" as const,
        metrics: { ...postMetrics({ reach: 100, shares: 2, likes: 1, comments: 1, saved: 2, views: 300 }), profile_visits: 10, follows: 2 },
      },
      {
        id: ids.p3,
        acc: accountA,
        at: new Date("2026-10-05T03:00:00Z"),
        type: "CAROUSEL_ALBUM" as const,
        metrics: { ...postMetrics({ reach: 200, shares: 0, saved: 4, views: 400 }), profile_visits: 20, follows: 4 },
      },
      { id: ids.p5, acc: accountA, at: new Date("2026-10-07T03:00:00Z"), type: "IMAGE" as const, metrics: postMetrics({ reach: null, shares: 1, views: 50 }) },
      { id: ids.b1, acc: accountB, at: new Date("2026-10-03T03:00:00Z"), type: "IMAGE" as const, metrics: { ...postMetrics({ reach: 50, shares: 5 }), profile_visits: 5, follows: 1 } },
    ];
    for (const p of posts) {
      await insertMedia(sql, { id: p.id, accountId: p.acc, postedAt: p.at, productType: "FEED", mediaType: p.type });
      await insertSnapshot(sql, { mediaId: p.id, postedAt: p.at, fetchedAt: fetched(p.at), metrics: p.metrics });
    }
    const set = await insertOutlierPeerSet(sql, {
      accountId: accountA,
      kind: "reel",
      peerCount: 8,
      nextId,
      latestPostedAt: new Date("2026-10-20T03:00:00Z"),
    });
    outlierId = set.outlierId;
    peerIds = set.peerIds;

    await insertStory(sql, { id: ids.s1, accountId: accountA, postedAt: new Date("2026-09-30T15:00:00Z"), metrics: storyMetrics({ views: 100, reach: 90, tapExit: 10, swipeForward: 5 }) });
    await insertStory(sql, { id: ids.s2, accountId: accountA, postedAt: new Date("2026-09-30T14:59:00Z"), metrics: storyMetrics({ views: 40, reach: 30, tapExit: 4, swipeForward: 2 }) });

    await insertAccountDailyMetrics(sql, { accountId: accountA, metricDate: "2026-09-30", reach: 30 });
    await insertAccountDailyMetrics(sql, { accountId: accountA, metricDate: "2026-10-01", reach: 10 });

    axisA = await insertTagAxis(sql, { accountId: accountA, name: "テーマ", sortOrder: 0 });
    valueA = await insertTagValue(sql, { axisId: axisA, name: "旅行", sortOrder: 0 });
    await insertTagValue(sql, { axisId: axisA, name: "未使用", sortOrder: 1 });
    const axisB = await insertTagAxis(sql, { accountId: accountB, name: "B の軸", sortOrder: 0 });
    const valueB = await insertTagValue(sql, { axisId: axisB, name: "B の値", sortOrder: 0 });
    await insertMediaTag(sql, { mediaId: ids.p2, accountId: accountA, axisId: axisA, valueId: valueA });
    await insertMediaTag(sql, { mediaId: ids.b1, accountId: accountB, axisId: axisB, valueId: valueB });
  });

  afterAll(async () => {
    if (accountA !== "") await sql`delete from public.accounts where id = ${accountA}`;
    if (accountB !== "") await sql`delete from public.accounts where id = ${accountB}`;
    await closeAllDb();
    await sql.end({ timeout: 5 });
    restoreEnv();
  });

  it("getKindSummary: 暦月の境目（JST 9/30 23:59 は 9 月、10/1 0:00 は 10 月）、種類ごとの件数と Σの比", async () => {
    const oct = await getKindSummary(accountA, OCT.from, OCT.to);
    if (!oct.ok) throw new Error(oct.reason);
    expect(oct.data.map((k) => k.kind)).toEqual(["feed", "carousel", "reel"]);
    const [feed, carousel, reel] = oct.data;
    expect(feed?.posts).toBe(2); // p2、p5
    expect(feed?.reach).toEqual({ sum: 100, used: 1, total: 2 }); // p5 は reach null
    expect(feed?.views).toEqual({ sum: 350, used: 2, total: 2 });
    expect(feed?.er).toEqual({ value: 0.06, used: 1, total: 2 }); // (1 + 1 + 2 + 2) / 100。p5 は分母がないので除く
    expect(feed?.saveRate).toEqual({ value: 0.02, used: 1, total: 2 });
    expect(feed?.shareRate).toEqual({ value: 0.02, used: 1, total: 2 });
    expect(feed?.profileVisits).toEqual({ sum: 10, used: 1, total: 2 });
    expect(carousel?.posts).toBe(1);
    expect(carousel?.er).toEqual({ value: 0.02, used: 1, total: 1 });
    expect(carousel?.shareRate).toEqual({ value: 0, used: 1, total: 1 });
    expect(reel?.posts).toBe(9);
    expect(reel?.reach).toEqual({ sum: 9 * 64, used: 9, total: 9 });
    expect(reel?.shareRate).toEqual({ value: 16 / (9 * 64), used: 9, total: 9 });
    expect(reel?.profileVisits).toEqual({ sum: null, used: 0, total: 9 });

    const sep = await getKindSummary(accountA, SEP.from, SEP.to);
    if (!sep.ok) throw new Error(sep.reason);
    expect(sep.data.map((k) => k.posts)).toEqual([1, 0, 0]); // p1 だけ
    expect(sep.data[1]).toMatchObject({ kind: "carousel", posts: 0, reach: { sum: null, used: 0, total: 0 }, er: { value: null, used: 0, total: 0 } });
  });

  it("getKindSummary: 2 アカウントを分ける", async () => {
    const b = await getKindSummary(accountB, OCT.from, OCT.to);
    if (!b.ok) throw new Error(b.reason);
    expect(b.data.map((k) => k.posts)).toEqual([1, 0, 0]);
    expect(b.data[0]?.shareRate).toEqual({ value: 0.1, used: 1, total: 1 });
  });

  it("getStorySummary: story_day_jst の暦月で絞り、件数・Σ閲覧・離脱率", async () => {
    const oct = await getStorySummary(accountA, OCT.from, OCT.to);
    if (!oct.ok) throw new Error(oct.reason);
    expect(oct.data).toEqual({
      posts: 1,
      views: { sum: 100, used: 1, total: 1 },
      tapExit: { sum: 10, used: 1, total: 1 },
      exitRate: { value: 0.1, used: 1, total: 1 },
    });
    const sep = await getStorySummary(accountA, SEP.from, SEP.to);
    if (!sep.ok) throw new Error(sep.reason);
    expect(sep.data.posts).toBe(1);
    expect(sep.data.views.sum).toBe(40);
    const b = await getStorySummary(accountB, OCT.from, OCT.to);
    if (!b.ok) throw new Error(b.reason);
    expect(b.data).toEqual({
      posts: 0,
      views: { sum: null, used: 0, total: 0 },
      tapExit: { sum: null, used: 0, total: 0 },
      exitRate: { value: null, used: 0, total: 0 },
    });
  });

  it("getMonthHighlights: 印を持ち、ストーリーズと別の月と別のアカウントを含まず、account_id でも結合する", async () => {
    const r = await getMonthHighlights(accountA, OCT.from, OCT.to);
    if (!r.ok) throw new Error(r.reason);
    const got = r.data.map((m) => m.media_id);
    expect(got).toHaveLength(12); // p2、p3、p5、リール 9 件
    expect(got).not.toContain(ids.p1);
    expect(got).not.toContain(ids.s1);
    expect(got).not.toContain(ids.b1);
    expect(new Set(got).size).toBe(got.length);
    const byId = new Map(r.data.map((m) => [m.media_id, m]));
    const outlier = byId.get(outlierId);
    expect(outlier?.share_flag).toBe("high");
    expect(outlier?.peer_n).toBe(8);
    expect(outlier?.kind).toBe("reel");
    expect(outlier?.share_rate).toBe(0.25);
    expect(outlier?.elapsed_latest).toBe(7 * 24 * 60 * 60);
    // 比較対象が 8 件未満の投稿は判定しない（share_flag null）が、行は返す
    expect(byId.get(peerIds[0] ?? "")?.share_flag).toBeNull();
    expect(byId.get(peerIds[0] ?? "")?.peer_n).toBe(0);
    // シェア率 null の投稿も行は返す（選び方は splitHighlights が除く）
    expect(byId.get(ids.p5)?.share_rate).toBeNull();
    expect(byId.get(ids.p2)?.kind).toBe("feed");
    expect(byId.get(ids.p3)?.kind).toBe("carousel");

    const { top, bottom } = splitHighlights(r.data);
    expect(top[0]?.media_id).toBe(outlierId);
    expect(top).toHaveLength(3);
    expect(bottom).toHaveLength(3);
    expect([...top, ...bottom].map((m) => m.media_id)).not.toContain(ids.p5);

    const b = await getMonthHighlights(accountB, OCT.from, OCT.to);
    if (!b.ok) throw new Error(b.reason);
    expect(b.data.map((m) => m.media_id)).toEqual([ids.b1]);
  });

  it("getMonthFunnel: フィードとカルーセルの 3 つがそろう投稿だけ、ストーリーズは 3 つがそろう行だけ", async () => {
    const r = await getMonthFunnel(accountA, OCT.from, OCT.to);
    if (!r.ok) throw new Error(r.reason);
    expect(r.data).toEqual({
      posts: {
        reach: { sum: 300, used: 2, total: 3 }, // p2 + p3。p5 は reach null、リールは対象外
        profileVisits: { sum: 30, used: 2, total: 3 },
        follows: { sum: 6, used: 2, total: 3 },
      },
      stories: {
        views: { sum: 100, used: 1, total: 1 },
        tapExit: { sum: 10, used: 1, total: 1 },
        swipeForward: { sum: 5, used: 1, total: 1 },
      },
    });
    const b = await getMonthFunnel(accountB, OCT.from, OCT.to);
    if (!b.ok) throw new Error(b.reason);
    expect(b.data.posts).toEqual({
      reach: { sum: 50, used: 1, total: 1 },
      profileVisits: { sum: 5, used: 1, total: 1 },
      follows: { sum: 1, used: 1, total: 1 },
    });
    expect(b.data.stories.views).toEqual({ sum: null, used: 0, total: 0 });
  });

  it("getTagMonthly: 軸ごとに暦月の投稿を返し、「タグなし」を含み、別のアカウントの軸を含まない", async () => {
    const r = await getTagMonthly(accountA, OCT.from, OCT.to);
    if (!r.ok) throw new Error(r.reason);
    expect(r.data.axes.map((a) => a.id)).toEqual([axisA]);
    expect(r.data.values[axisA]?.map((v) => v.name)).toEqual(["旅行", "未使用"]);
    const rows = r.data.rows.filter((x) => x.axis_id === axisA);
    expect(rows).toHaveLength(12);
    expect(rows.map((x) => x.media_id)).not.toContain(ids.p1);
    expect(rows.map((x) => x.media_id)).not.toContain(ids.s1);
    const byId = new Map(rows.map((x) => [x.media_id, x]));
    expect(byId.get(ids.p2)?.value_id).toBe(valueA);
    expect(byId.get(ids.p3)?.value_id).toBeNull();
    expect(byId.get(ids.p2)?.reach).toBe(100);

    const groups = tagGroupRows(rows, r.data.values[axisA] ?? [], "reach");
    expect(groups.map((g) => [g.label, g.n])).toEqual([
      ["旅行", 1],
      ["未使用", 0],
      [UNTAGGED_LABEL, 11],
    ]);
    expect(groups[0]?.medians.share_rate.value).toBe(0.02);

    const b = await getTagMonthly(accountB, OCT.from, OCT.to);
    if (!b.ok) throw new Error(b.reason);
    expect(b.data.axes.map((a) => a.name)).toEqual(["B の軸"]);
    expect(b.data.rows.map((x) => x.media_id)).toEqual([ids.b1]);
  });

  it("getTagMonthly: 軸が 0 件なら空", async () => {
    const r = await getTagMonthly(accountA, "2000-01-01", "2000-01-31");
    if (!r.ok) throw new Error(r.reason);
    expect(r.data.rows).toEqual([]);
    expect(r.data.axes).toHaveLength(1);
  });

  it("日次指標は metric_date（太平洋時間）の暦月（9/30 の行は 10 月に入らない）", async () => {
    const oct = await getDailyTotals(accountA, OCT.from, OCT.to);
    if (!oct.ok) throw new Error(oct.reason);
    expect(oct.data.reach).toEqual({ sum: 10, days: 1 });
    const sep = await getDailyTotals(accountA, SEP.from, SEP.to);
    if (!sep.ok) throw new Error(sep.reason);
    expect(sep.data.reach).toEqual({ sum: 30, days: 1 });
  });

  it("account_daily_wide: fixture の列の対応（saves → saved、follower_count → new_followers、follow_type の内訳）と、getDailyTotals の率は内訳や 4 指標のそろう日だけで計算する", async () => {
    // B にだけ入れる（A の 9/30・10/1 の期待値を変えない）。値は架空
    await insertAccountDailyMetrics(sql, {
      accountId: accountB,
      metricDate: "2026-10-02",
      reach: 20,
      views: 7,
      likes: 1,
      comments: 1,
      shares: 1,
      saved: 2,
      newFollowers: 3,
      reachFollower: 15,
      reachNonFollower: 5,
      viewsFollower: 4,
      viewsNonFollower: 3,
    });
    // 内訳も反応もない日（率の分母に入らない）。views は行があって null
    await insertAccountDailyMetrics(sql, { accountId: accountB, metricDate: "2026-10-03", reach: 10, views: null });

    const [wide] = await sql<Record<string, number | null>[]>`
      select reach::int as reach, views::int as views, likes::int as likes, comments::int as comments, shares::int as shares,
             saved::int as saved, new_followers::int as new_followers,
             reach_follower::int as reach_follower, reach_non_follower::int as reach_non_follower,
             views_follower::int as views_follower, views_non_follower::int as views_non_follower
      from public.account_daily_wide where account_id = ${accountB} and metric_date = '2026-10-02'
    `;
    expect(wide).toEqual({
      reach: 20,
      views: 7,
      likes: 1,
      comments: 1,
      shares: 1,
      saved: 2,
      new_followers: 3,
      reach_follower: 15,
      reach_non_follower: 5,
      views_follower: 4,
      views_non_follower: 3,
    });
    const [sparse] = await sql<Record<string, number | null>[]>`
      select reach::int as reach, views::int as views, saved::int as saved, new_followers::int as new_followers,
             reach_non_follower::int as reach_non_follower
      from public.account_daily_wide where account_id = ${accountB} and metric_date = '2026-10-03'
    `;
    expect(sparse).toEqual({ reach: 10, views: null, saved: null, new_followers: null, reach_non_follower: null });

    const oct = await getDailyTotals(accountB, OCT.from, OCT.to);
    if (!oct.ok) throw new Error(oct.reason);
    expect(oct.data.periodDays).toBe(31);
    expect(oct.data.reach).toEqual({ sum: 30, days: 2 });
    expect(oct.data.views).toEqual({ sum: 7, days: 1 });
    expect(oct.data.nonFollowerReachRate.value).toBeCloseTo(5 / 20, 10);
    expect(oct.data.nonFollowerReachRate).toMatchObject({ used: 1, total: 31 });
    expect(oct.data.er.value).toBeCloseTo((1 + 1 + 2 + 1) / 20, 10);
    expect(oct.data.er).toMatchObject({ used: 1, total: 31 });
    expect(oct.data.saveRate.value).toBeCloseTo(2 / 20, 10);
    expect(oct.data.shareRate.value).toBeCloseTo(1 / 20, 10);
    expect(oct.data.shareRate).toMatchObject({ used: 1, total: 31 });
  });
});
