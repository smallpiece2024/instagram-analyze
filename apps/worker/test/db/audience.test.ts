/**
 * `db/audience.ts` と `jobs/audience-demographics.ts` の結合テスト（R5 設計 3.3 節、5.1 節 (2)、7.1 節の結合（worker と DB））。
 * 偽の `fetch` と本物の DB（ローカル Supabase。R5 のマイグレーションが入っていること）で動かす。
 * 架空のアカウントを作り、終了時に消す（CASCADE で属性の行も消える）。fixture の値と区分の名前は架空（S6）。
 *
 * 時計（`deps.now`）は実時刻より 24 時間以上先に固定する（他のテストファイルが並列に書く `job_runs.rate_usage` を
 * `latestRateUsage` が拾わないようにするため。`db/profile.test.ts` と同じ）
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WorkerConfig } from "../../src/config.js";
import { upsertAccount, upsertCredential, type CredentialInfo } from "../../src/db/accounts.js";
import {
  insertAudienceCapture,
  listCapturedKeys,
  writeAudienceCapture,
  type AudienceCaptureInput,
  type AudienceCaptureRow,
} from "../../src/db/audience.js";
import { closeDb, connectDb, type Db } from "../../src/db/client.js";
import type { AccountRow, JobRunRow } from "../../src/db/types.js";
import { runJob, type JobDeps } from "../../src/jobs/framework.js";
import { job as audienceJob, jstWeekStart } from "../../src/jobs/audience-demographics.js";
import { createLogger, SecretRegistry } from "../../src/lib/log.js";
import { addDays } from "../../src/lib/time.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

function fakeIgUserId(): string {
  return "000000" + Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, "0");
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

const FAKE_TOKEN = `FAKE_AUDIENCE_TOKEN_${Math.floor(Math.random() * 1_000_000_000)}`;

const CREDENTIAL: CredentialInfo = {
  token_type: "PAGE",
  expires_at: null,
  data_access_expires_at: new Date("2026-12-29T00:00:00Z"),
  scopes: ["instagram_basic", "instagram_manage_insights", "pages_read_engagement"],
  status: "valid",
};

/** 架空の区分（形だけ実際の応答に合わせる） */
const SAMPLE: Record<string, string[]> = {
  age: ["18-24", "25-34", "65+"],
  gender: ["F", "M", "U"],
  country: ["AA", "BB"],
  city: ["CityB, PrefB", "CityA, PrefA"],
};

function insightsBody(metric: string, breakdown: string, empty: boolean): unknown {
  const results = (SAMPLE[breakdown] ?? []).map((name, i) => ({ dimension_values: [name], value: i + 1 }));
  return {
    data: [
      {
        name: metric,
        period: "lifetime",
        total_value: { breakdowns: [empty ? { dimension_keys: [breakdown] } : { dimension_keys: [breakdown], results }] },
      },
    ],
  };
}

/**
 * `daysAhead` 日後を含む週の月曜の JST 12:00（UTC 03:00）。テストごとに別の週を使う（7 日以上離す）。
 * 月曜に寄せるので、+24 時間しても同じ週のまま
 */
function futureAt(daysAhead: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  return new Date(`${jstWeekStart(d)}T03:00:00Z`);
}

