/**
 * `src/lib/meta-connect.ts` の単体テスト（設計 4.2 章）。偽の `fetch`（応答キュー）と偽の登録関数で全分岐を通し、
 * `fetch` に渡る URL と本文、ログの内容に秘密が入らないことを確かめる。
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/lib/db";
import { handleCallback, startLogin, type CallbackInput, type ConnectDeps, type ConnectEnv } from "../src/lib/meta-connect";
import type { RegisterCredentialInput, RegisterCredentialResult } from "../src/lib/queries/register-credential";

const APP_SECRET = "FAKE_APP_SECRET_xyz";
const CODE = "AQD_fake-code_123";
const STATE = "STATE_VALUE_abcdefghijklmnopqrstuvwxyz0123";
const SHORT_TOKEN = "SHORT_TOKEN_aaa";
const LONG_TOKEN = "LONG_TOKEN_bbb";
const PAGE_TOKEN = "PAGE_TOKEN_ccc";
const PAGE_ID = "000000000000099";
const IG_USER_ID = "000000123456789";
const ALL_SCOPES = ["instagram_basic", "instagram_manage_insights", "pages_read_engagement"];

const env: ConnectEnv = {
  metaAppId: "123456",
  metaAppSecret: APP_SECRET,
  graphApiVersion: "v25.0",
  appUrl: "http://localhost:3000",
  targetIgUserId: undefined,
};

type Reply = () => Response | Promise<Response>;

interface Call {
  url: URL;
  method: string;
  body: string | undefined;
  contentType: string | null;
  authorization: string | null;
  cache: RequestCache | undefined;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

const ok = (body: unknown): Reply => () => jsonResponse(body);
const graphError = (code: number, status = 400): Reply => () => jsonResponse({ error: { message: "x", type: "OAuthException", code } }, { status });
const notJson = (): Reply => () => new Response("<html>", { status: 200 });
const networkFailure = (): Reply => () => {
  throw new TypeError("fetch failed: https://graph.facebook.com/v25.0/oauth/access_token?code=LEAK");
};

function debugTokenOk(overrides: Record<string, unknown> = {}): Reply {
  return ok({
    data: {
      app_id: "123456",
      type: "PAGE",
      application: "instagram-analyze",
      data_access_expires_at: 1_798_761_600,
      expires_at: 0,
      is_valid: true,
      profile_id: PAGE_ID,
      scopes: [...ALL_SCOPES, "pages_show_list"],
      user_id: "000000000000098",
      ...overrides,
    },
  });
}

function pagesOk(pages: unknown[], after?: string): Reply {
  return ok({
    data: pages,
    paging: after ? { cursors: { before: "B", after }, next: "https://graph.facebook.com/next" } : { cursors: { before: "B", after: "A" } },
  });
}

function pageWithIg(pageId: string, igUserId: string, username = "fake_user", name = "Fake Name"): unknown {
  return { id: pageId, name: `Page ${pageId}`, instagram_business_account: { id: igUserId, username, name } };
}

describe("meta-connect", () => {
  const replies: Reply[] = [];
  const calls: Call[] = [];
  const lines: string[] = [];
  const registered: RegisterCredentialInput[] = [];
  let registerResult: RegisterCredentialResult | (() => never) = { ok: true, accountId: "00000000-0000-0000-0000-000000000001" };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
      contentType: headers.get("content-type"),
      authorization: headers.get("authorization"),
      cache: init?.cache,
    });
    const reply = replies.shift();
    if (!reply) return jsonResponse({ error: { message: "応答の用意がない", code: 999_999 } }, { status: 400 });
    return reply();
  };

  const register: ConnectDeps["register"] = async (_db, input) => {
    registered.push(input);
    if (typeof registerResult === "function") return registerResult();
    return registerResult;
  };

  const deps: ConnectDeps = { fetch: fetchImpl, db: {} as Db, env, register, log: (line) => lines.push(line) };

  const baseInput: CallbackInput = { code: CODE, state: STATE, cookieState: STATE };

  /** 成功までの応答をすべて積む */
  function pushHappyPath(options: { pages?: unknown[]; debug?: Reply } = {}): void {
    replies.push(
      ok({ access_token: SHORT_TOKEN, token_type: "bearer", expires_in: 5000 }),
      ok({ access_token: LONG_TOKEN, token_type: "bearer", expires_in: 5_184_000 }),
      pagesOk(options.pages ?? [pageWithIg(PAGE_ID, IG_USER_ID)]),
      ok({ access_token: PAGE_TOKEN, id: PAGE_ID }),
      options.debug ?? debugTokenOk(),
    );
  }

  function logText(): string {
    return lines.join("\n");
  }

  /** ログに秘密と URL と ID がなく、fetch の URL にアプリシークレット、code、ユーザートークンがないこと */
  function expectNoSecretsAnywhere(): void {
    const text = logText();
    for (const secret of [APP_SECRET, CODE, SHORT_TOKEN, LONG_TOKEN, PAGE_TOKEN, STATE]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain("://");
    expect(text).not.toContain(IG_USER_ID);
    expect(text).not.toContain(PAGE_ID);
    for (const call of calls) {
      const url = call.url.toString();
      for (const secret of [APP_SECRET, CODE, SHORT_TOKEN, LONG_TOKEN, STATE]) {
        expect(url).not.toContain(secret);
      }
    }
    // ページトークンが URL に載るのは debug_token の input_token だけ
    expect(calls.filter((c) => c.url.toString().includes(PAGE_TOKEN)).map((c) => c.url.pathname)).toEqual(
      calls.filter((c) => c.url.pathname === "/v25.0/debug_token").map((c) => c.url.pathname),
    );
  }

  beforeEach(() => {
    replies.length = 0;
    calls.length = 0;
    lines.length = 0;
    registered.length = 0;
    registerResult = { ok: true, accountId: "00000000-0000-0000-0000-000000000001" };
  });

  // -------------------------------------------------------------------------
  // startLogin
  // -------------------------------------------------------------------------

  describe("startLogin", () => {
    it("認可 URL と state を返す。URL の state は返した state と同じで、client_secret を含まない", () => {
      const { url, state } = startLogin({ env });
      const parsed = new URL(url);
      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(parsed.origin).toBe("https://www.facebook.com");
      expect(parsed.pathname).toBe("/v25.0/dialog/oauth");
      expect(parsed.searchParams.get("client_id")).toBe("123456");
      expect(parsed.searchParams.get("state")).toBe(state);
      expect(parsed.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/meta/callback");
      expect(parsed.searchParams.get("response_type")).toBe("code");
      expect(url).not.toContain(APP_SECRET);
      expect(url).not.toContain("client_secret");
    });

    it("random を注入できる", () => {
      const { state } = startLogin({ env, random: (n) => new Uint8Array(n) });
      expect(state).toBe("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    });
  });

  // -------------------------------------------------------------------------
  // 入力の検査（fetch を呼ばない）
  // -------------------------------------------------------------------------

  describe("handleCallback: 入力の検査", () => {
    it("state がなければ invalid_request", async () => {
      expect(await handleCallback({ ...baseInput, state: undefined }, deps)).toEqual({ result: "invalid_request" });
      expect(await handleCallback({ ...baseInput, state: "" }, deps)).toEqual({ result: "invalid_request" });
      expect(calls).toHaveLength(0);
      expect(logText()).toMatch(/^\[meta-connect\] result=invalid_request state なし$/m);
    });

    it("Cookie がない、または一致しなければ state_mismatch。ログに state の値を出さない", async () => {
      expect(await handleCallback({ ...baseInput, cookieState: undefined }, deps)).toEqual({ result: "state_mismatch" });
      expect(await handleCallback({ ...baseInput, cookieState: `${STATE}x` }, deps)).toEqual({ result: "state_mismatch" });
      expect(await handleCallback({ ...baseInput, cookieState: STATE.replace("a", "b") }, deps)).toEqual({ result: "state_mismatch" });
      expect(calls).toHaveLength(0);
      expect(lines).toEqual([
        "[meta-connect] result=state_mismatch cookie なし",
        "[meta-connect] result=state_mismatch 不一致",
        "[meta-connect] result=state_mismatch 不一致",
      ]);
      expectNoSecretsAnywhere();
    });

    it("state の検査は error より先（state 不一致の denied は state_mismatch）", async () => {
      expect(await handleCallback({ state: STATE, cookieState: "other", error: "access_denied" }, deps)).toEqual({ result: "state_mismatch" });
    });

    it("error があれば内容を問わず denied。error_reason は形が合うときだけログに、error_description は出さない", async () => {
      expect(
        await handleCallback(
          { state: STATE, cookieState: STATE, error: "access_denied", errorReason: "user_denied" },
          deps,
        ),
      ).toEqual({ result: "denied" });
      expect(await handleCallback({ state: STATE, cookieState: STATE, error: "server_error", errorReason: "Bad Reason!" }, deps)).toEqual({
        result: "denied",
      });
      expect(await handleCallback({ state: STATE, cookieState: STATE, error: "x", code: CODE }, deps)).toEqual({ result: "denied" });
      expect(calls).toHaveLength(0);
      expect(lines).toEqual([
        "[meta-connect] result=denied error_reason=user_denied",
        "[meta-connect] result=denied",
        "[meta-connect] result=denied",
      ]);
    });

    it("error があっても state がなければ invalid_request（state の検査が先）", async () => {
      expect(await handleCallback({ cookieState: STATE, error: "access_denied", errorReason: "user_denied" }, deps)).toEqual({
        result: "invalid_request",
      });
      expect(lines).toEqual(["[meta-connect] result=invalid_request state なし"]);
    });

    it("error が空文字なら無視して code の検査へ進む", async () => {
      expect(await handleCallback({ ...baseInput, error: "", code: undefined }, deps)).toEqual({ result: "invalid_request" });
      expect(lines).toEqual(["[meta-connect] result=invalid_request code の形が不正"]);
      replies.push(graphError(100));
      expect(await handleCallback({ ...baseInput, error: "" }, deps)).toEqual({ result: "token_exchange_failed" });
      expect(calls).toHaveLength(1);
    });

    it("code が空、長すぎる、形が不正なら invalid_request", async () => {
      for (const code of [undefined, "", "a".repeat(513), "abc def", "abc#_=_"]) {
        expect(await handleCallback({ ...baseInput, code }, deps)).toEqual({ result: "invalid_request" });
      }
      expect(calls).toHaveLength(0);
      expect(logText()).toMatch(/result=invalid_request code の形が不正/);
      expect(logText()).not.toContain("abc def");
    });
  });

  // -------------------------------------------------------------------------
  // トークン交換
  // -------------------------------------------------------------------------

  describe("handleCallback: トークン交換", () => {
    it("code の交換は POST 本文（x-www-form-urlencoded）。URL に client_secret と code を載せない。cache: no-store", async () => {
      replies.push(graphError(100));
      expect(await handleCallback(baseInput, deps)).toEqual({ result: "token_exchange_failed" });
      expect(calls).toHaveLength(1);
      const call = calls[0];
      expect(call.method).toBe("POST");
      expect(call.url.toString()).toBe("https://graph.facebook.com/v25.0/oauth/access_token");
      expect(call.contentType).toBe("application/x-www-form-urlencoded");
      expect(call.cache).toBe("no-store");
      const body = new URLSearchParams(call.body);
      expect(body.get("client_id")).toBe("123456");
      expect(body.get("client_secret")).toBe(APP_SECRET);
      expect(body.get("redirect_uri")).toBe("http://localhost:3000/api/meta/callback");
      expect(body.get("code")).toBe(CODE);
      expect(call.authorization).toBeNull();
      expect(lines).toEqual(["[meta-connect] result=token_exchange_failed step=code status=400 code=100"]);
      expectNoSecretsAnywhere();
    });

    it("交換の応答に access_token がない、JSON でない、fetch が例外を投げる → token_exchange_failed（例外の文言は出さない）", async () => {
      replies.push(ok({ token_type: "bearer" }));
      expect(await handleCallback(baseInput, deps)).toEqual({ result: "token_exchange_failed" });
      replies.push(notJson());
      expect(await handleCallback(baseInput, deps)).toEqual({ result: "token_exchange_failed" });
      replies.push(networkFailure());
      expect(await handleCallback(baseInput, deps)).toEqual({ result: "token_exchange_failed" });
      expect(lines).toEqual([
        "[meta-connect] result=token_exchange_failed step=code code=none",
        "[meta-connect] result=token_exchange_failed step=code status=200 code=none",
        "[meta-connect] result=token_exchange_failed step=code status=0 code=none",
      ]);
      expect(logText()).not.toContain("LEAK");
      expectNoSecretsAnywhere();
    });

    it("長期化も POST 本文（grant_type=fb_exchange_token）。失敗なら token_exchange_failed step=long", async () => {
      replies.push(ok({ access_token: SHORT_TOKEN }), graphError(190, 401));
      expect(await handleCallback(baseInput, deps)).toEqual({ result: "token_exchange_failed" });
      expect(calls).toHaveLength(2);
      const call = calls[1];
      expect(call.method).toBe("POST");
      expect(call.url.toString()).toBe("https://graph.facebook.com/v25.0/oauth/access_token");
      const body = new URLSearchParams(call.body);
      expect(body.get("grant_type")).toBe("fb_exchange_token");
      expect(body.get("client_id")).toBe("123456");
      expect(body.get("client_secret")).toBe(APP_SECRET);
      expect(body.get("fb_exchange_token")).toBe(SHORT_TOKEN);
      expect(lines).toEqual(["[meta-connect] result=token_exchange_failed step=long status=401 code=190"]);
      expectNoSecretsAnywhere();
    });

    it("長期化の応答に access_token がなければ token_exchange_failed step=long", async () => {
      replies.push(ok({ access_token: SHORT_TOKEN }), ok({}));
      expect(await handleCallback(baseInput, deps)).toEqual({ result: "token_exchange_failed" });
      expect(lines).toEqual(["[meta-connect] result=token_exchange_failed step=long code=none"]);
    });
  });

  // -------------------------------------------------------------------------
  // me/accounts と候補
  // -------------------------------------------------------------------------

  describe("handleCallback: me/accounts", () => {
    beforeEach(() => {
      replies.push(ok({ access_token: SHORT_TOKEN }), ok({ access_token: LONG_TOKEN }));
    });

    it("me/accounts は GET、Bearer に長期トークン、fields に access_token を含めない、limit=100。失敗は accounts_failed", async () => {
      replies.push(graphError(10, 403));
      expect(await handleCallback(baseInput, deps)).toEqual({ result: "accounts_failed" });
      expect(calls).toHaveLength(3);
      const call = calls[2];
      expect(call.method).toBe("GET");
      expect(call.url.origin + call.url.pathname).toBe("https://graph.facebook.com/v25.0/me/accounts");
      expect(call.url.searchParams.get("fields")).toBe("id,name,instagram_business_account{id,username,name}");
      expect(call.url.searchParams.get("limit")).toBe("100");
      expect(call.url.searchParams.has("access_token")).toBe(false);
      expect(call.url.searchParams.has("after")).toBe(false);
      expect(call.authorization).toBe(`Bearer ${LONG_TOKEN}`);
      expect(lines).toEqual(["[meta-connect] result=accounts_failed status=403 code=10"]);
      expectNoSecretsAnywhere();
    });

    it("data が配列でなければ accounts_failed", async () => {
      replies.push(ok({ data: { id: "1" } }));
      expect(await handleCallback(baseInput, deps)).toEqual({ result: "accounts_failed" });
    });

    it("2 ページを cursors.after で読み、候補が 0 なら no_instagram_account（ログは理由だけ）", async () => {
      replies.push(pagesOk([{ id: "1", name: "no ig" }], "CURSOR_2"), pagesOk([{ id: "2", name: "no ig" }]));
      expect(await handleCallback(baseInput, deps)).toEqual({ result: "no_instagram_account" });
      expect(calls).toHaveLength(4);
      expect(calls[3].url.searchParams.get("after")).toBe("CURSOR_2");
      expect(lines).toEqual(["[meta-connect] result=no_instagram_account"]);
    });

    it("next があっても最大 10 ページで止める", async () => {
      for (let i = 0; i < 12; i++) replies.push(pagesOk([{ id: String(i + 1) }], `C${i}`));
      expect(await handleCallback(baseInput, deps)).toEqual({ result: "no_instagram_account" });
      expect(calls).toHaveLength(12);
      expect(replies).toHaveLength(2);
    });

    it("候補が複数で targetIgUserId がなければ登録せず multiple_accounts（ログは件数だけ）", async () => {
      replies.push(pagesOk([pageWithIg("11", "900"), pageWithIg("12", "901"), pageWithIg("13", "900")]));
      expect(await handleCallback(baseInput, deps)).toEqual({ result: "multiple_accounts" });
      expect(calls).toHaveLength(3);
      expect(registered).toHaveLength(0);
      expect(lines).toEqual(["[meta-connect] result=multiple_accounts count=2"]);
    });

    it("候補が複数でも targetIgUserId に一致するものがあればそれを登録する", async () => {
      replies.push(
        pagesOk([pageWithIg("11", "900"), pageWithIg(PAGE_ID, IG_USER_ID)]),
        ok({ access_token: PAGE_TOKEN }),
        debugTokenOk(),
      );
      const outcome = await handleCallback(baseInput, { ...deps, env: { ...env, targetIgUserId: IG_USER_ID } });
      expect(outcome.result).toBe("ok");
      expect(registered[0]?.igUserId).toBe(IG_USER_ID);
      expect(registered[0]?.fbPageId).toBe(PAGE_ID);
    });

    it("targetIgUserId があり、Instagram 付きページはあるのに一致しなければ登録せず target_mismatch（ログは件数だけ）", async () => {
      replies.push(pagesOk([pageWithIg("11", "900"), pageWithIg("12", "901")]));
      expect(await handleCallback(baseInput, { ...deps, env: { ...env, targetIgUserId: IG_USER_ID } })).toEqual({
        result: "target_mismatch",
      });
      expect(calls).toHaveLength(3);
      expect(registered).toHaveLength(0);
      expect(lines).toEqual(["[meta-connect] result=target_mismatch count=2"]);
      expectNoSecretsAnywhere();
    });

    it("targetIgUserId があり、候補が 1 つでも一致しなければ target_mismatch", async () => {
      replies.push(pagesOk([pageWithIg("11", "900")]));
      expect(await handleCallback(baseInput, { ...deps, env: { ...env, targetIgUserId: IG_USER_ID } })).toEqual({
        result: "target_mismatch",
      });
      expect(registered).toHaveLength(0);
      expect(lines).toEqual(["[meta-connect] result=target_mismatch count=1"]);
    });

    it("targetIgUserId があっても、Instagram 付きページが 1 つもなければ no_instagram_account", async () => {
      replies.push(pagesOk([{ id: "1", name: "no ig" }]));
      expect(await handleCallback(baseInput, { ...deps, env: { ...env, targetIgUserId: IG_USER_ID } })).toEqual({
        result: "no_instagram_account",
      });
      expect(lines).toEqual(["[meta-connect] result=no_instagram_account"]);
    });

    it("targetIgUserId があり、候補 1 つが一致すれば登録する", async () => {
      replies.push(pagesOk([pageWithIg(PAGE_ID, IG_USER_ID)]), ok({ access_token: PAGE_TOKEN }), debugTokenOk());
      const outcome = await handleCallback(baseInput, { ...deps, env: { ...env, targetIgUserId: IG_USER_ID } });
      expect(outcome.result).toBe("ok");
      expect(registered[0]?.igUserId).toBe(IG_USER_ID);
    });
  });

  // -------------------------------------------------------------------------
  // ページトークンと debug_token
  // -------------------------------------------------------------------------

  describe("handleCallback: ページトークンと debug_token", () => {
    beforeEach(() => {
      replies.push(ok({ access_token: SHORT_TOKEN }), ok({ access_token: LONG_TOKEN }), pagesOk([pageWithIg(PAGE_ID, IG_USER_ID)]));
    });

    it("ページトークンは GET {page_id}?fields=access_token に Bearer 長期トークン。失敗は page_token_failed", async () => {
      replies.push(graphError(100));
      expect(await handleCallback(baseInput, deps)).toEqual({ result: "page_token_failed" });
      const call = calls[3];
      expect(call.method).toBe("GET");
      expect(call.url.origin + call.url.pathname).toBe(`https://graph.facebook.com/v25.0/${PAGE_ID}`);
      expect(call.url.searchParams.get("fields")).toBe("access_token");
      expect(call.authorization).toBe(`Bearer ${LONG_TOKEN}`);
      expect(lines).toEqual(["[meta-connect] result=page_token_failed status=400 code=100"]);
    });

    it("ページトークンの応答に access_token がなければ page_token_failed", async () => {
      replies.push(ok({ id: PAGE_ID }));
      expect(await handleCallback(baseInput, deps)).toEqual({ result: "page_token_failed" });
    });

    it("debug_token はアプリトークンを Bearer、input_token をクエリに。失敗は debug_token_failed", async () => {
      replies.push(ok({ access_token: PAGE_TOKEN }), graphError(190, 401));
      expect(await handleCallback(baseInput, deps)).toEqual({ result: "debug_token_failed" });
      const call = calls[4];
      expect(call.method).toBe("GET");
      expect(call.url.origin + call.url.pathname).toBe("https://graph.facebook.com/v25.0/debug_token");
      expect(call.url.searchParams.get("input_token")).toBe(PAGE_TOKEN);
      expect(call.authorization).toBe(`Bearer 123456|${APP_SECRET}`);
      expect(lines).toEqual(["[meta-connect] result=debug_token_failed status=401 code=190"]);
      expectNoSecretsAnywhere();
    });

    it("debug_token の data がなければ debug_token_failed", async () => {
      replies.push(ok({ access_token: PAGE_TOKEN }), ok({}));
      expect(await handleCallback(baseInput, deps)).toEqual({ result: "debug_token_failed" });
    });

    it.each<[string, Record<string, unknown>, string]>([
      ["is_valid が false", { is_valid: false }, "not_valid"],
      ["種類が USER", { type: "USER" }, "not_page_token"],
      ["app_id が違う", { app_id: "999" }, "app_id_mismatch"],
      ["profile_id がページと違う", { profile_id: "000000000000098" }, "profile_id_mismatch"],
      ["profile_id が数値型（文字列でない）", { profile_id: Number(PAGE_ID) }, "profile_id_mismatch"],
      ["profile_id がない", { profile_id: undefined }, "profile_id_mismatch"],
    ])("%s → token_invalid（ログは固定語）", async (_label, overrides, detail) => {
      replies.push(ok({ access_token: PAGE_TOKEN }), debugTokenOk(overrides));
      expect(await handleCallback(baseInput, deps)).toEqual({ result: "token_invalid" });
      expect(registered).toHaveLength(0);
      expect(lines).toEqual([`[meta-connect] result=token_invalid detail=${detail}`]);
      expectNoSecretsAnywhere();
    });
  });

  // -------------------------------------------------------------------------
  // 登録と成功
  // -------------------------------------------------------------------------

  describe("handleCallback: 登録", () => {
    it("成功すると登録関数にページトークンと認証情報を渡し、ok とユーザー名を返す。ログは出ない", async () => {
      pushHappyPath();
      expect(await handleCallback(baseInput, deps)).toEqual({ result: "ok", registered: [{ username: "fake_user" }] });
      expect(calls).toHaveLength(5);
      expect(registered).toEqual([
        {
          igUserId: IG_USER_ID,
          username: "fake_user",
          name: "Fake Name",
          fbPageId: PAGE_ID,
          token: PAGE_TOKEN,
          credential: {
            token_type: "PAGE",
            expires_at: null,
            data_access_expires_at: new Date(1_798_761_600 * 1000),
            scopes: [...ALL_SCOPES, "pages_show_list"],
            status: "valid",
          },
        },
      ]);
      expect(lines).toEqual([]);
      for (const call of calls) expect(call.cache).toBe("no-store");
      expectNoSecretsAnywhere();
    });

    it("権限が足りなくても insufficient_scope で登録する", async () => {
      pushHappyPath({ debug: debugTokenOk({ scopes: ["instagram_basic"] }) });
      expect((await handleCallback(baseInput, deps)).result).toBe("ok");
      expect(registered[0]?.credential.status).toBe("insufficient_scope");
      expect(registered[0]?.credential.scopes).toEqual(["instagram_basic"]);
    });

    it("username がなければ null で返す", async () => {
      pushHappyPath({ pages: [{ id: PAGE_ID, instagram_business_account: { id: IG_USER_ID } }] });
      expect(await handleCallback(baseInput, deps)).toEqual({ result: "ok", registered: [{ username: null }] });
      expect(registered[0]?.username).toBeNull();
      expect(registered[0]?.name).toBeNull();
    });

    it("登録に失敗したら db_failed（ログは固定文言）", async () => {
      pushHappyPath();
      registerResult = { ok: false, reason: "DB エラー（SQLSTATE 23505）" };
      expect(await handleCallback(baseInput, deps)).toEqual({ result: "db_failed" });
      expect(lines).toEqual(["[meta-connect] result=db_failed DB エラー（SQLSTATE 23505）"]);
    });

    it("登録関数が例外を投げたら unknown（例外の内容は出さない）", async () => {
      pushHappyPath();
      registerResult = () => {
        throw new Error(`boom ${PAGE_TOKEN}`);
      };
      expect(await handleCallback(baseInput, deps)).toEqual({ result: "unknown" });
      expect(lines).toEqual(["[meta-connect] result=unknown 例外"]);
      expectNoSecretsAnywhere();
    });

    it("register を省くと既定の registerCredential に db が渡る（偽の db では固定文言の db_failed）", async () => {
      pushHappyPath();
      const withoutRegister: ConnectDeps = { fetch: fetchImpl, db: {} as Db, env, log: (line) => lines.push(line) };
      expect(await handleCallback(baseInput, withoutRegister)).toEqual({ result: "db_failed" });
      expect(lines).toEqual(["[meta-connect] result=db_failed DB エラー"]);
    });
  });
});
