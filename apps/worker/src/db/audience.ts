/**
 * 属性の週次記録（`audience_captures`、`audience_values`。R5 設計 3.3 節、5.1 節 (2)）。
 *
 * - 書き込みは `audience_demographics` ジョブが組（指標 × timeframe × 内訳）ごとに 1 トランザクション（`Tx`）で呼ぶ
 * - `week_start` は `YYYY-MM-DD` の文字列（JST の月曜。`db/client.ts` で `date` 型を文字列のまま扱う）
 * - この層はログを出さない。DB の失敗は呼び出し側が SQLSTATE だけを記録する
 */
import type { Db, Tx } from "./client.js";

/** `audience_captures.metric` */
export type AudienceMetric = "follower_demographics" | "engaged_audience_demographics";
/** `audience_captures.timeframe` */
export type AudienceTimeframe = "this_week" | "this_month";
/** `audience_captures.breakdown` */
export type AudienceBreakdown = "age" | "gender" | "country" | "city";
/** `audience_captures.status`。`ok` は値の行が 1 件以上、`empty` は 0 件（D10） */
export type AudienceStatus = "ok" | "empty";

/** 組（その週に 1 行） */
export interface AudienceCaptureKey {
  metric: AudienceMetric;
  timeframe: AudienceTimeframe;
  breakdown: AudienceBreakdown;
}

/** `audience_values` の 1 行（`capture_id` を除く） */
export interface AudienceValue {
  value_key: string;
  value: number;
}

/** `audience_captures` に書く 1 行と、`ok` のときの値の行 */
export interface AudienceCaptureInput extends AudienceCaptureKey {
  account_id: string;
  week_start: string;
  status: AudienceStatus;
  fetched_at: Date;
  raw_response_id: string | null;
  /** `status = 'empty'` なら空 */
  values: AudienceValue[];
}

/** `public.audience_captures` */
export interface AudienceCaptureRow extends AudienceCaptureKey {
  id: string;
  account_id: string;
  week_start: string;
  status: AudienceStatus;
  fetched_at: Date;
  raw_response_id: string | null;
}

/** その週に行がある組（ジョブが API を呼ぶ前に飛ばす判定に使う） */
export async function listCapturedKeys(db: Db, accountId: string, weekStart: string): Promise<AudienceCaptureKey[]> {
  const rows = await db<AudienceCaptureKey[]>`
    select metric, timeframe, breakdown
    from public.audience_captures
    where account_id = ${accountId} and week_start = ${weekStart}
  `;
  return [...rows];
}

/**
 * `audience_captures` に 1 行を足し、`id` を返す。同じ組・同じ週の行が既にあれば何もせず undefined（D11。
 * 手元のワーカーと Actions が同時に動いたときなど）
 */
export async function insertAudienceCapture(tx: Tx, row: Omit<AudienceCaptureInput, "values">): Promise<string | undefined> {
  const rows = await tx<{ id: string }[]>`
    insert into public.audience_captures
      (account_id, metric, timeframe, breakdown, week_start, status, fetched_at, raw_response_id)
    values
      (${row.account_id}, ${row.metric}, ${row.timeframe}, ${row.breakdown}, ${row.week_start}, ${row.status},
       ${row.fetched_at}, ${row.raw_response_id})
    on conflict (account_id, metric, timeframe, breakdown, week_start) do nothing
    returning id
  `;
  return rows[0]?.id;
}

/** `audience_values` に区分ごとの行を足す。空なら何もしない */
export async function insertAudienceValues(tx: Tx, captureId: string, values: AudienceValue[]): Promise<void> {
  if (values.length === 0) return;
  const rows = values.map((v) => ({ capture_id: captureId, value_key: v.value_key, value: v.value }));
  await tx`insert into public.audience_values ${tx(rows, "capture_id", "value_key", "value")}`;
}

/**
 * 組 1 つを 1 トランザクションで書く（3.3 節）。書けたら true、同じ週の行が既にあって何もしなかったら false
 * （値も書かない）。`status` と `values` の整合（`ok` は 1 件以上、`empty` は 0 件）は呼び出し側が保つ
 */
export async function writeAudienceCapture(db: Db, capture: AudienceCaptureInput): Promise<boolean> {
  const { values, ...row } = capture;
  return db.begin(async (tx) => {
    const id = await insertAudienceCapture(tx, row);
    if (id === undefined) return false;
    await insertAudienceValues(tx, id, values);
    return true;
  });
}
