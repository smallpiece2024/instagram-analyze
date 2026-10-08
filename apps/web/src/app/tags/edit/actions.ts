"use server";
/**
 * タグの編集の Server Action（R5 設計 6.2 節）。このファイルは Action の関数だけを export する（S3。一覧はテストで固定）。
 * 型、定数、入力の検査は `_edit/input.ts`、SQL は `@/lib/queries/tag-edit`。
 *
 * 各 Action の先頭で順に検査する（どれかで落ちたら何も書かず、汎用の固定の文言を返す）:
 * 1. 同一オリジンの POST か（S2。`isSameOriginPost`。Next.js 自身の Origin の検査に重ねる）
 * 2. 認可（S1）。`checkAccess` には固定の経路 `"/tags/edit"` を渡す。要求の見出しから取った経路は使わない
 * 3. 対象のアカウント（`getTargetAccount()`。フォームから `account_id` を受け取らない）
 * 4. 入力の形（すべて文字列、id の形）と名前（S8）
 *
 * - 成功したら `revalidatePath` で描き直す。対象は `/tags/edit`、`setMediaTags` ではさらに `/tags` と `/media/[id]`（S12）
 * - ログは Action の名前、結果、SQLSTATE だけ（タグの名前、投稿の id を出さない）
 * - 戻り値は `useActionState` の状態（固定の文言だけ。DB のエラー文を返さない。S9）
 */
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { checkAccess } from "@/lib/auth";
import { dbFromEnv, type Db } from "@/lib/db";
import { readEnv } from "@/lib/env";
import { getTargetAccount } from "@/lib/queries/account";
import * as q from "@/lib/queries/tag-edit";
import { isSameOriginPost } from "@/lib/request-guard";
import {
  allValuesAreStrings,
  failed,
  MAX_AXES,
  MAX_VALUES_PER_AXIS,
  messageForFailure,
  normalizeTagName,
  parseDirection,
  parseMediaTagsForm,
  parseTagId,
  saved,
  singleString,
  type TagEditState,
} from "./_edit/input";

const EDIT_PATH = "/tags/edit";

type ActionName =
  | "createAxis"
  | "renameAxis"
  | "deleteAxis"
  | "moveAxis"
  | "createValue"
  | "renameValue"
  | "deleteValue"
  | "moveValue"
  | "setMediaTags";

type RejectReason = "origin" | "access" | "config" | "account" | "input";

function logRejected(action: ActionName, reason: RejectReason): void {
  console.error(`[tag-edit] action=${action} result=rejected reason=${reason}`);
}

/** 1〜3 の検査。通れば DB と対象のアカウントの id を返す。落ちたら理由だけをログに出して undefined */
async function authorize(action: ActionName): Promise<{ db: Db; accountId: string } | undefined> {
  const env = readEnv();
  if (!env.ok) {
    logRejected(action, "config");
    return undefined;
  }
  const h = await headers();
  if (!isSameOriginPost({ secFetchSite: h.get("sec-fetch-site"), origin: h.get("origin") }, env.env.appUrl)) {
    logRejected(action, "origin");
    return undefined;
  }
  // 経路は固定の値。要求の見出し（referer、next-url など）から取らない（S1）
  if ((await checkAccess(EDIT_PATH)) !== "pass") {
    logRejected(action, "access");
    return undefined;
  }
  const account = await getTargetAccount();
  if (!account.ok) {
    logRejected(action, "account");
    return undefined;
  }
  return { db: dbFromEnv(env.env), accountId: account.data.id };
}

/** DB の結果を状態にする。失敗は SQLSTATE だけをログに出す */
function finish(
  action: ActionName,
  result: q.TagWriteResult,
  operation: "insert" | "update" | "delete_value" | "other",
  paths: readonly ["/tags/edit"] | readonly ["/tags/edit", "/tags", "/media/[id]"] = [EDIT_PATH],
): TagEditState {
  if (result.ok) {
    for (const p of paths) {
      if (p === "/media/[id]") revalidatePath(p, "page");
      else revalidatePath(p);
    }
    return saved();
  }
  const sqlstate = result.kind === "db" ? result.sqlstate : undefined;
  console.error(
    `[tag-edit] action=${action} result=${result.kind === "db" ? "db_error" : "not_found"}${sqlstate ? ` sqlstate=${sqlstate}` : ""}`,
  );
  return failed(messageForFailure(operation, sqlstate));
}

/** 4 の前半: すべての値が文字列か。違えば落とす */
function stringsOnly(action: ActionName, formData: FormData): boolean {
  if (allValuesAreStrings(formData)) return true;
  logRejected(action, "input");
  return false;
}

/* ------------------------------------------------------------------
 * 軸
 * ------------------------------------------------------------------ */

export async function createAxis(_prev: TagEditState, formData: FormData): Promise<TagEditState> {
  const ctx = await authorize("createAxis");
  if (!ctx || !stringsOnly("createAxis", formData)) return failed();
  const name = normalizeTagName(singleString(formData, "name"));
  if (name === undefined) {
    logRejected("createAxis", "input");
    return failed();
  }
  return finish("createAxis", await q.createAxis(ctx.db, ctx.accountId, name, MAX_AXES), "insert");
}

