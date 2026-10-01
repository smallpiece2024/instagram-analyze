import { describe, expect, it } from "vitest";
import {
  accountStatusLabel,
  credentialStatusLabel,
  daysLeft,
  elapsedLabel,
  EMPTY,
  ERROR_FOLD_LENGTH,
  formatCount,
  formatDuration,
  formatJst,
  isInstagramPermalink,
  JOB_ORDER,
  jobRowView,
  jobStatusLabel,
  MAX_PAGE,
  metricCell,
  missingScopes,
  needsReconnect,
  parseJobFilter,
  parsePage,
  tokenTypeLabel,
  usagePercent,
} from "@/lib/format";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-02T03:00:00Z");

describe("formatJst", () => {
  it("JST の YYYY-MM-DD HH:mm にする（UTC 15:00 は翌日 00:00）", () => {
    expect(formatJst(new Date("2026-10-01T15:00:00Z"))).toBe("2026-10-02 00:00");
    expect(formatJst(new Date("2026-01-05T03:07:59Z"))).toBe("2026-01-05 12:07");
    expect(formatJst(new Date("2026-12-31T14:59:00Z"))).toBe("2026-12-31 23:59");
  });

  it("null、undefined、不正な日時は —", () => {
    expect(formatJst(null)).toBe(EMPTY);
    expect(formatJst(undefined)).toBe(EMPTY);
    expect(formatJst(new Date("invalid"))).toBe(EMPTY);
  });
});

describe("formatCount", () => {
  it("3 桁区切り。文字列（bigint）も受ける。null は —", () => {
    expect(formatCount(1234567)).toBe("1,234,567");
    expect(formatCount("1234")).toBe("1,234");
    expect(formatCount(0)).toBe("0");
    expect(formatCount(null)).toBe(EMPTY);
    expect(formatCount(undefined)).toBe(EMPTY);
    expect(formatCount("abc")).toBe(EMPTY);
  });
});

describe("daysLeft", () => {
  it("切り捨て。14 日ちょうどは 14、1 ミリ秒足りなければ 13、過ぎていれば負", () => {
    expect(daysLeft(new Date(NOW.getTime() + 14 * DAY_MS), NOW)).toBe(14);
    expect(daysLeft(new Date(NOW.getTime() + 14 * DAY_MS - 1), NOW)).toBe(13);
    expect(daysLeft(new Date(NOW.getTime() - 1), NOW)).toBe(-1);
    expect(daysLeft(new Date(NOW.getTime() - 3 * DAY_MS), NOW)).toBe(-3);
  });

  it("null と不正な日時は undefined", () => {
    expect(daysLeft(null, NOW)).toBeUndefined();
    expect(daysLeft(undefined, NOW)).toBeUndefined();
    expect(daysLeft(new Date("invalid"), NOW)).toBeUndefined();
  });
});

describe("needsReconnect", () => {
  const far = new Date(NOW.getTime() + 60 * DAY_MS);
  it("valid で 14 日超なら false。期限が不明でも false", () => {
    expect(needsReconnect({ credential_status: "valid", data_access_expires_at: far, now: NOW })).toBe(false);
    expect(needsReconnect({ credential_status: "valid", data_access_expires_at: null, now: NOW })).toBe(false);
    expect(
      needsReconnect({ credential_status: "valid", data_access_expires_at: new Date(NOW.getTime() + 15 * DAY_MS), now: NOW }),
    ).toBe(false);
  });

  it("valid 以外と null は true", () => {
    for (const status of ["expired", "insufficient_scope", "error", null, undefined]) {
      expect(needsReconnect({ credential_status: status, data_access_expires_at: far, now: NOW })).toBe(true);
    }
  });

  it("残り 14 日以下と過ぎた期限は true（15 日に 1 ミリ秒足りなければ切り捨てで 14 日）", () => {
    expect(
      needsReconnect({ credential_status: "valid", data_access_expires_at: new Date(NOW.getTime() + 14 * DAY_MS), now: NOW }),
    ).toBe(true);
    expect(
      needsReconnect({
        credential_status: "valid",
        data_access_expires_at: new Date(NOW.getTime() + 15 * DAY_MS - 1),
        now: NOW,
      }),
    ).toBe(true);
    expect(needsReconnect({ credential_status: "valid", data_access_expires_at: new Date(NOW.getTime() - 1), now: NOW })).toBe(
      true,
    );
  });
});

describe("missingScopes", () => {
  it("必要な 3 つのうち足りないもの。余分な権限は無視", () => {
    expect(missingScopes(["instagram_basic", "instagram_manage_insights", "pages_read_engagement", "pages_show_list"])).toEqual([]);
    expect(missingScopes(["instagram_basic"])).toEqual(["instagram_manage_insights", "pages_read_engagement"]);
    expect(missingScopes(null)).toEqual(["instagram_basic", "instagram_manage_insights", "pages_read_engagement"]);
  });
});

