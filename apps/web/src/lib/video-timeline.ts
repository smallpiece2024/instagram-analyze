/**
 * 投稿詳細の「カットのタイムライン」と、動画の解析の状態から「—」の理由への対応（R4 設計 6.1 節、R4.1 設計 6.1 節）。
 * `server-only` なし（純粋関数）。
 */
import { isSupported, MISSING_REASON_TEXT, type MediaKind, type Missing } from "./metrics";

/** シーン 1 本（ミリ秒） */
export interface Scene {
  start: number;
  end: number;
}

/** 文字の区間の位置（上・中・下。ビューの `vertical_position`） */
export type TextPosition = "top" | "middle" | "bottom";
export const TEXT_POSITIONS: readonly TextPosition[] = ["top", "middle", "bottom"];
export const TEXT_POSITION_LABEL: Record<TextPosition, string> = { top: "上", middle: "中", bottom: "下" };

/** `vertical_position` の値を 3 値に収める（外れた値は `middle`。新しい文言は足さない） */
export function textPosition(v: string): TextPosition {
  return (TEXT_POSITIONS as readonly string[]).includes(v) ? (v as TextPosition) : "middle";
}

/** タイムラインに描く文字の区間 1 本（ミリ秒）。タイムライン用で確信度は持たない */
export interface TextSpan {
  start: number;
  end: number;
  text: string;
  position: TextPosition;
  captionLike: boolean;
}

export interface TimelineModel {
  durationMs: number;
  scenes: Scene[];
  /** 画面変化の時刻（ミリ秒。0 と長さ以上は除く。重複なし、昇順） */
  cuts: number[];
  /** 文字の区間（`seq` の順。クリップ済み）。null は文字の解析がない（段を描かない） */
  texts: TextSpan[] | null;
}

/**
 * 文字の区間のクリップ（タイムラインだけの規則。表の行はそのまま出す）。
 * `start >= duration` と `start >= end` の区間は捨て、`end > duration` は `duration` に丸める。並びは入力のまま（`seq` の順）
 */
export function clipTextSpans(texts: readonly TextSpan[], durationMs: number): TextSpan[] {
  const out: TextSpan[] = [];
  for (const t of texts) {
    if (!Number.isFinite(t.start) || !Number.isFinite(t.end)) continue;
    if (t.start < 0 || t.start >= durationMs || t.start >= t.end) continue;
    out.push({ ...t, end: Math.min(t.end, durationMs) });
  }
  return out;
}

/**
 * カットの時刻からシーンを作る。先頭に 0 を足し、長さ以上の時刻と重複は捨てる（0 ms の画面変化は先頭の 0 と重なるので捨てる）。
 * 画面変化 0 回なら帯は 1 本。`duration_ms` が null か 0 以下なら null（描かない）。
 * `texts` は文字の区間（null なら段を描かない。空なら 3 段を空で描く）
 */
export function timelineModel(
  cutTimes: readonly number[],
  durationMs: number | null,
  texts: readonly TextSpan[] | null = null,
): TimelineModel | null {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs <= 0) return null;
  const cuts = Array.from(new Set(cutTimes.filter((t) => Number.isFinite(t) && t > 0 && t < durationMs))).sort(
    (a, b) => a - b,
  );
  const bounds = [0, ...cuts, durationMs];
  const scenes: Scene[] = [];
  for (let i = 0; i < bounds.length - 1; i++) scenes.push({ start: bounds[i] as number, end: bounds[i + 1] as number });
  return { durationMs, scenes, cuts, texts: texts === null ? null : clipTextSpans(texts, durationMs) };
}

/**
 * 同じ段で `[start, end)` が重なる区間のうち、帯の文字を出せるもの（入力 = `seq` の順。先の区間と重なるものは出さない）。
 * 全文は `<title>` と `aria-label` に残る
 */
export function textLabelsFit(texts: readonly TextSpan[]): boolean[] {
  const shown: TextSpan[] = [];
  return texts.map((t) => {
    const overlaps = shown.some((s) => s.position === t.position && t.start < s.end && s.start < t.end);
    if (!overlaps) shown.push(t);
    return !overlaps;
  });
}

/** 帯の文字の 1 文字の幅（全角換算、px）。半角が多いと余白が出るが許容 */
export const TEXT_LABEL_CHAR_PX = 11;

/** 幅 `widthPx` に入る文字数（コードポイント） */
export function labelCapacity(widthPx: number, charPx = TEXT_LABEL_CHAR_PX): number {
  return Math.max(0, Math.floor(widthPx / charPx));
}

