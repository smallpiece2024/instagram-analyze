/**
 * 「AI・OCR の利用状況」（`/jobs`。R4.1 設計 6.4 節）の読み出し。ビュー `ocr_monthly_usage` を `account_id` で必ず絞る。
 * 月は UTC（ビューの `month_utc`）。利用が 0 の月は行が出ないので、画面（`lib/ocr-usage.ts` の `fillMonths`）で補う
 */
import "server-only";
import { cache } from "react";
import type { QueryResult } from "@/lib/db-errors";
import type { OcrMonthRow } from "@/lib/ocr-usage";
import { runQuery } from "./run";

/** 月ごとの利用（全期間。新しい順）。行がなければ空 */
export const getOcrMonthlyUsage = cache(async (accountId: string): Promise<QueryResult<OcrMonthRow[]>> =>
  runQuery(async (db) => {
    const rows = await db<OcrMonthRow[]>`
      select
        to_char(month_utc, 'YYYY-MM') as month,
        requests, failed_requests, images, units, videos
      from public.ocr_monthly_usage
      where account_id = ${accountId}
      order by month_utc desc
    `;
    return rows.map((r) => ({ ...r }));
  }),
);
