/**
 * リールとフィード動画の解析（`video_analysis`。R4 設計 3 章）。hourly グループの `media_snapshot` の後に動く。
 *
 * 流れ:
 * 1. ffmpeg の有無: 最初に 1 回だけ `toolVersion("ffprobe")` と `toolVersion("ffmpeg")` を呼ぶ。どちらかが失敗したら
 *    （spawn の ENOENT か終了コード。文面では判定しない）行を書かず、ダウンロードもせず、`recordFailure`（`unknown`、
 *    `NO_FFMPEG_ERROR`）を 1 回だけ記録して終わる。行を書かないので `attempt_count` は増えない（3.3 節）
 * 2. 対象: `listVideoAnalysisCandidates`（SQL 1 本。再試行と打ち切りの判定も SQL。3.1 節）。新しい順の全件
 * 3. 1 本ずつ: 本数の上限（`config.videoMaxPerRun`）と時間の予算（`config.videoBudgetMs`。ジョブの開始からの経過）を
 *    超えていたら新しい 1 本を始めない（途中では止めない。3.2 節）。残りは `skipped_by_limit`／`skipped_by_budget`
 * 4. `media_url` の取り直し（`GET /{media-id}?fields=id,media_type,media_url`。3.4 節）
 *    - `transient`（再試行を使い切った）: 行を書かず `recordFailure`（次の回に再び選ばれる）
 *    - `fatal`: `failed`（固定文言 `メディア情報の取得に失敗（code n）`）を書き、同じ文言で `recordFailure`
 *    - `media_type` が `VIDEO` でない: `failed`（`NOT_VIDEO_ERROR`）を書き、`recordFailure`（`fatal`）
 *    - それ以外: `analyzeAndStore`（`media_url` がなければ `no_video_url` で `warn` のみ）
 * 5. 書いた結果、`success` 以外で `attempt_count` が `VIDEO_MAX_ATTEMPTS` に達したら `warn` を 1 行（3.6 節）
 *
 * - `items_fetched` は `success` の本数（3.7 節）
 * - ログと `recordFailure` には `media_id` も URL も入れない（件数と固定文言だけ。公開ログに出るため）。
 *   API の `message` も入れない（`code` だけ）
 * - 生の応答は既定どおり保存する（`media_url` は `graph-client.ts` が消してから保存する）。`media_url` は
 *   `analyzeAndStore` に渡すだけで、ほかに残さない
 * - `RateLimitExceeded` と `AuthError` は捕まえず枠組みに任せる
 * - `export const job` のほかに、テストで ffmpeg の確認と `fetch`、`probe`、`detect` を差し替えるための
 *   `createVideoAnalysisJob` を出す
 */
import { listVideoAnalysisCandidates, writeVideoAnalysis } from "../db/video.js";
import { DEFAULT_SCENE_THRESHOLD, toolVersion } from "../lib/ffmpeg.js";
import {
  ANALYSIS_RETRY_AFTER_MS,
  ANALYZER_VERSION,
  failedAnalysisRow,
  type VideoAnalysisDeps,
} from "../lib/video-analysis.js";
import type { JobContext, JobDefinition } from "./framework.js";
import { isMediaId } from "./media-sync.js";
import { analyzeAndStore } from "./video-store.js";

/** 打ち切りの回数（R4 設計 3.6 節）。`success` 以外でこの回数に達した行は対象から外す */
export const VIDEO_MAX_ATTEMPTS = 5;
/** 取り直しの `fields`（R4 設計 3.4 節） */
export const VIDEO_MEDIA_FIELDS = "id,media_type,media_url";

/** ffmpeg か ffprobe がないときの `recordFailure` の文言 */
export const NO_FFMPEG_ERROR = "ffmpeg がない";
/** 取り直した `media_type` が `VIDEO` でないときの `error` 列と `recordFailure` の文言 */
export const NOT_VIDEO_ERROR = "動画ではない";
/** 候補の ID がメディア ID の形でないときの `recordFailure` の文言（DB の値なので通常は起きない） */
export const INVALID_MEDIA_ID_ERROR = "メディア ID の形が不正";
/** `media_url` が返らなかったときの `warn` の文言（失敗には数えない） */
export const NO_VIDEO_URL_WARNING = "動画に media_url が返らなかった（no_video_url を記録した）";
/** 打ち切りに達したときの `warn` の文言 */
export const GAVE_UP_WARNING = "解析の打ち切りの回数に達した（次の回から対象外）";

/** API の失敗の固定文言（`fatal` の `error` 列と、`transient`／`fatal` の `recordFailure`）。API の `message` は入れない */
export function mediaFetchFailedError(code: number | undefined): string {
  return `メディア情報の取得に失敗（code ${code ?? "なし"}）`;
}

/** テスト用の差し替え。`toolsAvailable` は ffmpeg と ffprobe の有無（省略時は `toolVersion` を呼ぶ） */
export interface VideoAnalysisJobDeps extends VideoAnalysisDeps {
  toolsAvailable?: () => Promise<boolean>;
}

/** `ffprobe` と `ffmpeg` の両方が起動でき、終了コード 0 で終わるか。例外の文面は見ない */
export async function ffmpegToolsAvailable(): Promise<boolean> {
  try {
    await toolVersion("ffprobe");
    await toolVersion("ffmpeg");
    return true;
  } catch {
    return false;
  }
}

