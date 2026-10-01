/**
 * `commands/register-token.ts` の結合テスト（設計 4.1 章）。偽の `fetch` と本物の DB（ローカル Supabase）で、
 * 架空の Instagram アカウント ID と偽のトークンを登録する。終了時に `accounts` を消す（CASCADE で Vault も消える）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerToken } from "../../src/commands/register-token.js";
import { readCredential, vaultSecretName } from "../../src/db/accounts.js";
import { closeDb, connectDb, type Db } from "../../src/db/client.js";
import type { AccountRow, CredentialRow } from "../../src/db/types.js";
import type { GraphError } from "../../src/lib/graph.js";

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

const FAKE_TOKEN = `FAKE_REGISTER_TOKEN_${Math.floor(Math.random() * 1_000_000_000)}`;
const FAKE_APP_SECRET = "FAKE_REGISTER_APP_SECRET";
const USERNAME = "fake_register_user";
const NAME = "Fake Register Name";
const FB_PAGE_ID = "000000000000099";
const ALL_SCOPES = ["instagram_basic", "instagram_manage_insights", "pages_read_engagement"];

describe.skipIf(!TEST_DATABASE_URL)("commands/register-token（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  const igUserId = fakeIgUserId();
  let db: Db;
  const replies: Reply[] = [];
  const calls: { url: URL; authorization: string | null }[] = [];
  const lines: string[] = [];
  let spy: ReturnType<typeof vi.spyOn> | undefined;

  const env: Record<string, string | undefined> = {
    META_ACCESS_TOKEN: FAKE_TOKEN,
    META_APP_ID: "123456",
    META_APP_SECRET: FAKE_APP_SECRET,
    IG_USER_ID: igUserId,
    DATABASE_URL: url,
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: "FAKE_REGISTER_SERVICE_ROLE_KEY",
    WORKER_LOG_LEVEL: "debug",
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
        data_access_expires_at: Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60,
        expires_at: 0,
        is_valid: true,
        issued_at: Math.floor(Date.now() / 1000) - 60,
        profile_id: FB_PAGE_ID,
        scopes: [...ALL_SCOPES, "pages_show_list"],
        user_id: "000000000000098",
        ...overrides,
      },
    });
  }

  function meOk(): Reply {
    return ok({ id: igUserId, username: USERNAME, name: NAME });
  }

  async function accountRow(): Promise<AccountRow | undefined> {
    return (await db<AccountRow[]>`select * from public.accounts where ig_user_id = ${igUserId}`)[0];
  }

  async function counts(): Promise<{ accounts: number; credentials: number; vault: number }> {
    const account = await accountRow();
    if (!account) return { accounts: 0, credentials: 0, vault: 0 };
    const [cred] = await db<{ n: number }[]>`select count(*)::int as n from private.credentials where account_id = ${account.id}`;
    const [vault] = await db<{ n: number }[]>`select count(*)::int as n from vault.secrets where name = ${vaultSecretName(account.id)}`;
    return { accounts: 1, credentials: cred?.n ?? -1, vault: vault?.n ?? -1 };
  }

  function run(): Promise<boolean> {
    return registerToken([], { env, fetchImpl });
  }

  function logText(): string {
    return lines.join("\n");
  }

  beforeAll(() => {
    db = connectDb(url);
    spy = vi.spyOn(console, "log").mockImplementation((...data: unknown[]) => {
      lines.push(data.map((d) => (typeof d === "string" ? d : "")).join(" "));
    });
  });

  beforeEach(() => {
    replies.length = 0;
    calls.length = 0;
    lines.length = 0;
  });

  afterAll(async () => {
    spy?.mockRestore();
    const account = await accountRow();
    await db`delete from public.accounts where ig_user_id = ${igUserId}`;
    if (account) {
      const [vault] = await db<{ n: number }[]>`select count(*)::int as n from vault.secrets where name = ${vaultSecretName(account.id)}`;
      expect(vault?.n).toBe(0);
    }
    await closeDb(db);
  });

  it("debug_token が失敗したら登録せず false", async () => {
    replies.push(graphError({ message: "Invalid appsecret", type: "OAuthException", code: 190 }));
    expect(await run()).toBe(false);
    expect(await counts()).toEqual({ accounts: 0, credentials: 0, vault: 0 });
    expect(calls).toHaveLength(1);
    expect(logText()).toMatch(/WARN {2}command=register-token status=failed error="debug_token に失敗" error_code=190$/m);
  });

  it("is_valid が false なら登録せず false", async () => {
    replies.push(debugTokenOk({ is_valid: false, error: { code: 190, message: "Error validating access token" } }));
    expect(await run()).toBe(false);
    expect(await counts()).toEqual({ accounts: 0, credentials: 0, vault: 0 });
    expect(calls).toHaveLength(1);
    // 値に空白がないので引用符は付かない
    expect(logText()).toMatch(/WARN {2}command=register-token status=failed error=トークンが無効（debug_token）$/m);
  });

  it("対応していない種類（APP）なら登録せず false", async () => {
    replies.push(debugTokenOk({ type: "APP" }));
    expect(await run()).toBe(false);
    expect(await counts()).toEqual({ accounts: 0, credentials: 0, vault: 0 });
  });

  it("アカウントに届かなければ登録せず false", async () => {
    replies.push(debugTokenOk());
    replies.push(graphError({ message: "Unsupported get request", type: "GraphMethodException", code: 100, error_subcode: 33 }));
    expect(await run()).toBe(false);
    expect(await counts()).toEqual({ accounts: 0, credentials: 0, vault: 0 });
    expect(calls).toHaveLength(2);
    expect(logText()).toMatch(/WARN {2}command=register-token status=failed error="Instagram アカウントに届かない.*" error_code=100$/m);
  });

  it("成功すると accounts、private.credentials、Vault に 1 行ずつ入る。2 回実行しても行数は増えず、トークンの差し替えだけが起きる", async () => {
    replies.push(debugTokenOk(), meOk());
    expect(await run()).toBe(true);
    expect(calls).toHaveLength(2);
    // debug_token はアプリトークンをヘッダで送り、input_token はクエリ。トークンは URL に載らない
    expect(calls[0]?.url.pathname).toBe("/v25.0/debug_token");
    expect(calls[0]?.authorization).toBe(`Bearer 123456|${FAKE_APP_SECRET}`);
    expect(calls[0]?.url.searchParams.get("input_token")).toBe(FAKE_TOKEN);
    expect(calls[1]?.url.pathname).toBe(`/v25.0/${igUserId}`);
    expect(calls[1]?.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(calls[1]?.url.searchParams.has("access_token")).toBe(false);

    const account = await accountRow();
    expect(account?.username).toBe(USERNAME);
    expect(account?.name).toBe(NAME);
    expect(account?.fb_page_id).toBe(FB_PAGE_ID);
    expect(account?.status).toBe("active");
    expect(await counts()).toEqual({ accounts: 1, credentials: 1, vault: 1 });

    const credential = await readCredential(db, account?.id ?? "");
    expect(credential?.token).toBe(FAKE_TOKEN);
    expect(credential?.info.token_type).toBe("PAGE");
    expect(credential?.info.status).toBe("valid");
    expect(credential?.info.expires_at).toBeNull();
    expect(credential?.info.data_access_expires_at).toBeInstanceOf(Date);
    expect(credential?.info.scopes).toEqual([...ALL_SCOPES, "pages_show_list"]);
    const [row] = await db<CredentialRow[]>`select * from private.credentials where account_id = ${account?.id ?? ""}`;
    expect(row?.last_checked_at).toBeInstanceOf(Date);
    expect(row?.last_error).toBeNull();

    const text = logText();
    expect(text).toMatch(
      /INFO {2}command=register-token status=registered token_type=PAGE expires=なし data_access_days_left=(89|90) scopes=\S+ credential_status=valid$/m,
    );
    expect(text).not.toContain("WARN");
    expect(text).not.toContain(FAKE_TOKEN);
    expect(text).not.toContain(FAKE_APP_SECRET);
    expect(text).not.toContain(igUserId);
    expect(text).not.toContain(USERNAME);
    expect(text).not.toContain(NAME);
    expect(text).not.toContain(FB_PAGE_ID);
    expect(text).not.toContain("://");

    // 2 回目: 別のトークンでも行は増えず、Vault の値が差し替わる
    const secondToken = `${FAKE_TOKEN}_2`;
    replies.push(debugTokenOk(), meOk());
    expect(await registerToken([], { env: { ...env, META_ACCESS_TOKEN: secondToken }, fetchImpl })).toBe(true);
    expect(await counts()).toEqual({ accounts: 1, credentials: 1, vault: 1 });
    expect((await readCredential(db, account?.id ?? ""))?.token).toBe(secondToken);
    expect((await accountRow())?.id).toBe(account?.id);
    expect(logText()).not.toContain(secondToken);
  });

  it("権限が足りなくても登録し、insufficient_scope の warn を出す", async () => {
    replies.push(debugTokenOk({ scopes: ["instagram_basic", "instagram_manage_insights"] }), meOk());
    expect(await run()).toBe(true);
    const account = await accountRow();
    const credential = await readCredential(db, account?.id ?? "");
    expect(credential?.info.status).toBe("insufficient_scope");
    expect(credential?.info.scopes).toEqual(["instagram_basic", "instagram_manage_insights"]);
    expect(logText()).toMatch(/INFO {2}command=register-token status=registered .* credential_status=insufficient_scope$/m);
    expect(logText()).toMatch(/WARN {2}command=register-token status=insufficient_scope missing_scopes=pages_read_engagement hint=/m);
    expect(logText()).not.toContain(FAKE_TOKEN);
    expect(await counts()).toEqual({ accounts: 1, credentials: 1, vault: 1 });
  });

  it("設定が足りなければ ConfigError（変数名だけ）で、DB には触らない", async () => {
    await expect(registerToken([], { env: { ...env, IG_USER_ID: undefined }, fetchImpl })).rejects.toThrow(
      /環境変数 IG_USER_ID/,
    );
    expect(calls).toHaveLength(0);
  });
});
