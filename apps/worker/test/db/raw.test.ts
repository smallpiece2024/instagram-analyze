import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertAccount } from "../../src/db/accounts.js";
import { closeDb, connectDb, type Db } from "../../src/db/client.js";
import { finishJobRun, startJobRun } from "../../src/db/job-runs.js";
import { SECRET_PARAMS_ERROR, insertRawResponse } from "../../src/db/raw.js";
import type { RawApiResponseRow } from "../../src/db/types.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

function fakeIgUserId(): string {
  return "000000" + Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, "0");
}

describe.skipIf(!TEST_DATABASE_URL)("db/raw（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  let db: Db;
  let accountId: string;
  let jobRunId: string;

  async function readRaw(id: string): Promise<RawApiResponseRow | undefined> {
    const rows = await db<RawApiResponseRow[]>`select * from public.raw_api_responses where id = ${id}`;
    return rows[0];
  }

  beforeAll(async () => {
    db = connectDb(url);
    const account = await db.begin((tx) => upsertAccount(tx, { ig_user_id: fakeIgUserId() }));
    accountId = account.id;
    jobRunId = await startJobRun(db, "profile_daily", accountId);
  });

  afterAll(async () => {
    await finishJobRun(db, jobRunId, { status: "success", items_fetched: 0, api_calls: 0 });
    await db`delete from public.accounts where id = ${accountId}`;
    const [count] = await db<{ n: number }[]>`
      select count(*)::int as n from public.raw_api_responses where account_id = ${accountId}
    `;
    expect(count?.n).toBe(0);
    await closeDb(db);
  });

  it("insert して id が文字列で返り、params と body が jsonb として読み戻せる", async () => {
    const fetchedAt = new Date("2026-10-01T12:34:56.789Z");
    const params = { fields: "id,username", limit: 50, after: "QVFIU", nested: { a: [1, 2, null] } };
    const body = { data: [{ id: "1", caption: "テスト" }], paging: { cursors: { after: "QVFIU" }, next: "<omitted>" } };
    const id = await insertRawResponse(db, {
      account_id: accountId,
      job_run_id: jobRunId,
      endpoint: "000000000000000/media",
      params,
      api_version: "v25.0",
      fetched_at: fetchedAt,
      http_status: 200,
      body,
    });
    expect(typeof id).toBe("string");
    expect(id).toMatch(/^\d+$/);

    const row = await readRaw(id);
    expect(row?.account_id).toBe(accountId);
    expect(row?.job_run_id).toBe(jobRunId);
    expect(row?.endpoint).toBe("000000000000000/media");
    expect(row?.params).toEqual(params);
    expect(row?.body).toEqual(body);
    expect(row?.api_version).toBe("v25.0");
    expect(row?.fetched_at).toEqual(fetchedAt);
    expect(row?.http_status).toBe(200);
  });

  it("body: null と job_run_id: null も入る", async () => {
    const id = await insertRawResponse(db, {
      account_id: accountId,
      job_run_id: null,
      endpoint: "debug_token",
      params: {},
      api_version: "v25.0",
      fetched_at: new Date(),
      http_status: 0,
      body: null,
    });
    const row = await readRaw(id);
    expect(row?.job_run_id).toBeNull();
    expect(row?.body).toBeNull();
    expect(row?.params).toEqual({});
    expect(row?.http_status).toBe(0);
  });

  it("body: undefined は null として入る。エラーの本文もそのまま入る", async () => {
    const errorBody = { error: { message: "Invalid parameter", type: "OAuthException", code: 100 } };
    const first = await insertRawResponse(db, {
      account_id: accountId,
      job_run_id: jobRunId,
      endpoint: "x/insights",
      params: { metric: "reach" },
      api_version: "v25.0",
      fetched_at: new Date(),
      http_status: 400,
      body: errorBody,
    });
    expect((await readRaw(first))?.body).toEqual(errorBody);

    const second = await insertRawResponse(db, {
      account_id: accountId,
      job_run_id: jobRunId,
      endpoint: "x/insights",
      params: { metric: "reach" },
      api_version: "v25.0",
      fetched_at: new Date(),
      http_status: 500,
      body: undefined,
    });
    expect((await readRaw(second))?.body).toBeNull();
  });

  it("job_runs を消しても生レスポンスは残り、job_run_id が null になる", async () => {
    const runId = await startJobRun(db, "media_sync", accountId);
    await finishJobRun(db, runId, { status: "success", items_fetched: 0, api_calls: 1 });
    const id = await insertRawResponse(db, {
      account_id: accountId,
      job_run_id: runId,
      endpoint: "x/media",
      params: {},
      api_version: "v25.0",
      fetched_at: new Date(),
      http_status: 200,
      body: { data: [] },
    });
    await db`delete from public.job_runs where id = ${runId}`;
    const row = await readRaw(id);
    expect(row).toBeDefined();
    expect(row?.job_run_id).toBeNull();
  });

  it("params に秘密のキーがあれば固定文言で投げ、行を増やさない", async () => {
    async function countRows(): Promise<number | undefined> {
      const [row] = await db<{ n: number }[]>`
        select count(*)::int as n from public.raw_api_responses where account_id = ${accountId}
      `;
      return row?.n;
    }
    const before = await countRows();
    for (const key of ["access_token", "input_token", "appsecret_proof"]) {
      const attempt = insertRawResponse(db, {
        account_id: accountId,
        job_run_id: jobRunId,
        endpoint: "debug_token",
        params: { fields: "id", [key]: "SECRET_VALUE" },
        api_version: "v25.0",
        fetched_at: new Date(),
        http_status: 200,
        body: { data: {} },
      });
      await expect(attempt).rejects.toThrow(SECRET_PARAMS_ERROR);
      await expect(attempt).rejects.not.toThrow(/SECRET_VALUE/);
    }
    expect(await countRows()).toBe(before);
  });
});
