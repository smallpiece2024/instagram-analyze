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
 *   s1 ストーリーズ（詳細に出さない）
 * A のフォロワー数: 2026-07-31 12:00 UTC に 1000（投稿前 3 日以内）→ f2 のリーチ率は 150 ÷ 1000
 * B の投稿: b1 フィード reach 5000
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mediaTitle, topPercent } from "@/app/media/[id]/_detail/text";
import { closeAllDb } from "@/lib/db";
import { getMedia, getMediaHorizons, getPeerHorizonStats, getPeerStats } from "@/lib/queries/media-detail";
import { fakeIgUserId, fakeMediaId, setWebEnv } from "./fixtures";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe("投稿詳細の文字の組み立て", () => {
  it("mediaTitle: 1 行目の先頭 40 文字。空なら（キャプションなし）", () => {
    expect(mediaTitle("一行目\n二行目")).toBe("一行目");
    expect(mediaTitle(null)).toBe("（キャプションなし）");
    expect(mediaTitle("  \n二行目")).toBe("（キャプションなし）");
    // サロゲートペアを割らない
    const long = "😀".repeat(45);
    expect(Array.from(mediaTitle(long))).toHaveLength(40);
    expect(mediaTitle(long)).toBe("😀".repeat(40));
  });

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
  };
  const P = "2026-08-01T00:00:00Z";
  const H = 3600;
  const D = 86400;
  let sql: postgres.Sql;
  let accountA = "";
  let accountB = "";
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
  });

  afterAll(async () => {
    for (const id of [accountA, accountB]) {
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

  it("getPeerStats: 比較相手がいない種類は n = 0、この投稿のリーチがなければ順位の材料は null", async () => {
    const reel = await getPeerStats(accountA, "reel", ids.f1);
    expect(reel.ok && reel.data.stats.reach.n).toBe(0);
    const noReach = await getPeerStats(accountA, "feed", ids.f4);
    expect(noReach.ok && noReach.data.reachGreater).toBeNull();
    expect(noReach.ok && noReach.data.stats.reach.n).toBe(3);
  });
});
