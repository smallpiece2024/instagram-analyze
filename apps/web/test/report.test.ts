/**
 * `lib/report.ts`（レポートの純粋関数）の単体テスト（R6 設計 7.1 節「画面（単体）」、T10、T16）。
 * 6 節の上位・下位の選び方、ファネルの率、5 節の率の形、経過日数。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { KindSummaryCard } from "../src/app/report/_report/KindSummaryCard";
import { SECTION_TITLES } from "../src/app/report/_report/titles";
import {
  compareHighlights,
  elapsedDays,
  funnelStages,
  highlightCounts,
  postSumFrom,
  ratioOfSumsFrom,
  splitHighlights,
} from "../src/lib/report";

function post(id: string, share: number | null, postedAt = "2026-10-10T00:00:00Z") {
  return { media_id: id, posted_at: new Date(postedAt), share_rate: share };
}

describe("6 節: 上位・下位の件数（T10）", () => {
  it.each([
    [0, 0, 0],
    [1, 1, 0],
    [2, 1, 1],
    [3, 2, 1],
    [4, 2, 2],
    [5, 3, 2],
    [6, 3, 3],
    [7, 3, 3],
    [20, 3, 3],
  ])("n = %i → 上位 %i・下位 %i", (n, top, bottom) => {
    expect(highlightCounts(n)).toEqual({ top, bottom });
  });

  it("6 件未満でも式を変えない（上位と下位は重ならない）", () => {
    for (let n = 0; n <= 6; n++) {
      const { top, bottom } = highlightCounts(n);
      expect(top + bottom).toBeLessThanOrEqual(n);
    }
  });
});

describe("6 節: splitHighlights", () => {
  it("n = 1 → 上位 1・下位 0、n = 2 → 1・1、n = 3 → 2・1、n = 5 → 3・2", () => {
    const rows = [post("a", 0.5), post("b", 0.4), post("c", 0.3), post("d", 0.2), post("e", 0.1)];
    expect(splitHighlights(rows.slice(0, 1))).toEqual({ top: [rows[0]], bottom: [] });
    expect(splitHighlights(rows.slice(0, 2))).toEqual({ top: [rows[0]], bottom: [rows[1]] });
    expect(splitHighlights(rows.slice(0, 3))).toEqual({ top: [rows[0], rows[1]], bottom: [rows[2]] });
    const five = splitHighlights(rows);
    expect(five.top.map((r) => r.media_id)).toEqual(["a", "b", "c"]);
    // 下位はシェア率の低い順（課題の大きいものから）
    expect(five.bottom.map((r) => r.media_id)).toEqual(["e", "d"]);
  });

  it("シェア率が null の投稿は数にも入れず選ばない", () => {
    const rows = [post("x", null), post("a", 0.2), post("y", null), post("b", 0.1)];
    const { top, bottom } = splitHighlights(rows);
    expect(top.map((r) => r.media_id)).toEqual(["a"]);
    expect(bottom.map((r) => r.media_id)).toEqual(["b"]);
  });

  it("全部 null なら空", () => {
    expect(splitHighlights([post("x", null), post("y", null)])).toEqual({ top: [], bottom: [] });
    expect(splitHighlights([])).toEqual({ top: [], bottom: [] });
  });

  it("同値はシェア率 → 投稿日時の新しい順 → media_id の順", () => {
    const rows = [
      post("c", 0.1, "2026-10-01T00:00:00Z"),
      post("b", 0.1, "2026-10-02T00:00:00Z"),
      post("a", 0.1, "2026-10-02T00:00:00Z"),
      post("d", 0.3, "2026-10-01T00:00:00Z"),
    ];
    expect([...rows].sort(compareHighlights).map((r) => r.media_id)).toEqual(["d", "a", "b", "c"]);
    const { top, bottom } = splitHighlights(rows);
    expect(top.map((r) => r.media_id)).toEqual(["d", "a"]);
    expect(bottom.map((r) => r.media_id)).toEqual(["c", "b"]);
  });

  it("入力の順に依らない", () => {
    const rows = [post("b", 0.2), post("a", 0.3), post("c", 0.1)];
    expect(splitHighlights(rows).top.map((r) => r.media_id)).toEqual(["a", "b"]);
    expect(splitHighlights([...rows].reverse()).top.map((r) => r.media_id)).toEqual(["a", "b"]);
  });
});

describe("5 節: Σの比と合計の形", () => {
  it("ratioOfSumsFrom: 使えた投稿が 0 件なら null、分母 0 なら null、それ以外は比", () => {
    expect(ratioOfSumsFrom(null, null, 0, 3)).toEqual({ value: null, used: 0, total: 3 });
    expect(ratioOfSumsFrom(5, 0, 2, 3)).toEqual({ value: null, used: 2, total: 3 });
    expect(ratioOfSumsFrom(5, 200, 2, 3)).toEqual({ value: 0.025, used: 2, total: 3 });
  });

  it("postSumFrom: 値のある投稿が 0 件なら合計は null", () => {
    expect(postSumFrom(null, 0, 2)).toEqual({ sum: null, used: 0, total: 2 });
    expect(postSumFrom(0, 0, 2)).toEqual({ sum: null, used: 0, total: 2 });
    expect(postSumFrom(120, 2, 2)).toEqual({ sum: 120, used: 2, total: 2 });
  });
});

describe("8 節: ファネルの率（T16）", () => {
  const sum = (s: number | null, used: number, total: number) => ({ sum: s, used, total });

  it("前段比と 1 段目比、used/total", () => {
    const stages = funnelStages([
      { label: "リーチ数", sum: sum(1000, 4, 5) },
      { label: "プロフィール訪問", sum: sum(100, 4, 5) },
      { label: "フォロー", sum: sum(25, 4, 5) },
    ]);
    expect(stages.map((s) => s.stepRate)).toEqual([null, 0.1, 0.25]);
    expect(stages.map((s) => s.shareOfFirst)).toEqual([1, 0.1, 0.025]);
    expect(stages.map((s) => `${s.used}/${s.total}`)).toEqual(["4/5", "4/5", "4/5"]);
    expect(stages[0]?.label).toBe("リーチ数");
  });

  it("前段が 0 なら null（0% と書かない）、1 段目が 0 なら 1 段目比も null", () => {
    const stages = funnelStages([
      { label: "a", sum: sum(0, 1, 1) },
      { label: "b", sum: sum(0, 1, 1) },
      { label: "c", sum: sum(3, 1, 1) },
    ]);
    expect(stages.map((s) => s.stepRate)).toEqual([null, null, null]);
    expect(stages.map((s) => s.shareOfFirst)).toEqual([null, null, null]);
  });

  it("合計が null（投稿なし）なら値も率も null", () => {
    const stages = funnelStages([
      { label: "a", sum: sum(null, 0, 0) },
      { label: "b", sum: sum(null, 0, 0) },
    ]);
    expect(stages.map((s) => s.value)).toEqual([null, null]);
    expect(stages.map((s) => s.stepRate)).toEqual([null, null]);
    expect(stages.map((s) => s.shareOfFirst)).toEqual([null, null]);
  });

  it("空の入力は空", () => {
    expect(funnelStages([])).toEqual([]);
  });
});

describe("経過日数（秒 → 日、切り捨て）", () => {
  it("切り捨て、負は 0、null は null", () => {
    expect(elapsedDays(0)).toBe(0);
    expect(elapsedDays(86399)).toBe(0);
    expect(elapsedDays(86400)).toBe(1);
    expect(elapsedDays(86400 * 12 + 86399)).toBe(12);
    expect(elapsedDays(-5)).toBe(0);
    expect(elapsedDays(null)).toBeNull();
    expect(elapsedDays(undefined)).toBeNull();
    expect(elapsedDays(Number.NaN)).toBeNull();
  });
});

/* ------------------------------------------------------------------
 * 方針の回帰（R6 設計 7.1 節「方針の回帰」）
 * ------------------------------------------------------------------ */

