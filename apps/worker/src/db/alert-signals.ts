/**
 * `check-alerts --scope daily` の低下の通知に使う読み出し（R6 設計 4.3 節）。
 *
 * - `readNonFollowerReachWindows`: `public.account_daily_wide`（`security_invoker` のビュー。ワーカーは表の所有者で接続するので
 *   そのまま読める）から、`reach` のある最新の日を基点に直近 7 日と基準 28 日の Σ非フォロワーリーチ／Σリーチと使えた日数
 * - `countRecentPosts`: `public.media` の直近 7 日（太平洋時間の日付）の投稿数（ストーリーズを除く）
 * - `readFollowerPair`: `public.profile_daily` の `followers_count` が null でない新しい順 2 件
 *
 * 既存の `account-daily.ts` と `profile.ts` は書き込みの置き場所なので触らない。基の表 `account_daily_metrics` を直接集計すると
 * 内訳の 0／null の規則（R3）を 2 か所に持つことになるので、ビューを読む。
 * postgres.js は `bigint` を文字列で返すので、`::bigint`／`::int` にした上で `Number()` に直す。
 * `account_id` は必ず付ける。この層はログを出さない（合計値は呼び出し側にも出さない。S1）
 */
import type { Db } from "./client.js";
import type { FollowerRecord, RatioWindow } from "../jobs/alerts.js";

/** 2 つの窓と基点の日（`countRecentPosts` に渡す。`YYYY-MM-DD`） */
export interface NonFollowerReachWindows {
  recent: RatioWindow;
  base: RatioWindow;
  latest: string;
}

interface WindowsRow {
  recent_days: number;
  recent_num: string | null;
  recent_den: string | null;
  base_days: number;
  base_num: string | null;
  base_den: string | null;
  latest: string;
}

/** `sum` が null（使えた日が 0）は 0 にする */
function toTotal(value: string | null): number {
  return value === null ? 0 : Number(value);
}

/**
 * `reach` のある最新の日を基点に、直近（`latest − 6` 〜 `latest`）と基準（`latest − 34` 〜 `latest − 7`）の合計と使えた日数。
 * `reach` と `reach_non_follower` がともにある日だけを数える（`coalesce` で 0 にしない。内訳が null の日は分母にも入れない。D12）。
 * 日次指標（`reach` のある日）が 1 日もなければ `undefined`。基点はあるが使えた日が 0 なら、合計 0・日数 0 を返す（`no_history` になる）
 */
export async function readNonFollowerReachWindows(db: Db, accountId: string): Promise<NonFollowerReachWindows | undefined> {
  const rows = await db<WindowsRow[]>`
    with latest as (
      select max(metric_date) as d from public.account_daily_wide where account_id = ${accountId} and reach is not null
    )
    select
      (count(w.metric_date) filter (where w.metric_date > l.d - 7))::int                  as recent_days,
      (sum(w.reach_non_follower) filter (where w.metric_date > l.d - 7))::bigint         as recent_num,
      (sum(w.reach) filter (where w.metric_date > l.d - 7))::bigint                      as recent_den,
      (count(w.metric_date) filter (where w.metric_date <= l.d - 7))::int                as base_days,
      (sum(w.reach_non_follower) filter (where w.metric_date <= l.d - 7))::bigint        as base_num,
      (sum(w.reach) filter (where w.metric_date <= l.d - 7))::bigint                     as base_den,
      l.d::text as latest
    from latest l
    left join public.account_daily_wide w
      on w.account_id = ${accountId} and w.metric_date between l.d - 34 and l.d
      and w.reach is not null and w.reach_non_follower is not null
    where l.d is not null
    group by l.d
  `;
  const row = rows[0];
  if (!row) return undefined;
  return {
    recent: { numerator: toTotal(row.recent_num), denominator: toTotal(row.recent_den), days: Number(row.recent_days) },
    base: { numerator: toTotal(row.base_num), denominator: toTotal(row.base_den), days: Number(row.base_days) },
    latest: row.latest,
  };
}

/** `latest − 6` 〜 `latest`（太平洋時間の日付）に投稿された投稿の数。ストーリーズ（`STORY`）は除く */
export async function countRecentPosts(db: Db, accountId: string, latest: string): Promise<number> {
  const rows = await db<{ posts: number }[]>`
    select count(*)::int as posts
    from public.media
    where account_id = ${accountId} and media_product_type <> 'STORY'
      and (posted_at at time zone 'America/Los_Angeles')::date between ${latest}::date - 6 and ${latest}::date
  `;
  return Number(rows[0]?.posts ?? 0);
}

/**
 * `followers_count` が null でない記録の新しい順 2 件。1 件なら `previous` は null。記録がなければ `undefined`。
 * `previous` が前日かどうかは純関数（`jobs/alerts.ts`）で確かめる
 */
export async function readFollowerPair(db: Db, accountId: string): Promise<{ latest: FollowerRecord; previous: FollowerRecord | null } | undefined> {
  const rows = await db<{ captured_on: string; followers_count: number | string }[]>`
    select captured_on::text as captured_on, followers_count
    from public.profile_daily
    where account_id = ${accountId} and followers_count is not null
    order by captured_on desc
    limit 2
  `;
  const [first, second] = rows;
  if (!first) return undefined;
  const toRecord = (row: { captured_on: string; followers_count: number | string }): FollowerRecord => ({
    capturedOn: row.captured_on,
    count: Number(row.followers_count),
  });
  return { latest: toRecord(first), previous: second ? toRecord(second) : null };
}
