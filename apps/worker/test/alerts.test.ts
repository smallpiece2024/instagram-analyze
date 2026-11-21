/**
 * `jobs/alerts.ts` の `evaluateAlerts`（R2 設計 5.2 章の表、10.1 章）。DB と API に触らない
 */
import { describe, expect, it } from "vitest";
import {
  CAPACITY_WARN_RATIO,
  evaluateAlerts,
  NO_CREDENTIAL_STATUS,
  RUN_DURATION_WARN_SECONDS,
  STORIES_FAILED_RUNS,
  STORIES_SKIPPED_RUNS,
  type AlertAccount,
  type AlertInput,
} from "../src/jobs/alerts.js";
import { DATA_ACCESS_WARN_DAYS } from "../src/jobs/token-check.js";

const NOW = new Date("2026-10-01T05:30:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function expiresIn(ms: number): Date {
  return new Date(NOW.getTime() + ms);
}

function runs(...statuses: string[]): { status: string }[] {
  return statuses.map((status) => ({ status }));
}

/** 既定は active、valid で残り 89 日、stories は success × 3（該当なし） */
function account(overrides: Partial<AlertAccount> = {}): AlertAccount {
  return {
    ordinal: 1,
    status: "active",
    credential: { status: "valid", dataAccessExpiresAt: expiresIn(89 * DAY_MS + 60 * 60 * 1000) },
    recentStoriesRuns: runs("success", "success", "success"),
    ...overrides,
  };
}

function input(...accounts: AlertAccount[]): AlertInput {
  return { accounts: accounts.map((a, index) => ({ ...a, ordinal: index + 1 })) };
}

