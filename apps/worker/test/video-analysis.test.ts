import { readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DownloadLimits } from "../src/lib/download.js";
import { CommandError, DEFAULT_SCENE_THRESHOLD, type VideoProbe } from "../src/lib/ffmpeg.js";
import {
  ANALYSIS_RETRY_AFTER_MS,
  ANALYZER_VERSION,
  analyzeVideo,
  isAnalysisRetryDue,
  MAX_VIDEO_DURATION_MS,
  normalizeCutTimes,
  normalizeSceneChanges,
  summarizeCuts,
  TEMP_DIR_ERROR,
  VIDEO_TOO_LONG_ERROR,
  type VideoAnalysisInput,
} from "../src/lib/video-analysis.js";
import { TMP_DIR_PREFIX } from "../src/jobs/framework.js";

const HOSTS = ["cdninstagram.com", "fbcdn.net"];
const LIMITS: DownloadLimits = { maxBytes: 1024 * 1024, timeoutMs: 1000, allowedHosts: HOSTS };
const VIDEO_URL = "https://scontent-nrt1-1.cdninstagram.com/v/t50/story.mp4?oe=68F0A1B2&oh=abc";
const NOW = new Date("2026-10-01T12:00:00Z");
const VIDEO_TMP_PREFIX = `${TMP_DIR_PREFIX}video-`;

const encoder = new TextEncoder();

const PROBE: VideoProbe = {
  durationMs: 15_000,
  width: 1080,
  height: 1920,
  fps: 30,
  bitrate: 4_500_000,
  fileSize: 8_437_500,
  hasAudio: true,
};

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** 本文を返す偽の `fetch`。呼ばれた回数を数える */
function fakeFetch(body = "fake video bytes"): { fetchImpl: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response(streamOf([encoder.encode(body)]), { status: 200, headers: { "content-type": "video/mp4" } });
  };
  return { fetchImpl, calls: () => calls };
}

/** URL を `<url>` に置き換えるだけの偽の `mask`。呼ばれた引数を記録する */
function fakeMask(): { mask: (text: string) => string; inputs: string[] } {
  const inputs: string[] = [];
  return {
    inputs,
    mask: (text) => {
      inputs.push(text);
      return text.replace(/https?:\/\/\S+/g, "<url>");
    },
  };
}

