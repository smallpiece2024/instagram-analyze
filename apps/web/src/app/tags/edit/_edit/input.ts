/**
 * タグの編集（`/tags/edit`）の入力の検査と、Server Action が返す状態と文言（R5 設計 6.2 節。S8、S9）。
 * 純粋関数（`server-only` なし。単体テストで直接呼ぶ）。`actions.ts`（`'use server'`）は Action だけを export するので（S3）、
 * 型、定数、補助の関数はここに置く。
 *
 * - FormData の値はすべて文字列であること（`File` を拒む）
 * - 軸と値の id は `^\d{1,18}$`、投稿の id は `^\d{1,25}$`
 * - 名前: NFC → trim → 1〜30 コードポイント → 制御文字・書式文字・サロゲート・私用領域（`\p{Cc}\p{Cf}\p{Cs}\p{Co}`）を拒む。
 *   `#` で始まる名前は拒まない。DB の check（D15）が後ろで守る
 * - `setMediaTags` のキーは `^axis_\d{1,18}$` で 10 個まで、値は空（なし）か `^\d{1,18}$`。同じキーが 2 回あれば拒む
 */

/** 軸の数の上限（画面とサーバーの Action で検査する。DB には置かない。5.1 (5)） */
export const MAX_AXES = 10;
/** 1 つの軸の値の数の上限 */
export const MAX_VALUES_PER_AXIS = 50;
/** 名前の長さの上限（コードポイント。DB の check と同じ） */
export const MAX_NAME_LENGTH = 30;
/** 投稿へのタグ付けの表の 1 ページの件数 */
export const TAG_MEDIA_PAGE_SIZE = 50;

/** 文言（S9、T6）。DB のエラー文は返さない */
export const TAG_EDIT_MESSAGES = {
  saved: "保存しました",
  duplicate: "同じ名前があります",
  inUse: "使っている投稿があります",
  failed: "保存できませんでした",
} as const;

/** Server Action の戻り値（`useActionState` の状態）。文言は上の固定の文言だけ */
export interface TagEditState {
  status: "idle" | "ok" | "error";
  message: string;
}

export const INITIAL_TAG_EDIT_STATE: TagEditState = { status: "idle", message: "" };

export type MoveDirection = "up" | "down";

// 先頭の 0 を拒む（`axis_1` と `axis_01` が別のキーとして重複の検査をすり抜けないように）
const ID_PATTERN = /^[1-9]\d{0,17}$/;
const MEDIA_ID_PATTERN = /^\d{1,25}$/;
const AXIS_KEY_PATTERN = /^axis_([1-9]\d{0,17})$/;
const FORBIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}]/u;

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

/** 軸か値の id（`^\d{1,18}$`） */
export function parseTagId(value: unknown): string | undefined {
  return typeof value === "string" && ID_PATTERN.test(value) ? value : undefined;
}

/** 投稿の id（`^\d{1,25}$`） */
export function parseTagMediaId(value: unknown): string | undefined {
  return typeof value === "string" && MEDIA_ID_PATTERN.test(value) ? value : undefined;
}

/** 並べ替えの向き */
export function parseDirection(value: unknown): MoveDirection | undefined {
  return value === "up" || value === "down" ? value : undefined;
}

/**
 * 軸と値の名前（S8）。NFC にして前後の空白を除き、1〜30 コードポイントで、禁止の文字を含まなければ返す。
 * 不正なら undefined
 */
export function normalizeTagName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const s = value.normalize("NFC").trim();
  const length = [...s].length;
  if (length < 1 || length > MAX_NAME_LENGTH) return undefined;
  if (FORBIDDEN_CHARS.test(s)) return undefined;
  return s;
}

/** 投稿 1 件の軸ごとの指定。`valueId` が null の軸はタグを外す */
export interface MediaTagEntry {
  axisId: string;
  valueId: string | null;
}

/**
 * `setMediaTags` の入力。`media_id` と `axis_{id}` のキーだけを読む（ほかのキー、たとえば Next.js が JS なしの送信で足す
 * `$ACTION_` のキーは読まない）。`axis_` で始まるキーが形に合わない、11 個以上、同じキーが 2 回、値の形が違う、
 * 投稿の id が不正なら undefined
 */
export function parseMediaTagsForm(formData: FormData): { mediaId: string; entries: MediaTagEntry[] } | undefined {
  if (!allValuesAreStrings(formData)) return undefined;
  const mediaId = parseTagMediaId(singleString(formData, "media_id"));
  if (mediaId === undefined) return undefined;
  const seen = new Set<string>();
  const entries: MediaTagEntry[] = [];
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("axis_")) continue;
    const m = AXIS_KEY_PATTERN.exec(key);
    if (!m || m[1] === undefined) return undefined;
    if (seen.has(key)) return undefined;
    seen.add(key);
    if (typeof value !== "string") return undefined;
    if (value === "") {
      entries.push({ axisId: m[1], valueId: null });
    } else if (ID_PATTERN.test(value)) {
      entries.push({ axisId: m[1], valueId: value });
    } else {
      return undefined;
    }
    if (entries.length > MAX_AXES) return undefined;
  }
  return { mediaId, entries };
}

/** 失敗の状態 */
export function failed(message: string = TAG_EDIT_MESSAGES.failed): TagEditState {
  return { status: "error", message };
}

/** 成功の状態 */
export function saved(): TagEditState {
  return { status: "ok", message: TAG_EDIT_MESSAGES.saved };
}

/**
 * DB の結果の失敗の種類から文言を決める（T6）。23505 は「同じ名前があります」、値の削除の 23503 は
 * 「使っている投稿があります」、それ以外（insert／update の 23503、0 行、上限、ほかの SQLSTATE）は汎用の文言
 */
export function messageForFailure(
  operation: "insert" | "update" | "delete_value" | "other",
  sqlstate: string | undefined,
): string {
  if (sqlstate === "23505" && (operation === "insert" || operation === "update")) return TAG_EDIT_MESSAGES.duplicate;
  if (sqlstate === "23503" && operation === "delete_value") return TAG_EDIT_MESSAGES.inUse;
  return TAG_EDIT_MESSAGES.failed;
}
