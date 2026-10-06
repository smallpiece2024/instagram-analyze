/**
 * `queries/reels.ts` と `queries/media-detail.ts` の動画の特徴量の結合テスト（R4 設計 6.1 節、6.2 節）。
 * `TEST_DATABASE_URL` があるときだけ動く。架空のアカウントに架空の投稿と解析結果を作り、`afterAll` でアカウントを消す
 * （カスケードで関連行も消える）。手元の DB の本物の行は変えない。
 *
 *   r1 リール（10 日前）: 今の条件の success（長さ 12 秒、画面変化 3000 / 7000 ms）と、古い条件（0.5）の success
 *   r2 リール（5 日前）: 今の条件の failed（error 列に文字あり。画面には出さない）
 *   r3 リール（400 日前）: 期間外
 *   f1 フィード動画: 今の条件の success（リール分析には出ない）
 *   i1 フィードの画像: 動画でないのでビューに行がない
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllDb } from "@/lib/db";
import { getPeerStats, getVideoFeatures } from "@/lib/queries/media-detail";
import { getReels } from "@/lib/queries/reels";
import { buildReelsView } from "@/lib/reels";
import { fakeIgUserId, fakeMediaId, setWebEnv } from "./fixtures";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("queries/reels と動画の特徴量（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  const igUserId = fakeIgUserId();
  const ids = { r1: fakeMediaId(1), r2: fakeMediaId(2), r3: fakeMediaId(3), f1: fakeMediaId(4), i1: fakeMediaId(5) };
  let sql: postgres.Sql;
  let accountId = "";
  let restoreEnv: () => void = () => {};

  beforeAll(async () => {
    restoreEnv = setWebEnv(url);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    const [acc] = await sql<{ id: string }[]>`
      insert into public.accounts (ig_user_id, username, name) values (${igUserId}, 'fake_reels', null) returning id
    `;
    accountId = acc?.id ?? "";
    expect(accountId).not.toBe("");

    const media = [
      { id: ids.r1, type: "VIDEO", product: "REELS", days: 10, caption: "架空のリール 1" },
      { id: ids.r2, type: "VIDEO", product: "REELS", days: 5, caption: null },
      { id: ids.r3, type: "VIDEO", product: "REELS", days: 400, caption: null },
      { id: ids.f1, type: "VIDEO", product: "FEED", days: 3, caption: null },
      { id: ids.i1, type: "IMAGE", product: "FEED", days: 3, caption: null },
    ];
    for (const m of media) {
      await sql`
        insert into public.media (id, account_id, media_type, media_product_type, posted_at, caption)
        values (${m.id}, ${accountId}, ${m.type}, ${m.product}, now() - make_interval(days => ${m.days}), ${m.caption})
      `;
      await sql`
        insert into public.media_insight_snapshots (media_id, fetched_at, elapsed_seconds, metrics)
        values (${m.id}, now(), ${m.days * 86400}, ${sql.json({ reach: 100 + m.days, views: 300, ig_reels_avg_watch_time: 6000 })})
      `;
    }

    const [a1] = await sql<{ id: string }[]>`
      insert into public.video_analyses
        (media_id, analyzer_version, scene_threshold, status, duration_ms, cut_count, avg_scene_ms, first_cut_ms, cuts_in_first_3s)
      values (${ids.r1}, '1', 0.300, 'success', 12000, 2, 4000, 3000, 1)
      returning id::text as id
    `;
    await sql`insert into public.video_cuts (analysis_id, seq, at_ms) values (${a1?.id ?? ""}::bigint, 1, 3000), (${a1?.id ?? ""}::bigint, 2, 7000)`;
    await sql`
      insert into public.video_analyses
        (media_id, analyzer_version, scene_threshold, status, duration_ms, cut_count, avg_scene_ms, first_cut_ms, cuts_in_first_3s)
      values (${ids.r1}, '1', 0.500, 'success', 99000, 9, 9000, 900, 3)
    `;
    await sql`
      insert into public.video_analyses (media_id, analyzer_version, scene_threshold, status, error)
      values (${ids.r2}, '1', 0.300, 'failed', 'fake error text')
    `;
    await sql`
      insert into public.video_analyses
        (media_id, analyzer_version, scene_threshold, status, duration_ms, cut_count, avg_scene_ms, first_cut_ms, cuts_in_first_3s)
      values (${ids.f1}, '1', 0.300, 'success', 20000, 0, 20000, null, 0)
    `;
  });

  afterAll(async () => {
    if (accountId !== "") await sql`delete from public.accounts where id = ${accountId}`;
    await closeAllDb();
    await sql.end({ timeout: 5 });
    restoreEnv();
  });

  it("getReels: 期間内のリールだけ、今の条件の特徴量、新しい順", async () => {
    const r = await getReels(accountId);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.reason);
    expect(r.data.rows.map((x) => x.media_id)).toEqual([ids.r2, ids.r1]);
    const r1 = r.data.rows.find((x) => x.media_id === ids.r1);
    expect(r1?.analysis_status).toBe("success");
    expect(r1?.duration_ms).toBe(12000);
    expect(r1?.cut_count).toBe(2);
    expect(r1?.retention_rate).toBeCloseTo(0.5, 10);
    expect(r1?.views).toBe(300);
    expect(r1?.caption_chars).toBe("架空のリール 1".length);
    expect(typeof r1?.elapsed_hours).toBe("number");
    const r2 = r.data.rows.find((x) => x.media_id === ids.r2);
    expect(r2?.analysis_status).toBe("failed");
    expect(r2?.duration_ms).toBeNull();
    expect(r2?.retention_rate).toBeNull();
    // error 列は読まない
    expect(JSON.stringify(r.data.rows)).not.toContain("fake error text");
    expect(r.data.last_fetched_at).toBeInstanceOf(Date);

    const view = buildReelsView(r.data.rows, "views");
    expect(view.total).toBe(2);
    expect(view.analyzedCount).toBe(1);
    expect(view.objectiveCounts.reach_rate).toBe(0);
  });

  it("getVideoFeatures: 画面変化の時刻（seq の順）、failed は時刻なし、動画でなければ null", async () => {
    const r1 = await getVideoFeatures(accountId, ids.r1);
    expect(r1.ok && r1.data).toMatchObject({
      analysis_status: "success",
      duration_ms: 12000,
      cut_count: 2,
      avg_scene_ms: 4000,
      first_cut_ms: 3000,
      cuts_in_first_3s: 1,
      cut_times_ms: [3000, 7000],
    });
    const r2 = await getVideoFeatures(accountId, ids.r2);
    expect(r2.ok && r2.data).toMatchObject({ analysis_status: "failed", cut_times_ms: [], duration_ms: null });
    expect(JSON.stringify(r2)).not.toContain("fake error text");
    const f1 = await getVideoFeatures(accountId, ids.f1);
    expect(f1.ok && f1.data?.cut_times_ms).toEqual([]);
    expect(f1.ok && f1.data?.first_cut_ms).toBeNull();
    const i1 = await getVideoFeatures(accountId, ids.i1);
    expect(i1.ok && i1.data).toBeNull();
    // ほかのアカウントの ID では読めない
    const other = await getVideoFeatures("00000000-0000-0000-0000-000000000000", ids.r1);
    expect(other.ok && other.data).toBeNull();
  });

  it("getPeerStats: 視聴維持率は同じ種類で値のある投稿と比べる", async () => {
    const peers = await getPeerStats(accountId, "reel", ids.r2);
    expect(peers.ok).toBe(true);
    if (!peers.ok) throw new Error(peers.reason);
    // r1（0.5）と r3（期間は問わない。解析なしで null）→ 値のある相手は 1 件
    expect(peers.data.stats.retention_rate.n).toBe(1);
    expect(peers.data.stats.retention_rate.median).toBeCloseTo(0.5, 10);
    const self = await getPeerStats(accountId, "reel", ids.r1);
    expect(self.ok && self.data.stats.retention_rate.n).toBe(0);
  });
});