describe.skipIf(!TEST_DATABASE_URL)("db/audience と jobs/audience-demographics（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  let db: Db;
  let account: AccountRow;
  let deps: JobDeps;
  const calls: URL[] = [];
  const lines: string[] = [];
  /** 失敗させる組（`metric/breakdown`） */
  const failing = new Set<string>();
  /** 空を返す指標 */
  const emptyMetrics = new Set<string>();

  const config: WorkerConfig = {
    databaseUrl: url,
    supabaseUrl: "http://127.0.0.1:54321",
    supabaseServiceRoleKey: "FAKE_SERVICE_ROLE_KEY",
    graphApiVersion: "v25.0",
    metaAppId: "0",
    metaAppSecret: "FAKE_APP_SECRET",
    hourlyMinute: 5,
    dailyTimeJst: { hour: 5, minute: 30 },
    backfillMaxDays: 30,
    backfillHistoryDays: 730,
    rateHardLimit: 90,
    rateSoftLimit: 50,
    logLevel: "debug",
    outputDir: ".local",
    downloadAllowedHosts: ["cdninstagram.com"],
    videoMaxPerRun: 5,
    videoBudgetMs: 480_000,
  };

  const fetchImpl: typeof fetch = async (input) => {
    const target = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
    calls.push(target);
    const metric = target.searchParams.get("metric") ?? "";
    const breakdown = target.searchParams.get("breakdown") ?? "";
    if (failing.has(`${metric}/${breakdown}`)) {
      return jsonResponse({ error: { message: `(#100) bad ${target.toString()}`, code: 100 } }, { status: 400 });
    }
    return jsonResponse(insightsBody(metric, breakdown, emptyMetrics.has(metric)));
  };

  function capture(weekStart: string, overrides: Partial<AudienceCaptureInput> = {}): AudienceCaptureInput {
    return {
      account_id: account.id,
      metric: "follower_demographics",
      timeframe: "this_month",
      breakdown: "city",
      week_start: weekStart,
      status: "ok",
      fetched_at: new Date(),
      raw_response_id: null,
      values: [
        { value_key: "CityA, PrefA", value: 3 },
        { value_key: "CityB, PrefB", value: 0 },
      ],
      ...overrides,
    };
  }

  async function capturesFor(weekStart: string): Promise<AudienceCaptureRow[]> {
    return [
      ...(await db<AudienceCaptureRow[]>`
        select * from public.audience_captures where account_id = ${account.id} and week_start = ${weekStart} order by id
      `),
    ];
  }

  async function valueCount(captureId: string): Promise<number> {
    const [row] = await db<{ n: number }[]>`select count(*)::int as n from public.audience_values where capture_id = ${captureId}`;
    return row?.n ?? -1;
  }

  async function lastRun(): Promise<JobRunRow | undefined> {
    return (
      await db<JobRunRow[]>`
        select * from public.job_runs where account_id = ${account.id} and job_name = 'audience_demographics' order by id desc limit 1
      `
    )[0];
  }

  beforeAll(async () => {
    db = connectDb(url);
    account = await db.begin((tx) => upsertAccount(tx, { ig_user_id: fakeIgUserId(), username: "fake_audience" }));
    await db.begin((tx) => upsertCredential(tx, account.id, FAKE_TOKEN, CREDENTIAL));
    const secrets = new SecretRegistry();
    secrets.add(config.metaAppSecret);
    secrets.add(config.supabaseServiceRoleKey);
    secrets.addUrlParts(config.databaseUrl);
    secrets.addUrlParts(config.supabaseUrl);
    const log = createLogger("debug", secrets, (line) => lines.push(line));
    deps = { db, config, log, secrets, fetchImpl, sleep: async () => {} };
  });

  beforeEach(() => {
    calls.length = 0;
    lines.length = 0;
    failing.clear();
    emptyMetrics.clear();
  });

  afterAll(async () => {
    await db`delete from public.accounts where id = ${account.id}`;
    const [rows] = await db<{ n: number }[]>`select count(*)::int as n from public.audience_captures where account_id = ${account.id}`;
    expect(rows?.n).toBe(0);
    await closeDb(db);
  });

  it("writeAudienceCapture: 1 トランザクションで記録 1 行と値の行。同じ週の 2 回目は false で何も書かない", async () => {
    const week = jstWeekStart(futureAt(400));
    expect(await writeAudienceCapture(db, capture(week))).toBe(true);
    expect(await writeAudienceCapture(db, capture(week, { values: [{ value_key: "CityC, PrefC", value: 9 }] }))).toBe(false);
    const rows = await capturesFor(week);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("ok");
    expect(rows[0]?.week_start).toBe(week);
    expect(await valueCount(rows[0]?.id ?? "0")).toBe(2);
    expect(await listCapturedKeys(db, account.id, week)).toEqual([{ metric: "follower_demographics", timeframe: "this_month", breakdown: "city" }]);
  });

  it("insertAudienceCapture: on conflict do nothing で行が返らなければ undefined（D11）", async () => {
    const week = jstWeekStart(futureAt(407));
    const { values: _values, ...row } = capture(week, { breakdown: "age" });
    const first = await db.begin((tx) => insertAudienceCapture(tx, row));
    const second = await db.begin((tx) => insertAudienceCapture(tx, row));
    expect(first).toBeDefined();
    expect(second).toBeUndefined();
  });

  it("empty の行は値の行なし", async () => {
    const week = jstWeekStart(futureAt(414));
    expect(await writeAudienceCapture(db, capture(week, { status: "empty", values: [] }))).toBe(true);
    const rows = await capturesFor(week);
    expect(rows[0]?.status).toBe("empty");
    expect(await valueCount(rows[0]?.id ?? "0")).toBe(0);
  });

  it("check の列挙外（metric、timeframe、breakdown）と月曜でない week_start は 23514 で失敗し、値の行も残らない（D8、D9）", async () => {
    const week = jstWeekStart(futureAt(421));
    const bad: Partial<AudienceCaptureInput>[] = [
      { metric: "online_followers" as AudienceCaptureInput["metric"] },
      { timeframe: "last_30_days" as AudienceCaptureInput["timeframe"] },
      { breakdown: "locale" as AudienceCaptureInput["breakdown"] },
      { week_start: addDays(week, 1) },
    ];
    for (const overrides of bad) {
      await expect(writeAudienceCapture(db, capture(week, overrides))).rejects.toMatchObject({ code: "23514" });
    }
    expect(await capturesFor(week)).toHaveLength(0);
    expect(await capturesFor(addDays(week, 1))).toHaveLength(0);
  });

  it("runJob: 8 組を書き、同じ週の 2 回目は API を呼ばずに success。ログと job_runs にトークン、ig_user_id、URL、区分の名前がない", async () => {
    const now = futureAt(428);
    const week = jstWeekStart(now);
    emptyMetrics.add("engaged_audience_demographics");

    expect(await runJob(audienceJob, { ...deps, now: () => now }, account)).toBe("success");
    expect(calls).toHaveLength(8);
    const rows = await capturesFor(week);
    expect(rows).toHaveLength(8);
    expect(rows.filter((r) => r.status === "ok").map((r) => r.metric)).toEqual(Array(4).fill("follower_demographics"));
    expect(rows.filter((r) => r.status === "empty").map((r) => r.metric)).toEqual(Array(4).fill("engaged_audience_demographics"));
    expect(rows.every((r) => r.raw_response_id !== null)).toBe(true);
    const run1 = await lastRun();
    expect(run1?.items_fetched).toBe(8);
    expect(lines.join("\n")).toMatch(/job=audience_demographics captured=4 empty=4 skipped_this_week=0 failed=0/);

    calls.length = 0;
    lines.length = 0;
    expect(await runJob(audienceJob, { ...deps, now: () => new Date(now.getTime() + 24 * 3600 * 1000) }, account)).toBe("success");
    expect(calls).toHaveLength(0);
    expect(await capturesFor(week)).toHaveLength(8);
    expect(lines.join("\n")).toMatch(/captured=0 empty=0 skipped_this_week=8 failed=0/);
  });

  it("runJob: 一部の組の API が失敗したら partial。失敗した組は行を書かず、job_runs.error は固定の文言（S7）", async () => {
    const now = futureAt(435);
    const week = jstWeekStart(now);
    failing.add("follower_demographics/city");

    expect(await runJob(audienceJob, { ...deps, now: () => now }, account)).toBe("partial");
    const rows = await capturesFor(week);
    expect(rows).toHaveLength(7);
    expect(rows.some((r) => r.metric === "follower_demographics" && r.breakdown === "city")).toBe(false);
    const run = await lastRun();
    expect(run?.status).toBe("partial");
    expect(run?.error).toBe("属性の取得に失敗");
    const text = [lines.join("\n"), JSON.stringify(run)].join("\n");
    for (const banned of [FAKE_TOKEN, account.ig_user_id, "http", "graph.facebook.com", "CityA", "PrefA"]) {
      expect(text).not.toContain(banned);
    }

    // 翌日は失敗した組だけを取り直す
    failing.clear();
    calls.length = 0;
    expect(await runJob(audienceJob, { ...deps, now: () => new Date(now.getTime() + 24 * 3600 * 1000) }, account)).toBe("success");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.searchParams.get("breakdown")).toBe("city");
    expect(await capturesFor(week)).toHaveLength(8);
  });
});
