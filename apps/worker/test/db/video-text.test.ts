/**
 * R4.1 のマイグレーション `20261012000000_r4_1_video_text.sql` の結合テスト（設計 `doc/design/r4-1-video-text.md` 5 章、8 章）。
 * `TEST_DATABASE_URL`（postgres）があるときだけ動く。権限の節は `TEST_WEB_DATABASE_URL`（web_app）も要る。
 * 架空のアカウントと投稿を作り、終了時に消す（CASCADE で解析の行も消える。ocr_usage はアカウントごと消える）。
 *
 * 段階 2 の `db/video-text.ts` はまだないので、候補の SQL（設計 3.1 節）と行の書き込みはこのテストに直書きしている。
 * 段階 2 で `listVideoTextCandidates` ができたら、候補の節はその関数を呼ぶ形に替える。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertAccount } from "../../src/db/accounts.js";
import { closeDb, connectDb, type Db } from "../../src/db/client.js";
import { DEFAULT_SCENE_THRESHOLD } from "../../src/lib/ffmpeg.js";
import { ANALYZER_VERSION } from "../../src/lib/video-analysis.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_WEB_DATABASE_URL = process.env.TEST_WEB_DATABASE_URL;

const INSUFFICIENT_PRIVILEGE = "42501";
const CHECK_VIOLATION = "23514";

// 今の OCR の条件（設計 3.1 節の表）。段階 2 で `lib/video-text.ts` に置く定数と同じ値を直書きしている。
// 段階 2 でその定数を import する形に替える（DB の current_video_text_condition() と突き合わせるのが目的）
const OCR_METHOD = "google_vision";
const OCR_VERSION = "v1/DOCUMENT_TEXT_DETECTION";
const FRAME_INTERVAL_MS = 1000;
const TEXT_ANALYZER_VERSION = "1";
const SEGMENTER_VERSION = "1";
/** 対象にする動画の長さの上限（3 分。設計 3.2 節の定数。段階 2 で参照に替える） */
const VIDEO_TEXT_MAX_DURATION_MS = 3 * 60 * 1000;
/** 打ち切りの回数と再試行までの時間（設計 3.1 節の (a)。段階 2 の定数。SQL の検証では値は任意） */
const VIDEO_TEXT_MAX_ATTEMPTS = 3;
const RETRY_WAIT_HOURS = 3;

const OTHER_THRESHOLD = 0.4;
const OLD_SEGMENTER_VERSION = "0";
const OTHER_OCR_VERSION = "v1/TEXT_DETECTION";

/** 架空の Instagram アカウント ID（実在しない。先頭 6 桁が 0） */
function fakeIgUserId(): string {
  return "000000" + Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, "0");
}

/** 架空のメディア ID（実在しない。先頭 8 桁が 0） */
function fakeMediaId(): string {
  return "00000000" + Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, "0");
}