describe("方針の回帰: 6 節の選び方は印と判定の有無に依らない", () => {
  it("印（share_flag）が null や none でも、比較対象が 8 件未満（peer_n < 8）でも選ばれる。選び方は share_rate だけを見る", () => {
    const rows = [
      { ...post("a", 1 / 2), share_flag: null, peer_n: 0 },
      { ...post("b", 1 / 4), share_flag: "none", peer_n: 3 },
      { ...post("c", 1 / 8), share_flag: "low", peer_n: 20 },
      { ...post("d", 1 / 16), share_flag: null, peer_n: 7 },
    ];
    const { top, bottom } = splitHighlights(rows);
    expect(top.map((r) => r.media_id)).toEqual(["a", "b"]);
    expect(bottom.map((r) => r.media_id)).toEqual(["d", "c"]);
    // 印と peer_n の列を落としても同じ結果（印は選び方に関係しない）
    const plain = splitHighlights(rows.map(({ media_id, posted_at, share_rate }) => ({ media_id, posted_at, share_rate })));
    expect(plain.top.map((r) => r.media_id)).toEqual(["a", "b"]);
    expect(plain.bottom.map((r) => r.media_id)).toEqual(["d", "c"]);
  });

  it("月の投稿が 6 件未満でも式は同じ（4 件 → 2・2）。7 件は 3・3 で止め、上位と下位は重ならない", () => {
    const four = ["a", "b", "c", "d"].map((id, i) => post(id, (4 - i) / 8));
    const s4 = splitHighlights(four);
    expect(s4.top.map((r) => r.media_id)).toEqual(["a", "b"]);
    expect(s4.bottom.map((r) => r.media_id)).toEqual(["d", "c"]);

    const seven = ["a", "b", "c", "d", "e", "f", "g"].map((id, i) => post(id, (7 - i) / 8));
    const s7 = splitHighlights(seven);
    expect(s7.top.map((r) => r.media_id)).toEqual(["a", "b", "c"]);
    expect(s7.bottom.map((r) => r.media_id)).toEqual(["g", "f", "e"]);
    expect(s7.top.filter((r) => s7.bottom.includes(r))).toEqual([]);
  });
});

