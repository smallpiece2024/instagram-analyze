/**
 * `jobs/token-check.ts` の `evaluateDebugToken`（設計 4.2 章の 5 条件）。DB と API に触らない
 */
import { describe, expect, it } from "vitest";
import type { DebugTokenData } from "../src/lib/graph.js";
import type { DebugTokenResponse, Tracked } from "../src/jobs/graph-client.js";
import {
  DATA_ACCESS_WARN_DAYS,
  evaluateDebugToken,
  INVALID_TOKEN_ERROR,
  UNSUPPORTED_TOKEN_TYPE_ERROR,
} from "../src/jobs/token-check.js";

const ALL_SCOPES = ["instagram_basic", "instagram_manage_insights", "pages_read_engagement"];
const NOW = new Date("2026-10-01T05:30:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const FAKE_TOKEN = "EAAFAKETOKENVALUE0123456789abcdefghijklmn";

function unix(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

function tracked(overrides: Partial<Tracked<DebugTokenResponse>>): Tracked<DebugTokenResponse> {
  return {
    ok: true,
    status: 200,
    data: undefined,
    error: undefined,
    errorClass: undefined,
    rawResponseId: undefined,
    fetchedAt: NOW,
    ...overrides,
  };
}

function okWith(data: DebugTokenData | undefined): Tracked<DebugTokenResponse> {
  return tracked({ data: data === undefined ? {} : { data } });
}

const VALID: DebugTokenData = {
  type: "PAGE",
  is_valid: true,
  expires_at: 0,
  data_access_expires_at: unix(new Date(NOW.getTime() + 89 * DAY_MS + 60 * 60 * 1000)),
  scopes: [...ALL_SCOPES, "pages_show_list"],
  profile_id: "000000000000099",
};

describe("evaluateDebugToken", () => {
  it("固定文言としきい値", () => {
    expect(INVALID_TOKEN_ERROR).toBe("トークンが無効（debug_token）");
    expect(UNSUPPORTED_TOKEN_TYPE_ERROR).toBe("対応していないトークンの種類（debug_token）");
    expect(DATA_ACCESS_WARN_DAYS).toBe(14);
  });

  it("transient（再試行後）は patch なし", () => {
    const res = tracked({ ok: false, status: 0, error: { message: "ネットワークエラー", type: "NetworkError" }, errorClass: "transient" });
    expect(evaluateDebugToken(res, NOW)).toEqual({ outcome: "transient", patch: undefined, daysLeft: undefined, missing: [] });
  });

  it("fatal（コードあり）は status=error、last_error にコード、last_checked_at", () => {
    const res = tracked({ ok: false, status: 400, error: { message: "Invalid appsecret", type: "OAuthException", code: 190 }, errorClass: "fatal" });
    expect(evaluateDebugToken(res, NOW)).toEqual({
      outcome: "fatal",
      patch: { status: "error", last_error: "debug_token に失敗（コード 190）", last_checked_at: NOW },
      daysLeft: undefined,
      missing: [],
    });
  });

  it("fatal（コードなし）は「コード なし」", () => {
    const res = tracked({ ok: false, status: 400, error: { message: "HTTP 400" }, errorClass: "fatal" });
    expect(evaluateDebugToken(res, NOW).patch?.last_error).toBe("debug_token に失敗（コード なし）");
  });

  it("is_valid: false は status=expired、固定文言、期限（expires_at 0 は null）、last_checked_at。scopes は触らない", () => {
    const expires = unix(new Date("2026-12-29T00:00:00Z"));
    const res = okWith({ ...VALID, is_valid: false, data_access_expires_at: expires });
    expect(evaluateDebugToken(res, NOW)).toEqual({
      outcome: "invalid",
      patch: {
        status: "expired",
        last_error: INVALID_TOKEN_ERROR,
        expires_at: null,
        data_access_expires_at: new Date(expires * 1000),
        last_checked_at: NOW,
      },
      daysLeft: 88,
      missing: [],
    });
  });

  it("data がない（空のオブジェクト、data undefined、is_valid 省略）も expired。期限は null", () => {
    for (const res of [okWith(undefined), tracked({ data: undefined }), okWith({ type: "PAGE" })]) {
      const result = evaluateDebugToken(res, NOW);
      expect(result.outcome).toBe("invalid");
      expect(result.patch).toEqual({
        status: "expired",
        last_error: INVALID_TOKEN_ERROR,
        expires_at: null,
        data_access_expires_at: null,
        last_checked_at: NOW,
      });
      expect(result.daysLeft).toBeUndefined();
    }
  });

  it("権限が 1 つ欠ければ insufficient_scope。scopes、期限、last_checked_at、last_error に足りない権限", () => {
    const res = okWith({ ...VALID, scopes: ["instagram_basic", "instagram_manage_insights"] });
    expect(evaluateDebugToken(res, NOW)).toEqual({
      outcome: "insufficient_scope",
      patch: {
        status: "insufficient_scope",
        scopes: ["instagram_basic", "instagram_manage_insights"],
        expires_at: null,
        data_access_expires_at: new Date((VALID.data_access_expires_at ?? 0) * 1000),
        last_checked_at: NOW,
        last_error: "権限が足りない（pages_read_engagement）",
      },
      daysLeft: 89,
      missing: ["pages_read_engagement"],
    });
    expect(evaluateDebugToken(okWith({ ...VALID, scopes: undefined }), NOW).patch?.last_error).toBe(
      "権限が足りない（instagram_basic,instagram_manage_insights,pages_read_engagement）",
    );
  });

  it("有効で権限がそろえば valid。last_error は null、scopes と期限が入る", () => {
    expect(evaluateDebugToken(okWith(VALID), NOW)).toEqual({
      outcome: "valid",
      patch: {
        status: "valid",
        scopes: [...ALL_SCOPES, "pages_show_list"],
        expires_at: null,
        data_access_expires_at: new Date((VALID.data_access_expires_at ?? 0) * 1000),
        last_checked_at: NOW,
        last_error: null,
      },
      daysLeft: 89,
      missing: [],
    });
  });

  it("expires_at が秒なら Date、0 と undefined は null", () => {
    const seconds = unix(new Date("2026-11-30T00:00:00Z"));
    expect(evaluateDebugToken(okWith({ ...VALID, expires_at: seconds }), NOW).patch?.expires_at).toEqual(new Date(seconds * 1000));
    expect(evaluateDebugToken(okWith({ ...VALID, expires_at: 0 }), NOW).patch?.expires_at).toBeNull();
    expect(evaluateDebugToken(okWith({ ...VALID, expires_at: undefined }), NOW).patch?.expires_at).toBeNull();
  });

  it("daysLeft は data_access_expires_at から切り捨て。ちょうど 14 日は 14、14 日 − 1 秒は 13、期限なしは undefined、過ぎていれば負", () => {
    const at = (ms: number): DebugTokenData => ({ ...VALID, data_access_expires_at: unix(new Date(NOW.getTime() + ms)) });
    expect(evaluateDebugToken(okWith(at(14 * DAY_MS)), NOW).daysLeft).toBe(14);
    expect(evaluateDebugToken(okWith(at(14 * DAY_MS - 1000)), NOW).daysLeft).toBe(13);
    expect(evaluateDebugToken(okWith(at(15 * DAY_MS)), NOW).daysLeft).toBe(15);
    expect(evaluateDebugToken(okWith(at(-1000)), NOW).daysLeft).toBe(-1);
    expect(evaluateDebugToken(okWith({ ...VALID, data_access_expires_at: undefined }), NOW).daysLeft).toBeUndefined();
    expect(evaluateDebugToken(okWith({ ...VALID, data_access_expires_at: 0 }), NOW).daysLeft).toBeUndefined();
  });

  it("PAGE／USER 以外の種類は fatal（status=error、固定文言）", () => {
    expect(evaluateDebugToken(okWith({ ...VALID, type: "APP" }), NOW)).toEqual({
      outcome: "fatal",
      patch: { status: "error", last_error: UNSUPPORTED_TOKEN_TYPE_ERROR, last_checked_at: NOW },
      daysLeft: undefined,
      missing: [],
    });
    expect(evaluateDebugToken(okWith({ ...VALID, type: "USER" }), NOW).outcome).toBe("valid");
  });

  it("last_error にトークン、URL、Graph のエラー文が入らない", () => {
    const res = tracked({
      ok: false,
      status: 400,
      error: { message: `Error validating https://graph.facebook.com/debug_token?input_token=${FAKE_TOKEN} ${FAKE_TOKEN}`, code: 100 },
      errorClass: "fatal",
    });
    const text = JSON.stringify(evaluateDebugToken(res, NOW));
    expect(text).not.toContain(FAKE_TOKEN);
    expect(text).not.toContain("://");
    expect(text).not.toContain("Error validating");
    expect(text).toContain("debug_token に失敗（コード 100）");
  });

  it("patch に token_type を含めない（登録時の種類を変えない）", () => {
    for (const res of [okWith(VALID), okWith({ ...VALID, is_valid: false }), okWith({ ...VALID, scopes: [] })]) {
      expect(evaluateDebugToken(res, NOW).patch).not.toHaveProperty("token_type");
    }
  });

  it("入力を変えない", () => {
    const res = okWith({ ...VALID, scopes: [...ALL_SCOPES] });
    const snapshot = JSON.stringify(res);
    evaluateDebugToken(res, NOW);
    expect(JSON.stringify(res)).toBe(snapshot);
  });
});
