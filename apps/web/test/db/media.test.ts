/**
 * `queries/media.ts` の結合テスト（R1 設計 4.3 章。R3 段階 0 で `queries.test.ts` から分けた）。
 * `TEST_DATABASE_URL` があるときだけ動く。架空のアカウント 1 件、投稿 52 件（うち 1 件はストーリーズ）、
 * スナップショットを作り、`afterAll` でアカウントを消す（カスケードで関連行も消える）。
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllDb } from "@/lib/db";
import { PAGE_SIZE } from "@/lib/format";
import { getMediaPage, listMedia } from "@/lib/queries/media";
import { fakeIgUserId, fakeMediaId, MINUTE_MS, setWebEnv } from "./fixtures";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
/** ページング確認用の投稿数（1 ページ分 + 1） */
const FEED_COUNT = PAGE_SIZE + 1;

describe.skipIf(!TEST_DATABASE_URL)("queries/media（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  const igUserId = fakeIgUserId();
  const now = new Date();
  /** 投稿日時の新しい順に並ぶよう、seq が小さいほど新しい（seq 0 が最新。実アカウントの投稿より新しい） */
  const feedIds = Array.from({ length: FEED_COUNT }, (_, seq) => fakeMediaId(seq));
  const storyId = fakeMediaId(900);
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
      posted_at: new Date(now.getTime() - seq * MINUTE_MS),
      permalink: "https://www.instagram.com/p/fake/",
    }));
    await sql`insert into public.media ${sql(feedRows, "id", "account_id", "media_type", "media_product_type", "posted_at", "permalink")}`;
    await sql`
      insert into public.media (id, account_id, media_type, media_product_type, posted_at, permalink)
      values (${storyId}, ${accountId}, 'VIDEO', 'STORY', ${new Date(now.getTime() + MINUTE_MS)}, null)
    `;
    await sql`
      insert into public.media_insight_snapshots (media_id, fetched_at, elapsed_seconds, metrics)
      values (${feedIds[0] ?? ""}, now(), 3600, ${sql.json({ views: 10, reach: null })})
    `;
  });

  afterAll(async () => {
    if (accountId !== "") await sql`delete from public.accounts where id = ${accountId}`;
    await closeAllDb();
    await sql.end({ timeout: 5 });
    restoreEnv();
  });

  it("listMedia と getMediaPage: ストーリーズを除き、最新のスナップショットを付け、51 件で次ページがある", async () => {
    const page1 = await listMedia(1);
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;
    expect(page1.data.page).toBe(1);
    expect(page1.data.items).toHaveLength(PAGE_SIZE);
    expect(page1.data.hasNext).toBe(true);
    // 架空の投稿は実アカウントの投稿より新しいので、1 ページ目の先頭 50 件がそのまま並ぶ
    expect(page1.data.items.map((m) => m.id)).toEqual(feedIds.slice(0, PAGE_SIZE));
    expect(page1.data.items.find((m) => m.id === storyId)).toBeUndefined();
    expect(page1.data.items.every((m) => m.media_product_type !== "STORY")).toBe(true);

    const newest = page1.data.items[0];
    expect(newest?.id).toBe(feedIds[0]);
    expect(newest?.media_product_type).toBe("FEED");
    expect(newest?.posted_at).toBeInstanceOf(Date);
    expect(newest?.metrics_fetched_at).toBeInstanceOf(Date);
    expect(newest?.elapsed_seconds).toBe(3600);
    expect(newest?.metrics).toEqual({ views: 10, reach: null });
    expect(newest?.thumbnail_path).toBeNull();
    expect(newest?.gone_at).toBeNull();
    expect(newest !== undefined && "caption" in newest).toBe(false);
    // スナップショットのない投稿
    const second = page1.data.items[1];
    expect(second?.metrics).toBeNull();
    expect(second?.metrics_fetched_at).toBeNull();
    expect(second?.elapsed_seconds).toBeNull();

    const page2 = await listMedia(2);
    expect(page2.ok).toBe(true);
    if (!page2.ok) return;
    expect(page2.data.page).toBe(2);
    expect(page2.data.items[0]?.id).toBe(feedIds[PAGE_SIZE]);
    expect(page2.data.items.find((m) => m.id === storyId)).toBeUndefined();

    const withThumbs = await getMediaPage(1);
    expect(withThumbs.ok).toBe(true);
    if (!withThumbs.ok) return;
    expect(withThumbs.data.hasNext).toBe(true);
    expect(withThumbs.data.items.find((m) => m.id === feedIds[0])?.thumbnail_url).toBeNull();

    const far = await listMedia(100_000);
    expect(far.ok).toBe(true);
    if (!far.ok) return;
    expect(far.data.items).toEqual([]);
    expect(far.data.hasNext).toBe(false);
  });
});
