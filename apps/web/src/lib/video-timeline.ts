/**
 * 投稿詳細の「カットのタイムライン」と、動画の解析の状態から「—」の理由への対応（R4 設計 6.1 節）。`server-only` なし（純粋関数）。
 */
import { isSupported, MISSING_REASON_TEXT, type MediaKind, type Missing } from "./metrics";

/** シーン 1 本（ミリ秒） */
export interface Scene {
  start: number;
  end: number;
}

export interface TimelineModel {
  durationMs: number;
  scenes: Scene[];
  /** 画面変化の時刻（ミリ秒。0 と長さ以上は除く。重複なし、昇順） */
  cuts: number[];
}

/**
 * カットの時刻からシーンを作る。先頭に 0 を足し、長さ以上の時刻と重複は捨てる（0 ms の画面変化は先頭の 0 と重なるので捨てる）。
 * 画面変化 0 回なら帯は 1 本。`duration_ms` が null か 0 以下なら null（描かない）
 */
export function timelineModel(cutTimes: readonly number[], durationMs: number | null): TimelineModel | null {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs <= 0) return null;
  const cuts = Array.from(new Set(cutTimes.filter((t) => Number.isFinite(t) && t > 0 && t < durationMs))).sort(
    (a, b) => a - b,
  );
  const bounds = [0, ...cuts, durationMs];
  const scenes: Scene[] = [];
  for (let i = 0; i < bounds.length - 1; i++) scenes.push({ start: bounds[i] as number, end: bounds[i + 1] as number });
  return { durationMs, scenes, cuts };
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
