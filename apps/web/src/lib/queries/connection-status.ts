/**
 * 接続状態の読み出し（設計 1.6 章）。ビュー `account_connection_status` に `accounts` を結合して `name` を補い、
 * 最終収集時刻はビューの列を使わず（`token_check` の成功でも進むため）`job_runs` から `token_check` を除いて計算する。
 */
import "server-only";
import { cache } from "react";
import { getDb } from "@/lib/db";
import { describeDbError, type QueryResult } from "@/lib/db-errors";
import { markDynamic } from "@/lib/dynamic";
import { configMissingReason, readEnv } from "@/lib/env";

export interface ConnectionStatus {
  account_id: string;
  username: string | null;
  name: string | null;
  account_status: string;
  token_type: string | null;
  token_expires_at: Date | null;
  data_access_expires_at: Date | null;
  scopes: string[] | null;
  credential_status: string | null;
  last_checked_at: Date | null;
  last_error: string | null;
  last_collected_at: Date | null;
}

/** 全アカウントの接続状態（登録順）。同一リクエスト内では `React.cache` で 1 回だけ読む */
export const getConnectionStatus = cache(async (): Promise<QueryResult<ConnectionStatus[]>> => {
  await markDynamic();
  const env = readEnv();
  if (!env.ok) return { ok: false, reason: configMissingReason(env.missing) };
  try {
    const db = getDb(env.env.databaseUrl);
    const rows = await db<ConnectionStatus[]>`
      select
        s.account_id,
        s.username,
        a.name,
        s.account_status,
        s.token_type,
        s.token_expires_at,
        s.data_access_expires_at,
        s.scopes,
        s.credential_status,
        s.last_checked_at,
        s.last_error,
        (
          select max(j.finished_at)
          from public.job_runs j
          where j.account_id = s.account_id
            and j.job_name <> 'token_check'
            and j.status in ('success', 'partial')
        ) as last_collected_at
      from public.account_connection_status s
      join public.accounts a on a.id = s.account_id
      order by a.created_at, a.id
    `;
    return { ok: true, data: [...rows] };
  } catch (e) {
    return { ok: false, reason: describeDbError(e) };
  }
});
