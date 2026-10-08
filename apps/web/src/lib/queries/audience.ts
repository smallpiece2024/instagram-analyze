/**
 * オーディエンス（`/audience`）の読み出し（R5 設計 6.4 節）。
 *
 * - 指標と timeframe の記録を直近 52 週（JST の今日から 364 日より後の月曜）だけ読む
 * - 記録 × 区分の行を返す。`empty` の記録は区分の行がないので、`value_key` と `value` が null の 1 行になる
 * - `bigint` の人数は SQL で `float8` にして数で返す。`week_start`（date）は `YYYY-MM-DD` の文字列のまま
 * - 割合、上位の切り出し、欠けの扱いは `lib/audience.ts`
 */
import "server-only";
import { cache } from "react";
import { AUDIENCE_WEEKS, type AudienceMetric, type AudienceRow } from "@/lib/audience";
import type { QueryResult } from "@/lib/db-errors";
import { runQuery } from "./run";

/** 週 × 内訳 × 区分の行（週、内訳、区分の名前の順） */
export const getAudience = cache(
  async (accountId: string, metric: AudienceMetric, timeframe: string): Promise<QueryResult<AudienceRow[]>> =>
    runQuery(async (db) => {
      const rows = await db<AudienceRow[]>`
        select
          c.week_start, c.breakdown, c.status, c.fetched_at,
          v.value_key, v.value::float8 as value
        from public.audience_captures c
        left join public.audience_values v on v.capture_id = c.id
        where c.account_id = ${accountId}
          and c.metric = ${metric}
          and c.timeframe = ${timeframe}
          and c.week_start > (now() at time zone 'Asia/Tokyo')::date - ${AUDIENCE_WEEKS * 7}::int
        order by c.week_start, c.breakdown, v.value_key
      `;
      return rows.map((r) => ({ ...r }));
    }),
);
