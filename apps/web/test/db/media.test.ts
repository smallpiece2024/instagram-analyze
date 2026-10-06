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
  getMediaPage,
  listMedia,
  listMediaCsvRows,
  type MediaListParams,
} from "@/lib/queries/media";
import { fakeIgUserId, fakeMediaId, HOUR_MS, MINUTE_MS, setWebEnv } from "./fixtures";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
/** フィードの件数（1 ページ分 + 1） */
const FEED_COUNT = PAGE_SIZE + 1;
const DEFAULT_PARAMS: MediaListParams = { sort: "posted", order: "desc", page: 1 };

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

  it("listMedia: ER は分母がリーチ。ER の順に並び、分母 0 は null", async () => {
    const r = await listMedia(accountId, { ...DEFAULT_PARAMS, sort: "er", order: "desc" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // f0: 0.2、reel: 0.1、f1: 0.04、f2: 分母 0
    expect(r.data.slice(0, 3).map((m) => m.media_id)).toEqual([f0, reelId, f1]);
    expect(r.data[0]?.er).toBeCloseTo(0.2);
    expect(r.data[3]?.er).toBeNull();
  });

  it("countMedia: ストーリーズを除く総件数と最終更新", async () => {
    const r = await countMedia(accountId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.total).toBe(FEED_COUNT + 1);
    expect(r.data.last_fetched_at).toBeInstanceOf(Date);
  });

  it("getMediaPage: 一覧、総ページ数、サムネイル（パスがなければ null）", async () => {
    const r = await getMediaPage(accountId, DEFAULT_PARAMS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.page).toBe(1);
    expect(r.data.total).toBe(FEED_COUNT + 1);
    expect(r.data.pageCount).toBe(2);
    expect(r.data.items).toHaveLength(PAGE_SIZE);
    expect(r.data.items.every((m) => m.thumbnail_url === null)).toBe(true);
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

/**
 * 2 アカウントの分離、削除済み（`gone_at`）の投稿、基準値の材料（R3 設計 9.2 節の `test/db/media.test.ts` の行）。
 * 上の describe の件数を変えないように、架空のアカウント A と B を別に作り、`afterAll` で消す。
 *   g1 フィード 10 日前の投稿。7 日 + 1 時間でリーチ 150、10 日（最新）で 200（基準値は 200 だけを使う）
 *   g2 フィード 20 日前の投稿。gone_at あり、20 日でリーチ 100
 *   g3 フィード 2 時間前の投稿。1 時間でリーチ 10（経過の短い投稿も基準値に入る）
 *   g4 フィード 300 日前の投稿。最初のスナップショットが 200 日後でリーチ 400（7d は許容外でも基準値に入る）
 *   b1（アカウント B）フィード 1 日前の投稿。リーチ 5000（A の一覧と基準値に入らない）
 */
describe.skipIf(!TEST_DATABASE_URL)("queries/media（結合）: 2 アカウントの分離と削除済みの投稿", () => {
  const url = TEST_DATABASE_URL ?? "";
  const igUserIdA = fakeIgUserId();
  const igUserIdB = fakeIgUserId();
  const now = new Date();
  // 上の describe と ID が重ならないよう 600 番台を使う
  const ids = { g1: fakeMediaId(601), g2: fakeMediaId(602), g3: fakeMediaId(603), g4: fakeMediaId(604), b1: fakeMediaId(605) };
  const DAY = 24 * HOUR_MS;
  let sql: postgres.Sql;
  let accountA = "";
  let accountB = "";
  let restoreEnv: () => void = () => {};

  beforeAll(async () => {
    restoreEnv = setWebEnv(url);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    const accounts = await sql<{ id: string; ig_user_id: string }[]>`
      insert into public.accounts (ig_user_id, username, name)
      values (${igUserIdA}, 'fake_media_iso_a', null), (${igUserIdB}, 'fake_media_iso_b', null)
      returning id, ig_user_id
    `;
    accountA = accounts.find((r) => r.ig_user_id === igUserIdA)?.id ?? "";
    accountB = accounts.find((r) => r.ig_user_id === igUserIdB)?.id ?? "";
    expect(accountA).not.toBe("");
    expect(accountB).not.toBe("");

    const posted = {
      g1: new Date(now.getTime() - 10 * DAY),
      g2: new Date(now.getTime() - 20 * DAY),
      g3: new Date(now.getTime() - 2 * HOUR_MS),
      g4: new Date(now.getTime() - 300 * DAY),
      b1: new Date(now.getTime() - DAY),
    };
    await sql`
      insert into public.media (id, account_id, media_type, media_product_type, posted_at, gone_at)
      values
        (${ids.g1}, ${accountA}, 'IMAGE', 'FEED', ${posted.g1}, null),
        (${ids.g2}, ${accountA}, 'IMAGE', 'FEED', ${posted.g2}, ${new Date(now.getTime() - HOUR_MS)}),
        (${ids.g3}, ${accountA}, 'IMAGE', 'FEED', ${posted.g3}, null),
        (${ids.g4}, ${accountA}, 'IMAGE', 'FEED', ${posted.g4}, null),
        (${ids.b1}, ${accountB}, 'IMAGE', 'FEED', ${posted.b1}, null)
    `;
    const snap = (mediaId: string, postedAt: Date, elapsedSec: number, reach: number) => sql`
      insert into public.media_insight_snapshots (media_id, fetched_at, elapsed_seconds, metrics)
      values (
        ${mediaId}, ${new Date(postedAt.getTime() + elapsedSec * 1000)}, ${elapsedSec},
        ${sql.json({ reach, views: reach * 2, likes: 1, comments: 0, saved: 1, shares: 0, profile_visits: 0 })}
      )
    `;
    const H = 3600;
    const D = 86400;
    await snap(ids.g1, posted.g1, 7 * D + H, 150);
    await snap(ids.g1, posted.g1, 10 * D, 200);
    await snap(ids.g2, posted.g2, 20 * D, 100);
    await snap(ids.g3, posted.g3, H, 10);
    await snap(ids.g4, posted.g4, 200 * D, 400);
    await snap(ids.b1, posted.b1, D, 5000);
  });

  afterAll(async () => {
    for (const id of [accountA, accountB]) {
      if (id !== "") await sql`delete from public.accounts where id = ${id}`;
    }
    await closeAllDb();
    await sql.end({ timeout: 5 });
    restoreEnv();
  });

  it("listMedia と countMedia: 削除済みの投稿を含み、ほかのアカウントの投稿を含まない", async () => {
    const a = await listMedia(accountA, DEFAULT_PARAMS);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.data.map((m) => m.media_id)).toEqual([ids.g3, ids.g1, ids.g2, ids.g4]);
    const gone = a.data.find((m) => m.media_id === ids.g2);
    expect(gone?.gone_at).toBeInstanceOf(Date);
    expect(gone?.reach).toBe(100);
    expect(a.data.find((m) => m.media_id === ids.g1)?.gone_at).toBeNull();
    // 最新のスナップショットの値（7 日 + 1 時間の 150 ではなく 10 日の 200）
    expect(a.data.find((m) => m.media_id === ids.g1)?.reach).toBe(200);

    const b = await listMedia(accountB, DEFAULT_PARAMS);
    expect(b.ok && b.data.map((m) => m.media_id)).toEqual([ids.b1]);

    const countA = await countMedia(accountA);
    expect(countA.ok && countA.data.total).toBe(4);
    const countB = await countMedia(accountB);
    expect(countB.ok && countB.data.total).toBe(1);
  });

  it("listMedia: リーチの並べ替えにほかのアカウントの値（5000）が入らない", async () => {
    const r = await listMedia(accountA, { ...DEFAULT_PARAMS, sort: "reach", order: "desc" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.map((m) => m.media_id)).toEqual([ids.g4, ids.g1, ids.g2, ids.g3]);
  });

  it("getMediaPage と listMediaCsvRows: 削除済みを含み、ほかのアカウントを含まない", async () => {
    const page = await getMediaPage(accountA, DEFAULT_PARAMS);
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.data.total).toBe(4);
    expect(page.data.items.map((m) => m.media_id)).not.toContain(ids.b1);

    const csv = await listMediaCsvRows(accountA, { sort: "posted", order: "desc" });
    expect(csv.ok).toBe(true);
    if (!csv.ok) return;
    expect(csv.data.map((m) => m.media_id)).toEqual([ids.g3, ids.g1, ids.g2, ids.g4]);
    expect(csv.data.find((m) => m.media_id === ids.g2)?.gone_at_jst).toBeInstanceOf(Date);
  });
});
