/**
 * `db/account-daily.ts`、`jobs/account-daily.ts`、`jobs/account-backfill.ts` の結合テスト（設計 9.2 章の
 * 「各 upsert」「各ジョブの書き込み経路」の行）。偽の `fetch` と本物の DB（ローカル Supabase）で `runJob` を動かす。
 * 架空のアカウントを作り、終了時に消す（CASCADE で関連する行も消える）。`runJobsForActiveAccounts` は呼ばない。
 *
 * 「今日」は実時刻の 20 時間先に固定する。枠組みが `job_runs.rate_usage` を引き継ぐ窓（開始時刻の 1 時間前以降）に、
 * 並列に走る他のテストファイルの行（実時刻、または最大 10 時間先にずらした行）が入らないようにするため
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerConfig } from "../../src/config.js";
import {
  dedupeAccountDailyRows,
  listAccountDailyMetrics,
  listMetricDates,
  upsertAccountDailyMetrics,
} from "../../src/db/account-daily.js";
import { upsertAccount, upsertCredential, vaultSecretName, type CredentialInfo } from "../../src/db/accounts.js";
import { closeDb, connectDb, type Db } from "../../src/db/client.js";
import { getJobState, setJobState } from "../../src/db/job-runs.js";
import type { AccountDailyMetricRow, AccountRow, JobName, JobRunRow, RawApiResponseRow } from "../../src/db/types.js";
import { job as backfillJob, type BackfillState } from "../../src/jobs/account-backfill.js";
import { job as dailyJob } from "../../src/jobs/account-daily.js";
import { ACCOUNT_METRIC_GROUPS, type InsightsResponse } from "../../src/jobs/account-metrics.js";
import { runJob, type JobDeps } from "../../src/jobs/framework.js";
import type { GraphError } from "../../src/lib/graph.js";
import { createLogger, SecretRegistry } from "../../src/lib/log.js";
import { addDays, pacificDayRange, PT, zonedDate, zonedMidnightUtc } from "../../src/lib/time.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// `GraphClient` は呼び出しごとに 200 ms 待つ（設計 1.4 章）。1 回の `account_daily` で 23 回呼ぶので、既定の 5 秒では足りない
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

function fakeIgUserId(): string {
  return "000000" + Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, "0");
}

type Reply = () => Response;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function ok(body: unknown, headers: Record<string, string> = {}): Reply {
  return () => jsonResponse(body, { headers: { "content-type": "application/json", ...headers } });
}

/** `X-Business-Use-Case-Usage` で使用率を返す（ID は架空） */
function usageHeader(percent: number): Record<string, string> {
  return {
    "x-business-use-case-usage": JSON.stringify({
      "0": [{ type: "instagram", call_count: percent, total_cputime: 1, total_time: 1 }],
    }),
  };
}

function graphError(error: GraphError, status = 400): Reply {
  return () => jsonResponse({ error }, { status });
}

const HOUR_MS = 60 * 60 * 1000;
const FAKE_TOKEN = `FAKE_VAULT_TOKEN_${Math.floor(Math.random() * 1_000_000_000)}`;
const CREDENTIAL: CredentialInfo = {
  token_type: "PAGE",
  expires_at: null,
  data_access_expires_at: new Date("2026-12-29T00:00:00Z"),
  scopes: ["instagram_basic", "instagram_manage_insights", "pages_read_engagement"],
  status: "valid",
};

/** 固定した「今」（実時刻の 20 時間先）。PT の日付はここから求める */
const BASE = new Date(Math.floor(Date.now() / 1000) * 1000 + 20 * HOUR_MS);
const TODAY = zonedDate(BASE, PT);
const D = (n: number): string => addDays(TODAY, -n);

const NO_BREAKDOWN = ACCOUNT_METRIC_GROUPS[0]?.metrics ?? [];

type Item = NonNullable<InsightsResponse["data"]>[number];

function total(name: string, value?: number): Item {
  return { name, period: "day", total_value: value === undefined ? {} : { value } };
}

function withBreakdown(name: string, key: string, results: Record<string, number>, value?: number): Item {
  return {
    name,
    period: "day",
    total_value: {
      ...(value === undefined ? {} : { value }),
      breakdowns: [{ dimension_keys: [key], results: Object.entries(results).map(([k, v]) => ({ dimension_values: [k], value: v })) }],
    },
  };
}

/** グループ 1〜4 の正常応答（1 日分で 12 ＋ 7 ＋ 6 ＋ 2 = 27 行） */
function groupReplies(): Reply[] {
  return [
    ok({ data: NO_BREAKDOWN.map((m, i) => total(m, i + 1)) }),
    ok({
      data: [
        withBreakdown("reach", "follow_type", { FOLLOWER: 10, NON_FOLLOWER: 5 }, 15),
        withBreakdown("views", "follow_type", { FOLLOWER: 100 }, 100),
        withBreakdown("follows_and_unfollows", "follow_type", { FOLLOWER: 3 }),
      ],
    }),
    ok({
      data: [
        withBreakdown("reach", "media_product_type", { POST: 8, REEL: 7 }, 15),
        withBreakdown("views", "media_product_type", { REEL: 100 }, 100),
        withBreakdown("total_interactions", "media_product_type", {}, 0),
      ],
    }),
    ok({ data: [withBreakdown("profile_links_taps", "contact_button_type", { EMAIL: 2 }, 2)] }),
  ];
}

