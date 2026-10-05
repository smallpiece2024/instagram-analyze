/**
 * 期間比較の期間の決定（R3 設計 3.5 節「期間の指定」、4.7 節）。純粋関数（テストは `test/db/compare.test.ts`）。
 *
 * - クエリは `?preset=7d|30d|month|yoy`、または任意の期間。任意の期間は `?a=2026-09-01..2026-09-30&b=…` の形と、
 *   フォームの 4 つの日付入力（`a_from`、`a_to`、`b_from`、`b_to`）の形の両方を受け付ける（GET のフォームは `a=…..…` を作れないため）
 * - 日付の検査は `parseDateRange`（形、暦、開始 ≦ 終了、366 日以内）。通らなければ理由を返し、既定（前 30 日）で表示する
 * - 最新の日より後は最新の日に切り詰める。データの始まりより前は切り詰めない（`clampPeriod` は使わない。ある分の日数は画面で書く）
 */
import { parseDateRange, parsePreset, type ParamValue } from "@/lib/params";
import { compareYmd, presetPeriods, type ComparePreset, type Period, type Ymd } from "@/lib/period";

export type CompareParams = Readonly<Record<string, ParamValue>>;

export interface CompareInput {
  aFrom: string;
  aTo: string;
  bFrom: string;
  bTo: string;
}

export interface CompareSelection {
  /** 今の期間がプリセットならその値（チップの現在位置）。任意の期間なら null */
  preset: ComparePreset | null;
  a: Period;
  b: Period;
  /** フォームの初期値（任意の期間で検査に落ちたときは入れた値のまま） */
  input: CompareInput;
  /** 入力欄の下に出す理由 */
  errors: { a?: string; b?: string };
  /** 最新の日に切り詰めたなら最新の日（「2026-10-04 までのデータで表示」） */
  truncatedTo: Ymd | null;
}

const CUSTOM_KEYS = ["a", "b", "a_from", "a_to", "b_from", "b_to"] as const;

function single(v: ParamValue): string | undefined {
  if (typeof v !== "string") return v === undefined ? undefined : "";
  return v.trim() === "" ? undefined : v.trim();
}

/** `a`（`from..to`）か、`a_from`／`a_to` から開始と終了を取り出す */
function rawRange(params: CompareParams, key: "a" | "b"): { from: string | undefined; to: string | undefined } {
  const combined = single(params[key]);
  if (combined !== undefined) {
    const parts = combined.split("..");
    return parts.length === 2 ? { from: parts[0], to: parts[1] } : { from: combined, to: "" };
  }
  return { from: single(params[`${key}_from`]), to: single(params[`${key}_to`]) };
}

function isCustom(params: CompareParams): boolean {
  return CUSTOM_KEYS.some((k) => params[k] !== undefined);
}

function inputOf(a: Period, b: Period): CompareInput {
  return { aFrom: a.from, aTo: a.to, bFrom: b.from, bTo: b.to };
}

/** 最新の日より後を切り詰める。始まりも最新の日より後なら理由を返す */
function capToLatest(p: Period, latest: Ymd): { ok: true; period: Period; truncated: boolean } | { ok: false; reason: string } {
  if (compareYmd(p.from, latest) > 0) return { ok: false, reason: `開始日は ${latest} 以前にしてください` };
  if (compareYmd(p.to, latest) > 0) return { ok: true, period: { from: p.from, to: latest }, truncated: true };
  return { ok: true, period: p, truncated: false };
}

/**
 * クエリから期間 A（新しい方）と B（比べる方）を決める。`latest` は日次指標の最新の日（`reach` のある最新の日）
 */
export function resolveCompare(params: CompareParams, latest: Ymd): CompareSelection {
  if (!isCustom(params)) {
    const preset = parsePreset(params.preset);
    const { a, b } = presetPeriods(preset, latest);
    return { preset, a, b, input: inputOf(a, b), errors: {}, truncatedTo: null };
  }

  const ra = rawRange(params, "a");
  const rb = rawRange(params, "b");
  const input: CompareInput = { aFrom: ra.from ?? "", aTo: ra.to ?? "", bFrom: rb.from ?? "", bTo: rb.to ?? "" };
  const errors: { a?: string; b?: string } = {};

  const check = (r: { from: string | undefined; to: string | undefined }, side: "a" | "b") => {
    const parsed = parseDateRange(r.from, r.to);
    if (!parsed.ok) {
      errors[side] = parsed.reason;
      return null;
    }
    const capped = capToLatest(parsed.period, latest);
    if (!capped.ok) {
      errors[side] = capped.reason;
      return null;
    }
    return capped;
  };
  const ca = check(ra, "a");
  const cb = check(rb, "b");

  if (ca === null || cb === null) {
    const fallback = presetPeriods("30d", latest);
    return { preset: "30d", a: fallback.a, b: fallback.b, input, errors, truncatedTo: null };
  }
  return {
    preset: null,
    a: ca.period,
    b: cb.period,
    input,
    errors,
    truncatedTo: ca.truncated || cb.truncated ? latest : null,
  };
}