describe("evaluateAlerts", () => {
  it("定数", () => {
    expect(STORIES_FAILED_RUNS).toBe(2);
    expect(STORIES_SKIPPED_RUNS).toBe(3);
    expect(NO_CREDENTIAL_STATUS).toBe("none");
    expect(DATA_ACCESS_WARN_DAYS).toBe(14);
  });

  it("該当なしなら alerts は空で noHistory は false", () => {
    expect(evaluateAlerts(input(account()), NOW, "daily", false)).toEqual({ alerts: [], noHistory: false, noHistoryKinds: [] });
    expect(evaluateAlerts(input(account()), NOW, "hourly", false)).toEqual({ alerts: [], noHistory: false, noHistoryKinds: [] });
  });

  describe("トークンの期限（daily のみ）", () => {
    it("残り 13 日は警告、14 日ちょうどは警告しない、15 日は警告しない（token_check と同じ切り捨て）", () => {
      const at = (ms: number): AlertInput => input(account({ credential: { status: "valid", dataAccessExpiresAt: expiresIn(ms) } }));
      expect(evaluateAlerts(at(13 * DAY_MS), NOW, "daily", false).alerts).toEqual([
        { kind: "token", ordinal: 1, total: 1, daysLeft: 13, status: "valid" },
      ]);
      expect(evaluateAlerts(at(14 * DAY_MS - 1000), NOW, "daily", false).alerts).toEqual([
        { kind: "token", ordinal: 1, total: 1, daysLeft: 13, status: "valid" },
      ]);
      expect(evaluateAlerts(at(14 * DAY_MS), NOW, "daily", false).alerts).toEqual([]);
      expect(evaluateAlerts(at(15 * DAY_MS), NOW, "daily", false).alerts).toEqual([]);
    });

    it("期限を過ぎていれば負の日数で警告", () => {
      const result = evaluateAlerts(input(account({ credential: { status: "valid", dataAccessExpiresAt: expiresIn(-1000) } })), NOW, "daily", false);
      expect(result.alerts).toEqual([{ kind: "token", ordinal: 1, total: 1, daysLeft: -1, status: "valid" }]);
    });

    it("期限が不明（null）で valid でも警告する（daysLeft は undefined。フェイルクローズ）", () => {
      const result = evaluateAlerts(input(account({ credential: { status: "valid", dataAccessExpiresAt: null } })), NOW, "daily", false);
      expect(result.alerts).toEqual([{ kind: "token", ordinal: 1, total: 1, daysLeft: undefined, status: "valid" }]);
    });

    it("credential がなければ status=none で警告", () => {
      const result = evaluateAlerts(input(account({ credential: null })), NOW, "daily", false);
      expect(result.alerts).toEqual([{ kind: "token", ordinal: 1, total: 1, daysLeft: undefined, status: NO_CREDENTIAL_STATUS }]);
    });

    it("status が valid 以外なら残り日数に関わらず警告（expired、insufficient_scope、error）", () => {
      for (const status of ["expired", "insufficient_scope", "error"]) {
        const result = evaluateAlerts(
          input(account({ credential: { status, dataAccessExpiresAt: expiresIn(89 * DAY_MS) } })),
          NOW,
          "daily",
          false,
        );
        expect(result.alerts).toEqual([{ kind: "token", ordinal: 1, total: 1, daysLeft: 89, status }]);
      }
    });

    it("hourly ではトークンを判定しない", () => {
      const bad = input(account({ credential: null }), account({ credential: { status: "expired", dataAccessExpiresAt: null } }));
      expect(evaluateAlerts(bad, NOW, "hourly", false).alerts).toEqual([]);
      expect(evaluateAlerts(bad, NOW, "daily", false).alerts).toHaveLength(2);
    });
  });

  describe("stories の連続失敗（両方の scope）", () => {
    it("failed,failed は stories_failed（runs=2）。hourly でも daily でも", () => {
      const result = input(account({ recentStoriesRuns: runs("failed", "failed") }));
      for (const scope of ["hourly", "daily"] as const) {
        expect(evaluateAlerts(result, NOW, scope, false)).toEqual({
          alerts: [{ kind: "stories_failed", ordinal: 1, total: 1, runs: 2 }],
          noHistory: false,
          noHistoryKinds: [],
        });
      }
    });

    it("failed,partial と failed,skipped は失敗に数えない", () => {
      expect(evaluateAlerts(input(account({ recentStoriesRuns: runs("failed", "partial") })), NOW, "hourly", false).alerts).toEqual([]);
      expect(evaluateAlerts(input(account({ recentStoriesRuns: runs("failed", "skipped") })), NOW, "hourly", false).alerts).toEqual([]);
      expect(evaluateAlerts(input(account({ recentStoriesRuns: runs("success", "failed", "failed") })), NOW, "hourly", false).alerts).toEqual([]);
    });

    it("running は除いて数える（running,failed,failed → 2 回連続）", () => {
      expect(evaluateAlerts(input(account({ recentStoriesRuns: runs("running", "failed", "failed") })), NOW, "hourly", false)).toEqual({
        alerts: [{ kind: "stories_failed", ordinal: 1, total: 1, runs: 2 }],
        noHistory: false,
        noHistoryKinds: [],
      });
    });

    it("1 件だけ、0 件は判定せず noHistory", () => {
      expect(evaluateAlerts(input(account({ recentStoriesRuns: runs("failed") })), NOW, "hourly", false)).toEqual({ alerts: [], noHistory: true, noHistoryKinds: ["stories"] });
      expect(evaluateAlerts(input(account({ recentStoriesRuns: [] })), NOW, "hourly", false)).toEqual({ alerts: [], noHistory: true, noHistoryKinds: ["stories"] });
      expect(evaluateAlerts(input(account({ recentStoriesRuns: runs("running", "failed") })), NOW, "hourly", false)).toEqual({
        alerts: [],
        noHistory: true,
        noHistoryKinds: ["stories"],
      });
    });

    it("履歴が足りないアカウントがあっても、他のアカウントの該当は出す", () => {
      const result = evaluateAlerts(
        input(account({ recentStoriesRuns: [] }), account({ recentStoriesRuns: runs("failed", "failed") })),
        NOW,
        "hourly",
        false,
      );
      expect(result).toEqual({ alerts: [{ kind: "stories_failed", ordinal: 2, total: 2, runs: 2 }], noHistory: true, noHistoryKinds: ["stories"] });
    });
  });

  describe("stories の連続見送り", () => {
    it("skipped × 3 は stories_skipped（runs=3）。daily の回でも同じ", () => {
      expect(evaluateAlerts(input(account({ recentStoriesRuns: runs("skipped", "skipped", "skipped") })), NOW, "daily", false).alerts).toEqual([
        { kind: "stories_skipped", ordinal: 1, total: 1, runs: 3 },
      ]);
      expect(evaluateAlerts(input(account({ recentStoriesRuns: runs("skipped", "skipped", "skipped") })), NOW, "hourly", false)).toEqual({
        alerts: [{ kind: "stories_skipped", ordinal: 1, total: 1, runs: 3 }],
        noHistory: false,
        noHistoryKinds: [],
      });
    });

    it("skipped × 2 や skipped,skipped,success は該当しない。4 件目以降は見ない", () => {
      expect(evaluateAlerts(input(account({ recentStoriesRuns: runs("skipped", "skipped") })), NOW, "hourly", false).alerts).toEqual([]);
      expect(evaluateAlerts(input(account({ recentStoriesRuns: runs("skipped", "skipped", "success") })), NOW, "hourly", false).alerts).toEqual([]);
      expect(evaluateAlerts(input(account({ recentStoriesRuns: runs("skipped", "skipped", "skipped", "failed") })), NOW, "hourly", false).alerts).toEqual([
        { kind: "stories_skipped", ordinal: 1, total: 1, runs: 3 },
      ]);
    });
  });

  it("paused、disconnected のアカウントは対象外（noHistory にもしない）", () => {
    for (const status of ["paused", "disconnected"]) {
      const result = evaluateAlerts(
        input(account({ status, credential: null, recentStoriesRuns: runs("failed", "failed") }), account({ status, recentStoriesRuns: [] })),
        NOW,
        "daily",
        false,
      );
      expect(result).toEqual({ alerts: [], noHistory: false, noHistoryKinds: [] });
    }
  });

  it("simulate は先頭に simulated を足し、本物の判定も続ける", () => {
    expect(evaluateAlerts(input(account()), NOW, "hourly", true)).toEqual({ alerts: [{ kind: "simulated" }], noHistory: false, noHistoryKinds: [] });
    expect(evaluateAlerts(input(account({ recentStoriesRuns: runs("failed", "failed") })), NOW, "hourly", true).alerts).toEqual([
      { kind: "simulated" },
      { kind: "stories_failed", ordinal: 1, total: 1, runs: 2 },
    ]);
    expect(evaluateAlerts({ accounts: [] }, NOW, "daily", true)).toEqual({ alerts: [{ kind: "simulated" }], noHistory: false, noHistoryKinds: [] });
  });

  it("複数アカウントは ordinal/total の連番（paused も total に数える）", () => {
    const result = evaluateAlerts(
      input(
        account({ credential: null }),
        account({ status: "paused", credential: null }),
        account({ credential: { status: "expired", dataAccessExpiresAt: null }, recentStoriesRuns: runs("failed", "failed") }),
      ),
      NOW,
      "daily",
      false,
    );
    expect(result.alerts).toEqual([
      { kind: "token", ordinal: 1, total: 3, daysLeft: undefined, status: "none" },
      { kind: "token", ordinal: 3, total: 3, daysLeft: undefined, status: "expired" },
      { kind: "stories_failed", ordinal: 3, total: 3, runs: 2 },
    ]);
  });

  it("入力を変えない", () => {
    const data = input(account({ recentStoriesRuns: runs("running", "failed", "failed", "skipped") }), account({ credential: null }));
    const snapshot = JSON.stringify(data);
    evaluateAlerts(data, NOW, "daily", true);
    expect(JSON.stringify(data)).toBe(snapshot);
  });
});

