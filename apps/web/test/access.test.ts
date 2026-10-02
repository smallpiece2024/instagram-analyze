import { describe, expect, it } from "vitest";
import { decideAccess, isPublicPath, LOGIN_PATH } from "@/lib/access";

const ALLOWED = "00000000-0000-0000-0000-000000000001";
const OTHER = "00000000-0000-0000-0000-000000000002";

describe("isPublicPath", () => {
  it("/login、/login 配下、favicon、_next/static は公開。_next/image は使っていないので公開しない", () => {
    expect(isPublicPath(LOGIN_PATH)).toBe(true);
    expect(isPublicPath("/login/")).toBe(true);
    expect(isPublicPath("/favicon.ico")).toBe(true);
    expect(isPublicPath("/_next/static/chunks/main.js")).toBe(true);
    expect(isPublicPath("/_next/image?url=x")).toBe(false);
  });

  it("それ以外は公開でない（/loginx、/api/meta/callback、/）", () => {
    expect(isPublicPath("/")).toBe(false);
    expect(isPublicPath("/loginx")).toBe(false);
    expect(isPublicPath("/api/meta/callback")).toBe(false);
    expect(isPublicPath("/api/meta/login")).toBe(false);
    expect(isPublicPath("/_next/data/x.json")).toBe(false);
  });
});

describe("decideAccess", () => {
  it("/login と静的資産は claims や許可設定にかかわらず pass", () => {
    expect(decideAccess("/login", undefined, undefined)).toBe("pass");
    expect(decideAccess("/login", { sub: OTHER }, ALLOWED)).toBe("pass");
    expect(decideAccess("/favicon.ico", undefined, "")).toBe("pass");
    expect(decideAccess("/_next/static/a.css", undefined, undefined)).toBe("pass");
  });

  it("claims がなければ login（getClaims の失敗も claims なしとして扱う）", () => {
    expect(decideAccess("/", undefined, ALLOWED)).toBe("login");
    expect(decideAccess("/api/meta/callback", undefined, ALLOWED)).toBe("login");
    expect(decideAccess("/", undefined, undefined)).toBe("login");
  });

  it("allowedUserId が未設定・空・空白なら、claims があっても forbid（フェイルクローズ）", () => {
    expect(decideAccess("/", { sub: ALLOWED }, undefined)).toBe("forbid");
    expect(decideAccess("/", { sub: ALLOWED }, "")).toBe("forbid");
    expect(decideAccess("/", { sub: ALLOWED }, "   ")).toBe("forbid");
  });

  it("sub が一致しなければ forbid、一致すれば pass", () => {
    expect(decideAccess("/", { sub: OTHER }, ALLOWED)).toBe("forbid");
    expect(decideAccess("/", { sub: "" }, ALLOWED)).toBe("forbid");
    expect(decideAccess("/", {}, ALLOWED)).toBe("forbid");
    expect(decideAccess("/", { sub: ALLOWED }, ALLOWED)).toBe("pass");
    expect(decideAccess("/api/meta/callback", { sub: ALLOWED }, ` ${ALLOWED} `)).toBe("pass");
    expect(decideAccess("/media?page=2", { sub: ALLOWED }, ALLOWED)).toBe("pass");
  });
});
