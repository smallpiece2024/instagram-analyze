/**
 * `profile_daily` ジョブ: プロフィールの日次記録（設計 5.1 章。F-COL-10）。
 *
 * - `GET {ig_user_id}?fields=id,username,name,followers_count,follows_count,media_count` を 1 回呼ぶ
 * - `profile_daily` を (account_id, captured_on) で upsert し、`accounts.username`、`name` も更新する（1 トランザクション）
 * - `captured_on` はジョブ開始時刻（`ctx.startedAt`）の JST の日付。`captured_at` は取得時刻（`Tracked.fetchedAt`）
 * - 返らなかったフィールドは null（欠損）。API が失敗したら `recordFailure` だけ呼んで戻る。1 件のみなので
 *   枠組みの規則（`items` 0 かつ `failures` 1 以上 → `failed`。設計 13.2 章）で `failed` になり、`job_runs.error` には
 *   マスク済みの API の文言、ログの WARN 行には `error_code=` と `class=` が残る（`partial` は起きない）
 * - `index.ts` への登録は段階 3 で行う
 */
import { updateAccountProfile, upsertProfileDaily, type AccountProfile } from "../db/profile.js";
import type { ProfileDailyRow } from "../db/types.js";
import { JST, zonedDate } from "../lib/time.js";
import type { JobDefinition } from "./framework.js";

/** リクエストの `fields` */
export const PROFILE_FIELDS = "id,username,name,followers_count,follows_count,media_count";

/** `GET {ig_user_id}?fields=...` の応答。各項目は省略されうる */
export interface ProfileResponse {
  id?: string;
  username?: string;
  name?: string;
  followers_count?: number;
  follows_count?: number;
  media_count?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 件数の列（`integer`）に入れる値。数値か数字の文字列を `Number` で変換し、安全な整数でなければ null。
 * 真偽値や空文字は null（`Number(true)` が 1、`Number("")` が 0 になるのを避ける）
 */
function toCount(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

function toText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * 応答から `profile_daily` の行を組み立てる純粋関数。応答がオブジェクトでなければ全項目 null。
 * `capturedOn` は JST の日付（`YYYY-MM-DD`）、`fetchedAt` は取得時刻、`rawResponseId` は生レスポンスの id
 */
export function toProfileRow(
  body: unknown,
  accountId: string,
  capturedOn: string,
  fetchedAt: Date,
  rawResponseId: string | null,
): ProfileDailyRow {
  const data = isRecord(body) ? body : {};
  return {
    account_id: accountId,
    captured_on: capturedOn,
    captured_at: fetchedAt,
    followers_count: toCount(data["followers_count"]),
    follows_count: toCount(data["follows_count"]),
    media_count: toCount(data["media_count"]),
    raw_response_id: rawResponseId,
  };
}

/** 応答から `accounts.username`、`name` の更新値を取り出す純粋関数。文字列でなければ null（既存の値を残す） */
export function toAccountProfile(body: unknown): AccountProfile {
  const data = isRecord(body) ? body : {};
  return { username: toText(data["username"]), name: toText(data["name"]) };
}

export const job: JobDefinition = {
  name: "profile_daily",
  async run(ctx) {
    // 「今日」はジョブ開始時刻から 1 回だけ求める（設計 5.0 章）
    const capturedOn = zonedDate(ctx.startedAt, JST);

    const res = await ctx.graph.get<ProfileResponse>(ctx.account.ig_user_id, { fields: PROFILE_FIELDS });
    if (!res.ok) {
      // 1 件のみなので、枠組みの規則で failed になる（例外は投げない）
      ctx.recordFailure({
        code: res.error?.code,
        errorClass: res.errorClass ?? "unknown",
        message: res.error?.message ?? "不明なエラー",
      });
      return;
    }

    const row = toProfileRow(res.data, ctx.account.id, capturedOn, res.fetchedAt, res.rawResponseId ?? null);
    const profile = toAccountProfile(res.data);
    await ctx.db.begin(async (tx) => {
      await upsertProfileDaily(tx, row);
      await updateAccountProfile(tx, ctx.account.id, profile);
    });
    ctx.progress.items += 1;
  },
};
