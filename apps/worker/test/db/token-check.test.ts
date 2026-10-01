/**
 * `jobs/token-check.ts` の結合テスト（設計 4.2 章の 5 条件、9.2 章）。
 * 偽の `fetch` と本物の DB（ローカル Supabase）で `runJob(tokenCheckJob)` を動かし、`private.credentials`、`job_runs`、
 * `raw_api_responses`（`persist: false` なので増えない）、ログを確かめる。架空のアカウントを作り、終了時に消す
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WorkerConfig } from "../../src/config.js";
import { readCredential, updateCredentialStatus, upsertAccount, upsertCredential, type CredentialInfo } from "../../src/db/accounts.js";
import { closeDb, connectDb, type Db } from "../../src/db/client.js";
import type { AccountRow, CredentialRow, JobRunRow } from "../../src/db/types.js";
import { runJob, type JobDeps } from "../../src/jobs/framework.js";
import { INVALID_TOKEN_ERROR, job as tokenCheckJob } from "../../src/jobs/token-check.js";
import type { GraphError } from "../../src/lib/graph.js";
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

const FAKE_TOKEN = `FAKE_TOKEN_CHECK_TOKEN_${Math.floor(Math.random() * 1_000_000_000)}`;
const FAKE_APP_SECRET = "FAKE_TOKEN_CHECK_APP_SECRET";
const ALL_SCOPES = ["instagram_basic", "instagram_manage_insights", "pages_read_engagement"];
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** 登録時の状態。各テストの前にこれへ戻す */
const INITIAL: CredentialInfo = {
  token_type: "PAGE",
  expires_at: null,
  data_access_expires_at: new Date("2026-12-29T00:00:00Z"),
  scopes: [...ALL_SCOPES, "pages_show_list"],
  status: "valid",
};

