/**
 * 動画の画面の文字（R4.1 設計 3.4 節、4 章）の定数と純粋関数。I/O なし。
 *
 * - 定数: OCR の条件（`current_video_text_condition()` と同じ値）、打ち切り、長さの上限、区間化のしきい値
 * - `frameTimes`: 長さとカットからフレームの時刻の計画を作る（3.4 節）
 * - `normalizeText`、`codePoints`、`editDistance`: 文字の正規化と比較（4 章の「文字数」はコードポイント数）
 * - `frameLines`: 切り詰めた語の列から行を復元する（4.1 節）
 * - `segmentFrames`: フレームの行を区間にまとめる（4.2 節、4.3 節）
 * - `summarizeSegments`: 特徴量（4.4 節）
 *
 * 入力が同じなら出力が同じ（`segmenter_version` を上げたときに保存したフレームの結果から API を呼ばずに計算し直す）。
 * しきい値を変えたら `SEGMENTER_VERSION` を上げる
 */

/** OCR の条件（設計 3.1 節の表）。DB の `current_video_text_condition()` と一致させる（結合テストで突き合わせる） */
export const OCR_METHOD = "google_vision";
export const OCR_VERSION = "v1/DOCUMENT_TEXT_DETECTION";
export const FRAME_INTERVAL_MS = 1000;
/** フレームの取り出し方と要求の作り方の版（`video_text_analyses.analyzer_version`。動画の `ANALYZER_VERSION` とは別） */
export const TEXT_ANALYZER_VERSION = "1";
/** 区間化の規則と特徴量の定義の版。変えても API は呼ばない */
export const SEGMENTER_VERSION = "1";

/** 打ち切りの回数（設計 3.6 節。R4 と同じ） */
export const VIDEO_TEXT_MAX_ATTEMPTS = 5;
/** `success` 以外を再試行するまでの時間（設計 3.1 節 (a)） */
export const VIDEO_TEXT_RETRY_AFTER_MS = 3 * 60 * 60 * 1000;
/** 対象にする動画の長さの上限（3 分。設計 3.2 節） */
export const VIDEO_TEXT_MAX_DURATION_MS = 3 * 60 * 1000;
/** 1 本のフレームの取り出し全体の制限（3 分。設計 3.2 節） */
export const VIDEO_TEXT_EXTRACT_BUDGET_MS = 3 * 60 * 1000;
/** フレーム 1 枚の取り出しの制限時間（設計 3.4 節） */
export const FRAME_EXTRACT_TIMEOUT_MS = 15_000;
/** カット直後のずらし（設計 3.4 節） */
export const CUT_OFFSET_MS = 100;
/** 近い時刻をまとめる幅（設計 3.4 節） */
export const MERGE_WINDOW_MS = 300;
/** 1 枚の `words` の上限（設計 4.1 節） */
export const MAX_WORDS_PER_FRAME = 2000;
/** 1 枚の `text` の上限（コードポイント。設計 4.1 節） */
export const MAX_TEXT_CHARS_PER_FRAME = 20_000;

/** 区間化と特徴量のしきい値の形（テストで一部を差し替えるので数値の型にする） */
export interface SegmenterParams {
  minLineConfidence: number;
  maxIndexGap: number;
  containMinRatio: number;
  shortTextMaxLen: number;
  shortTextMaxDistance: number;
  minSimilarity: number;
  centerYTolerance: number;
  fragmentOverlapRatio: number;
  fragmentMaxChars: number;
  captionMinCharHeightRatio: number;
  captionMaxCenterXOffset: number;
  captionMinConfidence: number;
  captionMinFrames: number;
}

