import { describe, expect, it } from "vitest";
import {
  CSV_BOM,
  csvCell,
  csvFileName,
  type CsvColumn,
  DAILY_CSV_COLUMNS,
  MEDIA_CSV_COLUMNS,
  neutralizeFormula,
  quoteCsvField,
  toCsv,
} from "@/lib/csv";

describe("引用", () => {
  it("カンマ、ダブルクォート、CR、LF を含むなら囲み、中の \" を重ねる", () => {
    expect(quoteCsvField("abc")).toBe("abc");
    expect(quoteCsvField("a,b")).toBe('"a,b"');
    expect(quoteCsvField('a"b')).toBe('"a""b"');
    expect(quoteCsvField("a\rb")).toBe('"a\rb"');
    expect(quoteCsvField("a\nb")).toBe('"a\nb"');
  });
});

describe("数式の注入", () => {
  it("先頭が = + - @ タブ CR LF と全角の ＝＋－＠ なら ' を付ける", () => {
    for (const s of ["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx", "\nx", "＝1", "＋1", "－1", "＠x"]) {
      expect(neutralizeFormula(s)).toBe(`'${s}`);
    }
    expect(neutralizeFormula("ふつうの文")).toBe("ふつうの文");
    expect(neutralizeFormula("a=1")).toBe("a=1");
  });

  it("先頭の空白（半角、全角、タブ）のあとの = も対象", () => {
    expect(neutralizeFormula(" =1")).toBe("' =1");
    expect(neutralizeFormula("　=1")).toBe("'　=1");
    expect(neutralizeFormula(" \t +1")).toBe("' \t +1");
  });

  it("文字列の列は ' を付けてから引用する", () => {
    expect(csvCell("text", '=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell("text", "\nabc")).toBe(`"'\nabc"`);
  });

  it("数値の列の負の数は対象外", () => {
    expect(csvCell("number", -12)).toBe("-12");
    expect(csvCell("number", 0.0213)).toBe("0.0213");
    expect(csvCell("number", "-3")).toBe("-3");
    expect(csvCell("number", Number.NaN)).toBe("");
  });

  it("数値の列の空の文字列と空白だけの文字列は 0 ではなく空欄（欠損）", () => {
    expect(csvCell("number", "")).toBe("");
    expect(csvCell("number", " ")).toBe("");
    expect(csvCell("number", "\t\n")).toBe("");
    expect(csvCell("number", "　")).toBe("");
    // 数字以外の文字列も空欄。前後の空白のある数字は数として読む
    expect(csvCell("number", "abc")).toBe("");
    expect(csvCell("number", " 12 ")).toBe("12");
    expect(csvCell("number", "0")).toBe("0");
    expect(csvCell("number", 0)).toBe("0");
  });

  it("欠損は空欄。真偽と時刻（JST）", () => {
    expect(csvCell("text", null)).toBe("");
    expect(csvCell("number", undefined)).toBe("");
    expect(csvCell("boolean", true)).toBe("true");
    expect(csvCell("boolean", false)).toBe("false");
    expect(csvCell("datetime", new Date("2026-10-04T23:30:05Z"))).toBe("2026-10-05 08:30:05");
    expect(csvCell("date", "2026-10-04")).toBe("2026-10-04");
  });
});

describe("toCsv", () => {
  interface Row {
    name: string;
    n: number | null;
  }
  const cols: CsvColumn<Row>[] = [
    { header: "name", kind: "text", value: (r) => r.name },
    { header: "n", kind: "number", value: (r) => r.n },
  ];

  it("BOM、CRLF、見出し、行", () => {
    const s = toCsv(cols, [
      { name: "a,b", n: -1 },
      { name: "=x", n: null },
    ]);
    expect(s.startsWith(CSV_BOM)).toBe(true);
    expect(s).toBe(`${CSV_BOM}name,n\r\n"a,b",-1\r\n'=x,\r\n`);
  });

  it("行がなければ見出しだけ", () => {
    expect(toCsv(cols, [])).toBe(`${CSV_BOM}name,n\r\n`);
  });
});

describe("列の並び（7.3 節）", () => {
  it("投稿", () => {
    expect(MEDIA_CSV_COLUMNS.map((c) => c.header)).toEqual([
      "media_id",
      "kind",
      "posted_at_jst",
      "caption",
      "permalink",
      "is_collab",
      "is_trial_reel",
      "is_boosted",
      "gone_at_jst",
      "latest_fetched_at_jst",
      "elapsed_latest_hours",
      "reach",
      "views",
      "likes",
      "comments",
      "saved",
      "shares",
      "profile_visits",
      "follows",
      "avg_watch_time_ms",
      "skip_rate",
      "er",
      "save_rate",
      "share_rate",
      "like_rate",
      "comment_rate",
      "profile_visit_rate",
      "follow_conversion_rate",
      "views_per_reach",
      "reach_7d",
      "elapsed_7d_hours",
      "followers_at_post",
      "reach_rate",
    ]);
  });

  it("日次", () => {
    expect(DAILY_CSV_COLUMNS.map((c) => c.header)).toEqual([
      "metric_date_pt",
      "reach",
      "reach_follower",
      "reach_non_follower",
      "views",
      "views_follower",
      "views_non_follower",
      "accounts_engaged",
      "total_interactions",
      "likes",
      "comments",
      "shares",
      "saved",
      "new_followers",
      "followers_count_jst_day",
      "fetched_at_jst",
    ]);
  });

  it("thumbnail_path、account_id、署名付き URL の列がない", () => {
    const headers = [...MEDIA_CSV_COLUMNS, ...DAILY_CSV_COLUMNS].map((c) => c.header);
    for (const h of ["thumbnail_path", "account_id", "thumbnail_url", "signed_url"]) expect(headers).not.toContain(h);
  });

  it("caption と permalink は文字列の列（数式の注入の対象）、率は数値の列", () => {
    const kindOf = (h: string) => MEDIA_CSV_COLUMNS.find((c) => c.header === h)?.kind;
    expect(kindOf("caption")).toBe("text");
    expect(kindOf("permalink")).toBe("text");
    expect(kindOf("er")).toBe("number");
    expect(kindOf("posted_at_jst")).toBe("datetime");
  });
});

describe("ファイル名", () => {
  it("出力した日（日本時間）", () => {
    expect(csvFileName("media", new Date("2026-10-04T15:00:00Z"))).toBe("instagram-media-20261005.csv");
    expect(csvFileName("daily", new Date("2026-10-04T14:59:59Z"))).toBe("instagram-daily-20261004.csv");
  });
});
