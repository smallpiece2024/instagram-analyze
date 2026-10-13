/**
 * 月次レポートの記入欄（`public.report_notes`）の読み書き（R6 設計 5.1 節、6.2 節）。
 *
 * - 1 アカウント 1 月 1 行。`report_month` は月の 1 日（`YYYY-MM-01`。check が 1 日以外を拒む）
 * - 書き込みは `insert … on conflict (account_id, report_month) do update`。`updated_at` はトリガーが入れる（同じ値で保存しても進む。D9）
 * - どの文も `account_id` で絞る。失敗は例外を投げずに結果で返し、SQLSTATE だけを返す（DB のエラー文は返さない。S13）。ログはここでは出さない
 */
import "server-only";
import { cache } from "react";
import { dbFromEnv } from "@/lib/db";
import type { QueryResult } from "@/lib/db-errors";
import { readEnv } from "@/lib/env";
import type { YearMonth } from "@/lib/report-month";
import { sqlStateOf } from "./tag-edit";
import { runQuery } from "./run";

export interface ReportNotes {
  summary: string;
  next_plan: string;
  /** 最後に保存した時刻（「保存: YYYY-MM-DD HH:mm」） */
  updated_at: Date;
}

/** `YYYY-MM` → `YYYY-MM-01`（形の検査が済んだ値にだけ使う） */
function firstDayOf(month: YearMonth): string {
  return `${month}-01`;
}

/** その月の記入欄。未保存なら null */
export const getReportNotes = cache(async (accountId: string, month: YearMonth): Promise<QueryResult<ReportNotes | null>> =>
  runQuery(async (db) => {
    const [row] = await db<ReportNotes[]>`
      select summary, next_plan, updated_at
      from public.report_notes
      where account_id = ${accountId} and report_month = ${firstDayOf(month)}::date
    `;
    return row ? { summary: row.summary, next_plan: row.next_plan, updated_at: row.updated_at } : null;
  }),
);

/** 書き込みの結果。`sqlstate` は Postgres の SQLSTATE（5 文字）のときだけ。環境変数の不足は `config` */
export type ReportNotesWriteResult = { ok: true } | { ok: false; kind: "config" } | { ok: false; kind: "db"; sqlstate: string | undefined };

/** 2 欄を一緒に保存する（後に保存した人の 2 欄で上書き。Q15）。本文は呼ぶ側が検査済み */
export async function upsertReportNotes(
  accountId: string,
  month: YearMonth,
  summary: string,
  nextPlan: string,
): Promise<ReportNotesWriteResult> {
  const env = readEnv();
  if (!env.ok) return { ok: false, kind: "config" };
  try {
    const db = dbFromEnv(env.env);
    await db`
      insert into public.report_notes (account_id, report_month, summary, next_plan)
      values (${accountId}::uuid, ${firstDayOf(month)}::date, ${summary}, ${nextPlan})
      on conflict (account_id, report_month) do update
        set summary = excluded.summary, next_plan = excluded.next_plan
    `;
    return { ok: true };
  } catch (e) {
    return { ok: false, kind: "db", sqlstate: sqlStateOf(e) };
  }
}
