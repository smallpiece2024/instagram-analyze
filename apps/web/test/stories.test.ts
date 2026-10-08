/**
 * ストーリーズの計算（`lib/stories.ts`）の単体テスト（R5 設計 6.3 節、7.1 節「画面（単体）」の T7、T15、T16）。
 * 行は架空の値をテストの中で作る（DB は使わない）
 */
import { describe, expect, it } from "vitest";
import { PAGE_SIZE } from "@/lib/format";
import { NO_FOLLOWERS_AT_POST_TEXT } from "@/lib/metrics";
import {
  buildStoriesView,
  exitRateMissing,
  groupStories,
  medianWithN,
  paginateStories,
  parseStoriesParams,
  sortStories,
  storiesQuery,
  storyFunnel,
  storyLabel,
  storyOps,
  storySummary,
  storyTrend,
  sumWithN,
  viewRateMissing,
  type StoryRow,
} from "@/lib/stories";

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 8, 1, 3, 0, 0); // JST 2026-09-01 12:00

let seq = 0;
function story(hoursFromT0: number, over: Partial<StoryRow> = {}): StoryRow {
  seq += 1;
  return {
    media_id: String(1000 + seq),
    posted_at: new Date(T0 + hoursFromT0 * HOUR),
    media_type: "IMAGE",
    thumbnail_path: null,
    gone_at: null,
    metrics_fetched_at: null,
    views: 100,
    reach: 90,
    tap_forward: 60,
    tap_back: 10,
    tap_exit: 20,
    swipe_forward: 10,
    link_clicks: 0,
    replies: 0,
    followers_at_post: 1000,
    view_rate: 0.1,
    exit_rate: 0.2,
    in_range: true,
    ...over,
  };
}

describe("入力の検査", () => {
  it("不正な range、sort、dir は既定に戻す", () => {
    expect(parseStoriesParams({ range: "7", sort: "caption", dir: "up" })).toEqual({ range: 30, sort: "posted", dir: "desc" });
    expect(parseStoriesParams({ range: ["90", "365"], sort: ["views"] })).toEqual({ range: 30, sort: "posted", dir: "desc" });
    expect(parseStoriesParams({ range: "365", sort: "exit_rate", dir: "asc" })).toEqual({ range: 365, sort: "exit_rate", dir: "asc" });
  });

  it("既定の値は URL に出さない", () => {
    expect(storiesQuery({ range: 30, sort: "posted", dir: "desc" })).toEqual({ range: undefined, sort: undefined, dir: undefined });
    expect(storiesQuery({ range: 90, sort: "views", dir: "asc" })).toEqual({ range: "90", sort: "views", dir: "asc" });
  });
});

describe("まとまりの判定（T7）", () => {
  it("5 時間間隔の 3 件の鎖は 1 つ（1 件目と 3 件目は 10 時間離れている）", () => {
    const g = groupStories([story(0), story(5), story(10)]);
    expect(g.map((x) => x.length)).toEqual([3]);
  });

  it("6 時間ちょうどは別のまとまり、6 時間未満は同じ", () => {
    const a = story(0);
    const b = story(6);
    expect(groupStories([a, b]).map((x) => x.length)).toEqual([1, 1]);
    const c = story(0);
    const d = { ...story(0), posted_at: new Date(T0 + 6 * HOUR - 1000) };
    expect(groupStories([c, d]).map((x) => x.length)).toEqual([2]);
  });

  it("同時刻の 2 件は同じまとまりで、id の古い順に並ぶ", () => {
    const a = story(0, { media_id: "2" });
    const b = story(0, { media_id: "1" });
    const g = groupStories([a, b]);
    expect(g).toHaveLength(1);
    expect(g[0]?.map((r) => r.media_id)).toEqual(["1", "2"]);
  });

  it("入力の順が乱れていても、古い順に並べ直してから判定する", () => {
    const rows = [story(20), story(0), story(25), story(5)];
    const g = groupStories(rows);
    expect(g.map((x) => x.map((r) => r.posted_at.getTime() - T0))).toEqual([
      [0, 5 * HOUR],
      [20 * HOUR, 25 * HOUR],
    ]);
  });

  it("0 件なら空", () => {
    expect(groupStories([])).toEqual([]);
  });
});

