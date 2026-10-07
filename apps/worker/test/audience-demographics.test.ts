/**
 * `jobs/audience-demographics.ts` の単体テスト（R5 設計 3 章、7.1 節の単体（worker））。
 * ジョブ本体は偽の `JobGraphClient` と偽の `AudienceStore` を持つ `JobContext` で動かし、DB には触らない。
 * fixture は応答の形だけを写し、値と区分の名前は架空（S6。都市は `CityA, PrefA` など）
 */
import { describe, expect, it } from "vitest";
import type { WorkerConfig } from "../src/config.js";
import type { AudienceCaptureInput, AudienceCaptureKey } from "../src/db/audience.js";
import type { Db } from "../src/db/client.js";
import type { AccountRow } from "../src/db/types.js";
import {
  audienceParams,
  audienceRequests,
  createAudienceDemographicsJob,
  DUPLICATE_KEY_MESSAGE,
  FETCH_FAILED_MESSAGE,
  INVALID_RESPONSE_MESSAGE,
  job,
  jstWeekStart,
  parseAudienceResponse,
  truncateValueKey,
  WRITE_FAILED_MESSAGE,
  type AudienceStore,
} from "../src/jobs/audience-demographics.js";
import { deriveJobStatus, type ItemFailure, type JobContext } from "../src/jobs/framework.js";
import { AuthError, type JobGraphClient, type Tracked } from "../src/jobs/graph-client.js";
import { RateLimitExceeded, RateMonitor } from "../src/jobs/rate.js";
import type { GraphError, GraphParams } from "../src/lib/graph.js";
import { createLogger, SecretRegistry } from "../src/lib/log.js";

const ACCOUNT_ID = "00000000-0000-4000-8000-000000000005";
const IG_USER_ID = "000000123456789";
const FAKE_TOKEN = "FAKE_AUDIENCE_TOKEN_0001";
/** 木曜（JST 2026-10-08 21:00）。週の月曜は 2026-10-05 */
const STARTED_AT = new Date("2026-10-08T12:00:00.000Z");
const WEEK = "2026-10-05";
const FETCHED_AT = new Date("2026-10-08T12:00:01.000Z");

/** 応答の形（`data[0].total_value.breakdowns[0].results[]`）。値は架空 */
function breakdownBody(metric: string, breakdown: string, results: { name: unknown; value: unknown }[]): unknown {
  return {
    data: [
      {
        name: metric,
        period: "lifetime",
        title: "x",
        description: "x",
        total_value: {
          breakdowns: [
            {
              dimension_keys: [breakdown],
              results: results.map((r) => ({ dimension_values: [r.name], value: r.value })),
            },
          ],
        },
        id: "x",
      },
    ],
  };
}

/** 反応が 100 未満のときの形（`dimension_keys` だけで `results` がない） */
function emptyBody(metric: string, breakdown: string): unknown {
  return { data: [{ name: metric, period: "lifetime", total_value: { breakdowns: [{ dimension_keys: [breakdown] }] } }] };
}

const SAMPLE: Record<string, { name: string; value: number }[]> = {
  age: [
    { name: "18-24", value: 3 },
    { name: "25-34", value: 12 },
    { name: "35-44", value: 9 },
    { name: "45-54", value: 4 },
    { name: "55-64", value: 2 },
    { name: "65+", value: 1 },
  ],
  gender: [
    { name: "F", value: 20 },
    { name: "M", value: 10 },
    { name: "U", value: 1 },
  ],
  // 国と都市は値の順に並んでいない（3.1 節）
  country: [
    { name: "AA", value: 2 },
    { name: "BB", value: 25 },
  ],
  city: [
    { name: "CityB, PrefB", value: 1 },
    { name: "CityA, PrefA", value: 7 },
  ],
};

function okBody(key: AudienceCaptureKey): unknown {
  return breakdownBody(key.metric, key.breakdown, SAMPLE[key.breakdown] ?? []);
}

