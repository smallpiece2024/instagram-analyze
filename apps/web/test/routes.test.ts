/**
 * `/api/meta/login` と `/api/meta/callback` の Route Handler のテスト。node 環境で `NextRequest` を作って呼ぶ。
 * `markDynamic` と `server-only` は `vitest.config.mts` の alias でスタブ。環境変数は `vi.stubEnv` で与える。
 * `handleCallback` は `vi.fn` で包み、必要なときだけ戻り値や例外を差し替える（既定は本物）。
 */
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAllDb } from "../src/lib/db";
import { handleCallback } from "../src/lib/meta-connect";
import { GET as callbackGet } from "../src/app/api/meta/callback/route";
import * as login from "../src/app/api/meta/login/route";

vi.mock("../src/lib/meta-connect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/meta-connect")>();
  return { ...actual, handleCallback: vi.fn(actual.handleCallback) };
});

const APP_URL = "http://localhost:3000";
const STATE = "STATE_VALUE_abcdefghijklmnopqrstuvwxyz0123";

const BASE_ENV: Record<string, string | undefined> = {
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_SERVICE_ROLE_KEY: "FAKE_ROUTES_SERVICE_ROLE_KEY",
  META_APP_ID: "123456",
  META_APP_SECRET: "FAKE_ROUTES_APP_SECRET",
  META_GRAPH_API_VERSION: "v25.0",
  APP_URL,
  META_TARGET_IG_USER_ID: undefined,
};

function stubEnv(overrides: Record<string, string | undefined> = {}): void {
  for (const [name, value] of Object.entries({ ...BASE_ENV, ...overrides })) vi.stubEnv(name, value);
}

function loginRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${APP_URL}/api/meta/login`, {
    method: "POST",
    headers: { origin: APP_URL, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded", ...headers },
    body: "",
  });
}

function callbackRequest(query: Record<string, string>, cookie?: string): NextRequest {
  const url = new URL(`${APP_URL}/api/meta/callback`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new NextRequest(url, { method: "GET", headers: cookie === undefined ? {} : { cookie } });
}

function setCookie(res: Response): string {
  return res.headers.get("set-cookie") ?? "";
}

describe("routes", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  beforeEach(() => {
    stubEnv();
    warn.mockClear();
    vi.mocked(handleCallback).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    warn.mockRestore();
    await closeAllDb();
  });

  describe("POST /api/meta/login", () => {
    it("GET を export しない", () => {
      expect("GET" in login).toBe(false);
      expect(typeof login.POST).toBe("function");
    });

    it("Origin が APP_URL と違えば 403（Cookie もリダイレクトもなし）", async () => {
      const res = await login.POST(loginRequest({ origin: "http://evil.example.com" }));
      expect(res.status).toBe(403);
      expect(setCookie(res)).toBe("");
      expect(res.headers.get("location")).toBeNull();
    });

    it("Origin がない、または Sec-Fetch-Site が cross-site なら 403", async () => {
      const noOrigin = new NextRequest(`${APP_URL}/api/meta/login`, { method: "POST", headers: { "sec-fetch-site": "same-origin" } });
      expect((await login.POST(noOrigin)).status).toBe(403);
      expect((await login.POST(loginRequest({ "sec-fetch-site": "cross-site" }))).status).toBe(403);
    });

    it("正常なら 303 で facebook.com へ。state は Cookie（HttpOnly、SameSite=Lax、Path=/api/meta、Max-Age=600、http なら Secure なし）と URL で同じ", async () => {
      const res = await login.POST(loginRequest());
      expect(res.status).toBe(303);
      const location = new URL(res.headers.get("location") ?? "");
      expect(location.origin).toBe("https://www.facebook.com");
      expect(location.pathname).toBe("/v25.0/dialog/oauth");
      expect(location.searchParams.get("client_id")).toBe("123456");
      expect(location.searchParams.get("redirect_uri")).toBe(`${APP_URL}/api/meta/callback`);
      expect(location.toString()).not.toContain("FAKE_ROUTES_APP_SECRET");

      const cookie = setCookie(res);
      const match = /^meta_oauth_state=([A-Za-z0-9_-]{43});/.exec(cookie);
      expect(match).not.toBeNull();
      expect(location.searchParams.get("state")).toBe(match?.[1]);
      expect(cookie).toMatch(/;\s*Path=\/api\/meta/i);
      expect(cookie).toMatch(/;\s*Max-Age=600/i);
      expect(cookie).toMatch(/;\s*HttpOnly/i);
      expect(cookie).toMatch(/;\s*SameSite=lax/i);
      expect(cookie).not.toMatch(/Secure/i);
      expect(warn).not.toHaveBeenCalled();
    });

    it("APP_URL が https なら Cookie に Secure が付く", async () => {
      stubEnv({ APP_URL: "https://app.example.com" });
      const req = new NextRequest("https://app.example.com/api/meta/login", {
        method: "POST",
        headers: { origin: "https://app.example.com", "sec-fetch-site": "same-origin" },
      });
      const res = await login.POST(req);
      expect(res.status).toBe(303);
      expect(setCookie(res)).toMatch(/;\s*Secure/i);
    });

    it("環境変数が足りなければ相対の Location で /connect?result=config_missing（ログは変数名だけ）", async () => {
      stubEnv({ META_APP_SECRET: undefined, APP_URL: undefined });
      const res = await login.POST(loginRequest());
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/connect?result=config_missing");
      expect(setCookie(res)).toBe("");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toBe("[meta-connect] result=config_missing missing=META_APP_SECRET,APP_URL");
    });
  });

  describe("GET /api/meta/callback", () => {
    const deleteCookie = /^meta_oauth_state=;.*;\s*Max-Age=0/i;

    it("Cookie がなければ state_mismatch へ 303（APP_URL 基点）。削除の Set-Cookie を付ける", async () => {
      const res = await callbackGet(callbackRequest({ code: "AQD", state: STATE }));
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`${APP_URL}/connect?result=state_mismatch`);
      const cookie = setCookie(res);
      expect(cookie).toMatch(deleteCookie);
      expect(cookie).toMatch(/;\s*Path=\/api\/meta/i);
      expect(cookie).toMatch(/;\s*HttpOnly/i);
      expect(cookie).toMatch(/;\s*SameSite=lax/i);
      expect(cookie).not.toMatch(/Secure/i);
      expect(handleCallback).toHaveBeenCalledTimes(1);
    });

    it("Cookie、クエリの code、state、error、error_reason を handleCallback に渡し、結果のコードへ 303", async () => {
      vi.mocked(handleCallback).mockResolvedValueOnce({ result: "ok", registered: [{ username: "u" }] });
      const res = await callbackGet(
        callbackRequest({ code: "AQD", state: STATE, error: "access_denied", error_reason: "user_denied" }, `meta_oauth_state=${STATE}; other=1`),
      );
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`${APP_URL}/connect?result=ok`);
      expect(setCookie(res)).toMatch(deleteCookie);
      expect(handleCallback).toHaveBeenCalledWith(
        { code: "AQD", state: STATE, cookieState: STATE, error: "access_denied", errorReason: "user_denied" },
        expect.objectContaining({ env: expect.objectContaining({ appUrl: APP_URL, metaAppId: "123456" }) }),
      );
      expect(warn).not.toHaveBeenCalled();
    });

    it("handleCallback が例外を投げても unknown へ 303（ログは固定文言、例外の内容なし）。削除の Set-Cookie を付ける", async () => {
      vi.mocked(handleCallback).mockRejectedValueOnce(new Error("boom SECRET_IN_MESSAGE"));
      const res = await callbackGet(callbackRequest({ code: "AQD", state: STATE }, `meta_oauth_state=${STATE}`));
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`${APP_URL}/connect?result=unknown`);
      expect(setCookie(res)).toMatch(deleteCookie);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toBe("[meta-connect] result=unknown route の例外");
      expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRET_IN_MESSAGE");
    });

    it("環境変数が足りなければ相対の Location で config_missing。削除の Set-Cookie を付け、handleCallback は呼ばない", async () => {
      stubEnv({ APP_URL: undefined });
      const res = await callbackGet(callbackRequest({ code: "AQD", state: STATE }, `meta_oauth_state=${STATE}`));
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/connect?result=config_missing");
      expect(setCookie(res)).toMatch(deleteCookie);
      expect(handleCallback).not.toHaveBeenCalled();
      expect(warn.mock.calls[0]?.[0]).toBe("[meta-connect] result=config_missing missing=APP_URL");
    });

    it("APP_URL が https なら削除の Set-Cookie にも Secure が付く", async () => {
      stubEnv({ APP_URL: "https://app.example.com" });
      vi.mocked(handleCallback).mockResolvedValueOnce({ result: "denied" });
      const res = await callbackGet(callbackRequest({ error: "access_denied", state: STATE }, `meta_oauth_state=${STATE}`));
      expect(res.headers.get("location")).toBe("https://app.example.com/connect?result=denied");
      expect(setCookie(res)).toMatch(/;\s*Secure/i);
    });
  });
});