describe("離脱ファネル（T7、T15）", () => {
  it("期間内に 1 件でもあるまとまりのうち最も新しいもの。1 件目が期間外でも 1 件目から描く", () => {
    const rows = [
      story(-100, { views: 300 }),
      story(-99, { views: 150 }),
      story(-3, { views: 200, in_range: false }),
      story(1, { views: 100 }),
      story(2, { views: 50 }),
    ];
    const f = storyFunnel(rows);
    expect(f?.count).toBe(3);
    expect(f?.startLabel).toBe(storyLabel(new Date(T0 - 3 * HOUR)));
    expect(f?.values).toEqual([1, 0.5, 0.25]);
    expect(f?.labels).toEqual(["1 件目", "2 件目", "3 件目"]);
  });

  it("期間外の行だけのまとまりは出さない", () => {
    const rows = [story(-10, { in_range: false }), story(-9, { in_range: false }), story(10)];
    expect(storyFunnel(rows)).toBeNull();
  });

  it("2 件以上のまとまりがなければ null", () => {
    expect(storyFunnel([story(0), story(10), story(20)])).toBeNull();
    expect(storyFunnel([])).toBeNull();
  });

  it("1 件目の閲覧が null なら全部「—」にし、前のまとまりに切り替えない", () => {
    const rows = [story(0, { views: 100 }), story(1, { views: 80 }), story(20, { views: null }), story(21, { views: 40 })];
    const f = storyFunnel(rows);
    expect(f?.count).toBe(2);
    expect(f?.startLabel).toBe(storyLabel(new Date(T0 + 20 * HOUR)));
    expect(f?.values).toEqual([null, null]);
    expect(f?.tips[0]).toBe("1 件目: —（閲覧 —）");
  });

  it("1 件目の閲覧が 0 でも全部「—」", () => {
    const f = storyFunnel([story(0, { views: 0 }), story(1, { views: 5 })]);
    expect(f?.values).toEqual([null, null]);
  });

  it("2 件目が 1 件目より多ければ 100% を超えた値をそのまま返す", () => {
    const f = storyFunnel([story(0, { views: 100 }), story(1, { views: 150 })]);
    expect(f?.values).toEqual([1, 1.5]);
  });

  it("2 件目以降の閲覧が null ならその棒だけ「—」", () => {
    const f = storyFunnel([story(0, { views: 100 }), story(1, { views: null }), story(2, { views: 30 })]);
    expect(f?.values).toEqual([1, null, 0.3]);
  });
});

describe("操作の内訳", () => {
  it("直近 10 件を新しい順に。10 件未満ならあるだけ", () => {
    const many = Array.from({ length: 12 }, (_, i) => story(i * 24));
    const ops = storyOps(many);
    expect(ops).toHaveLength(10);
    expect(ops[0]?.label).toBe(storyLabel(new Date(T0 + 11 * 24 * HOUR)));
    expect(storyOps(many.slice(0, 3))).toHaveLength(3);
    expect(storyOps([])).toEqual([]);
  });

  it("値は次へ、戻る、離脱、次のアカウントへの順。どれかが null なら全部 null", () => {
    expect(storyOps([story(0)])[0]?.values).toEqual([60, 10, 20, 10]);
    expect(storyOps([story(0, { tap_back: null })])[0]?.values).toEqual([null, null, null, null]);
  });

  it("合計 0 の行は 0 のまま渡す（部品が「—」を書く）", () => {
    const r = story(0, { tap_forward: 0, tap_back: 0, tap_exit: 0, swipe_forward: 0 });
    expect(storyOps([r])[0]?.values).toEqual([0, 0, 0, 0]);
  });
});

describe("閲覧率の「—」", () => {
  it("フォロワー数の記録がない、または 0 は no_baseline_data（R3 の文言）", () => {
    expect(viewRateMissing({ view_rate: null, followers_at_post: null })).toEqual({
      reason: "no_baseline_data",
      text: NO_FOLLOWERS_AT_POST_TEXT,
    });
    expect(viewRateMissing({ view_rate: null, followers_at_post: 0 })?.reason).toBe("no_baseline_data");
  });

  it("フォロワー数があり閲覧が null は missing。値があれば null", () => {
    expect(viewRateMissing({ view_rate: null, followers_at_post: 1000 })?.reason).toBe("missing");
    expect(viewRateMissing({ view_rate: 0.1, followers_at_post: 1000 })).toBeNull();
  });

  it("離脱率は閲覧 0 で no_baseline_data、閲覧 null で missing", () => {
    expect(exitRateMissing({ exit_rate: null, views: 0 })?.reason).toBe("no_baseline_data");
    expect(exitRateMissing({ exit_rate: null, views: null })?.reason).toBe("missing");
    expect(exitRateMissing({ exit_rate: 0, views: 10 })).toBeNull();
  });
});

