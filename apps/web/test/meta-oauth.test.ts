import { describe, expect, it } from "vitest";
import {
  buildAuthorizeUrl,
  GENERIC_REASON_MESSAGE,
  generateState,
  graphErrorCode,
  isLoggableErrorReason,
  isReasonCode,
  OAUTH_SCOPES,
  parseTokenResponse,
  REASON_CODES,
  REASON_MESSAGES,
  reasonMessage,
  redirectUri,
  REQUIRED_SCOPES,
  selectCandidates,
  toCredentialInfo,
  validateCode,
  verifyState,
  type DebugTokenData,
} from "../src/lib/meta-oauth";

const CONFIG = { appId: "123456", graphApiVersion: "v25.0", appUrl: "http://localhost:3000" };
const ALL_SCOPES = ["instagram_basic", "instagram_manage_insights", "pages_read_engagement"];
const PAGE_ID = "000000000000099";

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

describe("generateState", () => {
  it("32 バイトの乱数を base64url にした 43 文字", () => {
    const state = generateState();
    expect(state).toHaveLength(43);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("注入した乱数を使う。呼ぶたびに違う値になる", () => {
    const fixed = generateState((n) => new Uint8Array(n).fill(0xff));
    expect(fixed).toBe("__________________________________________8");
    expect(generateState()).not.toBe(generateState());
  });
});

describe("verifyState", () => {
  it("同じ値なら true", () => {
    const s = generateState();
    expect(verifyState(s, s)).toBe(true);
  });

  it("長さ違い、1 文字違い、空、undefined は false", () => {
    expect(verifyState("abc", "abcd")).toBe(false);
    expect(verifyState("abcd", "abce")).toBe(false);
    expect(verifyState("", "")).toBe(false);
    expect(verifyState(undefined, "abc")).toBe(false);
    expect(verifyState("abc", undefined)).toBe(false);
    expect(verifyState(undefined, undefined)).toBe(false);
  });

  it("256 文字を超える値は比べずに false", () => {
    const long = "a".repeat(257);
    expect(verifyState(long, long)).toBe(false);
  });

  it("UTF-8 でバイト長が違えば false（文字数が同じでも）", () => {
    expect(verifyState("ab", "あ")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 認可 URL
// ---------------------------------------------------------------------------

describe("buildAuthorizeUrl", () => {
  const url = new URL(buildAuthorizeUrl(CONFIG, "STATE_VALUE"));

  it("Facebook の dialog/oauth に client_id、redirect_uri（完全一致）、state、scope 4 つ、response_type=code", () => {
    expect(url.origin).toBe("https://www.facebook.com");
    expect(url.pathname).toBe("/v25.0/dialog/oauth");
    expect(url.searchParams.get("client_id")).toBe("123456");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/meta/callback");
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri(CONFIG.appUrl));
    expect(url.searchParams.get("state")).toBe("STATE_VALUE");
    expect(url.searchParams.get("scope")?.split(",")).toEqual([
      "instagram_basic",
      "instagram_manage_insights",
      "pages_read_engagement",
      "pages_show_list",
    ]);
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  it("client_secret を含まない", () => {
    expect(url.searchParams.has("client_secret")).toBe(false);
    expect(url.toString()).not.toContain("secret");
  });

  it("OAUTH_SCOPES は REQUIRED_SCOPES ＋ pages_show_list", () => {
    expect([...REQUIRED_SCOPES]).toEqual(ALL_SCOPES);
    expect([...OAUTH_SCOPES]).toEqual([...ALL_SCOPES, "pages_show_list"]);
  });
});

// ---------------------------------------------------------------------------
// コールバックの入力
// ---------------------------------------------------------------------------

describe("validateCode", () => {
  it("英数字と _ - の 1〜512 文字だけ", () => {
    expect(validateCode("AQBx-abc_123")).toBe(true);
    expect(validateCode("a".repeat(512))).toBe(true);
    expect(validateCode("a".repeat(513))).toBe(false);
    expect(validateCode("")).toBe(false);
    expect(validateCode("abc def")).toBe(false);
    expect(validateCode("abc#_=_")).toBe(false);
    expect(validateCode("abc?x=1")).toBe(false);
    expect(validateCode(undefined)).toBe(false);
    expect(validateCode(123)).toBe(false);
    expect(validateCode(["abc"])).toBe(false);
  });
});

describe("isLoggableErrorReason", () => {
  it("^[a-z_]{1,40}$ に合うときだけ", () => {
    expect(isLoggableErrorReason("user_denied")).toBe(true);
    expect(isLoggableErrorReason("User denied")).toBe(false);
    expect(isLoggableErrorReason("a".repeat(41))).toBe(false);
    expect(isLoggableErrorReason("")).toBe(false);
    expect(isLoggableErrorReason(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// トークン応答
// ---------------------------------------------------------------------------

describe("parseTokenResponse", () => {
  it("access_token があれば ok", () => {
    expect(parseTokenResponse({ access_token: "TOKEN", token_type: "bearer", expires_in: 5183944 })).toEqual({
      ok: true,
      accessToken: "TOKEN",
    });
  });

  it("error 本文は失敗（コードつき）", () => {
    expect(parseTokenResponse({ error: { message: "Invalid code", type: "OAuthException", code: 100 } })).toEqual({
      ok: false,
      code: 100,
    });
    expect(parseTokenResponse({ error: "bad" })).toEqual({ ok: false, code: undefined });
  });

  it("JSON でない（文字列、undefined、配列）、access_token なし、空文字は失敗", () => {
    expect(parseTokenResponse("<html>")).toEqual({ ok: false });
    expect(parseTokenResponse(undefined)).toEqual({ ok: false });
    expect(parseTokenResponse([])).toEqual({ ok: false });
    expect(parseTokenResponse({ token_type: "bearer" })).toEqual({ ok: false });
    expect(parseTokenResponse({ access_token: "" })).toEqual({ ok: false });
    expect(parseTokenResponse({ access_token: 123 })).toEqual({ ok: false });
  });
});

describe("graphErrorCode", () => {
  it("error.code が数値のときだけ返す", () => {
    expect(graphErrorCode({ error: { code: 190 } })).toBe(190);
    expect(graphErrorCode({ error: { code: "190" } })).toBeUndefined();
    expect(graphErrorCode({ error: { message: "x" } })).toBeUndefined();
    expect(graphErrorCode({ data: [] })).toBeUndefined();
    expect(graphErrorCode(null)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 候補ページ
// ---------------------------------------------------------------------------

function page(id: string, ig?: { id: string; username?: string; name?: string }): Record<string, unknown> {
  return { id, name: `Page ${id}`, ...(ig ? { instagram_business_account: ig } : {}) };
}

describe("selectCandidates", () => {
  it("配列でなければ 0 件", () => {
    expect(selectCandidates(undefined)).toEqual([]);
    expect(selectCandidates({ data: [] })).toEqual([]);
  });

  it("instagram_business_account のないページは除く（0 件）", () => {
    expect(selectCandidates([page("1"), page("2")])).toEqual([]);
  });

  it("1 件なら username と name を取り、ないものは null", () => {
    expect(selectCandidates([page("1"), page("2", { id: "900", username: "u", name: "N" })])).toEqual([
      { pageId: "2", igUserId: "900", username: "u", name: "N" },
    ]);
    expect(selectCandidates([page("2", { id: "900" })])).toEqual([{ pageId: "2", igUserId: "900", username: null, name: null }]);
  });

  it("複数ならそのまま複数。ig_user_id が同じページは重複として除く（先に出たものを残す）", () => {
    const pages = [page("1", { id: "900" }), page("2", { id: "901" }), page("3", { id: "900" })];
    expect(selectCandidates(pages).map((c) => c.pageId)).toEqual(["1", "2"]);
  });

  it("id が数字列でない（ページでも Instagram でも）ものは除く", () => {
    expect(selectCandidates([page("abc", { id: "900" })])).toEqual([]);
    expect(selectCandidates([page("1", { id: "9x0" })])).toEqual([]);
    expect(selectCandidates([page("1", { id: "9".repeat(41) })])).toEqual([]);
    expect(selectCandidates([{ id: 1, instagram_business_account: { id: "900" } }])).toEqual([]);
    expect(selectCandidates([{ id: "1", instagram_business_account: "900" }])).toEqual([]);
  });

  it("targetIgUserId があれば、複数でも一致するものだけ。一致がなければ 0 件", () => {
    const pages = [page("1", { id: "900" }), page("2", { id: "901" })];
    expect(selectCandidates(pages, "901").map((c) => c.pageId)).toEqual(["2"]);
    expect(selectCandidates(pages, "999")).toEqual([]);
  });

  it("targetIgUserId があれば、1 件でも一致しなければ 0 件、一致すれば 1 件", () => {
    expect(selectCandidates([page("1", { id: "900" })], "999")).toEqual([]);
    expect(selectCandidates([page("1", { id: "900" })], "900")).toHaveLength(1);
  });

  it("targetIgUserId が重複するページの ID でも 1 件（重複排除の後に絞る）", () => {
    const pages = [page("1", { id: "900" }), page("2", { id: "900" })];
    expect(selectCandidates(pages, "900").map((c) => c.pageId)).toEqual(["1"]);
  });
});

// ---------------------------------------------------------------------------
// debug_token → 認証情報
// ---------------------------------------------------------------------------

describe("toCredentialInfo", () => {
  const expected = { appId: "123456", pageId: PAGE_ID };
  const base: DebugTokenData = {
    app_id: "123456",
    type: "PAGE",
    is_valid: true,
    expires_at: 0,
    data_access_expires_at: 1_798_761_600,
    scopes: [...ALL_SCOPES, "pages_show_list"],
    profile_id: PAGE_ID,
  };

  it("PAGE で 3 権限がそろえば valid。expires_at 0 は null、data_access_expires_at は Date", () => {
    expect(toCredentialInfo(base, expected)).toEqual({
      ok: true,
      credential: {
        token_type: "PAGE",
        expires_at: null,
        data_access_expires_at: new Date(1_798_761_600 * 1000),
        scopes: [...ALL_SCOPES, "pages_show_list"],
        status: "valid",
      },
      missing: [],
    });
  });

  it("expires_at が秒なら Date、undefined なら null。data_access_expires_at の 0 と undefined は null", () => {
    const at = (data: DebugTokenData) => {
      const r = toCredentialInfo(data, expected);
      return r.ok ? r.credential : undefined;
    };
    expect(at({ ...base, expires_at: 1_765_000_000 })?.expires_at).toEqual(new Date(1_765_000_000 * 1000));
    expect(at({ ...base, expires_at: undefined })?.expires_at).toBeNull();
    expect(at({ ...base, expires_at: "soon" })?.expires_at).toBeNull();
    expect(at({ ...base, data_access_expires_at: undefined })?.data_access_expires_at).toBeNull();
    expect(at({ ...base, data_access_expires_at: 0 })?.data_access_expires_at).toBeNull();
  });

  it("権限が 1 つ欠ければ insufficient_scope で missing に入る（登録はする）", () => {
    const r = toCredentialInfo({ ...base, scopes: ["instagram_basic", "instagram_manage_insights"] }, expected);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.credential.status).toBe("insufficient_scope");
    expect(r.missing).toEqual(["pages_read_engagement"]);
  });

  it("scopes がない、または文字列でない要素は除いて、足りなければ missing は 3 つ", () => {
    const r = toCredentialInfo({ ...base, scopes: undefined }, expected);
    expect(r.ok && r.credential.scopes).toEqual([]);
    expect(r.ok && r.missing).toEqual(ALL_SCOPES);
    const mixed = toCredentialInfo({ ...base, scopes: [...ALL_SCOPES, 1, null] }, expected);
    expect(mixed.ok && mixed.credential.scopes).toEqual(ALL_SCOPES);
  });

  it("is_valid が true でなければ not_valid", () => {
    expect(toCredentialInfo({ ...base, is_valid: false }, expected)).toEqual({ ok: false, reason: "token_invalid", detail: "not_valid" });
    expect(toCredentialInfo({ ...base, is_valid: undefined }, expected)).toEqual({ ok: false, reason: "token_invalid", detail: "not_valid" });
    expect(toCredentialInfo({ ...base, is_valid: "true" }, expected)).toEqual({ ok: false, reason: "token_invalid", detail: "not_valid" });
  });

  it("type が PAGE でなければ not_page_token（USER、APP、なし）", () => {
    for (const type of ["USER", "APP", "SYSTEM_USER", undefined]) {
      expect(toCredentialInfo({ ...base, type }, expected)).toEqual({ ok: false, reason: "token_invalid", detail: "not_page_token" });
    }
  });

  it("app_id が違う、または文字列でなければ app_id_mismatch", () => {
    expect(toCredentialInfo({ ...base, app_id: "999" }, expected)).toEqual({ ok: false, reason: "token_invalid", detail: "app_id_mismatch" });
    expect(toCredentialInfo({ ...base, app_id: 123456 }, expected)).toEqual({ ok: false, reason: "token_invalid", detail: "app_id_mismatch" });
    expect(toCredentialInfo({ ...base, app_id: undefined }, expected)).toEqual({ ok: false, reason: "token_invalid", detail: "app_id_mismatch" });
  });

  it("profile_id がページの id と違う、またはなければ profile_id_mismatch", () => {
    expect(toCredentialInfo({ ...base, profile_id: "000000000000098" }, expected)).toEqual({
      ok: false,
      reason: "token_invalid",
      detail: "profile_id_mismatch",
    });
    expect(toCredentialInfo({ ...base, profile_id: undefined }, expected)).toEqual({
      ok: false,
      reason: "token_invalid",
      detail: "profile_id_mismatch",
    });
  });

  it("入力を変えない", () => {
    const input: DebugTokenData = { ...base, scopes: [...ALL_SCOPES] };
    const snapshot = JSON.stringify(input);
    toCredentialInfo(input, expected);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// 理由コード
// ---------------------------------------------------------------------------

describe("REASON_MESSAGES / reasonMessage", () => {
  it("全コードに文言がある。文言にトークン、URL、英数字の ID を含まない", () => {
    expect(REASON_CODES).toHaveLength(15);
    expect(REASON_CODES).toContain("target_mismatch");
    for (const code of REASON_CODES) {
      const text = REASON_MESSAGES[code];
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/https?:/);
      expect(text).not.toMatch(/token|secret|[0-9]{6,}/i);
    }
  });

  it("既知のコードは対応する文言、未知と空は汎用文言、undefined は undefined", () => {
    expect(reasonMessage("ok")).toBe(REASON_MESSAGES.ok);
    expect(reasonMessage("db_failed")).toBe(REASON_MESSAGES.db_failed);
    expect(reasonMessage("<script>")).toBe(GENERIC_REASON_MESSAGE);
    expect(reasonMessage("")).toBe(GENERIC_REASON_MESSAGE);
    expect(reasonMessage("OK")).toBe(GENERIC_REASON_MESSAGE);
    expect(reasonMessage(undefined)).toBeUndefined();
  });

  it("isReasonCode は閉じた列挙だけを通す", () => {
    expect(isReasonCode("unknown")).toBe(true);
    expect(isReasonCode("constructor")).toBe(false);
    expect(isReasonCode(1)).toBe(false);
  });
});