type Reply =
  | { ok: true; body: unknown }
  | { ok: false; errorClass: "fatal" | "transient"; error?: GraphError }
  | { throws: unknown };

interface Harness {
  ctx: JobContext;
  calls: { path: string; params: GraphParams }[];
  failures: ItemFailure[];
  lines: string[];
  writes: AudienceCaptureInput[];
  listed: { accountId: string; weekStart: string }[];
  store: AudienceStore;
}

function harness(
  replies: Reply[],
  opts: { captured?: AudienceCaptureKey[]; write?: (c: AudienceCaptureInput) => Promise<boolean> } = {},
): Harness {
  const queue = [...replies];
  const calls: Harness["calls"] = [];
  const failures: ItemFailure[] = [];
  const lines: string[] = [];
  const writes: AudienceCaptureInput[] = [];
  const listed: Harness["listed"] = [];
  let rawId = 100;
  const graph: JobGraphClient = {
    async get<T>(path: string, params: GraphParams = {}): Promise<Tracked<T>> {
      calls.push({ path, params });
      const reply = queue.shift();
      if (!reply) throw new Error("応答の用意がない");
      if ("throws" in reply) throw reply.throws;
      rawId += 1;
      if (reply.ok) {
        return { ok: true, status: 200, data: reply.body as T, error: undefined, errorClass: undefined, rawResponseId: String(rawId), fetchedAt: FETCHED_AT };
      }
      return { ok: false, status: 400, data: undefined, error: reply.error, errorClass: reply.errorClass, rawResponseId: String(rawId), fetchedAt: FETCHED_AT };
    },
    pages: () => {
      throw new Error("このテストでは使わない");
    },
    debugToken: () => {
      throw new Error("このテストでは使わない");
    },
  };
  const store: AudienceStore = {
    listCapturedKeys: async (_db, accountId, weekStart) => {
      listed.push({ accountId, weekStart });
      return opts.captured ?? [];
    },
    write: async (_db, capture) => {
      writes.push(capture);
      return opts.write ? opts.write(capture) : true;
    },
  };
  const secrets = new SecretRegistry();
  secrets.add(FAKE_TOKEN);
  const account = { id: ACCOUNT_ID, ig_user_id: IG_USER_ID, username: null, name: null, fb_page_id: null, status: "active" } as AccountRow;
  const ctx: JobContext = {
    account,
    db: undefined as unknown as Db,
    config: { rateSoftLimit: 50, rateHardLimit: 90 } as WorkerConfig,
    log: createLogger("debug", secrets, (line) => lines.push(line)),
    now: () => FETCHED_AT,
    options: {},
    mask: (text) => text,
    graph,
    rate: new RateMonitor(),
    progress: { items: 0, failures: 0, apiCalls: 0 },
    jobRunId: "1",
    startedAt: STARTED_AT,
    recordFailure: (failure) => {
      failures.push(failure);
      (ctx.progress as { failures: number }).failures += 1;
    },
  };
  return { ctx, calls, failures, lines, writes, listed, store };
}

const ALL_OK: Reply[] = audienceRequests().map((key) => ({ ok: true, body: okBody(key) }));

async function run(h: Harness): Promise<void> {
  await createAudienceDemographicsJob(h.store).run(h.ctx);
}

describe("定数と組み立て", () => {
  it("job の名前。shouldRun はない", () => {
    expect(job.name).toBe("audience_demographics");
    expect(job.shouldRun).toBeUndefined();
  });

  it("8 組（2 指標 × 4 内訳 × this_month）。パラメータは period=lifetime、metric_type=total_value、内訳は 1 つずつ", () => {
    const keys = audienceRequests();
    expect(keys).toHaveLength(8);
    expect(keys.map((k) => `${k.metric}/${k.breakdown}/${k.timeframe}`)).toEqual([
      "follower_demographics/age/this_month",
      "follower_demographics/gender/this_month",
      "follower_demographics/country/this_month",
      "follower_demographics/city/this_month",
      "engaged_audience_demographics/age/this_month",
      "engaged_audience_demographics/gender/this_month",
      "engaged_audience_demographics/country/this_month",
      "engaged_audience_demographics/city/this_month",
    ]);
    expect(audienceParams({ metric: "follower_demographics", timeframe: "this_month", breakdown: "city" })).toEqual({
      metric: "follower_demographics",
      period: "lifetime",
      metric_type: "total_value",
      timeframe: "this_month",
      breakdown: "city",
    });
  });
});

