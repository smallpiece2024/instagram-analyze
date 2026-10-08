/**
 * タグ分析（`/tags`）の計算（`lib/tags.ts`）とカードの単体テスト（R5 設計 6.1 節、7.1 節「画面（単体）」）。
 * 行は架空の値をテストの中で作る（DB は使わない）
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HashtagCard, KindCompareCard, TagCompareCard } from "@/app/tags/_tags/cards";
import { parseKindFilter, parseSelectedAxis, parseTagMetric } from "@/lib/params";
import {
  buildTagsView,
  filterKind,
  HASHTAG_LIMIT,
  hashtagTable,
  kindGroupRows,
  medianCell,
  sortByOrder,
  tagGroupRows,
  tagsHref,
  tagsQuery,
  UNTAGGED_LABEL,
  type HashtagPostRow,
  type PostKind,
  type TagPostRow,
  type TagValue,
} from "@/lib/tags";

const BASE = new Date("2026-10-01T00:00:00Z");
let seq = 0;

function post(p: Partial<TagPostRow> = {}): TagPostRow {
  seq += 1;
  return {
    media_id: `m${String(seq).padStart(4, "0")}`,
    kind: "feed",
    posted_at: new Date(BASE.getTime() - seq * 3600_000),
    caption: null,
    elapsed_hours: 48,
    reach: null,
    views: null,
    er: null,
    save_rate: null,
    share_rate: null,
    reach_rate: null,
    value_id: null,
    ...p,
  };
}

function hashtag(tag: string, p: Partial<HashtagPostRow> = {}): HashtagPostRow {
  seq += 1;
  return {
    tag,
    media_id: `h${seq}`,
    kind: "feed",
    posted_at: new Date(BASE.getTime() - seq * 3600_000),
    reach: null,
    views: null,
    er: null,
    save_rate: null,
    share_rate: null,
    reach_rate: null,
    ...p,
  };
}

const VALUES: TagValue[] = [
  { id: "12", name: "旅行", sort_order: 1 },
  { id: "3", name: "料理", sort_order: 0 },
  { id: "9", name: "未使用", sort_order: 1 },
];

describe("入力の検査（T12）", () => {
  const axisIds = ["5", "7"];
  it("形が違う、消された軸、別のアカウントの軸は最初の軸", () => {
    for (const v of ["abc", "1e3", "-5", "5 ", "1234567890123456789", "99", ["5", "7"], undefined, ""]) {
      expect(parseSelectedAxis(v, axisIds)).toBe("5");
    }
    expect(parseSelectedAxis("7", axisIds)).toBe("7");
  });
  it("軸が 0 件なら undefined", () => {
    expect(parseSelectedAxis("5", [])).toBeUndefined();
  });
  it("kind と m の不正値は既定", () => {
    expect(parseKindFilter("story")).toBe("all");
    expect(parseKindFilter(["reel"])).toBe("all");
    expect(parseTagMetric("likes")).toBe("reach");
    expect(parseTagMetric("reach_rate")).toBe("reach_rate");
  });
});

describe("クエリの組み立て", () => {
  it("既定の値（最初の軸、all、reach）は出さない", () => {
    expect(tagsQuery({ axis: "5", kind: "all", m: "reach" }, "5")).toEqual({ axis: undefined, kind: undefined, m: undefined });
    expect(tagsHref({ axis: "5", kind: "all", m: "reach" }, "5", { m: "er" })).toBe("/tags?m=er");
    expect(tagsHref({ axis: "7", kind: "reel", m: "er" }, "5", { kind: "all" })).toBe("/tags?axis=7&m=er");
  });
});

describe("並び", () => {
  it("sort_order、同じなら id の数の順（文字の順ではない）", () => {
    expect(sortByOrder(VALUES).map((v) => v.id)).toEqual(["3", "9", "12"]);
  });
});

describe("中央値と n（列ごと）", () => {
  it("null と有限でない値は数えない。0 件は null", () => {
    expect(medianCell([1, null, 3, Number.NaN, 2])).toEqual({ n: 3, value: 2 });
    expect(medianCell([1, 2])).toEqual({ n: 2, value: 1.5 });
    expect(medianCell([])).toEqual({ n: 0, value: null });
  });
});

describe("タグごとの比較の行", () => {
  const rows = [
    post({ value_id: "3", kind: "reel", reach: 100, reach_rate: 0.1 }),
    post({ value_id: "3", kind: "feed", reach: 300 }),
    post({ value_id: "12", kind: "feed", reach: 50, save_rate: 0.02 }),
    post({ value_id: null, kind: "carousel", reach: 10 }),
    post({ value_id: null, kind: "feed", reach: null }),
  ];
  const out = tagGroupRows(rows, VALUES, "reach");

  it("値の並びで、0 件の値の行も出し、最後に「タグなし」", () => {
    expect(out.map((r) => r.label)).toEqual(["料理", "未使用", "旅行", UNTAGGED_LABEL]);
    expect(out.map((r) => r.n)).toEqual([2, 0, 1, 2]);
  });
  it("0 件の値の行は中央値の n が 0", () => {
    const empty = out[1];
    expect(empty?.medians.reach).toEqual({ n: 0, value: null });
    expect(empty?.elapsedHours.n).toBe(0);
    expect(empty?.points).toEqual([]);
  });
  it("列ごとの n（リーチ率は値のある投稿だけ）", () => {
    const r = out[0];
    expect(r?.medians.reach).toEqual({ n: 2, value: 200 });
    expect(r?.medians.reach_rate).toEqual({ n: 1, value: 0.1 });
    expect(r?.kindCounts).toEqual({ feed: 1, carousel: 0, reel: 1 });
  });
  it("「タグなし」は値のない投稿。点は選んだ指標の値がある投稿だけ", () => {
    const u = out[3];
    expect(u?.id).toBeNull();
    expect(u?.n).toBe(2);
    expect(u?.points.map((p) => p.value)).toEqual([10]);
    expect(u?.points[0]?.href).toMatch(/^\/media\/m\d{4}$/);
  });
  it("値が 0 件（軸の値がまだない）でも「タグなし」の行だけ出る", () => {
    expect(tagGroupRows(rows, [], "reach").map((r) => r.label)).toEqual([UNTAGGED_LABEL]);
  });
});

describe("種類の絞り込みと種類ごとの比較", () => {
  const rows = [
    post({ kind: "reel", reach: 1, value_id: "3" }),
    post({ kind: "reel", reach: 3 }),
    post({ kind: "feed", reach: 10, value_id: "3" }),
    post({ kind: "carousel", reach: 20 }),
  ];
  it("filterKind", () => {
    expect(filterKind(rows, "all")).toHaveLength(4);
    expect(filterKind(rows, "reel").map((r) => r.kind)).toEqual(["reel", "reel"]);
  });
  it("種類ごとの比較は kind の選択に従わない", () => {
    const view = buildTagsView(rows, VALUES, [], "reel", "reach");
    expect(view.kindRows.map((r) => r.n)).toEqual([1, 1, 2]);
    expect(view.kindRows.map((r) => r.label)).toEqual(["フィード", "カルーセル", "リール"]);
    expect(kindGroupRows(rows, "reach")[2]?.medians.reach.value).toBe(2);
  });
  it("見出しの n と m は同じ kind の条件で数える", () => {
    const view = buildTagsView(rows, VALUES, [], "reel", "reach");
    expect(view.total).toBe(2);
    expect(view.tagged).toBe(1);
    expect(view.kindCounts).toEqual({ all: 4, reel: 2, feed: 1, carousel: 1 });
    expect(view.overall).toBe(2);
  });
  it("指標の件数は値がある投稿の数", () => {
    const view = buildTagsView([post({ reach: 1 }), post({ reach: 2, reach_rate: 0.1 })], [], [], "all", "reach_rate");
    expect(view.metricCounts.reach).toBe(2);
    expect(view.metricCounts.reach_rate).toBe(1);
    expect(view.overall).toBe(0.1);
  });
});

describe("ハッシュタグ（F-UI-32）", () => {
  it("件数の多い順、同数は中央値の高い順（値なしは後ろ）、さらに文字列の順", () => {
    const rows = [
      hashtag("b", { reach: 10 }),
      hashtag("b", { reach: 10 }),
      hashtag("a", { reach: 5 }),
      hashtag("c", { reach: 50 }),
      hashtag("z", { reach: null }),
      hashtag("y", { reach: 50 }),
    ];
    const t = hashtagTable(rows, "reach");
    expect(t.rows.map((r) => r.tag)).toEqual(["b", "c", "y", "a", "z"]);
    expect(t.rows[0]?.n).toBe(2);
    expect(t.rows.at(-1)?.metric).toEqual({ n: 0, value: null });
    expect(t.rest).toBe(0);
  });
  it("最後に使った日は最も新しい投稿日時", () => {
    const d1 = new Date("2026-01-01T00:00:00Z");
    const d2 = new Date("2026-05-01T00:00:00Z");
    const t = hashtagTable([hashtag("x", { posted_at: d1 }), hashtag("x", { posted_at: d2 })], "reach");
    expect(t.rows[0]?.lastUsedAt.getTime()).toBe(d2.getTime());
  });
  it("上位 30 行と残りの行数（30、31 件の境目）", () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) => hashtag(`t${String(i).padStart(2, "0")}`));
    expect(hashtagTable(make(30), "reach")).toMatchObject({ rest: 0 });
    const t = hashtagTable(make(31), "reach");
    expect(t.rows).toHaveLength(HASHTAG_LIMIT);
    expect(t.rest).toBe(1);
  });
  it("kind の選択に従う", () => {
    const rows = [hashtag("x", { kind: "reel" as PostKind }), hashtag("y", { kind: "feed" as PostKind })];
    expect(buildTagsView([post()], [], rows, "reel", "reach").hashtags.rows.map((r) => r.tag)).toEqual(["x"]);
  });
});

describe("カードの描画", () => {
  const evil = `#<img src=x onerror=alert(1)><script>alert(1)</script>`;

  it("利用者の文字（値の名前、キャプション、ハッシュタグ）は文字として出る（S11）", () => {
    const rows = tagGroupRows(
      [post({ value_id: "1", reach: 10, caption: evil })],
      [{ id: "1", name: evil, sort_order: 0 }],
      "reach",
    );
    const html = renderToStaticMarkup(createElement(TagCompareCard, { axisName: evil, rows, m: "reach", overall: 10 }));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");

    const t = hashtagTable([hashtag(evil, { reach: 1 })], "reach");
    const h = renderToStaticMarkup(createElement(HashtagCard, { table: t, m: "reach" }));
    expect(h).not.toContain("<script>");
    expect(h).toContain("&lt;img");
  });

  it("n が 0 の列は「—」、0 件の値の行も出る", () => {
    const rows = tagGroupRows([post({ value_id: null, reach: 5 })], [{ id: "1", name: "空の値", sort_order: 0 }], "reach");
    const html = renderToStaticMarkup(createElement(TagCompareCard, { axisName: "軸", rows, m: "reach", overall: 5 }));
    expect(html).toContain("空の値");
    expect(html).toContain("—");
    expect(html).not.toContain("NaN");
  });

  it("種類ごとの比較とハッシュタグの空", () => {
    expect(renderToStaticMarkup(createElement(KindCompareCard, { rows: kindGroupRows([], "reach") }))).not.toContain("NaN");
    const h = renderToStaticMarkup(createElement(HashtagCard, { table: { rows: [], rest: 0 }, m: "reach" }));
    expect(h).toContain("ハッシュタグを使った投稿がありません");
  });

  it("ハッシュタグの 3 件未満の行は薄く、残りの行数を書く", () => {
    const t = hashtagTable([hashtag("a"), hashtag("b"), hashtag("b"), hashtag("b")], "reach", 1);
    const h = renderToStaticMarkup(createElement(HashtagCard, { table: t, m: "save_rate" }));
    expect(h).toContain("ほか 1 件");
    expect(h).not.toContain('class="dim"');
    const t2 = hashtagTable([hashtag("a")], "reach");
    expect(renderToStaticMarkup(createElement(HashtagCard, { table: t2, m: "reach" }))).toContain('class="dim"');
  });
});
