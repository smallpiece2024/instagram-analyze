/**
 * 動画の解析（設計 5.6 章「動画の解析」、9.1 章、13.3 章）。
 * ダウンロード → ffprobe → シーン検出 → 特徴量 → `video_analyses` と `video_cuts` に書く形の行、までを行う。
 * DB には書かない（書くのは `db/video.ts` の `upsertVideoAnalysis`。呼び出し側が 1 トランザクションで入れる）。
 *
 * - `analyzeVideo` は例外を投げない。失敗は `status = 'failed'` の行として返す
 * - `error` 列に入れる文字列は、`DownloadError` の固定文言か、呼び出し側が渡す `mask` を通した文字列だけ。
 *   URL は `DownloadError.message` に含まれない（`lib/download.ts`）
 * - 動画ファイルは一時ディレクトリ（`mkdtemp`、接頭辞 `TMP_DIR_PREFIX + 'video-'`）に置き、`finally` で必ず消す
 *   （F-COL-23、NF-CAP-03。動画のコンテンツは残さない）
 * - ffmpeg を呼ぶ `probeVideo` と `detectSceneChanges` は `deps` で差し替えられる（ホストに ffmpeg がない単体テスト用。
 *   実際の ffmpeg はコンテナで確かめる）
 * - R1 ではストーリーズの動画を解析する。R4 でリールを解析するときも同じ関数を使う
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VideoAnalysisStatus } from "../db/types.js";
import type { VideoAnalysisInsert, VideoCutInsert } from "../db/video.js";
import { TMP_DIR_PREFIX } from "../jobs/framework.js";
import { DownloadError, downloadToFile, type DownloadLimits } from "./download.js";
import { CommandError, DEFAULT_SCENE_THRESHOLD, detectSceneChanges, probeVideo } from "./ffmpeg.js";

/**
 * 解析プログラムの版（`video_analyses.analyzer_version`）。シーン検出の方法（フィルタ、特徴量の定義）を変えたら上げる
 * （F-VID-04）。しきい値の変更は `scene_threshold` の列で区別されるので、版は上げない
 */
export const ANALYZER_VERSION = "1";

/** `failed` と `no_video_url` を再試行するまでの時間（設計 5.6 章。一覧にある間の再試行を最大 7 回程度に抑える） */
export const ANALYSIS_RETRY_AFTER_MS = 3 * 60 * 60 * 1000;

/** 「冒頭 3 秒」の境界。`at_ms < 3000` を冒頭に含める（3000 ちょうどは含めない） */
const FIRST_SECONDS_MS = 3000;

/** 一時ファイルの名前。拡張子はダウンロード元に関係なく固定（ffmpeg は中身で判定する） */
const VIDEO_FILE_NAME = "video.mp4";

/** `Error` でないものが投げられたときの `error` 列の文言 */
const UNKNOWN_ERROR = "不明なエラー";

/** `mkdtemp` に失敗したときの `error` 列の文言（例外にはパスが入るので固定文言にする） */
export const TEMP_DIR_ERROR = "一時ディレクトリの作成に失敗";

/** カットから計算する特徴量（`video_analyses` の列。DB 設計 5.3 章） */
export interface CutSummary {
  /** 有効なカットの数 */
  cut_count: number;
  /** 平均シーン長 = 長さ ÷ (カット数 + 1)。四捨五入。長さが 0 なら null */
  avg_scene_ms: number | null;
  /** 最初のカットの時刻。カットがなければ null */
  first_cut_ms: number | null;
  /** 冒頭 3 秒（`at_ms < 3000`）のカット数 */
  cuts_in_first_3s: number;
}

/**
 * シーン検出が返したカットの時刻を整える。
 * 数値でないもの、負のもの、長さを超えるもの（`durationMs` ちょうどは残す）を捨て、整数に丸め、昇順にし、重複を除く。
 * 入力は変更しない。`video_cuts` の行と `summarizeCuts` の入力はこれを通した列で、`cut_count` と行数が一致する
 */
export function normalizeCutTimes(durationMs: number, cutTimesMs: readonly number[]): number[] {
  const valid = cutTimesMs
    .filter((t) => Number.isFinite(t))
    .map((t) => Math.round(t))
    .filter((t) => t >= 0 && t <= durationMs);
  return [...new Set(valid)].sort((a, b) => a - b);
}

