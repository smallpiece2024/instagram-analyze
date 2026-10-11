/**
 * 本物の ffmpeg／ffprobe での確認（R4 設計 4.3 節、7 章の「色の切り替え動画でカットの時刻が R1 と同じ」）。
 * ffmpeg と ffprobe が起動できるときだけ動く（ない環境では飛ばす）。一時ディレクトリは `afterAll` で消す
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile, stat } from "node:fs/promises";
import {
  CommandError,
  detectScenes,
  extractFrame,
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

  it("extractFrame（最小の env）で指定の時刻の色のフレームが出て、最後の間隔の中の 1 枚も出る。最後のフレームより後の時刻は CommandError（R4.1 設計 3.4 節）", async () => {
    // 赤 0〜1500、青 1500〜2500、緑 2500〜4000。JPEG の中身は ffmpeg で 1 画素に縮めて色を読む
    const sampleColor = async (jpg: string): Promise<[number, number, number]> => {
      const out = join(dir, "px.rgb");
      await runCommand("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", jpg, "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", out]);
      const px = await readFile(out);
      return [px[0] ?? 0, px[1] ?? 0, px[2] ?? 0];
    };
    const expectations: [number, "r" | "g" | "b"][] = [
      [0, "r"],
      [1600, "b"],
      [3000, "g"],
      [3900, "g"],
    ];
    for (const [atMs, channel] of expectations) {
      const out = join(dir, `frame-${atMs}.jpg`);
      await extractFrame(video, atMs, out, 15_000);
      expect((await stat(out)).size).toBeGreaterThan(0);
      const [r, g, b] = await sampleColor(out);
      // ffmpeg の `green` は (0,128,0) なので、優勢な成分が 100 より大きく、ほかの成分が 60 未満であることを見る
      const dominant = channel === "r" ? r : channel === "g" ? g : b;
      expect(dominant, `${atMs} ms`).toBeGreaterThan(100);
      for (const other of [r, g, b].filter((v) => v !== dominant)) expect(other, `${atMs} ms`).toBeLessThan(60);
    }
    // 最後のフレーム（30 fps なら 3.967 秒）より後の時刻は復号するフレームがなく、手元の ffmpeg は終了コードで失敗する
    // （ジョブは末尾の時刻のこの失敗を計画から外す）
    await expect(extractFrame(video, 4500, join(dir, "frame-4500.jpg"), 15_000)).rejects.toBeInstanceOf(CommandError);
  }, 60_000);

  it("mp4 でない中身（HLS の再生リスト）は -f mp4 で読めず CommandError", async () => {
    const playlist = join(dir, "video.mp4");
    await writeFile(playlist, "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttps://example.com/a.ts\n#EXT-X-ENDLIST\n");
    await expect(probeVideo(playlist)).rejects.toBeInstanceOf(CommandError);
    await expect(detectScenes(playlist, 0.3)).rejects.toBeInstanceOf(CommandError);
  });
});
