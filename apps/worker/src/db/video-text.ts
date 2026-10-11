/**
 * `video_text_analyses`、`video_text_frames`、`video_text_segments`、`ocr_usage`（R4.1 設計 3.1 節、3.3 節、3.6 節、5 章）。
 *
 * - 対象の選び方（再試行と打ち切りの判定を含む）は `listVideoTextCandidates` の SQL 1 本
 * - 1 本の処理は「取り掛かりの記録（upsert。`attempt_count + 1`）→ 要求ごとの書き込み（`ocr_usage` ＋ フレーム ＋
 *   `units_used`。1 トランザクション）→ 結果の書き込み（特徴量と区間。`attempt_count` と `units_used` は触らない）」
 * - 再区間化 (b) は `resegmentVideoText`（`attempt_count`、`units_used`、`status`、`error` を触らない）
 * - `numeric` の列は postgres.js では文字列で返るので、読み出しでは `Number()` に変換する。`bigint` の ID は文字列のまま
 * - この層はログを出さず、`error` 列の文字列も加工しない（呼び出し側が固定文言かマスク済みの文字列を渡す）
 */
import type { Db, Tx } from "./client.js";
import { jsonb } from "./client.js";
import type { VideoAnalysisStatus } from "./types.js";
import type { FrameSource, FrameWord, TextFeatures, TextSegment } from "../lib/video-text.js";

/** `video_text_analyses.status`（`video_analyses` と同じ 3 値） */
export type VideoTextStatus = VideoAnalysisStatus;

/** 取り掛かりの記録の固定文言（途中で落ちたらこのまま残る） */
export const IN_PROGRESS_ERROR = "処理の途中で止まった";

/** `listVideoTextCandidates` の 1 行（設計 3.1 節の SQL の列） */
export interface VideoTextCandidate {
  id: string;
  posted_at: Date;
  /** 今のカットの条件の `video_analyses.id` */
  video_analysis_id: string;
  duration_ms: number;
  text_analysis_id: string | null;
  text_status: VideoTextStatus | null;
  segmenter_version: string | null;
  /** 文字の行に残した `video_analysis_id`（再試行の計画に使う。`set null` なら null） */
  stored_video_analysis_id: string | null;
  stored_duration_ms: number | null;
  /** 文字の行に残した送った画像の大きさ（再試行と再区間化で矩形を比率に直すのに使う） */
  stored_image_width: number | null;
  stored_image_height: number | null;
}

export interface VideoTextCandidateQuery {
  accountId: string;
  /** カットの条件（`video_analyses`） */
  analyzerVersion: string;
  sceneThreshold: number;
  /** OCR の条件（一意キーの 4 つ） */
  ocrMethod: string;
  ocrVersion: string;
  frameIntervalMs: number;
  textAnalyzerVersion: string;
  /** 今の区間化の版。違う `success` の行は (b) で選ぶ */
  segmenterVersion: string;
  /** 対象にする長さの上限（ミリ秒） */
  maxDurationMs: number;
  maxAttempts: number;
  now: Date;
  retryAfterHours: number;
}

/**
 * `video_text` の対象（設計 3.1 節）。新しい順の全件。
 * (a) `status <> 'success'` かつ `attempt_count < maxAttempts` かつ `analyzed_at <= now − retryAfterHours`、
 * (b) `status = 'success'` かつ `segmenter_version` が今の版と違う
 */