describe("metricCell", () => {
  it("スナップショットなしは 未取得", () => {
    expect(metricCell(null, "views")).toBe("未取得");
    expect(metricCell(undefined, "views")).toBe("未取得");
    expect(metricCell([1], "views")).toBe("未取得");
    expect(metricCell("x", "views")).toBe("未取得");
  });

  it("キーなしは —、null は 欠損、数値は 3 桁区切り、内訳のオブジェクトは —", () => {
    expect(metricCell({}, "views")).toBe(EMPTY);
    expect(metricCell({ views: null }, "views")).toBe("欠損");
    expect(metricCell({ views: 1234 }, "views")).toBe("1,234");
    expect(metricCell({ views: 0 }, "views")).toBe("0");
    expect(metricCell({ navigation: { tap_forward: 1 } }, "navigation")).toBe(EMPTY);
    expect(metricCell({ views: "12" }, "views")).toBe(EMPTY);
    expect(metricCell({ views: Number.NaN }, "views")).toBe(EMPTY);
  });

  it("プロトタイプのキーは見ない", () => {
    expect(metricCell({}, "toString")).toBe(EMPTY);
  });
});

describe("parsePage", () => {
  it("1 以上の整数。数字以外、0、負、配列、未指定は 1", () => {
    expect(parsePage(undefined)).toBe(1);
    expect(parsePage("abc")).toBe(1);
    expect(parsePage("0")).toBe(1);
    expect(parsePage("-1")).toBe(1);
    expect(parsePage("1.5")).toBe(1);
    expect(parsePage(["2", "3"])).toBe(1);
    expect(parsePage("3")).toBe(3);
    expect(parsePage("007")).toBe(7);
  });

  it("巨大な値は桁数にかかわらず上限に丸める", () => {
    expect(parsePage("999999999")).toBe(MAX_PAGE);
    expect(parsePage("9999999999999")).toBe(MAX_PAGE);
    expect(parsePage("9".repeat(40))).toBe(MAX_PAGE);
    expect(parsePage("0000")).toBe(1);
    expect(parsePage(String(MAX_PAGE))).toBe(MAX_PAGE);
    expect(parsePage(String(MAX_PAGE + 1))).toBe(MAX_PAGE);
  });
});

describe("parseJobFilter", () => {
  it("7 つのジョブ名だけを通す。未知、配列、未指定は undefined", () => {
    for (const name of JOB_ORDER) expect(parseJobFilter(name)).toBe(name);
    expect(parseJobFilter("unknown")).toBeUndefined();
    expect(parseJobFilter("")).toBeUndefined();
    expect(parseJobFilter(["stories"])).toBeUndefined();
    expect(parseJobFilter(undefined)).toBeUndefined();
  });
});

describe("usagePercent", () => {
  it("3 つの最大。null や数値でない値は無視", () => {
    expect(usagePercent({ call_count: 10, total_cputime: 20, total_time: 30 })).toBe(30);
    expect(usagePercent({ call_count: 50, total_cputime: 1, total_time: 2 })).toBe(50);
    expect(usagePercent(null)).toBeUndefined();
    expect(usagePercent(undefined)).toBeUndefined();
    expect(usagePercent({ call_count: Number.NaN, total_cputime: 5, total_time: Number.POSITIVE_INFINITY })).toBe(5);
  });
});

describe("formatDuration", () => {
  it("秒、分と秒、時間と分。負は 0 秒。境界は 60 秒と 3600 秒", () => {
    expect(formatDuration(5000)).toBe("5 秒");
    expect(formatDuration(59_999)).toBe("59 秒");
    expect(formatDuration(60_000)).toBe("1 分 0 秒");
    expect(formatDuration(65_000)).toBe("1 分 5 秒");
    expect(formatDuration(3_599_000)).toBe("59 分 59 秒");
    expect(formatDuration(3_600_000)).toBe("1 時間 0 分");
    expect(formatDuration(3_660_000)).toBe("1 時間 1 分");
    expect(formatDuration(-1000)).toBe("0 秒");
  });
});

describe("elapsedLabel", () => {
  it("投稿後 N 分／時間／日。null は —。境界は 3600 秒と 86400 秒", () => {
    expect(elapsedLabel(null)).toBe(EMPTY);
    expect(elapsedLabel(300)).toBe("投稿後 5 分");
    expect(elapsedLabel(3599)).toBe("投稿後 59 分");
    expect(elapsedLabel(3600)).toBe("投稿後 1 時間");
    expect(elapsedLabel(7200)).toBe("投稿後 2 時間");
    expect(elapsedLabel(86_399)).toBe("投稿後 23 時間");
    expect(elapsedLabel(86_400)).toBe("投稿後 1 日");
    expect(elapsedLabel(90_000)).toBe("投稿後 1 日");
    expect(elapsedLabel(-5)).toBe("投稿後 0 分");
  });
});

