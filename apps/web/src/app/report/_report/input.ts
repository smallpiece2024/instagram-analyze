/**
 * レポートの記入欄（総評、翌月の施策）の入力の検査と、Server Action が返す状態と文言（R6 設計 6.2 節。S2、S13、U3）。
 * 純粋関数（`server-only` なし。単体テストで直接呼ぶ）。`actions.ts`（`'use server'`）は Action だけを export するので、
 * 型、定数、補助の関数はここに置く。月の検査は `@/lib/report-month`（ページと同じ関数）。
 *
 * 本文の検査（S2。順に）:
 * 1. `normalize("NFC")`
 * 2. `\r\n`、`\r`、U+2028（行区切り）、U+2029（段落区切り）を `\n` に。U+2028／U+2029 は C カテゴリでないが、
 *    本番の照合順序が libc だと DB の `[[:cntrl:]]` の check に当たり、手元（ICU）と判定が変わるので改行にそろえる（SQL レビューの中 1）
 * 3. 末尾の空白と改行を除く（先頭は残す）
 * 4. `[...s].length` が 0〜2,000（空は許す。空にして保存 = 消す）
 * 5. C カテゴリ（制御・書式・サロゲート・私用・未割当）を、改行と ZWJ（U+200D）以外すべて拒む。
 *    ZWJ を許すのは家族・職業・旗の絵文字が ZWJ でつながるため
 */

import { FORM_MESSAGES, INITIAL_FORM_STATE, type FormState } from "@/lib/form-input";

/** 本文の長さの上限（コードポイント。Q13） */
export const MAX_NOTE_LENGTH = 2000;

/** 文言（S13）。値を含めない。DB のエラー文は返さない */
export const REPORT_NOTES_MESSAGES = {
  saved: FORM_MESSAGES.saved,
  failed: FORM_MESSAGES.failed,
  month: "月が正しくありません",
  tooLong: "2,000 文字までです",
  badChars: "使えない文字があります",
} as const;

/** 送られた本文（正規化前）。失敗時に `<textarea defaultValue>` へ戻す（U3） */
export interface ReportNotesValues {
  summary: string;
  next_plan: string;
}

/** Server Action の戻り値（`useActionState` の状態）。失敗時だけ `values` が入る */
export interface ReportNotesState extends FormState {
  values?: ReportNotesValues;
}

export const INITIAL_REPORT_NOTES_STATE: ReportNotesState = INITIAL_FORM_STATE;

/** 改行と ZWJ（U+200D）以外の C カテゴリの文字（1 つでも当たれば拒む）。不可視文字はエスケープで書く（セキュリティレビューの低 1） */
export const FORBIDDEN_NOTE_CHARS = /[^\P{C}\n\u200D]/u;

/** 本文の正規化（NFC → 改行（CR、CRLF、U+2028、U+2029）を `\n` に → 末尾の空白と改行を除く）。検査の前に必ず通す */
export function normalizeNote(raw: string): string {
  return raw.normalize("NFC").replace(/\r\n|\r|\u2028|\u2029/g, "\n").trimEnd();
}

export type NoteCheck = { ok: true; value: string } | { ok: false; reason: "too_long" | "bad_chars" };

/** 本文の検査。通れば正規化した本文を返す */
export function checkNote(raw: string): NoteCheck {
  const value = normalizeNote(raw);
  if ([...value].length > MAX_NOTE_LENGTH) return { ok: false, reason: "too_long" };
  if (FORBIDDEN_NOTE_CHARS.test(value)) return { ok: false, reason: "bad_chars" };
  return { ok: true, value };
}

/** 本文の検査の失敗の理由 → 文言 */
export function messageForNote(reason: "too_long" | "bad_chars"): string {
  return reason === "too_long" ? REPORT_NOTES_MESSAGES.tooLong : REPORT_NOTES_MESSAGES.badChars;
}

/** 失敗の状態（送られた本文つき） */
export function failedWithValues(message: string, values: ReportNotesValues): ReportNotesState {
  return { status: "error", message, values };
}