/** 区間化と特徴量のしきい値（設計 4.1〜4.3 節）。変えたら `SEGMENTER_VERSION` を上げる */
export const SEGMENTER_PARAMS: Readonly<SegmenterParams> = Object.freeze({
  /** これ未満の確信度の行は区間化に使わない（ちょうどは残す） */
  minLineConfidence: 0.5,
  /** 最後に見えたフレームの添字が `k − maxIndexGap` 以上の区間だけに結び付ける（1 枚の見落としを許す） */
  maxIndexGap: 2,
  /** 包含で同じとみなす短い方 ÷ 長い方の下限 */
  containMinRatio: 0.5,
  /** この長さ以下は編集距離で比べる */
  shortTextMaxLen: 4,
  /** 短い文字で許す編集距離 */
  shortTextMaxDistance: 1,
  /** 長い文字で同じとみなす `1 − 編集距離 ÷ 長さ` の下限 */
  minSimilarity: 0.7,
  /** 中心 y の差の上限（画像の高さに対する比） */
  centerYTolerance: 0.15,
  /** 断片とみなす重なり（自分の面積に対する比） */
  fragmentOverlapRatio: 0.5,
  /** 1 フレームだけの観測で捨てる文字数の上限 */
  fragmentMaxChars: 2,
  /** テロップらしい文字の高さの比の下限（1280 px で 32 px） */
  captionMinCharHeightRatio: 0.025,
  /** テロップらしい中心 x の 0.5 からのずれの上限 */
  captionMaxCenterXOffset: 0.2,
  /** テロップらしい確信度の下限 */
  captionMinConfidence: 0.9,
  /**
   * テロップらしい観測数の下限。2026-10-11 の手元の実行で、カットが 1 秒ごとのリールでは 1 秒ごとに変わるテロップが
   * 1 フレーム（カット直後の 1 枚）にしか写らず、2 だとテロップのほとんどが偽になった。1 フレームの断片は区間化の
   * 規則 5（4.2 節）で除いているので、残る 1 フレームの大きく中央寄りで確信度の高い行はテロップとみなす（親の決定）
   */
  captionMinFrames: 1,
});

/** フレームの出所（`video_text_frames.source`） */
export type FrameSource = "interval" | "cut";

/** 計画した 1 枚 */
export interface PlannedFrame {
  atMs: number;
  source: FrameSource;
}

/** `frameTimes` の設定 */
export interface FrameTimeOptions {
  intervalMs: number;
  cutOffsetMs: number;
  mergeWindowMs: number;
}

export const DEFAULT_FRAME_TIME_OPTIONS: FrameTimeOptions = {
  intervalMs: FRAME_INTERVAL_MS,
  cutOffsetMs: CUT_OFFSET_MS,
  mergeWindowMs: MERGE_WINDOW_MS,
};

/**
 * フレームの時刻の計画（設計 3.4 節）。
 * 1. カット直後 `at_ms + cutOffsetMs`（`duration_ms` 未満のものだけ。直前に残したものと `mergeWindowMs` 未満なら捨てる）
 * 2. 一定間隔 `0, intervalMs, …`（`duration_ms` 未満）。1 のいずれかと `mergeWindowMs` 未満の差なら捨てる
 * 3. 昇順。`duration_ms` が 0 以下なら空
 */
export function frameTimes(
  durationMs: number,
  cutsMs: readonly number[],
  options: FrameTimeOptions = DEFAULT_FRAME_TIME_OPTIONS,
): PlannedFrame[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return [];
  const { intervalMs, cutOffsetMs, mergeWindowMs } = options;
  const cutTimes: number[] = [];
  const sortedCuts = cutsMs
    .filter((c) => Number.isFinite(c))
    .map((c) => Math.round(c))
    .sort((a, b) => a - b);
  for (const cut of sortedCuts) {
    const atMs = cut + cutOffsetMs;
    if (atMs < 0 || atMs >= durationMs) continue;
    const prev = cutTimes.at(-1);
    if (prev !== undefined && atMs - prev < mergeWindowMs) continue;
    cutTimes.push(atMs);
  }
  const frames: PlannedFrame[] = cutTimes.map((atMs) => ({ atMs, source: "cut" }));
  for (let t = 0; t < durationMs; t += intervalMs) {
    if (cutTimes.some((c) => Math.abs(c - t) < mergeWindowMs)) continue;
    frames.push({ atMs: t, source: "interval" });
  }
  return frames.sort((a, b) => a.atMs - b.atMs);
}

