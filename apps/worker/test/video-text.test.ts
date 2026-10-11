/**
 * `lib/video-text.ts` の純粋関数（R4.1 設計 3.4 節、4 章、8 章）。DB と API に触らない。
 * ゴールデン テストは `test/fixtures/vision/frames-caption-sign.json`（`segmenter_version` を上げるときは差分を検討メモに記録する）
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  codePoints,
  editDistance,
  frameLines,
  frameTimes,
  normalizeText,
  OCR_METHOD,
  OCR_VERSION,
  FRAME_INTERVAL_MS,
  SEGMENTER_PARAMS,
  SEGMENTER_VERSION,
  segmentFrames,
  summarizeSegments,
  TEXT_ANALYZER_VERSION,
  textSimilarity,
  VIDEO_TEXT_MAX_ATTEMPTS,
  VIDEO_TEXT_MAX_DURATION_MS,
  type FrameWord,
  type OcrFrame,
  type TextSegment,
} from "../src/lib/video-text.js";

interface Fixture {
  durationMs: number;
  imageWidth: number;
  imageHeight: number;
  frames: OcrFrame[];
  expectedSegments: TextSegment[];
  expectedFeatures: Record<string, unknown>;
}

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/vision/frames-caption-sign.json", import.meta.url)), "utf8"),
) as Fixture;

const W = 720;
const H = 1280;

/** 1 語で 1 行を作る（`b` を行ごとに変える） */
function word(
  t: string,
  over: Partial<FrameWord> & { x0?: number; y0?: number; x1?: number; y1?: number } = {},
): FrameWord {
  return { b: 0, p: 0, t, c: 0.99, l: "ja", x0: 200, y0: 300, x1: 520, y1: 345, br: "LINE_BREAK", ...over };
}

/** 各行を別の block にしたフレーム */
function frame(atMs: number, ...words: FrameWord[]): OcrFrame {
  return { atMs, words: words.map((w, i) => ({ ...w, b: i })) };
}

function segment(frames: OcrFrame[], durationMs = 10_000): TextSegment[] {
  return segmentFrames(frames, { durationMs, imageWidth: W, imageHeight: H });
}

describe("定数", () => {
  it("OCR の条件と上限（設計 3.1 節、3.2 節）", () => {
    expect([OCR_METHOD, OCR_VERSION, FRAME_INTERVAL_MS, TEXT_ANALYZER_VERSION, SEGMENTER_VERSION]).toEqual([
      "google_vision",
      "v1/DOCUMENT_TEXT_DETECTION",
      1000,
      "1",
      "1",
    ]);
    expect(VIDEO_TEXT_MAX_ATTEMPTS).toBe(5);
    expect(VIDEO_TEXT_MAX_DURATION_MS).toBe(180_000);
    expect(SEGMENTER_PARAMS.minLineConfidence).toBe(0.5);
  });
});