describe("期間全体の指標", () => {
  it("中央値と合計は値のあるものだけで計算し、n を返す", () => {
    const rows = [
      story(0, { view_rate: 0.1, exit_rate: 0.2, link_clicks: 3, replies: 0 }),
      story(24, { view_rate: null, followers_at_post: null, exit_rate: 0.4, link_clicks: null, replies: 0 }),
      story(48, { view_rate: 0.3, exit_rate: null, views: 0, link_clicks: 2, replies: 0 }),
    ];
    const s = storySummary(rows);
    expect(s.count).toBe(3);
    expect(s.viewRate).toEqual({ value: 0.2, n: 2 });
    expect(s.exitRate.n).toBe(2);
    expect(s.exitRate.value).toBeCloseTo(0.3);
    expect(s.linkClicks).toEqual({ value: 5, n: 2 });
    expect(s.replies).toEqual({ value: 0, n: 3 });
  });

  it("値が 1 件もなければ null（NaN を出さない）", () => {
    expect(medianWithN([null, null])).toEqual({ value: null, n: 0 });
    expect(sumWithN([])).toEqual({ value: null, n: 0 });
  });
});

describe("並べ替え（T16）", () => {
  it("null は向きによらず末尾。同じ値は投稿日時の新しい順、さらに id の降順", () => {
    const a = story(0, { media_id: "10", views: 5 });
    const b = story(24, { media_id: "11", views: null });
    const c = story(48, { media_id: "12", views: 5 });
    const d = story(48, { media_id: "13", views: 5 });
    const e = story(72, { media_id: "14", views: 9 });
    const rows = [a, b, c, d, e];
    expect(sortStories(rows, "views", "desc").map((r) => r.media_id)).toEqual(["14", "13", "12", "10", "11"]);
    expect(sortStories(rows, "views", "asc").map((r) => r.media_id)).toEqual(["13", "12", "10", "14", "11"]);
  });

  it("既定（posted、desc）は新しい順", () => {
    const rows = [story(0), story(24), story(48)];
    expect(sortStories(rows, "posted", "desc").map((r) => r.posted_at.getTime() - T0)).toEqual([48 * HOUR, 24 * HOUR, 0]);
  });

  it("ページ送りは PAGE_SIZE 件で、範囲外のページは最後のページに丸める", () => {
    const rows = Array.from({ length: PAGE_SIZE + 3 }, (_, i) => story(i * 24));
    const p = paginateStories(rows, "posted", "desc", 99);
    expect(p.pageCount).toBe(2);
    expect(p.currentPage).toBe(2);
    expect(p.pageRows).toHaveLength(3);
  });
});

describe("閲覧率の推移と画面全体", () => {
  it("推移は古い順で、ラベルは JST の M/D。値のないものは null", () => {
    const t = storyTrend([story(24, { view_rate: null }), story(0)]);
    expect(t.labels).toEqual(["9/1", "9/2"]);
    expect(t.values).toEqual([0.1, null]);
  });

  it("JST の日付で書く（UTC 14:59 と 15:00）", () => {
    expect(storyLabel(new Date(Date.UTC(2026, 8, 1, 14, 59)))).toBe("9/1 23:59");
    expect(storyLabel(new Date(Date.UTC(2026, 8, 1, 15, 0)))).toBe("9/2 00:00");
  });

  it("期間外の行は一覧と指標に入れず、ファネルにだけ使う", () => {
    const rows = [story(-2, { in_range: false, views: 200 }), story(1, { views: 100 })];
    const v = buildStoriesView(rows);
    expect(v.rows).toHaveLength(1);
    expect(v.summary.count).toBe(1);
    expect(v.ops).toHaveLength(1);
    expect(v.trend.values).toHaveLength(1);
    expect(v.funnel?.values).toEqual([1, 0.5]);
  });
});
