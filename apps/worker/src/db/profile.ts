/**
 * `profile_daily` と `accounts` のプロフィール項目（設計 3.4 章、5.1 章、DB 設計 3.3 章）。
 *
 * - `upsertProfileDaily` と `updateAccountProfile` は `profile_daily` ジョブが 1 つのトランザクション（`Tx`）で呼ぶ
 * - `captured_on` は `YYYY-MM-DD` の文字列（JST の日付。`db/client.ts` で `date` 型を文字列のまま扱う）
 * - この層はログを出さない。DB の失敗は呼び出し側（枠組み）が `normalizeDbError` で固定文言にする
 */
import type { Db, Tx } from "./client.js";
import type { ProfileDailyRow } from "./types.js";

/** `accounts.username`、`name` の更新。null の項目は既存の値を残す */
export interface AccountProfile {
  username: string | null;
  name: string | null;
}

/**
 * `profile_daily` を (account_id, captured_on) で upsert する。同じ日に 2 回実行したら後の値で上書きする（F-COL-20）。
 * 取れなかった値は null のまま書く（欠損）
 */
export async function upsertProfileDaily(tx: Tx, row: ProfileDailyRow): Promise<void> {
  await tx`
    insert into public.profile_daily
      (account_id, captured_on, captured_at, followers_count, follows_count, media_count, raw_response_id)
    values
      (${row.account_id}, ${row.captured_on}, ${row.captured_at}, ${row.followers_count}, ${row.follows_count},
       ${row.media_count}, ${row.raw_response_id})
    on conflict (account_id, captured_on) do update set
      captured_at = excluded.captured_at,
      followers_count = excluded.followers_count,
      follows_count = excluded.follows_count,
      media_count = excluded.media_count,
      raw_response_id = excluded.raw_response_id
  `;
}

/**
 * `accounts.username` と `name` を更新する。null の項目は触らない（`coalesce`）。
 * 両方 null なら何もしない（`updated_at` のトリガーも動かさない）。`updated_at` はトリガーが更新する
 */
export async function updateAccountProfile(tx: Tx, accountId: string, profile: AccountProfile): Promise<void> {
  if (profile.username === null && profile.name === null) return;
  await tx`
    update public.accounts set
      username = coalesce(${profile.username}, username),
      name = coalesce(${profile.name}, name)
    where id = ${accountId}
  `;
}

/** テスト用。その日の行。なければ undefined */
export async function getProfileDaily(db: Db, accountId: string, capturedOn: string): Promise<ProfileDailyRow | undefined> {
  const rows = await db<ProfileDailyRow[]>`
    select account_id, captured_on, captured_at, followers_count, follows_count, media_count, raw_response_id
    from public.profile_daily
    where account_id = ${accountId} and captured_on = ${capturedOn}
  `;
  return rows[0];
}
