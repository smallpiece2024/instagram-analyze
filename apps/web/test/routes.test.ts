/**
 * `/api/meta/login` と `/api/meta/callback` の Route Handler のテスト。node 環境で `NextRequest` を作って呼ぶ。
 * `markDynamic` と `server-only` は `vitest.config.mts` の alias でスタブ。環境変数は `vi.stubEnv` で与える。
 * `handleCallback` は `vi.fn` で包み、必要なときだけ戻り値や例外を差し替える（既定は本物）。
 * 末尾で、R3 で足す URL（`/compare`、`/export/*`、`/media/[id]`）と R4・R5 の画面の URL が proxy を通ること、
 * R5 の画面の `no-store` とナビの並びを確かめる。
 */
import { NextRequest, NextResponse } from "next/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAllDb } from "../src/lib/db";
import { config as proxyConfig, proxy } from "../src/proxy";
import { checkAccess } from "../src/lib/auth";
import { handleCallback } from "../src/lib/meta-connect";
import { GET as callbackGet } from "../src/app/api/meta/callback/route";
import * as login from "../src/app/api/meta/login/route";
import { activeNavHref, NAV_ITEMS } from "../src/components/NavLinks";
import nextConfig from "../next.config";

// R3 の新しい URL が proxy を通ることの確認用（test/proxy.test.ts と同じ差し替え。route handler には影響しない）
const getClaims = vi.fn();
vi.mock("../src/lib/supabase/proxy", () => ({
  createProxySupabaseClient: (request: NextRequest) => ({
    supabase: { auth: { getClaims } },
    response: () => NextResponse.next({ request }),
  }),
}));

vi.mock("../src/lib/meta-connect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/meta-connect")>();
  return { ...actual, handleCallback: vi.fn(actual.handleCallback) };
});

// ログインの再確認は `checkAccess` を差し替える（既定は pass。login と forbid は下の describe で確かめる）
vi.mock("../src/lib/auth", () => ({ checkAccess: vi.fn(async () => "pass") }));

const APP_URL = "http://localhost:3000";
const STATE = "STATE_VALUE_abcdefghijklmnopqrstuvwxyz0123";

