/**
 * アカウント日次指標の取得と行への変換（設計 5.2 章、5.3 章、13.1 章 P1／P3／P4、13.2 章の `online_followers`）。
 *
 * - 1 日分は `ACCOUNT_METRIC_GROUPS` の 4 リクエスト（内訳の種類ごとにまとめる。P1 で確定）＋ `online_followers` 1 回
 * - `total_value` には `end_time` がないので、日付は要求した日をそのまま使う（P3）
 * - 値 0 の区分は `results` に含まれない（P4）。内訳つきの印の行 `(metric, breakdown, '')` を書き、
 *   「内訳の値の行がなく印の行があれば 0、印の行がなければ未取得」と読む（DB 設計 3.4 章）
 * - まとめたリクエストがコード 100 で失敗したら 1 指標ずつ取り直す。単独でも取れない指標は、内訳なしなら
 *   `value = null` の行（欠損）、内訳つきなら行なし
 * - 2 年より前の日付のエラー（`isHistoryLimitError`）は失敗に数えず、`historyLimit: true` で呼び出し側に返す
 *
 * `toAccountDailyRows`、`toOnlineFollowersRows`、`isHistoryLimitError`、`toMetricValue` は純粋関数。
 * `fetchAccountDay` だけが `JobContext` を使う（API の呼び出しと失敗の記録。DB には書かない）
 */
import type { AccountDailyMetricRow } from "../db/types.js";
import type { GraphError, GraphParams } from "../lib/graph.js";
import { pacificDayRange } from "../lib/time.js";
import type { JobContext, JobName } from "./framework.js";
import type { Tracked } from "./graph-client.js";

/** 1 リクエストにまとめる指標の組（設計 5.2 章の表）。`breakdown` はリクエスト全体に効くので内訳の種類ごとに分ける */
export interface AccountMetricGroup {
  breakdown: string | undefined;
  metrics: string[];
}

/** 設計 5.2 章の 4 グループ。実機確認（P1）で 4 グループとも 1 リクエストで取れた */
export const ACCOUNT_METRIC_GROUPS: readonly AccountMetricGroup[] = [
  {
    breakdown: undefined,
    metrics: [
      "reach",
      "views",
      "accounts_engaged",
      "total_interactions",
      "likes",
      "comments",
      "shares",
      "saves",
      "replies",
      "reposts",
      "follows_and_unfollows",
      "profile_links_taps",
    ],
  },
  { breakdown: "follow_type", metrics: ["reach", "views", "follows_and_unfollows"] },
  { breakdown: "media_product_type", metrics: ["reach", "views", "total_interactions"] },
  { breakdown: "contact_button_type", metrics: ["profile_links_taps"] },
];

/** 時間帯別のオンラインフォロワー数（設計 13.2 章）。`period=lifetime` で 1 日 1 リクエスト */
export const ONLINE_FOLLOWERS_METRIC = "online_followers";

/** `online_followers` の行の `breakdown`。`breakdown_value` は時間帯のキー（`0`〜`23`） */
export const ONLINE_FOLLOWERS_BREAKDOWN = "hour";

/** 2 年より前の日付を指定したときの Graph API のメッセージの一部（設計 5.3 章、P10 で確定） */
export const HISTORY_LIMIT_MESSAGE_PART = "available for the last 2 years";

/** `Tracked.error` がないときに `recordFailure` に渡す文言 */
const UNKNOWN_ERROR_MESSAGE = "不明なエラー";

// ---------------------------------------------------------------------------
// レスポンスの形（`verify-api.ts` の型と R0 の記録に合わせる。各項目は省略されうるので緩く持つ）
// ---------------------------------------------------------------------------

export interface InsightBreakdownResult {
  dimension_values?: string[];
  value?: unknown;
}

export interface InsightBreakdown {
  dimension_keys?: string[];
  results?: InsightBreakdownResult[];
}

export interface InsightTotalValue {
  value?: unknown;
  breakdowns?: InsightBreakdown[];
}

/** time_series の 1 要素。`online_followers` では `value` が時間帯 → 人数のオブジェクト */
export interface InsightValue {
  value?: unknown;
  end_time?: string;
}

export interface InsightItem {
  name?: string;
  period?: string;
  values?: InsightValue[];
  total_value?: InsightTotalValue;
}

/** `GET {ig_user_id}/insights` の応答 */
export interface InsightsResponse {
  data?: InsightItem[];
}

// ---------------------------------------------------------------------------
// 純粋関数
// ---------------------------------------------------------------------------

/**
 * API の値を `account_daily_metrics.value`（bigint）に入れる数値にする。
 * 整数の数値と整数の文字列だけを受け付け、それ以外（undefined、null、小数、文字列、オブジェクト）は null
 */
