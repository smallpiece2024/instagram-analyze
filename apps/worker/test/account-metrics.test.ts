/**
 * `jobs/account-metrics.ts` の単体テスト（設計 9.1 章の `toAccountDailyRows`、`isHistoryLimitError` の行、13.2 章の `online_followers`）。
 * `fetchAccountDay` は偽の `JobGraphClient` を持つ `JobContext` で動かし、DB には触らない
 */
import { describe, expect, it } from "vitest";
import type { WorkerConfig } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import type { AccountDailyMetricRow, AccountRow } from "../src/db/types.js";
import {
  ACCOUNT_METRIC_GROUPS,
  fetchAccountDay,
  isHistoryLimitError,
  ONLINE_FOLLOWERS_BREAKDOWN,
  ONLINE_FOLLOWERS_METRIC,
  toAccountDailyRows,
  toMetricValue,
  toOnlineFollowersRows,
  type InsightsResponse,
} from "../src/jobs/account-metrics.js";
import type { ItemFailure, JobContext } from "../src/jobs/framework.js";
import type { JobGraphClient, Tracked } from "../src/jobs/graph-client.js";
import { RateMonitor } from "../src/jobs/rate.js";
import type { GraphError, GraphParams } from "../src/lib/graph.js";
import { createLogger, SecretRegistry } from "../src/lib/log.js";
import { pacificDayRange } from "../src/lib/time.js";

const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const IG_USER_ID = "000000123456789";
const FETCHED_AT = new Date("2026-10-01T12:00:00.000Z");
const DATE = "2026-09-29";
const RAW_ID = "42";

const NO_BREAKDOWN_METRICS = ACCOUNT_METRIC_GROUPS[0]?.metrics ?? [];

function item(name: string, value?: unknown, breakdowns?: { key: string; results: { dims: string[]; value: unknown }[] }[]): NonNullable<InsightsResponse["data"]>[number] {
  return {
    name,
    period: "day",
    total_value: {
      ...(value === undefined ? {} : { value }),
      ...(breakdowns
        ? {
            breakdowns: breakdowns.map((b) => ({
              dimension_keys: [b.key],
              results: b.results.map((r) => ({ dimension_values: r.dims, value: r.value })),
            })),
          }
        : {}),
    },
  };
}

function key(row: AccountDailyMetricRow): string {
  return `${row.metric}|${row.breakdown}|${row.breakdown_value}`;
}

function byKey(rows: AccountDailyMetricRow[]): Record<string, number | null> {
  return Object.fromEntries(rows.map((r) => [key(r), r.value]));
}

describe("ACCOUNT_METRIC_GROUPS", () => {
  it("設計 5.2 章の 4 グループ（内訳なし 12 指標、follow_type、media_product_type、contact_button_type）", () => {
    expect(ACCOUNT_METRIC_GROUPS).toHaveLength(4);
    expect(ACCOUNT_METRIC_GROUPS[0]?.breakdown).toBeUndefined();
    expect(NO_BREAKDOWN_METRICS).toHaveLength(12);
    expect(NO_BREAKDOWN_METRICS).toContain("follows_and_unfollows");
    expect(NO_BREAKDOWN_METRICS).toContain("profile_links_taps");
    expect(ACCOUNT_METRIC_GROUPS.slice(1).map((g) => [g.breakdown, g.metrics])).toEqual([
      ["follow_type", ["reach", "views", "follows_and_unfollows"]],
      ["media_product_type", ["reach", "views", "total_interactions"]],
      ["contact_button_type", ["profile_links_taps"]],
    ]);
    expect(ONLINE_FOLLOWERS_METRIC).toBe("online_followers");
  });
});

describe("toMetricValue", () => {
  it("整数と整数の文字列だけを数値にし、それ以外は null", () => {
    expect(toMetricValue(0)).toBe(0);
    expect(toMetricValue(123)).toBe(123);
    expect(toMetricValue("12")).toBe(12);
    expect(toMetricValue(1.5)).toBeNull();
    expect(toMetricValue("abc")).toBeNull();
    expect(toMetricValue("1.5")).toBeNull();
    expect(toMetricValue(undefined)).toBeNull();
    expect(toMetricValue(null)).toBeNull();
    expect(toMetricValue(true)).toBeNull();
    expect(toMetricValue({})).toBeNull();
    expect(toMetricValue(Number.NaN)).toBeNull();
  });
});