const BASE_ENV: Record<string, string | undefined> = {
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
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
    vi.mocked(checkAccess).mockReset();
    vi.mocked(checkAccess).mockResolvedValue("pass");
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

    it("正常なら 303 で facebook.com へ。state は Cookie（HttpOnly、SameSite=Lax、Path=/、Max-Age=600、http なら Secure なし）と URL で同じ", async () => {
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
      expect(cookie).toMatch(/;\s*Path=\/(;|$)/i);
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
      expect(cookie).toMatch(/;\s*Path=\/(;|$)/i);
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

  describe("ログインの再確認（checkAccess。R2 設計 4.3 章）", () => {
    it("login なら両方とも 303 /login（Cookie なし。handleCallback は呼ばない。pathname を渡す）", async () => {
      vi.mocked(checkAccess).mockResolvedValue("login");
      const res = await login.POST(loginRequest());
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/login");
      expect(setCookie(res)).toBe("");
      const cb = await callbackGet(callbackRequest({ code: "AQD", state: STATE }, `meta_oauth_state=${STATE}`));
      expect(cb.status).toBe(303);
      expect(cb.headers.get("location")).toBe("/login");
      expect(handleCallback).not.toHaveBeenCalled();
      expect(checkAccess).toHaveBeenCalledWith("/api/meta/login");
      expect(checkAccess).toHaveBeenCalledWith("/api/meta/callback");
      expect(warn).not.toHaveBeenCalled();
    });

    it("forbid なら両方とも 403", async () => {
      vi.mocked(checkAccess).mockResolvedValue("forbid");
      expect((await login.POST(loginRequest())).status).toBe(403);
      expect((await callbackGet(callbackRequest({ code: "AQD", state: STATE }, `meta_oauth_state=${STATE}`))).status).toBe(403);
      expect(handleCallback).not.toHaveBeenCalled();
    });

    it("APP_URL が https なら state の Cookie は __Host-meta_oauth_state（Secure、Path=/）で、callback も同じ名前を読む", async () => {
      stubEnv({ APP_URL: "https://app.example.com" });
      const req = new NextRequest("https://app.example.com/api/meta/login", {
        method: "POST",
        headers: { origin: "https://app.example.com", "sec-fetch-site": "same-origin" },
      });
      const cookie = setCookie(await login.POST(req));
      expect(cookie).toMatch(/^__Host-meta_oauth_state=[A-Za-z0-9_-]{43};/);
      expect(cookie).toMatch(/;\s*Path=\/(;|$)/i);
      expect(cookie).toMatch(/;\s*Secure/i);
      vi.mocked(handleCallback).mockResolvedValueOnce({ result: "denied" });
      const cb = await callbackGet(
        callbackRequest({ code: "AQD", state: STATE }, `__Host-meta_oauth_state=${STATE}; meta_oauth_state=other`),
      );
      expect(handleCallback).toHaveBeenCalledWith(expect.objectContaining({ cookieState: STATE }), expect.anything());
      expect(setCookie(cb)).toMatch(/^__Host-meta_oauth_state=;.*Max-Age=0/i);
    });
  });

  /**
   * R3 で足す URL（R3 設計 3 章、10 章の段階 0）。proxy の設定は変えず、matcher に入り、未ログインは /login へ 303、
   * 許可外は 403、本人は通過することだけを確かめる（まだない画面もある。画面とハンドラーの中身は各段階のテスト）
   */
  describe("R3 の新しい URL が proxy を通る", () => {
    const ALLOWED = "11111111-1111-1111-1111-111111111111";
    const NEW_PATHS = [
      "/compare",
      "/compare?preset=yoy",
      "/compare?a=2026-09-01..2026-09-30&b=2026-08-01..2026-08-31",
      "/export/media",
      "/export/daily?from=2026-09-01&to=2026-09-30",
      "/media/000012345",
      // R4 のリール分析（R4 設計 6.2 節）
      "/reels",
      "/reels?y=views&sort=duration&dir=asc",
      // R5 の画面（R5 設計 4 章。画面は段階 3 で作る。proxy は変えない）
      "/tags",
      "/tags?axis=12&kind=reel&m=save_rate",
      "/tags/edit",
      "/tags/edit?missing=12&confirm_delete=12",
      "/stories",
      "/stories?range=90&sort=views&dir=asc",
      "/audience",
      "/timing",
      "/timing?m=views_latest&kind=feed",
    ];
    // matcher は列挙しない 1 本の正規表現（src/proxy.ts）。Next.js と同じく pathname 全体に当てる
    const matchers = proxyConfig.matcher.map((m) => new RegExp(`^${m}$`));

    function pageRequest(path: string): NextRequest {
      return new NextRequest(`${APP_URL}${path}`, { headers: { host: "localhost:3000" } });
    }

    beforeEach(() => {
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
      vi.stubEnv("WEB_ALLOWED_USER_ID", ALLOWED);
      getClaims.mockReset();
    });

    it.each(NEW_PATHS)("%s は matcher に入る", (path) => {
      const pathname = new URL(path, APP_URL).pathname;
      expect(matchers.some((re) => re.test(pathname))).toBe(true);
    });

    it.each(NEW_PATHS)("%s: 未ログインは /login へ 303、許可外は 403、本人は通過", async (path) => {
      getClaims.mockResolvedValue({ data: null, error: { message: "no session" } });
      const anon = await proxy(pageRequest(path));
      expect(anon.status).toBe(303);
      expect(anon.headers.get("location")).toBe(`${APP_URL}/login`);

      getClaims.mockResolvedValue({ data: { claims: { sub: "22222222-2222-2222-2222-222222222222" } }, error: null });
      expect((await proxy(pageRequest(path))).status).toBe(403);

      getClaims.mockResolvedValue({ data: { claims: { sub: ALLOWED } }, error: null });
      expect((await proxy(pageRequest(path))).status).toBe(200);
    });
  });

  /** R5 の画面の応答は `Cache-Control: private, no-store`（R5 設計 4 章の S12。`next.config.ts` の `headers()`） */
  describe("R5 の画面のキャッシュ", () => {
    const R5_PAGES = ["/tags", "/tags/edit", "/stories", "/audience", "/timing"];

    it.each(R5_PAGES)("%s は Cache-Control: private, no-store", async (source) => {
      const rules = nextConfig.headers ? await nextConfig.headers() : [];
      const rule = rules.find((r) => r.source === source);
      expect(rule, source).toBeDefined();
      expect(rule?.headers.find((h) => h.key === "Cache-Control")?.value).toBe("private, no-store");
    });

    it("R3・R4 のページの no-store も残っている", async () => {
      const rules = nextConfig.headers ? await nextConfig.headers() : [];
      for (const source of ["/media", "/media/:id", "/reels"]) {
        expect(rules.find((r) => r.source === source)?.headers.some((h) => h.value === "private, no-store"), source).toBe(true);
      }
    });
  });

  /** ナビの並び（R5 設計 4 章、確認事項 Q11） */
  describe("R5 のナビ", () => {
    it("9 項目を決めた順に並べる", () => {
      expect(NAV_ITEMS.map((i) => [i.href, i.label])).toEqual([
        ["/", "概要"],
        ["/media", "投稿一覧"],
        ["/reels", "リール分析"],
        ["/tags", "タグ分析"],
        ["/stories", "ストーリーズ"],
        ["/timing", "投稿時刻"],
        ["/audience", "オーディエンス"],
        ["/compare", "期間比較"],
        ["/jobs", "接続と収集ログ"],
      ]);
    });

    it("タグの編集はナビに出さず、現在位置はタグ分析", () => {
      expect(NAV_ITEMS.map((i): string => i.href)).not.toContain("/tags/edit");
      expect(activeNavHref("/tags/edit")).toBe("/tags");
      expect(activeNavHref("/tags")).toBe("/tags");
      expect(activeNavHref("/timing")).toBe("/timing");
      expect(activeNavHref("/stories")).toBe("/stories");
      expect(activeNavHref("/audience")).toBe("/audience");
      // 前方一致は「/」の区切りまで（/tagsx は現在位置にしない）
      expect(activeNavHref("/tagsx")).toBeUndefined();
    });
  });
});
