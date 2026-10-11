/**
 * 動画の画面の文字（R4.1 設計 5.4 節、6 章、8 章「画面」）の結合テスト。
 * `TEST_DATABASE_URL` があるときだけ動く。段階 1 のマイグレーション（`video_text_analyses`、`video_text_segments`、
 * `ocr_usage`、`ocr_monthly_usage`、`media_video_features` の文字の列）が手元の DB に入っていなければ落ちる。
 * 架空のアカウントに架空の投稿と解析結果を作り、`afterAll` でアカウントを消す（カスケードで関連行も消える）。
 *
 *   r1 リール（10 日前）: カット success、文字 success（今の版。区間 3 本。「１００％」を含む）
 *   r2 リール（5 日前）: カット success、文字 success だが segmenter_version が古い（計算し直し待ち）
 *   r3 リール（3 日前）: カット success、文字 failed（error 列に文字あり。画面には出さない）
 *   f1 フィード動画（2 日前）: カット success、文字 success（検索には出る。リール分析には出ない）
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllDb } from "@/lib/db";
import { getVideoFeatures } from "@/lib/queries/media-detail";
import { getOcrMonthlyUsage } from "@/lib/queries/ocr-usage";
import { getReels, searchTextSegments } from "@/lib/queries/reels";
import { likePattern, parseSearchText } from "@/lib/text-search";
import { fakeIgUserId, fakeMediaId, setWebEnv } from "./fixtures";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("動画の画面の文字（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  const igUserId = fakeIgUserId();
  const ids = { r1: fakeMediaId(1), r2: fakeMediaId(2), r3: fakeMediaId(3), f1: fakeMediaId(4) };
  let sql: postgres.Sql;
  let accountId = "";
  let restoreEnv: () => void = () => {};

  beforeAll(async () => {
    restoreEnv = setWebEnv(url);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    const [acc] = await sql<{ id: string }[]>`
      insert into public.accounts (ig_user_id, username, name) values (${igUserId}, 'fake_video_text', null) returning id
    `;
    accountId = acc?.id ?? "";
    expect(accountId).not.toBe("");

    const media = [
      { id: ids.r1, product: "REELS", days: 10, caption: "架空のリール 1" },
      { id: ids.r2, product: "REELS", days: 5, caption: "架空のリール 2" },
      { id: ids.r3, product: "REELS", days: 3, caption: null },
      { id: ids.f1, product: "FEED", days: 2, caption: "架空のフィード動画" },
    ];
    for (const m of media) {
      await sql`
        insert into public.media (id, account_id, media_type, media_product_type, posted_at, caption)
        values (${m.id}, ${accountId}, 'VIDEO', ${m.product}, now() - make_interval(days => ${m.days}), ${m.caption})
      `;
      await sql`
        insert into public.media_insight_snapshots (media_id, fetched_at, elapsed_seconds, metrics)
        values (${m.id}, now(), ${m.days * 86400}, ${sql.json({ reach: 100 + m.days, views: 300, ig_reels_avg_watch_time: 6000 })})
      `;
      // カットは今の条件で success（`media_video_features` に行を出すため）
      await sql`
        insert into public.video_analyses
          (media_id, analyzer_version, scene_threshold, status, duration_ms, cut_count, avg_scene_ms, first_cut_ms, cuts_in_first_3s, cuts_in_last_3s)
        values (${m.id}, '1', 0.300, 'success', 12000, 1, 6000, 6000, 0, 0)
      `;
    }

    // 今の OCR の条件（ビューの結合に使う 4 列と、区間化の版）
    const [cond] = await sql<
      { ocr_method: string; ocr_version: string; frame_interval_ms: number; analyzer_version: string; segmenter_version: string }[]
    >`select * from public.current_video_text_condition()`;
    if (cond === undefined) throw new Error("current_video_text_condition");

    const insertText = async (mediaId: string, segmenterVersion: string, status: string, error: string | null) => {
      const [row] = await sql<{ id: string }[]>`
        insert into public.video_text_analyses
          (media_id, ocr_method, ocr_version, frame_interval_ms, analyzer_version, segmenter_version, status, error,
           duration_ms, first_text_ms, has_text_in_first_3s, text_coverage_ratio, total_text_chars, segment_count,
           caption_first_text_ms, caption_has_text_in_first_3s, caption_coverage_ratio, caption_total_chars)
        values
          (${mediaId}, ${cond.ocr_method}, ${cond.ocr_version}, ${cond.frame_interval_ms}, ${cond.analyzer_version},
           ${segmenterVersion}, ${status}, ${error},
           ${status === "success" ? 12000 : null}, ${status === "success" ? 1000 : null}, ${status === "success" ? true : null},
           ${status === "success" ? 0.5 : null}, ${status === "success" ? 12 : null}, ${status === "success" ? 3 : null},
           ${status === "success" ? 1000 : null}, ${status === "success" ? true : null}, ${status === "success" ? 0.25 : null},
           ${status === "success" ? 4 : null})
        returning id::text as id
      `;
      return row?.id ?? "";
    };
    const insertSegments = async (analysisId: string) => {
      const rows = [
        { seq: 1, text: "駅から徒歩4分", norm: "駅から徒歩4分", start: 1000, end: 4000, pos: "top", caption: true, conf: 0.98 },
        { seq: 2, text: "１００％ 天然", norm: "100%天然", start: 3000, end: 6000, pos: "bottom", caption: false, conf: 0.6 },
        { seq: 3, text: "<b>tag</b>", norm: "<b>tag</b>", start: 8000, end: 13000, pos: "middle", caption: false, conf: null },
      ];
      for (const r of rows) {
        await sql`
          insert into public.video_text_segments
            (analysis_id, seq, text, text_norm, start_ms, end_ms, vertical_position, confidence, frame_count, is_caption_like)
          values (${analysisId}::bigint, ${r.seq}, ${r.text}, ${r.norm}, ${r.start}, ${r.end}, ${r.pos}, ${r.conf}, 2, ${r.caption})
        `;
      }
    };

    const a1 = await insertText(ids.r1, cond.segmenter_version, "success", null);
    await insertSegments(a1);
    const a2 = await insertText(ids.r2, `${cond.segmenter_version}-old`, "success", null);
    await insertSegments(a2);
    await insertText(ids.r3, cond.segmenter_version, "failed", "fake text error");
    const a4 = await insertText(ids.f1, cond.segmenter_version, "success", null);
    await insertSegments(a4);

    // 利用の記録: 今月（UTC）に 2 要求（1 つ失敗）、先月に 1 要求
    const thisMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1, 0, 0, 0));
    const lastMonth = new Date(Date.UTC(thisMonth.getUTCFullYear(), thisMonth.getUTCMonth() - 1, 15));
    const usage = [
      { media: ids.r1, analysis: a1, at: thisMonth, images: 8, units: 8, ok: true, status: 200 },
      { media: ids.r1, analysis: a1, at: new Date(thisMonth.getTime() + 60_000), images: 4, units: 4, ok: false, status: 500 },
      { media: ids.f1, analysis: a4, at: lastMonth, images: 10, units: 10, ok: true, status: 200 },
    ];
    for (const u of usage) {
      await sql`
        insert into public.ocr_usage
          (account_id, media_id, analysis_id, ocr_method, ocr_version, requested_at, image_count, units, http_status, ok)
        values (${accountId}, ${u.media}, ${u.analysis}::bigint, ${cond.ocr_method}, ${cond.ocr_version}, ${u.at}, ${u.images}, ${u.units}, ${u.status}, ${u.ok})
      `;
    }
  });

  afterAll(async () => {
    if (accountId !== "") await sql`delete from public.accounts where id = ${accountId}`;
    await closeAllDb();
    await sql.end({ timeout: 5 });
    restoreEnv();
  });

  it("getVideoFeatures: 文字の列と区間（seq の順）。古い版は text_segmenter_current 偽で特徴量と区間なし。failed は error を読まない", async () => {
    const r1 = await getVideoFeatures(accountId, ids.r1);
    expect(r1.ok && r1.data).toMatchObject({
      analysis_status: "success",
      text_status: "success",
      text_segmenter_current: true,
      first_text_ms: 1000,
      has_text_in_first_3s: true,
      text_coverage_ratio: 0.5,
      total_text_chars: 12,
      segment_count: 3,
      caption_segment_count: 1,
      caption_total_chars: 4,
    });
    if (!r1.ok || r1.data === null) throw new Error("r1");
    expect(r1.data.text_segments.map((s) => s.seq)).toEqual([1, 2, 3]);
    expect(r1.data.text_segments[0]).toEqual({
      seq: 1,
      start_ms: 1000,
      end_ms: 4000,
      text: "駅から徒歩4分",
      position: "top",
      is_caption_like: true,
      confidence: 0.98,
    });
    expect(r1.data.text_segments[2]?.confidence).toBeNull();

    const r2 = await getVideoFeatures(accountId, ids.r2);
    expect(r2.ok && r2.data).toMatchObject({
      text_status: "success",
      text_segmenter_current: false,
      first_text_ms: null,
      has_text_in_first_3s: null,
      text_coverage_ratio: null,
      total_text_chars: null,
      caption_segment_count: 0,
      text_segments: [],
    });

    const r3 = await getVideoFeatures(accountId, ids.r3);
    expect(r3.ok && r3.data).toMatchObject({ text_status: "failed", text_segmenter_current: true, first_text_ms: null, text_segments: [] });
    expect(JSON.stringify(r3)).not.toContain("fake text error");
  });

  it("getReels: 文字の列が載る（r1 は値、r2 は古い版で null、r3 は failed で null）", async () => {
    const r = await getReels(accountId);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.reason);
    const r1 = r.data.rows.find((x) => x.media_id === ids.r1);
    expect(r1).toMatchObject({ text_status: "success", text_segmenter_current: true, first_text_ms: 1000, has_text_in_first_3s: true, text_coverage_ratio: 0.5, total_text_chars: 12 });
    const r2 = r.data.rows.find((x) => x.media_id === ids.r2);
    expect(r2).toMatchObject({ text_status: "success", text_segmenter_current: false, first_text_ms: null, has_text_in_first_3s: null });
    const r3 = r.data.rows.find((x) => x.media_id === ids.r3);
    expect(r3).toMatchObject({ text_status: "failed", first_text_ms: null, total_text_chars: null });
    expect(JSON.stringify(r.data.rows)).not.toContain("fake text error");
    // フィード動画はリール分析に出ない
    expect(r.data.rows.some((x) => x.media_id === ids.f1)).toBe(false);
  });

  it("searchTextSegments: 今の版の success だけ、新しい順、区間は start_ms の昇順で 3 つまで、全角の ％ はエスケープして文字として引く", async () => {
    const hit = await searchTextSegments(accountId, likePattern(parseSearchText("徒歩") as string));
    expect(hit.ok).toBe(true);
    if (!hit.ok) throw new Error(hit.reason);
    // f1（2 日前）→ r1（10 日前）。r2（古い版）は出ない
    expect(hit.data.hits.map((h) => h.media_id)).toEqual([ids.f1, ids.r1]);
    expect(hit.data.total).toBe(2);
    expect(hit.data.hits[1]).toMatchObject({ kind: "reel", caption: "架空のリール 1", match_count: 1 });
    expect(hit.data.hits[0]?.kind).toBe("feed");
    expect(hit.data.hits[1]?.segments).toEqual([{ seq: 1, start_ms: 1000, text: "駅から徒歩4分" }]);

    // ％ は NFKC で % になり、エスケープされるので「100%」の文字だけに一致する（ワイルドカードにならない）
    const pct = await searchTextSegments(accountId, likePattern(parseSearchText("１００％") as string));
    expect(pct.ok && pct.data.hits.map((h) => h.media_id)).toEqual([ids.f1, ids.r1]);
    expect(pct.ok && pct.data.hits[0]?.segments).toEqual([{ seq: 2, start_ms: 3000, text: "１００％ 天然" }]);
    const pctOnly = await searchTextSegments(accountId, likePattern(parseSearchText("％天") as string));
    expect(pctOnly.ok && pctOnly.data.total).toBe(2);
    // エスケープしなければ何にでも一致する「%」も、エスケープすると「%」の文字だけに一致する
    const wild = await searchTextSegments(accountId, likePattern("%"));
    expect(wild.ok && wild.data.hits.every((h) => h.segments.every((s) => s.text.includes("％")))).toBe(true);
    // 大文字小文字を区別しない。並びは start_ms の昇順
    const all = await searchTextSegments(accountId, likePattern("TAG"));
    expect(all.ok && all.data.hits[0]?.segments.map((s) => s.seq)).toEqual([3]);

    // 0 件
    const none = await searchTextSegments(accountId, likePattern("存在しない文字列"));
    expect(none.ok && none.data).toEqual({ hits: [], total: 0 });
    // ほかのアカウントでは引けない
    const other = await searchTextSegments("00000000-0000-0000-0000-000000000000", likePattern("徒歩"));
    expect(other.ok && other.data.total).toBe(0);
  });

  it("getOcrMonthlyUsage: 月（UTC）ごとの要求、失敗、画像、ユニット、本数。新しい順", async () => {
    const r = await getOcrMonthlyUsage(accountId);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.reason);
    expect(r.data).toHaveLength(2);
    expect(r.data[0]).toMatchObject({ requests: 2, failed_requests: 1, images: 12, units: 12, videos: 1 });
    expect(r.data[0]?.month).toMatch(/^\d{4}-\d{2}$/);
    expect(r.data[1]).toMatchObject({ requests: 1, failed_requests: 0, images: 10, units: 10, videos: 1 });
    expect((r.data[0]?.month ?? "") > (r.data[1]?.month ?? "")).toBe(true);
    const other = await getOcrMonthlyUsage("00000000-0000-0000-0000-000000000000");
    expect(other.ok && other.data).toEqual([]);
  });
});