describe("toAccountDailyRows", () => {
  const base = { accountId: ACCOUNT_ID, date: DATE, fetchedAt: FETCHED_AT, rawResponseId: RAW_ID };

  it("内訳なし 12 指標: 各指標が (date, metric, '', '', total_value.value) の行になり、共通の列が入る", () => {
    const body: InsightsResponse = { data: NO_BREAKDOWN_METRICS.map((m, i) => item(m, i * 10)) };
    const rows = toAccountDailyRows({ ...base, metrics: NO_BREAKDOWN_METRICS, breakdown: undefined, body });
    expect(rows).toHaveLength(12);
    expect(rows.map((r) => r.metric)).toEqual(NO_BREAKDOWN_METRICS);
    for (const [i, row] of rows.entries()) {
      expect(row).toEqual({
        account_id: ACCOUNT_ID,
        metric_date: DATE,
        metric: NO_BREAKDOWN_METRICS[i],
        breakdown: "",
        breakdown_value: "",
        value: i * 10,
        fetched_at: FETCHED_AT,
        raw_response_id: RAW_ID,
      });
    }
  });

  it("total_value がない、値がない、data にない指標は null。期待外の指標は無視。値 0 は 0", () => {
    const body: InsightsResponse = {
      data: [
        { name: "reach", period: "day" },
        item("views"),
        item("likes", 0),
        item("impressions", 999),
      ],
    };
    const rows = toAccountDailyRows({ ...base, metrics: ["reach", "views", "likes", "comments"], breakdown: undefined, body });
    expect(byKey(rows)).toEqual({ "reach||": null, "views||": null, "likes||": 0, "comments||": null });
  });

  it("body が undefined や data が配列でなくても、要求した指標の null の行になる", () => {
    expect(toAccountDailyRows({ ...base, metrics: ["reach"], breakdown: undefined, body: undefined }).map((r) => r.value)).toEqual([null]);
    expect(
      toAccountDailyRows({ ...base, metrics: ["reach"], breakdown: undefined, body: { data: "x" as unknown as [] } }).map((r) => r.value),
    ).toEqual([null]);
  });

  it("内訳つき: 印の行 (metric, breakdown, '') ＋ results ごとの行。results が空なら印の行だけ。total_value.value がなければ印の行は null", () => {
    const body: InsightsResponse = {
      data: [
        item("reach", 15, [{ key: "follow_type", results: [{ dims: ["FOLLOWER"], value: 10 }, { dims: ["NON_FOLLOWER"], value: 5 }] }]),
        item("views", 0, [{ key: "follow_type", results: [] }]),
        item("follows_and_unfollows", undefined, [{ key: "follow_type", results: [{ dims: ["FOLLOWER"], value: 0 }] }]),
      ],
    };
    const rows = toAccountDailyRows({ ...base, metrics: ["reach", "views", "follows_and_unfollows"], breakdown: "follow_type", body });
    expect(byKey(rows)).toEqual({
      "reach|follow_type|": 15,
      "reach|follow_type|FOLLOWER": 10,
      "reach|follow_type|NON_FOLLOWER": 5,
      "views|follow_type|": 0,
      "follows_and_unfollows|follow_type|": null,
      "follows_and_unfollows|follow_type|FOLLOWER": 0,
    });
    expect(rows.every((r) => r.raw_response_id === RAW_ID && r.fetched_at === FETCHED_AT && r.metric_date === DATE)).toBe(true);
  });

  it("内訳つきで data にない指標は印の行だけ（null）。dimension_values が空や空文字の結果は書かない。数値でない値は null", () => {
    const body: InsightsResponse = {
      data: [
        item("reach", 3, [
          { key: "media_product_type", results: [{ dims: [], value: 1 }, { dims: [""], value: 1 }, { dims: ["REEL"], value: "x" }, { dims: ["POST"], value: "2" }] },
        ]),
      ],
    };
    const rows = toAccountDailyRows({ ...base, metrics: ["reach", "views"], breakdown: "media_product_type", body });
    expect(byKey(rows)).toEqual({
      "reach|media_product_type|": 3,
      "reach|media_product_type|REEL": null,
      "reach|media_product_type|POST": 2,
      "views|media_product_type|": null,
    });
  });

  it("複数の breakdowns があれば dimension_keys が一致するものを使う", () => {
    const body: InsightsResponse = {
      data: [
        item("reach", 9, [
          { key: "other", results: [{ dims: ["X"], value: 1 }] },
          { key: "follow_type", results: [{ dims: ["FOLLOWER"], value: 9 }] },
        ]),
      ],
    };
    const rows = toAccountDailyRows({ ...base, metrics: ["reach"], breakdown: "follow_type", body });
    expect(byKey(rows)).toEqual({ "reach|follow_type|": 9, "reach|follow_type|FOLLOWER": 9 });
  });

  it("data の順序に依存しない（逆順でも同じ行）", () => {
    const data = NO_BREAKDOWN_METRICS.map((m, i) => item(m, i + 1));
    const forward = toAccountDailyRows({ ...base, metrics: NO_BREAKDOWN_METRICS, breakdown: undefined, body: { data } });
    const reversed = toAccountDailyRows({ ...base, metrics: NO_BREAKDOWN_METRICS, breakdown: undefined, body: { data: [...data].reverse() } });
    expect(reversed).toEqual(forward);
  });

  it("rawResponseId が undefined なら raw_response_id は null", () => {
    const rows = toAccountDailyRows({ ...base, rawResponseId: undefined, metrics: ["reach"], breakdown: undefined, body: { data: [item("reach", 1)] } });
    expect(rows[0]?.raw_response_id).toBeNull();
  });
});