describe("jstWeekStart（JST の月曜始まり）", () => {
  it("日曜 23:59 JST（UTC 14:59）は前の月曜、月曜 0:00 JST（UTC 15:00）はその月曜", () => {
    expect(jstWeekStart(new Date("2026-10-11T14:59:59Z"))).toBe("2026-10-05");
    expect(jstWeekStart(new Date("2026-10-11T15:00:00Z"))).toBe("2026-10-12");
  });

  it("週の途中、月曜の朝、年と月をまたぐ週", () => {
    expect(jstWeekStart(STARTED_AT)).toBe(WEEK);
    expect(jstWeekStart(new Date("2026-10-04T20:30:00Z"))).toBe(WEEK); // JST 月曜 05:30
    expect(jstWeekStart(new Date("2027-01-01T03:00:00Z"))).toBe("2026-12-28"); // JST 金曜
    expect(jstWeekStart(new Date("2026-11-01T00:00:00Z"))).toBe("2026-10-26"); // JST 日曜 09:00
  });
});

describe("truncateValueKey（コードポイントで切る。T5）", () => {
  it("200 コードポイントまではそのまま。201 は 200 に切る", () => {
    const k200 = "a".repeat(200);
    expect(truncateValueKey(k200)).toBe(k200);
    expect(truncateValueKey("a".repeat(201))).toBe(k200);
  });

  it("絵文字を含む 201 コードポイントでサロゲートペアの途中で切らない", () => {
    const s = "a".repeat(199) + "😀" + "b"; // 201 コードポイント（UTF-16 では 202）
    const t = truncateValueKey(s);
    expect([...t]).toHaveLength(200);
    expect(t.endsWith("😀")).toBe(true);
    const emojis = truncateValueKey("😀".repeat(201));
    expect([...emojis]).toHaveLength(200);
    expect(emojis).toBe("😀".repeat(200));
    // 孤立したサロゲートがない
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(t)).toBe(false);
  });
});

