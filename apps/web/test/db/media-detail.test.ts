/**
 * `queries/media-detail.ts` の結合テスト（R3 設計 3.4 節、4.5 節）と、投稿詳細の文字の組み立て（`_detail/text.ts`）の単体テスト。
 * 結合テストは `TEST_DATABASE_URL` があるときだけ動く。架空のアカウント 2 件（A を読み、B は分離の確認用）に
 * 投稿とスナップショットを作り、`afterAll` でアカウントを消す（カスケードで関連行も消える）。
 *
 * A の投稿（投稿日時はすべて P = 2026-08-01 00:00 UTC）:
 *   f1 フィード（自分）: 1h（経過 1h）reach 10、経過 6h reach 30、経過 10 日 reach 100（最新）
 *   f2 フィード: 1h reach 20、経過 7 日 + 1h reach 150（7 日の許容内）、10 日 reach 200（最新）
 *   f3 フィード: 経過 1.5h reach 40（1h の許容内）、10 日 reach 50（最新）
 *   f4 フィード: 10 日（reach のキーなし）
 *   c1 カルーセル: reach 9999（種類が違うので比べない）
 *   c2 カルーセル: 経過 1h の reach 7 だけ（経過の短い投稿も、最新の値どうしの比較相手に入る）
 *   s1 ストーリーズ（詳細に出さない）
 * A のフォロワー数: 2026-07-31 12:00 UTC に 1000（投稿前 3 日以内）→ f2 のリーチ率は 150 ÷ 1000
 * B の投稿: b1 フィード reach 5000、b2 カルーセル reach 8888
 * C の投稿（前回投稿からの日数の確認用。T0 = 2026-05-01 00:00 UTC）: p1 フィード（T0）→ s1 ストーリーズ（T0 + 10h）→ p2 リール（T0 + 36h）
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { topPercent } from "@/app/media/[id]/_detail/text";
import { closeAllDb } from "@/lib/db";
import { getMedia, getMediaHorizons, getOutlierFlag, getPeerHorizonStats, getPeerStats } from "@/lib/queries/media-detail";
import { tagEditHref } from "@/app/media/[id]/_detail/MediaTags";
import { getMediaTagSummary } from "@/lib/queries/tag-edit";
import {
  DAY_MS,
  fakeIgUserId,
  fakeMediaId,
  HOUR_MS,
  insertFakeAccount,
  insertMedia,
  insertMediaTag,
  insertOutlierPeerSet,
  insertSnapshot,
  insertStory,
  insertTagAxis,
  insertTagValue,
  setWebEnv,
  type FakeMedia,
} from "./fixtures";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe("投稿詳細の文字の組み立て", () => {
  it("topPercent: k = 大きい相手の数 + 1、m = 相手の数 + 1、上位 ⌈k ÷ m × 100⌉%", () => {
    expect(topPercent(1, 2)).toEqual({ percent: 67, rank: 2, of: 3 });
    expect(topPercent(0, 9)).toEqual({ percent: 10, rank: 1, of: 10 });
    expect(topPercent(0, 0)).toBeNull();
    expect(topPercent(null, 5)).toBeNull();
  });
});

describe.skipIf(!TEST_DATABASE_URL)("queries/media-detail（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  const igUserIdA = fakeIgUserId();
  const igUserIdB = fakeIgUserId();
  const ids = {
    f1: fakeMediaId(1),
    f2: fakeMediaId(2),
    f3: fakeMediaId(3),
    f4: fakeMediaId(4),
    c1: fakeMediaId(5),
    s1: fakeMediaId(6),
    b1: fakeMediaId(7),
    c2: fakeMediaId(8),
    b2: fakeMediaId(9),
  };
  const P = "2026-08-01T00:00:00Z";
  const H = 3600;
  const D = 86400;
  // 前回投稿からの日数の確認用（アカウント C）
  const prevIds = { p1: fakeMediaId(11), s1: fakeMediaId(12), p2: fakeMediaId(13) };
  const T0 = new Date("2026-05-01T00:00:00Z");
  let sql: postgres.Sql;
  let accountA = "";
  let accountB = "";
  let accountC = "";
  let restoreEnv: () => void = () => {};

  beforeAll(async () => {
    restoreEnv = setWebEnv(url);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    const accounts = await sql<{ id: string; ig_user_id: string }[]>`
      insert into public.accounts (ig_user_id, username, name)
      values (${igUserIdA}, 'fake_detail_a', null), (${igUserIdB}, 'fake_detail_b', null)
      returning id, ig_user_id
    `;
    accountA = accounts.find((r) => r.ig_user_id === igUserIdA)?.id ?? "";
    accountB = accounts.find((r) => r.ig_user_id === igUserIdB)?.id ?? "";
    expect(accountA).not.toBe("");
    expect(accountB).not.toBe("");

    const media = [
      { id: ids.f1, account_id: accountA, media_type: "IMAGE", media_product_type: "FEED", caption: "架空の一行目\n架空の二行目" },
      { id: ids.f2, account_id: accountA, media_type: "IMAGE", media_product_type: "FEED", caption: null },
      { id: ids.f3, account_id: accountA, media_type: "VIDEO", media_product_type: "FEED", caption: null },
      { id: ids.f4, account_id: accountA, media_type: "IMAGE", media_product_type: "FEED", caption: null },
      { id: ids.c1, account_id: accountA, media_type: "CAROUSEL_ALBUM", media_product_type: "FEED", caption: null },
      { id: ids.s1, account_id: accountA, media_type: "IMAGE", media_product_type: "STORY", caption: null },
      { id: ids.b1, account_id: accountB, media_type: "IMAGE", media_product_type: "FEED", caption: null },
      { id: ids.c2, account_id: accountA, media_type: "CAROUSEL_ALBUM", media_product_type: "FEED", caption: null },
      { id: ids.b2, account_id: accountB, media_type: "CAROUSEL_ALBUM", media_product_type: "FEED", caption: null },
    ];
    await sql`
      insert into public.media (id, account_id, media_type, media_product_type, posted_at, caption)
      select r.id, r.account_id, r.media_type, r.media_product_type, ${P}::timestamptz, r.caption
      from jsonb_to_recordset(${sql.json(media as unknown as postgres.JSONValue)})
        as r(id text, account_id uuid, media_type text, media_product_type text, caption text)
    `;

    const snaps: { media_id: string; elapsed: number; metrics: Record<string, number | null> }[] = [
      { media_id: ids.f1, elapsed: H, metrics: { reach: 10 } },
      { media_id: ids.f1, elapsed: 6 * H, metrics: { reach: 30 } },
      {
        media_id: ids.f1,
        elapsed: 10 * D,
        metrics: { reach: 100, views: 300, likes: 5, comments: 1, saved: 2, shares: 2, profile_visits: 4, follows: 1 },
      },
      { media_id: ids.f2, elapsed: H, metrics: { reach: 20 } },
      { media_id: ids.f2, elapsed: 7 * D + H, metrics: { reach: 150 } },
      {
        media_id: ids.f2,
        elapsed: 10 * D,
        metrics: { reach: 200, views: 400, likes: 10, comments: 0, saved: 10, shares: 0, profile_visits: 5, follows: 2 },
      },
      { media_id: ids.f3, elapsed: 1.5 * H, metrics: { reach: 40 } },
      { media_id: ids.f3, elapsed: 10 * D, metrics: { reach: 50, likes: 1, comments: 0, saved: 0, shares: 0 } },
      { media_id: ids.f4, elapsed: 10 * D, metrics: { views: 5 } },
      { media_id: ids.c1, elapsed: 10 * D, metrics: { reach: 9999, saved: 9999 } },
      { media_id: ids.s1, elapsed: 10 * H, metrics: { reach: 9999 } },
      { media_id: ids.b1, elapsed: 10 * D, metrics: { reach: 5000 } },
      { media_id: ids.c2, elapsed: H, metrics: { reach: 7 } },
      { media_id: ids.b2, elapsed: 10 * D, metrics: { reach: 8888 } },
    ];
    for (const s of snaps) {
      await sql`
        insert into public.media_insight_snapshots (media_id, fetched_at, elapsed_seconds, metrics)
        values (${s.media_id}, ${P}::timestamptz + make_interval(secs => ${s.elapsed}), ${s.elapsed}, ${sql.json(s.metrics)})
      `;
    }
    await sql`
      insert into public.profile_daily (account_id, captured_on, captured_at, followers_count)
      values (${accountA}, '2026-07-31', '2026-07-31T12:00:00Z', 1000)
    `;

    // アカウント C: p1 フィード（T0）→ s1 ストーリーズ（T0 + 10h）→ p2 リール（T0 + 36h）
    const [accC] = await sql<{ id: string }[]>`
      insert into public.accounts (ig_user_id, username, name) values (${fakeIgUserId()}, 'fake_detail_c', null) returning id
    `;
    accountC = accC?.id ?? "";
    expect(accountC).not.toBe("");
    const posts: FakeMedia[] = [
      { id: prevIds.p1, accountId: accountC, postedAt: T0, productType: "FEED", mediaType: "IMAGE" },
      { id: prevIds.p2, accountId: accountC, postedAt: new Date(T0.getTime() + 36 * HOUR_MS), productType: "REELS", mediaType: "VIDEO" },
    ];
    for (const p of posts) {
      await insertMedia(sql, p);
      await insertSnapshot(sql, {
        mediaId: p.id,
        postedAt: p.postedAt,
        fetchedAt: new Date(T0.getTime() + 10 * DAY_MS),
        metrics: { reach: 10 },
      });
    }
    await insertStory(sql, { id: prevIds.s1, accountId: accountC, postedAt: new Date(T0.getTime() + 10 * HOUR_MS), metrics: { reach: 5 } });
  });

  afterAll(async () => {
    for (const id of [accountA, accountB, accountC]) {
      if (id !== "") await sql`delete from public.accounts where id = ${id}`;
    }
    await closeAllDb();
    await sql.end({ timeout: 5 });
    restoreEnv();
  });

  it("getMedia: 最新の値を数で返し、派生指標とリーチ率の材料を持つ", async () => {
    const r = await getMedia(accountA, ids.f1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.data === null) throw new Error("投稿がない");
    const m = r.data;
    expect(m.kind).toBe("feed");
    expect(m.account_id).toBe(accountA);
    expect(m.caption).toBe("架空の一行目\n架空の二行目");
    expect(m.reach).toBe(100);
    expect(m.follows).toBe(1);
    expect(m.er).toBeCloseTo(0.1, 10);
    expect(m.save_rate).toBeCloseTo(0.02, 10);
    expect(m.elapsed_latest).toBe(10 * D);
    expect(m.latest_fetched_at).toBeInstanceOf(Date);
    expect(m.followers_at_post).toBe(1000);
    // 7 日の区分に当たるのは 10 日のスナップショット（許容外）なので、7 日時点の値はない
    expect(m.reach_7d).toBeNull();
    expect(m.reach_rate).toBeNull();

    const f2 = await getMedia(accountA, ids.f2);
    expect(f2.ok && f2.data?.reach_rate).toBeCloseTo(0.15, 10);
  });

  it("getMedia: 前回投稿からの時間。直前はストーリーズを除き種類を問わない。直前がなければ null、同時刻は id の順", async () => {
    // C: p2（リール、T0 + 36h）の直前は p1（フィード、T0）→ 36 時間。ストーリーズ s1（T0 + 10h）は直前にならない
    const p2 = await getMedia(accountC, prevIds.p2);
    expect(p2.ok && p2.data?.hours_since_previous_post).toBeCloseTo(36, 6);
    // 最初の投稿は null
    const p1 = await getMedia(accountC, prevIds.p1);
    expect(p1.ok && p1.data?.hours_since_previous_post).toBeNull();
    // A: すべて同時刻 P。f1 は id が最小なので直前なし、f2 の直前は f1 → 0 時間（種類を問わず、フィードどうしでも数える）
    const f1 = await getMedia(accountA, ids.f1);
    expect(f1.ok && f1.data?.hours_since_previous_post).toBeNull();
    const f2 = await getMedia(accountA, ids.f2);
    expect(f2.ok && f2.data?.hours_since_previous_post).toBeCloseTo(0, 6);
  });

  it("getMedia: ストーリーズ、ほかのアカウントの投稿、存在しない ID は null", async () => {
    expect(await getMedia(accountA, ids.s1)).toEqual({ ok: true, data: null });
    expect(await getMedia(accountA, ids.b1)).toEqual({ ok: true, data: null });
    expect(await getMedia(accountA, "0")).toEqual({ ok: true, data: null });
  });

  it("getMediaHorizons: 到達した区分だけを短い順に、within_tolerance と実際の経過時間つきで返す", async () => {
    const r = await getMediaHorizons(accountA, ids.f1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.map((p) => [p.horizon, p.within_tolerance, p.reach, p.elapsed_seconds])).toEqual([
      ["1h", true, 10, H],
      ["3h", false, 30, 6 * H],
      ["6h", true, 30, 6 * H],
      ["24h", false, 100, 10 * D],
      ["3d", false, 100, 10 * D],
      ["7d", false, 100, 10 * D],
    ]);
    // ほかのアカウントの投稿は読めない
    expect(await getMediaHorizons(accountA, ids.b1)).toEqual({ ok: true, data: [] });
  });

  it("getPeerHorizonStats: 同じ種類の自分を除く投稿の、許容内の値だけで区分ごとの分位を作る", async () => {
    const r = await getPeerHorizonStats(accountA, "feed", ids.f1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual([
      { horizon: "1h", n: 2, p25: 25, median: 30, p75: 35 },
      { horizon: "7d", n: 1, p25: 150, median: 150, p75: 150 },
    ]);
  });

  it("getPeerStats: 最新の値どうし。自分、ほかの種類、ほかのアカウントを除き、指標ごとに n を数える", async () => {
    const r = await getPeerStats(accountA, "feed", ids.f1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.data.stats;
    expect(s.reach).toEqual({ n: 2, min: 50, max: 200, mean: 125, p25: 87.5, median: 125, p75: 162.5 });
    expect(s.saved.n).toBe(2);
    expect(s.save_rate.n).toBe(2);
    expect(s.save_rate.max).toBeCloseTo(0.05, 10);
    // f3 はフォローのキーがない
    expect(s.follows).toMatchObject({ n: 1, median: 2 });
    // リーチ率は 7 日時点の値（f2 だけ）
    expect(s.reach_rate.n).toBe(1);
    expect(s.reach_rate.median).toBeCloseTo(0.15, 10);
    expect(s.avg_watch_time_s).toMatchObject({ n: 0, median: null });
    // f2（200）だけが f1（100）より大きい
    expect(r.data.reachGreater).toBe(1);
  });

  it("getPeerStats: 比較相手がいない種類は n = 0、この投稿のリーチ数がなければ順位の材料は null", async () => {
    const reel = await getPeerStats(accountA, "reel", ids.f1);
    expect(reel.ok && reel.data.stats.reach.n).toBe(0);
    const noReach = await getPeerStats(accountA, "feed", ids.f4);
    expect(noReach.ok && noReach.data.reachGreater).toBeNull();
    expect(noReach.ok && noReach.data.stats.reach.n).toBe(3);
  });

  it("getPeerStats: 経過の短い投稿（1h のスナップショットだけ）も比較相手に入り、ほかのアカウントの同じ種類は入らない", async () => {
    const c1 = await getPeerStats(accountA, "carousel", ids.c1);
    expect(c1.ok).toBe(true);
    if (!c1.ok) return;
    // c2 の 7 だけ（B の b2 の 8888 は入らない）
    expect(c1.data.stats.reach).toMatchObject({ n: 1, min: 7, max: 7, median: 7 });
    expect(c1.data.reachGreater).toBe(0);

    const c2 = await getPeerStats(accountA, "carousel", ids.c2);
    expect(c2.ok).toBe(true);
    if (!c2.ok) return;
    expect(c2.data.stats.reach).toMatchObject({ n: 1, min: 9999, max: 9999, median: 9999 });
    expect(c2.data.reachGreater).toBe(1);
  });
});

// ---------------------------------------------------------------
// R5: 投稿詳細のタグの表示（R5 設計 6.2 節「投稿詳細の変更」。担当 3B）
// ---------------------------------------------------------------

describe("投稿詳細の「タグを編集」のリンク", () => {
  it("tagEditHref: 編集画面の表（1 ページ 50 件）でのページと行のアンカー。1 ページ目には page を付けない", () => {
    expect(tagEditHref("1789", 0)).toBe("/tags/edit#m-1789");
    expect(tagEditHref("1789", 49)).toBe("/tags/edit#m-1789");
    expect(tagEditHref("1789", 50)).toBe("/tags/edit?page=2#m-1789");
    expect(tagEditHref("1789", 120)).toBe("/tags/edit?page=3#m-1789");
    expect(tagEditHref("1789", -1)).toBe("/tags/edit#m-1789");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("queries/tag-edit の getMediaTagSummary（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  let sql: postgres.Sql;
  let accountA = "";
  let accountB = "";
  let restoreEnv: () => void = () => {};
  const P = new Date("2026-08-01T00:00:00Z");
  const ids = { old: fakeMediaId(201), mid: fakeMediaId(202), story: fakeMediaId(203), newer: fakeMediaId(204), b1: fakeMediaId(205) };
  let axis1 = "";
  let axis2 = "";

  beforeAll(async () => {
    restoreEnv = setWebEnv(url);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    accountA = await insertFakeAccount(sql, "fake_detail_tag_a");
    accountB = await insertFakeAccount(sql, "fake_detail_tag_b");
    await insertMedia(sql, { id: ids.old, accountId: accountA, postedAt: P });
    await insertMedia(sql, { id: ids.mid, accountId: accountA, postedAt: new Date(P.getTime() + HOUR_MS) });
    // ストーリーズは編集画面の表に出ないので、位置に数えない
    await insertMedia(sql, { id: ids.story, accountId: accountA, postedAt: new Date(P.getTime() + 2 * HOUR_MS), productType: "STORY" });
    await insertMedia(sql, { id: ids.newer, accountId: accountA, postedAt: new Date(P.getTime() + 3 * HOUR_MS) });
    await insertMedia(sql, { id: ids.b1, accountId: accountB, postedAt: new Date(P.getTime() + 4 * HOUR_MS) });
    // 軸の並び順は 2 番目に作った軸を先に（sort_order で並ぶことを確かめる）
    axis1 = await insertTagAxis(sql, { accountId: accountA, name: "テーマ", sortOrder: 1 });
    axis2 = await insertTagAxis(sql, { accountId: accountA, name: "<script>目的</script>", sortOrder: 0 });
    const v1 = await insertTagValue(sql, { axisId: axis1, name: "旅" });
    const v2 = await insertTagValue(sql, { axisId: axis2, name: "認知" });
    await insertMediaTag(sql, { mediaId: ids.old, accountId: accountA, axisId: axis1, valueId: v1 });
    await insertMediaTag(sql, { mediaId: ids.old, accountId: accountA, axisId: axis2, valueId: v2 });
    const bAxis = await insertTagAxis(sql, { accountId: accountB, name: "B の軸" });
    const bValue = await insertTagValue(sql, { axisId: bAxis, name: "B の値" });
    await insertMediaTag(sql, { mediaId: ids.b1, accountId: accountB, axisId: bAxis, valueId: bValue });
  });

  afterAll(async () => {
    for (const id of [accountA, accountB]) {
      if (id !== "") await sql`delete from public.accounts where id = ${id}`;
    }
    await closeAllDb();
    await sql.end({ timeout: 5 });
    restoreEnv();
  });

  it("付いているタグを軸の並び順（sort_order、同じなら id）で返す。名前は文字列のまま", async () => {
    const r = await getMediaTagSummary(accountA, ids.old);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.tags).toEqual([
      { axis_name: "<script>目的</script>", value_name: "認知" },
      { axis_name: "テーマ", value_name: "旅" },
    ]);
  });

  it("位置は編集画面の表（新しい順、ストーリーズを除く）で前にある投稿の数", async () => {
    const old = await getMediaTagSummary(accountA, ids.old);
    const newer = await getMediaTagSummary(accountA, ids.newer);
    expect(old.ok && old.data.position).toBe(2);
    expect(newer.ok && newer.data.position).toBe(0);
  });

  it("タグがなければ空。別のアカウントの投稿のタグは読めない", async () => {
    const mid = await getMediaTagSummary(accountA, ids.mid);
    expect(mid.ok && mid.data.tags).toEqual([]);
    const other = await getMediaTagSummary(accountA, ids.b1);
    expect(other.ok && other.data).toEqual({ tags: [], position: 0 });
  });
});

// ---------------------------------------------------------------
// R6: 伸びた／課題の印（R6 設計 3.4 節、6.3 節 U13。担当 3B）
// ---------------------------------------------------------------

/**
 * `getOutlierFlag` の結合テスト。架空のアカウント A と B を作り、`afterAll` で消す。
 *   A のフィード: 比較対象 8 件（シェア 0〜7 ／ リーチ 64）+ 外れ値（シェア 16 ／ 64 = 1/4）
 *     → 四分位は 1.75/64、3.5/64、5.25/64。上限 = Q3 + 1.5 × IQR = 10.5/64 < 1/4 なので high
 *   A のカルーセル: 比較対象 7 件（シェア 0）+ 外れ値 → 8 件未満なので share_flag は null、peer_n は 7 のまま
 *   A のストーリーズ: ビューにない → null
 *   B のフィード: 比較対象 8 件 + 外れ値 → A の id で読むと null
 */