describe("frameTimes", () => {
  it("0 を含み、duration_ms ちょうどは含めない。カット直後を優先し、300 ms 未満の間隔のものを捨てる", () => {
    const frames = frameTimes(5000, [1000, 3800]);
    expect(frames).toEqual([
      { atMs: 0, source: "interval" },
      { atMs: 1100, source: "cut" },
      { atMs: 2000, source: "interval" },
      { atMs: 3000, source: "interval" },
      { atMs: 3900, source: "cut" },
    ]);
    // 4000 はカット直後 3900 と 100 ms しか離れていないので捨てる。5000（duration ちょうど）は含めない
  });

  it("300 ms 未満のカットが 3 連続なら、残したものから 300 ms 以上離れたものだけ残す", () => {
    expect(frameTimes(3000, [1000, 1200, 1400]).map((f) => f.atMs)).toEqual([0, 1100, 1500, 2000]);
  });

  it("カットが 0 ms なら 100 ms のカット直後が 0 ms の間隔より優先される", () => {
    expect(frameTimes(2500, [0]).map((f) => [f.atMs, f.source])).toEqual([
      [100, "cut"],
      [1000, "interval"],
      [2000, "interval"],
    ]);
  });

  it("カットが duration_ms の直前なら at_ms が duration_ms 以上になり捨てる", () => {
    expect(frameTimes(2050, [2000]).map((f) => f.atMs)).toEqual([0, 1000, 2000]);
    expect(frameTimes(2150, [2000]).map((f) => f.atMs)).toEqual([0, 1000, 2100]);
  });

  it("カット 0 回なら間隔だけ。duration_ms が 0 以下や数値でなければ空", () => {
    expect(frameTimes(2999, []).map((f) => f.atMs)).toEqual([0, 1000, 2000]);
    expect(frameTimes(0, [100])).toEqual([]);
    expect(frameTimes(-1, [])).toEqual([]);
    expect(frameTimes(Number.NaN, [])).toEqual([]);
  });

  it("設計の例: 21.2 秒、1 秒ごとに 19 回のカット → 22 枚", () => {
    const cuts = Array.from({ length: 19 }, (_, i) => (i + 1) * 1000);
    const frames = frameTimes(21_200, cuts);
    expect(frames).toHaveLength(22);
    expect(frames.filter((f) => f.source === "cut")).toHaveLength(19);
    expect(frames.filter((f) => f.source === "interval").map((f) => f.atMs)).toEqual([0, 20_000, 21_000]);
  });
});

describe("normalizeText / codePoints / editDistance", () => {
  it("NFKC の全角英数、全角空白、大文字、結合濁点、半角カナ、絵文字、記号だけ", () => {
    expect(normalizeText("ＡＢＣ１２３")).toBe("abc123");
    expect(normalizeText("溝口　から 徒歩\t4分\n")).toBe("溝口から徒歩4分");
    expect(normalizeText("Hello World")).toBe("helloworld");
    expect(normalizeText("が")).toBe("が");
    expect(normalizeText("ｶﾌｪ")).toBe("カフェ");
    expect(normalizeText("😀 OK")).toBe("😀ok");
    expect(normalizeText("!?・")).toBe("!?・");
    expect(normalizeText("   ")).toBe("");
  });

  it("codePoints は絵文字を 1 文字に数え、editDistance はコードポイントで計算する", () => {
    expect(codePoints("a😀b")).toEqual(["a", "😀", "b"]);
    expect(codePoints("a😀b")).toHaveLength(3);
    expect(editDistance(codePoints("溝口から徒歩4分"), codePoints("溝口から徒歩4分"))).toBe(0);
    expect(editDistance(codePoints("かな"), codePoints("がな"))).toBe(1);
    expect(editDistance(codePoints("😀b"), codePoints("b"))).toBe(1);
    expect(editDistance([], codePoints("abc"))).toBe(3);
  });
});

describe("textSimilarity", () => {
  it("包含は短い方 ÷ 長い方が 0.5 以上。短い文字は編集距離 1、長い文字は 0.7 以上", () => {
    expect(textSimilarity("から徒歩4分", "溝口から徒歩4分")).toEqual({ contain: true, score: 0.75 });
    expect(textSimilarity("4分", "溝口から徒歩4分")).toBeUndefined();
    expect(textSimilarity("かな", "がな")).toEqual({ contain: false, score: 0.5 });
    expect(textSimilarity("かなた", "がねた")).toBeUndefined();
    expect(textSimilarity("溝口から徒歩4分", "溝口から徒歩4介")).toEqual({ contain: false, score: 0.875 });
    expect(textSimilarity("溝口から徒歩4分", "溝口がら徒歩5介")).toBeUndefined();
    expect(textSimilarity("", "a")).toBeUndefined();
  });
});

