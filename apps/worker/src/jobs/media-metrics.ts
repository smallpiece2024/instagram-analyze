/**
 * 投稿とストーリーズの指標の取得と JSON の組み立て（設計 5.5 章、5.6 章、9.1 章、13.1 章 P5）。
 *
 * - `MEDIA_METRICS_BY_TYPE`: 種類（FEED、REELS、STORY）ごとに、内訳なしで 1 回にまとめて取る指標と、
 *   内訳つきで別のリクエストにする指標（P5: 内訳つきは内訳なしと同じリクエストに入れられない）
 * - `fetchMediaInsights`: 1 メディア分の API 呼び出し。`media_snapshot` と `stories` の両方が使う。
 *   `ctx.db.begin` の中から呼ばないこと（API の呼び出しと生レスポンスの保存を含む）
 * - `toMediaMetrics`: レスポンスから `media_insight_snapshots.metrics` の JSON を作る純粋関数。
 *   キーがない: その種類では取れない（対象外）、null: 取れるはずが取れなかった（欠損）、数値: 値
 * - `isUnsupportedMetricError`: 「does not support」のエラー（code 100、subcode なし）の判定
 *
 * メディアの ID はログに出さない（設計 8.1 章）。ログに出すのは指標名とコードだけ。
 */
import type { MediaMetrics, MediaMetricValue, MediaProductType } from "../db/types.js";
import type { GraphError } from "../lib/graph.js";
import type { JobContext, JobName } from "./framework.js";
import type { Tracked } from "./graph-client.js";

/** 内訳つきで取る指標の指定（1 指標 1 リクエスト） */
export interface BreakdownSpec {
  metric: string;
  breakdown: string;
}

/** 種類ごとに取る指標。`plain` は 1 回のリクエストにまとめる */
export interface MetricSet {
  plain: string[];
  breakdowns: BreakdownSpec[];
}

/** フィードとリールに共通する内訳なしの指標（R0 検証 2.4 章） */
const COMMON_POST_METRICS: readonly string[] = [
  "views",
  "reach",
  "likes",
  "comments",
  "saved",
  "shares",
  "reposts",
  "total_interactions",
];

/**
 * 種類ごとの指標の一覧（設計 5.5 章、5.6 章。R0 検証 2.4 章と `metric_definitions` に合わせる）。
 * REELS では `profile_visits`、`profile_activity`、`follows` が「does not support」になるので入れない。
 * 取れない指標が増えたら（カルーセルやフィード動画は未検証）、`fetchMediaInsights` が 1 指標ずつ取り直して
 * `warn` の行を出すので、それを見てこの定数を直す
 */
export const MEDIA_METRICS_BY_TYPE: Readonly<Record<MediaProductType, MetricSet>> = {
  FEED: {
    plain: [...COMMON_POST_METRICS, "profile_visits", "follows"],
    breakdowns: [{ metric: "profile_activity", breakdown: "action_type" }],
  },
  REELS: {
    plain: [...COMMON_POST_METRICS, "ig_reels_avg_watch_time", "ig_reels_video_view_total_time", "reels_skip_rate"],
    breakdowns: [],
  },
  STORY: {
    plain: ["views", "reach", "replies", "shares", "reposts", "total_interactions", "profile_visits", "follows", "link_clicks"],
    breakdowns: [
      { metric: "navigation", breakdown: "story_navigation_action_type" },
      { metric: "profile_activity", breakdown: "action_type" },
    ],
  },
};

/** その種類で `metrics` のキーになりうる指標（内訳なし ＋ 内訳つき） */
export function expectedMetricKeys(set: MetricSet): string[] {
  return [...set.plain, ...set.breakdowns.map((b) => b.metric)];
}

// ---------------------------------------------------------------------------
// レスポンスの形（`{media_id}/insights`）
// ---------------------------------------------------------------------------

export interface InsightValue {
  value?: unknown;
  end_time?: string;
}

export interface InsightBreakdownResult {
  dimension_values?: unknown[];
  value?: unknown;
}

