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

describe("alertFields: R6 の低下の通知（S1）", () => {
  it("non_follower_reach_drop の鍵は alert、account、days だけ。follower_drop は alert、account だけ", () => {
    const reach = alertFields({ kind: "non_follower_reach_drop", ordinal: 1, total: 2, recentDays: 7, baseDays: 28 });
    expect(Object.keys(reach)).toEqual(["alert", "account", "days"]);
    expect(reach).toEqual({ alert: "non_follower_reach_drop", account: "1/2", days: "7/28" });
    const followers = alertFields({ kind: "follower_drop", ordinal: 2, total: 2 });
    expect(Object.keys(followers)).toEqual(["alert", "account"]);
    expect(followers).toEqual({ alert: "follower_drop", account: "2/2" });
  });

  it("Logger を通した行の形（4.4 節）", () => {
    const lines: string[] = [];
    const log = createLogger("info", new SecretRegistry(), (line) => lines.push(line), () => NOW);
    log.warn(alertFields({ kind: "non_follower_reach_drop", ordinal: 1, total: 1, recentDays: 7, baseDays: 28 }));
    log.warn(alertFields({ kind: "non_follower_reach_drop", ordinal: 2, total: 3, recentDays: 5, baseDays: 20 }));
    log.warn(alertFields({ kind: "follower_drop", ordinal: 1, total: 1 }));
    expect(lines).toEqual([
      "2026-10-01T05:30:00.000Z WARN  alert=non_follower_reach_drop account=1/1 days=7/28",
      "2026-10-01T05:30:00.000Z WARN  alert=non_follower_reach_drop account=2/3 days=5/20",
      "2026-10-01T05:30:00.000Z WARN  alert=follower_drop account=1/1",
    ]);
  });
});

/** `readNonFollowerReachWindows` の SQL が返す 1 行（postgres.js は bigint を文字列で返す） */
interface FakeWindowsRow {
  recent_days: number;
  recent_num: string | null;
  recent_den: string | null;
  base_days: number;
  base_num: string | null;
  base_den: string | null;
  latest: string;
}

interface FakeSignals {
  /** `account_daily_wide` の行。省略は「日次指標がない」（0 行） */
  windows?: FakeWindowsRow;
  /** 直近 7 日の投稿数 */
  posts?: number;
  /** `profile_daily` の新しい順 */
  followers?: { captured_on: string; followers_count: number }[];
}

/** 実在しない UUID の形の架空のアカウント */
const FAKE_ACCOUNT = { id: "00000000-0000-4000-8000-000000000001", status: "active" } as unknown as AccountRow;

/**
 * postgres.js のタグ付きテンプレートの偽物。SQL の文面で読む先を見分けて固定の行を返し、R6 の 3 つの読み出しの順を記録する。
 * credential は valid で残り 89 日、stories は success × 2、Vision の利用は 0（どれも該当しない）
 */
function fakeDb(signals: FakeSignals): { db: Db; reads: string[] } {
  const reads: string[] = [];
  const db = async (strings: TemplateStringsArray): Promise<unknown[]> => {
    const sql = strings.join("?");
    if (sql.includes("private.credentials")) return [{ status: "valid", data_access_expires_at: new Date(NOW.getTime() + 89 * DAY_MS) }];
    if (sql.includes("public.job_runs")) return [{ status: "success", started_at: NOW }, { status: "success", started_at: NOW }];
    if (sql.includes("public.ocr_usage")) return [{ units: 0, videos: 0 }];
    if (sql.includes("public.account_daily_wide")) {
      reads.push("account_daily_wide");
      return signals.windows ? [signals.windows] : [];
    }
    if (sql.includes("public.media")) {
      reads.push("media");
      return [{ posts: signals.posts ?? 0 }];
    }
    if (sql.includes("public.profile_daily")) {
      reads.push("profile_daily");
      return signals.followers ?? [];
    }
    throw new Error("想定しない読み出し");
  };
  return { db: db as unknown as Db, reads };
}

/** 基準 約 41.1%（4111/10009）、直近 約 31.0%（3103/10007）で約 10.1 pt の低下。値は架空で、桁は実データに近い */
const DROP_WINDOWS: FakeWindowsRow = {
  recent_days: 7,
  recent_num: "3103",
  recent_den: "10007",
  base_days: 28,
  base_num: "4111",
  base_den: "10009",
  latest: "2026-09-30",
};

/** 合計やフォロワー数の値がログに出ないことの確認に使う（DROP_WINDOWS と FOLLOWER_DROP の数字） */
const SECRET_NUMBERS = ["3103", "10007", "4111", "10009", "1234", "1200"];

const FOLLOWER_DROP = [
  { captured_on: "2026-10-01", followers_count: 1200 },
  { captured_on: "2026-09-30", followers_count: 1234 },
];

