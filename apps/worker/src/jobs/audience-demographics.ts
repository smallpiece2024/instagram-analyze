/**
 * `audience_demographics` ジョブ: フォロワー属性と反応したユーザーの属性の週次記録（R5 設計 3 章。F-COL-30）。
 *
 * - 組は 2 指標（`follower_demographics`、`engaged_audience_demographics`）× 4 内訳（age、gender、country、city）×
 *   timeframe（`this_month` だけ。確認事項 Q7）の 8 つ。1 リクエスト 1 内訳（内訳は同時に指定しない。3.1 節）
 * - 「週」はジョブ開始時刻（`ctx.startedAt`）の JST の月曜。組ごとに、その週の行がまだなければ取る（3.2 節）。
 *   取れた組は同じ週の 2 回目から API を呼ばない。空の応答（100 未満など）も `empty` として記録し、取り直さない
 * - 組ごとに 1 トランザクションで `audience_captures` 1 行と、`ok` なら `audience_values` を書く（3.3 節）。
 *   `on conflict do nothing` で行が返らなければ値を書かず `skipped_this_week` に数える（D11）
 * - API の失敗、応答の形の不正、切り詰めによる区分の重なり、書き込みの失敗は、行を書かずに `recordFailure`（固定の
 *   文言）。翌日に同じ週の取り直しになる。`RateLimitExceeded` と `AuthError` は捕まえない（枠組みに任せる）
 * - ログは件数だけ（区分の名前と値、トークン、`ig_user_id`、URL は出さない。3.4 節）
 * - `items` は書いた組の数（`empty` を含む）
 */
import {
  listCapturedKeys,
  writeAudienceCapture,
  type AudienceBreakdown,
  type AudienceCaptureInput,
  type AudienceCaptureKey,
  type AudienceMetric,
  type AudienceTimeframe,
  type AudienceValue,
} from "../db/audience.js";
import type { Db } from "../db/client.js";
import type { GraphParams } from "../lib/graph.js";
import { addDays, JST, zonedDate } from "../lib/time.js";
import type { JobDefinition } from "./framework.js";

export const AUDIENCE_METRICS: readonly AudienceMetric[] = ["follower_demographics", "engaged_audience_demographics"];
export const AUDIENCE_BREAKDOWNS: readonly AudienceBreakdown[] = ["age", "gender", "country", "city"];
/** 確認事項 Q7: `this_month` だけを取る */
export const AUDIENCE_TIMEFRAMES: readonly AudienceTimeframe[] = ["this_month"];

/** 区分の名前（`value_key`）の上限（コードポイント。T5） */
export const VALUE_KEY_MAX_CODE_POINTS = 200;

/** `recordFailure` とログに使う固定の文言（API や DB の文言を使わない） */
export const FETCH_FAILED_MESSAGE = "属性の取得に失敗";
export const INVALID_RESPONSE_MESSAGE = "属性の応答の形が不正";
export const DUPLICATE_KEY_MESSAGE = "属性の区分の名前が重なった";
export const WRITE_FAILED_MESSAGE = "属性の書き込みに失敗";

const JOB_NAME = "audience_demographics";

/** 取る組の一覧（指標 → 内訳 → timeframe の順。8 つ） */
export function audienceRequests(): AudienceCaptureKey[] {
  const out: AudienceCaptureKey[] = [];
  for (const metric of AUDIENCE_METRICS) {
    for (const breakdown of AUDIENCE_BREAKDOWNS) {
      for (const timeframe of AUDIENCE_TIMEFRAMES) out.push({ metric, timeframe, breakdown });
    }
  }
  return out;
}

/** `GET {ig_user_id}/insights` のパラメータ（3.1 節） */
export function audienceParams(key: AudienceCaptureKey): GraphParams {
  return {
    metric: key.metric,
    period: "lifetime",
    metric_type: "total_value",
    timeframe: key.timeframe,
    breakdown: key.breakdown,
  };
}

/** 時刻の JST の週の月曜（`YYYY-MM-DD`）。JST の日付を求めてから、その曜日の分だけ戻す */
export function jstWeekStart(d: Date): string {
  const date = zonedDate(d, JST);
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 は日曜
  const isoDow = dow === 0 ? 7 : dow;
  return addDays(date, 1 - isoDow);
}

/** 区分の名前をコードポイントで切る（サロゲートペアの途中で切らない。T5） */
export function truncateValueKey(name: string): string {
  return [...name].slice(0, VALUE_KEY_MAX_CODE_POINTS).join("");
}