/** NFKC 正規化 → 空白（全角 U+3000 を含む）をすべて除く → ASCII の大文字を小文字にする（設計 4.1 節） */
export function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\s/gu, "")
    .replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** コードポイントの列（`length` は UTF-16 単位なので使わない） */
export function codePoints(text: string): string[] {
  return Array.from(text);
}

/** コードポイントの列の編集距離（Levenshtein） */
export function editDistance(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur: number[] = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

/** `video_text_frames.words` の 1 語（設計 4.1 節の切り詰めた形） */
export interface FrameWord {
  /** block の番号（0 から） */
  b: number;
  /** paragraph の番号（0 から） */
  p: number;
  /** 語の文字 */
  t: string;
  /** 確信度（0〜1。小数 3 桁。欠けていれば 0） */
  c: number;
  /** 言語。なければ null */
  l: string | null;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 最後の symbol の `detectedBreak.type`。なければ null */
  br: string | null;
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 復元した行（設計 4.1 節） */
export interface FrameLine {
  text: string;
  norm: string;
  box: Box;
  confidence: number;
  charHeight: number;
  lang: string | null;
}

/** 区間化の入力の 1 フレーム（保存した結果。文字のないフレームは `words` が空） */
export interface OcrFrame {
  atMs: number;
  words: readonly FrameWord[];
}

/** `video_text_segments` の 1 行（`analysis_id` なし） */
export interface TextSegment {
  seq: number;
  text: string;
  text_norm: string;
  start_ms: number;
  end_ms: number;
  vertical_position: "top" | "middle" | "bottom";
  center_x_ratio: number;
  center_y_ratio: number;
  char_height_ratio: number;
  confidence: number;
  frame_count: number;
  lang: string | null;
  is_caption_like: boolean;
}

/** 特徴量（設計 4.4 節。`video_text_analyses` の列） */
export interface TextFeatures {
  first_text_ms: number | null;
  has_text_in_first_3s: boolean;
  text_coverage_ratio: number | null;
  total_text_chars: number;
  segment_count: number;
  max_chars_per_frame: number;
  avg_chars_per_frame: number;
  caption_first_text_ms: number | null;
  caption_has_text_in_first_3s: boolean;
  caption_coverage_ratio: number | null;
  caption_total_chars: number;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/** 最頻値。同数なら `tieBreak` が真を返す方（省略時は先に出たもの） */
function mode<T>(values: readonly T[], tieBreak?: (candidate: T, current: T) => boolean): T | undefined {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | undefined;
  let bestCount = 0;
  for (const [v, n] of counts) {
    if (best === undefined || n > bestCount || (n === bestCount && tieBreak?.(v, best))) {
      best = v;
      bestCount = n;
    }
  }
  return best;
}

function unionBox(boxes: readonly Box[]): Box {
  return {
    x0: Math.min(...boxes.map((b) => b.x0)),
    y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)),
    y1: Math.max(...boxes.map((b) => b.y1)),
  };
}

function averageBox(boxes: readonly Box[]): Box {
  return {
    x0: average(boxes.map((b) => b.x0)),
    y0: average(boxes.map((b) => b.y0)),
    x1: average(boxes.map((b) => b.x1)),
    y1: average(boxes.map((b) => b.y1)),
  };
}

function boxArea(box: Box): number {
  return Math.max(0, box.x1 - box.x0) * Math.max(0, box.y1 - box.y0);
}

function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
}

function centerY(box: Box): number {
  return (box.y0 + box.y1) / 2;
}

function centerX(box: Box): number {
  return (box.x0 + box.x1) / 2;
}

function makeLine(words: readonly FrameWord[], text: string): FrameLine {
  const trimmed = text.trim();
  return {
    text: trimmed,
    norm: normalizeText(trimmed),
    box: unionBox(words.map((w) => ({ x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 }))),
    confidence: average(words.map((w) => w.c)),
    charHeight: median(words.map((w) => w.y1 - w.y0)),
    lang: mode(
      words.map((w) => w.l).filter((l): l is string => l !== null),
      (candidate, current) => candidate < current,
    ) ?? null,
  };
}

