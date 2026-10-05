/**
 * `queries/media.ts` の結合テスト（R3 設計 3.3 節、4.5 節、7 章）。
 * `TEST_DATABASE_URL` があるときだけ動く（`mediaTitle` の単体テストは `test/format.test.ts`）。
 * 架空のアカウント 1 件に、フィード 51 件、リール 1 件、ストーリーズ 1 件（一覧に出ない）とスナップショットを作り、
 * `afterAll` でアカウントを消す（カスケードで関連行も消える）。読み出しはすべて架空のアカウントの `accountId` で絞る。
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MEDIA_CSV_COLUMNS } from "@/lib/csv";
import { closeAllDb } from "@/lib/db";
import { PAGE_SIZE } from "@/lib/format";
import {
  countMedia,
  getMediaBaseline,
  getMediaPage,
  listMedia,
  listMediaCsvRows,
  type MediaListParams,
} from "@/lib/queries/media";
import { fakeIgUserId, fakeMediaId, HOUR_MS, MINUTE_MS, setWebEnv } from "./fixtures";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
/** フィードの件数（1 ページ分 + 1） */
const FEED_COUNT = PAGE_SIZE + 1;
const DEFAULT_PARAMS: MediaListParams = { sort: "posted", order: "desc", page: 1, er: "reach" };

