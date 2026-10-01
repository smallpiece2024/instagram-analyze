import { describe, expect, it } from "vitest";
import { registerToken, REQUIRED_SCOPES, toCredentialInfo, type DebugTokenData } from "../src/commands/register-token.js";

const ALL_SCOPES = ["instagram_basic", "instagram_manage_insights", "pages_read_engagement"];

describe("toCredentialInfo", () => {
  const base: DebugTokenData = {
    type: "PAGE",
    is_valid: true,
    expires_at: 0,
    data_access_expires_at: 1_798_761_600,
    scopes: [...ALL_SCOPES, "pages_show_list"],
    profile_id: "000000000000099",
  };

  it("必要な権限は 3 つ", () => {
    expect([...REQUIRED_SCOPES]).toEqual(ALL_SCOPES);
  });

  it("PAGE で 3 権限がそろえば valid。expires_at 0 は null、data_access_expires_at は Date、profile_id は fb_page_id", () => {
    expect(toCredentialInfo(base)).toEqual({
      credential: {
        token_type: "PAGE",
        expires_at: null,
        data_access_expires_at: new Date(1_798_761_600 * 1000),
        scopes: [...ALL_SCOPES, "pages_show_list"],
        status: "valid",
      },
      missing: [],
      fbPageId: "000000000000099",
    });
  });

  it("expires_at が秒なら Date、undefined なら null", () => {
    expect(toCredentialInfo({ ...base, expires_at: 1_765_000_000 })?.credential.expires_at).toEqual(new Date(1_765_000_000 * 1000));
    expect(toCredentialInfo({ ...base, expires_at: undefined })?.credential.expires_at).toBeNull();
    expect(toCredentialInfo({ ...base, data_access_expires_at: undefined })?.credential.data_access_expires_at).toBeNull();
    expect(toCredentialInfo({ ...base, data_access_expires_at: 0 })?.credential.data_access_expires_at).toBeNull();
  });

  it("権限が 1 つ欠ければ insufficient_scope で missing に入る。登録はする（credential は返る）", () => {
    const parsed = toCredentialInfo({ ...base, scopes: ["instagram_basic", "instagram_manage_insights"] });
    expect(parsed?.credential.status).toBe("insufficient_scope");
    expect(parsed?.missing).toEqual(["pages_read_engagement"]);
    expect(parsed?.credential.scopes).toEqual(["instagram_basic", "instagram_manage_insights"]);
  });

  it("scopes がなければ空配列で insufficient_scope、missing は 3 つ", () => {
    const parsed = toCredentialInfo({ ...base, scopes: undefined });
    expect(parsed?.credential.scopes).toEqual([]);
    expect(parsed?.credential.status).toBe("insufficient_scope");
    expect(parsed?.missing).toEqual(ALL_SCOPES);
  });

  it("USER なら fb_page_id は null（profile_id があっても）", () => {
    const parsed = toCredentialInfo({ ...base, type: "USER" });
    expect(parsed?.credential.token_type).toBe("USER");
    expect(parsed?.fbPageId).toBeNull();
  });

  it("PAGE でも profile_id がなければ null", () => {
    expect(toCredentialInfo({ ...base, profile_id: undefined })?.fbPageId).toBeNull();
  });

  it("APP や未知の種類、種類なしは undefined", () => {
    expect(toCredentialInfo({ ...base, type: "APP" })).toBeUndefined();
    expect(toCredentialInfo({ ...base, type: "SYSTEM_USER" })).toBeUndefined();
    expect(toCredentialInfo({ ...base, type: undefined })).toBeUndefined();
  });

  it("入力を変えない", () => {
    const input: DebugTokenData = { ...base, scopes: [...ALL_SCOPES] };
    const snapshot = JSON.stringify(input);
    toCredentialInfo(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("registerToken の引数", () => {
  it("引数があれば固定文言で失敗する（引数の値は出さない）", async () => {
    await expect(registerToken(["--bogus", "https://x/?access_token=SECRET"])).rejects.toThrow("register-token は引数を取らない");
    await expect(registerToken(["extra"])).rejects.toThrow("register-token は引数を取らない");
  });
});
