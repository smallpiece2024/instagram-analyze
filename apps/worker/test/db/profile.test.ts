/**
 * `db/profile.ts` と `jobs/profile-daily.ts` の結合テスト（設計 5.1 章、9.2 章）。
 * 偽の `fetch` と本物の DB（ローカル Supabase）で `runJob(profileDailyJob)` を動かす。
 * 架空のアカウントを作り、終了時に消す（CASCADE で関連する行も消える）。
 *
 * 時計（`deps.now`）は実時刻より 24 時間以上先（2 日後の UTC 14:59:59／15:00:00 など）に固定する。JST の日付の境界
 * （UTC 15:00）を確かめるためと、他のテストファイルが並列に書く `job_runs.rate_usage`（`finished_at` は最大で
 * 10 時間ほど先）を `latestRateUsage` が拾わないようにするため
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WorkerConfig } from "../../src/config.js";
import { upsertAccount, upsertCredential, type CredentialInfo } from "../../src/db/accounts.js";
import { closeDb, connectDb, type Db } from "../../src/db/client.js";
import { getProfileDaily, updateAccountProfile, upsertProfileDaily } from "../../src/db/profile.js";
import type { AccountRow, JobRunRow, ProfileDailyRow, RawApiResponseRow } from "../../src/db/types.js";
import { runJob, type JobDeps } from "../../src/jobs/framework.js";
import { job as profileDailyJob, PROFILE_FIELDS, toAccountProfile, toProfileRow } from "../../src/jobs/profile-daily.js";
import type { GraphError } from "../../src/lib/graph.js";
import { addDays } from "../../src/lib/time.js";
import { createLogger, SecretRegistry } from "../../src/lib/log.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

function fakeIgUserId(): string {
  return "000000" + Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, "0");
}

type Reply = () => Response;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function ok(body: unknown): Reply {
  return () => jsonResponse(body);
}

function graphError(error: GraphError, status = 400): Reply {
  return () => jsonResponse({ error }, { status });
}

const FAKE_TOKEN = `FAKE_PROFILE_TOKEN_${Math.floor(Math.random() * 1_000_000_000)}`;
const HOUR_MS = 60 * 60 * 1000;

const CREDENTIAL: CredentialInfo = {
  token_type: "PAGE",
  expires_at: null,
  data_access_expires_at: new Date("2026-12-29T00:00:00Z"),
  scopes: ["instagram_basic", "instagram_manage_insights", "pages_read_engagement"],
  status: "valid",
};

/**
 * `daysAhead` 日後（UTC の日付）の指定時刻。`daysAhead` は 2 以上にして実時刻から 24 時間以上先にする。
 * テストごとに別の日を使う（`profile_daily` は (account_id, captured_on) で 1 行なので、同じ JST の日付を使うと
 * 前のテストの行が残って見える）
 */
function futureAt(daysAhead: number, hour: number, minute: number, second: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hour, minute, second, 0);
  return d;
}

/** `Date` の UTC の日付（`YYYY-MM-DD`） */
function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

