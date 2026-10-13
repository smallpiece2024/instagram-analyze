/**
 * レポート `/report` の月（`?month=YYYY-MM`）の検査、既定、選べる月の列挙（R6 設計 6 章、U11、S6、T14、T20、Q14）。
 * 純粋関数（`server-only` なし）。DB は読まず、`getDailyRange()` の値を `{ start, latest }` で受ける。
 * ページと Server Action の両方から同じ関数を呼ぶ（S6）。
 *
 * 検査の順は **正規表現 → 選べる範囲（文字列の比較）→ `monthOf`**。`0000-01` のような値で `monthOf` が
 * `RangeError` を投げて 500 にならないよう、範囲の検査を `monthOf` より先にする（T14）。
 */

import { monthOf, parseYmd, previousMonth, type Period, type Ymd } from "./period";

/** `YYYY-MM` */
export type YearMonth = string;

/** 日次指標のある範囲。`getDailyRange()` の `start` と `end`（最新の日 `latest`）を渡す */
export interface ReportMonthRange {
  /** 日次指標の最初の日（データの始まり） */
  start: Ymd;
  /** 日次指標の最新の日 */
  latest: Ymd;
}

/** `?month=` の形。月は 01〜12 だけ（`2026-13`、`2026-1` は不正） */
export const REPORT_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** `YYYY-MM-DD` → `YYYY-MM` */
export function yearMonthOf(date: Ymd): YearMonth {
  return date.slice(0, 7);
}

/** `YYYY-MM` → その暦月（1 日〜末日）。形の検査が済んだ値にだけ使う（`monthOf` は不正な値で例外を投げる） */
export function reportMonthPeriod(month: YearMonth): Period {
  return monthOf(`${month}-01`);
}

/**
 * 選べる月（Q14）。データの始まりの月から `latest` を含む月まで、古い順。同じ月なら 1 つ。
 * `range` が null（日次指標がない）、日付の形が不正、`latest` が `start` より前なら空
 */
export function selectableReportMonths(range: ReportMonthRange | null): YearMonth[] {
  if (range === null) return [];
  const s = parseYmd(range.start);
  const l = parseYmd(range.latest);
  if (!s || !l) return [];
  const out: YearMonth[] = [];
  for (let y = s.y, m = s.m; y < l.y || (y === l.y && m <= l.m); ) {
    out.push(`${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`);
    if (m === 12) {
      y += 1;
      m = 1;
    } else {
      m += 1;
    }
  }
  return out;
}

/**
 * 既定の月（T20）。`presetPeriods("month", latest).a` と同じ = `latest` を含む月の前月。
 * 日本時間の月初 1〜2 日は `latest` がまだ前月なので前々月になる（`latest` の定義どおり。直さない）。
 * ただし前月がデータの始まりより前（データが今月から始まった）なら、選べる最初の月にする
 * （既定が選べる月の外にあると、記入欄の隠し `month` が Action で拒まれるため）
 */
export function defaultReportMonth(range: ReportMonthRange): YearMonth {
  const prev = yearMonthOf(previousMonth(range.latest).from);
  const first = yearMonthOf(range.start);
  return prev < first ? first : prev;
}

/**
 * `?month=` の値の検査（S6 (1)(2)、T14）。文字列 1 つで、形が `YYYY-MM` で、選べる月に含まれれば返す。
 * `string[]`（同じ名前が 2 つ）、undefined、形の違い、範囲の外（未来、データの前、`0000-01`）は undefined。
 * `monthOf` は呼ばないので例外を投げない。不正なときの扱い（ページは既定に戻す、Action は拒む）は呼ぶ側で決める
 */
export function parseReportMonth(value: unknown, selectable: readonly YearMonth[]): YearMonth | undefined {
  if (typeof value !== "string") return undefined;
  if (!REPORT_MONTH_PATTERN.test(value)) return undefined;
  return selectable.includes(value) ? value : undefined;
}

/** ページで使う、月の決定の結果 */
export interface ResolvedReportMonth {
  /** 表示する月（`YYYY-MM`。検査済み。隠し項目の `month` にそのまま入れる） */
  month: YearMonth;
  /** その暦月（1 日〜末日）。表示の期間は呼ぶ側で `clampPeriod` により `latest` に切り詰める */
  period: Period;
  /** 選べる月（古い順。月の切り替えのチップに使う） */
  selectable: YearMonth[];
  /** `?month=` が不正か範囲の外で既定に戻したか（値がないときは false） */
  fellBack: boolean;
}

/**
 * ページの `searchParams.month` から表示する月を決める。不正か範囲の外なら既定（R3 4.7 節「不正なら既定に戻す」）。
 * `range` が null（日次指標がない）なら null（ページは `NotCollected` を出し、月の選択と記入欄は出さない）
 */
export function resolveReportMonth(value: unknown, range: ReportMonthRange | null): ResolvedReportMonth | null {
  if (range === null) return null;
  const selectable = selectableReportMonths(range);
  if (selectable.length === 0) return null;
  const parsed = parseReportMonth(value, selectable);
  const month = parsed ?? defaultReportMonth(range);
  return { month, period: reportMonthPeriod(month), selectable, fellBack: parsed === undefined && value !== undefined };
}
