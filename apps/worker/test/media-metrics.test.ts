/**
 * `jobs/media-metrics.ts` の単体テスト（設計 9.1 章の `toMediaMetrics`、`isUnsupportedMetricError` の行）。
 * `fetchMediaInsights` は、`graph.get` を差し替えた偽の `JobContext` で動かす（DB と API に触らない）。
 */
import { describe, expect, it } from "vitest";
import type { WorkerConfig } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import type { MediaProductType } from "../src/db/types.js";
import type { ItemFailure, JobContext } from "../src/jobs/framework.js";
import { AuthError, type JobGraphClient, type Tracked } from "../src/jobs/graph-client.js";
import {
  expectedMetricKeys,
  fetchMediaInsights,
  isUnsupportedMetricError,
  MEDIA_METRICS_BY_TYPE,
  toMediaMetrics,
  type InsightItem,
  type InsightsBody,
  type MetricSet,
} from "../src/jobs/media-metrics.js";
import { RateLimitExceeded, RateMonitor } from "../src/jobs/rate.js";
import type { GraphError, GraphParams } from "../src/lib/graph.js";
import type { LogFields, Logger } from "../src/lib/log.js";

const FIXED_NOW = new Date("2026-10-01T12:00:00.000Z");

const FEED_PLAIN = [
  "views",
  "reach",
  "likes",
  "comments",
  "saved",
  "shares",
  "reposts",
  "total_interactions",
  "profile_visits",
  "follows",
];
const REELS_PLAIN = [
  "views",
  "reach",
  "likes",
  "comments",
  "saved",
  "shares",
  "reposts",
  "total_interactions",
  "ig_reels_avg_watch_time",
  "ig_reels_video_view_total_time",
  "reels_skip_rate",
];
const STORY_PLAIN = ["views", "reach", "replies", "shares", "reposts", "total_interactions", "profile_visits", "follows", "link_clicks"];

const UNSUPPORTED_MESSAGE = "The Media Insights API does not support the profile_visits metric for this media product type.";
const NOT_EXIST_MESSAGE =
  "Unsupported get request. Object with ID '***' does not exist, cannot be loaded due to missing permissions, or does not support this operation. Please read the Graph API documentation at <url>";

// ---------------------------------------------------------------------------
// レスポンスの組み立て
// ---------------------------------------------------------------------------

function item(name: string, value: unknown): InsightItem {
  return { name, period: "lifetime", values: [{ value }], title: name, description: "", id: `x/insights/${name}/lifetime` };
}

function plainBody(values: Record<string, unknown>): InsightsBody {
  return { data: Object.entries(values).map(([name, value]) => item(name, value)) };
}

function breakdownBody(metric: string, results: Record<string, unknown>, dimension = "action_type"): InsightsBody {
  return {
    data: [
      {
        name: metric,
        period: "lifetime",
        total_value: {
          breakdowns: [
            {
              dimension_keys: [dimension],
              results: Object.entries(results).map(([key, value]) => ({ dimension_values: [key], value })),
            },
          ],
        },
        title: metric,
        description: "",
        id: `x/insights/${metric}/lifetime`,
      },
    ],
  };
}

const FEED_VALUES: Record<string, number> = {
  views: 1520,
  reach: 980,
  likes: 40,
  comments: 3,
  saved: 31,
  shares: 5,
  reposts: 0,
  total_interactions: 79,
  profile_visits: 12,
  follows: 2,
};

const FEED_EXPECTED = { ...FEED_VALUES, profile_activity: { bio_link_clicked: 3, call: 0 } };

// ---------------------------------------------------------------------------
// MEDIA_METRICS_BY_TYPE、expectedMetricKeys
// ---------------------------------------------------------------------------