describe("frameLines", () => {
  it("段落ごとに語を連結し、LINE_BREAK／EOL_SURE_SPACE で行を分け、SPACE／SURE_SPACE は空白、HYPHEN はハイフン", () => {
    const lines = frameLines({
      words: [
        word("Hello", { b: 0, x0: 0, x1: 50, br: "SPACE" }),
        word("World", { b: 0, x0: 55, x1: 110, br: "EOL_SURE_SPACE" }),
        word("second", { b: 0, y0: 400, y1: 440, x0: 0, x1: 60, br: "SURE_SPACE" }),
        word("line", { b: 0, y0: 400, y1: 440, x0: 65, x1: 100, br: "LINE_BREAK" }),
        word("co", { b: 1, y0: 600, y1: 640, x0: 0, x1: 20, br: "HYPHEN" }),
        word("op", { b: 1, y0: 600, y1: 640, x0: 25, x1: 50, br: null }),
      ],
    });
    expect(lines.map((l) => l.text)).toEqual(["Hello World", "second line", "co-op"]);
    expect(lines.map((l) => l.norm)).toEqual(["helloworld", "secondline", "co-op"]);
    expect(lines[0]?.box).toEqual({ x0: 0, y0: 300, x1: 110, y1: 345 });
  });

  it("日本語は空白なしで連結する。確信度は平均、文字の高さは中央値、言語は最頻値（null を除く）", () => {
    const lines = frameLines({
      words: [
        word("溝口", { c: 0.9, l: "ja", x0: 200, x1: 300, br: null }),
        word("から", { c: 1.0, l: null, x0: 300, x1: 400, y1: 400, br: null }),
        word("徒歩", { c: 0.8, l: "en", x0: 400, x1: 500, br: "LINE_BREAK" }),
      ],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe("溝口から徒歩");
    expect(lines[0]?.confidence).toBeCloseTo(0.9, 10);
    expect(lines[0]?.charHeight).toBe(45);
    expect(lines[0]?.lang).toBe("en");
  });

  it("行の順は (y0, x0, norm)。全部 null の言語は null。語がなければ空", () => {
    const lines = frameLines({
      words: [
        word("b", { b: 0, y0: 500, y1: 520, x0: 10, x1: 20, l: null }),
        word("a", { b: 1, y0: 500, y1: 520, x0: 10, x1: 20, l: null }),
        word("c", { b: 2, y0: 100, y1: 120, x0: 50, x1: 60, l: null }),
        word("d", { b: 3, y0: 500, y1: 520, x0: 5, x1: 8, l: null }),
      ],
    });
    expect(lines.map((l) => l.text)).toEqual(["c", "d", "a", "b"]);
    expect(lines[0]?.lang).toBeNull();
    expect(frameLines({ words: [] })).toEqual([]);
  });

  it("縦書き（1 語ずつ改行）は語ごとに行になる", () => {
    const lines = frameLines({
      words: [
        word("営", { y0: 100, y1: 140, x0: 600, x1: 640 }),
        word("業", { y0: 140, y1: 180, x0: 600, x1: 640 }),
        word("中", { y0: 180, y1: 220, x0: 600, x1: 640 }),
      ],
    });
    expect(lines.map((l) => l.text)).toEqual(["営", "業", "中"]);
  });
});

describe("segmentFrames", () => {
  const caption = (atMs: number, t = "溝口から徒歩4分", over: Partial<FrameWord> = {}): OcrFrame => frame(atMs, word(t, over));

  it("同じ文字が続けば 1 区間。end_ms は最後の観測の次の計画フレーム。最後の計画フレームでだけ観測なら duration_ms", () => {
    const frames = [caption(0), caption(1000), caption(2000), frame(3000), frame(4000)];
    const segments = segment(frames, 4500);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ seq: 1, text: "溝口から徒歩4分", start_ms: 0, end_ms: 3000, frame_count: 3, is_caption_like: true });
    const last = segment([frame(0), frame(1000), caption(2000), caption(3000)], 4500);
    expect(last[0]).toMatchObject({ start_ms: 2000, end_ms: 4500, frame_count: 2 });
  });

  it("1 枚の見落とし（添字の差 2）は同じ区間。カット直後の挿入で添字が増えれば別の区間になる", () => {
    const frames = [caption(0), frame(1000), caption(2000)];
    expect(segment(frames, 3000)).toHaveLength(1);
    expect(segment(frames, 3000)[0]).toMatchObject({ frame_count: 2, start_ms: 0, end_ms: 3000 });
    const withCut = [caption(0), frame(1000), frame(1100), caption(2000)];
    expect(segment(withCut, 3000)).toHaveLength(2);
  });

  it("包含（から徒歩4分 ⊂ 溝口から徒歩4分）と 1 文字の読み違い、2〜5 文字の 1 文字違いは同じ区間", () => {
    const a = segment([caption(0), caption(1000, "から徒歩4分", { x0: 330 }), caption(2000)], 3000);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ text: "溝口から徒歩4分", frame_count: 3 });
    const b = segment([caption(0), caption(1000, "溝口から徒歩4介"), caption(2000)], 3000);
    expect(b).toHaveLength(1);
    const c = segment([caption(0, "かな"), caption(1000, "がな"), caption(2000, "かな")], 3000);
    expect(c).toHaveLength(1);
    const d = segment([caption(0, "かなた"), caption(1000, "がねた")], 3000);
    expect(d).toHaveLength(2);
  });

  it("位置が違えば別の区間。同じ文字が上下 2 か所なら 2 区間", () => {
    const top = word("営業中", { y0: 100, y1: 140 });
    const bottom = word("営業中", { y0: 1100, y1: 1140 });
    const segments = segment([frame(0, top, bottom), frame(1000, top, bottom)], 2000);
    expect(segments).toHaveLength(2);
    expect(segments.map((s) => s.vertical_position)).toEqual(["top", "bottom"]);
    const moved = segment([caption(0), caption(1000, "溝口から徒歩4分", { y0: 600, y1: 645 })], 2000);
    expect(moved).toHaveLength(2);
  });

  it("断片「MU溝」（1 フレーム、本体の区間と重なる）は捨てる。割れた断片が 2 フレーム続けば残る", () => {
    const split = frame(1000, word("MU溝", { x0: 200, x1: 330, c: 0.6 }), word("から徒歩4分", { x0: 330 }));
    const once = segment([caption(0), split, caption(2000)], 3000);
    expect(once.map((s) => s.text)).toEqual(["溝口から徒歩4分"]);
    const twice = segment([caption(0), split, { ...split, atMs: 2000 }, caption(3000)], 4000);
    expect(twice.map((s) => s.text).sort()).toEqual(["MU溝", "溝口から徒歩4分"]);
  });

  it("1 フレームで 2 文字以下は捨てる。2 文字が 2 フレーム続けば残る。確信度ちょうど 0.5 は使い、未満は捨てる", () => {
    expect(segment([frame(0, word("OK")), frame(1000)], 2000)).toEqual([]);
    expect(segment([frame(0, word("OK")), frame(1000, word("OK"))], 2000)).toHaveLength(1);
    expect(segment([caption(0, "ランチ", { c: 0.5 }), caption(1000, "ランチ", { c: 0.5 })], 2000)).toHaveLength(1);
    expect(segment([caption(0, "ランチ", { c: 0.49 }), caption(1000, "ランチ", { c: 0.49 })], 2000)).toEqual([]);
  });

  it("縦にずれていくテロップは中心 y の平均から 15% 以内なら同じ区間", () => {
    const frames = [0, 1000, 2000, 3000].map((atMs, i) => caption(atMs, "溝口から徒歩4分", { y0: 300 + i * 60, y1: 345 + i * 60 }));
    expect(segment(frames, 4000)).toHaveLength(1);
    const far = [0, 1000].map((atMs, i) => caption(atMs, "溝口から徒歩4分", { y0: 300 + i * 300, y1: 345 + i * 300 }));
    expect(segment(far, 2000)).toHaveLength(2);
  });

  it("空白を含む英文は norm で比べる。全フレーム文字なし・空の入力は空", () => {
    const en = (atMs: number, t: string) => frame(atMs, word(t, { br: "LINE_BREAK" }));
    const segments = segment([en(0, "Open Now"), en(1000, "OPEN NOW")], 2000);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.text_norm).toBe("opennow");
    expect(segment([frame(0), frame(1000)], 2000)).toEqual([]);
    expect(segment([], 2000)).toEqual([]);
  });

  it("入力のフレームと行の順を変えても同じ結果", () => {
    const f1 = frame(0, word("営業中", { b: 0, y0: 1100, y1: 1140 }), word("溝口から徒歩4分", { b: 1 }));
    const f2 = frame(1000, word("溝口から徒歩4分", { b: 0 }), word("営業中", { b: 1, y0: 1100, y1: 1140 }));
    const a = segment([f1, f2], 2000);
    const b = segment([f2, { ...f1, words: [...f1.words].reverse() }], 2000);
    expect(a).toEqual(b);
    expect(a.map((s) => s.seq)).toEqual([1, 2]);
  });

  it("テロップらしさ: 高さ 2.5%、中央 ±20%、確信度 0.9 のすべてを満たすときだけ。1 フレームでも真（captionMinFrames = 1）", () => {
    expect(SEGMENTER_PARAMS.captionMinFrames).toBe(1);
    const small = segment([caption(0, "ランチ", { y1: 330 }), caption(1000, "ランチ", { y1: 330 })], 2000);
    expect(small[0]?.is_caption_like).toBe(false);
    const side = segment([caption(0, "ランチ", { x0: 0, x1: 120 }), caption(1000, "ランチ", { x0: 0, x1: 120 })], 2000);
    expect(side[0]?.is_caption_like).toBe(false);
    const low = segment([caption(0, "ランチ", { c: 0.85 }), caption(1000, "ランチ", { c: 0.85 })], 2000);
    expect(low[0]?.is_caption_like).toBe(false);
    const once = segment([caption(0, "ランチ"), frame(1000), frame(2000)], 3000);
    expect(once[0]?.is_caption_like).toBe(true);
    // 2 フレーム以上を求める設定（以前の値）なら 1 フレームは偽
    const strict = segmentFrames([caption(0, "ランチ"), frame(1000)], {
      durationMs: 2000,
      imageWidth: W,
      imageHeight: H,
      params: { ...SEGMENTER_PARAMS, captionMinFrames: 2 },
    });
    expect(strict[0]?.is_caption_like).toBe(false);
    const ok = segment([caption(0, "ランチ"), caption(1000, "ランチ")], 2000);
    expect(ok[0]?.is_caption_like).toBe(true);
  });
});