export interface InsightBreakdown {
  dimension_keys?: string[];
  results?: InsightBreakdownResult[];
}

/**
 * `data[]` の 1 要素。内訳なしは `values[0].value`（`metric_type` なし）。
 * 内訳つきは `metric_type=total_value` を付けて要求し `total_value.breakdowns[].results[]` で返るが、
 * 付けなかったときの `values[0].value` がオブジェクト（`{ BIO_LINK_CLICKED: 3 }`）の形も受ける
 */
export interface InsightItem {
  name?: string;
  period?: string;
  values?: InsightValue[];
  total_value?: {
    value?: unknown;
    breakdowns?: InsightBreakdown[];
  };
  title?: string;
  description?: string;
  id?: string;
}

export interface InsightsBody {
  data?: InsightItem[];
}

// ---------------------------------------------------------------------------
// 純粋関数
// ---------------------------------------------------------------------------

/**
 * 「does not support」のエラー。R0 の実機では code 100、`error_subcode` なし、メッセージは
 * `The Media Insights API does not support the <metric> metric for this media product type.`。
 * 存在しないメディアのエラー（code 100、subcode 33）も `does not support this operation` を含むので、
 * 「does not support」だけでは判定せず `does not support the <指標> metric` の形で判定する。
 * `Tracked.error.message` はマスク済みだが、指標名はマスクの対象にならないので判定できる
 */
const UNSUPPORTED_METRIC_PATTERN = /does not support the \S+ metric/;

