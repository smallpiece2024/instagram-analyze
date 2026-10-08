/**
 * URL のクエリの検査（R3 設計 4.7 節）。`server-only` なし（純粋関数）。
 *
 * - 受け取るのは `searchParams` の 1 つの値（`string | string[] | undefined`）。配列（同じキーが 2 回）は不正として扱う
 * - 不正な値は既定の値に戻す（例外を投げない）。日付だけは理由を返し、入力欄の下に出す
 */
import { JOB_ORDER, type JobName, type JobStatus } from "./format";
import { COMPARE_PRESETS, type ComparePreset, compareYmd, diffDays, isValidYmd, type Period } from "./period";

export type ParamValue = string | string[] | undefined;

function single(value: ParamValue): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function pick<T extends string>(value: ParamValue, allowed: readonly T[]): T | undefined {
  const v = single(value);
  return v !== undefined && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

/** 概要の期間（日数） */
export const RANGES = [7, 30, 90] as const;
export type Range = (typeof RANGES)[number];
export const DEFAULT_RANGE: Range = 30;

export function parseRange(value: ParamValue): Range {
  const v = pick(value, ["7", "30", "90"] as const);
  return v === undefined ? DEFAULT_RANGE : (Number(v) as Range);
}

/** 並べ替えのキーの既定値 */
export const DEFAULT_SORT = "posted";

/**
 * 並べ替えのキー。許可リスト（画面の対応表のキー）にない値は `fallback`（既定 `posted`）。
 * 対応表（キー → SQL の列）は画面の側で持ち、ここには値の検査だけを置く
 */
export function parseSort<K extends string>(value: ParamValue, allowed: readonly K[], fallback: K): K {
  return pick(value, allowed) ?? fallback;
}

export type SortOrder = "asc" | "desc";

export function parseOrder(value: ParamValue): SortOrder {
  return pick(value, ["asc", "desc"] as const) ?? "desc";
}

/** ページ。`^\d{1,6}$` かつ 1 以上。外れたら 1 */
export function parsePageNumber(value: ParamValue): number {
  const v = single(value);
  if (v === undefined || !/^\d{1,6}$/.test(v)) return 1;
  const n = Number(v);
  return n >= 1 ? n : 1;
}

/** 投稿 ID（`/media/[id]`）。`^\d{1,25}$` に合わなければ null（呼び出し側で `notFound()`） */
export function parseMediaId(value: unknown): string | null {
  return typeof value === "string" && /^\d{1,25}$/.test(value) ? value : null;
}

/** 期間比較のプリセット */
export function parsePreset(value: ParamValue): ComparePreset {
  return pick(value, COMPARE_PRESETS) ?? "30d";
}

/** 収集ログの `job`。許可リスト外は絞り込みなし（undefined） */
export function parseJob(value: ParamValue): JobName | undefined {
  return pick(value, JOB_ORDER);
}

export const JOB_STATUSES: readonly JobStatus[] = ["running", "success", "partial", "failed", "skipped"];

/** 収集ログの `status`。許可リスト外は絞り込みなし（undefined） */
export function parseJobStatus(value: ParamValue): JobStatus | undefined {
  return pick(value, JOB_STATUSES);
}

// ---------- R5（R5 設計 6 章。画面ごとの文言と対応表は各画面の lib に置き、ここには値の検査だけを置く） ----------

/** 投稿の種類の絞り込み（タグ分析、投稿時刻の `kind`）。ストーリーズは入れない */
export const KIND_FILTERS = ["all", "reel", "feed", "carousel"] as const;
export type KindFilter = (typeof KIND_FILTERS)[number];

/** `kind`。許可リスト外は `all`（データの状況で既定を変えない。T15） */
export function parseKindFilter(value: ParamValue): KindFilter {
  return pick(value, KIND_FILTERS) ?? "all";
}

/** タグ分析の指標（`m`） */
export const TAG_METRICS = ["reach", "views", "save_rate", "share_rate", "er", "reach_rate"] as const;
export type TagMetric = (typeof TAG_METRICS)[number];

/** タグ分析の `m`。許可リスト外は `reach` */
export function parseTagMetric(value: ParamValue): TagMetric {
  return pick(value, TAG_METRICS) ?? "reach";
}

/** 投稿時刻の指標（`m`。確認事項 Q14） */
export const TIMING_METRICS = ["reach_24h", "views_24h", "reach_latest", "views_latest"] as const;
export type TimingMetric = (typeof TIMING_METRICS)[number];

/** 投稿時刻の `m`。許可リスト外は `reach_24h`（24 時間の値が 0 件でも既定を変えない。T15） */
export function parseTimingMetric(value: ParamValue): TimingMetric {
  return pick(value, TIMING_METRICS) ?? "reach_24h";
}

/** ストーリーズの期間（日数。確認事項 Q9） */
export const STORY_RANGES = [30, 90, 365] as const;
export type StoryRange = (typeof STORY_RANGES)[number];
export const DEFAULT_STORY_RANGE: StoryRange = 30;

/** ストーリーズの `range`。`30`、`90`、`365` だけ。ほかは 30 */
export function parseStoryRange(value: ParamValue): StoryRange {
  const v = pick(value, ["30", "90", "365"] as const);
  return v === undefined ? DEFAULT_STORY_RANGE : (Number(v) as StoryRange);
}

/**
 * タグの軸の id（`missing`、`confirm_delete`、`axis` の候補）。`^\d{1,18}$` の形で、かつ `axisIds`
 * （対象のアカウントの、いまある軸の id。DB の bigint を文字列で）に含まれるときだけ返す。
 * 形が違う、消された軸、別のアカウントの軸は undefined（T12）
 */
export function parseAxisId(value: ParamValue, axisIds: readonly string[]): string | undefined {
  const v = single(value);
  if (v === undefined || !/^\d{1,18}$/.test(v)) return undefined;
  return axisIds.includes(v) ? v : undefined;
}

/**
 * タグ分析の `axis`。`parseAxisId` で通らなければ既定（並び順の最初の軸 = `axisIds[0]`）。
 * 軸が 0 件なら undefined（画面は「タグの軸がありません」を出す）
 */
export function parseSelectedAxis(value: ParamValue, axisIds: readonly string[]): string | undefined {
  return parseAxisId(value, axisIds) ?? axisIds[0];
}

/** 期間の最大の日数（両端を含む） */
export const MAX_PERIOD_DAYS = 366;

export type DateRangeResult =
  | { ok: true; period: Period }
  | { ok: false; reason: string };

/**
 * 日付の範囲（期間比較の `a`／`b` の開始と終了、日次の CSV の `from`／`to`）。
 * `YYYY-MM-DD` の形、暦として正しい日、開始 ≦ 終了、366 日以内。外れたら理由を返す
 */
export function parseDateRange(fromValue: ParamValue, toValue: ParamValue): DateRangeResult {
  const from = single(fromValue);
  const to = single(toValue);
  if (from === undefined || to === undefined) return { ok: false, reason: "開始日と終了日を入れてください" };
  if (!isValidYmd(from) || !isValidYmd(to)) return { ok: false, reason: "日付は YYYY-MM-DD の形の正しい日にしてください" };
  if (compareYmd(from, to) > 0) return { ok: false, reason: "開始日は終了日より前にしてください" };
  if (diffDays(from, to) + 1 > MAX_PERIOD_DAYS) {
    return { ok: false, reason: `期間は ${MAX_PERIOD_DAYS} 日以内にしてください` };
  }
  return { ok: true, period: { from, to } };
}

/**
 * 日次の CSV の `from`／`to`。両方とも省略なら全期間（`all`）。
 * 片方だけ、または不正なら `invalid`（Route Handler は 400 と固定の文言）
 */
export function parseCsvDateRange(
  fromValue: ParamValue,
  toValue: ParamValue,
): { kind: "all" } | { kind: "range"; period: Period } | { kind: "invalid" } {
  if (fromValue === undefined && toValue === undefined) return { kind: "all" };
  const r = parseDateRange(fromValue, toValue);
  return r.ok ? { kind: "range", period: r.period } : { kind: "invalid" };
}