describe("summarizeSegments", () => {
  const seg = (over: Partial<TextSegment>): TextSegment => ({
    seq: 1,
    text: "x",
    text_norm: "x",
    start_ms: 0,
    end_ms: 1000,
    vertical_position: "top",
    center_x_ratio: 0.5,
    center_y_ratio: 0.2,
    char_height_ratio: 0.03,
    confidence: 0.99,
    frame_count: 2,
    lang: "ja",
    is_caption_like: false,
    ...over,
  });

  it("和集合の表示割合（上下 2 か所の区間は 1 回だけ）、重複除去の総文字数、小数 4 桁", () => {
    const segments = [
      seg({ text_norm: "営業中", start_ms: 1000, end_ms: 4000 }),
      seg({ text_norm: "営業中", start_ms: 2000, end_ms: 5000 }),
      seg({ text_norm: "ランチ", start_ms: 7000, end_ms: 8000 }),
    ];
    const f = summarizeSegments(segments, [], 9000);
    expect(f.text_coverage_ratio).toBe(0.5556);
    expect(f.total_text_chars).toBe(6);
    expect(f.segment_count).toBe(3);
    expect(f.first_text_ms).toBe(1000);
  });

  it("start_ms = 2999 は冒頭 3 秒、3000 は含めない。区間なしは 0 と null と false", () => {
    expect(summarizeSegments([seg({ start_ms: 2999, end_ms: 4000 })], [], 5000).has_text_in_first_3s).toBe(true);
    expect(summarizeSegments([seg({ start_ms: 3000, end_ms: 4000 })], [], 5000).has_text_in_first_3s).toBe(false);
    expect(summarizeSegments([], [], 5000)).toEqual({
      first_text_ms: null,
      has_text_in_first_3s: false,
      text_coverage_ratio: 0,
      total_text_chars: 0,
      segment_count: 0,
      max_chars_per_frame: 0,
      avg_chars_per_frame: 0,
      caption_first_text_ms: null,
      caption_has_text_in_first_3s: false,
      caption_coverage_ratio: 0,
      caption_total_chars: 0,
    });
  });

  it("duration_ms が 0 なら表示割合は null", () => {
    const f = summarizeSegments([seg({})], [], 0);
    expect(f.text_coverage_ratio).toBeNull();
    expect(f.caption_coverage_ratio).toBeNull();
  });

  it("caption_* は is_caption_like の区間だけ", () => {
    const f = summarizeSegments(
      [seg({ text_norm: "a", start_ms: 0, end_ms: 1000 }), seg({ text_norm: "bb", start_ms: 4000, end_ms: 5000, is_caption_like: true })],
      [],
      10_000,
    );
    expect(f).toMatchObject({ first_text_ms: 0, caption_first_text_ms: 4000, caption_has_text_in_first_3s: false, caption_total_chars: 2, caption_coverage_ratio: 0.1 });
  });

  it("max_chars_per_frame は断片を含み、確信度 0.5 未満の行を除く。avg は文字のないフレームを 0 として小数 2 桁", () => {
    const frames = [
      frame(0),
      frame(1000, word("溝口から徒歩4分"), word("MU溝", { x0: 200, x1: 330 }), word("低い", { c: 0.3, y0: 900, y1: 930 })),
      frame(2000, word("営業中", { y0: 1100, y1: 1130 })),
    ];
    const f = summarizeSegments([], frames, 3000);
    expect(f.max_chars_per_frame).toBe(11);
    expect(f.avg_chars_per_frame).toBe(4.67);
  });
});

