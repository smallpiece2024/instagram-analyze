import { spawn } from "node:child_process";

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunCommandOptions {
  /** 制限時間（ミリ秒）。超えたら `SIGKILL` で止めて `CommandError`（`code` は null）で reject する。省略時は制限なし */
  timeoutMs?: number;
}

/**
 * 子プロセスの失敗（終了コードが 0 でない、または制限時間を超えた）。
 * `command` は起動したコマンド名（`ffmpeg`、`ffprobe`）、`code` は終了コード（制限時間の超過やシグナルによる終了は null）。
 * `message` は stderr の末尾（一時ファイルのパスを含みうる）を含むので、`check-env` の表示には使ってよいが、
 * DB やログに入れるときは呼び出し側が `command` と `code` から固定文言を組み立てること（`lib/video-analysis.ts`、
 * `storage/thumbnails.ts`）
 */
export class CommandError extends Error {
  override readonly name = "CommandError";

  constructor(
    readonly command: string,
    readonly code: number | null,
    message: string,
  ) {
    super(message);
  }
}

/**
 * 子プロセスの標準出力と標準エラーをため込む上限（文字数。それぞれ）。壊れた動画で警告が 1 フレームごとに出ても
 * メモリを使い切らないため。超えたら止めて `CommandError`（`code` null）にする（切り詰めて解析を続けると、
 * シーン検出の結果が黙って欠けるので失敗にする）
 */
export const MAX_OUTPUT_CHARS = 8 * 1024 * 1024;

/** `ffmpeg -version` の制限時間（R4 のセキュリティレビュー。固まってもジョブ全体を止めない） */
export const VERSION_TIMEOUT_MS = 10_000;

/** `resizeImage` の制限時間。シーン検出の制限時間の上限にも使う（R4 設計 3.2 節） */
export const TOOL_TIMEOUT_MS = 5 * 60 * 1000;

/** ffprobe の制限時間（R4 設計 3.2 節。ヘッダを読むだけなので短い） */
export const PROBE_TIMEOUT_MS = 30_000;

/** シーン検出の制限時間の下限（R4 設計 3.2 節） */
export const SCENE_DETECT_MIN_TIMEOUT_MS = 60_000;

/** シーン検出の制限時間を動画の長さの何倍にするか（R4 設計 3.2 節） */
export const SCENE_DETECT_TIMEOUT_FACTOR = 3;

/**
 * シーン検出の制限時間 = `max(60 秒, 動画の長さ × 3)` を `TOOL_TIMEOUT_MS`（5 分）で頭打ちにする（R4 設計 3.2 節）。
 * 長さが数値でない、または 0 以下なら下限の 60 秒
 */
export function sceneDetectTimeoutMs(durationMs: number): number {
  const scaled = Number.isFinite(durationMs) && durationMs > 0 ? durationMs * SCENE_DETECT_TIMEOUT_FACTOR : 0;
  return Math.min(TOOL_TIMEOUT_MS, Math.max(SCENE_DETECT_MIN_TIMEOUT_MS, Math.ceil(scaled)));
}

/**
 * ffprobe と ffmpeg の入力の前に付ける引数（R4 設計 3.5 節）。ファイル以外のプロトコルを読まず（中身が HLS などでも
 * 別の URL やファイルを読みに行かない）、形式を mp4 に固定する。`-i`（ffprobe では入力のパス）の直前に置く
 */
export const SAFE_INPUT_ARGS: readonly string[] = ["-protocol_whitelist", "file", "-f", "mp4"];

/**
 * 子プロセスを起動して終了を待つ。終了コードが 0 でなくても resolve する（判断は呼び出し側）。
 * 起動の失敗（コマンドがない、など）は `spawn` の `error` で reject する。
 * `options.timeoutMs` を超えたら `SIGKILL` で止め、`CommandError`（`code` null、固定文言）で reject する。
 * 出力が `MAX_OUTPUT_CHARS` を超えたときも同じ（固定文言）
 */
