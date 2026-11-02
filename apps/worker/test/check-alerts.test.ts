/**
 * `commands/check-alerts.ts` の引数、ログの項目、DB に触れない経路（アカウント 0 件、一覧の失敗、simulate）。
 * DB を読む経路は `test/db/check-alerts.test.ts`（結合）
 */
import { describe, expect, it } from "vitest";
import type { Db } from "../src/db/client.js";
import type { AccountRow } from "../src/db/types.js";
import { alertFields, parseScope, runCheckAlerts, SCOPE_ARG_ERROR, type CheckAlertsDeps } from "../src/commands/check-alerts.js";
import type { Alert } from "../src/jobs/alerts.js";
import { createLogger, SecretRegistry } from "../src/lib/log.js";

const NOW = new Date("2026-10-01T05:30:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
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
    deps: {
      config: { simulateAlert: false, videoTextMonthlyUnitLimit: 1000, videoTextMonthlyMaxVideos: 30 },
      db,
      log,
      secrets,
      now: () => NOW,
      listAccounts: async () => [],
      ...overrides,
    },
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
      { kind: "ocr_monthly_cap", ordinal: 1, total: 2, units: 1000, videos: 3 },
    ];
    expect(alerts.map(alertFields)).toEqual([
      { alert: "simulated" },
      { alert: "token", account: "1/2", days_left: 13, status: "valid" },
      { alert: "token", account: "2/2", days_left: "unknown", status: "none" },
      { alert: "stories_failed", account: "1/2", runs: 2 },
      { alert: "stories_skipped", account: "2/2", runs: 3 },
      { alert: "ocr_monthly_cap", account: "1/2", units: 1000, videos: 3 },
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
    const { deps, lines } = fakeDeps({ config: { simulateAlert: true, videoTextMonthlyUnitLimit: 1000, videoTextMonthlyMaxVideos: 30 } });
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

/** 実在しない UUID の形の架空のアカウント */
const FAKE_ACCOUNT = { id: "00000000-0000-4000-8000-000000000001", status: "active" } as unknown as AccountRow;

/**
 * postgres.js のタグ付きテンプレートの偽物。SQL の文面で読む先を見分けて固定の行を返し、`ocr_usage` を読んだことを記録する。
 * credential は valid で残り 89 日、stories は success × 2（どちらも該当しない）
 */
function fakeDb(ocr: { units: number; videos: number }): { db: Db; reads: string[] } {
  const reads: string[] = [];
  const db = async (strings: TemplateStringsArray): Promise<unknown[]> => {
    const sql = strings.join("?");
    if (sql.includes("private.credentials")) return [{ status: "valid", data_access_expires_at: new Date(NOW.getTime() + 89 * DAY_MS) }];
    if (sql.includes("public.job_runs")) return [{ status: "success", started_at: NOW }, { status: "success", started_at: NOW }];
    if (sql.includes("public.ocr_usage")) {
      reads.push("ocr_usage");
      return [ocr];
    }
    throw new Error("想定しない読み出し");
  };
  return { db: db as unknown as Db, reads };
}

describe("runCheckAlerts: Vision の月の上限（偽の DB で読み出しとログを確かめる）", () => {
  it("daily は ocr_usage を読み、hourly では読まない", async () => {
    const daily = fakeDb({ units: 0, videos: 0 });
    const { deps } = fakeDeps({ db: daily.db, listAccounts: async () => [FAKE_ACCOUNT] });
    await expect(runCheckAlerts("daily", deps)).resolves.toBe(true);
    expect(daily.reads).toEqual(["ocr_usage"]);
    const hourly = fakeDb({ units: 0, videos: 0 });
    const { deps: hourlyDeps } = fakeDeps({ db: hourly.db, listAccounts: async () => [FAKE_ACCOUNT] });
    await expect(runCheckAlerts("hourly", hourlyDeps)).resolves.toBe(true);
    expect(hourly.reads).toEqual([]);
  });

  it("上限ちょうどで WARN alert=ocr_monthly_cap と INFO alerts=1 を出して false", async () => {
    const { db } = fakeDb({ units: 1000, videos: 3 });
    const { deps, lines } = fakeDeps({ db, listAccounts: async () => [FAKE_ACCOUNT] });
    await expect(runCheckAlerts("daily", deps)).resolves.toBe(false);
    expect(lines).toEqual([
      "2026-10-01T05:30:00.000Z WARN  alert=ocr_monthly_cap account=1/1 units=1000 videos=3",
      "2026-10-01T05:30:00.000Z INFO  command=check-alerts scope=daily accounts=1 alerts=1",
    ]);
  });
});
