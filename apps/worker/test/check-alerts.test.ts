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

const MB = 1024 * 1024;
const CONFIG: CheckAlertsDeps["config"] = {
  simulateAlert: false,
  videoTextMonthlyUnitLimit: 1000,
  videoTextMonthlyMaxVideos: 30,
  dbSizeLimitMb: 8192,
  storageSizeLimitMb: 102400,
};

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
      config: CONFIG,
      db,
      log,
      secrets,
      now: () => NOW,
      listAccounts: async () => [],
      // 所要と容量は DB を読まずに固定する（回がない。容量は 2026-11-21 の実測に近い値で、該当しない）
      readLatestRunSeconds: async () => undefined,
      readCapacity: async () => ({ dbBytes: 52 * MB, storageBytes: 2 * MB }),
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
      { kind: "run_duration", seconds: 901, limitSeconds: 900 },
      { kind: "db_size", usedMb: 6554, limitMb: 8192, percent: 80 },
      { kind: "storage_size", usedMb: 90000, limitMb: 102400, percent: 87 },
    ];
    expect(alerts.map(alertFields)).toEqual([
      { alert: "simulated" },
      { alert: "token", account: "1/2", days_left: 13, status: "valid" },
      { alert: "token", account: "2/2", days_left: "unknown", status: "none" },
      { alert: "stories_failed", account: "1/2", runs: 2 },
      { alert: "stories_skipped", account: "2/2", runs: 3 },
      { alert: "ocr_monthly_cap", account: "1/2", units: 1000, videos: 3 },
      // 全アカウントの合計の 3 つには account が付かない
      { alert: "run_duration", seconds: 901, limit_seconds: 900 },
      { alert: "db_size", used_mb: 6554, limit_mb: 8192, percent: 80 },
      { alert: "storage_size", used_mb: 90000, limit_mb: 102400, percent: 87 },
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
    const { deps, lines } = fakeDeps({ config: { ...CONFIG, simulateAlert: true } });
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

describe("runCheckAlerts: 上限の警告（課題 ia-6ui。読み出しを差し替えてログを確かめる）", () => {
  it("所要は hourly でも daily でも読み、容量は daily だけ読む（アカウントが 0 件でも）", async () => {
    for (const [scope, expected] of [["hourly", ["duration"]], ["daily", ["duration", "capacity"]]] as const) {
      const reads: string[] = [];
      const { deps } = fakeDeps({
        readLatestRunSeconds: async () => {
          reads.push("duration");
          return 12;
        },
        readCapacity: async () => {
          reads.push("capacity");
          return { dbBytes: 52 * MB, storageBytes: 2 * MB };
        },
      });
      await expect(runCheckAlerts(scope, deps)).resolves.toBe(true);
      expect(reads).toEqual(expected);
    }
  });

  it("所要が 15 分を超えたら WARN alert=run_duration で false。account= は付かず、reason=no_accounts も出ない", async () => {
    const { deps, lines } = fakeDeps({ readLatestRunSeconds: async () => 1234.5 });
    await expect(runCheckAlerts("hourly", deps)).resolves.toBe(false);
    expect(lines).toEqual([
      "2026-10-01T05:30:00.000Z WARN  alert=run_duration seconds=1235 limit_seconds=900",
      "2026-10-01T05:30:00.000Z INFO  command=check-alerts scope=hourly accounts=0 alerts=1",
    ]);
  });

  it("900 秒ちょうどは警告しない（既存の reason=no_accounts のまま）", async () => {
    const { deps, lines } = fakeDeps({ readLatestRunSeconds: async () => 900 });
    await expect(runCheckAlerts("hourly", deps)).resolves.toBe(true);
    expect(lines).toEqual(["2026-10-01T05:30:00.000Z INFO  command=check-alerts scope=hourly accounts=0 alerts=0 reason=no_accounts"]);
  });

  it("daily で容量が 8 割以上なら WARN alert=db_size と alert=storage_size。hourly では出ない", async () => {
    const readCapacity = async (): Promise<{ dbBytes: number; storageBytes: number }> => ({ dbBytes: 7000 * MB, storageBytes: 102400 * MB });
    const daily = fakeDeps({ readCapacity });
    await expect(runCheckAlerts("daily", daily.deps)).resolves.toBe(false);
    expect(daily.lines).toEqual([
      "2026-10-01T05:30:00.000Z WARN  alert=db_size used_mb=7000 limit_mb=8192 percent=85",
      "2026-10-01T05:30:00.000Z WARN  alert=storage_size used_mb=102400 limit_mb=102400 percent=100",
      "2026-10-01T05:30:00.000Z INFO  command=check-alerts scope=daily accounts=0 alerts=2",
    ]);
    const hourly = fakeDeps({ readCapacity });
    await expect(runCheckAlerts("hourly", hourly.deps)).resolves.toBe(true);
  });

  it("上限は設定の値を使う（小さくすれば実測に近い値でも該当する）", async () => {
    const { deps, lines } = fakeDeps({ config: { ...CONFIG, dbSizeLimitMb: 60 } });
    await expect(runCheckAlerts("daily", deps)).resolves.toBe(false);
    expect(lines[0]).toBe("2026-10-01T05:30:00.000Z WARN  alert=db_size used_mb=52 limit_mb=60 percent=86");
  });

  it("所要や容量の読み出しの失敗は ERROR class=db で false（alert と区別できる）", async () => {
    const failing = async (): Promise<never> => {
      throw fakePostgresError("42501", "permission denied for function capacity_snapshot");
    };
    const duration = fakeDeps({ readLatestRunSeconds: failing });
    await expect(runCheckAlerts("hourly", duration.deps)).resolves.toBe(false);
    expect(duration.lines[0]).toBe("2026-10-01T05:30:00.000Z ERROR command=check-alerts scope=hourly error_code=42501 class=db");
    const capacity = fakeDeps({ readCapacity: failing });
    await expect(runCheckAlerts("daily", capacity.deps)).resolves.toBe(false);
    expect(capacity.lines[0]).toBe("2026-10-01T05:30:00.000Z ERROR command=check-alerts scope=daily error_code=42501 class=db");
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