/**
 * カットの時刻から特徴量を計算する（純粋関数）。入力は `normalizeCutTimes` で整えてから使う（整えた列を渡しても結果は同じ）。
 * - `cut_count`: 有効なカットの数
 * - `avg_scene_ms`: `durationMs / (cut_count + 1)` を四捨五入。`durationMs` が 0 以下なら null
 * - `first_cut_ms`: 最初のカット。なければ null
 * - `cuts_in_first_3s`: `at_ms < 3000` のカット数
 */
export function summarizeCuts(durationMs: number, cutTimesMs: readonly number[]): CutSummary {
  const cuts = normalizeCutTimes(durationMs, cutTimesMs);
  const cutCount = cuts.length;
  return {
    cut_count: cutCount,
    avg_scene_ms: durationMs > 0 ? Math.round(durationMs / (cutCount + 1)) : null,
    first_cut_ms: cuts[0] ?? null,
    cuts_in_first_3s: cuts.filter((t) => t < FIRST_SECONDS_MS).length,
  };
}

/**
 * 同じ解析条件の結果を今回解析し直すか（設計 5.6 章）。
 * 解析結果がなければ true。`success` なら false。`failed` と `no_video_url` は `analyzed_at + retryAfterMs <= now` で true
 */
export function isAnalysisRetryDue(
  latest: { status: VideoAnalysisStatus; analyzed_at: Date } | undefined,
  now: Date,
  retryAfterMs: number = ANALYSIS_RETRY_AFTER_MS,
): boolean {
  if (!latest) return true;
  if (latest.status === "success") return false;
  return latest.analyzed_at.getTime() + retryAfterMs <= now.getTime();
}

export interface VideoAnalysisInput {
  /** `media.id`（Instagram のメディア ID） */
  mediaId: string;
  /** API の `media_url`。返らなかった（P2）ときは undefined で、`no_video_url` の行になる */
  videoUrl: string | undefined;
  /** ダウンロードの制限（設計 13.3 章。`maxBytes`、`timeoutMs`、`allowedHosts` は呼び出し側が渡す） */
  limits: DownloadLimits;
  /** シーン検出のしきい値。省略時は `DEFAULT_SCENE_THRESHOLD` */
  sceneThreshold?: number;
  /** `analyzed_at` に使う時刻 */
  now: () => Date;
  /** `error` 列に入れる自由文（ffmpeg の例外など）から秘密情報を落とす（`JobContext.mask`） */
  mask: (text: string) => string;
}

/** テスト用の差し替え。省略時は本物（グローバルの `fetch`、ffprobe、ffmpeg、`os.tmpdir()`） */
export interface VideoAnalysisDeps {
  fetchImpl?: typeof fetch;
  probe?: typeof probeVideo;
  detect?: typeof detectSceneChanges;
  /** 一時ディレクトリを作る親。省略時は `os.tmpdir()` */
  tmpRoot?: string;
}

/** `failed` の分類。`JobContext.recordFailure` の `errorClass` にそのまま渡せる */
export type VideoAnalysisFailureClass = "download" | "unknown";

export interface VideoAnalysisResult {
  /** `video_analyses` に書く行（`id` なし） */
  row: VideoAnalysisInsert;
  /**
   * `video_cuts` に書く行。`seq` は 1 から。
   * `scene_score` は現在の `detectSceneChanges` が返さないので常に null（将来 `showinfo` の出力から `scene_score` を
   * 拾えるようにしたら入れる）
   */
  cuts: VideoCutInsert[];
  /** `row.status` が `failed` のときの分類（`DownloadError` なら `download`、それ以外は `unknown`）。失敗でなければ undefined */
  failureClass: VideoAnalysisFailureClass | undefined;
}

/** 計測値の列をすべて null にした行（`no_video_url` と `failed` の形） */
function emptyRow(
  input: VideoAnalysisInput,
  threshold: number,
  status: Exclude<VideoAnalysisStatus, "success">,
  error: string | null,
): VideoAnalysisInsert {
  return {
    media_id: input.mediaId,
    analyzer_version: ANALYZER_VERSION,
    scene_threshold: threshold,
    status,
    error,
    analyzed_at: input.now(),
    duration_ms: null,
    width: null,
    height: null,
    fps: null,
    bitrate: null,
    file_size: null,
    has_audio: null,
    cut_count: null,
    avg_scene_ms: null,
    first_cut_ms: null,
    cuts_in_first_3s: null,
  };
}

