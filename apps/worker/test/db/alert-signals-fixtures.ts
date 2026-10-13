/**
 * `db/alert-signals.ts` の結合テストの fixture（R6 設計 4.5 節、S11）。架空のアカウントと、日次指標・`profile_daily`・`media` の行を
 * 入れる helper。値はすべて架空で、実在の ID、ユーザー名、実測の値は使わない。
 *
 * - 日次指標は `upsertAccountDailyMetrics`（既存の書き込み）で入れる。`reach` は印の行（`breakdown = ''`）、非フォロワーは
 *   `follow_type` の `NON_FOLLOWER` の行。`"absent"` は行を入れない（ビュー `account_daily_wide` では null になる）
 * - `media` は直接 insert する（投稿日時と種類だけが要る）
 * - 片付けは `deleteFixtureAccount`（`accounts` を消すと関連する行は CASCADE で消える）
 */
import { upsertAccountDailyMetrics } from "../../src/db/account-daily.js";
import { upsertAccount } from "../../src/db/accounts.js";
import type { Db } from "../../src/db/client.js";
import { upsertProfileDaily } from "../../src/db/profile.js";
import type { AccountDailyMetricRow, AccountRow, MediaProductType } from "../../src/db/types.js";

/** 架空の `ig_user_id`（先頭 6 桁が 0 なので実在の ID と重ならない） */
export function fakeIgUserId(): string {
  return "000000" + Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, "0");
}

/** 架空のアカウントを作る */
export async function createFixtureAccount(db: Db, username: string): Promise<AccountRow> {
  return db.begin((tx) => upsertAccount(tx, { ig_user_id: fakeIgUserId(), username }));
}

/** 架空のアカウントとその関連する行を消す */
export async function deleteFixtureAccount(db: Db, accountId: string): Promise<void> {
  await db`delete from public.accounts where id = ${accountId}`;
}

/** 行を入れない印 */
export type Absent = "absent";

const FIXTURE_FETCHED_AT = new Date("2030-01-01T00:00:00Z");

/**
 * 1 日分の `reach` と非フォロワーリーチ。`null` は値が null の行、`"absent"` は行なし。
 * どちらも `"absent"` なら何も入れない（その日は欠け）
 */
export async function insertDailyReach(
  db: Db,
  accountId: string,
  metricDate: string,
  reach: number | null | Absent,
  nonFollower: number | null | Absent,
): Promise<void> {
  const rows: AccountDailyMetricRow[] = [];
  const base = { account_id: accountId, metric_date: metricDate, metric: "reach", fetched_at: FIXTURE_FETCHED_AT, raw_response_id: null };
  if (reach !== "absent") rows.push({ ...base, breakdown: "", breakdown_value: "", value: reach });
  if (nonFollower !== "absent") rows.push({ ...base, breakdown: "follow_type", breakdown_value: "NON_FOLLOWER", value: nonFollower });
  if (rows.length === 0) return;
  await db.begin((tx) => upsertAccountDailyMetrics(tx, rows));
}

/** `profile_daily` の 1 行。フォロワー数だけを入れ、他の件数は null */
export async function insertFollowers(db: Db, accountId: string, capturedOn: string, followersCount: number | null): Promise<void> {
  await db.begin((tx) =>
    upsertProfileDaily(tx, {
      account_id: accountId,
      captured_on: capturedOn,
      captured_at: new Date(`${capturedOn}T00:00:00Z`),
      followers_count: followersCount,
      follows_count: null,
      media_count: null,
      raw_response_id: null,
    }),
  );
}

let mediaSequence = 0;

/** 投稿（またはストーリーズ）を 1 件入れる。`id` は架空（`fake-alert-…`）。返すのは入れた `id` */
export async function insertPost(db: Db, accountId: string, postedAt: Date, productType: MediaProductType = "FEED"): Promise<string> {
  mediaSequence += 1;
  const id = `fake-alert-${Math.floor(Math.random() * 1_000_000_000)}-${mediaSequence}`;
  await db`
    insert into public.media (id, account_id, media_type, media_product_type, posted_at)
    values (${id}, ${accountId}, 'IMAGE', ${productType}, ${postedAt})
  `;
  return id;
}