describe("ゴールデン テスト（fixtures/vision/frames-caption-sign.json）", () => {
  it("segmentFrames と summarizeSegments の結果が固定データと一致する", () => {
    const segments = segmentFrames(fixture.frames, {
      durationMs: fixture.durationMs,
      imageWidth: fixture.imageWidth,
      imageHeight: fixture.imageHeight,
    });
    expect(segments).toEqual(fixture.expectedSegments);
    expect(summarizeSegments(segments, fixture.frames, fixture.durationMs)).toEqual(fixture.expectedFeatures);
  });
});

/* ------------------------------------------------------------------
 * 8 章と突き合わせて足した端の場合（結合濁点、絵文字、代表の文字、候補の優先、位置の境界、画像の大きさ 0）
 * ------------------------------------------------------------------ */

describe("結合濁点と絵文字（コードポイントで数える）", () => {
  it("結合濁点 U+3099 は NFKC で合成される。正規化前は 2 コードポイント、後は 1 で、合成済みと同じ値", () => {
    const decomposed = "\u304b\u3099"; // か + 結合濁点
    expect(codePoints(decomposed)).toHaveLength(2);
    expect(normalizeText(decomposed)).toBe("\u304c"); // が
    expect(codePoints(normalizeText(decomposed))).toHaveLength(1);
    expect(normalizeText(decomposed)).toBe(normalizeText("\u304c"));
    expect(editDistance(codePoints(normalizeText(decomposed)), codePoints("\u304b"))).toBe(1);
  });

  it("絵文字を含むテロップは区間になり、total_text_chars と max_chars_per_frame は絵文字を 1 文字に数える", () => {
    const frames = [frame(0, word("🍣寿司🍣")), frame(1000, word("🍣寿司🍣")), frame(2000)];
    const segments = segment(frames, 3000);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ text_norm: "🍣寿司🍣", start_ms: 0, end_ms: 2000, frame_count: 2 });
    const f = summarizeSegments(segments, frames, 3000);
    expect(f.total_text_chars).toBe(4);
    expect(f.max_chars_per_frame).toBe(4);
  });

  it("結合濁点のフレームと合成済みのフレームは norm が同じなので 1 区間。text は同数なら長い方（コードポイント）", () => {
    const composed = "すぎなみ";
    const decomposed = "す\u304d\u3099なみ";
    expect(codePoints(decomposed)).toHaveLength(5);
    const segments = segment([frame(0, word(composed)), frame(1000, word(decomposed))], 2000);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ text: decomposed, text_norm: composed, frame_count: 2 });
  });
});

