/**
 * `src/lib/login.ts`（ログイン／ログアウトの流れ）と `src/lib/auth-env.ts`、`src/lib/supabase/cookie-options.ts` の単体テスト。
 * Supabase の Auth クライアントは偽物を注入する。
 */
import { describe, expect, it, vi } from "vitest";
import { readAuthEnv } from "@/lib/auth-env";
import {
  readSignInForm,
  SIGN_IN_FAILURE_DELAY_MS,
  SIGN_IN_RESULT_MESSAGES,
  signInResultMessage,
  signInWithForm,
  signOutEverywhere,
  type AuthApi,
} from "@/lib/login";
import { AUTH_COOKIE_MAX_AGE_SECONDS, authCookieOptions } from "@/lib/supabase/cookie-options";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

function fakeAuth(overrides: Partial<AuthApi> = {}): AuthApi & { signIn: ReturnType<typeof vi.fn>; out: ReturnType<typeof vi.fn> } {
  const signIn = vi.fn(async () => ({ error: null }));
  const out = vi.fn(async () => ({ error: null }));
  return { signInWithPassword: signIn, signOut: out, ...overrides, signIn, out };
}

describe("readSignInForm", () => {
  it("メールは前後の空白を落とし、パスワードはそのまま", () => {
    expect(readSignInForm(form({ email: "  a@example.com ", password: " p w " }))).toEqual({ email: "a@example.com", password: " p w " });
  });

  it("欠落、空、長すぎるものは undefined", () => {
    expect(readSignInForm(form({ password: "x" }))).toBeUndefined();
    expect(readSignInForm(form({ email: "a@example.com" }))).toBeUndefined();
    expect(readSignInForm(form({ email: "", password: "x" }))).toBeUndefined();
    expect(readSignInForm(form({ email: "a@example.com", password: "" }))).toBeUndefined();
    expect(readSignInForm(form({ email: `${"a".repeat(250)}@example.com`, password: "x" }))).toBeUndefined();
    expect(readSignInForm(form({ email: "a@example.com", password: "x".repeat(257) }))).toBeUndefined();
  });
});

describe("signInWithForm", () => {
  it("成功なら ok。遅延なし。入力をそのまま signInWithPassword に渡す", async () => {
    const auth = fakeAuth();
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    expect(await signInWithForm(auth, form({ email: "a@example.com", password: "secret-pw" }), sleep)).toBe("ok");
    expect(auth.signIn).toHaveBeenCalledWith({ email: "a@example.com", password: "secret-pw" });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("Supabase が error を返す、例外を投げる、形が不正 → いずれも failed で 1 秒の固定遅延", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const rejected = fakeAuth({ signInWithPassword: async () => ({ error: { message: "Invalid login credentials" } }) });
    expect(await signInWithForm(rejected, form({ email: "a@example.com", password: "x" }), sleep)).toBe("failed");
    const throwing = fakeAuth({
      signInWithPassword: async () => {
        throw new Error("fetch failed http://127.0.0.1:54321");
      },
    });
    expect(await signInWithForm(throwing, form({ email: "a@example.com", password: "x" }), sleep)).toBe("failed");
    const malformed = fakeAuth();
    expect(await signInWithForm(malformed, form({ email: "", password: "x" }), sleep)).toBe("failed");
    expect(malformed.signIn).not.toHaveBeenCalled();
    expect(sleep).toHaveBeenCalledTimes(3);
    for (const call of sleep.mock.calls) expect(call[0]).toBe(SIGN_IN_FAILURE_DELAY_MS);
    expect(SIGN_IN_FAILURE_DELAY_MS).toBe(1000);
  });
});

describe("signOutEverywhere", () => {
  it("signOut({ scope: 'global' }) を呼ぶ。失敗しても投げない", async () => {
    const auth = fakeAuth();
    await signOutEverywhere(auth);
    expect(auth.out).toHaveBeenCalledWith({ scope: "global" });
    const throwing = fakeAuth({
      signOut: async () => {
        throw new Error("network");
      },
    });
    await expect(signOutEverywhere(throwing)).resolves.toBeUndefined();
  });
});

describe("signInResultMessage", () => {
  it("パラメータなしは undefined、ok と failed は固定文言、未知の値は失敗の文言（反射しない）", () => {
    expect(signInResultMessage(undefined)).toBeUndefined();
    expect(signInResultMessage("ok")).toBe(SIGN_IN_RESULT_MESSAGES.ok);
    expect(signInResultMessage("failed")).toBe(SIGN_IN_RESULT_MESSAGES.failed);
    expect(signInResultMessage("<script>")).toBe(SIGN_IN_RESULT_MESSAGES.failed);
  });
});

describe("authCookieOptions", () => {
  it("httpOnly、SameSite=Lax、path=/、7 日。secure と __Host- 接頭辞は https のときだけ", () => {
    expect(authCookieOptions("https://app.example.com")).toEqual({
      name: "__Host-sb-auth",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: AUTH_COOKIE_MAX_AGE_SECONDS,
    });
    expect(authCookieOptions("http://localhost:3000").secure).toBe(false);
    expect(authCookieOptions("http://localhost:3000").name).toBe("sb-auth");
    expect(authCookieOptions(undefined).secure).toBe(false);
    expect(authCookieOptions(undefined).name).toBe("sb-auth");
    expect(AUTH_COOKIE_MAX_AGE_SECONDS).toBe(7 * 24 * 60 * 60);
  });
});

describe("readAuthEnv", () => {
  const VALID = {
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321/",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x",
    APP_URL: "http://localhost:3000",
    WEB_ALLOWED_USER_ID: " 00000000-0000-0000-0000-000000000001 ",
  };

  it("一式そろえば ok。URL の末尾のスラッシュと id の空白を落とす", () => {
    expect(readAuthEnv(VALID)).toEqual({
      ok: true,
      env: {
        supabaseUrl: "http://127.0.0.1:54321",
        publishableKey: "sb_publishable_x",
        appUrl: "http://localhost:3000",
        allowedUserId: "00000000-0000-0000-0000-000000000001",
      },
    });
  });

  it("WEB_ALLOWED_USER_ID は任意（未設定・空は undefined。decideAccess が forbid にする）", () => {
    const result = readAuthEnv({ ...VALID, WEB_ALLOWED_USER_ID: "" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.env.allowedUserId).toBeUndefined();
  });

  it("欠落と不正は変数名だけ。値を含まない", () => {
    expect(readAuthEnv({ ...VALID, NEXT_PUBLIC_SUPABASE_URL: "ftp://x" })).toEqual({ ok: false, missing: ["NEXT_PUBLIC_SUPABASE_URL"] });
    expect(readAuthEnv({ ...VALID, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: " " })).toEqual({
      ok: false,
      missing: ["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"],
    });
    expect(readAuthEnv({ ...VALID, APP_URL: "http://localhost:3000/" })).toEqual({ ok: false, missing: ["APP_URL"] });
    expect(JSON.stringify(readAuthEnv({}))).not.toContain("sb_publishable_x");
  });
});