describe("isInstagramPermalink", () => {
  it("https://www.instagram.com/ 始まりだけ", () => {
    expect(isInstagramPermalink("https://www.instagram.com/p/abc/")).toBe(true);
    expect(isInstagramPermalink("http://www.instagram.com/p/abc/")).toBe(false);
    expect(isInstagramPermalink("https://instagram.com/p/abc/")).toBe(false);
    expect(isInstagramPermalink("javascript:alert(1)")).toBe(false);
    expect(isInstagramPermalink(null)).toBe(false);
  });
});

describe("jobRowView", () => {
  const started = new Date(NOW.getTime() - 5 * 60_000);

  it("running は開始からの分数。所要時間とエラーは出さない", () => {
    const v = jobRowView({ status: "running", started_at: started, finished_at: null, error: null, rate_usage: null }, NOW);
    expect(v.statusLabel).toBe("実行中（開始から 5 分）");
    expect(v.durationLabel).toBe(EMPTY);
    expect(v.errorText).toBeNull();
    expect(v.usageLabel).toBe(EMPTY);
  });

  it("running で now が開始より前（時計のずれ）なら 0 分", () => {
    const future = new Date(NOW.getTime() + 10 * 60_000);
    const v = jobRowView({ status: "running", started_at: future, finished_at: null, error: null, rate_usage: null }, NOW);
    expect(v.statusLabel).toBe("実行中（開始から 0 分）");
  });

  it("success は所要時間。エラーは出さない", () => {
    const v = jobRowView(
      { status: "success", started_at: started, finished_at: new Date(started.getTime() + 65_000), error: null, rate_usage: null },
      NOW,
    );
    expect(v.statusLabel).toBe("成功");
    expect(v.durationLabel).toBe("1 分 5 秒");
    expect(v.errorText).toBeNull();
  });

  it("partial、failed、skipped はエラーを必ず出す。記録がなければ固定文言", () => {
    const partial = jobRowView(
      { status: "partial", started_at: started, finished_at: new Date(started.getTime() + 1000), error: "一部失敗", rate_usage: null },
      NOW,
    );
    expect(partial.statusLabel).toBe("一部失敗");
    expect(partial.errorText).toBe("一部失敗");
    expect(partial.errorIsLong).toBe(false);
    const failed = jobRowView({ status: "failed", started_at: started, finished_at: null, error: null, rate_usage: null }, NOW);
    expect(failed.errorText).toBe("（理由の記録なし）");
    expect(failed.durationLabel).toBe(EMPTY);
    const skipped = jobRowView(
      { status: "skipped", started_at: started, finished_at: started, error: "見送り", rate_usage: null },
      NOW,
    );
    expect(skipped.statusLabel).toBe("見送り");
    expect(skipped.errorText).toBe("見送り");
    expect(skipped.durationLabel).toBe("0 秒");
  });

  it("長いエラーは折りたたみ（境目ちょうどは折りたたまない）", () => {
    const long = jobRowView(
      {
        status: "failed",
        started_at: started,
        finished_at: started,
        error: "x".repeat(ERROR_FOLD_LENGTH + 1),
        rate_usage: null,
      },
      NOW,
    );
    expect(long.errorIsLong).toBe(true);
    const exact = jobRowView(
      {
        status: "failed",
        started_at: started,
        finished_at: started,
        error: "x".repeat(ERROR_FOLD_LENGTH),
        rate_usage: null,
      },
      NOW,
    );
    expect(exact.errorIsLong).toBe(false);
  });

  it("使用率は 3 つの最大。回復見込みがあれば付ける", () => {
    const v = jobRowView(
      {
        status: "success",
        started_at: started,
        finished_at: started,
        error: null,
        rate_usage: { call_count: 1, total_cputime: 7, total_time: 3, estimated_time_to_regain_access: 12 },
      },
      NOW,
    );
    expect(v.usageLabel).toBe("使用率 7%（回復見込み 12 分）");
  });
});

describe("ラベル", () => {
  it("状態の日本語。未知はそのまま", () => {
    expect(jobStatusLabel("success")).toBe("成功");
    expect(jobStatusLabel("weird")).toBe("weird");
    expect(credentialStatusLabel(null)).toBe("未接続");
    expect(credentialStatusLabel("insufficient_scope")).toBe("権限不足");
    expect(accountStatusLabel("paused")).toBe("停止");
    expect(accountStatusLabel(null)).toBe(EMPTY);
    expect(tokenTypeLabel("PAGE")).toBe("ページトークン");
    expect(tokenTypeLabel(null)).toBe(EMPTY);
  });
});