/**
 * 帯の文字。幅に入らない分をコードポイント（`Array.from`）で数えて切り「…」を付ける（サロゲートペアを割らない）。
 * `max` が 1 以下なら空（出さない）
 */
export function truncateLabel(text: string, max: number): string {
  if (max < 1) return "";
  const cps = Array.from(text);
  if (cps.length <= max) return text;
  if (max < 2) return "";
  return `${cps.slice(0, max - 1).join("")}…`;
}

/** 目盛の間隔の候補（秒） */
const TICK_STEPS_S = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600] as const;

/**
 * 目盛の間隔（ミリ秒）。動画の長さを、目盛 1 つに `minGap` px を取ったときの数に収まる最小の間隔にする（R3 の `labelStep` の考え方）
 */
export function timelineTickStepMs(durationMs: number, innerWidth: number, minGap = 44): number {
  const maxTicks = Math.max(2, Math.floor(innerWidth / minGap));
  const durS = Math.max(0, durationMs) / 1000;
  for (const s of TICK_STEPS_S) {
    if (durS / s <= maxTicks) return s * 1000;
  }
  return (TICK_STEPS_S[TICK_STEPS_S.length - 1] as number) * 1000;
}

/** 目盛の時刻（0 から間隔ごと、長さ以下） */
export function timelineTicks(durationMs: number, stepMs: number): number[] {
  const out: number[] = [];
  if (!(stepMs > 0) || !(durationMs > 0)) return [0];
  for (let t = 0; t <= durationMs; t += stepMs) out.push(t);
  return out;
}

/** 三角の印の間隔がこれより狭いところがあれば、印を省いて帯の濃淡だけにする（px） */
export const MARKER_MIN_GAP_PX = 6;

/** 印を描けるか（隣り合う画面変化の間隔が `minGap` px 以上） */
export function markersFit(model: TimelineModel, innerWidth: number, minGap = MARKER_MIN_GAP_PX): boolean {
  const px = (ms: number) => (innerWidth * ms) / model.durationMs;
  for (let i = 1; i < model.cuts.length; i++) {
    if (px((model.cuts[i] as number) - (model.cuts[i - 1] as number)) < minGap) return false;
  }
  return true;
}

/**
 * 今の条件の解析の状態 → 「—」の理由（6.1 節の表）。値を出せるなら null。
 * 行がない → not_yet（「—」だけ）、`no_video_url` と `failed`（打ち切りを含む）→ missing。新しい理由や文言は足さない
 */
export function videoAnalysisMissing(status: string | null): Missing | null {
  if (status === null) return { reason: "not_yet", text: MISSING_REASON_TEXT.not_yet };
  if (status === "success") return null;
  return { reason: "missing", text: MISSING_REASON_TEXT.missing };
}

/**
 * 文字の解析の状態 → 「—」の理由（R4.1 設計 6.1 節の表）。値を出せるなら null。
 * null（まだ読んでいない）と `success` で `text_segmenter_current` が偽（計算し直し待ち）→ not_yet、
 * `no_video_url` と `failed`（打ち切りを含む）→ missing
 */
export function videoTextMissing(textStatus: string | null, segmenterCurrent: boolean | null): Missing | null {
  if (textStatus === null) return { reason: "not_yet", text: MISSING_REASON_TEXT.not_yet };
  if (textStatus === "success") {
    return segmenterCurrent === true ? null : { reason: "not_yet", text: MISSING_REASON_TEXT.not_yet };
  }
  return { reason: "missing", text: MISSING_REASON_TEXT.missing };
}

/**
 * 視聴維持率の「—」の判定（質の指標）。値を出せるなら null。
 * 種類で取れない（フィード動画など）→ unsupported、解析なし → 解析の状態の対応、分母（長さ）が 0 → no_baseline_data、値なし → missing
 */
export function retentionMissing(input: {
  kind: MediaKind;
  analysisStatus: string | null;
  durationMs: number | null;
  value: number | null;
}): Missing | null {
  if (!isSupported("retention_rate", input.kind)) return { reason: "unsupported", text: MISSING_REASON_TEXT.unsupported };
  const byStatus = videoAnalysisMissing(input.analysisStatus);
  if (byStatus !== null) return byStatus;
  if (input.durationMs === 0) return { reason: "no_baseline_data", text: MISSING_REASON_TEXT.no_baseline_data };
  if (input.value === null || !Number.isFinite(input.value)) return { reason: "missing", text: MISSING_REASON_TEXT.missing };
  return null;
}