/** 5 節のカードは DB を読むので、`queries/report.ts` を差し替えて描く（値は架空） */
vi.mock("../src/lib/queries/report", () => {
  const ratio = (value: number | null, used: number, total: number) => ({ value, used, total });
  const sum = (s: number | null, used: number, total: number) => ({ sum: s, used, total });
  const kind = (k: "feed" | "carousel" | "reel", posts: number) => ({
    kind: k,
    posts,
    reach: sum(posts === 0 ? null : 100 * posts, posts, posts),
    views: sum(posts === 0 ? null : 300 * posts, posts, posts),
    er: ratio(posts === 0 ? null : 0.06, posts, posts),
    saveRate: ratio(posts === 0 ? null : 0.02, posts, posts),
    shareRate: ratio(posts === 0 ? null : 0.01, posts, posts),
    profileVisits: sum(null, 0, posts),
  });
  return {
    getKindSummary: vi.fn(async () => ({ ok: true, data: [kind("feed", 2), kind("carousel", 0), kind("reel", 9)] })),
    getStorySummary: vi.fn(async () => ({
      ok: true,
      data: { posts: 1, views: sum(100, 1, 1), tapExit: sum(10, 1, 1), exitRate: ratio(0.1, 1, 1) },
    })),
  };
});

describe("方針の回帰: 5 節の列は固定で、目標比の列がない（U9、T15）", () => {
  it("見出しは「種類」+ 8 列で「目標」の列がない。4 行（フィード、カルーセル、リール、ストーリーズ）が同じ列数で、当てはまらない欄は —", async () => {
    const element = await KindSummaryCard({ accountId: "00000000-0000-0000-0000-00000000000a", period: { from: "2026-09-01", to: "2026-09-30" } });
    const html = renderToStaticMarkup(element);
    const heads = [...html.matchAll(/<th(?:\s[^>]*)?>(.*?)<\/th>/g)].map((m) => m[1]);
    expect(heads).toEqual(["種類", "件数", "Σリーチ", "Σ閲覧数", "ER", "保存率", "シェア率", "プロフィール訪問", "離脱率"]);
    expect(html).not.toContain("目標");
    expect((html.match(/<tbody>[\s\S]*<\/tbody>/) ?? [""])[0].match(/<tr/g) ?? []).toHaveLength(4);
    expect(html.match(/<td/g) ?? []).toHaveLength(4 * 9);
    // 件数 0 のカルーセルも「—」で同じ列に出る（種類で分岐しない）
    expect(html).toContain("—");
    expect(html).not.toMatch(/NaN|Infinity|undefined/);
  });

  it("節は 9 つで番号と見出しが固定。目標の節はない", () => {
    const titles = Object.values(SECTION_TITLES);
    expect(titles).toHaveLength(9);
    expect(titles.map((t) => t.split(".")[0])).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    expect(titles.some((t) => t.includes("目標"))).toBe(false);
  });
});
