/**
 * `account_daily_metrics`（設計 3.4 章、3.5 章、13.2 章。DB 設計 3.4 章）。
 *
 * - 主キー (account_id, metric_date, metric, breakdown, breakdown_value) で upsert し、`value`、`fetched_at`、
 *   `raw_response_id` を上書きする。直近 4 日の取り直しとバックフィルはどちらもこれで上書きされる
 * - `value` は bigint 列。行の型は `number` で、読み出しで `Number()` に変換する（null は null のまま）
 * - `metric_date` は `YYYY-MM-DD` の文字列（`db/client.ts` で `date` の変換を外している）
 * - `upsertAccountDailyMetrics` は `Tx` で呼ぶ（1 日分の行を 1 トランザクションに）。この層はログを出さない
 */
import type { Db, Tx } from "./client.js";
import type { AccountDailyMetricRow } from "./types.js";

const COLUMNS = [
  "account_id",
  "metric_date",
  "metric",
  "breakdown",
  "breakdown_value",
  "value",
  "fetched_at",
  "raw_response_id",
] as const;

function rowKey(row: AccountDailyMetricRow): string {
  return [row.account_id, row.metric_date, row.metric, row.breakdown, row.breakdown_value].join("\u0000");
}

/**
 * 主キーが同じ行を 1 つにする（後勝ち）。同じ文で同じ行を 2 回更新すると Postgres が
 * `ON CONFLICT DO UPDATE command cannot affect row a second time` で失敗するため
 */
export function dedupeAccountDailyRows(rows: readonly AccountDailyMetricRow[]): AccountDailyMetricRow[] {
  const byKey = new Map<string, AccountDailyMetricRow>();
  for (const row of rows) byKey.set(rowKey(row), row);
  return [...byKey.values()];
}

/**
 * 複数行を 1 文で upsert し、書いた行数（insert ＋ update）を返す。空配列なら何もせず 0。
 * 主キーが重複する行は後勝ちで 1 つにする
 */
export async function upsertAccountDailyMetrics(tx: Tx, rows: readonly AccountDailyMetricRow[]): Promise<number> {
  const unique = dedupeAccountDailyRows(rows);
  if (unique.length === 0) return 0;
  const result = await tx`
    insert into public.account_daily_metrics ${tx(unique, ...COLUMNS)}
    on conflict (account_id, metric_date, metric, breakdown, breakdown_value) do update set
      value = excluded.value,
      fetched_at = excluded.fetched_at,
      raw_response_id = excluded.raw_response_id
  `;
  return result.count;
}

/** 指標の `metric_date` の一覧（重複なし、昇順）。バックフィルの確認とテストに使う */
export async function listMetricDates(db: Db, accountId: string, metric: string): Promise<string[]> {
  const rows = await db<{ metric_date: string }[]>`
    select distinct metric_date from public.account_daily_metrics
    where account_id = ${accountId} and metric = ${metric}
    order by metric_date
  `;
  return rows.map((row) => row.metric_date);
}

/** postgres.js は bigint を文字列で返すので、`value` を `number` に直す */
function toRow(row: Omit<AccountDailyMetricRow, "value"> & { value: string | number | null }): AccountDailyMetricRow {
  return { ...row, value: row.value === null ? null : Number(row.value) };
}

/** 1 日分の行（`metric`、`breakdown`、`breakdown_value` の順）。`value` は `number`（null は null） */
export async function listAccountDailyMetrics(db: Db, accountId: string, metricDate: string): Promise<AccountDailyMetricRow[]> {
  const rows = await db<(Omit<AccountDailyMetricRow, "value"> & { value: string | null })[]>`
    select account_id, metric_date, metric, breakdown, breakdown_value, value, fetched_at, raw_response_id
    from public.account_daily_metrics
    where account_id = ${accountId} and metric_date = ${metricDate}
    order by metric, breakdown, breakdown_value
  `;
  return rows.map(toRow);
}
