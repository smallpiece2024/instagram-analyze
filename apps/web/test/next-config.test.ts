import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

/**
 * `Referrer-Policy` が `no-referrer` だと、ブラウザは同一オリジンのフォーム送信（`POST /api/meta/login`）でも
 * `Origin: null` を送る（Fetch Standard の「append a request `Origin` header」）。すると `isSameOriginPost` が
 * 403 にして Facebook Login を始められない（2026-10-02 の実機で発生）。
 * `same-origin` なら `Origin` が付き、Referer は同じオリジンにしか送られない（Storage の署名付き URL や Meta に
 * アプリの URL は出ない）。
 */
describe("next.config.ts の headers()", () => {
  it("全ルートの Referrer-Policy は same-origin（no-referrer にすると Origin: null になり 403）", async () => {
    const headersFn = nextConfig.headers;
    expect(headersFn).toBeDefined();
    const rules = headersFn ? await headersFn() : [];
    const all = rules.find((rule) => rule.source === "/:path*");
    expect(all).toBeDefined();
    const policy = all?.headers.find((header) => header.key === "Referrer-Policy");
    expect(policy?.value).toBe("same-origin");
  });
});