/**
 * 行の復元（設計 4.1 節）。同じ `(b, p)` の語を順に連結し、`br` が `LINE_BREAK` か `EOL_SURE_SPACE` の語の後で行に分ける。
 * `SPACE`／`SURE_SPACE` は空白 1 つ、`HYPHEN` はハイフンで連結し、それ以外は空白なし。
 * 行の順は `(y0, x0, norm)` の昇順
 */
export function frameLines(frame: { words: readonly FrameWord[] }): FrameLine[] {
  const paragraphs = new Map<string, FrameWord[]>();
  for (const word of frame.words) {
    const key = `${word.b}/${word.p}`;
    const list = paragraphs.get(key);
    if (list) list.push(word);
    else paragraphs.set(key, [word]);
  }
  const lines: FrameLine[] = [];
  for (const words of paragraphs.values()) {
    let current: FrameWord[] = [];
    let text = "";
    for (const word of words) {
      current.push(word);
      text += word.t;
      if (word.br === "LINE_BREAK" || word.br === "EOL_SURE_SPACE") {
        lines.push(makeLine(current, text));
        current = [];
        text = "";
      } else if (word.br === "SPACE" || word.br === "SURE_SPACE") {
        text += " ";
      } else if (word.br === "HYPHEN") {
        text += "-";
      }
    }
    if (current.length > 0) lines.push(makeLine(current, text));
  }
  return sortLines(lines);
}

function sortLines(lines: FrameLine[]): FrameLine[] {
  return lines.sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0 || (a.norm < b.norm ? -1 : a.norm > b.norm ? 1 : 0));
}

/** 前処理（設計 4.1 節末尾）: `norm` が空の行と確信度が下限未満の行を除く */
export function usableLines(lines: readonly FrameLine[], params: SegmenterParams = SEGMENTER_PARAMS): FrameLine[] {
  return lines.filter((line) => line.norm !== "" && line.confidence >= params.minLineConfidence);
}

interface Similarity {
  contain: boolean;
  score: number;
}

/** 「文字が同じ」の判定（設計 4.2 節 1）。同じでなければ undefined */
export function textSimilarity(a: string, b: string, params: SegmenterParams = SEGMENTER_PARAMS): Similarity | undefined {
  const ca = codePoints(a);
  const cb = codePoints(b);
  if (ca.length === 0 || cb.length === 0) return undefined;
  const shorter = ca.length <= cb.length ? a : b;
  const longer = ca.length <= cb.length ? b : a;
  const ratio = Math.min(ca.length, cb.length) / Math.max(ca.length, cb.length);
  if (longer.includes(shorter) && ratio >= params.containMinRatio) return { contain: true, score: ratio };
  const distance = editDistance(ca, cb);
  const max = Math.max(ca.length, cb.length);
  if (max <= params.shortTextMaxLen) {
    return distance <= params.shortTextMaxDistance ? { contain: false, score: 1 - distance / max } : undefined;
  }
  const score = 1 - distance / max;
  return score >= params.minSimilarity ? { contain: false, score } : undefined;
}

interface Observation {
  frameIndex: number;
  line: FrameLine;
}

interface OpenSegment {
  /** 開いた順（決定性のため） */
  order: number;
  observations: Observation[];
  lastIndex: number;
}

/** 区間の代表の `norm`（観測の最頻値。同数なら長いもの、それも同じなら先に観測したもの） */
function representativeText(observations: readonly Observation[]): string {
  return (
    mode(
      observations.map((o) => o.line.text),
      (candidate, current) => codePoints(candidate).length > codePoints(current).length,
    ) ?? ""
  );
}

/** 区間化の設定 */
export interface SegmentOptions {
  durationMs: number;
  imageWidth: number;
  imageHeight: number;
  params?: SegmenterParams;
}

/**
 * フレームの行を区間にまとめる（設計 4.2 節、4.3 節）。`frames` は計画した全フレーム（文字のないフレームを含む）。
 * 入力の順に依らず同じ結果を返す（フレームは時刻順、行は `(y0, x0, norm)` 順に並べ直す）
 */
