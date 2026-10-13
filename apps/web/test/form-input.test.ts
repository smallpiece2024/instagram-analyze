/**
 * フォームの共通の検査と状態（`lib/form-input.ts`）の単体テスト（R6 設計 7.4 節の 2b）。
 * R5 の `_edit/input.ts` から移した関数が同じ挙動で、`_edit/input.ts` が同じものを再 export していることを確かめる
 */
import { describe, expect, it } from "vitest";
import {
  allValuesAreStrings,
  failed,
  FORM_MESSAGES,
  INITIAL_FORM_STATE,
  saved,
  singleString,
  type FormState,
} from "../src/lib/form-input";
import * as tagEditInput from "../src/app/tags/edit/_edit/input";

function formData(entries: [string, string | Blob][]): FormData {
  const fd = new FormData();
  for (const [k, v] of entries) fd.append(k, v);
  return fd;
}

describe("allValuesAreStrings", () => {
  it("すべて文字列なら真（空でも真）", () => {
    expect(allValuesAreStrings(formData([]))).toBe(true);
    expect(allValuesAreStrings(formData([["a", "1"], ["b", ""]]))).toBe(true);
  });

  it("File（Blob）が 1 つでもあれば偽", () => {
    expect(allValuesAreStrings(formData([["a", "1"], ["f", new Blob(["x"])]]))).toBe(false);
  });
});

describe("singleString", () => {
  it("1 つだけなら文字列で返す（空文字も返す）", () => {
    expect(singleString(formData([["month", "2026-09"]]), "month")).toBe("2026-09");
    expect(singleString(formData([["summary", ""]]), "summary")).toBe("");
  });

  it("ない、同じ名前が 2 つ、文字列でないなら undefined", () => {
    expect(singleString(formData([]), "month")).toBeUndefined();
    expect(singleString(formData([["month", "2026-09"], ["month", "2026-08"]]), "month")).toBeUndefined();
    expect(singleString(formData([["f", new Blob(["x"])]]), "f")).toBeUndefined();
  });
});

describe("状態（FormState、saved、failed）", () => {
  it("初期の状態は idle で文言なし", () => {
    expect(INITIAL_FORM_STATE).toEqual({ status: "idle", message: "" } satisfies FormState);
  });

  it("saved は ok で「保存しました」。文言を差し替えられる", () => {
    expect(saved()).toEqual({ status: "ok", message: "保存しました" });
    expect(saved("更新しました")).toEqual({ status: "ok", message: "更新しました" });
  });

  it("failed は error で「保存できませんでした」。文言を差し替えられる", () => {
    expect(failed()).toEqual({ status: "error", message: "保存できませんでした" });
    expect(failed("月が正しくありません")).toEqual({ status: "error", message: "月が正しくありません" });
  });

  it("共通の文言は固定", () => {
    expect(FORM_MESSAGES).toEqual({ saved: "保存しました", failed: "保存できませんでした" });
  });
});

describe("R5 の _edit/input.ts は同じものを再 export する（import の付け替え。U5）", () => {
  it("関数は同一で、R5 の文言と初期の状態は変わらない", () => {
    expect(tagEditInput.allValuesAreStrings).toBe(allValuesAreStrings);
    expect(tagEditInput.singleString).toBe(singleString);
    expect(tagEditInput.saved).toBe(saved);
    expect(tagEditInput.failed).toBe(failed);
    expect(tagEditInput.INITIAL_TAG_EDIT_STATE).toEqual({ status: "idle", message: "" });
    expect(tagEditInput.TAG_EDIT_MESSAGES.saved).toBe("保存しました");
    expect(tagEditInput.TAG_EDIT_MESSAGES.failed).toBe("保存できませんでした");
    expect(tagEditInput.saved()).toEqual({ status: "ok", message: tagEditInput.TAG_EDIT_MESSAGES.saved });
    expect(tagEditInput.failed()).toEqual({ status: "error", message: tagEditInput.TAG_EDIT_MESSAGES.failed });
  });
});