describe("区間の代表の文字と候補の優先", () => {
  const cap = (atMs: number, t: string): OcrFrame => frame(atMs, word(t));

  it("text は観測の最頻値。同数なら長いもの、それも同じなら先に観測したもの", () => {
    const most = segment([cap(0, "溝口から徒歩4介"), cap(1000, "溝口から徒歩4分"), cap(2000, "溝口から徒歩4分")], 3000);
    expect(most).toHaveLength(1);
    expect(most[0]?.text).toBe("溝口から徒歩4分");
    const longer = segment([cap(0, "から徒歩4分"), cap(1000, "溝口から徒歩4分")], 2000);
    expect(longer).toHaveLength(1);
    expect(longer[0]?.text).toBe("溝口から徒歩4分");
    const first = segment([cap(0, "溝口から徒歩4分"), cap(1000, "溝口から徒歩4介")], 2000);
    expect(first).toHaveLength(1);
    expect(first[0]?.text).toBe("溝口から徒歩4分");
  });

  it("同じ行に合う区間が複数なら包含の比が高い区間に結び付け、もう一方は見落としとして続く", () => {
    const a = word("溝口から徒歩4分", { y0: 300, y1: 345 });
    const b = word("溝口から徒歩4分です", { y0: 400, y1: 445 });
    const part = word("から徒歩4分", { y0: 350, y1: 395, x0: 330 });
    const segments = segment([frame(0, a, b), frame(1000, part), frame(2000, a, b)], 3000);
    expect(segments.map((s) => [s.text, s.frame_count])).toEqual([
      ["溝口から徒歩4分", 3],
      ["溝口から徒歩4分です", 2],
    ]);
  });
});

