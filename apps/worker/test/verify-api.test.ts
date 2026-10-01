import { describe, expect, it } from "vitest";
import { describeEndTime, hostTail } from "../src/commands/verify-api.js";

describe("hostTail", () => {
  it("ホスト名の末尾 2 ラベルだけを返す", () => {
    expect(hostTail("https://scontent-nrt1-1.cdninstagram.com/v/t50/video.mp4?oe=1")).toBe("cdninstagram.com");
    expect(hostTail("https://scontent-nrt1-1.xx.fbcdn.net/v/t51/image.jpg")).toBe("fbcdn.net");
  });

  it("URL がない、または解釈できないときは「なし」", () => {
    expect(hostTail(undefined)).toBe("なし");
    expect(hostTail("not a url")).toBe("なし");
  });
});

describe("describeEndTime", () => {
  it("end_time の PT の日付と、対象日との関係を添える（値は含まない）", () => {
    expect(describeEndTime("2026-09-27T07:00:00+0000", "2026-09-27")).toBe(
      "2026-09-27T07:00:00+0000（PT 2026-09-27、対象日と同日）",
    );
    expect(describeEndTime("2026-09-28T07:00:00+0000", "2026-09-27")).toBe(
      "2026-09-28T07:00:00+0000（PT 2026-09-28、対象日の翌日）",
    );
    expect(describeEndTime("2026-09-26T07:00:00+0000", "2026-09-27")).toBe(
      "2026-09-26T07:00:00+0000（PT 2026-09-26、対象日の前日）",
    );
  });

  it("冬時間の end_time（UTC 8 時）も PT の日付になる", () => {
    expect(describeEndTime("2026-12-02T08:00:00+0000", "2026-12-02")).toContain("PT 2026-12-02、対象日と同日");
  });

  it("end_time がない、または解釈できないときは固定文言", () => {
    expect(describeEndTime(undefined, "2026-09-27")).toBe("end_time なし");
    expect(describeEndTime("not a time", "2026-09-27")).toBe("not a time（解釈できない）");
  });
});