describe("parseAudienceResponse", () => {
  const city = { metric: "follower_demographics", breakdown: "city" } as const;

  it("区分あり: API の順のまま value_key と value を取り出す", () => {
    expect(parseAudienceResponse(okBody({ ...city, timeframe: "this_month" }), city)).toEqual({
      kind: "ok",
      values: [
        { value_key: "CityB, PrefB", value: 1 },
        { value_key: "CityA, PrefA", value: 7 },
      ],
    });
  });

  it("値は 0 も可。数字の文字列は数値にする", () => {
    expect(parseAudienceResponse(breakdownBody(city.metric, "city", [{ name: "CityA, PrefA", value: 0 }, { name: "CityB, PrefB", value: "5" }]), city)).toEqual({
      kind: "ok",
      values: [
        { value_key: "CityA, PrefA", value: 0 },
        { value_key: "CityB, PrefB", value: 5 },
      ],
    });
  });

  it("空: results がない（100 未満）、results が空、breakdowns が空、data が空", () => {
    const key = { metric: "engaged_audience_demographics", breakdown: "age" } as const;
    expect(parseAudienceResponse(emptyBody(key.metric, "age"), key)).toEqual({ kind: "empty" });
    expect(parseAudienceResponse(breakdownBody(key.metric, "age", []), key)).toEqual({ kind: "empty" });
    expect(parseAudienceResponse({ data: [{ name: key.metric, total_value: { breakdowns: [] } }] }, key)).toEqual({ kind: "empty" });
    expect(parseAudienceResponse({ data: [] }, key)).toEqual({ kind: "empty" });
  });

  it("形の違う応答は invalid", () => {
    for (const body of [
      undefined,
      null,
      "x",
      [],
      {},
      { data: {} },
      { data: [null] },
      { data: [{ name: city.metric }] },
      { data: [{ name: city.metric, total_value: {} }] },
      { data: [{ name: city.metric, total_value: { breakdowns: [null] } }] },
      { data: [{ name: city.metric, total_value: { breakdowns: [{ dimension_keys: ["city"], results: {} }] } }] },
      { data: [{ name: city.metric, total_value: { breakdowns: [{ dimension_keys: ["city"], results: [null] }] } }] },
      { data: [{ name: city.metric, total_value: { breakdowns: [{ dimension_keys: ["city"], results: [{ value: 1 }] }] } }] },
      { data: [{ name: city.metric, total_value: { breakdowns: [{ dimension_keys: ["city"], results: [{ dimension_values: ["A", "B"], value: 1 }] }] } }] },
    ]) {
      expect(parseAudienceResponse(body, city)).toEqual({ kind: "invalid" });
    }
  });

  it("指標の名前や内訳が頼んだものと違えば invalid", () => {
    expect(parseAudienceResponse(breakdownBody("engaged_audience_demographics", "city", SAMPLE.city ?? []), city)).toEqual({ kind: "invalid" });
    expect(parseAudienceResponse(breakdownBody(city.metric, "country", SAMPLE.country ?? []), city)).toEqual({ kind: "invalid" });
  });

  it("値が数でない、負、小数、真偽値、空文字、区分の名前が空か文字列でない要素が 1 つでもあれば invalid（黙って捨てない）", () => {
    for (const bad of ["abc", -1, 1.5, true, "", null, undefined]) {
      expect(parseAudienceResponse(breakdownBody(city.metric, "city", [{ name: "CityA, PrefA", value: 1 }, { name: "CityB, PrefB", value: bad }]), city)).toEqual({ kind: "invalid" });
    }
    for (const bad of ["", 1, null]) {
      expect(parseAudienceResponse(breakdownBody(city.metric, "city", [{ name: bad, value: 1 }]), city)).toEqual({ kind: "invalid" });
    }
  });

  it("切り詰めで同じ value_key ができたら duplicate（件数）。名前は返さない", () => {
    const base = "x".repeat(200);
    const parsed = parseAudienceResponse(
      breakdownBody(city.metric, "city", [
        { name: `${base}1`, value: 1 },
        { name: `${base}2`, value: 2 },
        { name: `${base}3`, value: 3 },
        { name: "CityA, PrefA", value: 4 },
      ]),
      city,
    );
    expect(parsed).toEqual({ kind: "duplicate", duplicates: 2 });
  });
});

