/**
 * `commands/check-alerts.ts` の引数、ログの項目、DB に触れない経路（アカウント 0 件、一覧の失敗、simulate）。
 * DB を読む経路は `test/db/check-alerts.test.ts`（結合）
 */
import { describe, expect, it } from "vitest";
import type { Db } from "../src/db/client.js";
import { alertFields, parseScope, runCheckAlerts, SCOPE_ARG_ERROR, type CheckAlertsDeps } from "../src/commands/check-alerts.js";
import type { Alert } from "../src/jobs/alerts.js";
import { createLogger, SecretRegistry } from "../src/lib/log.js";

const NOW = new Date("2026-10-01T05:30:00Z");
const FAKE_DB_URL = "postgresql://postgres.abcdefghijklmnop:pw-secret@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres";

/** postgres.js の PostgresError と同じ形（name と SQLSTATE の code）の偽物 */
function fakePostgresError(code: string, message: string): Error {
  return Object.assign(new Error(message), { name: "PostgresError", code });
}

function fakeDeps(overrides: Partial<CheckAlertsDeps> = {}): { deps: CheckAlertsDeps; lines: string[] } {
  const lines: string[] = [];
  const secrets = new SecretRegistry();
  secrets.addUrlParts(FAKE_DB_URL);
  const log = createLogger("debug", secrets, (line) => lines.push(line), () => NOW);
  // DB には触れない経路だけを試す（アカウントが 0 件なら読み出しは起きない）
  const db = {} as unknown as Db;
  return {
    deps: { config: { simulateAlert: false }, db, log, secrets, now: () => NOW, listAccounts: async () => [], ...overrides },
    lines,
  };
}

describe("parseScope", () => {
  it("--scope hourly|daily だけを受け付ける", () => {
    expect(parseScope(["--scope", "hourly"])).toEqual({ ok: true, scope: "hourly" });
    expect(parseScope(["--scope", "daily"])).toEqual({ ok: true, scope: "daily" });
  });

  it("省略、不明な値、余分な引数、位置引数は固定文言のエラー（値を含めない）", () => {
    for (const args of [[], ["--scope", "weekly-secret"], ["--scope", "hourly", "--full"], ["hourly"], ["--scope"]]) {
      const parsed = parseScope(args);
      expect(parsed).toEqual({ ok: false, error: SCOPE_ARG_ERROR });
      expect(SCOPE_ARG_ERROR).not.toContain("weekly-secret");
    }
  });
});

describe("alertFields", () => {
  it("account は ordinal/total の連番。days_left が undefined なら unknown", () => {
    const alerts: Alert[] = [
      { kind: "simulated" },
      { kind: "token", ordinal: 1, total: 2, daysLeft: 13, status: "valid" },
      { kind: "token", ordinal: 2, total: 2, daysLeft: undefined, status: "none" },
      { kind: "stories_failed", ordinal: 1, total: 2, runs: 2 },
      { kind: "stories_skipped", ordinal: 2, total: 2, runs: 3 },
    ];
    expect(alerts.map(alertFields)).toEqual([
      { alert: "simulated" },
      { alert: "token", account: "1/2", days_left: 13, status: "valid" },
      { alert: "token", account: "2/2", days_left: "unknown", status: "none" },
      { alert: "stories_failed", account: "1/2", runs: 2 },
      { alert: "stories_skipped", account: "2/2", runs: 3 },
    ]);
  });

  it("Logger を通した行の形", () => {
    const lines: string[] = [];
    const log = createLogger("info", new SecretRegistry(), (line) => lines.push(line), () => NOW);
    log.warn(alertFields({ kind: "token", ordinal: 1, total: 3, daysLeft: 13, status: "valid" }));
    log.warn(alertFields({ kind: "token", ordinal: 1, total: 3, daysLeft: undefined, status: "valid" }));
    log.warn(alertFields({ kind: "stories_failed", ordinal: 2, total: 3, runs: 2 }));
    expect(lines).toEqual([
      "2026-10-01T05:30:00.000Z WARN  alert=token account=1/3 days_left=13 status=valid",
      "2026-10-01T05:30:00.000Z WARN  alert=token account=1/3 days_left=unknown status=valid",
      "2026-10-01T05:30:00.000Z WARN  alert=stories_failed account=2/3 runs=2",
    ]);
    // ID、ユーザー名、URL、トークンに当たるものは行に含まれない
    for (const line of lines) {
      expect(line).not.toContain("://");
      expect(line).not.toMatch(/\d{10}/);
    }
  });
});

describe("runCheckAlerts（DB に触れない経路）", () => {
  it("アカウントが 0 件なら INFO alerts=0 で true", async () => {
    const { deps, lines } = fakeDeps();
    await expect(runCheckAlerts("hourly", deps)).resolves.toBe(true);
    expect(lines).toEqual(["2026-10-01T05:30:00.000Z INFO  command=check-alerts scope=hourly accounts=0 alerts=0 reason=no_accounts"]);
  });

  it("simulate なら WARN alert=simulated を出して false", async () => {
    const { deps, lines } = fakeDeps({ config: { simulateAlert: true } });
    await expect(runCheckAlerts("daily", deps)).resolves.toBe(false);
    expect(lines).toEqual([
      "2026-10-01T05:30:00.000Z WARN  alert=simulated",
      "2026-10-01T05:30:00.000Z INFO  command=check-alerts scope=daily accounts=0 alerts=1",
    ]);
  });

  it("DB の失敗は ERROR error_code=<SQLSTATE> class=db で false（alert と区別できる）", async () => {
    const { deps, lines } = fakeDeps({
      listAccounts: async () => {
        throw fakePostgresError("28P01", 'password authentication failed for user "postgres.abcdefghijklmnop"');
      },
    });
    await expect(runCheckAlerts("hourly", deps)).resolves.toBe(false);
    expect(lines[0]).toBe("2026-10-01T05:30:00.000Z ERROR command=check-alerts scope=hourly error_code=28P01 class=db");
    expect(lines[1]).toBe('2026-10-01T05:30:00.000Z DEBUG command=check-alerts scope=hourly error="DB 接続に失敗（SQLSTATE 28P01）"');
    expect(lines.join("\n")).not.toContain("abcdefghijklmnop");
  });

  it("TLS の失敗は error_code=<TLS のコード> class=db。ホスト名は出ない", async () => {
    const { deps, lines } = fakeDeps({
      listAccounts: async () => {
        throw Object.assign(
          new Error("Hostname/IP does not match certificate's altnames: Host: aws-0-ap-northeast-1.pooler.supabase.com. is not in the cert's altnames"),
          { code: "ERR_TLS_CERT_ALTNAME_INVALID" },
        );
      },
    });
    await expect(runCheckAlerts("daily", deps)).resolves.toBe(false);
    expect(lines[0]).toBe("2026-10-01T05:30:00.000Z ERROR command=check-alerts scope=daily error_code=ERR_TLS_CERT_ALTNAME_INVALID class=db");
    const text = lines.join("\n");
    expect(text).not.toContain("pooler.supabase.com");
    expect(text).not.toContain("altnames");
  });
});
