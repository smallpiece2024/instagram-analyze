import { describe, expect, it } from "vitest";
import { formatGraphError, GraphClient, parseCdnExpiry } from "../src/lib/graph.js";

describe("parseCdnExpiry", () => {
  it("oe パラメータ（16 進の UNIX 秒）を日時にする", () => {
    const url = "https://scontent.cdninstagram.com/v/t50/video.mp4?_nc_ht=x&oe=68F0A1B2&oh=abc";
    expect(parseCdnExpiry(url)?.getTime()).toBe(0x68f0a1b2 * 1000);
  });

  it("oe がない、または不正なら undefined", () => {
    expect(parseCdnExpiry("https://example.com/video.mp4")).toBeUndefined();
    expect(parseCdnExpiry("https://example.com/video.mp4?oe=zz")).toBeUndefined();
    expect(parseCdnExpiry("not a url")).toBeUndefined();
  });
});

describe("GraphClient.describe", () => {
  it("アクセストークンを含まないリクエスト表記を返す", () => {
    const client = new GraphClient("SECRET_TOKEN", "v25.0");
    const text = client.describe("123/insights", { metric: "reach", period: "day", since: undefined });
    expect(text).toBe("123/insights?metric=reach&period=day");
    expect(text).not.toContain("SECRET_TOKEN");
  });
});

describe("formatGraphError", () => {
  it("コードとサブコードを付けて整形する", () => {
    expect(formatGraphError({ message: "Invalid metric", code: 100, error_subcode: 2108006 })).toBe(
      "[100/2108006] Invalid metric",
    );
    expect(formatGraphError({ message: "HTTP 500" })).toBe("HTTP 500");
    expect(formatGraphError(undefined)).toBe("");
  });
});
