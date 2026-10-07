/**
 * 動画 1 本の「解析 → 書き込み → 失敗の記録」（R4 設計 3.8 節）。`stories` と `video_analysis` が共通に使う。
 *
 * 共通にするのは `analyzeVideo` → `writeVideoAnalysis`（1 トランザクション）→ `failed` なら `recordFailure` だけ。
 * 対象の判定、ffmpeg の事前の確認、件数の数え上げ、`no_video_url` の `warn` の文言は各ジョブに残す。
 *
 * - ダウンロードと ffmpeg は `ctx.db.begin` の外で行い、行の書き込みだけを 1 トランザクションにする
 *   （`max: 2`。`framework.ts` の注意）
 * - `media_id` と URL はログにも `recordFailure` にも入れない。`error` 列は `analyzeVideo` の固定文言か `ctx.mask` 済み
 */
import { writeVideoAnalysis } from "../db/video.js";
import type { DownloadLimits } from "../lib/download.js";
import { DEFAULT_SCENE_THRESHOLD } from "../lib/ffmpeg.js";
import { analyzeVideo, type VideoAnalysisDeps } from "../lib/video-analysis.js";
import type { VideoAnalysisStatus } from "../db/types.js";
import type { JobContext } from "./framework.js";

/** 動画のダウンロードの上限（R1 設計 3.7 章、13.3 章） */
export const VIDEO_MAX_BYTES = 200 * 1024 * 1024;
/** 動画のダウンロードの制限時間（R1 設計 3.7 章） */
export const VIDEO_DOWNLOAD_TIMEOUT_MS = 60_000;
/** 動画解析が `failed` で `error` が null だったときの `recordFailure` の文言（通常は `error` に理由が入る） */
export const VIDEO_ANALYSIS_FAILED_ERROR = "動画の解析に失敗";

/** 動画のダウンロードの `DownloadLimits`。`allowedHosts` は `config.downloadAllowedHosts` */
export function videoDownloadLimits(allowedHosts: string[]): DownloadLimits {
  return { maxBytes: VIDEO_MAX_BYTES, timeoutMs: VIDEO_DOWNLOAD_TIMEOUT_MS, allowedHosts };
}

export interface AnalyzeAndStoreInput {
  /** `media.id` */
  mediaId: string;
  /** API の `media_url`。返らなかったときは undefined（`no_video_url` の行になる） */
  videoUrl: string | undefined;
}

export interface AnalyzeAndStoreResult {
  status: VideoAnalysisStatus;
  /** 書いた後の `attempt_count`（同じ条件で書いた回数） */
  attemptCount: number;
}

/**
 * 動画 1 本を解析して `video_analyses` と `video_cuts` に書き、`failed` なら `recordFailure` を 1 回呼ぶ。
 * 解析条件は今の条件（`ANALYZER_VERSION`、`DEFAULT_SCENE_THRESHOLD`）。書いた行の状態と `attempt_count` を返す。
 * `analyzeVideo` は例外を投げない。DB の書き込みの失敗は外に出す（枠組みが扱う）
 */
export async function analyzeAndStore(
  ctx: JobContext,
  input: AnalyzeAndStoreInput,
  deps: VideoAnalysisDeps = {},
): Promise<AnalyzeAndStoreResult> {
  const result = await analyzeVideo(
    {
      mediaId: input.mediaId,
      videoUrl: input.videoUrl,
      limits: videoDownloadLimits(ctx.config.downloadAllowedHosts),
      sceneThreshold: DEFAULT_SCENE_THRESHOLD,
      now: ctx.now,
      mask: ctx.mask,
    },
    deps,
  );
  const written = await ctx.db.begin((tx) => writeVideoAnalysis(tx, result.row, result.cuts));
  if (result.row.status === "failed") {
    ctx.recordFailure({
      errorClass: result.failureClass ?? "unknown",
      message: result.row.error ?? VIDEO_ANALYSIS_FAILED_ERROR,
    });
  }
  return { status: result.row.status, attemptCount: written.attempt_count };
}
