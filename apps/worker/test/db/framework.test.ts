/**
 * `jobs/framework.ts` の結合テスト（設計 9.2 章の「jobs/framework.ts」と「秘密の非混入」の行）。
 * 偽の `fetch` と本物の DB（ローカル Supabase）で、偽のジョブ定義を `runJob` で動かす。
 * 架空のアカウントを作り、終了時に消す（CASCADE で関連する行も消える）。
 * `runJobsForActiveAccounts` は実アカウントの行に触らないよう、`deps.listAccounts` で対象を架空アカウントに固定する。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WorkerConfig } from "../../src/config.js";
import {
  readCredential,
  updateCredentialStatus,
  upsertAccount,
  upsertCredential,
  vaultSecretName,
  type CredentialInfo,
} from "../../src/db/accounts.js";
import { closeDb, connectDb, jsonb, type Db } from "../../src/db/client.js";
import { tryLock, unlock } from "../../src/db/job-runs.js";
import type { AccountRow, CredentialRow, JobName, JobRunRow, RawApiResponseRow } from "../../src/db/types.js";
import {
  LOCKED_ERROR,
  NO_CREDENTIAL_ERROR,
  runJob,
  runJobsForActiveAccounts,
  type JobDefinition,
  type JobDeps,
} from "../../src/jobs/framework.js";
import { DownloadError } from "../../src/lib/download.js";
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

function ok(body: unknown, headers: Record<string, string> = {}): Reply {
  return () => jsonResponse(body, { headers: { "content-type": "application/json", ...headers } });
}

function graphError(error: GraphError, status = 400): Reply {
  return () => jsonResponse({ error }, { status });
}

const FAKE_TOKEN = `FAKE_VAULT_TOKEN_${Math.floor(Math.random() * 1_000_000_000)}`;
const SIGNED_URL = "https://scontent-nrt1-1.cdninstagram.com/v/t51/a.jpg?_nc_ht=x&oe=68F0A1B2&oh=abc";
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const CREDENTIAL: CredentialInfo = {
  token_type: "PAGE",
  expires_at: null,
  data_access_expires_at: new Date("2026-12-29T00:00:00Z"),
  scopes: ["instagram_basic", "instagram_manage_insights", "pages_read_engagement"],
  status: "valid",
};

const TIMESTAMP = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z`;

describe.skipIf(!TEST_DATABASE_URL)("jobs/framework（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  let db: Db;
  let account: AccountRow;
  let deps: JobDeps;
  const createdAccountIds: string[] = [];
  const replies: Reply[] = [];
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

  const fetchImpl: typeof fetch = async () => {
    const reply = replies.shift();
    if (!reply) return jsonResponse({ error: { message: "応答の用意がない", code: 999_999 } }, { status: 400 });
    return reply();
  };

  async function runsFor(jobName: JobName, accountId = account.id): Promise<JobRunRow[]> {
    return [
      ...(await db<JobRunRow[]>`
        select * from public.job_runs where account_id = ${accountId} and job_name = ${jobName} order by id
      `),
    ];
  }

  async function rawFor(jobRunId: string): Promise<RawApiResponseRow[]> {
    return [...(await db<RawApiResponseRow[]>`select * from public.raw_api_responses where job_run_id = ${jobRunId} order by id`)];
  }

  async function credentialRow(accountId: string): Promise<CredentialRow | undefined> {
    return (await db<CredentialRow[]>`select * from private.credentials where account_id = ${accountId}`)[0];
  }

  function job(name: JobName, run: JobDefinition["run"], extra: Partial<JobDefinition> = {}): JobDefinition {
    return { name, run, ...extra };
  }

  function logText(): string {
    return lines.join("\n");
  }

  beforeAll(async () => {
    db = connectDb(url);
    account = await db.begin((tx) => upsertAccount(tx, { ig_user_id: fakeIgUserId(), username: "fake_user" }));
    createdAccountIds.push(account.id);
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
    lines.length = 0;
  });

  afterAll(async () => {
    for (const id of createdAccountIds) {
      await db`delete from public.accounts where id = ${id}`;
      const [vault] = await db<{ n: number }[]>`select count(*)::int as n from vault.secrets where name = ${vaultSecretName(id)}`;
      expect(vault?.n).toBe(0);
      const [runs] = await db<{ n: number }[]>`select count(*)::int as n from public.job_runs where account_id = ${id}`;
      expect(runs?.n).toBe(0);
    }
    await closeDb(db);
  });

  it("生レスポンスは項目のトランザクションが失敗しても残る。recordFailure で partial になり、最後の失敗が error とログに残る。終了後にロックは外れている", async () => {
    replies.push(ok({ id: "1" }, { "x-app-usage": JSON.stringify({ call_count: 2, total_cputime: 1, total_time: 1 }) }));
    replies.push(ok({ id: "2" }));
    const rawIds: (string | undefined)[] = [];
    let seenRunId = "";
    let startedAt: Date | undefined;
    let ctxJson = "";
    let maskedToken = "";
    let failuresSeen = -1;

    const outcome = await runJob(
      job("profile_daily", async (ctx) => {
        seenRunId = ctx.jobRunId;
        startedAt = ctx.startedAt;
        // トークンは JobContext に乗らない（構造的に固定する）
        ctxJson = JSON.stringify(ctx);
        maskedToken = ctx.mask(`token=${FAKE_TOKEN}`);
        const first = await ctx.graph.get<{ id: string }>("me", { fields: "id" });
        rawIds.push(first.rawResponseId);
        await ctx.db.begin(async (tx) => {
          await tx`select 1`;
        });
        ctx.progress.items += 1;

        const second = await ctx.graph.get<{ id: string }>("me", { fields: "id" });
        rawIds.push(second.rawResponseId);
        try {
          await ctx.db.begin(async (tx) => {
            await tx`select 1`;
            throw new Error("項目の書き込みに失敗");
          });
        } catch {
          ctx.recordFailure({ code: "23505", errorClass: "db", message: `項目の書き込みに失敗 token=${FAKE_TOKEN}` });
        }
        failuresSeen = ctx.progress.failures;
      }),
      deps,
      account,
    );
    expect(outcome).toBe("partial");
    expect(startedAt).toBeInstanceOf(Date);
    expect(ctxJson).not.toContain(FAKE_TOKEN);
    expect(maskedToken).toBe("token=***");
    expect(failuresSeen).toBe(1);

    const run = (await runsFor("profile_daily")).find((r) => r.id === seenRunId);
    expect(run?.status).toBe("partial");
    expect(run?.items_fetched).toBe(1);
    expect(run?.api_calls).toBe(2);
    expect(run?.error).toBe("項目の書き込みに失敗 token=***");
    expect(run?.finished_at).toBeInstanceOf(Date);
    expect(run?.rate_usage).toEqual({ call_count: 2, total_cputime: 1, total_time: 1 });

    const raw = await rawFor(seenRunId);
    expect(raw.map((r) => r.id)).toEqual(rawIds);
    expect(raw.map((r) => r.body)).toEqual([{ id: "1" }, { id: "2" }]);
    expect(raw[0]?.account_id).toBe(account.id);
    expect(raw[0]?.endpoint).toBe("me");
    expect(raw[0]?.params).toEqual({ fields: "id" });
    expect(raw[0]?.api_version).toBe("v25.0");

    // ロックは外れている（別の接続で取れる）
    const other = connectDb(url);
    const conn = await other.reserve();
    try {
      expect(await tryLock(conn, "profile_daily", account.id)).toBe(true);
      await unlock(conn, "profile_daily", account.id);
    } finally {
      conn.release();
      await closeDb(other);
    }

    expect(logText()).toMatch(
      new RegExp(`^${TIMESTAMP} WARN  job=profile_daily status=partial items=1 calls=2 failures=1 duration_ms=\\d+ rate=2% error_code=23505 class=db$`, "m"),
    );
    expect(logText()).toMatch(new RegExp(`^${TIMESTAMP} DEBUG job=profile_daily error="項目の書き込みに失敗 token=\\*\\*\\*"$`, "m"));
    expect(logText()).not.toContain(FAKE_TOKEN);
  });

  it("成功行は INFO 1 行（job、status、items、calls、failures、duration_ms、rate）。account= は runJobsForActiveAccounts の連番", async () => {
    replies.push(ok({ id: "1" }, { "x-app-usage": JSON.stringify({ call_count: 3, total_cputime: 1, total_time: 1 }) }));
    const outcome = await runJob(
      job("profile_daily", async (ctx) => {
        await ctx.graph.get("me", { fields: "id" });
        ctx.progress.items += 1;
      }),
      deps,
      account,
      {},
      "1/1",
    );
    expect(outcome).toBe("success");
    expect(logText()).toMatch(
      new RegExp(`^${TIMESTAMP} INFO  job=profile_daily account=1/1 status=success items=1 calls=1 failures=0 duration_ms=\\d+ rate=3%$`, "m"),
    );
    expect(logText()).not.toContain(account.id.slice(0, 8));
    expect(logText()).not.toContain("WARN");
  });

  it("RateLimitExceeded: 何も書く前なら skipped、1 件以上書けていれば partial。error に固定文言", async () => {
    replies.push(graphError({ message: "Application request limit reached", code: 4 }));
    const skipped = await runJob(
      job("account_daily", async (ctx) => {
        await ctx.graph.get("x/insights", { metric: "reach" });
        ctx.progress.items += 1;
      }),
      deps,
      account,
    );
    expect(skipped).toBe("skipped");
    let runs = await runsFor("account_daily");
    expect(runs.at(-1)?.status).toBe("skipped");
    expect(runs.at(-1)?.error).toBe("レート制限のエラー（コード 4）");
    expect(runs.at(-1)?.items_fetched).toBe(0);
    expect(runs.at(-1)?.api_calls).toBe(1);
    expect(logText()).toMatch(/WARN {2}job=account_daily status=skipped .* error_code=none class=rate$/m);

    replies.push(ok({ data: [] }));
    replies.push(graphError({ message: "limit", code: 4 }));
    const partial = await runJob(
      job("account_daily", async (ctx) => {
        await ctx.graph.get("x/insights", { metric: "reach" });
        ctx.progress.items += 1;
        await ctx.graph.get("x/insights", { metric: "views" });
        ctx.progress.items += 1;
      }),
      deps,
      account,
    );
    expect(partial).toBe("partial");
    runs = await runsFor("account_daily");
    expect(runs.at(-1)?.status).toBe("partial");
    expect(runs.at(-1)?.items_fetched).toBe(1);
    expect(runs.at(-1)?.api_calls).toBe(2);
    expect(runs.at(-1)?.error).toBe("レート制限のエラー（コード 4）");
  });

  it("直近 1 時間の job_runs.rate_usage がしきい値以上なら API を呼ばずに skipped になり、観測していない値は rate_usage に書き戻さない。1 時間より前の行は引き継がない", async () => {
    // 他のテストファイルが並列に書く job_runs（finished_at は最大で数時間先）に影響されないよう、時計を 10 時間先にずらす
    const base = Date.now() + 10 * HOUR_MS;
    const shiftedDeps: JobDeps = { ...deps, now: () => new Date(base) };
    const [seed] = await db<{ id: string }[]>`
      insert into public.job_runs (job_name, account_id, status, started_at, finished_at, items_fetched, api_calls, rate_usage)
      values ('media_sync', ${account.id}, 'success', ${new Date(base - 55 * MINUTE_MS)}, ${new Date(base - 50 * MINUTE_MS)}, 1, 5,
              ${jsonb(db, { call_count: 95, total_cputime: 1, total_time: 1, estimated_time_to_regain_access: 0 })})
      returning id
    `;
    const seedId = seed?.id ?? "";

    try {
      replies.push(ok({ data: [] }));
      const skipped = await runJob(
        job("media_sync", async (ctx) => {
          await ctx.graph.get("x/media", { fields: "id" });
          ctx.progress.items += 1;
        }),
        shiftedDeps,
        account,
      );
      expect(skipped).toBe("skipped");
      expect(replies).toHaveLength(1); // fetch は呼ばれていない
      let run = (await runsFor("media_sync")).at(-1);
      expect(run?.id).not.toBe(seedId);
      expect(run?.status).toBe("skipped");
      expect(run?.api_calls).toBe(0);
      expect(run?.rate_usage).toBeNull();
      expect(run?.error).toBe("レート制限の使用率がしきい値を超えた（使用率 95%、しきい値 90%）");
      expect(logText()).toMatch(/WARN {2}job=media_sync status=skipped items=0 calls=0 failures=0 duration_ms=\d+ rate=95% error_code=none class=rate$/m);

      // 70 分前なら引き継がない（since = 開始時刻 − 1 時間）
      await db`update public.job_runs set finished_at = ${new Date(base - 70 * MINUTE_MS)} where id = ${seedId}`;
      const ran = await runJob(
        job("media_sync", async (ctx) => {
          await ctx.graph.get("x/media", { fields: "id" });
          ctx.progress.items += 1;
        }),
        shiftedDeps,
        account,
      );
      expect(ran).toBe("success");
      expect(replies).toHaveLength(0);
      run = (await runsFor("media_sync")).at(-1);
      expect(run?.api_calls).toBe(1);
    } finally {
      // finished_at が未来の仕込みの行を残すと、後続のテスト（実時刻）が 95% を引き継いでしまう
      await db`delete from public.job_runs where id = ${seedId}`;
    }
  });

  it("コード 190 で private.credentials.status = expired、last_error、last_checked_at が入り、ジョブは failed。WARN の形式を固定", async () => {
    replies.push(graphError({ message: "Invalid OAuth access token - Cannot parse access token", code: 190, error_subcode: 463 }));
    const outcome = await runJob(
      job("stories", async (ctx) => {
        ctx.progress.items += 5;
        await ctx.graph.get("x/stories", { fields: "id" });
        ctx.progress.items += 1;
      }),
      deps,
      account,
    );
    expect(outcome).toBe("failed");

    const run = (await runsFor("stories")).at(-1);
    expect(run?.status).toBe("failed");
    expect(run?.error).toBe("トークンが無効（コード 190）");
    expect(run?.items_fetched).toBe(5);
    expect(run?.api_calls).toBe(1);

    const credential = await credentialRow(account.id);
    expect(credential?.status).toBe("expired");
    expect(credential?.last_error).toBe("トークンが無効（コード 190）");
    expect(credential?.last_checked_at).toBeInstanceOf(Date);
    expect(logText()).toMatch(
      new RegExp(`^${TIMESTAMP} WARN  job=stories status=failed items=5 calls=1 failures=0 duration_ms=\\d+ rate=\\d+% error_code=190 class=auth$`, "m"),
    );
    expect(logText()).toMatch(new RegExp(`^${TIMESTAMP} DEBUG job=stories error="トークンが無効（コード 190）"$`, "m"));

    // 権限不足は insufficient_scope
    await updateCredentialStatus(db, account.id, { status: "valid", last_error: null });
    replies.push(graphError({ message: "(#10) Permission denied", code: 10 }, 403));
    expect(await runJob(job("stories", async (ctx) => void (await ctx.graph.get("x/stories"))), deps, account)).toBe("failed");
    expect((await credentialRow(account.id))?.status).toBe("insufficient_scope");
    expect((await credentialRow(account.id))?.last_error).toBe("権限が足りない（コード 10）");
    await updateCredentialStatus(db, account.id, { status: "valid", last_error: null });
    // トークンは変わらない
    expect((await readCredential(db, account.id))?.token).toBe(FAKE_TOKEN);
  });

  it("persist: false なら raw_api_responses に行がない", async () => {
    replies.push(ok({ data: { is_valid: true } }));
    let seenRunId = "";
    let rawId: string | undefined = "x";
    const outcome = await runJob(
      job("token_check", async (ctx) => {
        seenRunId = ctx.jobRunId;
        const res = await ctx.graph.get("debug_token", { input_token: "SHOULD_NOT_BE_SENT_TO_DB" }, { persist: false });
        rawId = res.rawResponseId;
        ctx.progress.items += 1;
      }),
      deps,
      account,
    );
    expect(outcome).toBe("success");
    expect(rawId).toBeUndefined();
    expect(await rawFor(seenRunId)).toEqual([]);
    const run = (await runsFor("token_check")).find((r) => r.id === seenRunId);
    expect(run?.status).toBe("success");
    expect(run?.api_calls).toBe(1);
  });

  it("別の接続がロックを持っていれば、run を呼ばずに skipped の行を書く", async () => {
    const other = connectDb(url);
    const conn = await other.reserve();
    let called = false;
    try {
      expect(await tryLock(conn, "media_sync", account.id)).toBe(true);
      const before = (await runsFor("media_sync")).length;
      const outcome = await runJob(
        job("media_sync", async () => {
          called = true;
        }),
        deps,
        account,
      );
      expect(outcome).toBe("skipped");
      expect(called).toBe(false);
      const runs = await runsFor("media_sync");
      expect(runs).toHaveLength(before + 1);
      expect(runs.at(-1)?.status).toBe("skipped");
      expect(runs.at(-1)?.error).toBe(LOCKED_ERROR);
      expect(runs.at(-1)?.finished_at).toBeInstanceOf(Date);
      // 持っていたロックは外れていない
      expect(await tryLock(conn, "media_sync", account.id)).toBe(true);
      await unlock(conn, "media_sync", account.id);
      expect(logText()).toMatch(/WARN {2}job=media_sync status=skipped items=0 calls=0 failures=0 error=同じジョブが実行中$/m);
    } finally {
      await unlock(conn, "media_sync", account.id);
      conn.release();
      await closeDb(other);
    }
  });

  it("shouldRun が false なら job_runs に行を作らず skipped を返す。true なら動く。shouldRun が投げたら failed で行なし", async () => {
    const before = (await runsFor("account_backfill")).length;
    let called = false;
    const outcome = await runJob(
      job(
        "account_backfill",
        async () => {
          called = true;
        },
        { shouldRun: async (ctx) => ctx.account.id !== account.id },
      ),
      deps,
      account,
    );
    expect(outcome).toBe("skipped");
    expect(called).toBe(false);
    expect(await runsFor("account_backfill")).toHaveLength(before);

    const threw = await runJob(
      job(
        "account_backfill",
        async () => {
          called = true;
        },
        {
          shouldRun: async () => {
            throw new Error("job_state が読めない");
          },
        },
      ),
      deps,
      account,
    );
    expect(threw).toBe("failed");
    expect(called).toBe(false);
    expect(await runsFor("account_backfill")).toHaveLength(before);
    expect(logText()).toMatch(/WARN {2}job=account_backfill status=failed items=0 calls=0 failures=0 duration_ms=\d+ error_code=none class=unknown$/m);
    expect(logText()).toMatch(/DEBUG job=account_backfill error="job_state が読めない"$/m);

    const ran = await runJob(
      job(
        "account_backfill",
        async (ctx) => {
          called = true;
          ctx.progress.items += 1;
        },
        { shouldRun: async () => true },
      ),
      deps,
      account,
    );
    expect(ran).toBe("success");
    expect(called).toBe(true);
    expect(await runsFor("account_backfill")).toHaveLength(before + 1);
  });

  it("取り残しの running を failed にしてから自分の行を作る", async () => {
    const [stale] = await db<{ id: string }[]>`
      insert into public.job_runs (job_name, account_id) values ('media_snapshot', ${account.id}) returning id
    `;
    expect(await runJob(job("media_snapshot", async () => {}), deps, account)).toBe("success");
    const [row] = await db<JobRunRow[]>`select * from public.job_runs where id = ${stale?.id ?? ""}`;
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("中断（プロセスが終了した）");
  });

  it("DownloadError で止まったら failed、class=download、error は固定文言", async () => {
    const outcome = await runJob(
      job("stories", async (ctx) => {
        ctx.progress.items += 1;
        throw new DownloadError("許可されていない URL");
      }),
      deps,
      account,
    );
    expect(outcome).toBe("failed");
    const run = (await runsFor("stories")).at(-1);
    expect(run?.status).toBe("failed");
    expect(run?.error).toBe("許可されていない URL");
    expect(logText()).toMatch(/WARN {2}job=stories status=failed items=1 calls=0 failures=0 duration_ms=\d+ rate=\d+% error_code=none class=download$/m);
  });

  it("秘密の非混入: raw_api_responses の params と body、job_runs.error、ログにトークン、access_token=、署名付き URL、10 桁以上の数字、://、内部 ID が残らない", async () => {
    replies.push(
      ok({
        data: [{ id: "17841400000000001", media_url: SIGNED_URL, thumbnail_url: SIGNED_URL, caption: "c" }],
        paging: {
          cursors: { before: "B", after: "A" },
          next: `https://graph.facebook.com/v25.0/x/media?access_token=${FAKE_TOKEN}&after=A`,
        },
      }),
    );
    replies.push(
      graphError({
        message: `Unsupported get request https://graph.facebook.com/x?access_token=${FAKE_TOKEN} Object with ID '17841400000000002' ${FAKE_TOKEN}`,
        type: "GraphMethodException",
        code: 100,
        error_subcode: 33,
      }),
    );
    let seenRunId = "";
    let returnedMessage = "";
    const outcome = await runJob(
      job("media_snapshot", async (ctx) => {
        seenRunId = ctx.jobRunId;
        const page = await ctx.graph.get("x/media", { fields: "id,media_url", access_token: "SHOULD_NOT_BE_STORED", limit: 50 });
        if (page.ok) ctx.progress.items += 1;
        const bad = await ctx.graph.get("x/insights", { metric: "reach" });
        returnedMessage = bad.error?.message ?? "";
        // ジョブが API の文をそのまま例外にしても、記録はマスクされる
        throw new Error(`取得に失敗: ${bad.error?.message ?? ""} token=${FAKE_TOKEN}`);
      }),
      deps,
      account,
    );
    expect(outcome).toBe("failed");
    // graph が返す error.message は出所でマスク済み
    expect(returnedMessage).toBe("Unsupported get request <url> Object with ID '***' ***");

    const run = (await runsFor("media_snapshot")).find((r) => r.id === seenRunId);
    expect(run?.status).toBe("failed");
    expect(run?.items_fetched).toBe(1);
    expect(run?.api_calls).toBe(2);
    const error = run?.error ?? "";
    expect(error).toBe("取得に失敗: Unsupported get request <url> Object with ID '***' *** token=***");
    expect(error).not.toContain(FAKE_TOKEN);
    expect(error).not.toContain("access_token=");
    expect(error).not.toContain("cdninstagram.com");
    expect(error).not.toContain("://");
    expect(error).not.toMatch(/\d{10,}/);

    const raw = await rawFor(seenRunId);
    expect(raw).toHaveLength(2);
    for (const row of raw) {
      const text = JSON.stringify(row.params) + JSON.stringify(row.body);
      expect(text).not.toContain(FAKE_TOKEN);
      expect(text).not.toContain("SHOULD_NOT_BE_STORED");
      expect(text).not.toContain("access_token=");
      expect(text).not.toContain("cdninstagram.com");
    }
    expect(raw[0]?.params).toEqual({ fields: "id,media_url", limit: 50 });
    expect(raw[0]?.body).toEqual({
      data: [{ id: "17841400000000001", media_url: "<omitted>", thumbnail_url: "<omitted>", caption: "c" }],
      paging: { cursors: { before: "B", after: "A" }, next: "<omitted>" },
    });
    expect(raw[1]?.http_status).toBe(400);
    expect((raw[1]?.body as { error: GraphError }).error.code).toBe(100);
    expect((raw[1]?.body as { error: GraphError }).error.message).not.toContain("://");

    const text = logText();
    expect(text).toContain("job=media_snapshot");
    expect(text).toContain("status=failed");
    expect(text).toContain("error_code=none");
    expect(text).toContain("class=unknown");
    expect(text).not.toContain(FAKE_TOKEN);
    expect(text).not.toContain("cdninstagram.com");
    expect(text).not.toContain("://");
    expect(text).not.toContain(account.id);
    expect(text).not.toContain(account.id.slice(0, 8));
    expect(text).not.toContain(account.ig_user_id);
  });

  it("認証情報がないアカウントは API を呼ばずに failed（認証情報がない）", async () => {
    const bare = await db.begin((tx) => upsertAccount(tx, { ig_user_id: fakeIgUserId() }));
    createdAccountIds.push(bare.id);
    let called = false;
    const outcome = await runJob(
      job("profile_daily", async () => {
        called = true;
      }),
      deps,
      bare,
    );
    expect(outcome).toBe("failed");
    expect(called).toBe(false);
    const run = (await runsFor("profile_daily", bare.id)).at(-1);
    expect(run?.status).toBe("failed");
    expect(run?.error).toBe(NO_CREDENTIAL_ERROR);
    expect(run?.api_calls).toBe(0);
    expect(logText()).toMatch(/WARN {2}job=profile_daily status=failed items=0 calls=0 failures=0 duration_ms=\d+ error_code=none class=auth$/m);
  });

  it("runJobsForActiveAccounts は対象のアカウントを順に回し、1 つでも failed なら false。account= は連番。0 件なら warn と true。一覧の失敗は false", async () => {
    const bare = createdAccountIds[1];
    expect(bare).toBeDefined();
    const [bareAccount] = await db<AccountRow[]>`select * from public.accounts where id = ${bare ?? ""}`;
    expect(bareAccount).toBeDefined();
    if (!bareAccount) return;

    replies.push(ok({ id: "1" }));
    const beforeOk = (await runsFor("token_check")).length;
    const beforeBare = (await runsFor("token_check", bareAccount.id)).length;
    const result = await runJobsForActiveAccounts(
      job("token_check", async (ctx) => {
        await ctx.graph.get("debug_token", {}, { persist: false });
        ctx.progress.items += 1;
      }),
      { ...deps, listAccounts: async () => [account, bareAccount] },
    );
    expect(result).toBe(false);
    expect(await runsFor("token_check")).toHaveLength(beforeOk + 1);
    expect((await runsFor("token_check")).at(-1)?.status).toBe("success");
    expect(await runsFor("token_check", bareAccount.id)).toHaveLength(beforeBare + 1);
    expect((await runsFor("token_check", bareAccount.id)).at(-1)?.status).toBe("failed");
    expect(logText()).toMatch(/INFO {2}job=token_check account=1\/2 status=success/m);
    expect(logText()).toMatch(/WARN {2}job=token_check account=2\/2 status=failed .* error_code=none class=auth$/m);

    lines.length = 0;
    expect(await runJobsForActiveAccounts(job("token_check", async () => {}), { ...deps, listAccounts: async () => [] })).toBe(true);
    expect(logText()).toMatch(/WARN {2}job=token_check status=skipped error="active なアカウントがない/m);

    lines.length = 0;
    expect(
      await runJobsForActiveAccounts(job("token_check", async () => {}), {
        ...deps,
        listAccounts: async () => {
          throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:54322"), { code: "ECONNREFUSED" });
        },
      }),
    ).toBe(false);
    expect(logText()).toMatch(/WARN {2}job=token_check status=failed error_code=ECONNREFUSED class=db$/m);
    expect(logText()).not.toContain("127.0.0.1");
  });

  it("runJobsForActiveAccounts は partial と skipped を失敗に数えず true（failed だけ false。設計 1.1 章）", async () => {
    // partial: 1 件書けて 1 件失敗
    replies.push(ok({ id: "1" }));
    const partial = await runJobsForActiveAccounts(
      job("media_sync", async (ctx) => {
        await ctx.graph.get("x/media", { fields: "id" });
        ctx.progress.items += 1;
        ctx.recordFailure({ errorClass: "fatal", code: 100, message: "1 件失敗" });
      }),
      { ...deps, listAccounts: async () => [account] },
    );
    expect(partial).toBe(true);
    expect((await runsFor("media_sync")).at(-1)?.status).toBe("partial");
    expect(logText()).toMatch(/WARN {2}job=media_sync account=1\/1 status=partial .* error_code=100 class=fatal$/m);

    // skipped: shouldRun が false
    expect(
      await runJobsForActiveAccounts(job("media_sync", async () => {}, { shouldRun: async () => false }), {
        ...deps,
        listAccounts: async () => [account],
      }),
    ).toBe(true);

    // failed: 予期しない例外
    expect(
      await runJobsForActiveAccounts(
        job("media_sync", async () => {
          throw new Error("予期しない例外");
        }),
        { ...deps, listAccounts: async () => [account] },
      ),
    ).toBe(false);
  });

  it("ジョブが Error でない値を投げても failed で記録される", async () => {
    const outcome = await runJob(
      job("profile_daily", async () => {
        throw "文字列の例外";
      }),
      deps,
      account,
    );
    expect(outcome).toBe("failed");
    expect((await runsFor("profile_daily")).at(-1)?.error).toBe("不明なエラー");
  });

  it("finishJobRun が失敗しても例外は外に出ず failed を返す（items_fetched の桁あふれで DB エラーにする）", async () => {
    const before = (await runsFor("token_check")).length;
    const outcome = await runJob(
      job("token_check", async (ctx) => {
        ctx.progress.items = 2 ** 40;
      }),
      deps,
      account,
    );
    expect(outcome).toBe("failed");
    expect(await runsFor("token_check")).toHaveLength(before + 1);
    // 記録に失敗した行は running のまま残る（次の実行で failRunningRuns が failed にする）
    expect((await runsFor("token_check")).at(-1)?.status).toBe("running");
    expect(logText()).toMatch(/WARN {2}job=token_check status=failed .* error_code=22003 class=db$/m);
    expect(logText()).toMatch(/DEBUG job=token_check error="DB エラー（SQLSTATE 22003）"$/m);

    expect(await runJob(job("token_check", async () => {}), deps, account)).toBe("success");
    expect((await runsFor("token_check")).at(-2)?.status).toBe("failed");
  });
});
