/**
 * `src/lib/db.ts` の接続オプションの組み立て（R2 設計 2.2 章、10.1 章）。接続はしない。
 */
import { describe, expect, it } from "vitest";
import { buildConnectionOptions } from "@/lib/db";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";

describe("buildConnectionOptions", () => {
  it("DATABASE_POOL_MODE 未設定（session）→ prepare は既定（true）。transaction → prepare: false", () => {
    expect(buildConnectionOptions({}).prepare).toBe(true);
    expect(buildConnectionOptions({ poolMode: "session" }).prepare).toBe(true);
    expect(buildConnectionOptions({ poolMode: "transaction" }).prepare).toBe(false);
  });

  it("DATABASE_SSL_CA あり → ssl: { ca: [pem], rejectUnauthorized: true }。なし → ssl: false（URL の ?sslmode= に頼らない）", () => {
    expect(buildConnectionOptions({ sslCa: PEM }).ssl).toEqual({ ca: [PEM], rejectUnauthorized: true });
    expect(buildConnectionOptions({}).ssl).toBe(false);
    expect(buildConnectionOptions({ sslCa: undefined }).ssl).toBe(false);
  });
});
