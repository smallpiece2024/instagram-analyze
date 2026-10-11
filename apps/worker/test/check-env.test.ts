/**
 * `commands/check-env.ts` の純粋関数（R4.1 設計 3.8 節、8 章「単体（ジョブ）」の `check-env` の鍵の表示）。
 * ffmpeg と環境変数には触らない
 */
import { describe, expect, it } from "vitest";
import { describeVisionKey } from "../src/commands/check-env.js";

describe("describeVisionKey（check-env に出す Vision の鍵の状態）", () => {
  it("あり／なし／形が不正だけを出し、鍵の値（client_email、private_key）を含めない", () => {
    const privateKey = "-----BEGIN PRIVATE KEY-----\nSECRET_PEM_BODY\n-----END PRIVATE KEY-----\n";
    const clientEmail = "worker@fake-project.iam.gserviceaccount.com";
    const shown = describeVisionKey({ ok: true, key: { clientEmail, privateKey } });
    expect(shown).toBe("あり");
    expect(shown).not.toContain(clientEmail);
    expect(shown).not.toContain("SECRET_PEM_BODY");
    expect(describeVisionKey({ ok: false, reason: "missing" })).toBe("なし");
    expect(describeVisionKey({ ok: false, reason: "invalid" })).toBe("形が不正");
  });
});
