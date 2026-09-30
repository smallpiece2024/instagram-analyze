import { spawn } from "node:child_process";

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function runOrThrow(command: string, args: string[]): Promise<CommandResult> {
  const result = await runCommand(command, args);
  if (result.code !== 0) {
    const tail = result.stderr.split("\n").slice(-5).join("\n");
    throw new Error(`${command} が終了コード ${result.code} で失敗しました:\n${tail}`);
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

export async function probeVideo(filePath: string): Promise<VideoProbe> {
  const { stdout } = await runOrThrow("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);
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

/** ffmpeg のシーン検出で、画面が大きく変わった時刻（開始からのミリ秒）を返す */
export async function detectSceneChanges(
  filePath: string,
  threshold = DEFAULT_SCENE_THRESHOLD,
): Promise<number[]> {
  const { stderr } = await runOrThrow("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-i",
    filePath,
    "-filter:v",
    `select='gt(scene,${threshold})',showinfo`,
    "-an",
    "-f",
    "null",
    "-",
  ]);
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
