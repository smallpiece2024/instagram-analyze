import { describe, expect, it } from "vitest";
import {
  CommandError,
  parseFrameRate,
  parseProbeOutput,
  parseSceneChangeTimes,
  runCommand,
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

describe("parseSceneChangeTimes", () => {
  it("showinfo の行から pts_time をミリ秒で取り出す", () => {
    const stderr = [
      "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'test.mp4':",
      "[Parsed_showinfo_1 @ 0x55d0] n:   0 pts:  23040 pts_time:1.5     duration:512",
      "[Parsed_showinfo_1 @ 0x55d0] n:   1 pts:  38400 pts_time:2.5     duration:512",
      "[Parsed_showinfo_1 @ 0x55d0] n:   2 pts:  51029 pts_time:3.32223 duration:512",
      "frame=    3 fps=0.0 q=-0.0 Lsize=N/A time=00:00:04.00",
    ].join("\n");
    expect(parseSceneChangeTimes(stderr)).toEqual([1500, 2500, 3322]);
  });

  it("該当行がなければ空配列", () => {
    expect(parseSceneChangeTimes("no scenes here")).toEqual([]);
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