/** 失敗した SQL の SQLSTATE を返す。成功したら undefined */
async function sqlstate(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

interface MediaOptions {
  productType?: "REELS" | "FEED" | "STORY";
  mediaType?: "VIDEO" | "IMAGE";
  postedAt?: Date;
  goneAt?: Date | null;
}

interface TextAnalysisOptions {
  ocrVersion?: string;
  analyzerVersion?: string;
  segmenterVersion?: string;
  videoAnalysisId?: string | null;
  status?: "success" | "no_video_url" | "failed";
  analyzedAt?: Date;
  attemptCount?: number;
  durationMs?: number | null;
  /** success のときの特徴量を入れるか（既定 true。success 以外では入れない） */
  withFeatures?: boolean;
  totalTextChars?: number;
}

interface FeatureRow {
  media_id: string;
  analysis_status: string | null;
  text_analysis_id: string | null;
  text_status: string | null;
  text_attempt_count: number | null;
  text_analyzed_at: Date | null;
  text_segmenter_current: boolean | null;
  first_text_ms: number | null;
  has_text_in_first_3s: boolean | null;
  text_coverage_ratio: string | null;
  total_text_chars: number | null;
  segment_count: number | null;
  max_chars_per_frame: number | null;
  avg_chars_per_frame: string | null;
  caption_first_text_ms: number | null;
  caption_has_text_in_first_3s: boolean | null;
  caption_coverage_ratio: string | null;
  caption_total_chars: number | null;
}

describe.skipIf(!TEST_DATABASE_URL)("r4_1_video_text（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  let db: Db;
  /** ビューと制約の確認に使うアカウント */
  let accountId: string;
  /** 候補の SQL の確認に使うアカウント（ほかのテストの投稿が混ざらないよう分ける） */
  let candidateAccountId: string;

  async function insertMedia(id: string, owner: string, options: MediaOptions = {}): Promise<void> {
    const productType = options.productType ?? "REELS";
    const mediaType = options.mediaType ?? "VIDEO";
    const postedAt = options.postedAt ?? new Date("2026-10-01T10:00:00Z");
    const expiresAt = productType === "STORY" ? new Date(postedAt.getTime() + 24 * 60 * 60 * 1000) : null;
    await db`
      insert into public.media (id, account_id, media_type, media_product_type, posted_at, expires_at, gone_at)
      values (${id}, ${owner}, ${mediaType}, ${productType}, ${postedAt}, ${expiresAt}, ${options.goneAt ?? null})
    `;
  }

  /** カットの解析（video_analyses）の行。戻り値は id */
  async function insertCutAnalysis(
    mediaId: string,
    options: { threshold?: number; status?: "success" | "failed"; durationMs?: number | null } = {},
  ): Promise<string> {
    const rows = await db<{ id: string }[]>`
      insert into public.video_analyses (media_id, analyzer_version, scene_threshold, status, analyzed_at, duration_ms)
      values (${mediaId}, ${ANALYZER_VERSION}, ${options.threshold ?? DEFAULT_SCENE_THRESHOLD}, ${options.status ?? "success"},
              '2026-10-01T12:00:00Z', ${options.durationMs === undefined ? 15_000 : options.durationMs})
      returning id
    `;
    return rows[0]?.id ?? "";
  }

  /** 文字の解析（video_text_analyses）の行。戻り値は id */
  async function insertTextAnalysis(mediaId: string, options: TextAnalysisOptions = {}): Promise<string> {
    const status = options.status ?? "success";
    const withFeatures = status === "success" && (options.withFeatures ?? true);
    const totalTextChars = options.totalTextChars ?? 42;
    const rows = await db<{ id: string }[]>`
      insert into public.video_text_analyses (
        media_id, ocr_method, ocr_version, frame_interval_ms, analyzer_version, segmenter_version, video_analysis_id,
        status, error, analyzed_at, attempt_count, duration_ms, image_width, image_height,
        planned_frame_count, ocr_frame_count, units_used,
        first_text_ms, has_text_in_first_3s, text_coverage_ratio, total_text_chars, segment_count,
        max_chars_per_frame, avg_chars_per_frame,
        caption_first_text_ms, caption_has_text_in_first_3s, caption_coverage_ratio, caption_total_chars)
      values (
        ${mediaId}, ${OCR_METHOD}, ${options.ocrVersion ?? OCR_VERSION}, ${FRAME_INTERVAL_MS},
        ${options.analyzerVersion ?? TEXT_ANALYZER_VERSION}, ${options.segmenterVersion ?? SEGMENTER_VERSION},
        ${options.videoAnalysisId ?? null},
        ${status}, ${status === "success" ? null : "テスト用の固定文言"}, ${options.analyzedAt ?? new Date("2026-10-02T12:00:00Z")},
        ${options.attemptCount ?? 1}, ${options.durationMs === undefined ? 15_000 : options.durationMs}, 720, 1280,
        17, ${withFeatures ? 17 : 0}, ${withFeatures ? 17 : 0},
        ${withFeatures ? 500 : null}, ${withFeatures ? true : null}, ${withFeatures ? 0.6667 : null}, ${withFeatures ? totalTextChars : null},
        ${withFeatures ? 4 : null}, ${withFeatures ? 12 : null}, ${withFeatures ? 7.25 : null},
        ${withFeatures ? 1500 : null}, ${withFeatures ? true : null}, ${withFeatures ? 0.4 : null}, ${withFeatures ? 20 : null})
      returning id
    `;
    return rows[0]?.id ?? "";
  }

  async function featureRow(mediaId: string): Promise<FeatureRow | undefined> {
    const rows = await db<FeatureRow[]>`
      select media_id, analysis_status, text_analysis_id, text_status, text_attempt_count, text_analyzed_at, text_segmenter_current,
             first_text_ms, has_text_in_first_3s, text_coverage_ratio, total_text_chars, segment_count,
             max_chars_per_frame, avg_chars_per_frame,
             caption_first_text_ms, caption_has_text_in_first_3s, caption_coverage_ratio, caption_total_chars
      from public.media_video_features where media_id = ${mediaId}
    `;
    return rows[0];
  }

  /** 特徴量の列（text_status 以外）がすべて null か */
  function featuresAreNull(row: FeatureRow): boolean {
    return [
      row.first_text_ms,
      row.has_text_in_first_3s,
      row.text_coverage_ratio,
      row.total_text_chars,
      row.segment_count,
      row.max_chars_per_frame,
      row.avg_chars_per_frame,
      row.caption_first_text_ms,
      row.caption_has_text_in_first_3s,
      row.caption_coverage_ratio,
      row.caption_total_chars,
    ].every((v) => v === null);
  }

  beforeAll(async () => {
    db = connectDb(url);
    const account = await db.begin((tx) => upsertAccount(tx, { ig_user_id: fakeIgUserId() }));
    accountId = account.id;
    const candidateAccount = await db.begin((tx) => upsertAccount(tx, { ig_user_id: fakeIgUserId() }));
    candidateAccountId = candidateAccount.id;
  });

  afterAll(async () => {
    await db`delete from public.accounts where id in (${accountId}, ${candidateAccountId})`;
    // accounts → media → video_text_analyses → frames／segments と CASCADE で消える。ocr_usage は account_id の CASCADE で消える
    const [row] = await db<{ n: number }[]>`select count(*)::int as n from public.ocr_usage where account_id in (${accountId}, ${candidateAccountId})`;
    expect(row?.n).toBe(0);
    await closeDb(db);
  });

  it("current_video_text_condition() はワーカーの定数（段階 2 で lib/video-text.ts に置く）と一致する（設計 5.3 節）", async () => {
    const [row] = await db<
      { ocr_method: string; ocr_version: string; frame_interval_ms: number; analyzer_version: string; segmenter_version: string }[]
    >`select * from public.current_video_text_condition()`;
    expect(row).toEqual({
      ocr_method: OCR_METHOD,
      ocr_version: OCR_VERSION,
      frame_interval_ms: FRAME_INTERVAL_MS,
      analyzer_version: TEXT_ANALYZER_VERSION,
      segmenter_version: SEGMENTER_VERSION,
    });
  });

  describe("候補の SQL（設計 3.1 節）", () => {
    const NOW = new Date("2026-10-11T12:00:00Z");
    const HOUR = 60 * 60 * 1000;
    /** 投稿の順を固定する。index が小さいほど新しい */
    const posted = (index: number): Date => new Date(Date.UTC(2026, 9, 1, 10, 0, 0) - index * 60 * 1000);

    /** 設計 3.1 節の SQL そのもの。段階 2 の listVideoTextCandidates に替える */
    async function listCandidates(): Promise<{ id: string; text_status: string | null; segmenter_version: string | null }[]> {
      return db<{ id: string; text_status: string | null; segmenter_version: string | null }[]>`
        select m.id, m.posted_at,
               va.id as video_analysis_id, va.duration_ms,
               vt.id as text_analysis_id, vt.status as text_status, vt.segmenter_version,
               vt.video_analysis_id as stored_video_analysis_id, vt.duration_ms as stored_duration_ms
        from public.media m
        join public.video_analyses va
          on va.media_id = m.id and va.analyzer_version = ${ANALYZER_VERSION} and va.scene_threshold = ${DEFAULT_SCENE_THRESHOLD}
         and va.status = 'success'
        left join public.video_text_analyses vt
          on vt.media_id = m.id and vt.ocr_method = ${OCR_METHOD} and vt.ocr_version = ${OCR_VERSION}
         and vt.frame_interval_ms = ${FRAME_INTERVAL_MS} and vt.analyzer_version = ${TEXT_ANALYZER_VERSION}
        where m.account_id = ${candidateAccountId}
          and m.gone_at is null
          and m.media_type = 'VIDEO'
          and m.media_product_type in ('REELS', 'FEED')
          and va.duration_ms > 0 and va.duration_ms <= ${VIDEO_TEXT_MAX_DURATION_MS}
          and (vt.id is null
               or (vt.status <> 'success'
                   and vt.attempt_count < ${VIDEO_TEXT_MAX_ATTEMPTS}
                   and vt.analyzed_at <= ${NOW}::timestamptz - make_interval(hours => ${RETRY_WAIT_HOURS}::int))
               or (vt.status = 'success' and vt.segmenter_version <> ${SEGMENTER_VERSION}))
        order by m.posted_at desc, m.id
      `;
    }

    it("選ぶ条件と選ばない条件を網羅し、新しい順に返す", async () => {
      const ids: Record<string, string> = {};
      const add = async (name: string, index: number, options: MediaOptions = {}): Promise<string> => {
        const id = fakeMediaId();
        ids[name] = id;
        await insertMedia(id, candidateAccountId, { postedAt: posted(index), ...options });
        return id;
      };

      // 選ぶ: カットの解析が今の条件で success、長さが 0 より大きく上限以下、文字の行がない
      const fresh = await add("fresh", 1);
      await insertCutAnalysis(fresh);
      // 選ばない: 古いカットの条件（別のしきい値）の success しかない
      const oldCut = await add("oldCut", 2);
      await insertCutAnalysis(oldCut, { threshold: OTHER_THRESHOLD });
      // 選ばない: 今のカットの条件だが failed
      const cutFailed = await add("cutFailed", 3);
      await insertCutAnalysis(cutFailed, { status: "failed", durationMs: null });
      // 選ばない: duration_ms が null、0、上限超え。選ぶ: 上限ちょうど
      const durNull = await add("durNull", 4);
      await insertCutAnalysis(durNull, { durationMs: null });
      const durZero = await add("durZero", 5);
      await insertCutAnalysis(durZero, { durationMs: 0 });
      const durTooLong = await add("durTooLong", 6);
      await insertCutAnalysis(durTooLong, { durationMs: VIDEO_TEXT_MAX_DURATION_MS + 1 });
      const durMax = await add("durMax", 7);
      await insertCutAnalysis(durMax, { durationMs: VIDEO_TEXT_MAX_DURATION_MS });
      // media_product_type と media_type: FEED の動画は選ぶ。STORY と画像は選ばない
      const feed = await add("feed", 8, { productType: "FEED" });
      await insertCutAnalysis(feed);
      const story = await add("story", 9, { productType: "STORY" });
      await insertCutAnalysis(story);
      const image = await add("image", 10, { productType: "FEED", mediaType: "IMAGE" });
      await insertCutAnalysis(image);
      // 選ばない: 消えた投稿
      const gone = await add("gone", 11, { goneAt: new Date("2026-10-05T00:00:00Z") });
      await insertCutAnalysis(gone);
      // (a) 再試行: failed で attempt_count が上限未満、analyzed_at が now − 3 時間以前（ちょうどは含む）
      const retryDue = await add("retryDue", 12);
      await insertTextAnalysis(retryDue, { status: "failed", attemptCount: 1, analyzedAt: new Date(NOW.getTime() - RETRY_WAIT_HOURS * HOUR), videoAnalysisId: await insertCutAnalysis(retryDue) });
      const retryTooSoon = await add("retryTooSoon", 13);
      await insertTextAnalysis(retryTooSoon, { status: "failed", attemptCount: 1, analyzedAt: new Date(NOW.getTime() - RETRY_WAIT_HOURS * HOUR + 1000), videoAnalysisId: await insertCutAnalysis(retryTooSoon) });
      const retryExhausted = await add("retryExhausted", 14);
      await insertTextAnalysis(retryExhausted, { status: "failed", attemptCount: VIDEO_TEXT_MAX_ATTEMPTS, analyzedAt: new Date(NOW.getTime() - 24 * HOUR), videoAnalysisId: await insertCutAnalysis(retryExhausted) });
      const noVideoUrl = await add("noVideoUrl", 15);
      await insertTextAnalysis(noVideoUrl, { status: "no_video_url", attemptCount: 2, analyzedAt: new Date(NOW.getTime() - 24 * HOUR), videoAnalysisId: await insertCutAnalysis(noVideoUrl) });
      // success: 今の segmenter_version は選ばない。古い版は (b) で選ぶ
      const successCurrent = await add("successCurrent", 16);
      await insertTextAnalysis(successCurrent, { videoAnalysisId: await insertCutAnalysis(successCurrent) });
      const successOld = await add("successOld", 17);
      await insertTextAnalysis(successOld, { segmenterVersion: OLD_SEGMENTER_VERSION, videoAnalysisId: await insertCutAnalysis(successOld) });
      // 別の OCR の条件（ocr_version）の success しかない → 今の条件の行がないので選ぶ
      const otherOcr = await add("otherOcr", 18);
      await insertTextAnalysis(otherOcr, { ocrVersion: OTHER_OCR_VERSION, videoAnalysisId: await insertCutAnalysis(otherOcr) });
      // success でも attempt_count が上限でも、segmenter_version が古ければ (b) で選ぶ（(a) の条件は success に掛からない）
      const successOldExhausted = await add("successOldExhausted", 19);
      await insertTextAnalysis(successOldExhausted, { segmenterVersion: OLD_SEGMENTER_VERSION, attemptCount: VIDEO_TEXT_MAX_ATTEMPTS, videoAnalysisId: await insertCutAnalysis(successOldExhausted) });

      const rows = await listCandidates();
      expect(rows.map((r) => r.id)).toEqual([
        ids["fresh"],
        ids["durMax"],
        ids["feed"],
        ids["retryDue"],
        ids["noVideoUrl"],
        ids["successOld"],
        ids["otherOcr"],
        ids["successOldExhausted"],
      ]);
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(ids["fresh"] ?? "")?.text_status).toBeNull();
      expect(byId.get(ids["otherOcr"] ?? "")?.text_status).toBeNull();
      expect(byId.get(ids["retryDue"] ?? "")?.text_status).toBe("failed");
      expect(byId.get(ids["noVideoUrl"] ?? "")?.text_status).toBe("no_video_url");
      expect(byId.get(ids["successOld"] ?? "")).toMatchObject({ text_status: "success", segmenter_version: OLD_SEGMENTER_VERSION });
    });
  });

  describe("media_video_features の文字の列（設計 5.4 節 1）", () => {
    it("今の条件の success の行: text_status は success、text_segmenter_current は真、特徴量が出る", async () => {
      const mediaId = fakeMediaId();
      await insertMedia(mediaId, accountId);
      const cutId = await insertCutAnalysis(mediaId);
      const textId = await insertTextAnalysis(mediaId, { videoAnalysisId: cutId });
      const row = await featureRow(mediaId);
      expect(row).toMatchObject({
        analysis_status: "success",
        text_analysis_id: textId,
        text_status: "success",
        text_attempt_count: 1,
        text_analyzed_at: new Date("2026-10-02T12:00:00Z"),
        text_segmenter_current: true,
        first_text_ms: 500,
        has_text_in_first_3s: true,
        total_text_chars: 42,
        segment_count: 4,
        max_chars_per_frame: 12,
        caption_first_text_ms: 1500,
        caption_has_text_in_first_3s: true,
        caption_total_chars: 20,
      });
      expect(Number(row?.text_coverage_ratio)).toBe(0.6667);
      expect(Number(row?.avg_chars_per_frame)).toBe(7.25);
      expect(Number(row?.caption_coverage_ratio)).toBe(0.4);
    });

    it("success で segmenter_version が古い行: text_status は success のまま、text_segmenter_current は偽、特徴量は null", async () => {
      const mediaId = fakeMediaId();
      await insertMedia(mediaId, accountId);
      const textId = await insertTextAnalysis(mediaId, { videoAnalysisId: await insertCutAnalysis(mediaId) });
      await db`update public.video_text_analyses set segmenter_version = ${OLD_SEGMENTER_VERSION} where id = ${textId}`;
      const row = await featureRow(mediaId);
      expect(row).toMatchObject({ text_analysis_id: textId, text_status: "success", text_attempt_count: 1, text_segmenter_current: false });
      expect(row && featuresAreNull(row)).toBe(true);
    });

    it("古い版の failed: text_status は failed、text_segmenter_current は偽、特徴量は null。attempt_count は行の値", async () => {
      const mediaId = fakeMediaId();
      await insertMedia(mediaId, accountId);
      await insertTextAnalysis(mediaId, { status: "failed", segmenterVersion: OLD_SEGMENTER_VERSION, attemptCount: 3 });
      const row = await featureRow(mediaId);
      expect(row).toMatchObject({ text_status: "failed", text_attempt_count: 3, text_segmenter_current: false });
      expect(row && featuresAreNull(row)).toBe(true);
    });

    it("文字の行がない: text_status も text_segmenter_current も null。別の OCR の条件の行は結合しない", async () => {
      const mediaId = fakeMediaId();
      await insertMedia(mediaId, accountId);
      await insertCutAnalysis(mediaId);
      expect(await featureRow(mediaId)).toMatchObject({ analysis_status: "success", text_analysis_id: null, text_status: null, text_segmenter_current: null });
      // 別の ocr_version、別の analyzer_version の行は見えない
      await insertTextAnalysis(mediaId, { ocrVersion: OTHER_OCR_VERSION });
      await insertTextAnalysis(mediaId, { analyzerVersion: "99" });
      const row = await featureRow(mediaId);
      expect(row?.text_status).toBeNull();
      expect(row?.text_segmenter_current).toBeNull();
      expect(row && featuresAreNull(row)).toBe(true);
    });

    it("カットの条件を変えた後（今の条件の video_analyses がない）も text_status が残る（文字の列は OCR の条件だけで結合する）", async () => {
      const mediaId = fakeMediaId();
      await insertMedia(mediaId, accountId);
      const oldCutId = await insertCutAnalysis(mediaId, { threshold: OTHER_THRESHOLD });
      await insertTextAnalysis(mediaId, { videoAnalysisId: oldCutId });
      const row = await featureRow(mediaId);
      expect(row).toMatchObject({ analysis_status: null, text_status: "success", text_segmenter_current: true, first_text_ms: 500 });
    });

    it("video_analyses の行を消しても文字の行は残り、video_analysis_id が null になる（on delete set null）", async () => {
      const mediaId = fakeMediaId();
      await insertMedia(mediaId, accountId);
      const cutId = await insertCutAnalysis(mediaId);
      const textId = await insertTextAnalysis(mediaId, { videoAnalysisId: cutId });
      await db`delete from public.video_analyses where id = ${cutId}`;
      const [row] = await db<{ video_analysis_id: string | null; status: string }[]>`
        select video_analysis_id, status from public.video_text_analyses where id = ${textId}
      `;
      expect(row).toEqual({ video_analysis_id: null, status: "success" });
    });
  });

  describe("media_analysis_dataset の末尾の列（設計 5.4 節 2）", () => {
    it("最新の success（条件をまたぐ）の特徴量と条件の列が出る。success 以外は見ない", async () => {
      const mediaId = fakeMediaId();
      await insertMedia(mediaId, accountId);
      await insertTextAnalysis(mediaId, { ocrVersion: OTHER_OCR_VERSION, analyzedAt: new Date("2026-10-01T00:00:00Z"), totalTextChars: 10 });
      await insertTextAnalysis(mediaId, { analyzedAt: new Date("2026-10-02T00:00:00Z"), totalTextChars: 20 });
      // より新しい failed（別の analyzer_version）は無視される
      await insertTextAnalysis(mediaId, { analyzerVersion: "99", status: "failed", analyzedAt: new Date("2026-10-03T00:00:00Z") });
      const [row] = await db<Record<string, unknown>[]>`
        select ocr_method, ocr_version, frame_interval_ms, text_analyzer_version, segmenter_version,
               first_text_ms, has_text_in_first_3s, text_coverage_ratio, total_text_chars, segment_count
        from public.media_analysis_dataset where media_id = ${mediaId}
      `;
      expect(row).toMatchObject({
        ocr_method: OCR_METHOD,
        ocr_version: OCR_VERSION,
        frame_interval_ms: FRAME_INTERVAL_MS,
        text_analyzer_version: TEXT_ANALYZER_VERSION,
        segmenter_version: SEGMENTER_VERSION,
        first_text_ms: 500,
        has_text_in_first_3s: true,
        total_text_chars: 20,
        segment_count: 4,
      });
      expect(Number(row?.["text_coverage_ratio"])).toBe(0.6667);
    });

    it("文字の解析がなければ末尾の列は null（行は出る）", async () => {
      const mediaId = fakeMediaId();
      await insertMedia(mediaId, accountId);
      const [row] = await db<Record<string, unknown>[]>`
        select media_id, ocr_method, ocr_version, frame_interval_ms, text_analyzer_version, segmenter_version,
               first_text_ms, has_text_in_first_3s, text_coverage_ratio, total_text_chars, segment_count
        from public.media_analysis_dataset where media_id = ${mediaId}
      `;
      expect(row).toEqual({
        media_id: mediaId,
        ocr_method: null,
        ocr_version: null,
        frame_interval_ms: null,
        text_analyzer_version: null,
        segmenter_version: null,
        first_text_ms: null,
        has_text_in_first_3s: null,
        text_coverage_ratio: null,
        total_text_chars: null,
        segment_count: null,
      });
    });
  });

  describe("ocr_usage と ocr_monthly_usage（設計 5.4 節 3）", () => {
    async function insertUsage(options: {
      mediaId: string | null;
      analysisId?: string | null;
      requestedAt: string;
      imageCount: number;
      units: number;
      ok: boolean;
      httpStatus: number | null;
    }): Promise<void> {
      await db`
        insert into public.ocr_usage (account_id, media_id, analysis_id, job_run_id, ocr_method, ocr_version, requested_at,
                                      elapsed_ms, image_count, units, request_bytes, response_bytes, word_count, http_status, ok)
        values (${accountId}, ${options.mediaId}, ${options.analysisId ?? null}, null, ${OCR_METHOD}, ${OCR_VERSION}, ${options.requestedAt}::timestamptz,
                529, ${options.imageCount}, ${options.units}, 920000, 172000, 300, ${options.httpStatus}, ${options.ok})
      `;
    }

    it("UTC の月初 00:00 ちょうどの行はその月に入り、直前の秒は前の月。失敗の数、ユニット、本数（media_id が null は数えない）", async () => {
      const m1 = fakeMediaId();
      const m2 = fakeMediaId();
      await insertMedia(m1, accountId);
      await insertMedia(m2, accountId);
      await insertUsage({ mediaId: m1, requestedAt: "2026-10-01T00:00:00Z", imageCount: 8, units: 8, ok: true, httpStatus: 200 });
      await insertUsage({ mediaId: m1, requestedAt: "2026-09-30T23:59:59Z", imageCount: 5, units: 5, ok: true, httpStatus: 200 });
      await insertUsage({ mediaId: m2, requestedAt: "2026-10-15T03:00:00Z", imageCount: 8, units: 0, ok: false, httpStatus: 429 });
      await insertUsage({ mediaId: m2, requestedAt: "2026-10-15T03:00:10Z", imageCount: 8, units: 8, ok: false, httpStatus: null });
      await insertUsage({ mediaId: null, requestedAt: "2026-10-20T00:00:00Z", imageCount: 3, units: 3, ok: true, httpStatus: 200 });
      // JST では 10 月 1 日 08:59:59 だが UTC では 9 月（月は UTC の暦月）
      await insertUsage({ mediaId: m1, requestedAt: "2026-10-01T08:59:59+09:00", imageCount: 1, units: 1, ok: true, httpStatus: 200 });

      const rows = await db<Record<string, unknown>[]>`
        select month_utc, requests, failed_requests, images, units, videos
        from public.ocr_monthly_usage where account_id = ${accountId} order by month_utc
      `;
      expect(rows).toEqual([
        { month_utc: "2026-09-01", requests: 2, failed_requests: 0, images: 6, units: 6, videos: 1 },
        { month_utc: "2026-10-01", requests: 4, failed_requests: 2, images: 27, units: 19, videos: 2 },
      ]);
    });

    it("ok が真なら http_status が要る（check）。units と image_count の範囲", async () => {
      expect(
        await sqlstate(() => insertUsage({ mediaId: null, requestedAt: "2026-10-02T00:00:00Z", imageCount: 1, units: 1, ok: true, httpStatus: null })),
      ).toBe(CHECK_VIOLATION);
      expect(
        await sqlstate(() => insertUsage({ mediaId: null, requestedAt: "2026-10-02T00:00:00Z", imageCount: 0, units: 0, ok: false, httpStatus: null })),
      ).toBe(CHECK_VIOLATION);
      expect(
        await sqlstate(() => insertUsage({ mediaId: null, requestedAt: "2026-10-02T00:00:00Z", imageCount: 1, units: -1, ok: false, httpStatus: 500 })),
      ).toBe(CHECK_VIOLATION);
    });

    it("投稿を消しても ocr_usage は残り、media_id と analysis_id が null になる（費用の記録は消さない）", async () => {
      const mediaId = fakeMediaId();
      await insertMedia(mediaId, accountId);
      const textId = await insertTextAnalysis(mediaId);
      await insertUsage({ mediaId, analysisId: textId, requestedAt: "2026-11-01T00:00:00Z", imageCount: 8, units: 8, ok: true, httpStatus: 200 });
      await db`delete from public.media where id = ${mediaId}`;
      const rows = await db<{ media_id: string | null; analysis_id: string | null; units: number }[]>`
        select media_id, analysis_id, units from public.ocr_usage where account_id = ${accountId} and requested_at = '2026-11-01T00:00:00Z'
      `;
      expect(rows).toEqual([{ media_id: null, analysis_id: null, units: 8 }]);
      const [month] = await db<{ videos: number; units: number }[]>`
        select videos, units from public.ocr_monthly_usage where account_id = ${accountId} and month_utc = '2026-11-01'
      `;
      expect(month).toEqual({ videos: 0, units: 8 });
    });
  });

  describe("video_text_frames と video_text_segments の check（設計 5.2 節）", () => {
    let analysisId: string;

    beforeAll(async () => {
      const mediaId = fakeMediaId();
      await insertMedia(mediaId, accountId);
      analysisId = await insertTextAnalysis(mediaId);
    });

    const insertFrame = (atMs: number, text: string | null, words: string | null, errorCode: number | null) =>
      db`
        insert into public.video_text_frames (analysis_id, at_ms, source, text, words, word_count, error_code, fetched_at)
        values (${analysisId}, ${atMs}, 'interval', ${text}, ${words}::jsonb, ${words === null ? null : 0}, ${errorCode}, now())
      `;

    it("成功は text と words がある（文字なしは '' と '[]'）。失敗は error_code があり words が null", async () => {
      expect(await sqlstate(() => insertFrame(0, "", "[]", null))).toBeUndefined();
      expect(await sqlstate(() => insertFrame(1000, "ランチ", '[{"t":"ランチ"}]', null))).toBeUndefined();
      expect(await sqlstate(() => insertFrame(2000, null, null, 500))).toBeUndefined();
      expect(await sqlstate(() => insertFrame(3000, "部分的な文字", null, 500))).toBeUndefined();
      // 成功なのに text か words がない
      expect(await sqlstate(() => insertFrame(4000, null, "[]", null))).toBe(CHECK_VIOLATION);
      expect(await sqlstate(() => insertFrame(4000, "", null, null))).toBe(CHECK_VIOLATION);
      // 失敗なのに words がある
      expect(await sqlstate(() => insertFrame(4000, null, "[]", 500))).toBe(CHECK_VIOLATION);
      // 同じ時刻は 1 行（主キー）
      expect(await sqlstate(() => insertFrame(0, "", "[]", null))).toBe("23505");
      // source は interval か cut
      expect(
        await sqlstate(
          () => db`insert into public.video_text_frames (analysis_id, at_ms, source, text, words, fetched_at) values (${analysisId}, 5000, 'manual', '', '[]', now())`,
        ),
      ).toBe(CHECK_VIOLATION);
    });

    it("区間は end_ms > start_ms、frame_count >= 1、vertical_position は top／middle／bottom", async () => {
      const insertSegment = (seq: number, startMs: number, endMs: number, position: string, frameCount: number) =>
        db`
          insert into public.video_text_segments (analysis_id, seq, text, text_norm, start_ms, end_ms, vertical_position,
                                                  center_x_ratio, center_y_ratio, char_height_ratio, confidence, frame_count, lang, is_caption_like)
          values (${analysisId}, ${seq}, 'ランチ営業', 'ランチ営業', ${startMs}, ${endMs}, ${position}, 0.5, 0.3, 0.035, 0.99, ${frameCount}, 'ja', true)
        `;
      expect(await sqlstate(() => insertSegment(1, 0, 1000, "top", 1))).toBeUndefined();
      expect(await sqlstate(() => insertSegment(2, 1000, 1000, "top", 1))).toBe(CHECK_VIOLATION);
      expect(await sqlstate(() => insertSegment(2, 2000, 1000, "top", 1))).toBe(CHECK_VIOLATION);
      expect(await sqlstate(() => insertSegment(2, 0, 1000, "top", 0))).toBe(CHECK_VIOLATION);
      expect(await sqlstate(() => insertSegment(2, 0, 1000, "center", 1))).toBe(CHECK_VIOLATION);
      expect(await sqlstate(() => insertSegment(0, 0, 1000, "top", 1))).toBe(CHECK_VIOLATION);
    });

    it("解析の行を消すとフレームと区間も消える（CASCADE）", async () => {
      await db`delete from public.video_text_analyses where id = ${analysisId}`;
      const [frames] = await db<{ n: number }[]>`select count(*)::int as n from public.video_text_frames where analysis_id = ${analysisId}`;
      const [segments] = await db<{ n: number }[]>`select count(*)::int as n from public.video_text_segments where analysis_id = ${analysisId}`;
      expect(frames?.n).toBe(0);
      expect(segments?.n).toBe(0);
    });
  });

  it("一意キーは (media_id, ocr_method, ocr_version, frame_interval_ms, analyzer_version)。segmenter_version は含めない", async () => {
    const mediaId = fakeMediaId();
    await insertMedia(mediaId, accountId);
    await insertTextAnalysis(mediaId);
    expect(await sqlstate(() => insertTextAnalysis(mediaId, { segmenterVersion: OLD_SEGMENTER_VERSION }))).toBe("23505");
    expect(await sqlstate(() => insertTextAnalysis(mediaId, { ocrVersion: OTHER_OCR_VERSION }))).toBeUndefined();
    expect(await sqlstate(() => insertTextAnalysis(mediaId, { analyzerVersion: "2" }))).toBeUndefined();
    // duration_ms は 0 を許さない（R4 は許す）。attempt_count は 1 以上
    expect(await sqlstate(() => insertTextAnalysis(mediaId, { analyzerVersion: "3", durationMs: 0 }))).toBe(CHECK_VIOLATION);
    expect(await sqlstate(() => insertTextAnalysis(mediaId, { analyzerVersion: "3", attemptCount: 0 }))).toBe(CHECK_VIOLATION);
  });

  describe.skipIf(!TEST_WEB_DATABASE_URL)("権限（設計 5.5 節）", () => {
    let web: Db;

    beforeAll(() => {
      web = connectDb(TEST_WEB_DATABASE_URL ?? "");
    });

    afterAll(async () => {
      await closeDb(web);
    });

    /** 1 つのトランザクションの中でロールを切り替えてクエリを 1 回だけ流す（web-role.test.ts と同じ形） */
    function asRole(role: "anon" | "authenticated", query: string): () => Promise<unknown> {
      return () =>
        db.begin(async (tx) => {
          await tx.unsafe(`set local role ${role}`);
          return tx.unsafe(query);
        });
    }

    it("web_app は 3 表と 3 ビューを select でき、current_video_text_condition() を実行できる", async () => {
      for (const relation of ["video_text_analyses", "video_text_segments", "ocr_usage", "media_video_features", "media_analysis_dataset", "ocr_monthly_usage"]) {
        expect(await sqlstate(() => web`select * from ${web(`public.${relation}`)} limit 1`), relation).toBeUndefined();
      }
      const [row] = await web<{ ocr_method: string }[]>`select ocr_method from public.current_video_text_condition()`;
      expect(row?.ocr_method).toBe(OCR_METHOD);
    });

    it("web_app は video_text_frames を読めず、3 表に insert／update／delete できない", async () => {
      expect(await sqlstate(() => web`select * from public.video_text_frames limit 1`)).toBe(INSUFFICIENT_PRIVILEGE);
      expect(
        await sqlstate(
          () => web`insert into public.ocr_usage (account_id, ocr_method, ocr_version, requested_at, image_count, units, http_status, ok)
                    values (${accountId}, 'x', 'x', now(), 1, 1, 200, true)`,
        ),
      ).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await sqlstate(() => web`update public.video_text_analyses set status = 'failed' where media_id = 'x'`)).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await sqlstate(() => web`delete from public.video_text_segments where analysis_id = 0`)).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await sqlstate(() => web`update public.ocr_usage set units = 0 where id = 0`)).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("anon と authenticated は 4 表と ocr_monthly_usage を読めず、関数も実行できない", async () => {
      for (const role of ["anon", "authenticated"] as const) {
        for (const relation of ["video_text_analyses", "video_text_frames", "video_text_segments", "ocr_usage", "ocr_monthly_usage"]) {
          expect(await sqlstate(asRole(role, `select * from public.${relation} limit 1`)), `${role} / ${relation}`).toBe(INSUFFICIENT_PRIVILEGE);
        }
        expect(await sqlstate(asRole(role, "select * from public.current_video_text_condition()")), role).toBe(INSUFFICIENT_PRIVILEGE);
      }
    });
  });
});
