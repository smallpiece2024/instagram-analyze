/**
 * `queries/tags.ts` の結合テスト（R5 設計 6.1 節「クエリ」、7.1 節「画面（結合）」の T3、T10）。
 * `TEST_DATABASE_URL` があるときだけ動く。架空のアカウント 2 つに架空の投稿とタグを作り、`afterAll` でアカウントを消す
 * （カスケードで関連行も消える）。手元の DB の本物の行は変えない。
 *
 *   アカウント A
 *     t1 フィード（10 日前、#Coffee #coffee）: 軸 X の値「旅行」、軸 Y の値「朝」
 *     t2 リール（5 日前、＃珈琲）: 軸 X の値「料理」
 *     u1 カルーセル（3 日前）: タグなし（軸 Y にだけ値）
 *     in365 フィード（365 日 - 1 分前）: 期間内
 *     out366 フィード（365 日 + 1 秒前、#old）: 期間外
 *     s1 ストーリーズ（1 日前）: 対象外（軸 X の値を付ける）
 *   アカウント B
 *     b1 フィード（2 日前、#coffee）: B の軸の値
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllDb } from "@/lib/db";
import { getHashtagStats, getTagAnalysis, getTagAxes } from "@/lib/queries/tags";
import { buildTagsView } from "@/lib/tags";
import {
  DAY_MS,
  fakeMediaId,
  insertFakeAccount,
  insertMedia,
  insertMediaTag,
  insertSnapshot,
  insertStory,
  insertTagAxis,
  insertTagValue,
  setWebEnv,
  storyMetrics,
} from "./fixtures";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("queries/tags（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  const ids = {
    t1: fakeMediaId(11),
    t2: fakeMediaId(12),
    u1: fakeMediaId(13),
    in365: fakeMediaId(14),
    out366: fakeMediaId(15),
    s1: fakeMediaId(16),
    b1: fakeMediaId(17),
  };
  let sql: postgres.Sql;
  let accountA = "";
  let accountB = "";
  const axis = { x: "", y: "", b: "" };
  const value = { travel: "", cook: "", morning: "", b: "" };
  let restoreEnv: () => void = () => {};

  beforeAll(async () => {
    restoreEnv = setWebEnv(url);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    accountA = await insertFakeAccount(sql, "fake_tags_a");
    accountB = await insertFakeAccount(sql, "fake_tags_b");
    const now = Date.now();
    const ago = (ms: number) => new Date(now - ms);

    const media = [
      { id: ids.t1, acc: accountA, at: ago(10 * DAY_MS), product: "FEED" as const, type: "IMAGE" as const, caption: "#Coffee #coffee" },
      { id: ids.t2, acc: accountA, at: ago(5 * DAY_MS), product: "REELS" as const, type: "VIDEO" as const, caption: "＃珈琲" },
      { id: ids.u1, acc: accountA, at: ago(3 * DAY_MS), product: "FEED" as const, type: "CAROUSEL_ALBUM" as const, caption: null },
      { id: ids.in365, acc: accountA, at: ago(365 * DAY_MS - 60_000), product: "FEED" as const, type: "IMAGE" as const, caption: null },
      { id: ids.out366, acc: accountA, at: ago(365 * DAY_MS + 1000), product: "FEED" as const, type: "IMAGE" as const, caption: "#old" },
      { id: ids.b1, acc: accountB, at: ago(2 * DAY_MS), product: "FEED" as const, type: "IMAGE" as const, caption: "#coffee" },
    ];
    for (const m of media) {
      await insertMedia(sql, { id: m.id, accountId: m.acc, postedAt: m.at, productType: m.product, mediaType: m.type, caption: m.caption });
      await insertSnapshot(sql, { mediaId: m.id, postedAt: m.at, fetchedAt: new Date(now), metrics: { reach: 100, views: 200, saved: 5 } });
    }
    await insertStory(sql, { id: ids.s1, accountId: accountA, postedAt: ago(DAY_MS), metrics: storyMetrics({ views: 10, reach: 10 }) });

    axis.x = await insertTagAxis(sql, { accountId: accountA, name: "テーマ", sortOrder: 0 });
    axis.y = await insertTagAxis(sql, { accountId: accountA, name: "時間帯", sortOrder: 1 });
    axis.b = await insertTagAxis(sql, { accountId: accountB, name: "テーマ", sortOrder: 0 });
    value.travel = await insertTagValue(sql, { axisId: axis.x, name: "旅行", sortOrder: 1 });
    value.cook = await insertTagValue(sql, { axisId: axis.x, name: "料理", sortOrder: 0 });
    await insertTagValue(sql, { axisId: axis.x, name: "未使用", sortOrder: 2 });
    value.morning = await insertTagValue(sql, { axisId: axis.y, name: "朝", sortOrder: 0 });
    value.b = await insertTagValue(sql, { axisId: axis.b, name: "B の値", sortOrder: 0 });

    await insertMediaTag(sql, { mediaId: ids.t1, accountId: accountA, axisId: axis.x, valueId: value.travel });
    await insertMediaTag(sql, { mediaId: ids.t1, accountId: accountA, axisId: axis.y, valueId: value.morning });
    await insertMediaTag(sql, { mediaId: ids.t2, accountId: accountA, axisId: axis.x, valueId: value.cook });
    await insertMediaTag(sql, { mediaId: ids.u1, accountId: accountA, axisId: axis.y, valueId: value.morning });
    await insertMediaTag(sql, { mediaId: ids.s1, accountId: accountA, axisId: axis.x, valueId: value.travel });
    await insertMediaTag(sql, { mediaId: ids.b1, accountId: accountB, axisId: axis.b, valueId: value.b });
  });

  afterAll(async () => {
    if (accountA !== "") await sql`delete from public.accounts where id = ${accountA}`;
    if (accountB !== "") await sql`delete from public.accounts where id = ${accountB}`;
    await closeAllDb();
    await sql.end({ timeout: 5 });
    restoreEnv();
  });

  it("getTagAxes: そのアカウントの軸だけ、並び順", async () => {
    const r = await getTagAxes(accountA);
    if (!r.ok) throw new Error(r.reason);
    expect(r.data.map((a) => a.id)).toEqual([axis.x, axis.y]);
  });

  it("getTagAnalysis: 「タグなし」は落ちず、投稿は重ならず、ストーリーズと期間外は入らない（T3、T10）", async () => {
    const r = await getTagAnalysis(accountA, axis.x);
    if (!r.ok) throw new Error(r.reason);
    const got = r.data.rows.map((x) => x.media_id);
    expect(got).toEqual([ids.u1, ids.t2, ids.t1, ids.in365]);
    expect(new Set(got).size).toBe(got.length);
    const byId = new Map(r.data.rows.map((x) => [x.media_id, x]));
    expect(byId.get(ids.t1)?.value_id).toBe(value.travel);
    expect(byId.get(ids.t2)?.value_id).toBe(value.cook);
    // 別の軸（Y）の値だけが付いた投稿は、軸 X では「タグなし」
    expect(byId.get(ids.u1)?.value_id).toBeNull();
    expect(byId.get(ids.in365)?.value_id).toBeNull();
    expect(byId.get(ids.t2)?.kind).toBe("reel");
    expect(byId.get(ids.u1)?.kind).toBe("carousel");
    expect(byId.get(ids.t1)?.reach).toBe(100);
    expect(r.data.values.map((v) => v.name)).toEqual(["料理", "旅行", "未使用"]);
    expect(r.data.last_fetched_at).not.toBeNull();
  });

  it("「タグ付き m 件」は n と同じ条件で数える（ストーリーズに付いた値は数えない）", async () => {
    const r = await getTagAnalysis(accountA, axis.x);
    if (!r.ok) throw new Error(r.reason);
    const view = buildTagsView(r.data.rows, r.data.values, [], "all", "reach");
    expect(view.total).toBe(4);
    expect(view.tagged).toBe(2);
    expect(view.tagRows.map((x) => [x.label, x.n])).toEqual([
      ["料理", 1],
      ["旅行", 1],
      ["未使用", 0],
      ["タグなし", 2],
    ]);
    const feeds = buildTagsView(r.data.rows, r.data.values, [], "feed", "reach");
    expect(feeds.total).toBe(2);
    expect(feeds.tagged).toBe(1);
  });

  it("別のアカウントの軸の id では値を付けない（2 アカウントを分ける）", async () => {
    const r = await getTagAnalysis(accountA, axis.b);
    if (!r.ok) throw new Error(r.reason);
    expect(r.data.rows.every((x) => x.value_id === null)).toBe(true);
    expect(r.data.values).toEqual([]);
    const rb = await getTagAnalysis(accountB, axis.b);
    if (!rb.ok) throw new Error(rb.reason);
    expect(rb.data.rows.map((x) => x.media_id)).toEqual([ids.b1]);
    expect(rb.data.rows[0]?.value_id).toBe(value.b);
  });

  it("軸がない（null）なら全部「タグなし」", async () => {
    const r = await getTagAnalysis(accountA, null);
    if (!r.ok) throw new Error(r.reason);
    expect(r.data.rows).toHaveLength(4);
    expect(r.data.rows.every((x) => x.value_id === null)).toBe(true);
    expect(r.data.values).toEqual([]);
  });

  it("getHashtagStats: 期間内のそのアカウントの投稿だけ、1 投稿 1 タグ", async () => {
    const r = await getHashtagStats(accountA);
    if (!r.ok) throw new Error(r.reason);
    const pairs = r.data.map((x) => `${x.tag}:${x.media_id}`).sort();
    expect(pairs).toEqual([`coffee:${ids.t1}`, `珈琲:${ids.t2}`].sort());
    const rb = await getHashtagStats(accountB);
    if (!rb.ok) throw new Error(rb.reason);
    expect(rb.data.map((x) => x.media_id)).toEqual([ids.b1]);
  });
});
