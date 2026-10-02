/**
 * `src/lib/db.ts` の接続オプションの組み立て（R2 設計 2.2 章、10.1 章）。接続はしない。
 */
import { afterAll, describe, expect, it } from "vitest";
import { buildConnectionOptions, closeAllDb, getDb } from "@/lib/db";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";

afterAll(async () => {
  await closeAllDb();
});

describe("getDb（接続はしない。postgres.js の options を見る）", () => {
  it("URL の ?sslmode=require は無視され、CA がなければ ssl: false、あれば検証つき", () => {
    const url = "postgresql://web_app:web_app_local@127.0.0.1:54322/postgres?sslmode=require";
    expect(getDb(url).options.ssl).toBe(false);
    expect(getDb(url, { sslCa: PEM }).options.ssl).toEqual({ ca: [PEM], rejectUnauthorized: true });
    expect(getDb(url, { poolMode: "transaction" }).options.prepare).toBe(false);
  });
});

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