export async function listVideoTextCandidates(db: Db, q: VideoTextCandidateQuery): Promise<VideoTextCandidate[]> {
  return db<VideoTextCandidate[]>`
    select m.id, m.posted_at,
           va.id as video_analysis_id, va.duration_ms,
           vt.id as text_analysis_id, vt.status as text_status, vt.segmenter_version,
           vt.video_analysis_id as stored_video_analysis_id, vt.duration_ms as stored_duration_ms,
           vt.image_width as stored_image_width, vt.image_height as stored_image_height
    from public.media m
    join public.video_analyses va
      on va.media_id = m.id and va.analyzer_version = ${q.analyzerVersion} and va.scene_threshold = ${q.sceneThreshold}
     and va.status = 'success'
    left join public.video_text_analyses vt
      on vt.media_id = m.id and vt.ocr_method = ${q.ocrMethod} and vt.ocr_version = ${q.ocrVersion}
     and vt.frame_interval_ms = ${q.frameIntervalMs} and vt.analyzer_version = ${q.textAnalyzerVersion}
    where m.account_id = ${q.accountId}
      and m.gone_at is null
      and m.media_type = 'VIDEO'
      and m.media_product_type in ('REELS', 'FEED')
      and va.duration_ms > 0 and va.duration_ms <= ${q.maxDurationMs}
      and (vt.id is null
           or (vt.status <> 'success'
               and vt.attempt_count < ${q.maxAttempts}
               and vt.analyzed_at <= ${q.now}::timestamptz - make_interval(hours => ${q.retryAfterHours}::int))
           or (vt.status = 'success' and vt.segmenter_version <> ${q.segmenterVersion}))
    order by m.posted_at desc, m.id
  `;
}

/** カットの時刻（`video_cuts.at_ms`）を `seq` 順に読む。行がなければ undefined（`video_analyses` が消えている） */
export async function listCutsForAnalysis(db: Db, videoAnalysisId: string): Promise<number[] | undefined> {
  const exists = await db<{ id: string }[]>`select id from public.video_analyses where id = ${videoAnalysisId}`;
  if (exists.length === 0) return undefined;
  const rows = await db<{ at_ms: number }[]>`
    select at_ms from public.video_cuts where analysis_id = ${videoAnalysisId} order by seq
  `;
  return rows.map((r) => r.at_ms);
}

/** 保存したフレーム 1 行 */
export interface StoredFrame {
  at_ms: number;
  source: FrameSource;
  text: string | null;
  words: FrameWord[] | null;
  word_count: number | null;
  error_code: number | null;
}

/** 解析の行のフレームを `at_ms` 順に読む */
export async function listStoredFrames(db: Db | Tx, analysisId: string): Promise<StoredFrame[]> {
  return db<StoredFrame[]>`
    select at_ms, source, text, words, word_count, error_code
    from public.video_text_frames
    where analysis_id = ${analysisId}
    order by at_ms
  `;
}

/** 取り掛かりの記録の入力（設計 3.6 節 2） */
export interface BeginVideoTextAttemptInput {
  mediaId: string;
  ocrMethod: string;
  ocrVersion: string;
  frameIntervalMs: number;
  analyzerVersion: string;
  segmenterVersion: string;
  videoAnalysisId: string | null;
  durationMs: number;
  plannedFrameCount: number;
  analyzedAt: Date;
}

export interface BegunVideoTextAttempt {
  /** `video_text_analyses.id`（文字列） */
  id: string;
  /** 書いた後の `attempt_count` */
  attempt_count: number;
}

/**
 * 取り掛かりの記録。なければ挿入（`attempt_count` 1）、あれば `failed`／`IN_PROGRESS_ERROR`／`attempt_count + 1` に上書きし、
 * `planned_frame_count`、`video_analysis_id`、`duration_ms`、`segmenter_version` を今の値にする。特徴量は null に戻す
 */
export async function beginVideoTextAttempt(tx: Tx, input: BeginVideoTextAttemptInput): Promise<BegunVideoTextAttempt> {
  const rows = await tx<{ id: string; attempt_count: number }[]>`
    insert into public.video_text_analyses
      (media_id, ocr_method, ocr_version, frame_interval_ms, analyzer_version, segmenter_version, video_analysis_id,
       status, error, analyzed_at, duration_ms, planned_frame_count)
    values
      (${input.mediaId}, ${input.ocrMethod}, ${input.ocrVersion}, ${input.frameIntervalMs}, ${input.analyzerVersion},
       ${input.segmenterVersion}, ${input.videoAnalysisId}, 'failed', ${IN_PROGRESS_ERROR}, ${input.analyzedAt},
       ${input.durationMs}, ${input.plannedFrameCount})
    on conflict (media_id, ocr_method, ocr_version, frame_interval_ms, analyzer_version) do update set
      segmenter_version = excluded.segmenter_version,
      video_analysis_id = excluded.video_analysis_id,
      status = 'failed',
      error = excluded.error,
      analyzed_at = excluded.analyzed_at,
      attempt_count = public.video_text_analyses.attempt_count + 1,
      duration_ms = excluded.duration_ms,
      planned_frame_count = excluded.planned_frame_count,
      first_text_ms = null, has_text_in_first_3s = null, text_coverage_ratio = null, total_text_chars = null,
      segment_count = null, max_chars_per_frame = null, avg_chars_per_frame = null,
      caption_first_text_ms = null, caption_has_text_in_first_3s = null, caption_coverage_ratio = null, caption_total_chars = null
    returning id, attempt_count
  `;
  const row = rows[0];
  if (!row) throw new Error("video_text_analyses の upsert が id を返さなかった");
  return { id: row.id, attempt_count: row.attempt_count };
}

