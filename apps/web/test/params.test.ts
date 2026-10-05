import { describe, expect, it } from "vitest";
import {
  parseCsvDateRange,
  parseDateRange,
  parseEr,
  parseJob,
  parseJobStatus,
  parseMediaId,
  parseOrder,
  parsePageNumber,
  parsePreset,
  parseRange,
  parseSort,
} from "@/lib/params";

describe("range", () => {
  it("7、30、90 だけ。ほかは 30", () => {
    expect(parseRange("7")).toBe(7);
    expect(parseRange("90")).toBe(90);
    expect(parseRange("30")).toBe(30);
    for (const v of ["14", "007", "", "abc", undefined, ["7"]]) expect(parseRange(v)).toBe(30);
  });
});

describe("er", () => {
  it("reach、views、followers だけ。ほかは reach", () => {
    expect(parseEr("views")).toBe("views");
    expect(parseEr("followers")).toBe("followers");
    expect(parseEr("likes")).toBe("reach");
    expect(parseEr(undefined)).toBe("reach");
    expect(parseEr(["views"])).toBe("reach");
  });
});

describe("sort と order", () => {
  const keys = ["posted", "reach", "er"] as const;
  it("許可リスト外の sort は既定（posted）", () => {
    expect(parseSort("reach", keys, "posted")).toBe("reach");
    expect(parseSort("caption", keys, "posted")).toBe("posted");
    expect(parseSort("reach; drop table", keys, "posted")).toBe("posted");
    expect(parseSort(undefined, keys, "posted")).toBe("posted");
    expect(parseSort(["reach"], keys, "posted")).toBe("posted");
  });

  it("order は asc と desc。ほかは desc", () => {
    expect(parseOrder("asc")).toBe("asc");
    expect(parseOrder("desc")).toBe("desc");
    expect(parseOrder("ASC")).toBe("desc");
    expect(parseOrder(undefined)).toBe("desc");
  });
});

describe("page", () => {
  it("^\\d{1,6}$ かつ 1 以上。0、負、7 桁、数字以外は 1", () => {
    expect(parsePageNumber("1")).toBe(1);
    expect(parsePageNumber("2")).toBe(2);
    expect(parsePageNumber("999999")).toBe(999999);
    expect(parsePageNumber("0")).toBe(1);
    expect(parsePageNumber("000")).toBe(1);
    expect(parsePageNumber("-1")).toBe(1);
    expect(parsePageNumber("1000000")).toBe(1);
    expect(parsePageNumber("1.5")).toBe(1);
    expect(parsePageNumber("abc")).toBe(1);
    expect(parsePageNumber("")).toBe(1);
    expect(parsePageNumber(undefined)).toBe(1);
    expect(parsePageNumber(["2"])).toBe(1);
  });
});

describe("投稿 ID", () => {
  it("^\\d{1,25}$。26 桁と数字以外は null（notFound）", () => {
    expect(parseMediaId("1")).toBe("1");
    expect(parseMediaId("1".repeat(25))).toBe("1".repeat(25));
    expect(parseMediaId("1".repeat(26))).toBeNull();
    expect(parseMediaId("12a")).toBeNull();
    expect(parseMediaId("")).toBeNull();
    expect(parseMediaId("-1")).toBeNull();
    expect(parseMediaId(undefined)).toBeNull();
  });
});

describe("preset", () => {
  it("7d、30d、month、yoy。ほかは 30d", () => {
    for (const v of ["7d", "30d", "month", "yoy"]) expect(parsePreset(v)).toBe(v);
    expect(parsePreset("90d")).toBe("30d");
    expect(parsePreset(undefined)).toBe("30d");
  });
});

describe("job と status", () => {
  it("許可リスト外は絞り込みなし", () => {
    expect(parseJob("media_snapshot")).toBe("media_snapshot");
    expect(parseJob("drop")).toBeUndefined();
    expect(parseJob(["stories"])).toBeUndefined();
    for (const s of ["running", "success", "partial", "failed", "skipped"]) expect(parseJobStatus(s)).toBe(s);
    expect(parseJobStatus("ok")).toBeUndefined();
    expect(parseJobStatus(undefined)).toBeUndefined();
  });
});

describe("日付の範囲", () => {
  it("正しい範囲", () => {
    expect(parseDateRange("2026-09-01", "2026-09-30")).toEqual({
      ok: true,
      period: { from: "2026-09-01", to: "2026-09-30" },
    });
    expect(parseDateRange("2026-10-04", "2026-10-04").ok).toBe(true);
  });

  it("形と暦（2026-02-30、2025-02-29）", () => {
    expect(parseDateRange("2026/09/01", "2026-09-30").ok).toBe(false);
    expect(parseDateRange("2026-02-30", "2026-03-01").ok).toBe(false);
    expect(parseDateRange("2025-02-29", "2025-03-01").ok).toBe(false);
    expect(parseDateRange("2024-02-29", "2024-03-01").ok).toBe(true);
    expect(parseDateRange(undefined, "2026-03-01").ok).toBe(false);
    expect(parseDateRange(["2026-01-01"], "2026-03-01").ok).toBe(false);
  });

  it("逆順", () => {
    const r = parseDateRange("2026-10-02", "2026-10-01");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("開始日は終了日より前にしてください");
  });

  it("366 日は通り、367 日は通らない", () => {
    expect(parseDateRange("2025-01-01", "2026-01-01").ok).toBe(true); // 366 日
    expect(parseDateRange("2024-01-01", "2024-12-31").ok).toBe(true); // うるう年の 366 日
    expect(parseDateRange("2025-01-01", "2026-01-02").ok).toBe(false); // 367 日
  });

  it("日次の CSV: 両方省略は全期間、片方だけと不正は invalid", () => {
    expect(parseCsvDateRange(undefined, undefined)).toEqual({ kind: "all" });
    expect(parseCsvDateRange("2026-09-01", undefined)).toEqual({ kind: "invalid" });
    expect(parseCsvDateRange("2026-09-01", "2026-02-30")).toEqual({ kind: "invalid" });
    expect(parseCsvDateRange("2026-09-01", "2026-09-30")).toEqual({
      kind: "range",
      period: { from: "2026-09-01", to: "2026-09-30" },
    });
  });
});