export async function renameAxis(_prev: TagEditState, formData: FormData): Promise<TagEditState> {
  const ctx = await authorize("renameAxis");
  if (!ctx || !stringsOnly("renameAxis", formData)) return failed();
  const axisId = parseTagId(singleString(formData, "axis_id"));
  const name = normalizeTagName(singleString(formData, "name"));
  if (axisId === undefined || name === undefined) {
    logRejected("renameAxis", "input");
    return failed();
  }
  return finish("renameAxis", await q.renameAxis(ctx.db, ctx.accountId, axisId, name), "update");
}

/**
 * 軸を消す（S10）。確認の表示（`?confirm_delete=`）のフォームだけが `confirm=delete` を送る。それがなければ消さない。
 * 消したら確認の表示のない `/tags/edit` に移る
 */
export async function deleteAxis(_prev: TagEditState, formData: FormData): Promise<TagEditState> {
  const ctx = await authorize("deleteAxis");
  if (!ctx || !stringsOnly("deleteAxis", formData)) return failed();
  const axisId = parseTagId(singleString(formData, "axis_id"));
  if (axisId === undefined || singleString(formData, "confirm") !== "delete") {
    logRejected("deleteAxis", "input");
    return failed();
  }
  const state = finish("deleteAxis", await q.deleteAxis(ctx.db, ctx.accountId, axisId), "other");
  if (state.status === "ok") redirect(EDIT_PATH);
  return state;
}

export async function moveAxis(_prev: TagEditState, formData: FormData): Promise<TagEditState> {
  const ctx = await authorize("moveAxis");
  if (!ctx || !stringsOnly("moveAxis", formData)) return failed();
  const axisId = parseTagId(singleString(formData, "axis_id"));
  const direction = parseDirection(singleString(formData, "direction"));
  if (axisId === undefined || direction === undefined) {
    logRejected("moveAxis", "input");
    return failed();
  }
  return finish("moveAxis", await q.moveAxis(ctx.db, ctx.accountId, axisId, direction), "other");
}

/* ------------------------------------------------------------------
 * 値
 * ------------------------------------------------------------------ */

export async function createValue(_prev: TagEditState, formData: FormData): Promise<TagEditState> {
  const ctx = await authorize("createValue");
  if (!ctx || !stringsOnly("createValue", formData)) return failed();
  const axisId = parseTagId(singleString(formData, "axis_id"));
  const name = normalizeTagName(singleString(formData, "name"));
  if (axisId === undefined || name === undefined) {
    logRejected("createValue", "input");
    return failed();
  }
  return finish(
    "createValue",
    await q.createValue(ctx.db, ctx.accountId, axisId, name, MAX_VALUES_PER_AXIS),
    "insert",
  );
}

export async function renameValue(_prev: TagEditState, formData: FormData): Promise<TagEditState> {
  const ctx = await authorize("renameValue");
  if (!ctx || !stringsOnly("renameValue", formData)) return failed();
  const valueId = parseTagId(singleString(formData, "value_id"));
  const name = normalizeTagName(singleString(formData, "name"));
  if (valueId === undefined || name === undefined) {
    logRejected("renameValue", "input");
    return failed();
  }
  return finish("renameValue", await q.renameValue(ctx.db, ctx.accountId, valueId, name), "update");
}

/** 値を消す。付いている投稿があれば DB が 23503 で拒み、「使っている投稿があります」を返す */
export async function deleteValue(_prev: TagEditState, formData: FormData): Promise<TagEditState> {
  const ctx = await authorize("deleteValue");
  if (!ctx || !stringsOnly("deleteValue", formData)) return failed();
  const valueId = parseTagId(singleString(formData, "value_id"));
  if (valueId === undefined) {
    logRejected("deleteValue", "input");
    return failed();
  }
  return finish("deleteValue", await q.deleteValue(ctx.db, ctx.accountId, valueId), "delete_value");
}

export async function moveValue(_prev: TagEditState, formData: FormData): Promise<TagEditState> {
  const ctx = await authorize("moveValue");
  if (!ctx || !stringsOnly("moveValue", formData)) return failed();
  const valueId = parseTagId(singleString(formData, "value_id"));
  const direction = parseDirection(singleString(formData, "direction"));
  if (valueId === undefined || direction === undefined) {
    logRejected("moveValue", "input");
    return failed();
  }
  return finish("moveValue", await q.moveValue(ctx.db, ctx.accountId, valueId, direction), "other");
}

/* ------------------------------------------------------------------
 * 投稿へのタグ付け
 * ------------------------------------------------------------------ */

/** 投稿 1 件の軸ごとのタグを保存する（行ごとのフォーム）。空の軸は外す。ストーリーズの id は書かない（Q3） */
export async function setMediaTags(_prev: TagEditState, formData: FormData): Promise<TagEditState> {
  const ctx = await authorize("setMediaTags");
  if (!ctx) return failed();
  const input = parseMediaTagsForm(formData);
  if (input === undefined) {
    logRejected("setMediaTags", "input");
    return failed();
  }
  return finish(
    "setMediaTags",
    await q.setMediaTags(ctx.db, ctx.accountId, input.mediaId, input.entries),
    "other",
    [EDIT_PATH, "/tags", "/media/[id]"],
  );
}