/** 計画にない `at_ms` のフレームを消す（設計 3.6 節 3）。消した行数を返す */
export async function deleteFramesNotPlanned(tx: Tx, analysisId: string, plannedAtMs: readonly number[]): Promise<number> {
  const result = await tx`
    delete from public.video_text_frames
    where analysis_id = ${analysisId}
      and at_ms <> all(${[...plannedAtMs]}::int[])
  `;
  return result.count;
}

/** `ocr_usage` の 1 行（`id` なし） */
export interface OcrUsageInsert {
  account_id: string;
  media_id: string;
  analysis_id: string;
  job_run_id: string;
  ocr_method: string;
  ocr_version: string;
  requested_at: Date;
  elapsed_ms: number;
  image_count: number;
  units: number;
  request_bytes: number;
  response_bytes: number | null;
  word_count: number | null;
  http_status: number | null;
  ok: boolean;
}

/** `video_text_frames` の 1 行（`analysis_id` なし） */
export interface FrameUpsert {
  at_ms: number;
  source: FrameSource;
  text: string | null;
  words: FrameWord[] | null;
  word_count: number | null;
  error_code: number | null;
  fetched_at: Date;
}

/**
 * 要求ごとの書き込み（設計 3.6 節 5）: `ocr_usage` に 1 行、フレームを `at_ms` で upsert、`units_used` に `units` を足す。
 * トランザクションの中で呼ぶこと
 */
export async function writeOcrRequest(tx: Tx, usage: OcrUsageInsert, frames: readonly FrameUpsert[]): Promise<void> {
  await tx`
    insert into public.ocr_usage
      (account_id, media_id, analysis_id, job_run_id, ocr_method, ocr_version, requested_at,
       elapsed_ms, image_count, units, request_bytes, response_bytes, word_count, http_status, ok)
    values
      (${usage.account_id}, ${usage.media_id}, ${usage.analysis_id}, ${usage.job_run_id}, ${usage.ocr_method}, ${usage.ocr_version},
       ${usage.requested_at}, ${usage.elapsed_ms}, ${usage.image_count}, ${usage.units}, ${usage.request_bytes},
       ${usage.response_bytes}, ${usage.word_count}, ${usage.http_status}, ${usage.ok})
  `;
  for (const frame of frames) {
    await tx`
      insert into public.video_text_frames (analysis_id, at_ms, source, text, words, word_count, error_code, fetched_at)
      values (${usage.analysis_id}, ${frame.at_ms}, ${frame.source}, ${frame.text},
              ${frame.words === null ? null : jsonb(tx, frame.words)}, ${frame.word_count}, ${frame.error_code}, ${frame.fetched_at})
      on conflict (analysis_id, at_ms) do update set
        source = excluded.source,
        text = excluded.text,
        words = excluded.words,
        word_count = excluded.word_count,
        error_code = excluded.error_code,
        fetched_at = excluded.fetched_at
    `;
  }
  if (usage.units > 0) {
    await tx`update public.video_text_analyses set units_used = units_used + ${usage.units} where id = ${usage.analysis_id}`;
  }
}

/** 結果の書き込みの入力（設計 3.6 節 7 (a)） */
export interface FinishVideoTextAttemptInput {
  status: VideoTextStatus;
  error: string | null;
  analyzedAt: Date;
  ocrFrameCount: number;
  /** 末尾の取り出せないフレームを外した後の計画の枚数。省略時は取り掛かりの記録の値のまま */
  plannedFrameCount?: number;
  imageWidth: number | null;
  imageHeight: number | null;
  segmenterVersion: string;
  /** `success` のときだけ。それ以外は null（特徴量の列を null にする） */
  features: TextFeatures | null;
}