describe("toOnlineFollowersRows", () => {
  const base = { accountId: ACCOUNT_ID, date: DATE, fetchedAt: FETCHED_AT, rawResponseId: RAW_ID };

  function body(value: unknown, extra: Partial<NonNullable<InsightsResponse["data"]>[number]> = {}): InsightsResponse {
    return { data: [{ name: ONLINE_FOLLOWERS_METRIC, period: "lifetime", values: [{ value, end_time: "2026-09-30T07:00:00+0000" }], ...extra }] };
  }

  it("24 の時間帯 → 印の行 ＋ 24 行（breakdown は hour、印の行の value は null）", () => {
    const hours = Object.fromEntries(Array.from({ length: 24 }, (_, h) => [String(h), h * 3]));
    const rows = toOnlineFollowersRows({ ...base, body: body(hours) });
    expect(rows).toHaveLength(25);
    expect(rows[0]).toEqual({
      account_id: ACCOUNT_ID,
      metric_date: DATE,
      metric: "online_followers",
      breakdown: ONLINE_FOLLOWERS_BREAKDOWN,
      breakdown_value: "",
      value: null,
      fetched_at: FETCHED_AT,
      raw_response_id: RAW_ID,
    });
    expect(rows.slice(1).map((r) => [r.breakdown_value, r.value])).toEqual(Array.from({ length: 24 }, (_, h) => [String(h), h * 3]));
    expect(rows.every((r) => r.breakdown === "hour")).toBe(true);
  });

  it("value が {} なら 0 行（印の行も書かない）", () => {
    expect(toOnlineFollowersRows({ ...base, body: body({}) })).toEqual([]);
  });

  it("values がない、data が空、body が undefined、name が違う → 0 行", () => {
    expect(toOnlineFollowersRows({ ...base, body: { data: [{ name: ONLINE_FOLLOWERS_METRIC, period: "lifetime" }] } })).toEqual([]);
    expect(toOnlineFollowersRows({ ...base, body: { data: [] } })).toEqual([]);
    expect(toOnlineFollowersRows({ ...base, body: undefined })).toEqual([]);
    expect(toOnlineFollowersRows({ ...base, body: { data: [{ name: "reach", values: [{ value: { "0": 1 } }] }] } })).toEqual([]);
  });

  it("数値でない値は無視し、数値が 1 つもなければ 0 行。値 0 は行になる", () => {
    const rows = toOnlineFollowersRows({ ...base, body: body({ "0": "abc", "1": null, "2": 5, "3": 0, "4": 1.5 }) });
    expect(rows.map((r) => [r.breakdown_value, r.value])).toEqual([["", null], ["2", 5], ["3", 0]]);
    expect(toOnlineFollowersRows({ ...base, body: body({ "0": "abc", "1": null }) })).toEqual([]);
    expect(toOnlineFollowersRows({ ...base, body: body("12") })).toEqual([]);
    expect(toOnlineFollowersRows({ ...base, body: body(null) })).toEqual([]);
  });
});

