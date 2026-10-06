import { describe, expect, it } from "vitest";
import {
  DEFAULT_TUNE_THRESHOLDS,
  formatThresholdTable,
  parseTuneArgs,
  summarizeByThreshold,
  TUNE_ARGS_ERROR,
  TUNE_CI_MESSAGE,
  TUNE_ID_ERROR,
  TUNE_THRESHOLDS_ERROR,
  videoTune,
} from "../src/commands/video-tune.js";
import { isCiEnvironment } from "../src/config.js";

describe("parseTuneArgs（R4 設計 4.1 節）", () => {
  it("ID は数字だけで 1 本以上。--thresholds の既定は 0.2,0.25,0.3,0.4,0.5", () => {
    expect(parseTuneArgs(["123", "456"])).toEqual({ ok: true, args: { mediaIds: ["123", "456"], thresholds: [...DEFAULT_TUNE_THRESHOLDS] } });
    expect(parseTuneArgs([])).toEqual({ ok: false, error: TUNE_ARGS_ERROR });
    for (const bad of ["12a", "../me", "1/insights", "-1", "１２３"]) {
      expect(parseTuneArgs(["123", bad]).ok, bad).toBe(false);
    }
    expect(parseTuneArgs(["12a"])).toEqual({ ok: false, error: TUNE_ID_ERROR });
    expect(parseTuneArgs(["123", "--unknown"])).toEqual({ ok: false, error: TUNE_ARGS_ERROR });
  });

  it("--thresholds は 0.1 より大きく 1 未満の数。昇順、重複なし", () => {
    expect(parseTuneArgs(["1", "--thresholds", "0.4, 0.2,0.4"])).toEqual({ ok: true, args: { mediaIds: ["1"], thresholds: [0.2, 0.4] } });
    expect(parseTuneArgs(["1", "--thresholds", "-0.3"]).ok).toBe(false);
    for (const bad of ["0.1", "1", "abc", "0.2,", "0.2;0.3"]) {
      expect(parseTuneArgs(["1", "--thresholds", bad]), bad).toEqual({ ok: false, error: TUNE_THRESHOLDS_ERROR });
    }
  });
});

describe("summarizeByThreshold", () => {
  const changes = [
    { atMs: 4200, score: 0.25 },
    { atMs: 1500, score: 0.4 },
    { atMs: 9000, score: 0.3 },
    { atMs: 12_345, score: null },
  ];

  it("score > t のカットを時刻の順に数える（ちょうど t は含めない。点数 null は数えない）", () => {
    expect(summarizeByThreshold(changes, [0.2, 0.25, 0.3, 0.5])).toEqual([
      { threshold: 0.2, count: 3, timesSec: ["1.5", "4.2", "9.0"] },
      { threshold: 0.25, count: 2, timesSec: ["1.5", "9.0"] },
      { threshold: 0.3, count: 1, timesSec: ["1.5"] },
      { threshold: 0.5, count: 0, timesSec: [] },
    ]);
  });

  it("表の行: 見出しと、しきい値ごとの 1 行。カットがなければ「—」", () => {
    const lines = formatThresholdTable(summarizeByThreshold(changes, [0.3, 0.5]));
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^ {2}0\.30 +1 {2}1\.5$/);
    expect(lines[2]).toMatch(/—$/);
  });
});

describe("video-tune の CI の判定", () => {
  it("CI か GITHUB_ACTIONS があれば何もせず true（DB にも API にも触れない）", async () => {
    const out: string[] = [];
    expect(await videoTune(["123"], { env: { GITHUB_ACTIONS: "true" }, out: (l) => out.push(l) })).toBe(true);
    expect(out).toEqual([TUNE_CI_MESSAGE]);
    expect(isCiEnvironment({ CI: "1" })).toBe(true);
    expect(isCiEnvironment({ CI: "" })).toBe(false);
    expect(isCiEnvironment({})).toBe(false);
  });

  it("CI でなく引数が不正なら固定文言の例外（値を含めない）", async () => {
    await expect(videoTune(["12a"], { env: {}, out: () => undefined })).rejects.toThrow(TUNE_ID_ERROR);
  });
});