export function isUnsupportedMetricError(error: GraphError | undefined): boolean {
  return error?.code === 100 && UNSUPPORTED_METRIC_PATTERN.test(error.message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 指標の値。数値はそのまま、数値の文字列は `Number`、それ以外（オブジェクト、空、NaN）は null */
function toMetricValue(raw: unknown): MediaMetricValue {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * 内訳つきの 1 指標を `{ [内訳の値（小文字）]: 値 }` にする。
 * `total_value` があれば `breakdowns[].results[]`（値 0 の区分は API が返さないので、空なら `{}`）。
 * なければ `values[0].value` のオブジェクト。どちらでもなければ null（欠損）
 */
function toBreakdownValues(item: InsightItem): Record<string, MediaMetricValue> | null {
  const out: Record<string, MediaMetricValue> = {};
  if (isRecord(item.total_value)) {
    for (const group of item.total_value.breakdowns ?? []) {
      for (const result of group.results ?? []) {
        const key = result.dimension_values?.[0];
        if (typeof key !== "string" || key === "") continue;
        out[key.toLowerCase()] = toMetricValue(result.value);
      }
    }
    return out;
  }
  const first = item.values?.[0]?.value;
  if (isRecord(first)) {
    for (const [key, value] of Object.entries(first)) {
      if (key === "") continue;
      out[key.toLowerCase()] = toMetricValue(value);
    }
    return out;
  }
  return null;
}

/** `data[]` を `name` で引けるようにする。同じ名前が複数あれば先頭を使う */
function indexByName(body: InsightsBody | undefined): Map<string, InsightItem> {
  const index = new Map<string, InsightItem>();
  for (const item of body?.data ?? []) {
    if (typeof item?.name === "string" && !index.has(item.name)) index.set(item.name, item);
  }
  return index;
}

export interface ToMediaMetricsArgs {
  expected: MetricSet;
  /** 内訳なしのレスポンス。undefined なら期待する指標はすべて null */
  plain: InsightsBody | undefined;
  /** 指標名 → 内訳つきのレスポンス。undefined（失敗）なら null */
  breakdowns: Record<string, InsightsBody | undefined>;
  /** 「does not support」だった指標。キーを作らない */
  unsupported: string[];
}

/**
 * `media_insight_snapshots.metrics` を組み立てる純粋関数（設計 5.5 章、DB 設計 3.6 章）。
 * - 期待する指標だけをキーにし、期待外の指標は無視する
 * - 内訳なし: `values[0].value`。返らなかった、`values[0]` がない、数値に読めない → null
 * - 内訳つき: `{ [dimension_values[0] の小文字]: 値 }`。レスポンスがなければ null
 * - `unsupported` の指標はキーなし
 */
export function toMediaMetrics(args: ToMediaMetricsArgs): MediaMetrics {
  const unsupported = new Set(args.unsupported);
  const plain = indexByName(args.plain);
  const out: MediaMetrics = {};
  for (const metric of args.expected.plain) {
    if (unsupported.has(metric)) continue;
    const item = plain.get(metric);
    out[metric] = item ? toMetricValue(item.values?.[0]?.value) : null;
  }
  for (const { metric } of args.expected.breakdowns) {
    if (unsupported.has(metric)) continue;
    const body = args.breakdowns[metric];
    const item = body ? indexByName(body).get(metric) : undefined;
    out[metric] = item ? toBreakdownValues(item) : null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// API の呼び出し
// ---------------------------------------------------------------------------

export interface MediaInsightsTarget {
  /** Instagram のメディア ID */
  id: string;
  media_product_type: MediaProductType;
}

export interface MediaInsightsResult {
  /** 内訳なしの指標を取れた（まとめて、または 1 指標ずつで 1 つ以上）。内訳つきの失敗では false にならない */
  ok: boolean;
  /** `media_insight_snapshots.metrics`。`ok` でなくても期待する指標をすべて null にした形で返す */
  metrics: MediaMetrics;
  /**
   * 内訳なしのリクエスト直前の時刻。`fetched_at` に使う。
   * 1 指標ずつ取り直したときは `rawResponseId` と同じく最初に成功した単独の応答の時刻（全部失敗ならまとめた取得のもの）
   */
  fetchedAt: Date;
  /**
   * `raw_response_id` に結ぶ生レスポンス。内訳なしのレスポンス（1 指標ずつのときは最初に成功したもの）。
   * `fatal` のときはエラー応答。`transient`（再試行を使い切った）のときは undefined で、呼び出し側は行を書かない
   */
  rawResponseId: string | undefined;
  /** このメディアで `ctx.recordFailure` を呼んだ回数 */
  failures: number;
}

export interface FetchMediaInsightsOptions {
  /** ログの `job=` に出す名前。省略時は `media_snapshot`（`stories` ジョブは `stories` を渡す） */
  job?: JobName;
}

const UNKNOWN_ERROR = "不明なエラー";

/**
 * 存在しない（削除済み、アーカイブ済み）か権限のないメディアのエラー。code 100、`error_subcode` 33
 * （`Unsupported get request. Object with ID '…' does not exist, cannot be loaded due to missing permissions, …`）。
 * 1 指標ずつ取り直しても同じエラーが返るだけなので、取り直さずに null の行にする
 */
function isMissingMediaError(error: GraphError | undefined): boolean {
  return error?.code === 100 && error.error_subcode === 33;
}

/**
 * 1 メディア分の指標を取る（設計 5.5 章の「API」「複数リクエストの一部が失敗」「fatal」「transient」の行）。
 *
 * 1. 内訳なしの指標を 1 回で取る。
 *    - `ok`: そのまま
 *    - `fatal` で code 100（subcode 33 を除く）: 1 指標ずつ取り直す。「does not support」の指標は対象外（キーなし）、
 *      それ以外の失敗は null（欠損）にして `recordFailure`。取り直したことを `warn` の行で出す
 *    - `fatal` で code 100・subcode 33（存在しない・権限のないメディア）または code 100 以外: `recordFailure` を
 *      1 回。期待する指標をすべて null にして `rawResponseId` にエラー応答を結んで返す（呼び出し側は null の行を
 *      書く）。内訳つきは取らない。subcode 33 は `warn` の行を出す
 *    - `transient`: `recordFailure`。`rawResponseId` は undefined（呼び出し側は行を書かない）
 * 2. 内訳つきの指標を 1 指標ずつ `metric_type=total_value` で取る。失敗した指標は null で `recordFailure`、
 *    「does not support」なら対象外（キーなし）
 *
 * `RateLimitExceeded` と `AuthError` は捕まえずに外へ出す
 */
export async function fetchMediaInsights(
  ctx: JobContext,
  media: MediaInsightsTarget,
  options: FetchMediaInsightsOptions = {},
): Promise<MediaInsightsResult> {
  const job = options.job ?? "media_snapshot";
  const set = MEDIA_METRICS_BY_TYPE[media.media_product_type];
  const path = `${media.id}/insights`;
  const unsupported: string[] = [];
  let failures = 0;

  const fail = (res: Tracked<unknown>): void => {
    failures += 1;
    ctx.recordFailure({
      code: res.error?.code,
      errorClass: res.errorClass ?? "unknown",
      message: res.error?.message ?? UNKNOWN_ERROR,
    });
  };

  const batch = await ctx.graph.get<InsightsBody>(path, { metric: set.plain.join(",") });
  let fetchedAt = batch.fetchedAt;
  let plain: InsightsBody | undefined;
  let rawResponseId = batch.rawResponseId;
  let ok: boolean;

  if (batch.ok) {
    plain = batch.data;
    ok = true;
  } else if (batch.errorClass === "fatal" && batch.error?.code === 100 && !isMissingMediaError(batch.error)) {
    const data: InsightItem[] = [];
    const unexpected: string[] = [];
    let okCount = 0;
    for (const metric of set.plain) {
      const one = await ctx.graph.get<InsightsBody>(path, { metric });
      if (one.ok) {
        okCount += 1;
        if (okCount === 1) {
          // 行に結ぶ生レスポンスと時刻は、最初に成功した単独の応答のもの
          rawResponseId = one.rawResponseId;
          fetchedAt = one.fetchedAt;
        }
        data.push(...(one.data?.data ?? []));
        continue;
      }
      if (one.errorClass === "fatal" && isUnsupportedMetricError(one.error)) {
        unsupported.push(metric);
        continue;
      }
      if (one.errorClass === "fatal" && one.error?.code === 100) unexpected.push(metric);
      fail(one);
    }
    ctx.log.warn({
      job,
      error_code: 100,
      class: "fatal",
      error: "まとめた取得が code 100 で失敗したため 1 指標ずつ取り直した",
      unsupported: unsupported.length > 0 ? unsupported.join(",") : undefined,
      unexpected: unexpected.length > 0 ? unexpected.join(",") : undefined,
    });
    plain = { data };
    ok = okCount > 0;
  } else {
    if (batch.errorClass === "fatal" && isMissingMediaError(batch.error)) {
      ctx.log.warn({
        job,
        error_code: 100,
        error_subcode: 33,
        class: "fatal",
        error: "メディアが存在しないか権限がない（指標をすべて null にした行を書く）",
      });
    }
    fail(batch);
    return {
      ok: false,
      metrics: toMediaMetrics({ expected: set, plain: undefined, breakdowns: {}, unsupported: [] }),
      fetchedAt,
      rawResponseId: batch.errorClass === "fatal" ? batch.rawResponseId : undefined,
      failures,
    };
  }

  const breakdowns: Record<string, InsightsBody | undefined> = {};
  for (const spec of set.breakdowns) {
    const res = await ctx.graph.get<InsightsBody>(path, {
      metric: spec.metric,
      breakdown: spec.breakdown,
      metric_type: "total_value",
    });
    if (res.ok) {
      breakdowns[spec.metric] = res.data;
      continue;
    }
    if (res.errorClass === "fatal" && isUnsupportedMetricError(res.error)) {
      unsupported.push(spec.metric);
      ctx.log.warn({
        job,
        error_code: 100,
        class: "fatal",
        error: "内訳つきの指標がこの種類では取れない（定数を見直す）",
        unsupported: spec.metric,
      });
      continue;
    }
    breakdowns[spec.metric] = undefined;
    fail(res);
  }

  return {
    ok,
    metrics: toMediaMetrics({ expected: set, plain, breakdowns, unsupported }),
    fetchedAt,
    rawResponseId,
    failures,
  };
}
