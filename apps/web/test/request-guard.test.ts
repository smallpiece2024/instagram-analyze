import { describe, expect, it } from "vitest";
import { appOrigin, isAllowedHost, isSameOriginPost } from "../src/lib/request-guard";

const APP_URL = "http://localhost:3000";

describe("appOrigin", () => {
  it("URL のオリジンを返す。読めなければ undefined", () => {
    expect(appOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(appOrigin("https://example.com/path")).toBe("https://example.com");
    expect(appOrigin("not a url")).toBeUndefined();
    expect(appOrigin(undefined)).toBeUndefined();
    expect(appOrigin("")).toBeUndefined();
  });
});

describe("isAllowedHost", () => {
  it("APP_URL のホストとローカルの既定 3 つを許す（大文字小文字と前後の空白は無視）", () => {
    expect(isAllowedHost("localhost:3000", APP_URL)).toBe(true);
    expect(isAllowedHost("127.0.0.1:3000", APP_URL)).toBe(true);
    expect(isAllowedHost("[::1]:3000", APP_URL)).toBe(true);
    expect(isAllowedHost(" LOCALHOST:3000 ", APP_URL)).toBe(true);
    expect(isAllowedHost("myapp.example.com", "https://myapp.example.com")).toBe(true);
    expect(isAllowedHost("myapp.example.com:8443", "https://myapp.example.com:8443")).toBe(true);
  });

  it("それ以外のホスト、空、null は拒否する", () => {
    expect(isAllowedHost("evil.example.com", APP_URL)).toBe(false);
    expect(isAllowedHost("localhost:3001", APP_URL)).toBe(false);
    expect(isAllowedHost("localhost", APP_URL)).toBe(false);
    expect(isAllowedHost("192.168.1.10:3000", APP_URL)).toBe(false);
    expect(isAllowedHost("", APP_URL)).toBe(false);
    expect(isAllowedHost(null, APP_URL)).toBe(false);
    expect(isAllowedHost(undefined, APP_URL)).toBe(false);
  });

  it("APP_URL が未設定や不正でもローカルの既定は許し、それ以外は拒否する", () => {
    expect(isAllowedHost("localhost:3000", undefined)).toBe(true);
    expect(isAllowedHost("localhost:3000", "bogus")).toBe(true);
    expect(isAllowedHost("myapp.example.com", undefined)).toBe(false);
    expect(isAllowedHost("myapp.example.com", "bogus")).toBe(false);
  });
});

describe("isSameOriginPost", () => {
  it("Sec-Fetch-Site が same-origin／none で Origin が一致すれば許す", () => {
    expect(isSameOriginPost({ secFetchSite: "same-origin", origin: APP_URL }, APP_URL)).toBe(true);
    expect(isSameOriginPost({ secFetchSite: "none", origin: APP_URL }, APP_URL)).toBe(true);
    expect(isSameOriginPost({ secFetchSite: null, origin: APP_URL }, APP_URL)).toBe(true);
    expect(isSameOriginPost({ secFetchSite: "Same-Origin", origin: "HTTP://LOCALHOST:3000" }, APP_URL)).toBe(true);
  });

  it("cross-site、same-site は拒否する", () => {
    expect(isSameOriginPost({ secFetchSite: "cross-site", origin: APP_URL }, APP_URL)).toBe(false);
    expect(isSameOriginPost({ secFetchSite: "same-site", origin: APP_URL }, APP_URL)).toBe(false);
  });

  it("Origin がない、違う、null 文字列は拒否する", () => {
    expect(isSameOriginPost({ secFetchSite: "same-origin", origin: null }, APP_URL)).toBe(false);
    expect(isSameOriginPost({ secFetchSite: "same-origin", origin: undefined }, APP_URL)).toBe(false);
    expect(isSameOriginPost({ secFetchSite: "same-origin", origin: "null" }, APP_URL)).toBe(false);
    expect(isSameOriginPost({ secFetchSite: "same-origin", origin: "http://127.0.0.1:3000" }, APP_URL)).toBe(false);
    expect(isSameOriginPost({ secFetchSite: "same-origin", origin: "http://localhost:3000/" }, APP_URL)).toBe(false);
    expect(isSameOriginPost({ secFetchSite: "same-origin", origin: "http://evil.example.com" }, APP_URL)).toBe(false);
  });

  it("APP_URL が不正なら拒否する", () => {
    expect(isSameOriginPost({ secFetchSite: "same-origin", origin: APP_URL }, "bogus")).toBe(false);
  });
});