const NULL_FEATURES: TextFeatures = {
  first_text_ms: null,
  has_text_in_first_3s: null as unknown as boolean,
  text_coverage_ratio: null,
  total_text_chars: null as unknown as number,
  segment_count: null as unknown as number,
  max_chars_per_frame: null as unknown as number,
  avg_chars_per_frame: null as unknown as number,
  caption_first_text_ms: null,
  caption_has_text_in_first_3s: null as unknown as boolean,
  caption_coverage_ratio: null,
  caption_total_chars: null as unknown as number,
};

async function replaceSegments(tx: Tx, analysisId: string, segments: readonly TextSegment[]): Promise<void> {
  await tx`delete from public.video_text_segments where analysis_id = ${analysisId}`;
  if (segments.length === 0) return;
  const rows = segments.map((s) => ({
    analysis_id: analysisId,
    seq: s.seq,
    text: s.text,
    text_norm: s.text_norm,
    start_ms: s.start_ms,
    end_ms: s.end_ms,
    vertical_position: s.vertical_position,
    center_x_ratio: s.center_x_ratio,
    center_y_ratio: s.center_y_ratio,
    char_height_ratio: s.char_height_ratio,
    confidence: s.confidence,
    frame_count: s.frame_count,
    lang: s.lang,
    is_caption_like: s.is_caption_like,
  }));
  await tx`insert into public.video_text_segments ${tx(
    rows,
    "analysis_id",
    "seq",
    "text",
    "text_norm",
    "start_ms",
    "end_ms",
    "vertical_position",
    "center_x_ratio",
    "center_y_ratio",
    "char_height_ratio",
    "confidence",
    "frame_count",
    "lang",
    "is_caption_like",
  )}`;
}

/**
 * 結果の書き込み (a)。`status`、`error`、`analyzed_at`、`ocr_frame_count`、`image_width`、`image_height`、
 * `segmenter_version`、特徴量を更新し、区間を入れ直す。`attempt_count` と `units_used` は触らない
 */
export async function finishVideoTextAttempt(
  tx: Tx,
  analysisId: string,
  input: FinishVideoTextAttemptInput,
  segments: readonly TextSegment[],
): Promise<void> {
  const f = input.features ?? NULL_FEATURES;
  await tx`
    update public.video_text_analyses set
      status = ${input.status},
      error = ${input.error},
      analyzed_at = ${input.analyzedAt},
      ocr_frame_count = ${input.ocrFrameCount},
      planned_frame_count = coalesce(${input.plannedFrameCount ?? null}::int, planned_frame_count),
      image_width = coalesce(${input.imageWidth}::int, image_width),
      image_height = coalesce(${input.imageHeight}::int, image_height),
      segmenter_version = ${input.segmenterVersion},
      first_text_ms = ${f.first_text_ms},
      has_text_in_first_3s = ${f.has_text_in_first_3s},
      text_coverage_ratio = ${f.text_coverage_ratio},
      total_text_chars = ${f.total_text_chars},
      segment_count = ${f.segment_count},
      max_chars_per_frame = ${f.max_chars_per_frame},
      avg_chars_per_frame = ${f.avg_chars_per_frame},
      caption_first_text_ms = ${f.caption_first_text_ms},
      caption_has_text_in_first_3s = ${f.caption_has_text_in_first_3s},
      caption_coverage_ratio = ${f.caption_coverage_ratio},
      caption_total_chars = ${f.caption_total_chars}
    where id = ${analysisId}
  `;
  await replaceSegments(tx, analysisId, segments);
}

/**
 * 再区間化 (b)。`segmenter_version`、特徴量、`analyzed_at` を更新し、区間を入れ直す。
 * `attempt_count`、`units_used`、`status`、`error` は触らない
 */
