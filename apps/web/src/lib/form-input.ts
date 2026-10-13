/**
 * フォームを受ける Server Action の共通の検査と状態（R5 設計 6.2 節の S8、S9 から R6 で切り出した。R6 設計 6.2 節 U5）。
 * 純粋関数（`server-only` なし。単体テストで直接呼ぶ）。
 *
 * - FormData の値はすべて文字列であること（`File` を拒む）
 * - 1 つの名前の値は 1 つだけ取る（ない、同じ名前が 2 つ以上、文字列でないなら拒む）
 * - `useActionState` の状態は `{ status, message }`。文言は固定で、DB のエラー文や入力の値を含めない
 *
 * 画面ごとの検査と文言（タグの名前、レポートの本文など）はここに置かず、各画面の `input.ts` に置く
 */

/** 共通の文言。画面ごとの文言はこれを使い回すか、各画面の `input.ts` で足す */
export const FORM_MESSAGES = {
  saved: "保存しました",
  failed: "保存できませんでした",
} as const;

/** Server Action の戻り値（`useActionState` の状態）。文言は固定の文言だけ */
export interface FormState {
  status: "idle" | "ok" | "error";
  message: string;
}

export const INITIAL_FORM_STATE: FormState = { status: "idle", message: "" };

/** FormData のすべての値が文字列か（`File` があれば偽） */
export function allValuesAreStrings(formData: FormData): boolean {
  for (const [, v] of formData.entries()) {
    if (typeof v !== "string") return false;
  }
  return true;
}

/** 1 つの名前の値を 1 つだけ文字列で取る。ない、2 つ以上、文字列でないなら undefined */
export function singleString(formData: FormData, name: string): string | undefined {
  const all = formData.getAll(name);
  if (all.length !== 1) return undefined;
  const v = all[0];
  return typeof v === "string" ? v : undefined;
}

/** 失敗の状態 */
export function failed(message: string = FORM_MESSAGES.failed): FormState {
  return { status: "error", message };
}

/** 成功の状態 */
export function saved(message: string = FORM_MESSAGES.saved): FormState {
  return { status: "ok", message };
}