export function runCommand(command: string, args: string[], options: RunCommandOptions = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let overflowed = false;
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs);
    const overflow = () => {
      if (overflowed) return;
      overflowed = true;
      child.kill("SIGKILL");
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (overflowed) return;
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_OUTPUT_CHARS) overflow();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (overflowed) return;
      stderr += chunk.toString("utf8");
      if (stderr.length > MAX_OUTPUT_CHARS) overflow();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new CommandError(command, null, `${command} が制限時間を超えた`));
        return;
      }
      if (overflowed) {
        reject(new CommandError(command, null, `${command} の出力が上限を超えた`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

/** 終了コードが 0 でなければ `CommandError`（`message` は stderr の末尾 5 行を含む）。`timeoutMs` は `runCommand` と同じ */
async function runOrThrow(command: string, args: string[], timeoutMs?: number): Promise<CommandResult> {
  const result = await runCommand(command, args, { timeoutMs });
  if (result.code !== 0) {
    const tail = result.stderr.split("\n").slice(-5).join("\n");
    throw new CommandError(command, result.code, `${command} が終了コード ${result.code} で失敗しました:\n${tail}`);
  }
  return result;
}

/** `ffmpeg -version` の 1 行目（例: "ffmpeg version 5.1.6-0+deb12u1 ..."） */
export async function toolVersion(tool: "ffmpeg" | "ffprobe"): Promise<string> {
  const { stdout } = await runOrThrow(tool, ["-hide_banner", "-version"], VERSION_TIMEOUT_MS);
  return stdout.split("\n")[0]?.trim() ?? "";
}

export interface VideoProbe {
  durationMs: number;
  width: number | undefined;
  height: number | undefined;
  fps: number | undefined;
  bitrate: number | undefined;
  fileSize: number | undefined;
  hasAudio: boolean;
}

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string; bit_rate?: string; size?: string };
}

/** "30000/1001" のような分数表記をフレームレートの数値に変換する */
export function parseFrameRate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const [num, den] = value.split("/").map(Number);
  if (num === undefined || !Number.isFinite(num)) return undefined;
  if (den === undefined) return num;
  if (!Number.isFinite(den) || den === 0) return undefined;
  return num / den;
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function parseProbeOutput(json: string): VideoProbe {
  const data = JSON.parse(json) as FfprobeOutput;
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const durationSec = toNumber(data.format?.duration);
  if (durationSec === undefined) {
    throw new Error("ffprobe の出力に動画の長さがありません");
  }
  return {
    durationMs: Math.round(durationSec * 1000),
    width: video?.width,
    height: video?.height,
    fps: parseFrameRate(video?.avg_frame_rate),
    bitrate: toNumber(data.format?.bit_rate),
    fileSize: toNumber(data.format?.size),
    hasAudio: streams.some((s) => s.codec_type === "audio"),
  };
}

/** ffprobe の引数（純粋関数）。入力は `SAFE_INPUT_ARGS` で制限する */
export function probeArgs(filePath: string): string[] {
  return ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", ...SAFE_INPUT_ARGS, filePath];
}

/** ffprobe で長さ、解像度、フレームレートなどを読む。失敗は `CommandError`。制限時間は `PROBE_TIMEOUT_MS` */
export async function probeVideo(filePath: string): Promise<VideoProbe> {
  const { stdout } = await runOrThrow("ffprobe", probeArgs(filePath), PROBE_TIMEOUT_MS);
  return parseProbeOutput(stdout);
}

export const DEFAULT_SCENE_THRESHOLD = 0.3;

/** シーン検出で選ばれたフレーム 1 枚 */
export interface SceneChange {
  /** 開始からのミリ秒（`pts_time` を四捨五入） */
  atMs: number;
  /** `lavfi.scene_score`（0〜1。直前のフレームとの差）。行がなければ null */
  score: number | null;
}

/**
 * シーン検出の ffmpeg の引数（純粋関数。R4 設計 4.3 節）。`select='gt(scene,T)'` で T より大きいフレームを選び、
 * `metadata=print:key=lavfi.scene_score` でその時刻と点数を標準エラーに出す。入力は `SAFE_INPUT_ARGS` で制限する
 */
export function sceneDetectArgs(filePath: string, threshold: number): string[] {
  return [
    "-hide_banner",
    "-nostats",
    ...SAFE_INPUT_ARGS,
    "-i",
    filePath,
    "-filter:v",
    `select='gt(scene,${threshold})',metadata=print:key=lavfi.scene_score`,
    "-an",
    "-f",
    "null",
    "-",
  ];
}

/**
 * `metadata=print` の出力（stderr）から、選ばれたフレームの時刻と点数を取り出す（R4 設計 4.1 節、4.3 節）。
 * フレーム 1 枚につき次の 2 行が出る（コンテナの ffmpeg 5.1 とホストの 2025 年の開発版で確認）。`pts_time` の行で 1 枚を始め、続く `lavfi.scene_score` の行を組にする。
 * - `[Parsed_metadata_1 @ 0x...] frame:0    pts:23040   pts_time:1.5`
 * - `[Parsed_metadata_1 @ 0x...] lavfi.scene_score=0.400000`
 * `Parsed_metadata` を含まない行は無視する。時刻が数値でない行は捨てる。点数の行がない、または数値でなければ null
 */
export function parseSceneMetadata(stderr: string): SceneChange[] {
  const changes: SceneChange[] = [];
  let current: SceneChange | undefined;
  for (const line of stderr.split(/\r?\n/)) {
    if (!line.includes("Parsed_metadata")) continue;
    const time = /pts_time:\s*(\S+)/.exec(line);
    if (time?.[1] !== undefined) {
      const sec = Number(time[1]);
      current = Number.isFinite(sec) ? { atMs: Math.round(sec * 1000), score: null } : undefined;
      if (current) changes.push(current);
      continue;
    }
    const score = /lavfi\.scene_score=(\S+)/.exec(line);
    if (score?.[1] !== undefined && current && current.score === null) {
      const value = Number(score[1]);
      if (Number.isFinite(value)) current.score = value;
    }
  }
  return changes;
}

/**
 * ffmpeg のシーン検出で、画面が大きく変わったフレームの時刻（開始からのミリ秒）と点数を返す。失敗は `CommandError`。
 * 制限時間は `timeoutMs`（省略時は `TOOL_TIMEOUT_MS`。解析では `sceneDetectTimeoutMs(長さ)` を渡す）
 */
export async function detectScenes(
  filePath: string,
  threshold = DEFAULT_SCENE_THRESHOLD,
  timeoutMs: number = TOOL_TIMEOUT_MS,
): Promise<SceneChange[]> {
  const { stderr } = await runOrThrow("ffmpeg", sceneDetectArgs(filePath, threshold), timeoutMs);
  return parseSceneMetadata(stderr);
}

/** `detectScenes` の時刻だけ（ミリ秒）。`check-env` と `verify-api` が使う */
export async function detectSceneChanges(
  filePath: string,
  threshold = DEFAULT_SCENE_THRESHOLD,
  timeoutMs: number = TOOL_TIMEOUT_MS,
): Promise<number[]> {
  return (await detectScenes(filePath, threshold, timeoutMs)).map((c) => c.atMs);
}

/** 色が切り替わるだけの検証用動画を作る。区間の長さはミリ秒で指定する */
export async function generateColorTestVideo(
  outputPath: string,
  segments: { color: string; durationMs: number }[],
): Promise<void> {
  const inputs = segments.flatMap((s) => [
    "-f",
    "lavfi",
    "-i",
    `color=c=${s.color}:s=360x640:r=30:d=${s.durationMs / 1000}`,
  ]);
  const concatInputs = segments.map((_, i) => `[${i}:v]`).join("");
  await runOrThrow("ffmpeg", [
    "-hide_banner",
    "-y",
    ...inputs,
    "-filter_complex",
    `${concatInputs}concat=n=${segments.length}:v=1:a=0[v]`,
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    outputPath,
  ]);
}

/** サムネイルの幅（ピクセル）。一覧表示用（設計 3.6 章、NF-CAP-03） */
export const THUMBNAIL_WIDTH = 320;

/**
 * 画像（動画なら先頭のフレーム）を幅 `width` に縮小して JPEG に書く ffmpeg の引数（設計 3.6 章）。純粋関数。
 * `scale=<width>:-2` は縦横比を保ち、高さを偶数に丸める。`-frames:v 1` で 1 枚だけ出し、`-q:v 4` は JPEG の品質
 */
export function resizeImageArgs(input: string, output: string, width = THUMBNAIL_WIDTH): string[] {
  return ["-hide_banner", "-y", "-i", input, "-vf", `scale=${width}:-2`, "-frames:v", "1", "-q:v", "4", output];
}

/**
 * `input` を幅 `width` に縮小して `output`（拡張子で形式が決まる。`.jpg`）に書く。
 * 失敗時の例外メッセージには stderr の末尾（入力のパスを含みうる）が入るので、呼び出し側
 * （`storage/thumbnails.ts` の `saveThumbnail`）で固定文言に置き換えること。ホストに ffmpeg はないので、
 * 引数の組み立て（`resizeImageArgs`）だけを単体テストし、実行はコンテナで確かめる
 */
export async function resizeImage(input: string, output: string, width = THUMBNAIL_WIDTH): Promise<void> {
  await runOrThrow("ffmpeg", resizeImageArgs(input, output, width), TOOL_TIMEOUT_MS);
}