/** 応答の解析の結果。`duplicate` は切り詰めなどで同じ `value_key` ができた数（T14） */
export type ParsedAudience =
  | { kind: "ok"; values: AudienceValue[] }
  | { kind: "empty" }
  | { kind: "invalid" }
  | { kind: "duplicate"; duplicates: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 件数（`bigint`、0 以上）。`profile-daily.ts` の `toCount` と同じ検査に、負の数を不可として足す */
function toCount(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * 応答を解析する純粋関数（3.1 節、3.3 節）。
 * - `data` が空の配列、`breakdowns` が空、`breakdowns[0]` に `results` がない、`results` が空 → `empty`
 * - `data[0].total_value.breakdowns[0].results[]` の各要素の `dimension_values[0]` と `value` → `ok`
 * - 形が違う（オブジェクトでない、配列でない、指標や内訳の名前が違う、区分の名前が文字列でないか空、値が 0 以上の
 *   整数でない）→ `invalid`（要素 1 つでも不正なら組ごと。黙って捨てない）
 * - 切り詰めた名前が重なった → `duplicate`
 */
export function parseAudienceResponse(body: unknown, key: Pick<AudienceCaptureKey, "metric" | "breakdown">): ParsedAudience {
  if (!isRecord(body) || !Array.isArray(body["data"])) return { kind: "invalid" };
  const data = body["data"];
  if (data.length === 0) return { kind: "empty" };
  const item: unknown = data[0];
  if (!isRecord(item)) return { kind: "invalid" };
  if (item["name"] !== undefined && item["name"] !== key.metric) return { kind: "invalid" };
  const total = item["total_value"];
  if (!isRecord(total) || !Array.isArray(total["breakdowns"])) return { kind: "invalid" };
  const breakdowns = total["breakdowns"];
  if (breakdowns.length === 0) return { kind: "empty" };
  const first: unknown = breakdowns[0];
  if (!isRecord(first)) return { kind: "invalid" };
  const keys = first["dimension_keys"];
  if (keys !== undefined && !(Array.isArray(keys) && keys.length === 1 && keys[0] === key.breakdown)) {
    return { kind: "invalid" };
  }
  const results = first["results"];
  if (results === undefined) return { kind: "empty" };
  if (!Array.isArray(results)) return { kind: "invalid" };

  const values: AudienceValue[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const result of results) {
    if (!isRecord(result)) return { kind: "invalid" };
    const dims = result["dimension_values"];
    if (!Array.isArray(dims) || dims.length !== 1 || typeof dims[0] !== "string" || dims[0] === "") return { kind: "invalid" };
    const value = toCount(result["value"]);
    if (value === null) return { kind: "invalid" };
    const valueKey = truncateValueKey(dims[0]);
    if (seen.has(valueKey)) {
      duplicates += 1;
      continue;
    }
    seen.add(valueKey);
    values.push({ value_key: valueKey, value });
  }
  if (duplicates > 0) return { kind: "duplicate", duplicates };
  return values.length === 0 ? { kind: "empty" } : { kind: "ok", values };
}

/** SQLSTATE（5 文字）だけを取り出す。それ以外のコードやメッセージは見ない */
function sqlState(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

/** DB の読み書き。単体テストで差し替える */
export interface AudienceStore {
  listCapturedKeys: (db: Db, accountId: string, weekStart: string) => Promise<AudienceCaptureKey[]>;
  /** 組 1 つを 1 トランザクションで書く。同じ週の行が既にあれば false */
  write: (db: Db, capture: AudienceCaptureInput) => Promise<boolean>;
}

const DB_STORE: AudienceStore = { listCapturedKeys, write: writeAudienceCapture };

function keyOf(k: AudienceCaptureKey): string {
  return `${k.metric}|${k.timeframe}|${k.breakdown}`;
}

/** `audience_demographics` のジョブ定義を作る。`store` はテスト用（省略時は `db/audience.ts`） */
export function createAudienceDemographicsJob(store: AudienceStore = DB_STORE): JobDefinition {
  return {
    name: JOB_NAME,
    async run(ctx) {
      // 「週」はジョブ開始時刻から 1 回だけ求める（R1 設計 5.0 章）
      const weekStart = jstWeekStart(ctx.startedAt);
      const done = new Set((await store.listCapturedKeys(ctx.db, ctx.account.id, weekStart)).map(keyOf));
      const counts = { captured: 0, empty: 0, skipped: 0, failed: 0 };

      for (const key of audienceRequests()) {
        if (done.has(keyOf(key))) {
          counts.skipped += 1;
          continue;
        }

        // RateLimitExceeded と AuthError はここから外へ出る（捕まえない）
        const res = await ctx.graph.get<unknown>(`${ctx.account.ig_user_id}/insights`, audienceParams(key));
        if (!res.ok) {
          counts.failed += 1;
          ctx.recordFailure({ code: res.error?.code, errorClass: res.errorClass ?? "unknown", message: FETCH_FAILED_MESSAGE });
          continue;
        }

        const parsed = parseAudienceResponse(res.data, key);
        if (parsed.kind === "invalid") {
          counts.failed += 1;
          ctx.recordFailure({ errorClass: "fatal", message: INVALID_RESPONSE_MESSAGE });
          continue;
        }
        if (parsed.kind === "duplicate") {
          counts.failed += 1;
          ctx.recordFailure({ errorClass: "fatal", message: DUPLICATE_KEY_MESSAGE });
          // 区分の名前は出さず、件数だけ（T14）
          ctx.log.warn({ job: JOB_NAME, metric: key.metric, breakdown: key.breakdown, error: DUPLICATE_KEY_MESSAGE, duplicates: parsed.duplicates });
          continue;
        }

        const values = parsed.kind === "ok" ? parsed.values : [];
        let written: boolean;
        try {
          written = await store.write(ctx.db, {
            ...key,
            account_id: ctx.account.id,
            week_start: weekStart,
            status: values.length > 0 ? "ok" : "empty",
            fetched_at: res.fetchedAt,
            raw_response_id: res.rawResponseId ?? null,
            values,
          });
        } catch (error) {
          // DB の文言（値や名前を含みうる）は使わず、SQLSTATE だけ
          counts.failed += 1;
          ctx.recordFailure({ code: sqlState(error), errorClass: "db", message: WRITE_FAILED_MESSAGE });
          continue;
        }
        if (!written) {
          counts.skipped += 1;
          continue;
        }
        ctx.progress.items += 1;
        if (values.length > 0) counts.captured += 1;
        else counts.empty += 1;
      }

      ctx.log.info({
        job: JOB_NAME,
        captured: counts.captured,
        empty: counts.empty,
        skipped_this_week: counts.skipped,
        failed: counts.failed,
      });
    },
  };
}

export const job: JobDefinition = createAudienceDemographicsJob();
