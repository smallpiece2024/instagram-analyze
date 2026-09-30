import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectSceneChanges,
  generateColorTestVideo,
  probeVideo,
  toolVersion,
} from "../lib/ffmpeg.js";

/** カットのタイミングの許容誤差（ミリ秒）。30fps の 1 フレーム強 */
const TOLERANCE_MS = 40;

/**
 * ワーカーの実行環境を確認する（F-SYS-04）。
 * ffmpeg / ffprobe の存在と、長さ・カットのタイミング（ミリ秒）の取得を、
 * 自動生成した検証用動画で確かめる。
 */
export async function checkEnv(): Promise<boolean> {
  console.log(`Node.js: ${process.version}`);
  console.log(`ffmpeg : ${await toolVersion("ffmpeg")}`);
  console.log(`ffprobe: ${await toolVersion("ffprobe")}`);

  const segments = [
    { color: "red", durationMs: 1500 },
    { color: "blue", durationMs: 1000 },
    { color: "green", durationMs: 1500 },
  ];
  const expectedDurationMs = segments.reduce((sum, s) => sum + s.durationMs, 0);
  const expectedCuts = segments
    .slice(0, -1)
    .reduce<number[]>((acc, s) => [...acc, (acc.at(-1) ?? 0) + s.durationMs], []);

  const dir = await mkdtemp(join(tmpdir(), "worker-check-"));
  try {
    const video = join(dir, "test.mp4");
    await generateColorTestVideo(video, segments);
    const probe = await probeVideo(video);
    const cuts = await detectSceneChanges(video);

    console.log("");
    console.log("検証用動画（赤 1.5 秒 → 青 1.0 秒 → 緑 1.5 秒）");
    console.log(`  長さ        : ${probe.durationMs} ms（期待値 ${expectedDurationMs} ms）`);
    console.log(`  解像度      : ${probe.width}x${probe.height}、${probe.fps?.toFixed(2)} fps`);
    console.log(`  カット      : ${cuts.join(", ")} ms（期待値 ${expectedCuts.join(", ")} ms）`);

    const durationOk = Math.abs(probe.durationMs - expectedDurationMs) <= TOLERANCE_MS;
    const cutsOk =
      cuts.length === expectedCuts.length &&
      cuts.every((t, i) => Math.abs(t - (expectedCuts[i] ?? Number.NaN)) <= TOLERANCE_MS);

    console.log("");
    console.log(durationOk && cutsOk ? "結果: OK" : "結果: NG（期待値と一致しません）");
    return durationOk && cutsOk;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
