/**
 * 動画の画面の文字（`video_text`。R4.1 設計 3 章）。hourly グループの `video_analysis` の次に動く。
 *
 * 流れ:
 * 1. 対象: `listVideoTextCandidates`（SQL 1 本。再試行 (a) と再区間化 (b) の判定も SQL。3.1 節）。新しい順の全件
 * 2. `WORKER_VIDEO_TEXT_MAX_PER_RUN = 0` なら候補を数えて `info` を出すだけで終わる（鍵と ffmpeg の確認もしない）
 * 3. 鍵（`config.visionKey`）と ffmpeg の有無。どちらかがなければ行を書かず `recordFailure` を 1 回だけ記録して終わる
 * 4. 1 本ずつ: 時間の予算 → (b) なら API を呼ばず区間化だけ → 本数の上限 → 計画（長さとカットから）→ 1 回と月の
 *    ユニットの上限 → （最初の本なら）トークン → 取り掛かりの記録（`failed`、`attempt_count + 1`）→ `media_url` の
 *    取り直し → ダウンロード → 取り出し → 要求ごとに送って保存 → 区間化 → 結果の書き込み（3.6 節）
 * 5. 失敗の分類は 3.6 節の表。`auth`／`rate`／`db` の失敗と 2 本続けての `transient` でこの回を終える
 *
 * - `items_fetched` は `success` の本数（(b) は数えない）
 * - ログと `recordFailure` には `media_id`、URL、鍵、トークン、読み取った文字を入れない（件数、固定文言、HTTP の status だけ）
 * - `RateLimitExceeded` と `AuthError`（Graph API）は捕まえず枠組みに任せる
 * - `export const job` のほかに、テストで `fetch`、ffmpeg、再送の待ちを差し替えるための `createVideoTextJob` を出す
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginVideoTextAttempt,
  deleteFramesNotPlanned,
  finishVideoTextAttempt,
  listCutsForAnalysis,
  listStoredFrames,
  listVideoTextCandidates,
  monthlyOcrUsage,
  resegmentVideoText,
  writeOcrRequest,
  type FrameUpsert,
  type VideoTextCandidate,
  type VideoTextStatus,
} from "../db/video-text.js";
import { DownloadError, downloadToFile } from "../lib/download.js";
import { CommandError, DEFAULT_SCENE_THRESHOLD, extractFrame } from "../lib/ffmpeg.js";
import { ANALYZER_VERSION, TEMP_DIR_ERROR, VIDEO_CONTENT_TYPE_PREFIX } from "../lib/video-analysis.js";
import {
  FRAME_EXTRACT_TIMEOUT_MS,
  FRAME_INTERVAL_MS,
  frameTimes,
  OCR_METHOD,
  OCR_VERSION,
  SEGMENTER_VERSION,
  segmentFrames,
  summarizeSegments,
  TEXT_ANALYZER_VERSION,
  VIDEO_TEXT_EXTRACT_BUDGET_MS,
  VIDEO_TEXT_MAX_ATTEMPTS,
  VIDEO_TEXT_MAX_DURATION_MS,
  VIDEO_TEXT_RETRY_AFTER_MS,
  type OcrFrame,
  type PlannedFrame,
} from "../lib/video-text.js";
import { createVisionClient, splitRequests, unitsFor, VisionError, type VisionClient } from "../lib/vision-client.js";
import { TMP_DIR_PREFIX, type ItemFailureClass, type JobContext, type JobDefinition } from "./framework.js";
import { isMediaId } from "./media-sync.js";
import {
  ffmpegToolsAvailable,
  INVALID_MEDIA_ID_ERROR,
  mediaFetchFailedError,
  NO_FFMPEG_ERROR,
  NO_VIDEO_URL_WARNING,
  NOT_VIDEO_ERROR,
  VIDEO_MEDIA_FIELDS,
} from "./video-analysis.js";
import { videoDownloadLimits } from "./video-store.js";

/** 鍵がないときの `recordFailure` の文言 */
export const NO_VISION_KEY_ERROR = "Vision の鍵がない";
/** 鍵の形が不正なときの `recordFailure` の文言 */
export const INVALID_VISION_KEY_ERROR = "Vision の鍵の形が不正";
/** 出力ファイルがない・空のときの `error` 列の文言 */
export const FRAME_EXTRACT_ERROR = "フレームを取り出せない";
/** 1 枚の取り出しが制限時間を超えたときの `error` 列の文言 */
export const FRAME_EXTRACT_TIMEOUT_ERROR = "フレームの取り出しが制限時間を超えた";
/** 1 本の取り出し全体が制限を超えたときの `error` 列の文言 */
export const FRAME_EXTRACT_TOO_LONG_ERROR = "フレームの取り出しが長すぎる";
/** 1 枚で本文の上限を超えるフレームがあったときの `error` 列の文言 */
export const IMAGE_TOO_LARGE_ERROR = "画像が大きすぎる";
/** `ocr_usage` の書き込みに失敗したときの `error` 列の文言 */
export const USAGE_WRITE_ERROR = "利用記録を書けない";
/** 1 枚ごとの `error` があったときの `error` 列の文言 */
export function unreadableFramesError(count: number): string {
  return `読めないフレームがある（${count} 枚）`;
}
/** ffmpeg が終了コードで失敗したときの `error` 列の文言（stderr は入れない） */
export function ffmpegFailedError(code: number | null): string {
  return `ffmpeg が終了コード ${code ?? "なし"} で失敗`;
}
/** 1 本の枚数だけで 1 回の上限を超えるときの `warn` の文言 */
export const UNIT_LIMIT_WARNING = "1 回の上限より枚数が多い";
/** 月の上限に達したときの `warn` の文言 */
export const MONTHLY_CAP_WARNING = "月の上限に達した";
/** 再試行の計画の元のカットが消えていたときの `warn` の文言 */
export const CUTS_MISSING_WARNING = "再試行の計画の元のカットが消えているので今の条件で作り直した";
/** 打ち切りに達したときの `warn` の文言 */
export const TEXT_GAVE_UP_WARNING = "文字の解析の打ち切りの回数に達した（次の回から対象外）";
/** `transient` の失敗が続いたらこの回を終える本数 */
export const CONSECUTIVE_TRANSIENT_LIMIT = 2;

