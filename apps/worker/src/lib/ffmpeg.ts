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

/** `probeVideo`、`detectSceneChanges`、`resizeImage` の制限時間。ストーリーズの動画（最長 60 秒）には十分な余裕 */
export const TOOL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 子プロセスを起動して終了を待つ。終了コードが 0 でなくても resolve する（判断は呼び出し側）。
 * 起動の失敗（コマンドがない、など）は `spawn` の `error` で reject する。
 * `options.timeoutMs` を超えたら `SIGKILL` で止め、`CommandError`（`code` null、固定文言）で reject する
 */
export function runCommand(command: string, args: string[], options: RunCommandOptions = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
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
  const { stdout } = await runOrThrow(tool, ["-hide_banner", "-version"]);
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

/** ffprobe で長さ、解像度、フレームレートなどを読む。失敗は `CommandError`。制限時間は `TOOL_TIMEOUT_MS` */
export async function probeVideo(filePath: string): Promise<VideoProbe> {
  const { stdout } = await runOrThrow(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath],
    TOOL_TIMEOUT_MS,
  );
  return parseProbeOutput(stdout);
}

export const DEFAULT_SCENE_THRESHOLD = 0.3;

/**
 * showinfo フィルタの出力（stderr）から、選ばれたフレームの時刻をミリ秒で取り出す。
 * 行の例: "[Parsed_showinfo_1 @ 0x...] n:   0 pts:  45 pts_time:1.5 ..."
 */
export function parseSceneChangeTimes(stderr: string): number[] {
  const times: number[] = [];
  for (const line of stderr.split("\n")) {
    if (!line.includes("Parsed_showinfo")) continue;
    const match = /pts_time:\s*(-?[\d.]+)/.exec(line);
    if (!match?.[1]) continue;
    const sec = Number(match[1]);
    if (Number.isFinite(sec)) times.push(Math.round(sec * 1000));
  }
  return times;
}

/** ffmpeg のシーン検出で、画面が大きく変わった時刻（開始からのミリ秒）を返す。失敗は `CommandError`。制限時間は `TOOL_TIMEOUT_MS` */
export async function detectSceneChanges(
  filePath: string,
  threshold = DEFAULT_SCENE_THRESHOLD,
): Promise<number[]> {
  const { stderr } = await runOrThrow(
    "ffmpeg",
    ["-hide_banner", "-nostats", "-i", filePath, "-filter:v", `select='gt(scene,${threshold})',showinfo`, "-an", "-f", "null", "-"],
    TOOL_TIMEOUT_MS,
  );
  return parseSceneChangeTimes(stderr);
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