describe("MEDIA_METRICS_BY_TYPE", () => {
  it("設計 5.5 章、5.6 章の一覧と一致する（REELS に profile_visits、follows、profile_activity がない）", () => {
    expect(MEDIA_METRICS_BY_TYPE.FEED).toEqual({
      plain: FEED_PLAIN,
      breakdowns: [{ metric: "profile_activity", breakdown: "action_type" }],
    });
    expect(MEDIA_METRICS_BY_TYPE.REELS).toEqual({ plain: REELS_PLAIN, breakdowns: [] });
    expect(MEDIA_METRICS_BY_TYPE.STORY).toEqual({
      plain: STORY_PLAIN,
      breakdowns: [
        { metric: "navigation", breakdown: "story_navigation_action_type" },
        { metric: "profile_activity", breakdown: "action_type" },
      ],
    });
  });

  it("expectedMetricKeys は内訳なし ＋ 内訳つきの指標名", () => {
    expect(expectedMetricKeys(MEDIA_METRICS_BY_TYPE.FEED)).toEqual([...FEED_PLAIN, "profile_activity"]);
    expect(expectedMetricKeys(MEDIA_METRICS_BY_TYPE.REELS)).toEqual(REELS_PLAIN);
    expect(expectedMetricKeys(MEDIA_METRICS_BY_TYPE.STORY)).toEqual([...STORY_PLAIN, "navigation", "profile_activity"]);
    expect(expectedMetricKeys({ plain: [], breakdowns: [] })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// isUnsupportedMetricError
// ---------------------------------------------------------------------------

describe("isUnsupportedMetricError", () => {
  it("code 100 かつ「does not support the <指標> metric」の文言で true", () => {
    expect(isUnsupportedMetricError({ message: UNSUPPORTED_MESSAGE, type: "OAuthException", code: 100 })).toBe(true);
    expect(isUnsupportedMetricError({ message: "does not support the ig_reels_avg_watch_time metric", code: 100 })).toBe(true);
  });

  it("「2 years」の文言、code 190、subcode 33（存在しないメディア。does not support this operation）、undefined は false", () => {
    expect(
      isUnsupportedMetricError({
        message: "(#100) since param is not valid. Metrics data is available for the last 2 years",
        code: 100,
      }),
    ).toBe(false);
    expect(isUnsupportedMetricError({ message: UNSUPPORTED_MESSAGE, code: 190 })).toBe(false);
    expect(isUnsupportedMetricError({ message: UNSUPPORTED_MESSAGE })).toBe(false);
    expect(isUnsupportedMetricError({ message: NOT_EXIST_MESSAGE, code: 100, error_subcode: 33 })).toBe(false);
    expect(isUnsupportedMetricError(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// toMediaMetrics
// ---------------------------------------------------------------------------

describe("toMediaMetrics", () => {
  const feed = MEDIA_METRICS_BY_TYPE.FEED;

  it("内訳なしは values[0].value、内訳つきは入れ子で内訳の値を小文字にする", () => {
    const metrics = toMediaMetrics({
      expected: feed,
      plain: plainBody(FEED_VALUES),
      breakdowns: { profile_activity: breakdownBody("profile_activity", { BIO_LINK_CLICKED: 3, CALL: 0 }) },
      unsupported: [],
    });
    expect(metrics).toEqual(FEED_EXPECTED);
    expect(Object.keys(metrics)).toEqual([...FEED_PLAIN, "profile_activity"]);
  });

  it("期待したのに返らなかった指標は null、期待外の指標は無視する", () => {
    const { follows: _follows, ...withoutFollows } = FEED_VALUES;
    const metrics = toMediaMetrics({
      expected: feed,
      plain: plainBody({ ...withoutFollows, facebook_views: 10, crossposted_views: 2 }),
      breakdowns: { profile_activity: breakdownBody("profile_activity", { BIO_LINK_CLICKED: 3 }) },
      unsupported: [],
    });
    expect(metrics["follows"]).toBeNull();
    expect(metrics).not.toHaveProperty("facebook_views");
    expect(metrics).not.toHaveProperty("crossposted_views");
    expect(metrics["views"]).toBe(1520);
  });

  it("unsupported の指標はキーなし（内訳なしも内訳つきも）。期待外の名前が unsupported にあっても無害", () => {
    const metrics = toMediaMetrics({
      expected: feed,
      plain: plainBody(FEED_VALUES),
      breakdowns: {},
      unsupported: ["profile_visits", "follows", "profile_activity", "not_expected"],
    });
    expect(metrics).not.toHaveProperty("profile_visits");
    expect(metrics).not.toHaveProperty("follows");
    expect(metrics).not.toHaveProperty("profile_activity");
    expect(metrics).not.toHaveProperty("not_expected");
    expect(Object.keys(metrics)).toHaveLength(8);
  });

  it("values[0] がない、values がない、値がオブジェクト → null。値が数値の文字列 → 数値。読めない文字列 → null", () => {
    const metrics = toMediaMetrics({
      expected: { plain: ["a", "b", "c", "d", "e", "f"], breakdowns: [] },
      plain: {
        data: [
          { name: "a", values: [] },
          { name: "b" },
          { name: "c", values: [{ value: { X: 1 } }] },
          { name: "d", values: [{ value: "12" }] },
          { name: "e", values: [{ value: "abc" }] },
          { name: "f", values: [{ value: 0 }] },
        ],
      },
      breakdowns: {},
      unsupported: [],
    });
    expect(metrics).toEqual({ a: null, b: null, c: null, d: 12, e: null, f: 0 });
  });

  it("内訳つきのレスポンスが undefined（失敗）なら null。レスポンスに指標がなくても null。results が空なら {}", () => {
    const set: MetricSet = {
      plain: [],
      breakdowns: [
        { metric: "profile_activity", breakdown: "action_type" },
        { metric: "navigation", breakdown: "story_navigation_action_type" },
      ],
    };
    expect(
      toMediaMetrics({ expected: set, plain: undefined, breakdowns: { profile_activity: undefined }, unsupported: [] }),
    ).toEqual({ profile_activity: null, navigation: null });
    expect(
      toMediaMetrics({
        expected: set,
        plain: undefined,
        breakdowns: { profile_activity: { data: [] }, navigation: breakdownBody("navigation", {}) },
        unsupported: [],
      }),
    ).toEqual({ profile_activity: null, navigation: {} });
  });

  it("内訳つきが metric_type なしの形（values[0].value がオブジェクト）でも読める。内訳の値が文字列なら数値、読めなければ null", () => {
    const metrics = toMediaMetrics({
      expected: { plain: [], breakdowns: [{ metric: "navigation", breakdown: "story_navigation_action_type" }] },
      plain: undefined,
      breakdowns: {
        navigation: { data: [{ name: "navigation", values: [{ value: { TAP_FORWARD: 120, TAP_BACK: "8", TAP_EXIT: "x" } }] }] },
      },
      unsupported: [],
    });
    expect(metrics).toEqual({ navigation: { tap_forward: 120, tap_back: 8, tap_exit: null } });
  });

  it("plain が undefined なら期待する指標がすべて null（fatal の行の形）", () => {
    const metrics = toMediaMetrics({ expected: feed, plain: undefined, breakdowns: {}, unsupported: [] });
    expect(Object.keys(metrics)).toEqual([...FEED_PLAIN, "profile_activity"]);
    expect(Object.values(metrics).every((v) => v === null)).toBe(true);
  });

  it("STORY の形: navigation と profile_activity が入れ子になる", () => {
    const story = MEDIA_METRICS_BY_TYPE.STORY;
    const metrics = toMediaMetrics({
      expected: story,
      plain: plainBody({ views: 50, reach: 45, replies: 0, shares: 1, reposts: 0, total_interactions: 1, profile_visits: 2, follows: 0, link_clicks: 3 }),
      breakdowns: {
        navigation: breakdownBody("navigation", { TAP_FORWARD: 30, TAP_BACK: 2, TAP_EXIT: 5, SWIPE_FORWARD: 8 }, "story_navigation_action_type"),
        profile_activity: breakdownBody("profile_activity", { BIO_LINK_CLICKED: 1 }),
      },
      unsupported: [],
    });
    expect(metrics["navigation"]).toEqual({ tap_forward: 30, tap_back: 2, tap_exit: 5, swipe_forward: 8 });
    expect(metrics["profile_activity"]).toEqual({ bio_link_clicked: 1 });
    expect(metrics["link_clicks"]).toBe(3);
    expect(Object.keys(metrics)).toHaveLength(11);
  });
});

// ---------------------------------------------------------------------------
// fetchMediaInsights（偽の JobContext）
// ---------------------------------------------------------------------------

interface Call {
  path: string;
  params: GraphParams;
}

type Handler = (call: Call) => Tracked<unknown> | Promise<Tracked<unknown>>;

interface Fake {
  ctx: JobContext;
  calls: Call[];
  failures: ItemFailure[];
  warns: LogFields[];
  infos: LogFields[];
}

function fakeContext(handler: Handler): Fake {
  const calls: Call[] = [];
  const failures: ItemFailure[] = [];
  const warns: LogFields[] = [];
  const infos: LogFields[] = [];
  const log: Logger = {
    info: (fields) => void infos.push(fields),
    warn: (fields) => void warns.push(fields),
    debug: () => {},
  };
  const graph: JobGraphClient = {
    get: async <T>(path: string, params: GraphParams = {}): Promise<Tracked<T>> => {
      const call = { path, params };
      calls.push(call);
      return (await handler(call)) as Tracked<T>;
    },
    pages: () => {
      throw new Error("このテストでは使わない");
    },
    debugToken: () => {
      throw new Error("このテストでは使わない");
    },
  };
  const ctx: JobContext = {
    account: {
      id: "00000000-0000-0000-0000-000000000000",
      ig_user_id: "0",
      username: null,
      name: null,
      fb_page_id: null,
      status: "active",
      created_at: FIXED_NOW,
      updated_at: FIXED_NOW,
    },
    db: {} as Db,
    config: {} as WorkerConfig,
    log,
    now: () => FIXED_NOW,
    options: {},
    mask: (text) => text,
    graph,
    rate: new RateMonitor(),
    progress: { items: 0, failures: 0, apiCalls: 0 },
    jobRunId: "1",
    startedAt: FIXED_NOW,
    recordFailure: (failure) => void failures.push(failure),
  };
  return { ctx, calls, failures, warns, infos };
}

let nextRawId = 1;

function okRes(body: unknown, fetchedAt = FIXED_NOW): Tracked<unknown> {
  return { ok: true, status: 200, data: body, error: undefined, errorClass: undefined, rawResponseId: String(nextRawId++), fetchedAt };
}

function fatalRes(error: GraphError): Tracked<unknown> {
  return { ok: false, status: 400, data: undefined, error, errorClass: "fatal", rawResponseId: String(nextRawId++), fetchedAt: FIXED_NOW };
}

/** HTTP 500 の本文も保存されるので `rawResponseId` はある（`fetchMediaInsights` はそれを返さない） */
function transientRes(): Tracked<unknown> {
  return {
    ok: false,
    status: 500,
    data: undefined,
    error: { message: "HTTP 500" },
    errorClass: "transient",
    rawResponseId: String(nextRawId++),
    fetchedAt: FIXED_NOW,
  };
}

function metricsOf(call: Call): string[] {
  return String(call.params["metric"] ?? "").split(",");
}

/** FEED の正常な応答。まとめても 1 指標ずつでも、要求された指標の値を返す */
function feedHandler(call: Call): Tracked<unknown> {
  if (call.params["breakdown"] === "action_type") {
    return okRes(breakdownBody("profile_activity", { BIO_LINK_CLICKED: 3, CALL: 0 }));
  }
  const values: Record<string, unknown> = {};
  for (const metric of metricsOf(call)) values[metric] = FEED_VALUES[metric] ?? 0;
  return okRes(plainBody(values));
}

const media = (id: string, media_product_type: MediaProductType) => ({ id, media_product_type });

describe("fetchMediaInsights", () => {
  it("FEED: 内訳なし 1 回 ＋ 内訳つき 1 回（metric_type=total_value）。rawResponseId と fetchedAt は内訳なしのもの", async () => {
    const plainFetchedAt = new Date("2026-10-01T12:00:05.000Z");
    const fake = fakeContext((call) => {
      if (call.params["breakdown"] === undefined) {
        return { ...feedHandler(call), rawResponseId: "plain-raw", fetchedAt: plainFetchedAt };
      }
      return { ...feedHandler(call), rawResponseId: "breakdown-raw" };
    });
    const result = await fetchMediaInsights(fake.ctx, media("m1", "FEED"));

    expect(fake.calls).toEqual([
      { path: "m1/insights", params: { metric: FEED_PLAIN.join(",") } },
      { path: "m1/insights", params: { metric: "profile_activity", breakdown: "action_type", metric_type: "total_value" } },
    ]);
    expect(result).toEqual({ ok: true, metrics: FEED_EXPECTED, fetchedAt: plainFetchedAt, rawResponseId: "plain-raw", failures: 0 });
    expect(fake.failures).toEqual([]);
    expect(fake.warns).toEqual([]);
  });

  it("REELS: 内訳なし 1 回だけ。follows、profile_visits、profile_activity のキーがない", async () => {
    const fake = fakeContext((call) => {
      const values: Record<string, unknown> = {};
      for (const metric of metricsOf(call)) values[metric] = 7;
      return okRes(plainBody(values));
    });
    const result = await fetchMediaInsights(fake.ctx, media("r1", "REELS"));
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.params).toEqual({ metric: REELS_PLAIN.join(",") });
    expect(Object.keys(result.metrics)).toEqual(REELS_PLAIN);
    expect(result.metrics).not.toHaveProperty("follows");
    expect(result.metrics).not.toHaveProperty("profile_visits");
    expect(result.metrics).not.toHaveProperty("profile_activity");
    expect(result.metrics["reels_skip_rate"]).toBe(7);
    expect(result.ok).toBe(true);
    expect(result.failures).toBe(0);
  });

  it("STORY: 内訳なし 1 回 ＋ 内訳つき 2 回。options.job でログの job= を変えられる", async () => {
    const fake = fakeContext((call) => {
      if (call.params["breakdown"] === "story_navigation_action_type") {
        return okRes(breakdownBody("navigation", { TAP_FORWARD: 30 }, "story_navigation_action_type"));
      }
      if (call.params["breakdown"] === "action_type") {
        return fatalRes({ message: "The Media Insights API does not support the profile_activity metric for this media product type.", code: 100 });
      }
      const values: Record<string, unknown> = {};
      for (const metric of metricsOf(call)) values[metric] = 1;
      return okRes(plainBody(values));
    });
    const result = await fetchMediaInsights(fake.ctx, media("s1", "STORY"), { job: "stories" });
    expect(fake.calls.map((c) => c.params)).toEqual([
      { metric: STORY_PLAIN.join(",") },
      { metric: "navigation", breakdown: "story_navigation_action_type", metric_type: "total_value" },
      { metric: "profile_activity", breakdown: "action_type", metric_type: "total_value" },
    ]);
    expect(result.metrics["navigation"]).toEqual({ tap_forward: 30 });
    // 内訳つきが does not support なら対象外（キーなし）で、失敗には数えない
    expect(result.metrics).not.toHaveProperty("profile_activity");
    expect(result.failures).toBe(0);
    expect(fake.failures).toEqual([]);
    expect(fake.warns).toHaveLength(1);
    expect(fake.warns[0]).toMatchObject({ job: "stories", error_code: 100, class: "fatal", unsupported: "profile_activity" });
  });

  it("まとめた取得が code 100 なら 1 指標ずつ取り直す。does not support の指標はキーなし、他の失敗は null。warn を 1 行。rawResponseId と fetchedAt は最初に成功した単独の応答", async () => {
    const batchFetchedAt = new Date("2026-10-01T12:00:00.000Z");
    let singleIndex = 0;
    const fake = fakeContext((call) => {
      if (call.params["breakdown"] === "action_type") return feedHandler(call);
      const metrics = metricsOf(call);
      if (metrics.length > 1) {
        return { ...fatalRes({ message: UNSUPPORTED_MESSAGE, code: 100 }), rawResponseId: "batch-error", fetchedAt: batchFetchedAt };
      }
      // 単独の応答は 1 秒ずつ後の時刻にする
      singleIndex += 1;
      const fetchedAt = new Date(batchFetchedAt.getTime() + singleIndex * 1000);
      const metric = metrics[0] ?? "";
      if (metric === "profile_visits" || metric === "follows") {
        return { ...fatalRes({ message: `The Media Insights API does not support the ${metric} metric for this media product type.`, code: 100 }), fetchedAt };
      }
      if (metric === "saved") return { ...fatalRes({ message: "(#100) Invalid parameter", code: 100 }), fetchedAt };
      if (metric === "shares") return { ...transientRes(), fetchedAt };
      return { ...feedHandler(call), rawResponseId: `one-${metric}`, fetchedAt };
    });
    const result = await fetchMediaInsights(fake.ctx, media("m2", "FEED"));

    // 1（まとめて）＋ 10（1 指標ずつ）＋ 1（内訳つき）
    expect(fake.calls).toHaveLength(12);
    expect(fake.calls.slice(1, 11).map((c) => c.params)).toEqual(FEED_PLAIN.map((metric) => ({ metric })));
    expect(result.ok).toBe(true);
    expect(result.rawResponseId).toBe("one-views");
    // views は 1 件目の単独の応答（まとめた取得の 1 秒後）
    expect(result.fetchedAt).toEqual(new Date("2026-10-01T12:00:01.000Z"));
    expect(result.metrics).toEqual({
      views: 1520,
      reach: 980,
      likes: 40,
      comments: 3,
      saved: null,
      shares: null,
      reposts: 0,
      total_interactions: 79,
      profile_activity: { bio_link_clicked: 3, call: 0 },
    });
    expect(result.metrics).not.toHaveProperty("profile_visits");
    expect(result.metrics).not.toHaveProperty("follows");
    expect(result.failures).toBe(2);
    expect(fake.failures).toEqual([
      { code: 100, errorClass: "fatal", message: "(#100) Invalid parameter" },
      { code: undefined, errorClass: "transient", message: "HTTP 500" },
    ]);
    expect(fake.warns).toHaveLength(1);
    expect(fake.warns[0]).toMatchObject({
      job: "media_snapshot",
      error_code: 100,
      class: "fatal",
      unsupported: "profile_visits,follows",
      unexpected: "saved",
    });
  });

  it("1 指標ずつでも 1 つも取れなければ ok: false。rawResponseId と fetchedAt はまとめた取得のエラー応答のもの", async () => {
    const invalid: GraphError = { message: "(#100) Invalid parameter", type: "OAuthException", code: 100 };
    const batchFetchedAt = new Date("2026-10-01T12:00:00.000Z");
    const fake = fakeContext((call) => {
      if (call.params["breakdown"] !== undefined) return feedHandler(call);
      if (metricsOf(call).length > 1) return { ...fatalRes(invalid), rawResponseId: "batch-error", fetchedAt: batchFetchedAt };
      return { ...fatalRes(invalid), fetchedAt: new Date(batchFetchedAt.getTime() + 5000) };
    });
    const result = await fetchMediaInsights(fake.ctx, media("m3", "FEED"));
    expect(fake.calls).toHaveLength(12);
    expect(result.ok).toBe(false);
    expect(result.rawResponseId).toBe("batch-error");
    expect(result.fetchedAt).toEqual(batchFetchedAt);
    expect(result.failures).toBe(10);
    expect(result.metrics).toEqual({ ...Object.fromEntries(FEED_PLAIN.map((m) => [m, null])), profile_activity: { bio_link_clicked: 3, call: 0 } });
    expect(fake.warns).toHaveLength(1);
    expect(fake.warns[0]).toMatchObject({ error_code: 100, unexpected: FEED_PLAIN.join(",") });
    // undefined の項目は Logger が出さない
    expect(fake.warns[0]?.["unsupported"]).toBeUndefined();
  });

  it("code 100・subcode 33（存在しない・権限のないメディア）なら取り直さず、期待する指標をすべて null にして rawResponseId（エラー応答）を返す。recordFailure は 1 回、warn は 1 行", async () => {
    const fake = fakeContext(() => ({ ...fatalRes({ message: NOT_EXIST_MESSAGE, type: "GraphMethodException", code: 100, error_subcode: 33 }), rawResponseId: "error-raw" }));
    const result = await fetchMediaInsights(fake.ctx, media("m3b", "FEED"));
    expect(fake.calls).toHaveLength(1);
    expect(result).toEqual({
      ok: false,
      metrics: Object.fromEntries([...FEED_PLAIN, "profile_activity"].map((m) => [m, null])),
      fetchedAt: FIXED_NOW,
      rawResponseId: "error-raw",
      failures: 1,
    });
    expect(fake.failures).toEqual([{ code: 100, errorClass: "fatal", message: NOT_EXIST_MESSAGE }]);
    expect(fake.warns).toHaveLength(1);
    expect(fake.warns[0]).toMatchObject({ job: "media_snapshot", error_code: 100, error_subcode: 33, class: "fatal" });
  });

  it("fatal で code 100 以外なら、期待する指標をすべて null にして rawResponseId（エラー応答）を返す。内訳つきは取らない", async () => {
    const fake = fakeContext(() => ({ ...fatalRes({ message: "Some other error", code: 803 }), rawResponseId: "error-raw" }));
    const result = await fetchMediaInsights(fake.ctx, media("m4", "FEED"));
    expect(fake.calls).toHaveLength(1);
    expect(result).toEqual({
      ok: false,
      metrics: Object.fromEntries([...FEED_PLAIN, "profile_activity"].map((m) => [m, null])),
      fetchedAt: FIXED_NOW,
      rawResponseId: "error-raw",
      failures: 1,
    });
    expect(fake.failures).toEqual([{ code: 803, errorClass: "fatal", message: "Some other error" }]);
    expect(fake.warns).toEqual([]);
  });

  it("transient（再試行を使い切った）なら rawResponseId は undefined。内訳つきは取らない", async () => {
    const fake = fakeContext(() => transientRes());
    const result = await fetchMediaInsights(fake.ctx, media("m5", "FEED"));
    expect(fake.calls).toHaveLength(1);
    expect(result.ok).toBe(false);
    expect(result.rawResponseId).toBeUndefined();
    expect(result.failures).toBe(1);
    expect(Object.values(result.metrics).every((v) => v === null)).toBe(true);
    expect(fake.failures).toEqual([{ code: undefined, errorClass: "transient", message: "HTTP 500" }]);
  });

  it("内訳つきのリクエストが失敗したら、その指標だけ null で recordFailure。ok と rawResponseId は内訳なしのまま", async () => {
    for (const reply of [() => fatalRes({ message: "(#100) Invalid parameter", code: 100 }), () => transientRes()]) {
      const fake = fakeContext((call) => (call.params["breakdown"] === undefined ? { ...feedHandler(call), rawResponseId: "plain-raw" } : reply()));
      const result = await fetchMediaInsights(fake.ctx, media("m6", "FEED"));
      expect(result.ok).toBe(true);
      expect(result.rawResponseId).toBe("plain-raw");
      expect(result.metrics).toEqual({ ...FEED_VALUES, profile_activity: null });
      expect(result.failures).toBe(1);
      expect(fake.failures).toHaveLength(1);
      expect(fake.warns).toEqual([]);
    }
  });

  it("RateLimitExceeded と AuthError は捕まえずに外へ出す", async () => {
    const rate = fakeContext(() => {
      throw RateLimitExceeded.forError(4);
    });
    await expect(fetchMediaInsights(rate.ctx, media("m7", "FEED"))).rejects.toBeInstanceOf(RateLimitExceeded);
    expect(rate.failures).toEqual([]);

    const auth = fakeContext((call) => {
      if (call.params["breakdown"] !== undefined) throw new AuthError(190, "トークンが無効（コード 190）");
      return feedHandler(call);
    });
    await expect(fetchMediaInsights(auth.ctx, media("m8", "FEED"))).rejects.toBeInstanceOf(AuthError);
    expect(auth.failures).toEqual([]);
  });

  it("ログと recordFailure にメディアの ID を出さない", async () => {
    const fake = fakeContext((call) => (metricsOf(call).length > 1 ? fatalRes({ message: UNSUPPORTED_MESSAGE, code: 100 }) : fatalRes({ message: "x", code: 1234 })));
    await fetchMediaInsights(fake.ctx, media("17841400000000099", "REELS"));
    const text = JSON.stringify([fake.warns, fake.infos, fake.failures]);
    expect(text).not.toContain("17841400000000099");
  });
});