function baseInput(overrides: Partial<VideoAnalysisInput> = {}): VideoAnalysisInput {
  return {
    mediaId: "00000000000000001",
    videoUrl: VIDEO_URL,
    limits: LIMITS,
    now: () => NOW,
    mask: (text) => text,
    ...overrides,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** `os.tmpdir()` 直下にある動画用の一時ディレクトリの名前 */
async function listVideoTempDirs(): Promise<Set<string>> {
  const names = await readdir(tmpdir());
  return new Set(names.filter((name) => name.startsWith(VIDEO_TMP_PREFIX)));
}

/** `fn` の実行で動画用の一時ディレクトリが増えていないことを確かめる */
async function expectNoTempDirLeft<T>(fn: () => Promise<T>): Promise<T> {
  const before = await listVideoTempDirs();
  const result = await fn();
  const after = await listVideoTempDirs();
  const added = [...after].filter((name) => !before.has(name));
  expect(added).toEqual([]);
  return result;
}

const NULL_METRICS = {
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
  cuts_in_last_3s: null,
};

describe("normalizeCutTimes", () => {
  it("負、長さ超過、数値でないものを捨て、整数に丸め、昇順にし、重複を除く。長さちょうどは残す", () => {
    const input = [7000.4, -1, 2000, 10_001, 2000, Number.NaN, Number.POSITIVE_INFINITY, 0, 10_000, 500.6];
    const copy = [...input];
    expect(normalizeCutTimes(10_000, input)).toEqual([0, 501, 2000, 7000, 10_000]);
    expect(input).toEqual(copy);
  });

  it("空なら空", () => {
    expect(normalizeCutTimes(10_000, [])).toEqual([]);
  });
});

describe("summarizeCuts", () => {
  it("カットなし: cut_count 0、avg_scene_ms は長さ、first_cut_ms null、冒頭 3 秒 0", () => {
    expect(summarizeCuts(12_345, [])).toEqual({
      cut_count: 0,
      avg_scene_ms: 12_345,
      first_cut_ms: null,
      cuts_in_first_3s: 0,
      cuts_in_last_3s: 0,
    });
  });

  it("avg_scene_ms は 長さ ÷ (カット数 + 1) を四捨五入する", () => {
    expect(summarizeCuts(10_000, [3000, 7000])).toEqual({
      cut_count: 2,
      avg_scene_ms: 3333,
      first_cut_ms: 3000,
      cuts_in_first_3s: 0,
      cuts_in_last_3s: 0,
    });
    expect(summarizeCuts(10_001, [5000]).avg_scene_ms).toBe(5001); // 5000.5 → 5001
  });

  it("3000ms ちょうどのカットは冒頭 3 秒に含めず、2999ms は含める", () => {
    expect(summarizeCuts(10_000, [3000]).cuts_in_first_3s).toBe(0);
    expect(summarizeCuts(10_000, [2999]).cuts_in_first_3s).toBe(1);
    expect(summarizeCuts(10_000, [1000, 2999, 3000, 3001]).cuts_in_first_3s).toBe(2);
  });

  it("最後 3 秒: 長さ − 3000ms ちょうどは含めず、それより後は含める。長さちょうども含める", () => {
    expect(summarizeCuts(10_000, [7000]).cuts_in_last_3s).toBe(0);
    expect(summarizeCuts(10_000, [7001]).cuts_in_last_3s).toBe(1);
    expect(summarizeCuts(10_000, [1000, 6999, 7000, 7001, 10_000]).cuts_in_last_3s).toBe(2);
    // 3 秒より短い動画は、すべてのカットが冒頭にも最後にも入る
    expect(summarizeCuts(2000, [500, 1500])).toMatchObject({ cuts_in_first_3s: 2, cuts_in_last_3s: 2 });
  });

  it("0ms のカットは有効で、first_cut_ms は 0 になり、冒頭 3 秒に含まれる", () => {
    expect(summarizeCuts(10_000, [0, 5000])).toEqual({
      cut_count: 2,
      avg_scene_ms: 3333,
      first_cut_ms: 0,
      cuts_in_first_3s: 1,
      cuts_in_last_3s: 0,
    });
  });

  it("長さを超えるカットと負のカットは無視する。長さちょうどは数える", () => {
    expect(summarizeCuts(10_000, [-100, 4000, 10_001, 20_000])).toEqual({
      cut_count: 1,
      avg_scene_ms: 5000,
      first_cut_ms: 4000,
      cuts_in_first_3s: 0,
      cuts_in_last_3s: 0,
    });
    expect(summarizeCuts(10_000, [10_000]).cut_count).toBe(1);
  });

  it("重複は 1 つに数える", () => {
    expect(summarizeCuts(10_000, [2000, 2000, 2000, 6000])).toEqual({
      cut_count: 2,
      avg_scene_ms: 3333,
      first_cut_ms: 2000,
      cuts_in_first_3s: 1,
      cuts_in_last_3s: 0,
    });
  });

  it("順序が乱れていても first_cut_ms は最小の時刻になる", () => {
    expect(summarizeCuts(10_000, [8000, 1500, 4000])).toEqual({
      cut_count: 3,
      avg_scene_ms: 2500,
      first_cut_ms: 1500,
      cuts_in_first_3s: 1,
      cuts_in_last_3s: 1,
    });
  });

  it("durationMs が 0 なら avg_scene_ms は null（0ms のカットは数える）", () => {
    expect(summarizeCuts(0, [])).toEqual({ cut_count: 0, avg_scene_ms: null, first_cut_ms: null, cuts_in_first_3s: 0, cuts_in_last_3s: 0 });
    expect(summarizeCuts(0, [0, 100])).toEqual({ cut_count: 1, avg_scene_ms: null, first_cut_ms: 0, cuts_in_first_3s: 1, cuts_in_last_3s: 1 });
  });

  it("入力の配列を変更しない", () => {
    const input = [5000, 1000];
    summarizeCuts(10_000, input);
    expect(input).toEqual([5000, 1000]);
  });
});

describe("isAnalysisRetryDue", () => {
  const analyzedAt = new Date("2026-10-01T09:00:00Z");
  const threeHoursLater = new Date(analyzedAt.getTime() + ANALYSIS_RETRY_AFTER_MS);
  const justBefore = new Date(threeHoursLater.getTime() - 1);

  it("既定の再試行間隔は 3 時間", () => {
    expect(ANALYSIS_RETRY_AFTER_MS).toBe(3 * 60 * 60 * 1000);
  });

  it("解析結果がなければ true", () => {
    expect(isAnalysisRetryDue(undefined, NOW)).toBe(true);
  });

  it("success は時間が経っても false", () => {
    expect(isAnalysisRetryDue({ status: "success", analyzed_at: analyzedAt }, NOW)).toBe(false);
    expect(isAnalysisRetryDue({ status: "success", analyzed_at: new Date(0) }, NOW)).toBe(false);
  });

  it("failed と no_video_url は 3 時間後ちょうどに true、その 1 ミリ秒前は false", () => {
    for (const status of ["failed", "no_video_url"] as const) {
      expect(isAnalysisRetryDue({ status, analyzed_at: analyzedAt }, threeHoursLater)).toBe(true);
      expect(isAnalysisRetryDue({ status, analyzed_at: analyzedAt }, justBefore)).toBe(false);
      expect(isAnalysisRetryDue({ status, analyzed_at: analyzedAt }, analyzedAt)).toBe(false);
      expect(isAnalysisRetryDue({ status, analyzed_at: analyzedAt }, new Date("2026-10-02T00:00:00Z"))).toBe(true);
    }
  });

  it("再試行の間隔を変えられる", () => {
    const tenMinutes = 10 * 60 * 1000;
    expect(isAnalysisRetryDue({ status: "failed", analyzed_at: analyzedAt }, justBefore, tenMinutes)).toBe(true);
    expect(isAnalysisRetryDue({ status: "failed", analyzed_at: analyzedAt }, analyzedAt, tenMinutes)).toBe(false);
  });
});

describe("analyzeVideo", () => {
  it("ANALYZER_VERSION は '1'", () => {
    expect(ANALYZER_VERSION).toBe("1");
  });

  it("videoUrl がなければ no_video_url の行を返し、fetch も probe も detect も呼ばず、一時ディレクトリも作らない", async () => {
    const { fetchImpl, calls } = fakeFetch();
    let probeCalls = 0;
    let detectCalls = 0;
    const result = await expectNoTempDirLeft(() =>
      analyzeVideo(baseInput({ videoUrl: undefined }), {
        fetchImpl,
        probe: async () => {
          probeCalls += 1;
          return PROBE;
        },
        detect: async () => {
          detectCalls += 1;
          return [];
        },
      }),
    );
    expect(result).toEqual({
      row: {
        media_id: "00000000000000001",
        analyzer_version: "1",
        scene_threshold: DEFAULT_SCENE_THRESHOLD,
        status: "no_video_url",
        error: null,
        analyzed_at: NOW,
        ...NULL_METRICS,
      },
      cuts: [],
      failureClass: undefined,
    });
    expect(result.failureClass).toBeUndefined();
    expect(calls()).toBe(0);
    expect(probeCalls).toBe(0);
    expect(detectCalls).toBe(0);
  });

  it("空文字の videoUrl も no_video_url", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const result = await analyzeVideo(baseInput({ videoUrl: "" }), { fetchImpl });
    expect(result.row.status).toBe("no_video_url");
    expect(calls()).toBe(0);
  });

  it("ダウンロード → probe → detect で success の行と cuts を返し、一時ディレクトリを消す", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const seen: { probePath?: string; detectPath?: string; detectThreshold?: number; fileBytesAtProbe?: number } = {};
    const result = await expectNoTempDirLeft(() =>
      analyzeVideo(baseInput(), {
        fetchImpl,
        probe: async (filePath) => {
          seen.probePath = filePath;
          seen.fileBytesAtProbe = (await stat(filePath)).size;
          return PROBE;
        },
        detect: async (filePath, threshold) => {
          seen.detectPath = filePath;
          seen.detectThreshold = threshold;
          // 長さ超過（20000）と負（-5）と重複（4200）は捨てられる
          return [4200, 1500, 20_000, -5, 4200, 9000];
        },
      }),
    );

    expect(result.row).toEqual({
      media_id: "00000000000000001",
      analyzer_version: "1",
      scene_threshold: DEFAULT_SCENE_THRESHOLD,
      status: "success",
      error: null,
      analyzed_at: NOW,
      duration_ms: 15_000,
      width: 1080,
      height: 1920,
      fps: 30,
      bitrate: 4_500_000,
      file_size: 8_437_500,
      has_audio: true,
      cut_count: 3,
      avg_scene_ms: 3750,
      first_cut_ms: 1500,
      cuts_in_first_3s: 1,
      cuts_in_last_3s: 0,
    });
    expect(result.cuts).toEqual([
      { seq: 1, at_ms: 1500, scene_score: null },
      { seq: 2, at_ms: 4200, scene_score: null },
      { seq: 3, at_ms: 9000, scene_score: null },
    ]);
    expect(result.failureClass).toBeUndefined();
    expect(calls()).toBe(1);

    // 一時ディレクトリは os.tmpdir() 直下の TMP_DIR_PREFIX + 'video-' で始まり、probe と detect に同じファイルを渡す
    expect(seen.probePath).toBeDefined();
    expect(seen.detectPath).toBe(seen.probePath);
    expect(seen.detectThreshold).toBe(DEFAULT_SCENE_THRESHOLD);
    const dir = dirname(seen.probePath ?? "");
    expect(dirname(dir)).toBe(tmpdir());
    expect(basename(dir).startsWith(VIDEO_TMP_PREFIX)).toBe(true);
    expect(seen.fileBytesAtProbe).toBe("fake video bytes".length);
    expect(await exists(dir)).toBe(false);
  });

  it("sceneThreshold を渡すと detect と行の scene_threshold に使う", async () => {
    const { fetchImpl } = fakeFetch();
    let threshold: number | undefined;
    const result = await analyzeVideo(baseInput({ sceneThreshold: 0.5 }), {
      fetchImpl,
      probe: async () => PROBE,
      detect: async (_path, t) => {
        threshold = t;
        return [];
      },
    });
    expect(threshold).toBe(0.5);
    expect(result.row.scene_threshold).toBe(0.5);
    expect(result.row.status).toBe("success");
    expect(result.row.cut_count).toBe(0);
    expect(result.row.avg_scene_ms).toBe(15_000);
    expect(result.row.first_cut_ms).toBeNull();
    expect(result.cuts).toEqual([]);
  });

  it("probe が返さない項目（width、fps など）は null になる", async () => {
    const { fetchImpl } = fakeFetch();
    const result = await analyzeVideo(baseInput(), {
      fetchImpl,
      probe: async () => ({
        durationMs: 3000,
        width: undefined,
        height: undefined,
        fps: undefined,
        bitrate: undefined,
        fileSize: undefined,
        hasAudio: false,
      }),
      detect: async () => [1000],
    });
    expect(result.row.status).toBe("success");
    expect(result.row.width).toBeNull();
    expect(result.row.height).toBeNull();
    expect(result.row.fps).toBeNull();
    expect(result.row.bitrate).toBeNull();
    expect(result.row.file_size).toBeNull();
    expect(result.row.has_audio).toBe(false);
    expect(result.row.duration_ms).toBe(3000);
    expect(result.row.cut_count).toBe(1);
  });

  it("許可されていないホストは fetch を呼ばずに failed にし、error は固定文言で URL を含まない。一時ディレクトリも残らない", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const { mask, inputs } = fakeMask();
    const result = await expectNoTempDirLeft(() =>
      analyzeVideo(baseInput({ videoUrl: "https://example.com/video.mp4", mask }), {
        fetchImpl,
        probe: async () => PROBE,
        detect: async () => [],
      }),
    );
    expect(result.row).toEqual({
      media_id: "00000000000000001",
      analyzer_version: "1",
      scene_threshold: DEFAULT_SCENE_THRESHOLD,
      status: "failed",
      error: "許可されていない URL",
      analyzed_at: NOW,
      ...NULL_METRICS,
    });
    expect(result.cuts).toEqual([]);
    expect(result.failureClass).toBe("download");
    expect(calls()).toBe(0);
    expect(inputs).toEqual([]); // DownloadError は mask を通さない（固定文言）
  });

  it("HTTP 404 は failed で error は 'HTTP 404'", async () => {
    const fetchImpl: typeof fetch = async () => new Response("not found", { status: 404 });
    const result = await expectNoTempDirLeft(() =>
      analyzeVideo(baseInput(), { fetchImpl, probe: async () => PROBE, detect: async () => [] }),
    );
    expect(result.row.status).toBe("failed");
    expect(result.row.error).toBe("HTTP 404");
    expect(result.row.error).not.toContain("://");
    expect(result.failureClass).toBe("download");
  });

  it("probe が投げると failed で、error は mask を通した message。一時ディレクトリは残らない", async () => {
    const { fetchImpl } = fakeFetch();
    const { mask, inputs } = fakeMask();
    let probePath: string | undefined;
    let detectCalls = 0;
    const result = await expectNoTempDirLeft(() =>
      analyzeVideo(baseInput({ mask }), {
        fetchImpl,
        probe: async (filePath) => {
          probePath = filePath;
          throw new Error(`ffprobe が終了コード 1 で失敗しました: ${VIDEO_URL}`);
        },
        detect: async () => {
          detectCalls += 1;
          return [];
        },
      }),
    );
    expect(result.row.status).toBe("failed");
    expect(result.row.error).toBe("ffprobe が終了コード 1 で失敗しました: <url>");
    expect(result.row.error).not.toContain("cdninstagram");
    expect(result.failureClass).toBe("unknown");
    expect(inputs).toHaveLength(1);
    expect(result.row).toMatchObject(NULL_METRICS);
    expect(result.cuts).toEqual([]);
    expect(detectCalls).toBe(0);
    expect(probePath).toBeDefined();
    expect(await exists(dirname(probePath ?? ""))).toBe(false);
  });

  it("probe が CommandError（stderr の末尾にパスを含む）を投げると、error は固定文言で mask を通さない", async () => {
    const { fetchImpl } = fakeFetch();
    const { mask, inputs } = fakeMask();
    const result = await expectNoTempDirLeft(() =>
      analyzeVideo(baseInput({ mask }), {
        fetchImpl,
        probe: async (filePath) => {
          throw new CommandError("ffprobe", 1, `ffprobe が終了コード 1 で失敗しました:\n${filePath}: Invalid data found`);
        },
        detect: async () => [],
      }),
    );
    expect(result.row.status).toBe("failed");
    expect(result.row.error).toBe("動画の解析に失敗（ffprobe、終了コード 1）");
    expect(result.row.error).not.toContain(VIDEO_TMP_PREFIX);
    expect(result.failureClass).toBe("unknown");
    expect(inputs).toEqual([]);
  });

  it("detect が制限時間の超過（CommandError で code が null）なら error は '終了コード なし'", async () => {
    const { fetchImpl } = fakeFetch();
    const result = await expectNoTempDirLeft(() =>
      analyzeVideo(baseInput(), {
        fetchImpl,
        probe: async () => PROBE,
        detect: async () => {
          throw new CommandError("ffmpeg", null, "ffmpeg が制限時間を超えた");
        },
      }),
    );
    expect(result.row.status).toBe("failed");
    expect(result.row.error).toBe("動画の解析に失敗（ffmpeg、終了コード なし）");
    expect(result.row).toMatchObject(NULL_METRICS);
    expect(result.failureClass).toBe("unknown");
  });

  it("一時ディレクトリを作れなければ fetch を呼ばずに failed で、error は固定文言（パスを含まない）", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const missingRoot = join(tmpdir(), `instagram-analyze-missing-root-${Date.now()}`);
    const result = await analyzeVideo(baseInput(), {
      fetchImpl,
      probe: async () => PROBE,
      detect: async () => [],
      tmpRoot: missingRoot,
    });
    expect(result.row.status).toBe("failed");
    expect(result.row.error).toBe(TEMP_DIR_ERROR);
    expect(result.row.error).not.toContain("missing-root");
    expect(result.failureClass).toBe("unknown");
    expect(result.cuts).toEqual([]);
    expect(calls()).toBe(0);
  });

  it("detect が投げると failed で、probe の値も残さない（計測値はすべて null）", async () => {
    const { fetchImpl } = fakeFetch();
    const { mask } = fakeMask();
    let detectPath: string | undefined;
    const result = await expectNoTempDirLeft(() =>
      analyzeVideo(baseInput({ mask }), {
        fetchImpl,
        probe: async () => PROBE,
        detect: async (filePath) => {
          detectPath = filePath;
          throw new Error("ffmpeg が終了コード 1 で失敗しました");
        },
      }),
    );
    expect(result.row.status).toBe("failed");
    expect(result.row.error).toBe("ffmpeg が終了コード 1 で失敗しました");
    expect(result.row).toMatchObject(NULL_METRICS);
    expect(result.cuts).toEqual([]);
    expect(await exists(dirname(detectPath ?? ""))).toBe(false);
  });

  it("Error でないものが投げられたら error は '不明なエラー'", async () => {
    const { fetchImpl } = fakeFetch();
    const result = await expectNoTempDirLeft(() =>
      analyzeVideo(baseInput(), {
        fetchImpl,
        probe: async () => {
          throw "文字列の例外";
        },
        detect: async () => [],
      }),
    );
    expect(result.row.status).toBe("failed");
    expect(result.row.error).toBe("不明なエラー");
  });

  it("fetch の例外は failed で error は 'ネットワークエラー'", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError(`unexpected redirect from ${VIDEO_URL}`);
    };
    const result = await expectNoTempDirLeft(() =>
      analyzeVideo(baseInput(), { fetchImpl, probe: async () => PROBE, detect: async () => [] }),
    );
    expect(result.row.status).toBe("failed");
    expect(result.row.error).toBe("ネットワークエラー");
    expect(result.row.error).not.toContain("://");
  });

  it("サイズ上限を超えたら failed で error は 'サイズ上限を超過'", async () => {
    const { fetchImpl } = fakeFetch("x".repeat(64));
    const result = await expectNoTempDirLeft(() =>
      analyzeVideo(baseInput({ limits: { ...LIMITS, maxBytes: 16 } }), {
        fetchImpl,
        probe: async () => PROBE,
        detect: async () => [],
      }),
    );
    expect(result.row.status).toBe("failed");
    expect(result.row.error).toBe("サイズ上限を超過");
  });

  it("一時ファイルのパスは os.tmpdir() 配下にあり、同じ呼び出しの中で probe と detect の両方に渡る", async () => {
    const { fetchImpl } = fakeFetch();
    const paths: string[] = [];
    await analyzeVideo(baseInput(), {
      fetchImpl,
      probe: async (p) => {
        paths.push(p);
        return PROBE;
      },
      detect: async (p) => {
        paths.push(p);
        return [];
      },
    });
    expect(paths).toHaveLength(2);
    expect(paths[0]).toBe(paths[1]);
    expect(paths[0]?.startsWith(join(tmpdir(), VIDEO_TMP_PREFIX))).toBe(true);
  });
});