/**
 * `error` 列に入れる文字列。
 * - `DownloadError`: 固定文言（URL を含まない）
 * - `CommandError`（ffprobe、ffmpeg の失敗）: `動画の解析に失敗（<command>、終了コード <code>）`。`message` には stderr の
 *   末尾（一時ファイルのパスを含みうる）が入るので使わない。制限時間の超過などで `code` が null なら `なし`
 * - それ以外の `Error`: `mask(message)`
 * `stack`、`cause` は参照しない（設計 10.5 章）
 */
function describeAnalysisError(error: unknown, mask: (text: string) => string): string {
  if (error instanceof DownloadError) return error.message;
  if (error instanceof CommandError) return `動画の解析に失敗（${error.command}、終了コード ${error.code ?? "なし"}）`;
  if (error instanceof Error) return mask(error.message);
  return UNKNOWN_ERROR;
}

/**
 * 動画 1 本を解析して、`video_analyses` と `video_cuts` に書く形の行を返す。例外は投げない。
 *
 * 1. `videoUrl` がなければ `status = 'no_video_url'`（ダウンロードしない）
 * 2. 一時ディレクトリを作り（失敗は `TEMP_DIR_ERROR` の `failed`）、`downloadToFile` で落とす
 * 3. `probe`（ffprobe）→ `detect`（ffmpeg のシーン検出。しきい値は `sceneThreshold`）
 * 4. `normalizeCutTimes` → `summarizeCuts` で特徴量を計算し、`status = 'success'` の行と `cuts` を返す
 * 5. 途中で失敗したら `status = 'failed'`、`error` は `describeAnalysisError`、計測値の列は null、`cuts` は空
 * 6. `finally` で一時ディレクトリを消す（動画ファイルを残さない）
 */
export async function analyzeVideo(
  input: VideoAnalysisInput,
  deps: VideoAnalysisDeps = {},
): Promise<VideoAnalysisResult> {
  const threshold = input.sceneThreshold ?? DEFAULT_SCENE_THRESHOLD;
  if (!input.videoUrl) {
    return { row: emptyRow(input, threshold, "no_video_url", null), cuts: [], failureClass: undefined };
  }

  let dir: string | undefined;
  try {
    try {
      dir = await mkdtemp(join(deps.tmpRoot ?? tmpdir(), `${TMP_DIR_PREFIX}video-`));
    } catch {
      // 例外のメッセージにはパスが入るので固定文言にする（`storage/thumbnails.ts` と同じ）
      return { row: emptyRow(input, threshold, "failed", TEMP_DIR_ERROR), cuts: [], failureClass: "unknown" };
    }
    const filePath = join(dir, VIDEO_FILE_NAME);
    await downloadToFile(input.videoUrl, filePath, input.limits, deps.fetchImpl);
    const probe = await (deps.probe ?? probeVideo)(filePath);
    const rawCuts = await (deps.detect ?? detectSceneChanges)(filePath, threshold);
    const cutTimes = normalizeCutTimes(probe.durationMs, rawCuts);
    const summary = summarizeCuts(probe.durationMs, cutTimes);
    return {
      row: {
        media_id: input.mediaId,
        analyzer_version: ANALYZER_VERSION,
        scene_threshold: threshold,
        status: "success",
        error: null,
        analyzed_at: input.now(),
        duration_ms: probe.durationMs,
        width: probe.width ?? null,
        height: probe.height ?? null,
        fps: probe.fps ?? null,
        bitrate: probe.bitrate ?? null,
        file_size: probe.fileSize ?? null,
        has_audio: probe.hasAudio,
        ...summary,
      },
      cuts: cutTimes.map((at_ms, index) => ({ seq: index + 1, at_ms, scene_score: null })),
      failureClass: undefined,
    };
  } catch (error) {
    return {
      row: emptyRow(input, threshold, "failed", describeAnalysisError(error, input.mask)),
      cuts: [],
      failureClass: error instanceof DownloadError ? "download" : "unknown",
    };
  } finally {
    if (dir !== undefined) {
      // 消せなくても解析結果は返す（起動時の掃除 `cleanOldTempDirs` が 1 日後に消す）
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