describe("ジョブ本体（偽の graph と store）", () => {
  it("8 リクエストを内訳ごとに 1 つずつ送り、組ごとに 1 回書く。week_start、fetched_at、raw_response_id、status=ok", async () => {
    const h = harness(ALL_OK);
    await run(h);
    expect(h.listed).toEqual([{ accountId: ACCOUNT_ID, weekStart: WEEK }]);
    expect(h.calls).toHaveLength(8);
    expect(h.calls.every((c) => c.path === `${IG_USER_ID}/insights`)).toBe(true);
    expect(h.calls.map((c) => c.params)).toEqual(audienceRequests().map(audienceParams));
    expect(h.writes).toHaveLength(8);
    expect(h.writes[3]).toEqual({
      metric: "follower_demographics",
      timeframe: "this_month",
      breakdown: "city",
      account_id: ACCOUNT_ID,
      week_start: WEEK,
      status: "ok",
      fetched_at: FETCHED_AT,
      raw_response_id: "104",
      values: [
        { value_key: "CityB, PrefB", value: 1 },
        { value_key: "CityA, PrefA", value: 7 },
      ],
    });
    expect(h.ctx.progress.items).toBe(8);
    expect(h.failures).toEqual([]);
    expect(deriveJobStatus(h.ctx.progress, "none")).toBe("success");
    expect(h.lines.at(-1)).toMatch(/INFO {2}job=audience_demographics captured=8 empty=0 skipped_this_week=0 failed=0$/);
  });

  it("その週の行がある組は API を呼ばずに飛ばす。全部あれば 1 回も呼ばない（success）", async () => {
    const captured = audienceRequests().slice(0, 3);
    const h = harness(ALL_OK.slice(3), { captured });
    await run(h);
    expect(h.calls).toHaveLength(5);
    expect(h.calls.map((c) => c.params["breakdown"])).toEqual(["city", "age", "gender", "country", "city"]);
    expect(h.ctx.progress.items).toBe(5);
    expect(h.lines.at(-1)).toMatch(/captured=5 empty=0 skipped_this_week=3 failed=0$/);

    const all = harness([], { captured: audienceRequests() });
    await run(all);
    expect(all.calls).toHaveLength(0);
    expect(all.writes).toHaveLength(0);
    expect(deriveJobStatus(all.ctx.progress, "none")).toBe("success");
    expect(all.lines.at(-1)).toMatch(/captured=0 empty=0 skipped_this_week=8 failed=0$/);
  });

  it("空の応答は status=empty、値の行 0 件で書き、items に数える（D10）", async () => {
    const replies: Reply[] = audienceRequests().map((key) =>
      key.metric === "engaged_audience_demographics" ? { ok: true, body: emptyBody(key.metric, key.breakdown) } : { ok: true, body: okBody(key) },
    );
    const h = harness(replies);
    await run(h);
    const engaged = h.writes.filter((w) => w.metric === "engaged_audience_demographics");
    expect(engaged).toHaveLength(4);
    expect(engaged.every((w) => w.status === "empty" && w.values.length === 0)).toBe(true);
    expect(h.writes.filter((w) => w.status === "ok").every((w) => w.values.length > 0)).toBe(true);
    expect(h.ctx.progress.items).toBe(8);
    expect(h.lines.at(-1)).toMatch(/captured=4 empty=4 skipped_this_week=0 failed=0$/);
  });

  it("書き込みで行が返らない（同時に動いた）組は skipped に数え、items に数えない（D11）", async () => {
    const h = harness(ALL_OK, { write: async (c) => c.breakdown !== "age" });
    await run(h);
    expect(h.ctx.progress.items).toBe(6);
    expect(h.failures).toEqual([]);
    expect(h.lines.at(-1)).toMatch(/captured=6 empty=0 skipped_this_week=2 failed=0$/);
  });

  it("API の失敗（fatal、transient の使い切り）は書かずに recordFailure（固定の文言とコード）。一部の失敗で partial", async () => {
    const replies = [...ALL_OK];
    replies[0] = { ok: false, errorClass: "fatal", error: { message: `(#100) bad https://graph.facebook.com/${IG_USER_ID}?access_token=${FAKE_TOKEN}`, code: 100 } };
    replies[5] = { ok: false, errorClass: "transient", error: { message: "ネットワークエラー", type: "NetworkError" } };
    const h = harness(replies);
    await run(h);
    expect(h.writes).toHaveLength(6);
    expect(h.failures).toEqual([
      { code: 100, errorClass: "fatal", message: FETCH_FAILED_MESSAGE },
      { code: undefined, errorClass: "transient", message: FETCH_FAILED_MESSAGE },
    ]);
    expect(deriveJobStatus(h.ctx.progress, "none")).toBe("partial");
    expect(h.lines.at(-1)).toMatch(/captured=6 empty=0 skipped_this_week=0 failed=2$/);
  });

  it("全部失敗なら items 0 で failed", async () => {
    const h = harness(audienceRequests().map(() => ({ ok: false, errorClass: "fatal", error: { message: "x", code: 100 } })));
    await run(h);
    expect(h.writes).toHaveLength(0);
    expect(deriveJobStatus(h.ctx.progress, "none")).toBe("failed");
  });

  it("形の違う応答は書かずに recordFailure（invalid の固定の文言）", async () => {
    const replies = [...ALL_OK];
    replies[2] = { ok: true, body: { data: {} } };
    const h = harness(replies);
    await run(h);
    expect(h.writes.map((w) => w.breakdown)).not.toContain(undefined);
    expect(h.writes).toHaveLength(7);
    expect(h.failures).toEqual([{ errorClass: "fatal", message: INVALID_RESPONSE_MESSAGE }]);
  });

  it("切り詰めで value_key が重なった組は書かずに失敗に数え、件数だけを warn に出す（T14）", async () => {
    const replies = [...ALL_OK];
    const long = "CityZ, " + "y".repeat(200);
    replies[3] = { ok: true, body: breakdownBody("follower_demographics", "city", [{ name: `${long}1`, value: 1 }, { name: `${long}2`, value: 2 }]) };
    const h = harness(replies);
    await run(h);
    expect(h.writes).toHaveLength(7);
    expect(h.failures).toEqual([{ errorClass: "fatal", message: DUPLICATE_KEY_MESSAGE }]);
    const warn = h.lines.find((l) => l.includes("WARN"));
    expect(warn).toMatch(/job=audience_demographics metric=follower_demographics breakdown=city error=\S+ duplicates=1$/);
    expect(h.lines.join("\n")).not.toContain("CityZ");
  });

  it("書き込みの例外は組の失敗（SQLSTATE と固定の文言）にして次へ進む。DB の文言は使わない", async () => {
    const dbError = Object.assign(new Error('new row violates check constraint "x" CityA, PrefA'), { name: "PostgresError", code: "23514" });
    const h = harness(ALL_OK, {
      write: async (c) => {
        if (c.breakdown === "gender") throw dbError;
        return true;
      },
    });
    await run(h);
    expect(h.ctx.progress.items).toBe(6);
    expect(h.failures).toEqual([
      { code: "23514", errorClass: "db", message: WRITE_FAILED_MESSAGE },
      { code: "23514", errorClass: "db", message: WRITE_FAILED_MESSAGE },
    ]);
    expect(deriveJobStatus(h.ctx.progress, "none")).toBe("partial");
  });

  it("RateLimitExceeded と AuthError は捕まえずに外へ出す（その後の組は呼ばない）", async () => {
    const rate = RateLimitExceeded.forUsage(95, 90, undefined);
    const h1 = harness([ALL_OK[0] as Reply, { throws: rate }]);
    await expect(run(h1)).rejects.toBe(rate);
    expect(h1.calls).toHaveLength(2);
    expect(h1.writes).toHaveLength(1);

    const auth = new AuthError(190, "トークンが無効（コード 190）");
    const h2 = harness([{ throws: auth }]);
    await expect(run(h2)).rejects.toBe(auth);
    expect(h2.calls).toHaveLength(1);
    expect(h2.writes).toHaveLength(0);
  });

  it("ログと recordFailure に区分の名前、値、アクセストークン、ig_user_id、URL が出ない（S7）", async () => {
    const replies = [...ALL_OK];
    replies[1] = { ok: false, errorClass: "fatal", error: { message: `bad https://graph.facebook.com/v25.0/${IG_USER_ID}/insights?access_token=${FAKE_TOKEN}`, code: 100 } };
    const h = harness(replies);
    await run(h);
    const text = [...h.lines, ...h.failures.map((f) => `${f.message} ${String(f.code)}`)].join("\n");
    for (const banned of [IG_USER_ID, FAKE_TOKEN, "http", "graph.facebook.com", "CityA", "PrefA", "18-24"]) {
      expect(text).not.toContain(banned);
    }
  });
});
