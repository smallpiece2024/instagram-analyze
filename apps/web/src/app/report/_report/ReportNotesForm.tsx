"use client";

import { createContext, useActionState, useContext, type ReactNode } from "react";
import { INITIAL_REPORT_NOTES_STATE, type ReportNotesState } from "./input";

export type ReportNotesAction = (state: ReportNotesState, formData: FormData) => Promise<ReportNotesState>;

/** 1 節の `<textarea>` と 9 節の `<form>` を結び付ける id（HTML の `form` 属性。JS なしでも動く） */
export const REPORT_NOTES_FORM_ID = "report-notes";

interface NotesContext {
  state: ReportNotesState;
  formAction: (formData: FormData) => void;
  pending: boolean;
}

const Ctx = createContext<NotesContext | null>(null);

/**
 * 記入欄の状態（R6 設計 6.2 節 U2、U3）。`<form>` は 9 節のカードの中だけに置き、1 節の `<textarea name="summary">` は `form` 属性で
 * 結び付ける。両方が同じ `useActionState` の状態を見る（失敗時に送られた本文を `defaultValue` へ戻す）ために、1〜9 節のカードを
 * この Provider で包む。カード本体は Server Component のまま（`children` として受ける）
 */
export function ReportNotesProvider({ action, children }: { action: ReportNotesAction; children: ReactNode }) {
  const [state, formAction, pending] = useActionState(action, INITIAL_REPORT_NOTES_STATE);
  return <Ctx.Provider value={{ state, formAction, pending }}>{children}</Ctx.Provider>;
}

function useNotes(): NotesContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("ReportNotesProvider の中で使う");
  return ctx;
}

/** 本文の表示。空白なしの 2,000 文字で段組みが崩れないように `overflow-wrap: anywhere`（U23） */
const TEXTAREA_STYLE = { overflowWrap: "anywhere", resize: "vertical", minHeight: "6em" } as const;

/** 1 節「総評」の入力欄。`form` 属性で 9 節のフォームに結び付ける */
export function SummaryField({ saved }: { saved: string }) {
  const { state, pending } = useNotes();
  return (
    <div className="stack">
      <label htmlFor="report-summary" className="small muted">
        結果、課題、翌月の方針
      </label>
      <textarea
        id="report-summary"
        name="summary"
        form={REPORT_NOTES_FORM_ID}
        className="input input--block"
        rows={4}
        defaultValue={state.values?.summary ?? saved}
        disabled={pending}
        style={TEXTAREA_STYLE}
      />
    </div>
  );
}

/** 9 節「翌月の施策」の入力欄とフォーム本体（隠し `month`、保存のボタン、送信中の印、文言） */
export function NextPlanForm({ month, saved, savedAt }: { month: string; saved: string; savedAt: string | null }) {
  const { state, formAction, pending } = useNotes();
  return (
    <form id={REPORT_NOTES_FORM_ID} action={formAction} className="stack" aria-label="レポートの記入欄">
      <input type="hidden" name="month" value={month} />
      <label htmlFor="report-next-plan" className="small muted">
        翌月の施策
      </label>
      <textarea
        id="report-next-plan"
        name="next_plan"
        className="input input--block"
        rows={4}
        defaultValue={state.values?.next_plan ?? saved}
        disabled={pending}
        style={TEXTAREA_STYLE}
      />
      <div className="field-row">
        <button
          type="submit"
          className="btn"
          disabled={pending}
          aria-disabled={pending || undefined}
          style={{ position: "relative" }}
        >
          保存
          <span aria-hidden="true" className="link-pending" data-pending={pending || undefined} />
        </button>
        {savedAt !== null && <span className="small muted">保存: {savedAt}</span>}
      </div>
      <p aria-live="polite" className={state.status === "error" ? "field-error" : "small muted"} style={{ margin: 0 }}>
        {state.status === "idle" ? "" : state.message}
      </p>
    </form>
  );
}