describe("vertical_position の境界と画像の大きさ 0", () => {
  const twice = (y0: number, y1: number): OcrFrame[] => [frame(0, word("ランチ営業中", { y0, y1 })), frame(1000, word("ランチ営業中", { y0, y1 }))];
  const position = (y0: number, y1: number) =>
    segmentFrames(twice(y0, y1), { durationMs: 2000, imageWidth: 720, imageHeight: 1000 })[0]?.vertical_position;

  it("中心 y の比（小数 4 桁）が 1/3 未満は top、2/3 未満は middle、それ以外は bottom", () => {
    expect(position(300, 366)).toBe("top"); // 中心 333 → 0.333
    expect(position(300, 368)).toBe("middle"); // 中心 334 → 0.334
    expect(position(630, 702)).toBe("middle"); // 中心 666 → 0.666
    expect(position(630, 704)).toBe("bottom"); // 中心 667 → 0.667
  });

  it("画像の大きさが 0（保存した幅と高さがない）なら比は 0、テロップらしさは偽、位置の近さは見ない", () => {
    const far = [frame(0, word("ランチ営業中", { y0: 100, y1: 145 })), frame(1000, word("ランチ営業中", { y0: 1100, y1: 1145 }))];
    const segments = segmentFrames(far, { durationMs: 2000, imageWidth: 0, imageHeight: 0 });
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      center_x_ratio: 0,
      center_y_ratio: 0,
      char_height_ratio: 0,
      vertical_position: "top",
      is_caption_like: false,
      frame_count: 2,
    });
  });
});