export function toMetricValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/** 「2 年より前」のエラーか。`code === 100` かつメッセージに `available for the last 2 years` を含む（設計 5.3 章） */
export function isHistoryLimitError(error: GraphError | undefined): boolean {
  return error?.code === 100 && typeof error.message === "string" && error.message.includes(HISTORY_LIMIT_MESSAGE_PART);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `data[]` を `name` で引けるようにする。順序に依存しない。同じ名前が複数あれば後の方 */
function itemsByName(body: InsightsResponse | undefined): Map<string, InsightItem> {
  const map = new Map<string, InsightItem>();
  const data = body?.data;
  if (!Array.isArray(data)) return map;
  for (const item of data) {
    if (isRecord(item) && typeof item.name === "string") map.set(item.name, item as InsightItem);
  }
  return map;
}

/** 内訳の種類に対応する `results[]`。`dimension_keys` が一致するものを優先し、なければ先頭 */
function breakdownResults(item: InsightItem | undefined, breakdown: string): InsightBreakdownResult[] {
  const breakdowns = item?.total_value?.breakdowns;
  if (!Array.isArray(breakdowns) || breakdowns.length === 0) return [];
  const matched = breakdowns.find((b) => Array.isArray(b?.dimension_keys) && b.dimension_keys[0] === breakdown) ?? breakdowns[0];
  const results = matched?.results;
  return Array.isArray(results) ? results.filter(isRecord) : [];
}

interface RowSource {
  accountId: string;
  date: string;
  fetchedAt: Date;
  rawResponseId: string | undefined;
}

function makeRow(src: RowSource, metric: string, breakdown: string, breakdownValue: string, value: number | null): AccountDailyMetricRow {
  return {
    account_id: src.accountId,
    metric_date: src.date,
    metric,
    breakdown,
    breakdown_value: breakdownValue,
    value,
    fetched_at: src.fetchedAt,
    raw_response_id: src.rawResponseId ?? null,
  };
}

export interface ToAccountDailyRowsArgs extends RowSource {
  /** 要求した指標。レスポンスにない指標も行にする（内訳なしは null、内訳つきは印の行だけ） */
  metrics: string[];
  breakdown: string | undefined;
  body: InsightsResponse | undefined;
}

/**
 * `total_value` のレスポンスを `account_daily_metrics` の行にする（純粋関数）。
 * - 内訳なし: 要求した指標ごとに `(date, metric, '', '', total_value.value)`。レスポンスにない指標、値がない指標は null
 * - 内訳つき: 指標ごとに印の行 `(date, metric, breakdown, '', total_value.value ?? null)` と、
 *   `results[]` ごとに `(date, metric, breakdown, dimension_values[0], value)`。`results` が空なら印の行だけ
 * 日付は要求した日（P3。`total_value` に `end_time` はない）。`data[]` の順序に依存しない
 */
export function toAccountDailyRows(args: ToAccountDailyRowsArgs): AccountDailyMetricRow[] {
  const items = itemsByName(args.body);
  const breakdown = args.breakdown ?? "";
  const rows: AccountDailyMetricRow[] = [];
  for (const metric of args.metrics) {
    const item = items.get(metric);
    rows.push(makeRow(args, metric, breakdown, "", toMetricValue(item?.total_value?.value)));
    if (args.breakdown === undefined) continue;
    for (const result of breakdownResults(item, args.breakdown)) {
      const key = result.dimension_values?.[0];
      // 空文字は印の行と主キーが衝突するので書かない
      if (typeof key !== "string" || key === "") continue;
      rows.push(makeRow(args, metric, breakdown, key, toMetricValue(result.value)));
    }
  }
  return rows;
}

export interface ToOnlineFollowersRowsArgs extends RowSource {
  body: InsightsResponse | undefined;
}

/**
 * `online_followers` のレスポンスを行にする（純粋関数。設計 13.2 章）。
 * `values[0].value`（時間帯 → 人数）のキーごとに `(date, 'online_followers', 'hour', '<時間帯>', 人数)` と、
 * 印の行 `(date, 'online_followers', 'hour', '', null)`。
 * **数値の値が 1 つもなければ空配列**（印の行も書かない。取れない日は `value` が `{}` で返る）。数値でない値は無視する
 */
export function toOnlineFollowersRows(args: ToOnlineFollowersRowsArgs): AccountDailyMetricRow[] {
  const item = itemsByName(args.body).get(ONLINE_FOLLOWERS_METRIC);
  const first = Array.isArray(item?.values) ? item.values[0] : undefined;
  const hours = isRecord(first) && isRecord(first.value) ? first.value : undefined;
  if (!hours) return [];
  const rows: AccountDailyMetricRow[] = [];
  for (const [hour, raw] of Object.entries(hours)) {
    const value = toMetricValue(raw);
    if (value === null || hour === "") continue;
    rows.push(makeRow(args, ONLINE_FOLLOWERS_METRIC, ONLINE_FOLLOWERS_BREAKDOWN, hour, value));
  }
  if (rows.length === 0) return [];
  return [makeRow(args, ONLINE_FOLLOWERS_METRIC, ONLINE_FOLLOWERS_BREAKDOWN, "", null), ...rows];
}

// ---------------------------------------------------------------------------
// 1 日分の取得（API を呼ぶ。DB には書かない）
// ---------------------------------------------------------------------------

export interface FetchAccountDayOptions {
  /** ログの `job=` に出す */
  jobName?: JobName;
  /** false なら `online_followers` を取らない（バックフィル。設計 13.2 章）。既定 true */
  includeOnlineFollowers?: boolean;
}

export interface AccountDayResult {
  rows: AccountDailyMetricRow[];
  /** 1 つでも失敗（`recordFailure` 済み）があれば true */
  failed: boolean;
  /** 2 年より前の日付で API が拒んだ。`rows` は空で、この応答は失敗に数えていない */
  historyLimit: boolean;
  /** 失敗した応答の Graph API のコード（重複なし）。バックフィルの「2 年の判定に失敗した可能性」の判定に使う */
  errorCodes: number[];
}

function insightsParams(metrics: string[], breakdown: string | undefined, since: number, until: number): GraphParams {
  return { metric: metrics.join(","), period: "day", metric_type: "total_value", breakdown, since, until };
}

/**
 * 1 日分（PT の `date`）のアカウント日次指標を取り、行にして返す。
 * 4 グループ → `online_followers` の順に `ctx.graph.get` を呼ぶ（`db.begin` の外で呼ぶこと）。
 * - グループが `fatal` のコード 100 で失敗したら 1 指標ずつ取り直す（`warn` の行 `error_code=100`）。
 *   単独でも取れない指標は `recordFailure` し、内訳なしで `fatal` なら `value = null` の行を足す
 *   （`transient` はレスポンスがないので行なし）
 * - 最初のグループが「2 年より前」のエラーなら、残りを呼ばず `historyLimit: true` で返す
 * - `transient` やコード 100 以外の `fatal` は `recordFailure` して次のグループへ
 * - `online_followers` の空（`{}`）は失敗にしない
 * `RateLimitExceeded` と `AuthError` は `ctx.graph.get` が投げ、ここでは捕まえない
 */
export async function fetchAccountDay(
  ctx: JobContext,
  date: string,
  options: FetchAccountDayOptions = {},
): Promise<AccountDayResult> {
  const path = `${ctx.account.ig_user_id}/insights`;
  const { since, until } = pacificDayRange(date);
  const accountId = ctx.account.id;
  const rows: AccountDailyMetricRow[] = [];
  const errorCodes = new Set<number>();
  let failed = false;

  const fail = (res: Tracked<unknown>): void => {
    failed = true;
    if (typeof res.error?.code === "number") errorCodes.add(res.error.code);
    ctx.recordFailure({
      code: res.error?.code,
      errorClass: res.errorClass ?? "unknown",
      message: res.error?.message ?? UNKNOWN_ERROR_MESSAGE,
    });
  };

  const source = (res: Tracked<unknown>): RowSource => ({ accountId, date, fetchedAt: res.fetchedAt, rawResponseId: res.rawResponseId });

  for (const group of ACCOUNT_METRIC_GROUPS) {
    const res = await ctx.graph.get<InsightsResponse>(path, insightsParams(group.metrics, group.breakdown, since, until));
    if (res.ok) {
      rows.push(...toAccountDailyRows({ ...source(res), metrics: group.metrics, breakdown: group.breakdown, body: res.data }));
      continue;
    }
    if (isHistoryLimitError(res.error)) {
      return { rows: [], failed, historyLimit: true, errorCodes: [...errorCodes] };
    }
    if (res.errorClass === "fatal" && res.error?.code === 100) {
      ctx.log.warn({
        job: options.jobName,
        date,
        breakdown: group.breakdown,
        metrics: group.metrics.length,
        warn: "まとめて取れないので 1 指標ずつ取り直す",
        error_code: 100,
        class: "fatal",
      });
      const missing: string[] = [];
      let lastCode: number | undefined;
      for (const metric of group.metrics) {
        const one = await ctx.graph.get<InsightsResponse>(path, insightsParams([metric], group.breakdown, since, until));
        if (one.ok) {
          rows.push(...toAccountDailyRows({ ...source(one), metrics: [metric], breakdown: group.breakdown, body: one.data }));
          continue;
        }
        fail(one);
        missing.push(metric);
        lastCode = one.error?.code ?? lastCode;
        // 取得したが値が返らなかった（欠損）。レスポンスがない transient は行を書かない
        if (group.breakdown === undefined && one.errorClass === "fatal") {
          rows.push(makeRow(source(one), metric, "", "", null));
        }
      }
      if (missing.length > 0) {
        ctx.log.warn({
          job: options.jobName,
          date,
          breakdown: group.breakdown,
          warn: "単独でも取れない指標",
          metrics: missing.join(","),
          error_code: lastCode ?? "none",
          class: "fatal",
        });
      }
      continue;
    }
    fail(res);
  }

  if (options.includeOnlineFollowers !== false) {
    const res = await ctx.graph.get<InsightsResponse>(path, {
      metric: ONLINE_FOLLOWERS_METRIC,
      period: "lifetime",
      since,
      until,
    });
    if (res.ok) {
      rows.push(...toOnlineFollowersRows({ ...source(res), body: res.data }));
    } else {
      fail(res);
    }
  }

  return { rows, failed, historyLimit: false, errorCodes: [...errorCodes] };
}