export function segmentFrames(frames: readonly OcrFrame[], options: SegmentOptions): TextSegment[] {
  const params = options.params ?? SEGMENTER_PARAMS;
  const sorted = [...frames].sort((a, b) => a.atMs - b.atMs);
  const height = options.imageHeight;
  const width = options.imageWidth;
  const open: OpenSegment[] = [];
  const finished: OpenSegment[] = [];
  let nextOrder = 0;

  for (const [k, frame] of sorted.entries()) {
    const lines = usableLines(frameLines(frame), params);
    const matched = new Set<OpenSegment>();
    for (const line of lines) {
      let best: { segment: OpenSegment; contain: boolean; score: number; dy: number } | undefined;
      for (const segment of open) {
        if (matched.has(segment) || segment.lastIndex < k - params.maxIndexGap) continue;
        const similarity = textSimilarity(line.norm, normalizeText(representativeText(segment.observations)), params);
        if (!similarity) continue;
        const segmentCenterY = average(segment.observations.map((o) => centerY(o.line.box)));
        const dy = Math.abs(centerY(line.box) - segmentCenterY);
        if (height > 0 && dy > params.centerYTolerance * height) continue;
        const better =
          best === undefined ||
          (similarity.contain && !best.contain) ||
          (similarity.contain === best.contain &&
            (similarity.score > best.score ||
              (similarity.score === best.score && (dy < best.dy || (dy === best.dy && segment.order < best.segment.order)))));
        if (better) best = { segment, contain: similarity.contain, score: similarity.score, dy };
      }
      if (best) {
        best.segment.observations.push({ frameIndex: k, line });
        best.segment.lastIndex = k;
        matched.add(best.segment);
      } else {
        const segment: OpenSegment = { order: nextOrder, observations: [{ frameIndex: k, line }], lastIndex: k };
        nextOrder += 1;
        open.push(segment);
        matched.add(segment);
      }
    }
    for (let i = open.length - 1; i >= 0; i -= 1) {
      const segment = open[i];
      if (segment && segment.lastIndex < k - params.maxIndexGap) {
        finished.push(segment);
        open.splice(i, 1);
      }
    }
  }
  finished.push(...open);

  // 雑音の除去（設計 4.2 節 5）
  const kept = finished.filter((segment) => {
    if (segment.observations.length !== 1) return true;
    const only = segment.observations[0];
    if (!only) return false;
    if (codePoints(only.line.norm).length <= params.fragmentMaxChars) return false;
    const ownArea = boxArea(only.line.box);
    for (const other of finished) {
      if (other === segment) continue;
      const index = other.observations.findIndex((o) => o.frameIndex === only.frameIndex);
      // 同じフレームで「観測を足した」区間（そのフレームで開いた区間は除く）
      if (index <= 0) continue;
      const overlap = overlapArea(only.line.box, averageBox(other.observations.map((o) => o.line.box)));
      if (ownArea > 0 && overlap >= params.fragmentOverlapRatio * ownArea) return false;
    }
    return true;
  });

  const segments = kept.map((segment): Omit<TextSegment, "seq"> => {
    const observations = segment.observations;
    const text = representativeText(observations);
    const first = observations[0];
    const last = observations[observations.length - 1];
    const startMs = sorted[first?.frameIndex ?? 0]?.atMs ?? 0;
    const endMs = sorted[(last?.frameIndex ?? 0) + 1]?.atMs ?? options.durationMs;
    const cx = average(observations.map((o) => centerX(o.line.box)));
    const cy = average(observations.map((o) => centerY(o.line.box)));
    const centerXRatio = round(clamp01(width > 0 ? cx / width : 0), 4);
    const centerYRatio = round(clamp01(height > 0 ? cy / height : 0), 4);
    const charHeightRatio = round(clamp01(height > 0 ? median(observations.map((o) => o.line.charHeight)) / height : 0), 4);
    const confidence = round(clamp01(average(observations.map((o) => o.line.confidence))), 4);
    const lang =
      mode(
        observations.map((o) => o.line.lang).filter((l): l is string => l !== null),
        (candidate, current) => candidate < current,
      ) ?? null;
    const isCaptionLike =
      charHeightRatio >= params.captionMinCharHeightRatio &&
      Math.abs(centerXRatio - 0.5) <= params.captionMaxCenterXOffset &&
      confidence >= params.captionMinConfidence &&
      observations.length >= params.captionMinFrames;
    return {
      text,
      text_norm: normalizeText(text),
      start_ms: startMs,
      end_ms: endMs,
      vertical_position: centerYRatio < 1 / 3 ? "top" : centerYRatio < 2 / 3 ? "middle" : "bottom",
      center_x_ratio: centerXRatio,
      center_y_ratio: centerYRatio,
      char_height_ratio: charHeightRatio,
      confidence,
      frame_count: observations.length,
      lang,
      is_caption_like: isCaptionLike,
    };
  });
  segments.sort(
    (a, b) =>
      a.start_ms - b.start_ms ||
      a.center_y_ratio - b.center_y_ratio ||
      a.center_x_ratio - b.center_x_ratio ||
      (a.text_norm < b.text_norm ? -1 : a.text_norm > b.text_norm ? 1 : 0),
  );
  return segments.map((segment, index) => ({ seq: index + 1, ...segment }));
}

