/**
 * `src/proxy.ts` の分岐（R2 設計 4.3 章、10.1 章）。Supabase のクライアントは差し替え、`getClaims()` の
 * 「一致／不一致／error／例外」と、環境変数の有無、Host 検査、Cookie の引き継ぎを確かめる。
 */
import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getClaims = vi.fn();

vi.mock("../src/lib/supabase/proxy", () => ({
  createProxySupabaseClient: (request: NextRequest) => ({
    supabase: { auth: { getClaims } },
    // `setAll` が最後に作ったレスポンスの代わり。更新済みの Cookie が付いている体にする
    response: () => {
      const res = NextResponse.next({ request });
      res.cookies.set("sb-auth", "refreshed", { path: "/" });
      res.headers.set("cache-control", "no-store");
      return res;
    },
  }),
}));

import { proxy } from "../src/proxy";

const APP_URL = "http://localhost:3000";
const ALLOWED = "11111111-1111-1111-1111-111111111111";

function request(path: string, host = "localhost:3000"): NextRequest {
  return new NextRequest(`${APP_URL}${path}`, { headers: { host } });
}

function withClaims(sub: string | undefined): void {
  getClaims.mockResolvedValue({ data: { claims: { sub } }, error: null });
}

describe("proxy", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    vi.stubEnv("APP_URL", APP_URL);
    vi.stubEnv("WEB_ALLOWED_USER_ID", ALLOWED);
    getClaims.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("本人（sub が一致）は通過し、更新済みの Cookie とキャッシュ系ヘッダが付いたレスポンスをそのまま返す", async () => {
    withClaims(ALLOWED);
    const res = await proxy(request("/jobs"));
    expect(res.status).toBe(200);
    expect(res.cookies.get("sb-auth")?.value).toBe("refreshed");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("getClaims が error を返せば未ログインとして /login へ 303（基点は APP_URL）。Cookie は引き継ぐ", async () => {
    getClaims.mockResolvedValue({ data: null, error: { message: "expired" } });
    const res = await proxy(request("/media"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${APP_URL}/login`);
    expect(res.cookies.get("sb-auth")?.value).toBe("refreshed");
  });

  it("getClaims が例外を投げても未ログインとして /login へ 303", async () => {
    getClaims.mockRejectedValue(new Error("network"));
    const res = await proxy(request("/"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${APP_URL}/login`);
  });

  it("別の利用者（sub が不一致）は 403。更新済みの Cookie は写さない", async () => {
    withClaims("22222222-2222-2222-2222-222222222222");
    const res = await proxy(request("/jobs"));
    expect(res.status).toBe(403);
    expect(res.cookies.get("sb-auth")).toBeUndefined();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("WEB_ALLOWED_USER_ID が未設定なら本人の JWT でも 403（フェイルクローズ）", async () => {
    vi.stubEnv("WEB_ALLOWED_USER_ID", "");
    withClaims(ALLOWED);
    const res = await proxy(request("/"));
    expect(res.status).toBe(403);
  });

  it("認証の環境変数が足りなければ getClaims を呼ばず、/login へ 303（基点は要求の URL）", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    const res = await proxy(request("/connect"));
    expect(getClaims).not.toHaveBeenCalled();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${APP_URL}/login`);
  });

  it("/login と静的資産は未ログインでも通過する（セッションの更新は行う）", async () => {
    getClaims.mockResolvedValue({ data: null, error: { message: "no session" } });
    expect((await proxy(request("/login"))).status).toBe(200);
    expect((await proxy(request("/favicon.ico"))).status).toBe(200);
    expect((await proxy(request("/_next/static/chunks/app.js"))).status).toBe(200);
    // callback は保護対象
    const callback = await proxy(request("/api/meta/callback?code=x&state=y"));
    expect(callback.status).toBe(303);
  });

  it("Host が許可リストにないと、認証を見る前に 403", async () => {
    withClaims(ALLOWED);
    const res = await proxy(request("/", "evil.example.com"));
    expect(res.status).toBe(403);
    expect(getClaims).not.toHaveBeenCalled();
  });
});
