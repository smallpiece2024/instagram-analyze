/**
 * 文字で探す（`lib/text-search.ts`。R4.1 設計 6.3 節、8 章「画面」）の単体テスト。
 * 正規化はワーカーの `normalizeText` と同じ入出力の表（両方のパッケージに同じ表を置く）
 */
import { describe, expect, it } from "vitest";
import { escapeLike, likePattern, normalizeText, parseSearchText, SEARCH_MAX_CODE_POINTS } from "@/lib/text-search";

/** ワーカーの `normalizeText` と同じ入出力の表 */
const NORMALIZE_TABLE: readonly [string, string][] = [
  ["ＡＢＣ１２３", "abc123"], // NFKC の全角英数と小文字化
  ["Hello World", "helloworld"], // 大文字と ASCII の空白
  ["東京　駅", "東京駅"], // 全角空白 U+3000
  ["が", "が"], // 結合濁点 U+3099 が合成される
  ["ｶﾀｶﾅ", "カタカナ"], // 半角カナ
  ["🍣寿司", "🍣寿司"], // 絵文字は残る
  ["a\tb\nc\r\n d", "abcd"], // 制御の空白
  ["％＿＼", "%_\\"], // 全角の記号は NFKC で ASCII に
  ["", ""],
];

describe("normalizeText（ワーカーと同じ入出力）", () => {
  it.each(NORMALIZE_TABLE)("%j → %j", (input, expected) => {
    expect(normalizeText(input)).toBe(expected);
  });
});

describe("parseSearchText: 正規化 → 空白除去 → 長さの検査", () => {
  it("文字列でない（配列、undefined）は null", () => {
    expect(parseSearchText(undefined)).toBeNull();
    expect(parseSearchText(["a", "b"])).toBeNull();
    expect(parseSearchText(12)).toBeNull();
  });

  it("空と空白だけは null（既定の画面）", () => {
    expect(parseSearchText("")).toBeNull();
    expect(parseSearchText("   ")).toBeNull();
    expect(parseSearchText("　\t\n")).toBeNull();
  });

  it("全角は NFKC で正規化した値を返す", () => {
    expect(parseSearchText("ＡＢＣ 徒歩")).toBe("abc徒歩");
  });

  it("長さは正規化後のコードポイントで 1〜100。サロゲートペアは 1 文字", () => {
    expect(SEARCH_MAX_CODE_POINTS).toBe(100);
    expect(parseSearchText("a".repeat(100))).toBe("a".repeat(100));
    expect(parseSearchText("a".repeat(101))).toBeNull();
    // 絵文字 100 個（UTF-16 では 200 単位）は 100 コードポイントなので通る
    expect(parseSearchText("🍣".repeat(100))).toBe("🍣".repeat(100));
    expect(parseSearchText("🍣".repeat(101))).toBeNull();
    // 全角英字 100 個 + 空白は、空白を除いて 100 なので通る
    expect(parseSearchText(`${"Ａ".repeat(100)} `)).toBe("a".repeat(100));
    // 半角カナ「ｶﾞ」（UTF-16 で 2 単位）は NFKC で「ガ」1 コードポイントに合成されるので、100 個で 100
    expect(parseSearchText("ｶﾞ".repeat(100))).toBe("ガ".repeat(100));
    expect(parseSearchText("ｶﾞ".repeat(101))).toBeNull();
  });
});

describe("escapeLike と likePattern: エスケープは正規化の後", () => {
  it("\\、%、_ を \\ でエスケープする", () => {
    expect(escapeLike("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
    expect(escapeLike("普通")).toBe("普通");
    expect(likePattern("a%")).toBe("%a\\%%");
  });

  it("全角の ％・＿・＼ が NFKC 後にエスケープされる（順を逆にすると素通りする）", () => {
    const q = parseSearchText("１００％ ＿ ＼") as string;
    expect(q).toBe("100%_\\");
    expect(likePattern(q)).toBe("%100\\%\\_\\\\%");
    // 逆の順（エスケープ → 正規化）では全角の記号がエスケープされずワイルドカードになってしまう
    expect(normalizeText(escapeLike("％"))).toBe("%");
  });
});