describe.skipIf(!TEST_DATABASE_URL)("jobs/token-check（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  let db: Db;
  let account: AccountRow;
  let deps: JobDeps;
  const replies: Reply[] = [];
  const calls: { url: URL; authorization: string | null }[] = [];
  const lines: string[] = [];
  // 他のテストファイルが並列に書く job_runs.rate_usage を latestRateUsage が拾わないよう、実時刻より先に固定する。
  // debug_token の期限は UNIX 秒なので、残り日数の計算がずれないよう秒に切り捨てる
  const now = new Date(Math.floor((Date.now() + 20 * HOUR_MS) / 1000) * 1000);

  const config: WorkerConfig = {
    databaseUrl: url,
    supabaseUrl: "http://127.0.0.1:54321",
    supabaseServiceRoleKey: "FAKE_SERVICE_ROLE_KEY",
    graphApiVersion: "v25.0",
    metaAppId: "123456",
    metaAppSecret: FAKE_APP_SECRET,
    hourlyMinute: 5,
    dailyTimeJst: { hour: 5, minute: 30 },
    backfillMaxDays: 30,
    backfillHistoryDays: 730,
    rateHardLimit: 90,
    rateSoftLimit: 50,
    logLevel: "debug",
    outputDir: ".local",
    downloadAllowedHosts: ["cdninstagram.com"],
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const target = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
    calls.push({ url: target, authorization: new Headers(init?.headers).get("authorization") });
    const reply = replies.shift();
    if (!reply) return jsonResponse({ error: { message: "応答の用意がない", code: 999_999 } }, { status: 400 });
    return reply();
  };

  function debugTokenOk(overrides: Record<string, unknown> = {}): Reply {
    return ok({
      data: {
        app_id: "123456",
        type: "PAGE",
        application: "instagram-analyze",
        data_access_expires_at: Math.floor((now.getTime() + 60 * DAY_MS + HOUR_MS) / 1000),
        expires_at: 0,
        is_valid: true,
        issued_at: Math.floor(now.getTime() / 1000) - 60,
        profile_id: "000000000000099",
        scopes: [...ALL_SCOPES, "pages_show_list"],
        user_id: "000000000000098",
        ...overrides,
      },
    });
  }

  async function runsFor(): Promise<JobRunRow[]> {
    return [...(await db<JobRunRow[]>`select * from public.job_runs where account_id = ${account.id} and job_name = 'token_check' order by id`)];
  }

  async function rawCount(): Promise<number> {
    const [row] = await db<{ n: number }[]>`select count(*)::int as n from public.raw_api_responses where account_id = ${account.id}`;
    return row?.n ?? -1;
  }

  async function credentialRow(): Promise<CredentialRow | undefined> {
    return (await db<CredentialRow[]>`select * from private.credentials where account_id = ${account.id}`)[0];
  }

  function logText(): string {
    return lines.join("\n");
  }

  async function runCheck(): Promise<{ outcome: string; jobRun: JobRunRow | undefined; credential: CredentialRow | undefined }> {
    const rawBefore = await rawCount();
    const outcome = await runJob(tokenCheckJob, deps, account, {}, "1/1");
    // debug_token は persist: false なので生レスポンスは増えない
    expect(await rawCount()).toBe(rawBefore);
    // トークンの値は Vault から読んで input_token に、アプリトークンは Bearer に。URL に access_token は載らない
    for (const call of calls) {
      expect(call.url.pathname).toBe("/v25.0/debug_token");
      expect(call.url.searchParams.get("input_token")).toBe(FAKE_TOKEN);
      expect(call.url.searchParams.has("access_token")).toBe(false);
      expect(call.authorization).toBe(`Bearer 123456|${FAKE_APP_SECRET}`);
    }
    const text = logText();
    expect(text).not.toContain(FAKE_TOKEN);
    expect(text).not.toContain(FAKE_APP_SECRET);
    expect(text).not.toContain(account.ig_user_id);
    expect(text).not.toContain(account.id);
    expect(text).not.toContain("://");
    return { outcome, jobRun: (await runsFor()).at(-1), credential: await credentialRow() };
  }

  beforeAll(async () => {
    db = connectDb(url);
    account = await db.begin((tx) => upsertAccount(tx, { ig_user_id: fakeIgUserId(), username: "fake_token_check" }));
    await db.begin((tx) => upsertCredential(tx, account.id, FAKE_TOKEN, INITIAL));

    const secrets = new SecretRegistry();
    secrets.add(config.metaAppSecret);
    secrets.add(config.supabaseServiceRoleKey);
    secrets.addUrlParts(config.databaseUrl);
    secrets.addUrlParts(config.supabaseUrl);
    const log = createLogger("debug", secrets, (line) => lines.push(line));
    deps = { db, config, log, secrets, fetchImpl, sleep: async () => {}, now: () => now };
  });

  beforeEach(async () => {
    replies.length = 0;
    calls.length = 0;
    lines.length = 0;
    await updateCredentialStatus(db, account.id, { ...INITIAL, last_error: null, last_checked_at: new Date("2026-09-01T00:00:00Z") });
  });

  afterAll(async () => {
    await db`delete from public.accounts where id = ${account.id}`;
    await closeDb(db);
  });

  it("transient（ネットワーク失敗 3 回）: private.credentials を触らず failed。error はマスク済みの文言、WARN 行に class=transient、api_calls は 3", async () => {
    const network: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const before = await credentialRow();
    const rawBefore = await rawCount();
    const outcome = await runJob(tokenCheckJob, { ...deps, fetchImpl: network }, account, {}, "1/1");
    expect(outcome).toBe("failed");
    expect(await rawCount()).toBe(rawBefore);

    const jobRun = (await runsFor()).at(-1);
    expect(jobRun?.status).toBe("failed");
    expect(jobRun?.items_fetched).toBe(0);
    expect(jobRun?.api_calls).toBe(3);
    expect(jobRun?.error).toBe("ネットワークエラー");

    const after = await credentialRow();
    expect(after).toEqual(before);
    expect(after?.status).toBe("valid");
    expect(after?.last_checked_at).toEqual(new Date("2026-09-01T00:00:00Z"));
    expect(logText()).toMatch(/WARN {2}job=token_check account=1\/1 status=failed items=0 calls=3 failures=1 duration_ms=\d+ rate=\d+% error_code=none class=transient$/m);
    expect(logText()).toMatch(/DEBUG job=token_check account=1\/1 error=ネットワークエラー$/m);
    expect(logText()).not.toContain(FAKE_TOKEN);
  });

  it("fatal（アプリシークレットの誤りなど。debug_token の 190 は auth にせず fatal）: status=error、last_error にコード、last_checked_at。failed", async () => {
    replies.push(graphError({ message: `Invalid appsecret https://graph.facebook.com/x?access_token=${FAKE_TOKEN}`, type: "OAuthException", code: 190 }));
    const { outcome, jobRun, credential } = await runCheck();
    expect(outcome).toBe("failed");
    expect(calls).toHaveLength(1);
    expect(jobRun?.status).toBe("failed");
    expect(jobRun?.items_fetched).toBe(0);
    expect(jobRun?.api_calls).toBe(1);
    // job_runs.error はマスク済みの API の文言（URL は <url>、トークンは残らない）。固定文言は private.credentials.last_error に入る
    expect(jobRun?.error).toBe("Invalid appsecret <url>");

    expect(credential?.status).toBe("error");
    expect(credential?.last_error).toBe("debug_token に失敗（コード 190）");
    expect(credential?.last_checked_at).toEqual(now);
    // 期限と権限は触らない
    expect(credential?.scopes).toEqual(INITIAL.scopes);
    expect(credential?.data_access_expires_at).toEqual(INITIAL.data_access_expires_at);
    expect(credential?.expires_at).toBeNull();
    // トークンは変わらない
    expect((await readCredential(db, account.id))?.token).toBe(FAKE_TOKEN);
    expect(logText()).toMatch(/WARN {2}job=token_check account=1\/1 status=failed items=0 calls=1 failures=1 duration_ms=\d+ rate=\d+% error_code=190 class=fatal$/m);
    expect(logText()).toMatch(/DEBUG job=token_check account=1\/1 error="Invalid appsecret <url>"$/m);
  });

  it("is_valid: false: status=expired、固定文言、期限、last_checked_at。ジョブは success で warn の行", async () => {
    const dataAccess = Math.floor(new Date("2026-12-29T00:00:00Z").getTime() / 1000);
    replies.push(debugTokenOk({ is_valid: false, data_access_expires_at: dataAccess, error: { code: 190, message: "Error validating access token" } }));
    const { outcome, jobRun, credential } = await runCheck();
    expect(outcome).toBe("success");
    expect(jobRun?.status).toBe("success");
    expect(jobRun?.items_fetched).toBe(1);
    expect(jobRun?.api_calls).toBe(1);
    expect(jobRun?.error).toBeNull();

    expect(credential?.status).toBe("expired");
    expect(credential?.last_error).toBe(INVALID_TOKEN_ERROR);
    expect(credential?.last_checked_at).toEqual(now);
    expect(credential?.expires_at).toBeNull();
    expect(credential?.data_access_expires_at).toEqual(new Date(dataAccess * 1000));
    expect(credential?.scopes).toEqual(INITIAL.scopes);
    expect(logText()).toMatch(/WARN {2}job=token_check credential_status=expired( data_access_days_left=-?\d+)?$/m);
    expect(logText()).toMatch(/INFO {2}job=token_check account=1\/1 status=success items=1 calls=1 failures=0/m);
  });

  it("data がない応答も expired として扱う", async () => {
    replies.push(ok({}));
    const { outcome, credential } = await runCheck();
    expect(outcome).toBe("success");
    expect(credential?.status).toBe("expired");
    expect(credential?.last_error).toBe(INVALID_TOKEN_ERROR);
    expect(credential?.data_access_expires_at).toBeNull();
    expect(credential?.last_checked_at).toEqual(now);
  });

  it("権限が足りない: status=insufficient_scope、scopes、期限、last_checked_at、last_error に足りない権限。success で warn の行", async () => {
    replies.push(debugTokenOk({ scopes: ["instagram_basic", "instagram_manage_insights"] }));
    const { outcome, jobRun, credential } = await runCheck();
    expect(outcome).toBe("success");
    expect(jobRun?.status).toBe("success");
    expect(jobRun?.items_fetched).toBe(1);

    expect(credential?.status).toBe("insufficient_scope");
    expect(credential?.scopes).toEqual(["instagram_basic", "instagram_manage_insights"]);
    expect(credential?.last_error).toBe("権限が足りない（pages_read_engagement）");
    expect(credential?.last_checked_at).toEqual(now);
    expect(credential?.expires_at).toBeNull();
    expect(credential?.data_access_expires_at).toEqual(new Date(Math.floor((now.getTime() + 60 * DAY_MS + HOUR_MS) / 1000) * 1000));
    expect(logText()).toMatch(/WARN {2}job=token_check credential_status=insufficient_scope missing_scopes=pages_read_engagement data_access_days_left=60$/m);
  });

  it("有効で権限がそろう: status=valid、scopes、期限、last_checked_at、last_error=null。success で info の行に残り日数", async () => {
    // 前の状態が expired でも valid に戻る（設計 4.3 章）
    await updateCredentialStatus(db, account.id, { status: "expired", last_error: "トークンが無効（コード 190）", scopes: [] });
    const expires = Math.floor((now.getTime() + 30 * DAY_MS) / 1000);
    replies.push(debugTokenOk({ expires_at: expires }));
    const { outcome, jobRun, credential } = await runCheck();
    expect(outcome).toBe("success");
    expect(jobRun?.status).toBe("success");
    expect(jobRun?.items_fetched).toBe(1);
    expect(jobRun?.api_calls).toBe(1);

    expect(credential?.status).toBe("valid");
    expect(credential?.last_error).toBeNull();
    expect(credential?.last_checked_at).toEqual(now);
    expect(credential?.scopes).toEqual([...ALL_SCOPES, "pages_show_list"]);
    expect(credential?.expires_at).toEqual(new Date(expires * 1000));
    expect(credential?.data_access_expires_at).toEqual(new Date(Math.floor((now.getTime() + 60 * DAY_MS + HOUR_MS) / 1000) * 1000));
    expect(credential?.token_type).toBe("PAGE");
    expect(logText()).toMatch(/INFO {2}job=token_check credential_status=valid data_access_days_left=60$/m);
    expect(logText()).toMatch(/INFO {2}job=token_check account=1\/1 status=success items=1 calls=1 failures=0/m);
    expect(logText()).not.toContain("WARN");
  });

  it("有効でも残りが 14 日以下なら warn の行。期限が分からなければ日数なしの info", async () => {
    replies.push(debugTokenOk({ data_access_expires_at: Math.floor((now.getTime() + 14 * DAY_MS + HOUR_MS) / 1000) }));
    let result = await runCheck();
    expect(result.outcome).toBe("success");
    expect(result.credential?.status).toBe("valid");
    expect(logText()).toMatch(/WARN {2}job=token_check credential_status=valid data_access_days_left=14 hint=/m);

    lines.length = 0;
    calls.length = 0;
    replies.push(debugTokenOk({ data_access_expires_at: Math.floor((now.getTime() + 15 * DAY_MS) / 1000) }));
    result = await runCheck();
    expect(logText()).toMatch(/INFO {2}job=token_check credential_status=valid data_access_days_left=15$/m);
    expect(logText()).not.toContain("WARN");

    lines.length = 0;
    calls.length = 0;
    replies.push(debugTokenOk({ data_access_expires_at: undefined }));
    result = await runCheck();
    expect(result.credential?.status).toBe("valid");
    expect(result.credential?.data_access_expires_at).toBeNull();
    expect(logText()).toMatch(/INFO {2}job=token_check credential_status=valid$/m);
  });

  it("レート制限（コード 4）はジョブを止めて skipped。private.credentials は触らない", async () => {
    replies.push(graphError({ message: "Application request limit reached", code: 4 }));
    const before = await credentialRow();
    const { outcome, jobRun, credential } = await runCheck();
    expect(outcome).toBe("skipped");
    expect(jobRun?.status).toBe("skipped");
    expect(jobRun?.error).toBe("レート制限のエラー（コード 4）");
    expect(credential).toEqual(before);
  });
});
