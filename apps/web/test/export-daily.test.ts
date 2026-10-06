/**
 * 日次の CSV（`GET /export/daily`）の Route Handler のテスト（R3 設計 7 章）。node 環境で `NextRequest` を作って呼ぶ。
 * `checkAccess` は差し替える（既定は pass）。環境変数は `vi.stubEnv` で与える。
 * 末尾の結合テストは `TEST_DATABASE_URL` があるときだけ動き、架空のアカウントを作って `afterAll` で消す。
 */
import { NextRequest } from "next/server";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../src/app/export/daily/route";
import { checkAccess } from "../src/lib/auth";
import { closeAllDb } from "../src/lib/db";
import { getTargetAccount } from "../src/lib/queries/account";
import { fakeIgUserId } from "./db/fixtures";

vi.mock("../src/lib/auth", () => ({ checkAccess: vi.fn(async () => "pass") }));
// getTargetAccount は既定で本物を呼び、テストごとに一度だけ結果を差し替える
vi.mock("../src/lib/queries/account", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/queries/account")>();
  return { ...actual, getTargetAccount: vi.fn(actual.getTargetAccount) };
});
// mockQueryError.current があれば、dbFromEnv が返す db の呼び出しがその例外を投げる（listDailyCsvRows の catch を通す）。
// なければ本物（末尾の結合テストはこちら）
const mockQueryError = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("../src/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/db")>();
  return {
    ...actual,
    dbFromEnv: (...args: Parameters<typeof actual.dbFromEnv>) => {
      if (mockQueryError.current === undefined) return actual.dbFromEnv(...args);
      const err = mockQueryError.current;
      return (() => {
        throw err;
      }) as unknown as ReturnType<typeof actual.dbFromEnv>;
    },
  };
});

const APP_URL = "http://localhost:3000";
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const BASE_ENV: Record<string, string | undefined> = {
  // 届かない宛先（DB に繋がる前に返る場合だけで使う）
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:1/postgres",
  META_APP_ID: "123456",
  META_APP_SECRET: "FAKE_EXPORT_APP_SECRET",
  META_GRAPH_API_VERSION: "v25.0",
  APP_URL,
  META_TARGET_IG_USER_ID: undefined,
};

function stubEnv(overrides: Record<string, string | undefined> = {}): void {
  for (const [name, value] of Object.entries({ ...BASE_ENV, ...overrides })) vi.stubEnv(name, value);
}

function request(query = ""): NextRequest {
  return new NextRequest(`${APP_URL}/export/daily${query}`, { method: "GET" });
}

const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

beforeEach(() => {
  stubEnv();
  warn.mockClear();
  mockQueryError.current = undefined;
  vi.mocked(checkAccess).mockReset();
  vi.mocked(checkAccess).mockResolvedValue("pass");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /export/daily（DB を使わない）", () => {
  it("未ログインは 401、許可外は 403。`checkAccess` にパスを渡す", async () => {
    vi.mocked(checkAccess).mockResolvedValueOnce("login");
    const r1 = await GET(request());
    expect(r1.status).toBe(401);
    expect(vi.mocked(checkAccess)).toHaveBeenCalledWith("/export/daily");

    vi.mocked(checkAccess).mockResolvedValueOnce("forbid");
    const r2 = await GET(request());
    expect(r2.status).toBe(403);
    expect(r2.headers.get("cache-control")).toBe("private, no-store");
  });

  it.each([
    ["?from=2026-09-01", "片方だけ"],
    ["?to=2026-09-01", "片方だけ"],
    ["?from=2026-02-30&to=2026-03-01", "暦にない日"],
    ["?from=2026-09-30&to=2026-09-01", "開始 > 終了"],
    ["?from=2025-01-01&to=2026-01-02", "367 日"],
    ["?from=2026-09-01&from=2026-09-02&to=2026-09-30", "同じキーが 2 回"],
    ["?from=20260901&to=20260930", "形が違う"],
  ])("期間の指定が正しくなければ 400 と固定の文言（%s: %s）", async (query) => {
    const res = await GET(request(query));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("期間の指定が正しくありません");
  });

  it("対象のアカウントが設定されていなければ 409 と固定の文言", async () => {
    const res = await GET(request());
    expect(res.status).toBe(409);
    expect(await res.text()).toBe("対象のアカウントが設定されていません");
  });

  it.each([
    ["checkAccess", "checkAccess"],
    ["getTargetAccount", "getTargetAccount"],
  ])("%s が想定外に例外を投げても 500、固定の文言、private, no-store と nosniff（例外の文をログに出さない）", async (where) => {
    stubEnv({ META_TARGET_IG_USER_ID: "000000123456789" });
    const secret = "SECRET_EXCEPTION_TEXT";
    if (where === "checkAccess") {
      vi.mocked(checkAccess).mockRejectedValueOnce(new Error(secret));
    } else {
      vi.mocked(getTargetAccount).mockRejectedValueOnce(new Error(secret));
    }
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("CSV を作れませんでした");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toBe("[export-daily] result=db_error code=unknown");
    expect(logged).not.toContain(secret);
  });

  it.each([
    ["改行を含む code", { code: "42P01\ninjected=1" }, "unknown"],
    ["小文字や記号を含む code", { code: "bad-code" }, "unknown"],
    ["41 文字の code", { code: "A".repeat(41) }, "unknown"],
    ["数値の code", { code: 42 }, "unknown"],
    ["code なし", {}, "unknown"],
    ["SQLSTATE", { code: "42P01" }, "42P01"],
    ["Node.js のコード", { code: "ECONNREFUSED" }, "ECONNREFUSED"],
  ])("listDailyCsvRows の失敗のログ: %s → code=%s の形だけ", async (_label, props, expected) => {
    stubEnv({ META_TARGET_IG_USER_ID: "000000123456789" });
    vi.mocked(getTargetAccount).mockResolvedValueOnce({
      ok: true,
      data: { id: "00000000-0000-0000-0000-000000000000" },
    } as Awaited<ReturnType<typeof getTargetAccount>>);
    mockQueryError.current = Object.assign(new Error("relation does not exist SECRET_DB_TEXT"), props);
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("CSV を作れませんでした");
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toBe(`[export-daily] result=db_error code=${expected}`);
    expect(logged).not.toContain("\n");
    expect(logged).not.toContain("SECRET_DB_TEXT");
  });

  it("DB に繋がらなければ 500 と固定の文言。ログに DB のエラー文や接続文字列を書かない", async () => {
    stubEnv({ META_TARGET_IG_USER_ID: "000000123456789" });
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("CSV を作れませんでした");
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toMatch(/^\[export-daily\] /);
    expect(logged).not.toContain("postgresql://");
    expect(logged).not.toContain("000000123456789");
    await closeAllDb();
  });
});

