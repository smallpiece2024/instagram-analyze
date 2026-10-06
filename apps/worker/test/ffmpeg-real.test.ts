/**
 * 本物の ffmpeg／ffprobe での確認（R4 設計 4.3 節、7 章の「色の切り替え動画でカットの時刻が R1 と同じ」）。
 * ffmpeg と ffprobe が起動できるときだけ動く（ない環境では飛ばす）。一時ディレクトリは `afterAll` で消す
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CommandError,
  detectScenes,
  generateColorTestVideo,
  probeVideo,
  runCommand,
} from "../src/lib/ffmpeg.js";

function available(tool: string): boolean {
  try {
    return spawnSync(tool, ["-hide_banner", "-version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

const HAS_FFMPEG = available("ffmpeg") && available("ffprobe");

/** R1 の検出（showinfo）の時刻。R4 の metadata=print と比べるためにテストの中でだけ使う */
async function showinfoTimes(filePath: string, threshold: number): Promise<number[]> {
  const { stderr } = await runCommand("ffmpeg", [
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
  const times: number[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    if (!line.includes("Parsed_showinfo")) continue;
    const match = /pts_time:\s*(-?[\d.]+)/.exec(line);
    if (match?.[1]) times.push(Math.round(Number(match[1]) * 1000));
  }
  return times;
}

describe.skipIf(!HAS_FFMPEG)("本物の ffmpeg（結合）", () => {
  let dir: string;
  let video: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "worker-test-ffmpeg-"));
    video = join(dir, "test.mp4");
    await generateColorTestVideo(video, [
      { color: "red", durationMs: 1500 },
      { color: "blue", durationMs: 1000 },
      { color: "green", durationMs: 1500 },
    ]);
  }, 60_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("-protocol_whitelist file -f mp4 で ffprobe が読める（長さ 4 秒）", async () => {
    const probe = await probeVideo(video);
    expect(Math.abs(probe.durationMs - 4000)).toBeLessThanOrEqual(50);
    expect(probe.width).toBe(360);
  });

  it("metadata=print のカットの時刻が R1（showinfo）と同じで、点数が取れてしきい値より大きい", async () => {
    for (const threshold of [0.1, 0.3]) {
      const changes = await detectScenes(video, threshold);
      expect(changes.map((c) => c.atMs)).toEqual(await showinfoTimes(video, threshold));
      expect(changes.map((c) => c.atMs)).toEqual([1500, 2500]);
      for (const c of changes) {
        expect(c.score).not.toBeNull();
        expect(c.score ?? 0).toBeGreaterThan(threshold);
        expect(c.score ?? 2).toBeLessThanOrEqual(1);
      }
    }
  }, 60_000);

  it("mp4 でない中身（HLS の再生リスト）は -f mp4 で読めず CommandError", async () => {
    const playlist = join(dir, "video.mp4");
    await writeFile(playlist, "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttps://example.com/a.ts\n#EXT-X-ENDLIST\n");
    await expect(probeVideo(playlist)).rejects.toBeInstanceOf(CommandError);
    await expect(detectScenes(playlist, 0.3)).rejects.toBeInstanceOf(CommandError);
  });
});
