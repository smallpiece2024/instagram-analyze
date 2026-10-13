"use server";
/**
 * レポートの記入欄（総評、翌月の施策）を保存する Server Action（R6 設計 6.2 節）。このファイルは Action の関数だけを export する
 * （export の一覧はテストで固定）。検査と文言は `_report/input.ts`、月の検査は `@/lib/report-month`、SQL は `@/lib/queries/report-notes`。
 *
 * 先頭で順に検査する（どれかで落ちたら何も書かず、固定の文言を返す。R5 の `authorize()` と同じ順）:
 * 0. 環境（`readEnv()` が `ok` でなければ）
 * 1. 同一オリジンの POST か（`isSameOriginPost`。Next.js 自身の Origin の検査に重ねる）
 * 2. 認可。`checkAccess` には固定の経路 `"/report"` を渡す。要求の見出しから取った経路は使わない
 * 3. 対象のアカウント（`getTargetAccount()`。フォームから `account_id` を受け取らない）
 * 4. 入力の形（すべて文字列、`month`・`summary`・`next_plan` が 1 つずつ）
 * 5. 月（ページと同じ `parseReportMonth`。選べる月は `getDailyRange()` から列挙し、空なら拒む）
 * 6. 本文（NFC → 改行 → 末尾の空白 → 0〜2,000 コードポイント → 使えない文字）
 * 7. upsert
 *
 * - 成功したら `revalidatePath("/report")`。`redirect` と `router.refresh()` は使わない
 * - 失敗時は送られた本文（正規化前）を `values` に入れて返す（`<textarea defaultValue>` に戻すため。U3）
 * - ログは Action の名前、結果、SQLSTATE だけ（本文、`values`、月は出さない）。DB のエラー文は返さない
 */
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { checkAccess } from "@/lib/auth";
import { readEnv } from "@/lib/env";
import { allValuesAreStrings, saved, singleString } from "@/lib/form-input";
import { getTargetAccount } from "@/lib/queries/account";
import { getDailyRange } from "@/lib/queries/period-summary";
import { upsertReportNotes } from "@/lib/queries/report-notes";
import { parseReportMonth, selectableReportMonths } from "@/lib/report-month";
import { isSameOriginPost } from "@/lib/request-guard";
import {
  checkNote,
  failedWithValues,
  messageForNote,
  REPORT_NOTES_MESSAGES,
  type ReportNotesState,
  type ReportNotesValues,
} from "./_report/input";

const REPORT_PATH = "/report";
const ACTION = "saveReportNotes";

type RejectReason = "config" | "origin" | "access" | "account" | "input" | "range" | "month" | "note";

function logRejected(reason: RejectReason): void {
  console.error(`[report-notes] action=${ACTION} result=rejected reason=${reason}`);
}

/** 失敗時に `<textarea>` へ戻す本文（正規化前）。文字列でない項目（`File`）やない項目は空 */
function sentValues(formData: FormData): ReportNotesValues {
  const text = (name: string): string => {
    const v = formData.get(name);
    return typeof v === "string" ? v : "";
  };
  return { summary: text("summary"), next_plan: text("next_plan") };
}

export async function saveReportNotes(_prev: ReportNotesState, formData: FormData): Promise<ReportNotesState> {
  const values = sentValues(formData);
  const fail = (message: string = REPORT_NOTES_MESSAGES.failed): ReportNotesState => failedWithValues(message, values);

  // 0. 環境
  const env = readEnv();
  if (!env.ok) {
    logRejected("config");
    return fail();
  }
  // 1. 同一オリジン
  const h = await headers();
  if (!isSameOriginPost({ secFetchSite: h.get("sec-fetch-site"), origin: h.get("origin") }, env.env.appUrl)) {
    logRejected("origin");
    return fail();
  }
  // 2. 認可（経路は固定の値。要求の見出しから取らない）
  if ((await checkAccess(REPORT_PATH)) !== "pass") {
    logRejected("access");
    return fail();
  }
  // 3. 対象のアカウント
  const account = await getTargetAccount();
  if (!account.ok) {
    logRejected("account");
    return fail();
  }
  const accountId = account.data.id;
  // 4. 入力の形
  if (!allValuesAreStrings(formData)) {
    logRejected("input");
    return fail();
  }
  const month = singleString(formData, "month");
  const summary = singleString(formData, "summary");
  const nextPlan = singleString(formData, "next_plan");
  if (month === undefined || summary === undefined || nextPlan === undefined) {
    logRejected("input");
    return fail();
  }
  // 5. 月（ページと同じ検査。選べる月が空 = 日次指標がないアカウントには書けない）
  const range = await getDailyRange(accountId);
  if (!range.ok) {
    logRejected("range");
    return fail();
  }
  const selectable = range.data === null ? [] : selectableReportMonths({ start: range.data.start, latest: range.data.end });
  const parsedMonth = parseReportMonth(month, selectable);
  if (parsedMonth === undefined) {
    logRejected("month");
    return fail(REPORT_NOTES_MESSAGES.month);
  }
  // 6. 本文
  const checkedSummary = checkNote(summary);
  if (!checkedSummary.ok) {
    logRejected("note");
    return fail(messageForNote(checkedSummary.reason));
  }
  const checkedNextPlan = checkNote(nextPlan);
  if (!checkedNextPlan.ok) {
    logRejected("note");
    return fail(messageForNote(checkedNextPlan.reason));
  }
  // 7. 書き込み
  const result = await upsertReportNotes(accountId, parsedMonth, checkedSummary.value, checkedNextPlan.value);
  if (!result.ok) {
    const sqlstate = result.kind === "db" ? result.sqlstate : undefined;
    console.error(
      `[report-notes] action=${ACTION} result=${result.kind === "db" ? "db_error" : "config"}${sqlstate ? ` sqlstate=${sqlstate}` : ""}`,
    );
    return fail();
  }
  revalidatePath(REPORT_PATH);
  return saved();
}