describe("runCheckAlerts: R6 の低下の通知（偽の DB で読み出しとログを確かめる）", () => {
  it("daily は account_daily_wide → media → profile_daily の順に読み、hourly では読まない", async () => {
    const daily = fakeDb({ windows: DROP_WINDOWS, posts: 3, followers: FOLLOWER_DROP });
    const { deps } = fakeDeps({ db: daily.db, listAccounts: async () => [FAKE_ACCOUNT] });
    await runCheckAlerts("daily", deps);
    expect(daily.reads).toEqual(["account_daily_wide", "media", "profile_daily"]);

    const hourly = fakeDb({ windows: DROP_WINDOWS, posts: 3, followers: FOLLOWER_DROP });
    const { deps: hourlyDeps, lines } = fakeDeps({ db: hourly.db, listAccounts: async () => [FAKE_ACCOUNT] });
    await expect(runCheckAlerts("hourly", hourlyDeps)).resolves.toBe(true);
    expect(hourly.reads).toEqual([]);
    expect(lines).toEqual(["2026-10-01T05:30:00.000Z INFO  command=check-alerts scope=hourly accounts=1 alerts=0"]);
  });

  it("日次指標がなければ media は読まず、2 種類とも判定しない（noHistory も立てない）", async () => {
    const { db, reads } = fakeDb({});
    const { deps, lines } = fakeDeps({ db, listAccounts: async () => [FAKE_ACCOUNT] });
    await expect(runCheckAlerts("daily", deps)).resolves.toBe(true);
    expect(reads).toEqual(["account_daily_wide", "profile_daily"]);
    expect(lines).toEqual(["2026-10-01T05:30:00.000Z INFO  command=check-alerts scope=daily accounts=1 alerts=0"]);
  });

  it("該当すれば WARN 2 行と INFO alerts=2 で false。合計値やフォロワー数は debug ログにも出ない（S1）", async () => {
    const { db } = fakeDb({ windows: DROP_WINDOWS, posts: 3, followers: FOLLOWER_DROP });
    const { deps, lines } = fakeDeps({ db, listAccounts: async () => [FAKE_ACCOUNT] });
    await expect(runCheckAlerts("daily", deps)).resolves.toBe(false);
    expect(lines).toEqual([
      "2026-10-01T05:30:00.000Z WARN  alert=non_follower_reach_drop account=1/1 days=7/28",
      "2026-10-01T05:30:00.000Z WARN  alert=follower_drop account=1/1",
      "2026-10-01T05:30:00.000Z INFO  command=check-alerts scope=daily accounts=1 alerts=2",
    ]);
    const text = lines.join("\n");
    for (const value of SECRET_NUMBERS) expect(text).not.toContain(value);
    expect(text).not.toContain(FAKE_ACCOUNT.id);
    expect(text).not.toMatch(/\d+(\.\d+)?%/);
  });

  it("履歴が足りなければ INFO に reason=no_history と no_history=<kinds>（固定の語のカンマ区切り）", async () => {
    // 直近 4 日しか使えず、フォロワーの記録は 1 件
    const { db } = fakeDb({
      windows: { ...DROP_WINDOWS, recent_days: 4 },
      posts: 3,
      followers: [{ captured_on: "2026-10-01", followers_count: 1200 }],
    });
    const { deps, lines } = fakeDeps({ db, listAccounts: async () => [FAKE_ACCOUNT] });
    await expect(runCheckAlerts("daily", deps)).resolves.toBe(true);
    expect(lines).toEqual([
      "2026-10-01T05:30:00.000Z INFO  command=check-alerts scope=daily accounts=1 alerts=0 reason=no_history no_history=non_follower_reach_drop,follower_drop",
    ]);
  });

  it("使えた日が 0 日（sum が null）は 0 として no_history", async () => {
    const { db } = fakeDb({
      windows: { recent_days: 0, recent_num: null, recent_den: null, base_days: 0, base_num: null, base_den: null, latest: "2026-09-30" },
      posts: 0,
      followers: FOLLOWER_DROP,
    });
    const { deps, lines } = fakeDeps({ db, listAccounts: async () => [FAKE_ACCOUNT] });
    await expect(runCheckAlerts("daily", deps)).resolves.toBe(false);
    expect(lines).toEqual([
      "2026-10-01T05:30:00.000Z WARN  alert=follower_drop account=1/1",
      "2026-10-01T05:30:00.000Z INFO  command=check-alerts scope=daily accounts=1 alerts=1 no_history=non_follower_reach_drop",
    ]);
  });

  it("投稿がなく見送れば INFO に no_posts=non_follower_reach_drop。該当があっても no_history= は出す（reason は出ない）", async () => {
    const noPosts = fakeDb({ windows: DROP_WINDOWS, posts: 0, followers: FOLLOWER_DROP.map((row) => ({ ...row, followers_count: 1234 })) });
    const first = fakeDeps({ db: noPosts.db, listAccounts: async () => [FAKE_ACCOUNT] });
    await expect(runCheckAlerts("daily", first.deps)).resolves.toBe(true);
    expect(first.lines).toEqual([
      "2026-10-01T05:30:00.000Z INFO  command=check-alerts scope=daily accounts=1 alerts=0 no_posts=non_follower_reach_drop",
    ]);

    const mixed = fakeDb({ windows: DROP_WINDOWS, posts: 3, followers: [{ captured_on: "2026-10-01", followers_count: 1200 }] });
    const second = fakeDeps({ db: mixed.db, listAccounts: async () => [FAKE_ACCOUNT] });
    await expect(runCheckAlerts("daily", second.deps)).resolves.toBe(false);
    expect(second.lines).toEqual([
      "2026-10-01T05:30:00.000Z WARN  alert=non_follower_reach_drop account=1/1 days=7/28",
      "2026-10-01T05:30:00.000Z INFO  command=check-alerts scope=daily accounts=1 alerts=1 no_history=follower_drop",
    ]);
  });
});
