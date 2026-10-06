/**
 * 期間比較の期間の決定（R3 設計 3.5 節「期間の指定」、4.7 節）。純粋関数（テストは `test/db/compare.test.ts`）。
 *
 * - 期間はプリセット（`?preset=7d|30d|month|yoy`）だけ。任意の期間の指定は置かない（2026-10-05 ユーザーの決定）
 * - 不明な値は既定（前 30 日）
 */
import { parsePreset, type ParamValue } from "@/lib/params";
import { presetPeriods, type ComparePreset, type Period } from "@/lib/period";

export type CompareParams = Readonly<Record<string, ParamValue>>;

export interface CompareSelection {
  /** 今のプリセット（見出しの右の切り替えの現在位置） */
  preset: ComparePreset;
  a: Period;
  b: Period;
}

/** クエリから期間 A（新しい方）と B（比べる方）を決める。`latest` は日次指標の最新の日（`reach` のある最新の日） */
export function resolveCompare(params: CompareParams, latest: string): CompareSelection {
  const preset = parsePreset(params.preset);
  const { a, b } = presetPeriods(preset, latest);
  return { preset, a, b };
}