export async function resegmentVideoText(
  tx: Tx,
  analysisId: string,
  input: { segmenterVersion: string; analyzedAt: Date; features: TextFeatures },
  segments: readonly TextSegment[],
): Promise<void> {
  const f = input.features;
  await tx`
    update public.video_text_analyses set
      analyzed_at = ${input.analyzedAt},
      segmenter_version = ${input.segmenterVersion},
      first_text_ms = ${f.first_text_ms},
      has_text_in_first_3s = ${f.has_text_in_first_3s},
      text_coverage_ratio = ${f.text_coverage_ratio},
      total_text_chars = ${f.total_text_chars},
      segment_count = ${f.segment_count},
      max_chars_per_frame = ${f.max_chars_per_frame},
      avg_chars_per_frame = ${f.avg_chars_per_frame},
      caption_first_text_ms = ${f.caption_first_text_ms},
      caption_has_text_in_first_3s = ${f.caption_has_text_in_first_3s},
      caption_coverage_ratio = ${f.caption_coverage_ratio},
      caption_total_chars = ${f.caption_total_chars}
    where id = ${analysisId}
  `;
  await replaceSegments(tx, analysisId, segments);
}

/** UTC の暦月の範囲 `[start, end)`（設計 3.3 節） */
export function utcMonthRange(now: Date): { start: Date; end: Date } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1)) };
}

export interface MonthlyOcrUsage {
  /** 今月のユニットの合計（失敗した要求の分を含む） */
  units: number;
  /** 今月に要求を送った本（`count(distinct media_id)`。消えた投稿は入らない） */
  videos: number;
}

/** 今月（UTC）の利用。範囲で引く（`(account_id, requested_at)` の索引が効く） */
export async function monthlyOcrUsage(db: Db, accountId: string, now: Date): Promise<MonthlyOcrUsage> {
  const { start, end } = utcMonthRange(now);
  const rows = await db<{ units: number; videos: number }[]>`
    select coalesce(sum(units), 0)::int as units, count(distinct media_id)::int as videos
    from public.ocr_usage
    where account_id = ${accountId} and requested_at >= ${start} and requested_at < ${end}
  `;
  return { units: rows[0]?.units ?? 0, videos: rows[0]?.videos ?? 0 };
}

/** 解析の行（テストと実機確認用）。`numeric` は `number` に変換済み */
export interface VideoTextAnalysisSummary {
  id: string;
  status: VideoTextStatus;
  error: string | null;
  attempt_count: number;
  segmenter_version: string;
  video_analysis_id: string | null;
  duration_ms: number | null;
  image_width: number | null;
  image_height: number | null;
  planned_frame_count: number | null;
  ocr_frame_count: number;
  units_used: number;
  first_text_ms: number | null;
  has_text_in_first_3s: boolean | null;
  text_coverage_ratio: number | null;
  total_text_chars: number | null;
  segment_count: number | null;
  max_chars_per_frame: number | null;
  avg_chars_per_frame: number | null;
}

/** 今の OCR の条件の解析の行を 1 本分読む。なければ undefined */
export async function getVideoTextAnalysis(
  db: Db,
  mediaId: string,
  condition: { ocrMethod: string; ocrVersion: string; frameIntervalMs: number; analyzerVersion: string },
): Promise<VideoTextAnalysisSummary | undefined> {
  const rows = await db<(Omit<VideoTextAnalysisSummary, "text_coverage_ratio" | "avg_chars_per_frame"> & {
    text_coverage_ratio: string | null;
    avg_chars_per_frame: string | null;
  })[]>`
    select id, status, error, attempt_count, segmenter_version, video_analysis_id, duration_ms, image_width, image_height,
           planned_frame_count, ocr_frame_count, units_used, first_text_ms, has_text_in_first_3s, text_coverage_ratio,
           total_text_chars, segment_count, max_chars_per_frame, avg_chars_per_frame
    from public.video_text_analyses
    where media_id = ${mediaId} and ocr_method = ${condition.ocrMethod} and ocr_version = ${condition.ocrVersion}
      and frame_interval_ms = ${condition.frameIntervalMs} and analyzer_version = ${condition.analyzerVersion}
  `;
  const row = rows[0];
  if (!row) return undefined;
  return {
    ...row,
    text_coverage_ratio: row.text_coverage_ratio === null ? null : Number(row.text_coverage_ratio),
    avg_chars_per_frame: row.avg_chars_per_frame === null ? null : Number(row.avg_chars_per_frame),
  };
}