/** 区間の `[start_ms, end_ms)` の和集合の長さ */
function unionLength(segments: readonly TextSegment[]): number {
  const ranges = segments.map((s) => [s.start_ms, s.end_ms] as const).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let currentStart: number | undefined;
  let currentEnd = 0;
  for (const [start, end] of ranges) {
    if (currentStart === undefined || start > currentEnd) {
      if (currentStart !== undefined) total += currentEnd - currentStart;
      currentStart = start;
      currentEnd = end;
    } else {
      currentEnd = Math.max(currentEnd, end);
    }
  }
  if (currentStart !== undefined) total += currentEnd - currentStart;
  return total;
}

/** `text_norm` が同じ区間を 1 つに数えた文字数の合計 */
function distinctChars(segments: readonly TextSegment[]): number {
  const seen = new Set<string>();
  let total = 0;
  for (const s of segments) {
    if (seen.has(s.text_norm)) continue;
    seen.add(s.text_norm);
    total += codePoints(s.text_norm).length;
  }
  return total;
}

/** 特徴量（設計 4.4 節）。`frames` は計画した全フレーム（断片を含むフレームごとの文字数に使う） */
export function summarizeSegments(
  segments: readonly TextSegment[],
  frames: readonly OcrFrame[],
  durationMs: number,
  params: SegmenterParams = SEGMENTER_PARAMS,
): TextFeatures {
  const coverage = (list: readonly TextSegment[]): number | null =>
    durationMs > 0 ? round(clamp01(unionLength(list) / durationMs), 4) : null;
  const firstMs = (list: readonly TextSegment[]): number | null =>
    list.length === 0 ? null : Math.min(...list.map((s) => s.start_ms));
  const charsPerFrame = frames.map((frame) =>
    usableLines(frameLines(frame), params).reduce((sum, line) => sum + codePoints(line.norm).length, 0),
  );
  const captions = segments.filter((s) => s.is_caption_like);
  return {
    first_text_ms: firstMs(segments),
    has_text_in_first_3s: segments.some((s) => s.start_ms < 3000),
    text_coverage_ratio: coverage(segments),
    total_text_chars: distinctChars(segments),
    segment_count: segments.length,
    max_chars_per_frame: charsPerFrame.length === 0 ? 0 : Math.max(...charsPerFrame),
    avg_chars_per_frame: charsPerFrame.length === 0 ? 0 : round(average(charsPerFrame), 2),
    caption_first_text_ms: firstMs(captions),
    caption_has_text_in_first_3s: captions.some((s) => s.start_ms < 3000),
    caption_coverage_ratio: coverage(captions),
    caption_total_chars: distinctChars(captions),
  };
}