describe("toProfileRow と toAccountProfile（純粋関数）", () => {
  const fetchedAt = new Date("2026-10-01T05:30:00Z");

  it("応答の件数を数値のまま、username と name を文字列のまま取り出す", () => {
    const body = { id: "1", username: "u", name: "n", followers_count: 1234, follows_count: 56, media_count: 78 };
    expect(toProfileRow(body, "acc", "2026-10-01", fetchedAt, "99")).toEqual({
      account_id: "acc",
      captured_on: "2026-10-01",
      captured_at: fetchedAt,
      followers_count: 1234,
      follows_count: 56,
      media_count: 78,
      raw_response_id: "99",
    });
    expect(toAccountProfile(body)).toEqual({ username: "u", name: "n" });
  });

  it("返らなかったフィールドは null。0 は 0。数字の文字列は数値。変換できない値、真偽値、空文字、小数は null", () => {
    const row = toProfileRow({ id: "1", followers_count: 0, follows_count: "12", media_count: "abc" }, "acc", "2026-10-01", fetchedAt, null);
    expect(row.followers_count).toBe(0);
    expect(row.follows_count).toBe(12);
    expect(row.media_count).toBeNull();
    expect(row.raw_response_id).toBeNull();
    expect(toProfileRow({ followers_count: true, follows_count: "", media_count: 1.5 }, "acc", "2026-10-01", fetchedAt, null)).toMatchObject({
      followers_count: null,
      follows_count: null,
      media_count: null,
    });
    expect(toAccountProfile({ username: 123, name: null })).toEqual({ username: null, name: null });
  });

  it("応答がオブジェクトでなければ全項目 null", () => {
    for (const body of [undefined, null, "text", [1, 2]]) {
      expect(toProfileRow(body, "acc", "2026-10-01", fetchedAt, null)).toMatchObject({
        followers_count: null,
        follows_count: null,
        media_count: null,
      });
      expect(toAccountProfile(body)).toEqual({ username: null, name: null });
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("db/profile と jobs/profile-daily（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  let db: Db;
  let account: AccountRow;
  let deps: JobDeps;
  const replies: Reply[] = [];
  const calls: { url: URL; authorization: string | null }[] = [];
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

  const fetchImpl: typeof fetch = async (input, init) => {
    const target = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
    calls.push({ url: target, authorization: new Headers(init?.headers).get("authorization") });
    const reply = replies.shift();
    if (!reply) return jsonResponse({ error: { message: "応答の用意がない", code: 999_999 } }, { status: 400 });
    return reply();
  };

  function profileOk(overrides: Record<string, unknown> = {}): Reply {
    return ok({
      id: account.ig_user_id,
      username: "fake_profile_user",
      name: "Fake Profile Name",
      followers_count: 1234,
      follows_count: 56,
      media_count: 78,
      ...overrides,
    });
  }

  async function runsFor(): Promise<JobRunRow[]> {
    return [...(await db<JobRunRow[]>`select * from public.job_runs where account_id = ${account.id} and job_name = 'profile_daily' order by id`)];
  }

  async function rawFor(jobRunId: string): Promise<RawApiResponseRow[]> {
    return [...(await db<RawApiResponseRow[]>`select * from public.raw_api_responses where job_run_id = ${jobRunId} order by id`)];
  }

  async function profileRows(): Promise<ProfileDailyRow[]> {
    return [...(await db<ProfileDailyRow[]>`select * from public.profile_daily where account_id = ${account.id} order by captured_on`)];
  }

  async function accountRow(): Promise<AccountRow | undefined> {
    return (await db<AccountRow[]>`select * from public.accounts where id = ${account.id}`)[0];
  }

  function depsAt(now: Date): JobDeps {
    return { ...deps, now: () => now };
  }

  function logText(): string {
    return lines.join("\n");
  }

  beforeAll(async () => {
    db = connectDb(url);
    account = await db.begin((tx) => upsertAccount(tx, { ig_user_id: fakeIgUserId(), username: "fake_before" }));
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
    replies.length = 0;
    calls.length = 0;
    lines.length = 0;
  });

  afterAll(async () => {
    await db`delete from public.accounts where id = ${account.id}`;
    const [rows] = await db<{ n: number }[]>`select count(*)::int as n from public.profile_daily where account_id = ${account.id}`;
    expect(rows?.n).toBe(0);
    await closeDb(db);
  });

  it("upsertProfileDaily: 2 回で 1 行、後の値で上書き。null は SQL の NULL。date は文字列で返る", async () => {
    const capturedOn = "2030-01-01";
    const first = new Date("2030-01-01T00:00:00Z");
    const second = new Date("2030-01-01T01:00:00Z");
    await db.begin((tx) =>
      upsertProfileDaily(tx, {
        account_id: account.id,
        captured_on: capturedOn,
        captured_at: first,
        followers_count: 10,
        follows_count: 20,
        media_count: 30,
        raw_response_id: null,
      }),
    );
    expect(await getProfileDaily(db, account.id, capturedOn)).toEqual({
      account_id: account.id,
      captured_on: capturedOn,
      captured_at: first,
      followers_count: 10,
      follows_count: 20,
      media_count: 30,
      raw_response_id: null,
    });

    await db.begin((tx) =>
      upsertProfileDaily(tx, {
        account_id: account.id,
        captured_on: capturedOn,
        captured_at: second,
        followers_count: 11,
        follows_count: null,
        media_count: 0,
        raw_response_id: null,
      }),
    );
    const rows = await profileRows();
    expect(rows.filter((r) => r.captured_on === capturedOn)).toHaveLength(1);
    const row = await getProfileDaily(db, account.id, capturedOn);
    expect(row?.captured_at).toEqual(second);
    expect(row?.followers_count).toBe(11);
    expect(row?.follows_count).toBeNull();
    expect(row?.media_count).toBe(0);
    const [nulls] = await db<{ n: number }[]>`
      select count(*)::int as n from public.profile_daily
      where account_id = ${account.id} and captured_on = ${capturedOn} and follows_count is null and media_count = 0
    `;
    expect(nulls?.n).toBe(1);
    expect(await getProfileDaily(db, account.id, "2030-01-02")).toBeUndefined();
  });

  it("updateAccountProfile: null の項目は既存の値を残す。両方 null なら updated_at も変わらない", async () => {
    await db.begin((tx) => updateAccountProfile(tx, account.id, { username: "fake_updated", name: "Fake Updated" }));
    let row = await accountRow();
    expect(row?.username).toBe("fake_updated");
    expect(row?.name).toBe("Fake Updated");
    const updatedAt = row?.updated_at;

    await db.begin((tx) => updateAccountProfile(tx, account.id, { username: null, name: "Only Name" }));
    row = await accountRow();
    expect(row?.username).toBe("fake_updated");
    expect(row?.name).toBe("Only Name");

    await db.begin((tx) => updateAccountProfile(tx, account.id, { username: "only_user", name: null }));
    row = await accountRow();
    expect(row?.username).toBe("only_user");
    expect(row?.name).toBe("Only Name");
    expect(row?.updated_at.getTime()).toBeGreaterThanOrEqual(updatedAt?.getTime() ?? 0);

    const before = (await accountRow())?.updated_at;
    await db.begin((tx) => updateAccountProfile(tx, account.id, { username: null, name: null }));
    row = await accountRow();
    expect(row?.username).toBe("only_user");
    expect(row?.name).toBe("Only Name");
    expect(row?.updated_at).toEqual(before);
  });

  it("runJob: 行が入り、captured_on は開始時刻の JST の日付（UTC 15:00 で日付が変わる）、captured_at は取得時刻、raw_response_id が結ばれ、accounts.username と name が更新される", async () => {
    const before = futureAt(2, 14, 59, 59);
    const after = new Date(before.getTime() + 1000);
    const dayBefore = utcDate(before);
    const dayAfter = addDays(dayBefore, 1);
    expect(utcDate(after)).toBe(dayBefore); // UTC では同じ日。JST では翌日

    // UTC 14:59:59 → JST 23:59:59（同じ日）
    replies.push(profileOk());
    expect(await runJob(profileDailyJob, depsAt(before), account, {}, "1/1")).toBe("success");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.pathname).toBe(`/v25.0/${account.ig_user_id}`);
    expect(calls[0]?.url.searchParams.get("fields")).toBe(PROFILE_FIELDS);
    expect(calls[0]?.url.searchParams.has("access_token")).toBe(false);
    expect(calls[0]?.authorization).toBe(`Bearer ${FAKE_TOKEN}`);

    const run = (await runsFor()).at(-1);
    expect(run?.status).toBe("success");
    expect(run?.items_fetched).toBe(1);
    expect(run?.api_calls).toBe(1);
    expect(run?.error).toBeNull();
    const raw = await rawFor(run?.id ?? "");
    expect(raw).toHaveLength(1);
    expect(raw[0]?.endpoint).toBe(account.ig_user_id);
    expect(raw[0]?.params).toEqual({ fields: PROFILE_FIELDS });

    const row = await getProfileDaily(db, account.id, dayBefore);
    expect(row).toEqual({
      account_id: account.id,
      captured_on: dayBefore,
      captured_at: before,
      followers_count: 1234,
      follows_count: 56,
      media_count: 78,
      raw_response_id: raw[0]?.id,
    });
    expect(await getProfileDaily(db, account.id, dayAfter)).toBeUndefined();

    const updated = await accountRow();
    expect(updated?.username).toBe("fake_profile_user");
    expect(updated?.name).toBe("Fake Profile Name");

    // UTC 15:00:00 → JST 翌日 00:00:00
    replies.push(profileOk({ followers_count: 1235 }));
    expect(await runJob(profileDailyJob, depsAt(after), account)).toBe("success");
    const next = await getProfileDaily(db, account.id, dayAfter);
    expect(next?.captured_on).toBe(dayAfter);
    expect(next?.captured_at).toEqual(after);
    expect(next?.followers_count).toBe(1235);
    // 前の日の行はそのまま
    expect((await getProfileDaily(db, account.id, dayBefore))?.followers_count).toBe(1234);

    expect(logText()).toMatch(/INFO {2}job=profile_daily account=1\/1 status=success items=1 calls=1 failures=0 duration_ms=\d+/m);
    expect(logText()).not.toContain(FAKE_TOKEN);
    expect(logText()).not.toContain(account.ig_user_id);
    expect(logText()).not.toContain("fake_profile_user");
  });

  it("runJob: 同じ応答で 2 回流しても 1 行のまま（raw_response_id は後の方に差し替わる）。返らなかったフィールドは null、username がなければ既存を残す", async () => {
    const now = futureAt(4, 3, 0, 0);
    const day = utcDate(now); // UTC 03:00 = JST 12:00、同じ日
    const countBefore = (await profileRows()).length;

    replies.push(profileOk());
    expect(await runJob(profileDailyJob, depsAt(now), account)).toBe("success");
    const firstRaw = (await getProfileDaily(db, account.id, day))?.raw_response_id;
    expect(firstRaw).toBeTruthy();

    replies.push(profileOk({ username: undefined, name: undefined, follows_count: undefined, media_count: "abc" }));
    expect(await runJob(profileDailyJob, depsAt(now), account)).toBe("success");
    expect(await profileRows()).toHaveLength(countBefore + 1);
    const row = await getProfileDaily(db, account.id, day);
    expect(row?.followers_count).toBe(1234);
    expect(row?.follows_count).toBeNull();
    expect(row?.media_count).toBeNull();
    expect(row?.raw_response_id).not.toBe(firstRaw);
    const updated = await accountRow();
    expect(updated?.username).toBe("fake_profile_user");
    expect(updated?.name).toBe("Fake Profile Name");
  });

  it("runJob: API が fatal で失敗したら failed で行なし。error はマスク済みの API の文言、WARN 行に error_code と class。transient を使い切っても failed", async () => {
    const now = futureAt(5, 5, 30, 0);
    const day = utcDate(now);
    const countBefore = (await profileRows()).length;

    replies.push(graphError({ message: `Unsupported get request. Object with ID '${account.ig_user_id}' does not exist`, type: "GraphMethodException", code: 100, error_subcode: 33 }));
    expect(await runJob(profileDailyJob, depsAt(now), account)).toBe("failed");
    let run = (await runsFor()).at(-1);
    expect(run?.status).toBe("failed");
    expect(run?.items_fetched).toBe(0);
    expect(run?.api_calls).toBe(1);
    // ID（10 桁以上の数字）は出所でマスクされる
    expect(run?.error).toBe("Unsupported get request. Object with ID '***' does not exist");
    expect(await getProfileDaily(db, account.id, day)).toBeUndefined();
    expect(await profileRows()).toHaveLength(countBefore);
    // 生レスポンス（エラー応答）は残る
    expect(await rawFor(run?.id ?? "")).toHaveLength(1);
    expect(logText()).toMatch(/WARN {2}job=profile_daily status=failed items=0 calls=1 failures=1 duration_ms=\d+ rate=\d+% error_code=100 class=fatal$/m);
    expect(logText()).toMatch(/DEBUG job=profile_daily error="Unsupported get request\. Object with ID '\*\*\*' does not exist"$/m);
    expect(logText()).not.toContain(account.ig_user_id);

    lines.length = 0;
    const network: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await runJob(profileDailyJob, { ...depsAt(now), fetchImpl: network }, account)).toBe("failed");
    run = (await runsFor()).at(-1);
    expect(run?.status).toBe("failed");
    expect(run?.items_fetched).toBe(0);
    expect(run?.api_calls).toBe(3);
    expect(run?.error).toBe("ネットワークエラー");
    expect(await profileRows()).toHaveLength(countBefore);
    expect(logText()).toMatch(/WARN {2}job=profile_daily status=failed items=0 calls=3 failures=1 duration_ms=\d+ rate=\d+% error_code=none class=transient$/m);
    expect(logText()).toMatch(/DEBUG job=profile_daily error=ネットワークエラー$/m);
  });

  it("runJob: コード 190 なら failed、private.credentials が expired、行なし", async () => {
    const now = futureAt(6, 6, 0, 0);
    const day = utcDate(now);
    replies.push(graphError({ message: "Invalid OAuth access token", type: "OAuthException", code: 190 }));
    expect(await runJob(profileDailyJob, depsAt(now), account)).toBe("failed");
    expect((await runsFor()).at(-1)?.error).toBe("トークンが無効（コード 190）");
    expect(await getProfileDaily(db, account.id, day)).toBeUndefined();
    const [credential] = await db<{ status: string }[]>`select status from private.credentials where account_id = ${account.id}`;
    expect(credential?.status).toBe("expired");
  });
});