describe.skipIf(!TEST_DATABASE_URL)("queries/media（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  const igUserId = fakeIgUserId();
  const now = new Date();
  /** seq が小さいほど新しい（seq 0 がフィードの最新） */
  const feedIds = Array.from({ length: FEED_COUNT }, (_, seq) => fakeMediaId(seq));
  const reelId = fakeMediaId(800);
  const storyId = fakeMediaId(900);
  const [f0 = "", f1 = "", f2 = ""] = feedIds;
  let sql: postgres.Sql;
  let accountId = "";
  let restoreEnv: () => void = () => {};

  beforeAll(async () => {
    // Storage は thumbnail_path が null なので呼ばれない
    restoreEnv = setWebEnv(url);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    const [account] = await sql<{ id: string }[]>`
      insert into public.accounts (ig_user_id, username, name)
      values (${igUserId}, 'fake_web_media', 'Fake Media')
      returning id
    `;
    accountId = account?.id ?? "";
    expect(accountId).not.toBe("");

    const feedRows = feedIds.map((id, seq) => ({
      id,
      account_id: accountId,
      media_type: "IMAGE",
      media_product_type: "FEED",
      posted_at: new Date(now.getTime() - (seq + 1) * MINUTE_MS),
      caption: seq === 0 ? "架空の題名\n本文" : null,
      permalink: "https://www.instagram.com/p/fake/",
    }));
    await sql`insert into public.media ${sql(feedRows, "id", "account_id", "media_type", "media_product_type", "posted_at", "caption", "permalink")}`;
    // リールはフィードより新しく、ストーリーズはさらに新しい（一覧には出ない）
    await sql`
      insert into public.media (id, account_id, media_type, media_product_type, posted_at, permalink)
      values
        (${reelId}, ${accountId}, 'VIDEO', 'REELS', ${new Date(now.getTime() - 30_000)}, null),
        (${storyId}, ${accountId}, 'VIDEO', 'STORY', ${now}, null)
    `;
    const snap = (mediaId: string, fetchedAgoMs: number, elapsed: number, metrics: Record<string, number | null>) => sql`
      insert into public.media_insight_snapshots (media_id, fetched_at, elapsed_seconds, metrics)
      values (${mediaId}, ${new Date(now.getTime() - fetchedAgoMs)}, ${elapsed}, ${sql.json(metrics)})
    `;
    // f0 は古いスナップショットも持つ（最新の値が使われることの確認）
    await snap(f0, 2 * HOUR_MS, 60, { reach: 1, views: 1, likes: 0, comments: 0, saved: 0, shares: 0 });
    await snap(f0, 0, 3600, { reach: 100, views: 200, likes: 10, comments: 2, saved: 5, shares: 3, profile_visits: 7 });
    await snap(f1, 0, 3600, { reach: 50, views: 100, likes: 1, comments: 0, saved: 1, shares: 0, profile_visits: 1 });
    await snap(f2, 0, 3600, { reach: 0, views: 0, likes: 0, comments: 0, saved: 0, shares: 0, profile_visits: 0 });
    await snap(reelId, 0, 3600, { reach: 300, views: 600, likes: 30, comments: 0, saved: 0, shares: 0 });
  });

  afterAll(async () => {
    if (accountId !== "") await sql`delete from public.accounts where id = ${accountId}`;
    await closeAllDb();
    await sql.end({ timeout: 5 });
    restoreEnv();
  });

  it("listMedia: 既定は投稿日時の新しい順で 50 件。ストーリーズを除き、最新のスナップショットの値", async () => {
    const page1 = await listMedia(accountId, DEFAULT_PARAMS);
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;
    expect(page1.data).toHaveLength(PAGE_SIZE);
    expect(page1.data.map((m) => m.media_id)).toEqual([reelId, ...feedIds.slice(0, PAGE_SIZE - 1)]);
    expect(page1.data.find((m) => m.media_id === storyId)).toBeUndefined();

    const reel = page1.data[0];
    expect(reel?.kind).toBe("reel");
    const top = page1.data[1];
    expect(top?.kind).toBe("feed");
    expect(top?.posted_at).toBeInstanceOf(Date);
    expect(top?.caption).toBe("架空の題名\n本文");
    expect(top?.reach).toBe(100);
    expect(top?.views).toBe(200);
    expect(top?.profile_visits).toBe(7);
    expect(top?.er).toBeCloseTo(0.2);
    expect(top?.save_rate).toBeCloseTo(0.05);
    expect(top?.share_rate).toBeCloseTo(0.03);
    expect(top?.views_before_change).toBe(false);
    expect(top?.elapsed_hours).toBeGreaterThan(0);
    expect(top?.elapsed_hours).toBeLessThan(1);
    // 分母 0 の率は null（0% にしない）
    const zero = page1.data.find((m) => m.media_id === f2);
    expect(zero?.reach).toBe(0);
    expect(zero?.er).toBeNull();
    expect(zero?.save_rate).toBeNull();
    // スナップショットのない投稿
    const none = page1.data[5];
    expect(none?.reach).toBeNull();
    expect(none?.er).toBeNull();

    const page2 = await listMedia(accountId, { ...DEFAULT_PARAMS, page: 2 });
    expect(page2.ok).toBe(true);
    if (!page2.ok) return;
    expect(page2.data.map((m) => m.media_id)).toEqual(feedIds.slice(PAGE_SIZE - 1));

    const far = await listMedia(accountId, { ...DEFAULT_PARAMS, page: 100_000 });
    expect(far.ok && far.data).toEqual([]);
  });

  it("listMedia: 並べ替えは nulls last。同じ値は投稿日時の新しい順", async () => {
    const desc = await listMedia(accountId, { ...DEFAULT_PARAMS, sort: "reach", order: "desc" });
    expect(desc.ok).toBe(true);
    if (!desc.ok) return;
    expect(desc.data.slice(0, 4).map((m) => m.media_id)).toEqual([reelId, f0, f1, f2]);
    expect(desc.data[4]?.reach).toBeNull();
    expect(desc.data[4]?.media_id).toBe(feedIds[3]);

    const asc = await listMedia(accountId, { ...DEFAULT_PARAMS, sort: "reach", order: "asc" });
    expect(asc.ok).toBe(true);
    if (!asc.ok) return;
    expect(asc.data.slice(0, 4).map((m) => m.media_id)).toEqual([f2, f1, f0, reelId]);
    expect(asc.data[4]?.reach).toBeNull();

    const oldest = await listMedia(accountId, { ...DEFAULT_PARAMS, order: "asc", page: 1 });
    expect(oldest.ok && oldest.data[0]?.media_id).toBe(feedIds[FEED_COUNT - 1]);
  });

  it("listMedia: ER の分母を閲覧数に切り替えると、値と並びが変わる", async () => {
    const r = await listMedia(accountId, { ...DEFAULT_PARAMS, sort: "er", order: "desc", er: "views" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // f0: 20/200 = 0.1、reel: 30/600 = 0.05、f1: 2/100 = 0.02、f2: 分母 0
    expect(r.data.slice(0, 3).map((m) => m.media_id)).toEqual([f0, reelId, f1]);
    expect(r.data[0]?.er).toBeCloseTo(0.1);
    expect(r.data[3]?.er).toBeNull();
  });

  it("countMedia: ストーリーズを除く総件数と最終更新", async () => {
    const r = await countMedia(accountId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.total).toBe(FEED_COUNT + 1);
    expect(r.data.last_fetched_at).toBeInstanceOf(Date);
  });

  it("getMediaBaseline: 全投稿の最新の値の平均と分位（percentile_cont）と、指標ごとの n", async () => {
    const r = await getMediaBaseline(accountId, "reach");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // リーチ: 0, 50, 100, 300
    expect(r.data.reach.n).toBe(4);
    expect(r.data.reach.mean).toBeCloseTo(112.5);
    expect(r.data.reach.median).toBeCloseTo(75);
    expect(r.data.reach.q25).toBeCloseTo(37.5);
    expect(r.data.reach.q75).toBeCloseTo(150);
    // ER（分母リーチ）: f0 0.2、f1 0.04、reel 0.1（f2 は分母 0 で数えない）
    expect(r.data.er.n).toBe(3);
    expect(r.data.er.median).toBeCloseTo(0.1);
    // プロフ訪問はリールにない: f0 7、f1 1、f2 0
    expect(r.data.profile_visits.n).toBe(3);

    const byViews = await getMediaBaseline(accountId, "views");
    expect(byViews.ok && byViews.data.er.median).toBeCloseTo(0.05);
  });

  it("getMediaPage: 一覧、総ページ数、基準値、サムネイル（パスがなければ null）", async () => {
    const r = await getMediaPage(accountId, DEFAULT_PARAMS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.page).toBe(1);
    expect(r.data.total).toBe(FEED_COUNT + 1);
    expect(r.data.pageCount).toBe(2);
    expect(r.data.items).toHaveLength(PAGE_SIZE);
    expect(r.data.items.every((m) => m.thumbnail_url === null)).toBe(true);
    expect(r.data.baseline.reach.n).toBe(4);
  });

  it("listMediaCsvRows: 全件（ページで切らない）を一覧と同じ並びで、CSV の列の形で返す", async () => {
    const r = await listMediaCsvRows(accountId, { sort: "reach", order: "desc" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toHaveLength(FEED_COUNT + 1);
    expect(r.data.slice(0, 4).map((m) => m.media_id)).toEqual([reelId, f0, f1, f2]);
    const row = r.data[1];
    expect(Object.keys(row ?? {}).sort()).toEqual(MEDIA_CSV_COLUMNS.map((c) => c.header).sort());
    expect(row?.kind).toBe("feed");
    expect(row?.posted_at_jst).toBeInstanceOf(Date);
    expect(row?.latest_fetched_at_jst).toBeInstanceOf(Date);
    expect(row?.elapsed_latest_hours).toBe(1);
    expect(row?.reach).toBe(100);
    expect(row?.er).toBeCloseTo(0.2);
    expect(row?.reach_7d).toBeNull();
    expect(row?.reach_rate).toBeNull();
  });
});