describe("isHistoryLimitError", () => {
  const history: GraphError = { message: "(#100) since param is not valid. Metrics data is available for the last 2 years", code: 100 };

  it("code 100 かつ「available for the last 2 years」を含むときだけ true", () => {
    expect(isHistoryLimitError(history)).toBe(true);
    expect(isHistoryLimitError({ message: "(#100) The Media Insights API does not support the reach metric", code: 100 })).toBe(false);
    expect(isHistoryLimitError({ ...history, code: 190 })).toBe(false);
    expect(isHistoryLimitError({ message: history.message })).toBe(false);
    expect(isHistoryLimitError(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetchAccountDay（偽の JobGraphClient）
// ---------------------------------------------------------------------------

type Reply =
  | { ok: true; body: unknown }
  | { ok: false; errorClass: "fatal" | "transient"; error?: GraphError; status?: number };

interface Harness {
  ctx: JobContext;
  calls: { path: string; params: GraphParams }[];
  failures: ItemFailure[];
  lines: string[];
}

function harness(replies: Reply[]): Harness {
  const queue = [...replies];
  const calls: Harness["calls"] = [];
  const failures: ItemFailure[] = [];
  const lines: string[] = [];
  let rawId = 0;
  const graph: JobGraphClient = {
    async get<T>(path: string, params: GraphParams = {}): Promise<Tracked<T>> {
      calls.push({ path, params });
      const reply = queue.shift();
      if (!reply) throw new Error("応答の用意がない");
      if (reply.ok) {
        rawId += 1;
        return { ok: true, status: 200, data: reply.body as T, error: undefined, errorClass: undefined, rawResponseId: String(rawId), fetchedAt: FETCHED_AT };
      }
      const status = reply.status ?? (reply.errorClass === "transient" ? 0 : 400);
      if (status !== 0) rawId += 1;
      return {
        ok: false,
        status,
        data: undefined,
        error: reply.error,
        errorClass: reply.errorClass,
        rawResponseId: status === 0 ? undefined : String(rawId),
        fetchedAt: FETCHED_AT,
      };
    },
    pages: () => {
      throw new Error("このテストでは使わない");
    },
    debugToken: () => {
      throw new Error("このテストでは使わない");
    },
  };
  const account = { id: ACCOUNT_ID, ig_user_id: IG_USER_ID, username: null, name: null, fb_page_id: null, status: "active" } as AccountRow;
  const ctx: JobContext = {
    account,
    db: undefined as unknown as Db,
    config: { rateSoftLimit: 50, rateHardLimit: 90, backfillMaxDays: 30 } as WorkerConfig,
    log: createLogger("debug", new SecretRegistry(), (line) => lines.push(line)),
    now: () => FETCHED_AT,
    options: {},
    mask: (text) => text,
    graph,
    rate: new RateMonitor(),
    progress: { items: 0, failures: 0, apiCalls: 0 },
    jobRunId: "1",
    startedAt: FETCHED_AT,
    recordFailure: (failure) => failures.push(failure),
  };
  return { ctx, calls, failures, lines };
}

function groupOk(metrics: string[], breakdown?: string): Reply {
  return {
    ok: true,
    body: {
      data: metrics.map((m) =>
        breakdown ? item(m, 5, [{ key: breakdown, results: [{ dims: ["A"], value: 3 }, { dims: ["B"], value: 2 }] }]) : item(m, 7),
      ),
    },
  };
}

function onlineOk(hours: Record<string, number>): Reply {
  return { ok: true, body: { data: [{ name: ONLINE_FOLLOWERS_METRIC, period: "lifetime", values: [{ value: hours }] }] } };
}

function fatal(code: number, message = `(#${code}) Unsupported`): Reply {
  return { ok: false, errorClass: "fatal", error: { message, code } };
}

const TRANSIENT: Reply = { ok: false, errorClass: "transient", error: { message: "ネットワークエラー", type: "NetworkError" } };
const HISTORY_LIMIT: Reply = fatal(100, "(#100) since param is not valid. Metrics data is available for the last 2 years");

const GROUP_REPLIES: Reply[] = ACCOUNT_METRIC_GROUPS.map((g) => groupOk(g.metrics, g.breakdown));

describe("fetchAccountDay", () => {
  it("4 グループ → online_followers の順に 5 回呼び、パラメータは metric_type=total_value、period=day、since/until は pacificDayRange", async () => {
    const h = harness([...GROUP_REPLIES, onlineOk({ "0": 1, "23": 2 })]);
    const result = await fetchAccountDay(h.ctx, DATE, { jobName: "account_daily" });
    const { since, until } = pacificDayRange(DATE);

    expect(h.calls).toHaveLength(5);
    expect(h.calls.every((c) => c.path === `${IG_USER_ID}/insights`)).toBe(true);
    expect(h.calls.slice(0, 4).map((c) => c.params)).toEqual(
      ACCOUNT_METRIC_GROUPS.map((g) => ({ metric: g.metrics.join(","), period: "day", metric_type: "total_value", breakdown: g.breakdown, since, until })),
    );
    expect(h.calls[4]?.params).toEqual({ metric: "online_followers", period: "lifetime", since, until });

    // 12 ＋ (1+2)×3 ＋ (1+2)×3 ＋ (1+2) ＋ (1+2) = 12 + 9 + 9 + 3 + 3 = 36
    expect(result).toEqual({ rows: expect.any(Array), failed: false, historyLimit: false, errorCodes: [] });
    expect(result.rows).toHaveLength(36);
    expect(result.rows.filter((r) => r.metric === "online_followers").map((r) => [r.breakdown_value, r.value])).toEqual([["", null], ["0", 1], ["23", 2]]);
    expect(result.rows.every((r) => r.metric_date === DATE && r.account_id === ACCOUNT_ID)).toBe(true);
    // raw_response_id は呼び出しごとの id（グループ 1 の行は "1"、online_followers は "5"）
    expect(result.rows[0]?.raw_response_id).toBe("1");
    expect(result.rows.at(-1)?.raw_response_id).toBe("5");
    expect(h.failures).toEqual([]);
    expect(h.lines).toEqual([]);
  });

  it("最初のグループが「2 年」のエラーなら、残りを呼ばずに historyLimit: true、行なし、失敗に数えない", async () => {
    const h = harness([HISTORY_LIMIT]);
    const result = await fetchAccountDay(h.ctx, "2024-01-01");
    expect(result).toEqual({ rows: [], failed: false, historyLimit: true, errorCodes: [] });
    expect(h.calls).toHaveLength(1);
    expect(h.failures).toEqual([]);
  });

  it("内訳なしのグループが fatal のコード 100 なら 1 指標ずつ取り直す。取れない指標は fatal なら null の行、transient なら行なし。warn に error_code=100", async () => {
    const singles: Reply[] = NO_BREAKDOWN_METRICS.map((m) =>
      m === "reposts" ? fatal(100, "(#100) The reposts metric is not supported") : m === "replies" ? TRANSIENT : groupOk([m]),
    );
    const h = harness([fatal(100), ...singles, ...GROUP_REPLIES.slice(1), onlineOk({})]);
    const result = await fetchAccountDay(h.ctx, DATE, { jobName: "account_backfill" });

    expect(h.calls).toHaveLength(1 + 12 + 3 + 1);
    expect(h.calls.slice(1, 13).map((c) => c.params.metric)).toEqual(NO_BREAKDOWN_METRICS);
    expect(h.calls[1]?.params).toEqual({ metric: "reach", period: "day", metric_type: "total_value", breakdown: undefined, ...pacificDayRange(DATE) });

    expect(result.failed).toBe(true);
    expect(result.historyLimit).toBe(false);
    expect(result.errorCodes).toEqual([100]);
    const plain = result.rows.filter((r) => r.breakdown === "");
    expect(plain).toHaveLength(11); // replies（transient）は行なし
    // raw_response_id は応答があった呼び出しの連番（グループ 1 回目 = 1、replies は応答なしで番号なし、reposts = 10）
    expect(plain.find((r) => r.metric === "reposts")).toEqual(expect.objectContaining({ value: null, raw_response_id: "10" }));
    expect(plain.find((r) => r.metric === "replies")).toBeUndefined();
    expect(plain.find((r) => r.metric === "reach")?.value).toBe(7);
    expect(result.rows.filter((r) => r.metric === "online_followers")).toEqual([]);
    expect(result.rows).toHaveLength(11 + 9 + 9 + 3);

    // 指標の順（replies → reposts）に失敗が記録される
    expect(h.failures).toEqual([
      { code: undefined, errorClass: "transient", message: "ネットワークエラー" },
      { code: 100, errorClass: "fatal", message: "(#100) The reposts metric is not supported" },
    ]);
    expect(h.lines).toHaveLength(2);
    expect(h.lines[0]).toMatch(/WARN {2}job=account_backfill date=2026-09-29 metrics=12 warn="まとめて取れないので 1 指標ずつ取り直す" error_code=100 class=fatal$/);
    expect(h.lines[1]).toMatch(/WARN {2}job=account_backfill date=2026-09-29 warn=単独でも取れない指標 metrics=replies,reposts error_code=100 class=fatal$/);
  });

  it("内訳つきのグループが fatal のコード 100 なら 1 指標ずつ取り直し、取れない指標は印の行も書かない", async () => {
    const h = harness([
      GROUP_REPLIES[0] as Reply,
      fatal(100),
      groupOk(["reach"], "follow_type"),
      fatal(100, "(#100) views not supported"),
      groupOk(["follows_and_unfollows"], "follow_type"),
      ...GROUP_REPLIES.slice(2),
      onlineOk({ "1": 1 }),
    ]);
    const result = await fetchAccountDay(h.ctx, DATE);
    expect(h.calls).toHaveLength(1 + 1 + 3 + 2 + 1);
    expect(h.calls.slice(2, 5).map((c) => [c.params.metric, c.params.breakdown])).toEqual([
      ["reach", "follow_type"],
      ["views", "follow_type"],
      ["follows_and_unfollows", "follow_type"],
    ]);
    const followType = result.rows.filter((r) => r.breakdown === "follow_type");
    expect(followType.map((r) => key(r))).toEqual([
      "reach|follow_type|",
      "reach|follow_type|A",
      "reach|follow_type|B",
      "follows_and_unfollows|follow_type|",
      "follows_and_unfollows|follow_type|A",
      "follows_and_unfollows|follow_type|B",
    ]);
    expect(result.failed).toBe(true);
    expect(h.failures).toHaveLength(1);
    expect(h.lines[0]).toMatch(/WARN {2}date=2026-09-29 breakdown=follow_type metrics=3 warn=/);
  });

  it("transient やコード 100 以外の fatal のグループは recordFailure して次へ（取り直さない）。online_followers の {} は失敗にしない", async () => {
    const h = harness([TRANSIENT, fatal(300, "(#300) Something"), ...GROUP_REPLIES.slice(2), onlineOk({})]);
    const result = await fetchAccountDay(h.ctx, DATE);
    expect(h.calls).toHaveLength(5);
    expect(h.calls.map((c) => c.params.breakdown)).toEqual([undefined, "follow_type", "media_product_type", "contact_button_type", undefined]);
    expect(result.rows.map((r) => r.breakdown)).not.toContain("");
    expect(result.rows.map((r) => r.breakdown)).not.toContain("follow_type");
    expect(result.rows).toHaveLength(9 + 3);
    expect(result.failed).toBe(true);
    expect(result.errorCodes).toEqual([300]);
    expect(h.failures.map((f) => [f.code, f.errorClass])).toEqual([
      [undefined, "transient"],
      [300, "fatal"],
    ]);
    expect(h.lines).toEqual([]);
  });

  it("online_followers の API エラーは失敗。includeOnlineFollowers: false なら呼ばない", async () => {
    const failing = harness([...GROUP_REPLIES, TRANSIENT]);
    const result = await fetchAccountDay(failing.ctx, DATE);
    expect(failing.calls).toHaveLength(5);
    expect(result.failed).toBe(true);
    expect(result.rows).toHaveLength(36 - 3);
    expect(failing.failures).toHaveLength(1);

    const without = harness([...GROUP_REPLIES]);
    const skipped = await fetchAccountDay(without.ctx, DATE, { includeOnlineFollowers: false });
    expect(without.calls).toHaveLength(4);
    expect(without.calls.map((c) => c.params.metric)).not.toContain("online_followers");
    expect(skipped).toEqual({ rows: expect.any(Array), failed: false, historyLimit: false, errorCodes: [] });
    expect(skipped.rows).toHaveLength(33);
  });

  it("「2 年」のエラーが 2 つ目以降のグループで返っても historyLimit: true で止まる（それまでの失敗は残る）", async () => {
    const h = harness([TRANSIENT, HISTORY_LIMIT]);
    const result = await fetchAccountDay(h.ctx, DATE);
    expect(h.calls).toHaveLength(2);
    expect(result).toEqual({ rows: [], failed: true, historyLimit: true, errorCodes: [] });
  });
});
