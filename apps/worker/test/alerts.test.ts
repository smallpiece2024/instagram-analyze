/**
 * `jobs/alerts.ts` の `evaluateAlerts`（R2 設計 5.2 章の表、10.1 章）。DB と API に触らない
 */
import { describe, expect, it } from "vitest";
import {
  evaluateAlerts,
  NO_CREDENTIAL_STATUS,
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
    expect(evaluateAlerts(input(account()), NOW, "daily", false)).toEqual({ alerts: [], noHistory: false });
    expect(evaluateAlerts(input(account()), NOW, "hourly", false)).toEqual({ alerts: [], noHistory: false });
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

    it("期限が不明（null）で valid なら警告しない", () => {
      const result = evaluateAlerts(input(account({ credential: { status: "valid", dataAccessExpiresAt: null } })), NOW, "daily", false);
      expect(result.alerts).toEqual([]);
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
      });
    });

    it("1 件だけ、0 件は判定せず noHistory", () => {
      expect(evaluateAlerts(input(account({ recentStoriesRuns: runs("failed") })), NOW, "hourly", false)).toEqual({ alerts: [], noHistory: true });
      expect(evaluateAlerts(input(account({ recentStoriesRuns: [] })), NOW, "hourly", false)).toEqual({ alerts: [], noHistory: true });
      expect(evaluateAlerts(input(account({ recentStoriesRuns: runs("running", "failed") })), NOW, "hourly", false)).toEqual({
        alerts: [],
        noHistory: true,
      });
    });

    it("履歴が足りないアカウントがあっても、他のアカウントの該当は出す", () => {
      const result = evaluateAlerts(
        input(account({ recentStoriesRuns: [] }), account({ recentStoriesRuns: runs("failed", "failed") })),
        NOW,
        "hourly",
        false,
      );
      expect(result).toEqual({ alerts: [{ kind: "stories_failed", ordinal: 2, total: 2, runs: 2 }], noHistory: true });
    });
  });

  describe("stories の連続見送り", () => {
    it("skipped × 3 は stories_skipped（runs=3）", () => {
      expect(evaluateAlerts(input(account({ recentStoriesRuns: runs("skipped", "skipped", "skipped") })), NOW, "hourly", false)).toEqual({
        alerts: [{ kind: "stories_skipped", ordinal: 1, total: 1, runs: 3 }],
        noHistory: false,
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
      expect(result).toEqual({ alerts: [], noHistory: false });
    }
  });

  it("simulate は先頭に simulated を足し、本物の判定も続ける", () => {
    expect(evaluateAlerts(input(account()), NOW, "hourly", true)).toEqual({ alerts: [{ kind: "simulated" }], noHistory: false });
    expect(evaluateAlerts(input(account({ recentStoriesRuns: runs("failed", "failed") })), NOW, "hourly", true).alerts).toEqual([
      { kind: "simulated" },
      { kind: "stories_failed", ordinal: 1, total: 1, runs: 2 },
    ]);
    expect(evaluateAlerts({ accounts: [] }, NOW, "daily", true)).toEqual({ alerts: [{ kind: "simulated" }], noHistory: false });
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