describe.skipIf(!TEST_DATABASE_URL)("GET /export/daily（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  const igUserId = fakeIgUserId();
  let sql: postgres.Sql;
  let accountId = "";

  beforeAll(async () => {
    sql = postgres(url, { max: 1, onnotice: () => {} });
    const [acc] = await sql<{ id: string }[]>`
      insert into public.accounts (ig_user_id, username) values (${igUserId}, 'fake_export_daily') returning id
    `;
    accountId = acc?.id ?? "";
    const rows = [
      ["2026-08-01", "reach", "", "", 100],
      ["2026-08-01", "reach", "follow_type", "", 100],
      ["2026-08-01", "reach", "follow_type", "NON_FOLLOWER", 100],
      ["2026-08-01", "views", "", "", 10],
      ["2026-08-02", "reach", "", "", 200],
      ["2026-08-02", "follower_count", "", "", 3],
    ].map(([metric_date, metric, breakdown, breakdown_value, value]) => ({
      account_id: accountId,
      metric_date,
      metric,
      breakdown,
      breakdown_value,
      value,
    }));
    await sql`
      insert into public.account_daily_metrics (account_id, metric_date, metric, breakdown, breakdown_value, value, fetched_at)
      select r.*, '2026-08-03T00:00:00Z'::timestamptz
      from jsonb_to_recordset(${sql.json(rows as unknown as postgres.JSONValue)})
        as r(account_id uuid, metric_date date, metric text, breakdown text, breakdown_value text, value bigint)
    `;
    await sql`
      insert into public.profile_daily (account_id, captured_on, captured_at, followers_count)
      values (${accountId}, '2026-08-02', '2026-08-02T03:00:00Z', 1234)
    `;
  });

  afterAll(async () => {
    if (accountId !== "") await sql`delete from public.accounts where id = ${accountId}`;
    await closeAllDb();
    await sql.end({ timeout: 5 });
  });

  it("全期間の CSV: ヘッダー、BOM、CRLF、列の並び、値", async () => {
    stubEnv({ DATABASE_URL: url, META_TARGET_IG_USER_ID: igUserId });
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="instagram-daily-\d{8}\.csv"$/);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const body = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
    expect(body.startsWith("﻿")).toBe(true);
    const lines = body.slice(1).split("\r\n");
    expect(lines[0]).toBe(
      "metric_date_pt,reach,reach_follower,reach_non_follower,views,views_follower,views_non_follower," +
        "accounts_engaged,total_interactions,likes,comments,shares,saved,new_followers,followers_count_jst_day,fetched_at_jst",
    );
    expect(lines[1]).toBe("2026-08-01,100,0,100,10,,,,,,,,,,,2026-08-03 09:00:00");
    expect(lines[2]).toBe("2026-08-02,200,,,,,,,,,,,,3,1234,2026-08-03 09:00:00");
    expect(lines[3]).toBe("");
    expect(lines).toHaveLength(4);
  });

  it("期間を指定した CSV はその日だけ", async () => {
    stubEnv({ DATABASE_URL: url, META_TARGET_IG_USER_ID: igUserId });
    const res = await GET(request("?from=2026-08-02&to=2026-08-02"));
    expect(res.status).toBe(200);
    const lines = (await res.text()).replace(/^﻿/, "").split("\r\n");
    expect(lines.slice(1, -1).map((l) => l.split(",")[0])).toEqual(["2026-08-02"]);
  });
});