/** テスト用の差し替え（省略時は本物の `fetch`、ffmpeg、`os.tmpdir()`、実際の待ち） */
export interface VideoTextJobDeps {
  /** CDN（動画）と Google（トークン、`images:annotate`）に使う。Graph API は `ctx.graph` */
  fetchImpl?: typeof fetch;
  toolsAvailable?: () => Promise<boolean>;
  extractFrame?: typeof extractFrame;
  sleep?: (ms: number) => Promise<void>;
  tmpRoot?: string;
}

/** 取り直しの応答の形（API の JSON なので型は確かめて使う） */
interface MediaVideoFields {
  id?: unknown;
  media_type?: unknown;
  media_url?: unknown;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** `ocr_usage` の書き込みの失敗（`annotate` の `onAttempt` から外へ出す） */
class UsageWriteError extends Error {
  override readonly name = "UsageWriteError";
}

interface Failure {
  errorClass: ItemFailureClass;
  message: string;
  code?: number;
}

/** 1 本の結果。`left` は行を取り掛かりの記録のまま残した（次の回に再び選ばれる） */
interface ProcessResult {
  status: VideoTextStatus | "left";
  failure?: Failure;
  /** この回を終える */
  stop: boolean;
  /** `transient` の失敗（2 本続けたら終える） */
  transient: boolean;
}

interface Plan {
  frames: PlannedFrame[];
  videoAnalysisId: string;
  durationMs: number;
  /** 再試行の計画の元のカットが消えていて今の条件で作り直した */
  rebuilt: boolean;
}

interface Counters {
  processed: number;
  resegmented: number;
  noVideoUrl: number;
  failed: number;
  requests: number;
  /** この回に記録したユニット（再送の分を含む） */
  units: number;
  skippedByLimit: number;
  skippedByBudget: number;
  skippedByUnitLimit: number;
  skippedByMonthlyCap: number;
}

/** 計画（設計 3.4 節「計画の安定」）。再試行は文字の行に残したカットの解析から作り、消えていれば今の条件で作り直す */
async function planFrames(ctx: JobContext, candidate: VideoTextCandidate): Promise<Plan> {
  if (candidate.text_analysis_id !== null && candidate.stored_video_analysis_id !== null && candidate.stored_duration_ms !== null) {
    const cuts = await listCutsForAnalysis(ctx.db, candidate.stored_video_analysis_id);
    if (cuts) {
      return {
        frames: frameTimes(candidate.stored_duration_ms, cuts),
        videoAnalysisId: candidate.stored_video_analysis_id,
        durationMs: candidate.stored_duration_ms,
        rebuilt: false,
      };
    }
  }
  const cuts = (await listCutsForAnalysis(ctx.db, candidate.video_analysis_id)) ?? [];
  return {
    frames: frameTimes(candidate.duration_ms, cuts),
    videoAnalysisId: candidate.video_analysis_id,
    durationMs: candidate.duration_ms,
    rebuilt: candidate.text_analysis_id !== null,
  };
}

/** 再区間化 (b)。保存したフレームの集合をそのまま計画にし、API を呼ばずに特徴量と区間を計算し直す */
async function resegment(ctx: JobContext, candidate: VideoTextCandidate, analysisId: string): Promise<void> {
  const stored = await listStoredFrames(ctx.db, analysisId);
  const frames: OcrFrame[] = stored.filter((f) => f.error_code === null).map((f) => ({ atMs: f.at_ms, words: f.words ?? [] }));
  const durationMs = candidate.stored_duration_ms ?? candidate.duration_ms;
  const segments = segmentFrames(frames, {
    durationMs,
    imageWidth: candidate.stored_image_width ?? 0,
    imageHeight: candidate.stored_image_height ?? 0,
  });
  const features = summarizeSegments(segments, frames, durationMs);
  await ctx.db.begin((tx) =>
    resegmentVideoText(tx, analysisId, { segmenterVersion: SEGMENTER_VERSION, analyzedAt: ctx.now(), features }, segments),
  );
}

interface SendInput {
  mediaId: string;
  analysisId: string;
  videoUrl: string;
  needed: PlannedFrame[];
  durationMs: number;
  client: VisionClient;
  counters: Counters;
  budgetExceeded: () => boolean;
}

interface SendResult {
  failure?: Failure & { stop?: boolean; left?: boolean; transient?: boolean };
  imageWidth: number | null;
  imageHeight: number | null;
  /**
   * 動画の末尾（最後の間隔の中）で復号するフレームがなく取り出せなかった時刻。計画から外す（設計 3.4 節の
   * 「最後の時刻は復号するフレームがなく出力が空になりうる」。コンテナの長さより映像が短い動画で起きる。
   * 手元の ffmpeg（2025 年の開発版）は出力が空だと終了コード 0 にならないので、終了コードでなく時刻で判定する）
   */
  droppedAtMs: number[];
}

/** 例外から `error` 列の文言を作る。`DownloadError` と `CommandError` は固定文言、それ以外は `mask` 済みの文面 */
function describeError(ctx: JobContext, error: unknown, timeoutMessage: string): { errorClass: ItemFailureClass; message: string } {
  if (error instanceof DownloadError) return { errorClass: "download", message: error.message };
  if (error instanceof CommandError) {
    return { errorClass: "unknown", message: error.code === null ? timeoutMessage : ffmpegFailedError(error.code) };
  }
  const message = error instanceof Error ? error.message : "不明なエラー";
  return { errorClass: "unknown", message: ctx.mask(message) };
}

/** ダウンロード → 取り出し → 要求ごとに送って保存（設計 3.6 節 4〜5）。一時ディレクトリは `finally` で消す */
async function downloadExtractAndSend(ctx: JobContext, deps: VideoTextJobDeps, input: SendInput): Promise<SendResult> {
  let dir: string | undefined;
  let imageWidth: number | null = null;
  let imageHeight: number | null = null;
  const droppedAtMs: number[] = [];
  /** 末尾の間隔の中の時刻か（取り出せなければ計画から外してよい） */
  const isTail = (frame: PlannedFrame): boolean => frame.atMs + FRAME_INTERVAL_MS >= input.durationMs;
  try {
    try {
      dir = await mkdtemp(join(deps.tmpRoot ?? tmpdir(), `${TMP_DIR_PREFIX}text-`));
    } catch {
      return { failure: { errorClass: "unknown", message: TEMP_DIR_ERROR }, imageWidth, imageHeight, droppedAtMs };
    }
    const videoPath = join(dir, "video.mp4");
    try {
      await downloadToFile(
        input.videoUrl,
        videoPath,
        { ...videoDownloadLimits(ctx.config.downloadAllowedHosts), contentTypePrefix: VIDEO_CONTENT_TYPE_PREFIX },
        deps.fetchImpl,
      );
    } catch (error) {
      return { failure: describeError(ctx, error, FRAME_EXTRACT_TIMEOUT_ERROR), imageWidth, imageHeight, droppedAtMs };
    }

    // 取り出し（1 枚ずつ。1 枚 15 秒、全体 3 分）
    const extract = deps.extractFrame ?? extractFrame;
    const extractStartedAt = ctx.now().getTime();
    const images: { frame: PlannedFrame; bytes: Buffer; byteLength: number }[] = [];
    for (const frame of input.needed) {
      if (ctx.now().getTime() - extractStartedAt > VIDEO_TEXT_EXTRACT_BUDGET_MS) {
        return { failure: { errorClass: "unknown", message: FRAME_EXTRACT_TOO_LONG_ERROR }, imageWidth, imageHeight, droppedAtMs };
      }
      const output = join(dir, `frame-${frame.atMs}.jpg`);
      try {
        await extract(videoPath, frame.atMs, output, FRAME_EXTRACT_TIMEOUT_MS);
      } catch (error) {
        // 末尾の時刻で終了コードの失敗（制限時間ではない）なら、復号するフレームがないとみなして計画から外す
        if (error instanceof CommandError && error.code !== null && isTail(frame)) {
          droppedAtMs.push(frame.atMs);
          continue;
        }
        return { failure: describeError(ctx, error, FRAME_EXTRACT_TIMEOUT_ERROR), imageWidth, imageHeight, droppedAtMs };
      }
      let bytes: Buffer | undefined;
      try {
        bytes = await readFile(output);
      } catch {
        bytes = undefined;
      }
      if (bytes === undefined || bytes.length === 0) {
        if (isTail(frame)) {
          droppedAtMs.push(frame.atMs);
          continue;
        }
        return { failure: { errorClass: "unknown", message: FRAME_EXTRACT_ERROR }, imageWidth, imageHeight, droppedAtMs };
      }
      images.push({ frame, bytes, byteLength: bytes.length });
    }

    // 送信（要求ごとに 1 トランザクションで保存）
    const { batches, tooLarge } = splitRequests(images);
    for (const batch of batches) {
      let attempt;
      try {
        attempt = await input.client.annotate(
          batch.map((b) => b.bytes),
          {
            canRetry: () => !input.budgetExceeded(),
            onAttempt: async (a) => {
              const units = unitsFor(a.httpStatus, a.imageCount);
              const fetchedAt = ctx.now();
              const frames: FrameUpsert[] = a.ok
                ? (a.frames ?? []).map((parsed, i) => {
                    const planned = batch[i]?.frame ?? { atMs: 0, source: "interval" as const };
                    if (parsed.ok) {
                      if (imageWidth === null && parsed.width !== null && parsed.height !== null) {
                        imageWidth = parsed.width;
                        imageHeight = parsed.height;
                      }
                      return {
                        at_ms: planned.atMs,
                        source: planned.source,
                        text: parsed.text,
                        words: parsed.words,
                        word_count: parsed.wordCount,
                        error_code: null,
                        fetched_at: fetchedAt,
                      };
                    }
                    return {
                      at_ms: planned.atMs,
                      source: planned.source,
                      text: null,
                      words: null,
                      word_count: null,
                      error_code: parsed.errorCode,
                      fetched_at: fetchedAt,
                    };
                  })
                : [];
              try {
                await ctx.db.begin((tx) =>
                  writeOcrRequest(
                    tx,
                    {
                      account_id: ctx.account.id,
                      media_id: input.mediaId,
                      analysis_id: input.analysisId,
                      job_run_id: ctx.jobRunId,
                      ocr_method: OCR_METHOD,
                      ocr_version: OCR_VERSION,
                      requested_at: fetchedAt,
                      elapsed_ms: a.elapsedMs,
                      image_count: a.imageCount,
                      units,
                      request_bytes: a.requestBytes,
                      response_bytes: a.responseBytes,
                      word_count: a.wordCount,
                      http_status: a.httpStatus ?? null,
                      ok: a.ok,
                    },
                    frames,
                  ),
                );
              } catch {
                throw new UsageWriteError(USAGE_WRITE_ERROR);
              }
              // ログの requests と units は「この回に記録した」数（設計 3.7 節）。記録できなかった要求は数えない
              input.counters.requests += 1;
              input.counters.units += units;
            },
          },
        );
      } catch (error) {
        if (error instanceof UsageWriteError) {
          return { failure: { errorClass: "db", message: USAGE_WRITE_ERROR, stop: true }, imageWidth, imageHeight, droppedAtMs };
        }
        if (error instanceof VisionError) {
          // トークンの取り直しの失敗（auth はこの回を終える。行は取り掛かりの記録のまま）
          if (error.kind === "auth") {
            return { failure: { errorClass: "auth", message: error.message, stop: true, left: true }, imageWidth, imageHeight, droppedAtMs };
          }
          return { failure: { errorClass: "transient", message: error.message, transient: true }, imageWidth, imageHeight, droppedAtMs };
        }
        throw error;
      }
      if (!attempt.ok) {
        const kind = attempt.error?.kind ?? "transient";
        const message = attempt.error?.message ?? "";
        const code = attempt.httpStatus;
        if (kind === "auth") return { failure: { errorClass: "auth", message, code, stop: true, left: true }, imageWidth, imageHeight, droppedAtMs };
        if (kind === "rate") return { failure: { errorClass: "rate", message, code, stop: true, left: true }, imageWidth, imageHeight, droppedAtMs };
        if (kind === "fatal") return { failure: { errorClass: "fatal", message, code }, imageWidth, imageHeight, droppedAtMs };
        return { failure: { errorClass: "transient", message, code, transient: true }, imageWidth, imageHeight, droppedAtMs };
      }
    }
    if (tooLarge.length > 0) {
      return { failure: { errorClass: "unknown", message: IMAGE_TOO_LARGE_ERROR }, imageWidth, imageHeight, droppedAtMs };
    }
    return { imageWidth, imageHeight, droppedAtMs };
  } finally {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

interface ProcessInput {
  candidate: VideoTextCandidate;
  analysisId: string;
  plan: Plan;
  needed: PlannedFrame[];
  client: VisionClient;
  counters: Counters;
  budgetExceeded: () => boolean;
}

/** 1 本の処理（取り掛かりの記録の後）。結果の書き込みまで行う */
async function processVideo(ctx: JobContext, deps: VideoTextJobDeps, input: ProcessInput): Promise<ProcessResult> {
  const { candidate, analysisId } = input;
  let plan = input.plan;
  const mediaId = candidate.id;
  let imageWidth: number | null = candidate.stored_image_width;
  let imageHeight: number | null = candidate.stored_image_height;

  const finishFailed = async (message: string): Promise<void> => {
    await ctx.db.begin((tx) =>
      finishVideoTextAttempt(
        tx,
        analysisId,
        {
          status: "failed",
          error: message,
          analyzedAt: ctx.now(),
          ocrFrameCount: 0,
          imageWidth,
          imageHeight,
          segmenterVersion: SEGMENTER_VERSION,
          features: null,
        },
        [],
      ),
    );
  };

  if (input.needed.length > 0) {
    // media_url の取り直し（RateLimitExceeded と AuthError は外へ出す）
    const res = await ctx.graph.get<MediaVideoFields>(mediaId, { fields: VIDEO_MEDIA_FIELDS });
    if (!res.ok || !res.data) {
      const code = res.error?.code;
      const message = mediaFetchFailedError(code);
      if (res.errorClass === "fatal") {
        await finishFailed(message);
        return { status: "failed", failure: { code, errorClass: "fatal", message }, stop: false, transient: false };
      }
      // transient（再試行を使い切った）は行を取り掛かりの記録のまま残す（次の回に再び選ばれる）
      return { status: "left", failure: { code, errorClass: res.errorClass ?? "unknown", message }, stop: false, transient: false };
    }
    if (res.data.media_type !== "VIDEO") {
      await finishFailed(NOT_VIDEO_ERROR);
      return { status: "failed", failure: { errorClass: "fatal", message: NOT_VIDEO_ERROR }, stop: false, transient: false };
    }
    const videoUrl = nonEmptyString(res.data.media_url);
    if (!videoUrl) {
      await ctx.db.begin((tx) =>
        finishVideoTextAttempt(
          tx,
          analysisId,
          {
            status: "no_video_url",
            error: null,
            analyzedAt: ctx.now(),
            ocrFrameCount: 0,
            imageWidth,
            imageHeight,
            segmenterVersion: SEGMENTER_VERSION,
            features: null,
          },
          [],
        ),
      );
      return { status: "no_video_url", stop: false, transient: false };
    }

    const sent = await downloadExtractAndSend(ctx, deps, {
      mediaId,
      analysisId,
      videoUrl,
      needed: input.needed,
      durationMs: plan.durationMs,
      client: input.client,
      counters: input.counters,
      budgetExceeded: input.budgetExceeded,
    });
    imageWidth = sent.imageWidth ?? imageWidth;
    imageHeight = sent.imageHeight ?? imageHeight;
    if (sent.droppedAtMs.length > 0) {
      const dropped = new Set(sent.droppedAtMs);
      plan = { ...plan, frames: plan.frames.filter((f) => !dropped.has(f.atMs)) };
      ctx.log.debug({ job: "video_text", dropped_tail_frames: sent.droppedAtMs.length });
    }
    if (sent.failure) {
      const { stop, left, transient, ...failure } = sent.failure;
      if (left) return { status: "left", failure, stop: stop ?? false, transient: false };
      await finishFailed(failure.message);
      return { status: "failed", failure, stop: stop ?? false, transient: transient ?? false };
    }
  }

  // 区間化と特徴量（保存したフレームのうち計画のもの）
  const stored = await listStoredFrames(ctx.db, analysisId);
  const planned = new Map(plan.frames.map((f) => [f.atMs, f]));
  const okFrames = new Map(stored.filter((f) => f.error_code === null && planned.has(f.at_ms)).map((f) => [f.at_ms, f]));
  const missing = plan.frames.length - okFrames.size;
  if (missing > 0) {
    const message = unreadableFramesError(missing);
    await ctx.db.begin((tx) =>
      finishVideoTextAttempt(
        tx,
        analysisId,
        {
          status: "failed",
          error: message,
          analyzedAt: ctx.now(),
          ocrFrameCount: okFrames.size,
          plannedFrameCount: plan.frames.length,
          imageWidth,
          imageHeight,
          segmenterVersion: SEGMENTER_VERSION,
          features: null,
        },
        [],
      ),
    );
    return { status: "failed", failure: { errorClass: "unknown", message }, stop: false, transient: false };
  }
  const frames: OcrFrame[] = plan.frames.map((f) => ({ atMs: f.atMs, words: okFrames.get(f.atMs)?.words ?? [] }));
  const segments = segmentFrames(frames, { durationMs: plan.durationMs, imageWidth: imageWidth ?? 0, imageHeight: imageHeight ?? 0 });
  const features = summarizeSegments(segments, frames, plan.durationMs);
  await ctx.db.begin((tx) =>
    finishVideoTextAttempt(
      tx,
      analysisId,
      {
        status: "success",
        error: null,
        analyzedAt: ctx.now(),
        ocrFrameCount: okFrames.size,
        plannedFrameCount: plan.frames.length,
        imageWidth,
        imageHeight,
        segmenterVersion: SEGMENTER_VERSION,
        features,
      },
      segments,
    ),
  );
  return { status: "success", stop: false, transient: false };
}

/** `video_text` のジョブ定義を作る。`deps` はテスト用（省略時は本物の ffmpeg、`fetch`、実際の待ち） */
export function createVideoTextJob(deps: VideoTextJobDeps = {}): JobDefinition {
  return {
    name: "video_text",
    run: async (ctx) => {
      const config = ctx.config;
      const counters: Counters = {
        processed: 0,
        resegmented: 0,
        noVideoUrl: 0,
        failed: 0,
        requests: 0,
        units: 0,
        skippedByLimit: 0,
        skippedByBudget: 0,
        skippedByUnitLimit: 0,
        skippedByMonthlyCap: 0,
      };
      const candidates = await listVideoTextCandidates(ctx.db, {
        accountId: ctx.account.id,
        analyzerVersion: ANALYZER_VERSION,
        sceneThreshold: DEFAULT_SCENE_THRESHOLD,
        ocrMethod: OCR_METHOD,
        ocrVersion: OCR_VERSION,
        frameIntervalMs: FRAME_INTERVAL_MS,
        textAnalyzerVersion: TEXT_ANALYZER_VERSION,
        segmenterVersion: SEGMENTER_VERSION,
        maxDurationMs: VIDEO_TEXT_MAX_DURATION_MS,
        maxAttempts: VIDEO_TEXT_MAX_ATTEMPTS,
        now: ctx.now(),
        retryAfterHours: VIDEO_TEXT_RETRY_AFTER_MS / (60 * 60 * 1000),
      });
      const summarize = async (): Promise<void> => {
        const month = await monthlyOcrUsage(ctx.db, ctx.account.id, ctx.now());
        ctx.log.info({
          job: "video_text",
          candidates: candidates.length,
          processed: counters.processed,
          resegmented: counters.resegmented,
          no_video_url: counters.noVideoUrl,
          failed: counters.failed,
          requests: counters.requests,
          units: counters.units,
          month_units: month.units,
          skipped_by_limit: counters.skippedByLimit,
          skipped_by_budget: counters.skippedByBudget,
          skipped_by_unit_limit: counters.skippedByUnitLimit,
          skipped_by_monthly_cap: counters.skippedByMonthlyCap,
        });
      };

      // 2. 本数 0 なら数えるだけ
      if (config.videoTextMaxPerRun === 0) {
        await summarize();
        return;
      }
      // 3. 鍵と ffmpeg
      if (!config.visionKey.ok) {
        ctx.recordFailure({
          errorClass: "unknown",
          message: config.visionKey.reason === "missing" ? NO_VISION_KEY_ERROR : INVALID_VISION_KEY_ERROR,
        });
        await summarize();
        return;
      }
      if (!(await (deps.toolsAvailable ?? ffmpegToolsAvailable)())) {
        ctx.recordFailure({ errorClass: "unknown", message: NO_FFMPEG_ERROR });
        await summarize();
        return;
      }
      const client = createVisionClient(config.visionKey.key, {
        fetch: deps.fetchImpl,
        now: ctx.now,
        sleep: deps.sleep,
        onToken: (token) => ctx.addSecret(token),
      });
      const budgetExceeded = (): boolean => ctx.now().getTime() - ctx.startedAt.getTime() > config.videoTextBudgetMs;

      let tokenReady = false;
      let started = 0;
      /** 1 回の上限の判定に使う枚数（再送の分を含めない） */
      let plannedUnits = 0;
      let unitLimitReached = false;
      let monthlyCapReached = false;
      let consecutiveTransient = 0;

      for (const [index, candidate] of candidates.entries()) {
        if (budgetExceeded()) {
          counters.skippedByBudget = candidates.length - index;
          break;
        }
        ctx.log.debug({ job: "video_text", progress: `${index + 1}/${candidates.length}` });

        // (b) 再区間化: ユニットを使わず、本数にも数えない
        if (candidate.text_status === "success" && candidate.text_analysis_id !== null) {
          await resegment(ctx, candidate, candidate.text_analysis_id);
          counters.resegmented += 1;
          continue;
        }
        if (!isMediaId(candidate.id)) {
          ctx.recordFailure({ errorClass: "fatal", message: INVALID_MEDIA_ID_ERROR });
          counters.failed += 1;
          continue;
        }
        if (started >= config.videoTextMaxPerRun) {
          counters.skippedByLimit += 1;
          continue;
        }
        if (unitLimitReached) {
          counters.skippedByUnitLimit += 1;
          continue;
        }
        if (monthlyCapReached) {
          counters.skippedByMonthlyCap += 1;
          continue;
        }

        // 計画と必要なフレーム（計画 − 保存済み）
        const plan = await planFrames(ctx, candidate);
        const stored = candidate.text_analysis_id === null ? [] : await listStoredFrames(ctx.db, candidate.text_analysis_id);
        const storedOk = new Set(stored.filter((f) => f.error_code === null).map((f) => f.at_ms));
        const needed = plan.frames.filter((f) => !storedOk.has(f.atMs));

        if (needed.length > 0) {
          // 1 回の上限（この本だけで超える本は飛ばして次へ。累計で超えるなら残りも始めない）
          if (needed.length > config.videoTextMaxUnitsPerRun) {
            ctx.log.warn({ job: "video_text", error: UNIT_LIMIT_WARNING, frames: needed.length, limit: config.videoTextMaxUnitsPerRun });
            counters.skippedByUnitLimit += 1;
            continue;
          }
          if (plannedUnits + needed.length > config.videoTextMaxUnitsPerRun) {
            unitLimitReached = true;
            counters.skippedByUnitLimit += 1;
            continue;
          }
          // 月の上限
          const month = await monthlyOcrUsage(ctx.db, ctx.account.id, ctx.now());
          if (month.units + needed.length > config.videoTextMonthlyUnitLimit || month.videos >= config.videoTextMonthlyMaxVideos) {
            ctx.log.warn({ job: "video_text", error: MONTHLY_CAP_WARNING, month_units: month.units, month_videos: month.videos });
            monthlyCapReached = true;
            counters.skippedByMonthlyCap += 1;
            continue;
          }
          // トークン（最初の本のダウンロードの前。失敗したらダウンロードせずこの回を終える）
          if (!tokenReady) {
            try {
              await client.ensureToken();
              tokenReady = true;
            } catch (error) {
              const kind = error instanceof VisionError ? error.kind : "transient";
              const message = error instanceof VisionError ? error.message : "Vision の要求に失敗（status なし）";
              ctx.recordFailure({
                errorClass: kind === "auth" ? "auth" : "transient",
                message,
                code: error instanceof VisionError ? error.status : undefined,
              });
              break;
            }
          }
          started += 1;
          plannedUnits += needed.length;
        }
        if (plan.rebuilt) ctx.log.warn({ job: "video_text", error: CUTS_MISSING_WARNING });

        // 取り掛かりの記録（途中で落ちても failed と attempt_count が残る）
        const begun = await ctx.db.begin(async (tx) => {
          const row = await beginVideoTextAttempt(tx, {
            mediaId: candidate.id,
            ocrMethod: OCR_METHOD,
            ocrVersion: OCR_VERSION,
            frameIntervalMs: FRAME_INTERVAL_MS,
            analyzerVersion: TEXT_ANALYZER_VERSION,
            segmenterVersion: SEGMENTER_VERSION,
            videoAnalysisId: plan.videoAnalysisId,
            durationMs: plan.durationMs,
            plannedFrameCount: plan.frames.length,
            analyzedAt: ctx.now(),
          });
          await deleteFramesNotPlanned(
            tx,
            row.id,
            plan.frames.map((f) => f.atMs),
          );
          return row;
        });

        const result = await processVideo(ctx, deps, {
          candidate,
          analysisId: begun.id,
          plan,
          needed,
          client,
          counters,
          budgetExceeded,
        });

        if (result.status === "success") {
          counters.processed += 1;
          ctx.progress.items += 1;
          consecutiveTransient = 0;
        } else if (result.status === "no_video_url") {
          counters.noVideoUrl += 1;
          ctx.log.warn({ job: "video_text", error: NO_VIDEO_URL_WARNING });
          consecutiveTransient = 0;
        } else {
          counters.failed += 1;
          if (result.failure) ctx.recordFailure(result.failure);
          consecutiveTransient = result.transient ? consecutiveTransient + 1 : 0;
        }
        // 打ち切りに達した回に 1 行だけ（次の回からは SQL が選ばない）
        if (result.status !== "success" && begun.attempt_count >= VIDEO_TEXT_MAX_ATTEMPTS) {
          ctx.log.warn({ job: "video_text", error: TEXT_GAVE_UP_WARNING, attempts: begun.attempt_count });
        }
        if (result.stop || consecutiveTransient >= CONSECUTIVE_TRANSIENT_LIMIT) break;
      }

      await summarize();
    },
  };
}

export const job: JobDefinition = createVideoTextJob();