describe("evaluateAlerts: ocr_monthly_cap（R4.1 設計 3.3 節）", () => {
  const limits = { unitLimit: 1000, maxVideos: 30 };

  it("daily だけ。ユニットか本数が上限以上（>=）で該当。ちょうど上限も該当", () => {
    const over = account({ ocrMonthly: { units: 1000, videos: 3 } });
    expect(evaluateAlerts({ ...input(over), ocrLimits: limits }, NOW, "daily", false).alerts).toEqual([
      { kind: "ocr_monthly_cap", ordinal: 1, total: 1, units: 1000, videos: 3 },
    ]);
    expect(evaluateAlerts({ ...input(over), ocrLimits: limits }, NOW, "hourly", false).alerts).toEqual([]);
    const videos = account({ ocrMonthly: { units: 10, videos: 30 } });
    expect(evaluateAlerts({ ...input(videos), ocrLimits: limits }, NOW, "daily", false).alerts).toHaveLength(1);
    const under = account({ ocrMonthly: { units: 999, videos: 29 } });
    expect(evaluateAlerts({ ...input(under), ocrLimits: limits }, NOW, "daily", false).alerts).toEqual([]);
  });

  it("上限 0 なら利用 0 でも該当。利用を読んでいない、上限がない、active でないアカウントは判定しない", () => {
    const zero = account({ ocrMonthly: { units: 0, videos: 0 } });
    expect(evaluateAlerts({ ...input(zero), ocrLimits: { unitLimit: 0, maxVideos: 30 } }, NOW, "daily", false).alerts).toHaveLength(1);
    expect(evaluateAlerts({ ...input(account()), ocrLimits: limits }, NOW, "daily", false).alerts).toEqual([]);
    expect(evaluateAlerts(input(account({ ocrMonthly: { units: 5000, videos: 50 } })), NOW, "daily", false).alerts).toEqual([]);
    const paused = account({ status: "paused", ocrMonthly: { units: 5000, videos: 50 } });
    expect(evaluateAlerts({ ...input(paused), ocrLimits: limits }, NOW, "daily", false).alerts).toEqual([]);
  });
});