/** 取り直しの応答の形（API の JSON なので型は確かめて使う） */
interface MediaVideoFields {
  id?: unknown;
  media_type?: unknown;
  media_url?: unknown;
}

/** 空文字と文字列以外は undefined にする */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** 解析せずに `failed` の行を書く（固定文言）。書いた後の `attempt_count` を返す */
async function writeFailed(ctx: JobContext, mediaId: string, error: string): Promise<number> {
  const row = failedAnalysisRow(mediaId, DEFAULT_SCENE_THRESHOLD, error, ctx.now());
  const written = await ctx.db.begin((tx) => writeVideoAnalysis(tx, row, []));
  return written.attempt_count;
}

/** `video_analysis` のジョブ定義を作る。`deps` はテスト用（省略時は本物の ffmpeg、ffprobe、`fetch`） */
export function createVideoAnalysisJob(deps: VideoAnalysisJobDeps = {}): JobDefinition {
  return {
    name: "video_analysis",
    run: async (ctx) => {
      // 1. ffmpeg の有無（最初に 1 回だけ）
      if (!(await (deps.toolsAvailable ?? ffmpegToolsAvailable)())) {
        ctx.recordFailure({ errorClass: "unknown", message: NO_FFMPEG_ERROR });
        return;
      }

      // 2. 対象
      const candidates = await listVideoAnalysisCandidates(ctx.db, {
        accountId: ctx.account.id,
        analyzerVersion: ANALYZER_VERSION,
        sceneThreshold: DEFAULT_SCENE_THRESHOLD,
        maxAttempts: VIDEO_MAX_ATTEMPTS,
        now: ctx.now(),
        retryAfterHours: ANALYSIS_RETRY_AFTER_MS / (60 * 60 * 1000),
      });

      let started = 0;
      let analyzed = 0;
      let noVideoUrl = 0;
      let failed = 0;
      let skippedByLimit = 0;
      let skippedByBudget = 0;

      for (const [index, candidate] of candidates.entries()) {
        // 3. 本数の上限と時間の予算（新しい 1 本を始める前にだけ見る）
        const remaining = candidates.length - index;
        if (started >= ctx.config.videoMaxPerRun) {
          skippedByLimit = remaining;
          break;
        }
        if (ctx.now().getTime() - ctx.startedAt.getTime() > ctx.config.videoBudgetMs) {
          skippedByBudget = remaining;
          break;
        }
        started += 1;
        ctx.log.debug({ job: "video_analysis", progress: `${index + 1}/${candidates.length}` });

        const mediaId = candidate.id;
        if (!isMediaId(mediaId)) {
          // DB の値なので通常は起きない。パスに入れない
          ctx.recordFailure({ errorClass: "fatal", message: INVALID_MEDIA_ID_ERROR });
          failed += 1;
          continue;
        }

        // 4. media_url の取り直し（RateLimitExceeded と AuthError は外へ出す）
        const res = await ctx.graph.get<MediaVideoFields>(mediaId, { fields: VIDEO_MEDIA_FIELDS });
        let status: "success" | "no_video_url" | "failed";
        let attemptCount: number;
        if (!res.ok || !res.data) {
          const code = res.error?.code;
          const message = mediaFetchFailedError(code);
          if (res.errorClass === "fatal") {
            attemptCount = await writeFailed(ctx, mediaId, message);
            ctx.recordFailure({ code, errorClass: "fatal", message });
            status = "failed";
          } else {
            // transient（再試行を使い切った）は行を書かない。次の回に再び選ばれる
            ctx.recordFailure({ code, errorClass: res.errorClass ?? "unknown", message });
            failed += 1;
            continue;
          }
        } else if (res.data.media_type !== "VIDEO") {
          attemptCount = await writeFailed(ctx, mediaId, NOT_VIDEO_ERROR);
          ctx.recordFailure({ errorClass: "fatal", message: NOT_VIDEO_ERROR });
          status = "failed";
        } else {
          // failed の recordFailure は analyzeAndStore の中で済んでいる
          const stored = await analyzeAndStore(ctx, { mediaId, videoUrl: nonEmptyString(res.data.media_url) }, deps);
          status = stored.status;
          attemptCount = stored.attemptCount;
        }

        if (status === "success") {
          analyzed += 1;
          ctx.progress.items += 1;
        } else if (status === "no_video_url") {
          noVideoUrl += 1;
          ctx.log.warn({ job: "video_analysis", error: NO_VIDEO_URL_WARNING });
        } else {
          failed += 1;
        }
        // 5. 打ち切りに達した回に 1 行だけ（次の回からは SQL が選ばない）
        if (status !== "success" && attemptCount >= VIDEO_MAX_ATTEMPTS) {
          ctx.log.warn({ job: "video_analysis", error: GAVE_UP_WARNING, attempts: attemptCount });
        }
      }

      ctx.log.info({
        job: "video_analysis",
        candidates: candidates.length,
        analyzed,
        no_video_url: noVideoUrl,
        failed,
        skipped_by_limit: skippedByLimit,
        skipped_by_budget: skippedByBudget,
      });
    },
  };
}

export const job: JobDefinition = createVideoAnalysisJob();
