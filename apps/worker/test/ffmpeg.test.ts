import { describe, expect, it } from "vitest";
import {
  CommandError,
  parseFrameRate,
  parseProbeOutput,
  parseSceneMetadata,
  PROBE_TIMEOUT_MS,
  probeArgs,
  runCommand,
  SAFE_INPUT_ARGS,
  sceneDetectArgs,
  sceneDetectTimeoutMs,
  TOOL_TIMEOUT_MS,
} from "../src/lib/ffmpeg.js";

describe("runCommand", () => {
  it("終了コード、stdout、stderr を返す（0 でなくても resolve）", async () => {
    const result = await runCommand(process.execPath, [
      "-e",
      "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)",
    ]);
    expect(result).toEqual({ code: 3, stdout: "out", stderr: "err" });
    expect((await runCommand(process.execPath, ["-e", "process.exit(0)"])).code).toBe(0);
  });

  it("存在しないコマンドは spawn の error で reject する", async () => {
    await expect(runCommand("instagram-analyze-no-such-command", ["-x"])).rejects.toThrow();
  });

  it("制限時間を超えたら子プロセスを止めて CommandError（code null、固定文言）で reject する", async () => {
    const started = Date.now();
    let caught: unknown;
    try {
      await runCommand(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 300 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CommandError);
    const error = caught as CommandError;
    expect(error.name).toBe("CommandError");
    expect(error.command).toBe(process.execPath);
    expect(error.code).toBeNull();
    expect(error.message).toBe(`${process.execPath} が制限時間を超えた`);
    // 10 秒の子プロセスを待っていない
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("制限時間内に終われば通常どおり resolve する", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.exit(0)"], { timeoutMs: TOOL_TIMEOUT_MS });
    expect(result.code).toBe(0);
    expect(TOOL_TIMEOUT_MS).toBe(5 * 60 * 1000);
  });

  it("CommandError は command と code を持つ", () => {
    const error = new CommandError("ffprobe", 1, "ffprobe が終了コード 1 で失敗しました:\n/tmp/x/video.mp4: Invalid data");
    expect(error).toBeInstanceOf(Error);
    expect(error.command).toBe("ffprobe");
    expect(error.code).toBe(1);
    expect(error.message).toContain("Invalid data");
  });
});

describe("parseSceneMetadata（R4 設計 4.1 節、4.3 節）", () => {
  it("metadata=print の 2 行（pts_time と lavfi.scene_score）を組にして、時刻（ミリ秒）と点数を返す", () => {
    const stderr = [
      "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'video.mp4':",
      "[Parsed_metadata_1 @ 0x55d0] frame:0    pts:23040   pts_time:1.5",
      "[Parsed_metadata_1 @ 0x55d0] lavfi.scene_score=0.400000",
      "[Parsed_metadata_1 @ 0x55d0] frame:1    pts:38400   pts_time:2.5",
      "[Parsed_metadata_1 @ 0x55d0] lavfi.scene_score=0.312345",
      "[Parsed_metadata_1 @ 0x55d0] frame:2    pts:51029   pts_time:3.32223",
      "[Parsed_metadata_1 @ 0x55d0] lavfi.scene_score=1.000000",
      "frame=    3 fps=0.0 q=-0.0 Lsize=N/A time=00:00:04.00",
    ].join("\r\n");
    expect(parseSceneMetadata(stderr)).toEqual([
      { atMs: 1500, score: 0.4 },
      { atMs: 2500, score: 0.312345 },
      { atMs: 3322, score: 1 },
    ]);
  });

  it("点数の行がないフレームは null、時刻が数値でない行は捨てる、Parsed_metadata 以外の行は無視する", () => {
    const stderr = [
      "[Parsed_metadata_1 @ 0x1] frame:0 pts:1 pts_time:0.5",
      "[Parsed_metadata_1 @ 0x1] frame:1 pts:2 pts_time:1.0",
      "[Parsed_metadata_1 @ 0x1] lavfi.scene_score=0.5",
      "[Parsed_metadata_1 @ 0x1] frame:2 pts:3 pts_time:nan",
      "[Parsed_metadata_1 @ 0x1] lavfi.scene_score=0.9",
      "[Parsed_showinfo_1 @ 0x2] n:0 pts:3 pts_time:9.9",
      "lavfi.scene_score=0.7",
    ].join("\n");
    expect(parseSceneMetadata(stderr)).toEqual([
      { atMs: 500, score: null },
      { atMs: 1000, score: 0.5 },
    ]);
  });

  it("該当行がなければ空配列", () => {
    expect(parseSceneMetadata("no scenes here")).toEqual([]);
  });
});

describe("ffmpeg と ffprobe の引数（R4 設計 3.5 節、4.3 節）", () => {
  it("ffprobe は入力の直前に -protocol_whitelist file -f mp4 を付ける", () => {
    expect(SAFE_INPUT_ARGS).toEqual(["-protocol_whitelist", "file", "-f", "mp4"]);
    const args = probeArgs("/tmp/x/video.mp4");
    expect(args.slice(-5)).toEqual(["-protocol_whitelist", "file", "-f", "mp4", "/tmp/x/video.mp4"]);
  });

  it("シーン検出は -i の前に入力の制限を付け、select と metadata=print のフィルタを使う（showinfo は使わない）", () => {
    const args = sceneDetectArgs("/tmp/x/video.mp4", 0.3);
    const i = args.indexOf("-i");
    expect(args.slice(i - 4, i + 2)).toEqual(["-protocol_whitelist", "file", "-f", "mp4", "-i", "/tmp/x/video.mp4"]);
    expect(args).toContain("select='gt(scene,0.3)',metadata=print:key=lavfi.scene_score");
    expect(args.join(" ")).not.toContain("showinfo");
  });
});

describe("制限時間（R4 設計 3.2 節）", () => {
  it("ffprobe は 30 秒", () => {
    expect(PROBE_TIMEOUT_MS).toBe(30_000);
  });

  it("シーン検出は max(60 秒, 長さ × 3) で 5 分が上限。長さ 0、負、NaN は 60 秒", () => {
    expect(sceneDetectTimeoutMs(10_000)).toBe(60_000);
    expect(sceneDetectTimeoutMs(20_000)).toBe(60_000);
    expect(sceneDetectTimeoutMs(30_000)).toBe(90_000);
    expect(sceneDetectTimeoutMs(100_000)).toBe(TOOL_TIMEOUT_MS);
    expect(sceneDetectTimeoutMs(15 * 60 * 1000)).toBe(TOOL_TIMEOUT_MS);
    expect(sceneDetectTimeoutMs(0)).toBe(60_000);
    expect(sceneDetectTimeoutMs(-1)).toBe(60_000);
    expect(sceneDetectTimeoutMs(Number.NaN)).toBe(60_000);
  });
});

describe("parseFrameRate", () => {
  it("分数表記を数値にする", () => {
    expect(parseFrameRate("30/1")).toBe(30);
    expect(parseFrameRate("30000/1001")).toBeCloseTo(29.97, 2);
  });

  it("分母が 0 や不正な値なら undefined", () => {
    expect(parseFrameRate("0/0")).toBeUndefined();
    expect(parseFrameRate(undefined)).toBeUndefined();
    expect(parseFrameRate("abc")).toBeUndefined();
  });
});

describe("parseProbeOutput", () => {
  it("ffprobe の JSON から長さ（ミリ秒）と映像・音声の情報を取り出す", () => {
    const json = JSON.stringify({
      streams: [
        { codec_type: "video", width: 1080, height: 1920, avg_frame_rate: "30/1" },
        { codec_type: "audio" },
      ],
      format: { duration: "18.366667", bit_rate: "3500000", size: "8035000" },
    });
    expect(parseProbeOutput(json)).toEqual({
      durationMs: 18367,
      width: 1080,
      height: 1920,
      fps: 30,
      bitrate: 3500000,
      fileSize: 8035000,
      hasAudio: true,
    });
  });

  it("長さがなければエラー", () => {
    expect(() => parseProbeOutput(JSON.stringify({ streams: [], format: {} }))).toThrow();
  });
});
