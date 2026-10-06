/**
 * 対象のアカウントの決定（R3 設計 4.1 節）。サーバーだけの環境変数 `META_TARGET_IG_USER_ID` と `accounts.ig_user_id` が
 * 一致する行を選ぶ。未設定、または一致する行がなければ、ほかのアカウントを代わりに選ばず失敗を返す。
 * R3 の読み出し関数はすべて、ここで決めた `accountId` を第 1 引数に取る。
 */
import "server-only";
import { cache } from "react";
import { dbFromEnv } from "@/lib/db";
import { describeDbError, type QueryResult } from "@/lib/db-errors";
import { markDynamic } from "@/lib/dynamic";
import { configMissingReason, readEnv } from "@/lib/env";

export interface TargetAccount {
  /** `accounts.id`（uuid） */
  id: string;
  ig_user_id: string;
  username: string | null;
  name: string | null;
  /** `accounts.status`（active／paused／disconnected） */
  status: string;
}

/** 未設定と一致なしの固定文言（3.1 節）。どちらの場合も同じ文言にする */
export const TARGET_ACCOUNT_NOT_SET = "対象のアカウントが設定されていません";

/** 対象のアカウント 1 件。同一リクエスト内では `React.cache` で 1 回だけ読む */
export const getTargetAccount = cache(async (): Promise<QueryResult<TargetAccount>> => {
  await markDynamic();
  const env = readEnv();
  if (!env.ok) return { ok: false, reason: configMissingReason(env.missing) };
  const target = env.env.targetIgUserId;
  if (target === undefined) return { ok: false, reason: TARGET_ACCOUNT_NOT_SET };
  try {
    const db = dbFromEnv(env.env);
    // ig_user_id は unique。一致がなければ 0 行（ほかの行で代用しない）
    const rows = await db<TargetAccount[]>`
      select id, ig_user_id, username, name, status
      from public.accounts
      where ig_user_id = ${target}
    `;
    const row = rows[0];
    if (row === undefined) return { ok: false, reason: TARGET_ACCOUNT_NOT_SET };
    return { ok: true, data: { ...row } };
  } catch (e) {
    return { ok: false, reason: describeDbError(e) };
  }
});