describe.skipIf(!TEST_DATABASE_URL)("queries/media-detail の getOutlierFlag（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  // ほかの describe と ID が重ならないよう 400 番台を使う
  let seq = 400;
  const nextId = () => fakeMediaId(seq++);
  const D = 86400;
  let sql: postgres.Sql;
  let accountA = "";
  let accountB = "";
  let feed: { peerIds: string[]; outlierId: string } = { peerIds: [], outlierId: "" };
  let carousel: { peerIds: string[]; outlierId: string } = { peerIds: [], outlierId: "" };
  let other: { peerIds: string[]; outlierId: string } = { peerIds: [], outlierId: "" };
  let storyId = "";
  let restoreEnv: () => void = () => {};

  beforeAll(async () => {
    restoreEnv = setWebEnv(url);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    accountA = await insertFakeAccount(sql, "fake_detail_flag_a");
    accountB = await insertFakeAccount(sql, "fake_detail_flag_b");
    feed = await insertOutlierPeerSet(sql, { accountId: accountA, kind: "feed", peerCount: 8, nextId, peerShares: (i) => i });
    carousel = await insertOutlierPeerSet(sql, { accountId: accountA, kind: "carousel", peerCount: 7, nextId });
    storyId = nextId();
    await insertMedia(sql, { id: storyId, accountId: accountA, postedAt: new Date(), productType: "STORY" });
    other = await insertOutlierPeerSet(sql, { accountId: accountB, kind: "feed", peerCount: 8, nextId });
  });

  afterAll(async () => {
    for (const id of [accountA, accountB]) {
      if (id !== "") await sql`delete from public.accounts where id = ${id}`;
    }
    await closeAllDb();
    await sql.end({ timeout: 5 });
    restoreEnv();
  });

  it("比較対象 8 件: 四分位（シェア率）、peer_n、share_rate、elapsed_latest を数で返し、share_flag は high", async () => {
    const r = await getOutlierFlag(accountA, feed.outlierId);
    expect(r.ok).toBe(true);
    if (!r.ok || r.data === null) throw new Error("行がない");
    expect(r.data.media_id).toBe(feed.outlierId);
    expect(r.data.peer_n).toBe(8);
    expect(r.data.peer_q1).toBeCloseTo(1.75 / 64, 10);
    expect(r.data.peer_median).toBeCloseTo(3.5 / 64, 10);
    expect(r.data.peer_q3).toBeCloseTo(5.25 / 64, 10);
    expect(r.data.share_rate).toBeCloseTo(0.25, 10);
    expect(r.data.elapsed_latest).toBe(7 * D);
    expect(r.data.share_flag).toBe("high");
  });

  it("比較対象 7 件: share_flag は null（判定しない）で、peer_n = 7 と四分位はそのまま返す", async () => {
    const r = await getOutlierFlag(accountA, carousel.outlierId);
    expect(r.ok).toBe(true);
    if (!r.ok || r.data === null) throw new Error("行がない");
    expect(r.data.peer_n).toBe(7);
    expect(r.data.share_flag).toBeNull();
    expect(r.data.peer_q1).toBe(0);
    expect(r.data.peer_median).toBe(0);
    expect(r.data.peer_q3).toBe(0);
  });

  it("比較対象 0 件（最古の投稿）: peer_n = 0、四分位は null、share_flag は null", async () => {
    const r = await getOutlierFlag(accountA, feed.peerIds[0] ?? "");
    expect(r.ok).toBe(true);
    if (!r.ok || r.data === null) throw new Error("行がない");
    expect(r.data).toMatchObject({ peer_n: 0, peer_q1: null, peer_median: null, peer_q3: null, share_flag: null });
  });

  it("ストーリーズ、ほかのアカウントの投稿、存在しない ID は null", async () => {
    expect(await getOutlierFlag(accountA, storyId)).toEqual({ ok: true, data: null });
    expect(await getOutlierFlag(accountA, other.outlierId)).toEqual({ ok: true, data: null });
    expect(await getOutlierFlag(accountA, "0")).toEqual({ ok: true, data: null });
  });
});