describe("R4: analyzeVideo の入力の制限、制限時間、点数（R4 設計 3.2 節、3.5 節、4.3 節）", () => {
  it("長さが 15 分を超えたらシーン検出をせず failed（固定文言）。15 分ちょうどは検出する", async () => {
    let detectCalls = 0;
    const detect = async () => {
      detectCalls += 1;
      return [];
    };
    const long = await analyzeVideo(baseInput(), {
      fetchImpl: fakeFetch().fetchImpl,
      probe: async () => ({ ...PROBE, durationMs: MAX_VIDEO_DURATION_MS + 1 }),
      detect,
    });
    expect(long.row).toMatchObject({ status: "failed", error: VIDEO_TOO_LONG_ERROR, duration_ms: null });
    expect(long.failureClass).toBe("unknown");
    expect(detectCalls).toBe(0);
    const edge = await analyzeVideo(baseInput(), {
      fetchImpl: fakeFetch().fetchImpl,
      probe: async () => ({ ...PROBE, durationMs: MAX_VIDEO_DURATION_MS }),
      detect,
    });
    expect(edge.row.status).toBe("success");
    expect(detectCalls).toBe(1);
  });

  it("シーン検出の制限時間に max(60 秒, 長さ × 3)（上限 5 分）を渡す。長さ 0 でも 60 秒で、success（avg_scene_ms は null）", async () => {
    const seen: (number | undefined)[] = [];
    const detect = async (_p: string, _t: number, timeoutMs?: number) => {
      seen.push(timeoutMs);
      return [];
    };
    await analyzeVideo(baseInput(), { fetchImpl: fakeFetch().fetchImpl, probe: async () => ({ ...PROBE, durationMs: 40_000 }), detect });
    await analyzeVideo(baseInput(), { fetchImpl: fakeFetch().fetchImpl, probe: async () => ({ ...PROBE, durationMs: 600_000 }), detect });
    const zero = await analyzeVideo(baseInput(), { fetchImpl: fakeFetch().fetchImpl, probe: async () => ({ ...PROBE, durationMs: 0 }), detect });
    expect(seen).toEqual([120_000, 300_000, 60_000]);
    expect(zero.row).toMatchObject({ status: "success", duration_ms: 0, avg_scene_ms: null, cut_count: 0 });
  });

  it("ダウンロードの content-type が video/ でなければ failed（download）で、probe も detect も呼ばない", async () => {
    let probeCalls = 0;
    const fetchImpl: typeof fetch = async () =>
      new Response(streamOf([encoder.encode("<html>")]), { status: 200, headers: { "content-type": "text/html" } });
    const result = await analyzeVideo(baseInput(), {
      fetchImpl,
      probe: async () => {
        probeCalls += 1;
        return PROBE;
      },
      detect: async () => [],
    });
    expect(result.row).toMatchObject({ status: "failed", error: "content-type が想定外" });
    expect(result.failureClass).toBe("download");
    expect(probeCalls).toBe(0);
  });

  it("detect の点数を cuts の scene_score に入れる（時刻は normalizeCutTimes と同じ規則で整える）", async () => {
    const result = await analyzeVideo(baseInput(), {
      fetchImpl: fakeFetch().fetchImpl,
      probe: async () => PROBE,
      detect: async () => [
        { atMs: 4200.4, score: 0.5 },
        { atMs: 1500, score: 0.312345 },
        { atMs: 1500, score: 0.9 },
        { atMs: 999_999, score: 0.8 },
      ],
    });
    expect(result.cuts).toEqual([
      { seq: 1, at_ms: 1500, scene_score: 0.312345 },
      { seq: 2, at_ms: 4200, scene_score: 0.5 },
    ]);
    expect(result.row.cut_count).toBe(2);
  });
});

describe("normalizeSceneChanges", () => {
  it("数値だけの要素は点数 null。時刻は normalizeCutTimes と同じ列になる", () => {
    const input = [3000, { atMs: -1, score: 0.5 }, { atMs: 2000, score: Number.NaN }, Number.NaN, 2000.6];
    const out = normalizeSceneChanges(10_000, input);
    expect(out).toEqual([
      { at_ms: 2000, scene_score: null },
      { at_ms: 2001, scene_score: null },
      { at_ms: 3000, scene_score: null },
    ]);
    expect(out.map((c) => c.at_ms)).toEqual(normalizeCutTimes(10_000, [3000, -1, 2000, Number.NaN, 2000.6]));
  });
});