describe("evaluateAlerts: 上限の警告（課題 ia-6ui）", () => {
  const MB = 1024 * 1024;
  const capacityLimits = { dbLimitMb: 8192, storageLimitMb: 102400 };

  it("定数", () => {
    expect(RUN_DURATION_WARN_SECONDS).toBe(900);
    expect(CAPACITY_WARN_RATIO).toBe(0.8);
  });

  describe("run_duration（両方の scope）", () => {
    it("900 秒ちょうどは警告しない、901 秒は警告。hourly でも daily でも", () => {
      for (const scope of ["hourly", "daily"] as const) {
        expect(evaluateAlerts({ ...input(account()), latestRunSeconds: 900 }, NOW, scope, false).alerts).toEqual([]);
        expect(evaluateAlerts({ ...input(account()), latestRunSeconds: 901 }, NOW, scope, false).alerts).toEqual([
          { kind: "run_duration", seconds: 901, limitSeconds: 900 },
        ]);
      }
    });

    it("端数は切り上げて出す（900.4 秒は超えているので 901）。12 秒は警告しない", () => {
      expect(evaluateAlerts({ ...input(account()), latestRunSeconds: 900.4 }, NOW, "hourly", false).alerts).toEqual([
        { kind: "run_duration", seconds: 901, limitSeconds: 900 },
      ]);
      expect(evaluateAlerts({ ...input(account()), latestRunSeconds: 12.3 }, NOW, "hourly", false).alerts).toEqual([]);
    });

    it("値がなければ判定しない。アカウントが 0 件でも判定する（account を持たない）", () => {
      expect(evaluateAlerts(input(account()), NOW, "hourly", false).alerts).toEqual([]);
      expect(evaluateAlerts({ accounts: [], latestRunSeconds: 1800 }, NOW, "hourly", false)).toEqual({
        alerts: [{ kind: "run_duration", seconds: 1800, limitSeconds: 900 }],
        noHistory: false,
        noHistoryKinds: [],
      });
    });
  });

  describe("db_size と storage_size（daily のみ）", () => {
    it("8 割ちょうどは警告、1 バイト足りなければ警告しない。percent と used_mb は切り捨て", () => {
      const dbAt = 8192 * MB * 0.8;
      const storageAt = 102400 * MB * 0.8;
      expect(
        evaluateAlerts({ accounts: [], capacity: { dbBytes: dbAt, storageBytes: storageAt }, capacityLimits }, NOW, "daily", false).alerts,
      ).toEqual([
        { kind: "db_size", usedMb: 6553, limitMb: 8192, percent: 80 },
        { kind: "storage_size", usedMb: 81920, limitMb: 102400, percent: 80 },
      ]);
      expect(
        evaluateAlerts({ accounts: [], capacity: { dbBytes: dbAt - 1, storageBytes: storageAt - 1 }, capacityLimits }, NOW, "daily", false).alerts,
      ).toEqual([]);
    });

    it("片方だけ超えればその 1 件。上限を超えた値は 100 以上の percent", () => {
      expect(
        evaluateAlerts({ accounts: [], capacity: { dbBytes: 9000 * MB, storageBytes: 2 * MB }, capacityLimits }, NOW, "daily", false).alerts,
      ).toEqual([{ kind: "db_size", usedMb: 9000, limitMb: 8192, percent: 109 }]);
      // 2026-11-21 の実測（52 MB、1.7 MB）は該当しない
      expect(
        evaluateAlerts({ accounts: [], capacity: { dbBytes: 52 * MB, storageBytes: 1.7 * MB }, capacityLimits }, NOW, "daily", false).alerts,
      ).toEqual([]);
    });

    it("hourly では判定しない。容量か上限の省略でも判定しない", () => {
      const full = { dbBytes: 8192 * MB, storageBytes: 102400 * MB };
      expect(evaluateAlerts({ accounts: [], capacity: full, capacityLimits }, NOW, "hourly", false).alerts).toEqual([]);
      expect(evaluateAlerts({ accounts: [], capacityLimits }, NOW, "daily", false).alerts).toEqual([]);
      expect(evaluateAlerts({ accounts: [], capacity: full }, NOW, "daily", false).alerts).toEqual([]);
      expect(evaluateAlerts({ accounts: [], capacity: full, capacityLimits }, NOW, "daily", false).alerts).toHaveLength(2);
    });
  });

  it("並びはアカウントの判定のあとに run_duration、db_size、storage_size", () => {
    const result = evaluateAlerts(
      {
        ...input(account({ credential: null })),
        latestRunSeconds: 1000,
        capacity: { dbBytes: 8192 * MB, storageBytes: 102400 * MB },
        capacityLimits,
      },
      NOW,
      "daily",
      true,
    );
    expect(result.alerts.map((alert) => alert.kind)).toEqual(["simulated", "token", "run_duration", "db_size", "storage_size"]);
  });
});