const GROUP_ROWS = 27;

function onlineReply(hours: Record<string, number>): Reply {
  return ok({ data: [{ name: "online_followers", period: "lifetime", values: [{ value: hours, end_time: "2026-09-30T07:00:00+0000" }] }] });
}

const HOURS_24 = Object.fromEntries(Array.from({ length: 24 }, (_, h) => [String(h), h + 1]));

function followerCountReply(dates: string[]): Reply {
  return ok({
    data: [
      {
        name: "follower_count",
        period: "day",
        values: dates.map((d, i) => ({ value: i + 1, end_time: zonedMidnightUtc(d, PT).toISOString() })),
      },
    ],
  });
}

const UNSUPPORTED: GraphError = { message: "(#100) Unsupported metric", code: 100 };
const HISTORY_LIMIT: GraphError = { message: "(#100) since param is not valid. Metrics data is available for the last 2 years", code: 100 };

describe.skipIf(!TEST_DATABASE_URL)("db/account-daily、account_daily、account_backfill（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  let db: Db;
  let account: AccountRow;
  let deps: JobDeps;
  const replies: Reply[] = [];
  const calls: URL[] = [];
  const lines: string[] = [];

  const config: WorkerConfig = {
    databaseUrl: url,
    supabaseUrl: "http://127.0.0.1:54321",
    supabaseServiceRoleKey: "FAKE_SERVICE_ROLE_KEY",
    graphApiVersion: "v25.0",
    metaAppId: "0",
    metaAppSecret: "FAKE_APP_SECRET",
    hourlyMinute: 5,
    dailyTimeJst: { hour: 5, minute: 30 },
    backfillMaxDays: 3,
    backfillHistoryDays: 730,
    rateHardLimit: 90,
    rateSoftLimit: 50,
    logLevel: "debug",
    outputDir: ".local",
    downloadAllowedHosts: ["cdninstagram.com"],
  };

  const fetchImpl: typeof fetch = async (input) => {
    calls.push(input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url));
    const reply = replies.shift();
    if (!reply) return jsonResponse({ error: { message: "応答の用意がない", code: 999_999 } }, { status: 400 });
    return reply();
  };

  async function runsFor(jobName: JobName): Promise<JobRunRow[]> {
    return [...(await db<JobRunRow[]>`select * from public.job_runs where account_id = ${account.id} and job_name = ${jobName} order by id`)];
  }

  async function rawFor(jobRunId: string): Promise<RawApiResponseRow[]> {
    return [...(await db<RawApiResponseRow[]>`select * from public.raw_api_responses where job_run_id = ${jobRunId} order by id`)];
  }

  async function countRows(): Promise<number> {
    const [row] = await db<{ n: number }[]>`select count(*)::int as n from public.account_daily_metrics where account_id = ${account.id}`;
    return row?.n ?? -1;
  }

  function metricParam(u: URL): string {
    return u.searchParams.get("metric") ?? "";
  }

  function logText(): string {
    return lines.join("\n");
  }

  function row(patch: Partial<AccountDailyMetricRow>): AccountDailyMetricRow {
    return {
      account_id: account.id,
      metric_date: "2026-01-15",
      metric: "reach",
      breakdown: "",
      breakdown_value: "",
      value: 1,
      fetched_at: new Date("2026-01-16T00:00:00Z"),
      raw_response_id: null,
      ...patch,
    };
  }

  beforeAll(async () => {
    db = connectDb(url);
    account = await db.begin((tx) => upsertAccount(tx, { ig_user_id: fakeIgUserId(), username: "fake_user" }));
    await db.begin((tx) => upsertCredential(tx, account.id, FAKE_TOKEN, CREDENTIAL));

    const secrets = new SecretRegistry();
    secrets.add(config.metaAppSecret);
    secrets.add(config.supabaseServiceRoleKey);
    secrets.addUrlParts(config.databaseUrl);
    secrets.addUrlParts(config.supabaseUrl);
    const log = createLogger("debug", secrets, (line) => lines.push(line));
    deps = { db, config, log, secrets, fetchImpl, sleep: async () => {}, now: () => new Date(BASE) };
  });

  beforeEach(() => {
    replies.length = 0;
    calls.length = 0;
    lines.length = 0;
  });

  afterAll(async () => {
    await db`delete from public.accounts where id = ${account.id}`;
    const [vault] = await db<{ n: number }[]>`select count(*)::int as n from vault.secrets where name = ${vaultSecretName(account.id)}`;
    expect(vault?.n).toBe(0);
    const [metrics] = await db<{ n: number }[]>`select count(*)::int as n from public.account_daily_metrics where account_id = ${account.id}`;
    expect(metrics?.n).toBe(0);
    const [state] = await db<{ n: number }[]>`select count(*)::int as n from public.job_state where account_id = ${account.id}`;
    expect(state?.n).toBe(0);
    await closeDb(db);
  });

  // -------------------------------------------------------------------------
  // db/account-daily.ts
  // -------------------------------------------------------------------------

  it("upsertAccountDailyMetrics: 同じ行で 2 回 → 行数不変。value が上書きされ、null は SQL NULL、bigint は number で読める。空配列は 0", async () => {
    const rows = [
      row({ value: 5 }),
      row({ metric: "views", value: 0 }),
      row({ metric: "saves", value: null }),
      row({ metric: "reach", breakdown: "follow_type", breakdown_value: "", value: 12_345_678_901 }),
    ];
    expect(await db.begin((tx) => upsertAccountDailyMetrics(tx, []))).toBe(0);
    expect(await countRows()).toBe(0);
    expect(await db.begin((tx) => upsertAccountDailyMetrics(tx, rows))).toBe(4);
    expect(await countRows()).toBe(4);
    expect(await db.begin((tx) => upsertAccountDailyMetrics(tx, rows))).toBe(4);
    expect(await countRows()).toBe(4);

    const read = await listAccountDailyMetrics(db, account.id, "2026-01-15");
    expect(read.map((r) => [r.metric, r.breakdown, r.value])).toEqual([
      ["reach", "", 5],
      ["reach", "follow_type", 12_345_678_901],
      ["saves", "", null],
      ["views", "", 0],
    ]);
    expect(read.every((r) => typeof r.value === "number" || r.value === null)).toBe(true);
    expect(read[0]?.metric_date).toBe("2026-01-15");
    expect(read[0]?.fetched_at).toEqual(new Date("2026-01-16T00:00:00Z"));
    expect(read[0]?.raw_response_id).toBeNull();

    const [nulls] = await db<{ n: number }[]>`
      select count(*)::int as n from public.account_daily_metrics
      where account_id = ${account.id} and metric_date = '2026-01-15' and value is null
    `;
    expect(nulls?.n).toBe(1);

    // 上書き（value、fetched_at）。null → 値、値 → null の両方向
    const later = new Date("2026-01-17T00:00:00Z");
    await db.begin((tx) => upsertAccountDailyMetrics(tx, [row({ value: 9, fetched_at: later }), row({ metric: "saves", value: 3, fetched_at: later }), row({ metric: "views", value: null, fetched_at: later })]));
    const updated = await listAccountDailyMetrics(db, account.id, "2026-01-15");
    expect(updated.map((r) => [r.metric, r.breakdown, r.value])).toEqual([
      ["reach", "", 9],
      ["reach", "follow_type", 12_345_678_901],
      ["saves", "", 3],
      ["views", "", null],
    ]);
    expect(updated[0]?.fetched_at).toEqual(later);
    expect(await countRows()).toBe(4);

    expect(await listMetricDates(db, account.id, "reach")).toEqual(["2026-01-15"]);
    expect(await listMetricDates(db, account.id, "nothing")).toEqual([]);
    await db`delete from public.account_daily_metrics where account_id = ${account.id}`;
  });

  it("主キーが重複する行は後勝ちで 1 行になる（同じ文で 2 回更新しない）", async () => {
    const dup = [row({ value: 1 }), row({ value: 2 })];
    expect(dedupeAccountDailyRows(dup)).toEqual([row({ value: 2 })]);
    expect(await db.begin((tx) => upsertAccountDailyMetrics(tx, dup))).toBe(1);
    expect((await listAccountDailyMetrics(db, account.id, "2026-01-15")).map((r) => r.value)).toEqual([2]);
    await db`delete from public.account_daily_metrics where account_id = ${account.id}`;
  });

  // -------------------------------------------------------------------------
  // account_daily
  // -------------------------------------------------------------------------

  /** D−2: 全部成功。D−1: 内訳なしがコード 100 → 1 指標ずつ（reposts だけ失敗）、online_followers は {}。follower_count 3 日 */
  function queueDailyReplies(): void {
    replies.push(...groupReplies(), onlineReply(HOURS_24));
    replies.push(graphError(UNSUPPORTED));
    for (const m of NO_BREAKDOWN) {
      replies.push(m === "reposts" ? graphError({ message: "(#100) The reposts metric is not supported", code: 100 }) : ok({ data: [total(m, 50)] }));
    }
    replies.push(...groupReplies().slice(1), onlineReply({}));
    replies.push(followerCountReply([D(3), D(2), D(1)]));
  }

  const DAILY_CALLS = 5 + (1 + 12 + 3 + 1) + 1;
  const DAILY_ROWS = GROUP_ROWS + 25 + GROUP_ROWS + 3;

  it("account_daily（--days 2）: 4 グループ → online_followers → follower_count の順にリクエストし、印の行を含む行が入り、1 グループのコード 100 は 1 指標ずつに落ちて partial。raw_response_id が結ばれる。2 回流しても行数不変", async () => {
    queueDailyReplies();
    const outcome = await runJob(dailyJob, deps, account, { days: 2 });
    expect(outcome).toBe("partial");
    expect(replies).toHaveLength(0);

    const run = (await runsFor("account_daily")).at(-1);
    expect(run?.status).toBe("partial");
    expect(run?.items_fetched).toBe(DAILY_ROWS);
    expect(run?.api_calls).toBe(DAILY_CALLS);
    expect(run?.error).toBe("(#100) The reposts metric is not supported");

    // リクエストの順と形
    expect(calls).toHaveLength(DAILY_CALLS);
    expect(calls.every((u) => u.pathname === `/v25.0/${account.ig_user_id}/insights`)).toBe(true);
    const groupMetrics = ACCOUNT_METRIC_GROUPS.map((g) => g.metrics.join(","));
    expect(calls.map(metricParam)).toEqual([
      ...groupMetrics,
      "online_followers",
      groupMetrics[0],
      ...NO_BREAKDOWN,
      ...groupMetrics.slice(1),
      "online_followers",
      "follower_count",
    ]);
    const first = calls[0] as URL;
    expect(first.searchParams.get("period")).toBe("day");
    expect(first.searchParams.get("metric_type")).toBe("total_value");
    expect(first.searchParams.has("breakdown")).toBe(false);
    expect(first.searchParams.has("access_token")).toBe(false);
    expect(Number(first.searchParams.get("since"))).toBe(pacificDayRange(D(2)).since);
    expect(Number(first.searchParams.get("until"))).toBe(pacificDayRange(D(2)).until);
    expect((calls[1] as URL).searchParams.get("breakdown")).toBe("follow_type");
    const online = calls[4] as URL;
    expect(online.searchParams.get("period")).toBe("lifetime");
    expect(online.searchParams.has("metric_type")).toBe(false);
    expect(Number((calls[5] as URL).searchParams.get("since"))).toBe(pacificDayRange(D(1)).since);
    const follower = calls.at(-1) as URL;
    expect(follower.searchParams.get("period")).toBe("day");
    expect(follower.searchParams.has("metric_type")).toBe(false);
    expect(Number(follower.searchParams.get("since"))).toBe(Math.floor(zonedMidnightUtc(D(29), PT).getTime() / 1000));
    expect(Number(follower.searchParams.get("until"))).toBe(Math.floor(BASE.getTime() / 1000));

    // D−2 の行: 内訳なし 12、印の行つきの内訳 15、online_followers 25（follower_count の 1 行は別に見る）
    const dayA = (await listAccountDailyMetrics(db, account.id, D(2))).filter((r) => r.metric !== "follower_count");
    expect(dayA).toHaveLength(GROUP_ROWS + 25);
    expect(dayA.find((r) => r.metric === "reach" && r.breakdown === "" )?.value).toBe(1);
    expect(dayA.filter((r) => r.metric === "reach" && r.breakdown === "follow_type").map((r) => [r.breakdown_value, r.value])).toEqual([
      ["", 15],
      ["FOLLOWER", 10],
      ["NON_FOLLOWER", 5],
    ]);
    expect(dayA.filter((r) => r.metric === "follows_and_unfollows" && r.breakdown === "follow_type").map((r) => [r.breakdown_value, r.value])).toEqual([
      ["", null],
      ["FOLLOWER", 3],
    ]);
    expect(dayA.filter((r) => r.metric === "total_interactions" && r.breakdown === "media_product_type").map((r) => [r.breakdown_value, r.value])).toEqual([["", 0]]);
    const onlineRows = dayA.filter((r) => r.metric === "online_followers");
    expect(onlineRows).toHaveLength(25);
    expect(onlineRows.every((r) => r.breakdown === "hour")).toBe(true);
    expect(onlineRows.find((r) => r.breakdown_value === "")?.value).toBeNull();
    expect(onlineRows.find((r) => r.breakdown_value === "23")?.value).toBe(24);
    expect(dayA.every((r) => r.fetched_at.getTime() === BASE.getTime())).toBe(true);

    // D−1 の行: 1 指標ずつ（reposts は null）、online_followers なし
    const dayB = (await listAccountDailyMetrics(db, account.id, D(1))).filter((r) => r.metric !== "follower_count");
    expect(dayB).toHaveLength(GROUP_ROWS);
    expect(dayB.filter((r) => r.metric === "online_followers")).toEqual([]);
    expect(dayB.find((r) => r.metric === "reach" && r.breakdown === "")?.value).toBe(50);
    const reposts = dayB.find((r) => r.metric === "reposts" && r.breakdown === "");
    expect(reposts?.value).toBeNull();

    // raw_response_id は raw_api_responses に結ばれ、reposts の行はエラー応答（400）を指す
    const raw = await rawFor(run?.id ?? "");
    expect(raw).toHaveLength(DAILY_CALLS);
    const rawIds = new Set(raw.map((r) => r.id));
    for (const r of [...dayA, ...dayB]) {
      expect(r.raw_response_id).not.toBeNull();
      expect(rawIds.has(r.raw_response_id ?? "")).toBe(true);
    }
    const repostsRaw = raw.find((r) => r.id === reposts?.raw_response_id);
    expect(repostsRaw?.http_status).toBe(400);
    expect(repostsRaw?.params).toEqual({ metric: "reposts", period: "day", metric_type: "total_value", ...pacificDayRange(D(1)) });
    const dayARaw = raw.find((r) => r.id === dayA[0]?.raw_response_id);
    expect(dayARaw?.http_status).toBe(200);

    // follower_count は end_time の PT の日付で 3 日分
    expect(await listMetricDates(db, account.id, "follower_count")).toEqual([D(3), D(2), D(1)]);
    const fc = await listAccountDailyMetrics(db, account.id, D(3));
    expect(fc.map((r) => [r.metric, r.value])).toEqual([["follower_count", 1]]);
    expect((await listAccountDailyMetrics(db, account.id, D(2))).find((r) => r.metric === "follower_count")?.value).toBe(2);
    expect(await countRows()).toBe(DAILY_ROWS);

    // ログ: 項目の行は出さず、最後に days= と follower_days=。1 指標ずつに落ちた warn に error_code=100
    expect(logText()).toMatch(new RegExp(`^\\S+ INFO  job=account_daily days=2 from=${D(2)} to=${D(1)} follower_days=3$`, "m"));
    expect(logText()).toMatch(new RegExp(`^\\S+ WARN  job=account_daily date=${D(1)} metrics=12 warn="まとめて取れないので 1 指標ずつ取り直す" error_code=100 class=fatal$`, "m"));
    expect(logText()).toMatch(/WARN {2}job=account_daily date=\S+ warn=単独でも取れない指標 metrics=reposts error_code=100 class=fatal$/m);
    expect(logText()).toMatch(/WARN {2}job=account_daily status=partial items=\d+ calls=23 failures=1 duration_ms=\d+ rate=\d+% error_code=100 class=fatal$/m);
    expect(logText()).not.toContain(FAKE_TOKEN);
    expect(logText()).not.toContain(account.ig_user_id);
    expect(logText()).not.toContain(account.id);

    // 2 回目: 同じ応答で行数が変わらない（F-COL-20）
    queueDailyReplies();
    expect(await runJob(dailyJob, deps, account, { days: 2 })).toBe("partial");
    expect(await countRows()).toBe(DAILY_ROWS);
    expect((await runsFor("account_daily")).at(-1)?.items_fetched).toBe(DAILY_ROWS);
  });

  it("account_daily: online_followers が {} の日は行 0 で failures 0（success）。follower_count の失敗は partial", async () => {
    await db`delete from public.account_daily_metrics where account_id = ${account.id}`;
    replies.push(...groupReplies(), onlineReply({}), followerCountReply([D(1)]));
    expect(await runJob(dailyJob, deps, account, { days: 1 })).toBe("success");
    let run = (await runsFor("account_daily")).at(-1);
    expect(run?.items_fetched).toBe(GROUP_ROWS + 1);
    expect(run?.api_calls).toBe(6);
    expect((await listAccountDailyMetrics(db, account.id, D(1))).filter((r) => r.metric === "online_followers")).toEqual([]);
    expect(logText()).toMatch(/INFO {2}job=account_daily status=success items=28 calls=6 failures=0/m);

    replies.push(...groupReplies(), onlineReply({}), graphError({ message: "(#100) bad since", code: 100 }));
    expect(await runJob(dailyJob, deps, account, { days: 1 })).toBe("partial");
    run = (await runsFor("account_daily")).at(-1);
    expect(run?.items_fetched).toBe(GROUP_ROWS);
    expect(run?.error).toBe("(#100) bad since");
    expect(logText()).toMatch(/INFO {2}job=account_daily days=1 from=\S+ to=\S+ follower_days=0$/m);
    await db`delete from public.account_daily_metrics where account_id = ${account.id}`;
  });

  it("account_daily: --days が 2 年を超えて API が 2 年のエラーを返す日があれば、その日は失敗（固定文言）として partial。他の日と follower_count は書ける", async () => {
    // 2 年の境界は偽の fetch が決める（本物の 731 日分は 200 ms 間隔で 2 分以上かかる）。D−2 で 2 年のエラー、D−1 は正常
    replies.push(graphError(HISTORY_LIMIT));
    replies.push(...groupReplies(), onlineReply({}), followerCountReply([D(1)]));
    expect(await runJob(dailyJob, deps, account, { days: 2 })).toBe("partial");
    expect(calls).toHaveLength(1 + 5 + 1);
    const run = (await runsFor("account_daily")).at(-1);
    expect(run?.status).toBe("partial");
    expect(run?.items_fetched).toBe(GROUP_ROWS + 1);
    expect(run?.api_calls).toBe(7);
    expect(run?.error).toBe("2 年より前の日付は取得できない");
    expect(await listAccountDailyMetrics(db, account.id, D(2))).toEqual([]);
    expect(await listMetricDates(db, account.id, "reach")).toEqual([D(1)]);
    expect(logText()).toMatch(/WARN {2}job=account_daily status=partial items=28 calls=7 failures=1 duration_ms=\d+ rate=\d+% error_code=100 class=fatal$/m);
    expect(logText()).toMatch(/DEBUG job=account_daily error="2 年より前の日付は取得できない"$/m);
    await db`delete from public.account_daily_metrics where account_id = ${account.id}`;
  });

  it("account_daily: 既定は 4 日（D−4〜D−1 を古い順）", async () => {
    for (let i = 0; i < 4; i += 1) replies.push(...groupReplies(), onlineReply({}));
    replies.push(followerCountReply([]));
    expect(await runJob(dailyJob, deps, account, {})).toBe("success");
    expect(calls).toHaveLength(21);
    expect([0, 5, 10, 15].map((i) => Number((calls[i] as URL).searchParams.get("since")))).toEqual([D(4), D(3), D(2), D(1)].map((d) => pacificDayRange(d).since));
    expect(await listMetricDates(db, account.id, "reach")).toEqual([D(4), D(3), D(2), D(1)]);
    await db`delete from public.account_daily_metrics where account_id = ${account.id}`;
  });

  // -------------------------------------------------------------------------
  // account_backfill
  // -------------------------------------------------------------------------

  async function backfillState(): Promise<BackfillState | undefined> {
    return getJobState<BackfillState>(db, account.id, "account_backfill");
  }

  it("account_backfill: 1 回目は maxDays 分進んで job_state が更新され、2 回目は続きから。2 年超のエラーで done、3 回目は shouldRun が false で job_runs に行を作らない", async () => {
    // 1 回目: D−1、D−2、D−3（online_followers は呼ばない）
    for (let i = 0; i < 3; i += 1) replies.push(...groupReplies());
    expect(await runJob(backfillJob, deps, account)).toBe("success");
    expect(replies).toHaveLength(0);
    expect(calls).toHaveLength(12);
    expect(calls.map(metricParam)).not.toContain("online_followers");
    expect([0, 4, 8].map((i) => Number((calls[i] as URL).searchParams.get("since")))).toEqual([D(1), D(2), D(3)].map((d) => pacificDayRange(d).since));
    let run = (await runsFor("account_backfill")).at(-1);
    expect(run?.status).toBe("success");
    expect(run?.items_fetched).toBe(GROUP_ROWS * 3);
    expect(run?.api_calls).toBe(12);
    expect(await backfillState()).toEqual({ next_date: D(4), oldest_date: D(730), done: false, days_done: 3, failed_dates: [] });
    expect(await listMetricDates(db, account.id, "reach")).toEqual([D(3), D(2), D(1)]);
    expect(logText()).toMatch(new RegExp(`^\\S+ INFO  job=account_backfill days=3 retry=false next_date=${D(4)} days_done=3 failed_dates=0 done=false$`, "m"));

    // 2 回目: D−4 は取れ、D−5 で 2 年超のエラー → その日は取らずに done
    const before = (await runsFor("account_backfill")).length;
    replies.push(...groupReplies(), graphError(HISTORY_LIMIT));
    expect(await runJob(backfillJob, deps, account)).toBe("success");
    expect(replies).toHaveLength(0);
    expect(calls).toHaveLength(12 + 5);
    run = (await runsFor("account_backfill")).at(-1);
    expect(run?.items_fetched).toBe(GROUP_ROWS);
    expect(run?.api_calls).toBe(5);
    expect(run?.error).toBeNull();
    // 2 年のエラーの日で通常の日の下限が確定する（oldest_date = D−5 + 1 = D−4）
    expect(await backfillState()).toEqual({ next_date: D(5), oldest_date: D(4), done: true, days_done: 4, failed_dates: [] });
    expect(await listMetricDates(db, account.id, "reach")).toEqual([D(4), D(3), D(2), D(1)]);
    expect(logText()).toMatch(new RegExp(`^\\S+ INFO  job=account_backfill days=1 retry=false next_date=${D(5)} days_done=4 failed_dates=0 done=true reason="2 年より前"$`, "m"));

    // 3 回目: shouldRun が false → job_runs に行を作らない
    expect(await runJob(backfillJob, deps, account)).toBe("skipped");
    expect(await runsFor("account_backfill")).toHaveLength(before + 1);
    expect(calls).toHaveLength(17);
    await db`delete from public.account_daily_metrics where account_id = ${account.id}`;
  });

  it("account_backfill: 使用率が rateSoftLimit 以上（hard limit 未満）なら次の日の前で止まり、書けた分は残る（partial、error に固定文言）", async () => {
    // 初期値（直近 1 時間の job_runs.rate_usage）で見送る経路も同じ `ctx.rate.exceeds(rateSoftLimit)` の判定。
    // 未来の finished_at を job_runs に仕込むと、並列に走る他のテストファイルが `latestRateUsage`（アカウントで絞らない）で
    // 拾ってしまうため、ここでは応答ヘッダで使用率を上げる
    await setJobState<BackfillState>(db, account.id, "account_backfill", { next_date: D(6), oldest_date: D(730), done: false, days_done: 5, failed_dates: [] });
    const [g1, g2, g3] = groupReplies();
    replies.push(g1 as Reply, g2 as Reply, g3 as Reply, ok({ data: [withBreakdown("profile_links_taps", "contact_button_type", { EMAIL: 2 }, 2)] }, usageHeader(60)));
    replies.push(...groupReplies());
    expect(await runJob(backfillJob, deps, account)).toBe("partial");
    expect(calls).toHaveLength(4);
    expect(replies).toHaveLength(4);
    const run = (await runsFor("account_backfill")).at(-1);
    expect(run?.status).toBe("partial");
    expect(run?.items_fetched).toBe(GROUP_ROWS);
    expect(run?.api_calls).toBe(4);
    expect(run?.rate_usage).toEqual({ call_count: 60, total_cputime: 1, total_time: 1 });
    expect(run?.error).toBe("レート制限の使用率がしきい値を超えた（使用率 60%、しきい値 50%）");
    expect(await backfillState()).toEqual({ next_date: D(7), oldest_date: D(730), done: false, days_done: 6, failed_dates: [] });
    expect(logText()).toMatch(/WARN {2}job=account_backfill status=partial items=27 calls=4 failures=0 duration_ms=\d+ rate=60% error_code=none class=rate$/m);
    replies.length = 0;
    await db`delete from public.account_daily_metrics where account_id = ${account.id}`;
  });

  it("account_backfill: 失敗した日は failed_dates に入り partial。通常の日を終えたら attempts < 3 の日を取り直し、3 回失敗した日は残して done", async () => {
    // 通常の回: D−6 の内訳なしがコード 300（取り直さない）→ failed_dates に attempts 1
    await setJobState<BackfillState>(db, account.id, "account_backfill", { next_date: D(6), oldest_date: D(730), done: false, days_done: 5, failed_dates: [] });
    replies.push(graphError({ message: "(#300) Something went wrong", code: 300 }), ...groupReplies().slice(1));
    replies.push(...groupReplies(), ...groupReplies());
    expect(await runJob(backfillJob, deps, account)).toBe("partial");
    expect(calls).toHaveLength(12);
    let run = (await runsFor("account_backfill")).at(-1);
    expect(run?.items_fetched).toBe(15 + GROUP_ROWS * 2);
    expect(run?.error).toBe("(#300) Something went wrong");
    expect(await backfillState()).toEqual({ next_date: D(9), oldest_date: D(730), done: false, days_done: 8, failed_dates: [{ date: D(6), attempts: 1 }] });
    expect((await listAccountDailyMetrics(db, account.id, D(6))).filter((r) => r.breakdown === "")).toEqual([]);

    // 取り直しの回: 通常の日を終えた状態にして、attempts 2 の日は取れて消え、attempts 3 の日は残って done
    await setJobState<BackfillState>(db, account.id, "account_backfill", {
      next_date: D(731),
      oldest_date: D(730),
      done: false,
      days_done: 730,
      failed_dates: [
        { date: D(6), attempts: 2 },
        { date: D(100), attempts: 3 },
      ],
    });
    calls.length = 0;
    lines.length = 0;
    replies.push(...groupReplies());
    expect(await runJob(backfillJob, deps, account)).toBe("success");
    expect(calls).toHaveLength(4);
    expect(Number((calls[0] as URL).searchParams.get("since"))).toBe(pacificDayRange(D(6)).since);
    expect(await backfillState()).toEqual({ next_date: D(731), oldest_date: D(730), done: true, days_done: 730, failed_dates: [{ date: D(100), attempts: 3 }] });
    expect((await listAccountDailyMetrics(db, account.id, D(6))).filter((r) => r.breakdown === "")).toHaveLength(12);
    expect(logText()).toMatch(/WARN {2}job=account_backfill warn=取り直しを使い切った日が残っている failed_dates=1$/m);
    expect(logText()).toMatch(new RegExp(`INFO  job=account_backfill days=1 retry=true next_date=${D(731)} days_done=730 failed_dates=1 done=true$`, "m"));

    // 取り直しで 3 回目も失敗 → その日を残して done
    await setJobState<BackfillState>(db, account.id, "account_backfill", { next_date: D(731), oldest_date: D(730), done: false, days_done: 730, failed_dates: [{ date: D(7), attempts: 2 }] });
    replies.push(graphError({ message: "(#300) Something went wrong", code: 300 }), ...groupReplies().slice(1));
    expect(await runJob(backfillJob, deps, account)).toBe("partial");
    expect(await backfillState()).toEqual({ next_date: D(731), oldest_date: D(730), done: true, days_done: 730, failed_dates: [{ date: D(7), attempts: 3 }] });

    // 通常の日も取り直しも残っていない（3 回失敗の日だけ）→ API を呼ばずに done
    await setJobState<BackfillState>(db, account.id, "account_backfill", { next_date: D(731), oldest_date: D(730), done: false, days_done: 730, failed_dates: [{ date: D(7), attempts: 3 }] });
    calls.length = 0;
    expect(await runJob(backfillJob, deps, account)).toBe("success");
    expect(calls).toHaveLength(0);
    expect((await backfillState())?.done).toBe(true);
    await db`delete from public.account_daily_metrics where account_id = ${account.id}`;
  });

  it("account_backfill: 2 年のエラーが返っても取り直せる失敗日が残っていれば done にせず、次回に取り直してから done。取り直しの回の 2 年エラーは date 以前の失敗日だけを消す", async () => {
    // 通常の回: D−10 で 2 年のエラー。D−3 の失敗（attempts 1）は残るので done にしない。D−11、D−12 は呼ばない
    await setJobState<BackfillState>(db, account.id, "account_backfill", {
      next_date: D(10),
      oldest_date: D(730),
      done: false,
      days_done: 9,
      failed_dates: [{ date: D(3), attempts: 1 }],
    });
    replies.push(graphError(HISTORY_LIMIT));
    expect(await runJob(backfillJob, deps, account)).toBe("success");
    expect(calls).toHaveLength(1);
    expect(await backfillState()).toEqual({ next_date: D(10), oldest_date: D(9), done: false, days_done: 9, failed_dates: [{ date: D(3), attempts: 1 }] });
    expect(logText()).not.toContain("取り直しを使い切った日が残っている");
    expect(logText()).toMatch(new RegExp(`INFO  job=account_backfill days=0 retry=false next_date=${D(10)} days_done=9 failed_dates=1 done=false reason="2 年より前"$`, "m"));

    // 次回は取り直しの回: D−3 が取れて done
    calls.length = 0;
    lines.length = 0;
    replies.push(...groupReplies());
    expect(await runJob(backfillJob, deps, account)).toBe("success");
    expect(calls).toHaveLength(4);
    expect(Number((calls[0] as URL).searchParams.get("since"))).toBe(pacificDayRange(D(3)).since);
    expect(await backfillState()).toEqual({ next_date: D(10), oldest_date: D(9), done: true, days_done: 9, failed_dates: [] });
    expect(await runJob(backfillJob, deps, account)).toBe("skipped");

    // 取り直しの回に 2 年のエラー: D−20（新しい方から）で返ると D−20 以前の失敗日は消え、D−3 はこの回で続けて取り直される
    await setJobState<BackfillState>(db, account.id, "account_backfill", {
      next_date: D(731),
      oldest_date: D(730),
      done: false,
      days_done: 730,
      failed_dates: [
        { date: D(20), attempts: 1 },
        { date: D(3), attempts: 2 },
        { date: D(25), attempts: 1 },
      ],
    });
    calls.length = 0;
    lines.length = 0;
    replies.push(graphError(HISTORY_LIMIT), ...groupReplies());
    expect(await runJob(backfillJob, deps, account)).toBe("success");
    expect(calls).toHaveLength(5);
    expect(Number((calls[0] as URL).searchParams.get("since"))).toBe(pacificDayRange(D(20)).since);
    expect(Number((calls[1] as URL).searchParams.get("since"))).toBe(pacificDayRange(D(3)).since);
    expect(await backfillState()).toEqual({ next_date: D(20), oldest_date: D(19), done: true, days_done: 730, failed_dates: [] });
    expect(logText()).toMatch(new RegExp(`INFO  job=account_backfill days=1 retry=true next_date=${D(20)} days_done=730 failed_dates=0 done=true reason="2 年より前"$`, "m"));
    await db`delete from public.account_daily_metrics where account_id = ${account.id}`;
  });

  it("account_backfill: 730 日で作った job_state があっても、設定の遡る日数を小さくすれば残りの日が縮んで done になる", async () => {
    // D−90 まで進んだ状態（oldest_date は 730 日前で保存済み）で、遡る日数を 92 にする → D−90、D−91、D−92 で終わり
    await setJobState<BackfillState>(db, account.id, "account_backfill", { next_date: D(90), oldest_date: D(730), done: false, days_done: 89, failed_dates: [] });
    const shortHistory: JobDeps = { ...deps, config: { ...config, backfillHistoryDays: 92 } };
    for (let i = 0; i < 3; i += 1) replies.push(...groupReplies());
    expect(await runJob(backfillJob, shortHistory, account)).toBe("success");
    expect(calls).toHaveLength(12);
    expect([0, 4, 8].map((i) => Number((calls[i] as URL).searchParams.get("since")))).toEqual([D(90), D(91), D(92)].map((d) => pacificDayRange(d).since));
    expect(await backfillState()).toEqual({ next_date: D(93), oldest_date: D(92), done: true, days_done: 92, failed_dates: [] });
    expect(await listMetricDates(db, account.id, "reach")).toEqual([D(92), D(91), D(90)]);
    expect(await runJob(backfillJob, shortHistory, account)).toBe("skipped");

    // next_date が新しい下限より古い状態で小さくすると、API を呼ばずに done
    await setJobState<BackfillState>(db, account.id, "account_backfill", { next_date: D(500), oldest_date: D(730), done: false, days_done: 499, failed_dates: [] });
    calls.length = 0;
    expect(await runJob(backfillJob, { ...deps, config: { ...config, backfillHistoryDays: 400 } }, account)).toBe("success");
    expect(calls).toHaveLength(0);
    expect(await backfillState()).toEqual({ next_date: D(500), oldest_date: D(400), done: true, days_done: 499, failed_dates: [] });
    await db`delete from public.account_daily_metrics where account_id = ${account.id}`;
  });

  it("account_backfill: D−700 より古い日でコード 100 が「2 年」の判定に当たらなければ warn して failed_dates に入れ、done にしない", async () => {
    await setJobState<BackfillState>(db, account.id, "account_backfill", { next_date: D(705), oldest_date: D(730), done: false, days_done: 0, failed_dates: [] });
    const shortDeps: JobDeps = { ...deps, config: { ...config, backfillMaxDays: 1 } };
    replies.push(graphError(UNSUPPORTED));
    for (const m of NO_BREAKDOWN) replies.push(graphError({ message: `(#100) ${m} unsupported`, code: 100 }));
    replies.push(...groupReplies().slice(1));
    expect(await runJob(backfillJob, shortDeps, account)).toBe("partial");
    expect(calls).toHaveLength(1 + 12 + 3);
    const run = (await runsFor("account_backfill")).at(-1);
    expect(run?.items_fetched).toBe(12 + 15);
    expect(await backfillState()).toEqual({ next_date: D(706), oldest_date: D(730), done: false, days_done: 1, failed_dates: [{ date: D(705), attempts: 1 }] });
    const rows = await listAccountDailyMetrics(db, account.id, D(705));
    expect(rows.filter((r) => r.breakdown === "").every((r) => r.value === null)).toBe(true);
    expect(logText()).toMatch(new RegExp(`^\\S+ WARN  job=account_backfill date=${D(705)} warn="2 年の判定に失敗した可能性" error_code=100 class=fatal$`, "m"));
    expect(logText()).toMatch(/WARN {2}job=account_backfill status=partial items=27 calls=16 failures=12 .* error_code=100 class=fatal$/m);
    await db`delete from public.account_daily_metrics where account_id = ${account.id}`;
    await db`delete from public.job_state where account_id = ${account.id}`;
  });
});
