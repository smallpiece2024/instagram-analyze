/**
 * `jobs/alerts.ts` の `evaluateAlerts`（R2 設計 5.2 章の表、10.1 章）。DB と API に触らない
 */
import { describe, expect, it } from "vitest";
import {
  evaluateAlerts,
  FOLLOWER_DROP_MIN_COUNT,
  FOLLOWER_DROP_MIN_PERCENT,
  NO_CREDENTIAL_STATUS,
  NON_FOLLOWER_REACH_BASE_DAYS,
  NON_FOLLOWER_REACH_DROP_PT,
  NON_FOLLOWER_REACH_MIN_BASE_DAYS,
  NON_FOLLOWER_REACH_MIN_RECENT_DAYS,
  NON_FOLLOWER_REACH_RECENT_DAYS,
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
    expect(evaluateAlerts(input(account()), NOW, "daily", false)).toEqual({ alerts: [], noHistory: false, noHistoryKinds: [], noPosts: false });
    expect(evaluateAlerts(input(account()), NOW, "hourly", false)).toEqual({ alerts: [], noHistory: false, noHistoryKinds: [], noPosts: false });
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
          noPosts: false,
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
        noPosts: false,
      });
    });

    it("1 件だけ、0 件は判定せず noHistory", () => {
      expect(evaluateAlerts(input(account({ recentStoriesRuns: runs("failed") })), NOW, "hourly", false)).toEqual({ alerts: [], noHistory: true, noHistoryKinds: ["stories"], noPosts: false });
      expect(evaluateAlerts(input(account({ recentStoriesRuns: [] })), NOW, "hourly", false)).toEqual({ alerts: [], noHistory: true, noHistoryKinds: ["stories"], noPosts: false });
      expect(evaluateAlerts(input(account({ recentStoriesRuns: runs("running", "failed") })), NOW, "hourly", false)).toEqual({
        alerts: [],
        noHistory: true,
        noHistoryKinds: ["stories"],
        noPosts: false,
      });
    });

    it("履歴が足りないアカウントがあっても、他のアカウントの該当は出す", () => {
      const result = evaluateAlerts(
        input(account({ recentStoriesRuns: [] }), account({ recentStoriesRuns: runs("failed", "failed") })),
        NOW,
        "hourly",
        false,
      );
      expect(result).toEqual({ alerts: [{ kind: "stories_failed", ordinal: 2, total: 2, runs: 2 }], noHistory: true, noHistoryKinds: ["stories"], noPosts: false });
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
        noPosts: false,
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
      expect(result).toEqual({ alerts: [], noHistory: false, noHistoryKinds: [], noPosts: false });
    }
  });

  it("simulate は先頭に simulated を足し、本物の判定も続ける", () => {
    expect(evaluateAlerts(input(account()), NOW, "hourly", true)).toEqual({ alerts: [{ kind: "simulated" }], noHistory: false, noHistoryKinds: [], noPosts: false });
    expect(evaluateAlerts(input(account({ recentStoriesRuns: runs("failed", "failed") })), NOW, "hourly", true).alerts).toEqual([
      { kind: "simulated" },
      { kind: "stories_failed", ordinal: 1, total: 1, runs: 2 },
    ]);
    expect(evaluateAlerts({ accounts: [] }, NOW, "daily", true)).toEqual({ alerts: [{ kind: "simulated" }], noHistory: false, noHistoryKinds: [], noPosts: false });
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

/** 該当なしで見送りもない結果の共通部分 */
const CLEAN = { noHistory: false, noHistoryKinds: [], noPosts: false } as const;

/**
 * 非フォロワーリーチ比率の入力。`[分子, 分母, 使えた日数]` で与える（率は持たない）。
 * 既定は直近 7 日・基準 28 日がすべて使え、直近の投稿は 3 件
 */
function reachSignal(recent: [number, number, number], base: [number, number, number], recentPosts = 3): AlertAccount {
  return account({
    nonFollowerReach: {
      recent: { numerator: recent[0], denominator: recent[1], days: recent[2] },
      base: { numerator: base[0], denominator: base[1], days: base[2] },
      recentPosts,
    },
  });
}

/** フォロワー数の入力。`[captured_on, 人数]`。`previous` は null にできる */
function followerSignal(latest: [string, number], previous: [string, number] | null): AlertAccount {
  return account({
    followers: {
      latest: { capturedOn: latest[0], count: latest[1] },
      previous: previous ? { capturedOn: previous[0], count: previous[1] } : null,
    },
  });
}

describe("evaluateAlerts: non_follower_reach_drop（R6 設計 4.1 節。daily のみ）", () => {
  it("定数（Q9、Q10）", () => {
    expect(NON_FOLLOWER_REACH_DROP_PT).toBe(10);
    expect(NON_FOLLOWER_REACH_RECENT_DAYS).toBe(7);
    expect(NON_FOLLOWER_REACH_BASE_DAYS).toBe(28);
    expect(NON_FOLLOWER_REACH_MIN_RECENT_DAYS).toBe(5);
    expect(NON_FOLLOWER_REACH_MIN_BASE_DAYS).toBe(20);
  });

  it("基準 41%、直近 31%（10.0 pt ちょうど）は鳴り、9.9 pt 相当は鳴らない（整数の交差乗算。T4）", () => {
    expect(evaluateAlerts(input(reachSignal([31, 100, 7], [41, 100, 28])), NOW, "daily", false)).toEqual({
      alerts: [{ kind: "non_follower_reach_drop", ordinal: 1, total: 1, recentDays: 7, baseDays: 28 }],
      ...CLEAN,
    });
    expect(evaluateAlerts(input(reachSignal([311, 1000, 7], [410, 1000, 28])), NOW, "daily", false)).toEqual({ alerts: [], ...CLEAN });
    // 10.1 pt 相当は鳴る。合計が実データの桁（数百万）でも同じ
    expect(evaluateAlerts(input(reachSignal([309, 1000, 7], [410, 1000, 28])), NOW, "daily", false).alerts).toHaveLength(1);
    expect(evaluateAlerts(input(reachSignal([3_100_000, 10_000_000, 7], [4_100_000, 10_000_000, 28])), NOW, "daily", false).alerts).toHaveLength(1);
    expect(evaluateAlerts(input(reachSignal([3_100_001, 10_000_000, 7], [4_100_000, 10_000_000, 28])), NOW, "daily", false).alerts).toEqual([]);
    // 分母が違っても比率で比べる（直近 31/100 と基準 410/1000）
    expect(evaluateAlerts(input(reachSignal([31, 100, 7], [410, 1000, 28])), NOW, "daily", false).alerts).toHaveLength(1);
    // 上昇や同じ比率は鳴らない
    expect(evaluateAlerts(input(reachSignal([41, 100, 7], [31, 100, 28])), NOW, "daily", false).alerts).toEqual([]);
    expect(evaluateAlerts(input(reachSignal([41, 100, 7], [41, 100, 28])), NOW, "daily", false).alerts).toEqual([]);
  });

  it("Alert は使えた日数だけを持ち、率や合計を持たない（S1）", () => {
    const [alert] = evaluateAlerts(input(reachSignal([31, 100, 6], [41, 100, 25])), NOW, "daily", false).alerts;
    expect(alert).toEqual({ kind: "non_follower_reach_drop", ordinal: 1, total: 1, recentDays: 6, baseDays: 25 });
    expect(Object.keys(alert ?? {}).sort()).toEqual(["baseDays", "kind", "ordinal", "recentDays", "total"]);
  });

  it("直近 5 日で鳴り、4 日は no_history。基準 20 日で鳴り、19 日は no_history", () => {
    const skipped = { alerts: [], noHistory: true, noHistoryKinds: ["non_follower_reach_drop"], noPosts: false };
    expect(evaluateAlerts(input(reachSignal([31, 100, 5], [41, 100, 28])), NOW, "daily", false).alerts).toEqual([
      { kind: "non_follower_reach_drop", ordinal: 1, total: 1, recentDays: 5, baseDays: 28 },
    ]);
    expect(evaluateAlerts(input(reachSignal([31, 100, 4], [41, 100, 28])), NOW, "daily", false)).toEqual(skipped);
    expect(evaluateAlerts(input(reachSignal([31, 100, 7], [41, 100, 20])), NOW, "daily", false).alerts).toEqual([
      { kind: "non_follower_reach_drop", ordinal: 1, total: 1, recentDays: 7, baseDays: 20 },
    ]);
    expect(evaluateAlerts(input(reachSignal([31, 100, 7], [41, 100, 19])), NOW, "daily", false)).toEqual(skipped);
    expect(evaluateAlerts(input(reachSignal([31, 100, 0], [41, 100, 0])), NOW, "daily", false)).toEqual(skipped);
  });

  it("どちらかの分母が 0 なら no_history（日数が足りていても）", () => {
    const skipped = { alerts: [], noHistory: true, noHistoryKinds: ["non_follower_reach_drop"], noPosts: false };
    expect(evaluateAlerts(input(reachSignal([0, 0, 7], [41, 100, 28])), NOW, "daily", false)).toEqual(skipped);
    expect(evaluateAlerts(input(reachSignal([31, 100, 7], [0, 0, 28])), NOW, "daily", false)).toEqual(skipped);
    // 分子が 0 なのは比率 0% で、判定する（基準 41% → 直近 0% は鳴る）
    expect(evaluateAlerts(input(reachSignal([0, 100, 7], [41, 100, 28])), NOW, "daily", false).alerts).toHaveLength(1);
  });

  it("直近 7 日に投稿がなければ no_posts で鳴らない。履歴が足りなければ no_history が先", () => {
    expect(evaluateAlerts(input(reachSignal([31, 100, 7], [41, 100, 28], 0)), NOW, "daily", false)).toEqual({
      alerts: [],
      noHistory: false,
      noHistoryKinds: [],
      noPosts: true,
    });
    // 低下がなくても投稿がなければ noPosts は立つ（見送ったことを記録する）
    expect(evaluateAlerts(input(reachSignal([41, 100, 7], [41, 100, 28], 0)), NOW, "daily", false).noPosts).toBe(true);
    expect(evaluateAlerts(input(reachSignal([31, 100, 4], [41, 100, 28], 0)), NOW, "daily", false)).toEqual({
      alerts: [],
      noHistory: true,
      noHistoryKinds: ["non_follower_reach_drop"],
      noPosts: false,
    });
    // 1 件でもあれば判定する
    expect(evaluateAlerts(input(reachSignal([31, 100, 7], [41, 100, 28], 1)), NOW, "daily", false).alerts).toHaveLength(1);
  });

  it("入力の省略は判定しない（noHistory も立てない）。hourly では判定しない。active でなければ判定しない", () => {
    expect(evaluateAlerts(input(account()), NOW, "daily", false)).toEqual({ alerts: [], ...CLEAN });
    expect(evaluateAlerts(input(reachSignal([31, 100, 7], [41, 100, 28])), NOW, "hourly", false)).toEqual({ alerts: [], ...CLEAN });
    expect(evaluateAlerts(input(reachSignal([31, 100, 4], [41, 100, 28])), NOW, "hourly", false)).toEqual({ alerts: [], ...CLEAN });
    expect(evaluateAlerts(input(reachSignal([31, 100, 7], [41, 100, 28], 0)), NOW, "hourly", false)).toEqual({ alerts: [], ...CLEAN });
    const paused = { ...reachSignal([31, 100, 7], [41, 100, 28]), status: "paused" };
    expect(evaluateAlerts(input(paused), NOW, "daily", false)).toEqual({ alerts: [], ...CLEAN });
  });
});

describe("evaluateAlerts: follower_drop（R6 設計 4.1 節。daily のみ）", () => {
  const fired = { alerts: [{ kind: "follower_drop", ordinal: 1, total: 1 }], ...CLEAN };
  const skipped = { alerts: [], noHistory: true, noHistoryKinds: ["follower_drop"], noPosts: false };

  it("定数（Q11）", () => {
    expect(FOLLOWER_DROP_MIN_COUNT).toBe(10);
    expect(FOLLOWER_DROP_MIN_PERCENT).toBe(1);
  });

  it("前日比 10 人以上かつ 1% 以上で鳴る。ちょうど 10 人・ちょうど 1% も鳴る", () => {
    expect(evaluateAlerts(input(followerSignal(["2026-10-01", 990], ["2026-09-30", 1000])), NOW, "daily", false)).toEqual(fired);
    expect(evaluateAlerts(input(followerSignal(["2026-10-01", 1980], ["2026-09-30", 2000])), NOW, "daily", false)).toEqual(fired);
    expect(evaluateAlerts(input(followerSignal(["2026-10-01", 100], ["2026-09-30", 500])), NOW, "daily", false)).toEqual(fired);
    // 月をまたぐ前日も隣接
    expect(evaluateAlerts(input(followerSignal(["2026-11-01", 990], ["2026-10-31", 1000])), NOW, "daily", false)).toEqual(fired);
  });

  it("片方だけでは鳴らない: 9 人で 2%、10 人で 0.9%。増加や変化なしも鳴らない", () => {
    expect(evaluateAlerts(input(followerSignal(["2026-10-01", 441], ["2026-09-30", 450])), NOW, "daily", false)).toEqual({ alerts: [], ...CLEAN });
    expect(evaluateAlerts(input(followerSignal(["2026-10-01", 1190], ["2026-09-30", 1200])), NOW, "daily", false)).toEqual({ alerts: [], ...CLEAN });
    expect(evaluateAlerts(input(followerSignal(["2026-10-01", 1981], ["2026-09-30", 2000])), NOW, "daily", false)).toEqual({ alerts: [], ...CLEAN });
    expect(evaluateAlerts(input(followerSignal(["2026-10-01", 1100], ["2026-09-30", 1000])), NOW, "daily", false)).toEqual({ alerts: [], ...CLEAN });
    expect(evaluateAlerts(input(followerSignal(["2026-10-01", 1000], ["2026-09-30", 1000])), NOW, "daily", false)).toEqual({ alerts: [], ...CLEAN });
  });

  it("Alert は連番だけを持ち、人数を持たない（S1）", () => {
    const [alert] = evaluateAlerts(input(followerSignal(["2026-10-01", 990], ["2026-09-30", 1000])), NOW, "daily", false).alerts;
    expect(Object.keys(alert ?? {}).sort()).toEqual(["kind", "ordinal", "total"]);
  });

  it("previous がない、previous が前日でない（2 日前、同じ日、逆順）、previous = 0 は no_history", () => {
    expect(evaluateAlerts(input(followerSignal(["2026-10-01", 990], null)), NOW, "daily", false)).toEqual(skipped);
    expect(evaluateAlerts(input(followerSignal(["2026-10-01", 990], ["2026-09-29", 1000])), NOW, "daily", false)).toEqual(skipped);
    expect(evaluateAlerts(input(followerSignal(["2026-10-01", 990], ["2026-10-01", 1000])), NOW, "daily", false)).toEqual(skipped);
    expect(evaluateAlerts(input(followerSignal(["2026-10-01", 990], ["2026-10-02", 1000])), NOW, "daily", false)).toEqual(skipped);
    expect(evaluateAlerts(input(followerSignal(["2026-10-01", 0], ["2026-09-30", 0])), NOW, "daily", false)).toEqual(skipped);
    // 日付の形が崩れていても例外にせず no_history
    expect(evaluateAlerts(input(followerSignal(["2026-10-01", 990], ["unknown", 1000])), NOW, "daily", false)).toEqual(skipped);
  });

  it("入力の省略は判定しない。hourly では判定しない。active でなければ判定しない", () => {
    expect(evaluateAlerts(input(followerSignal(["2026-10-01", 990], ["2026-09-30", 1000])), NOW, "hourly", false)).toEqual({ alerts: [], ...CLEAN });
    expect(evaluateAlerts(input(followerSignal(["2026-10-01", 990], null)), NOW, "hourly", false)).toEqual({ alerts: [], ...CLEAN });
    const paused = { ...followerSignal(["2026-10-01", 990], ["2026-09-30", 1000]), status: "paused" };
    expect(evaluateAlerts(input(paused), NOW, "daily", false)).toEqual({ alerts: [], ...CLEAN });
  });
});

describe("evaluateAlerts: R6 の 2 種類の共通", () => {
  const both = (): AlertAccount => ({
    ...reachSignal([31, 100, 7], [41, 100, 28]),
    ...followerSignal(["2026-10-01", 990], ["2026-09-30", 1000]),
  });

  it("simulate と併存し、順は simulated → token → ocr → non_follower_reach_drop → follower_drop → stories", () => {
    const data = input({ ...both(), credential: null, recentStoriesRuns: runs("failed", "failed") });
    expect(evaluateAlerts(data, NOW, "daily", true).alerts.map((alert) => alert.kind)).toEqual([
      "simulated",
      "token",
      "non_follower_reach_drop",
      "follower_drop",
      "stories_failed",
    ]);
    expect(evaluateAlerts(input(both()), NOW, "daily", true)).toEqual({
      alerts: [
        { kind: "simulated" },
        { kind: "non_follower_reach_drop", ordinal: 1, total: 1, recentDays: 7, baseDays: 28 },
        { kind: "follower_drop", ordinal: 1, total: 1 },
      ],
      ...CLEAN,
    });
  });

  it("noHistoryKinds は判定の順に並び、複数のアカウントで重複しない。noHistory は 1 つでも true", () => {
    const lacking = (): AlertAccount => ({
      ...reachSignal([31, 100, 4], [41, 100, 28]),
      ...followerSignal(["2026-10-01", 990], null),
      recentStoriesRuns: [],
    });
    expect(evaluateAlerts(input(lacking(), lacking()), NOW, "daily", false)).toEqual({
      alerts: [],
      noHistory: true,
      noHistoryKinds: ["non_follower_reach_drop", "follower_drop", "stories"],
      noPosts: false,
    });
    // stories だけが足りないときは従来どおり stories だけ
    expect(evaluateAlerts(input(account({ recentStoriesRuns: [] })), NOW, "daily", false).noHistoryKinds).toEqual(["stories"]);
    // hourly では stories しか判定しないので、2 種類の見送りは入らない
    expect(evaluateAlerts(input(lacking()), NOW, "hourly", false).noHistoryKinds).toEqual(["stories"]);
  });

  it("見送りと該当は混ざる（片方のアカウントが鳴り、もう片方が見送り）", () => {
    const result = evaluateAlerts(input(both(), followerSignal(["2026-10-01", 990], null)), NOW, "daily", false);
    expect(result.alerts).toEqual([
      { kind: "non_follower_reach_drop", ordinal: 1, total: 2, recentDays: 7, baseDays: 28 },
      { kind: "follower_drop", ordinal: 1, total: 2 },
    ]);
    expect(result.noHistory).toBe(true);
    expect(result.noHistoryKinds).toEqual(["follower_drop"]);
    expect(result.noPosts).toBe(false);
  });

  it("入力を変えない", () => {
    const data = input(both(), reachSignal([31, 100, 7], [41, 100, 28], 0), followerSignal(["2026-10-01", 990], null));
    const snapshot = JSON.stringify(data);
    evaluateAlerts(data, NOW, "daily", true);
    evaluateAlerts(data, NOW, "hourly", false);
    expect(JSON.stringify(data)).toBe(snapshot);
  });
});
