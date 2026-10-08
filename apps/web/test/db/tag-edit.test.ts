/**
 * `lib/queries/tag-edit.ts` の結合テスト（R5 設計 7.1 節「画面（結合）」、7.3 節の数の上限と並び順。S4、T11、Q3）。
 * `TEST_DATABASE_URL` があるときだけ動く。架空のアカウント A と B を作り、A として読み書きして、B の行に効かないことを確かめる。
 * `afterAll` でアカウントを消す（カスケードで軸、値、投稿、タグも消える）。
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllDb, getDb, type Db } from "@/lib/db";
import {
  createAxis,
  createValue,
  deleteAxis,
  deleteValue,
  getTagEditor,
  getTagMediaPage,
  moveAxis,
  moveValue,
  renameAxis,
  renameValue,
  setMediaTags,
} from "@/lib/queries/tag-edit";
import { fakeMediaId, insertFakeAccount, insertMedia, insertMediaTag, insertTagAxis, insertTagValue, setWebEnv } from "./fixtures";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("queries/tag-edit（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  let sql: postgres.Sql;
  let db: Db;
  let accountA = "";
  let accountB = "";
  let restoreEnv: () => void = () => {};
  const P = new Date("2026-08-01T00:00:00Z");
  const ids = {
    a1: fakeMediaId(101),
    a2: fakeMediaId(102),
    aStory: fakeMediaId(103),
    b1: fakeMediaId(104),
  };

  async function axesOf(accountId: string) {
    return sql<{ id: string; name: string; sort_order: number }[]>`
      select id::text as id, name, sort_order from public.tag_axes where account_id = ${accountId} order by tag_axes.sort_order, tag_axes.id
    `;
  }

  async function valuesOf(axisId: string) {
    return sql<{ id: string; name: string; sort_order: number }[]>`
      select id::text as id, name, sort_order from public.tag_values where axis_id = ${axisId}::bigint order by tag_values.sort_order, tag_values.id
    `;
  }

  async function tagsOf(mediaId: string) {
    return sql<{ axis_id: string; value_id: string }[]>`
      select axis_id::text as axis_id, value_id::text as value_id from public.media_tags where media_id = ${mediaId} order by media_tags.axis_id
    `;
  }

  beforeAll(async () => {
    restoreEnv = setWebEnv(url);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    db = getDb(url);
    accountA = await insertFakeAccount(sql, "fake_tag_edit_a");
    accountB = await insertFakeAccount(sql, "fake_tag_edit_b");
    await insertMedia(sql, { id: ids.a1, accountId: accountA, postedAt: P });
    await insertMedia(sql, { id: ids.a2, accountId: accountA, postedAt: new Date(P.getTime() + 3600_000), mediaType: "CAROUSEL_ALBUM" });
    await insertMedia(sql, { id: ids.aStory, accountId: accountA, postedAt: P, productType: "STORY" });
    await insertMedia(sql, { id: ids.b1, accountId: accountB, postedAt: P });
  });

  afterAll(async () => {
    for (const id of [accountA, accountB]) {
      if (id !== "") await sql`delete from public.accounts where id = ${id}`;
    }
    await closeAllDb();
    await sql.end({ timeout: 5 });
    restoreEnv();
  });

  it("createAxis: 並び順は最大値 + 1（空なら 0）。同じ名前は 23505。11 個目は 0 行", async () => {
    expect(await createAxis(db, accountA, "テーマ", 10)).toEqual({ ok: true });
    expect(await createAxis(db, accountA, "目的", 10)).toEqual({ ok: true });
    const axes = await axesOf(accountA);
    expect(axes.map((a) => [a.name, a.sort_order])).toEqual([
      ["テーマ", 0],
      ["目的", 1],
    ]);
    expect(await createAxis(db, accountA, "テーマ", 10)).toEqual({ ok: false, kind: "db", sqlstate: "23505" });
    // B は空から 0
    expect(await createAxis(db, accountB, "B の軸", 10)).toEqual({ ok: true });
    expect((await axesOf(accountB))[0]?.sort_order).toBe(0);
    // 上限 3 で 3 個目まで、4 個目は 0 行
    expect(await createAxis(db, accountA, "CTA", 3)).toEqual({ ok: true });
    expect(await createAxis(db, accountA, "キャンペーン", 3)).toEqual({ ok: false, kind: "not_found" });
    expect(await axesOf(accountA)).toHaveLength(3);
  });

  it("createAxis: 軸 10 個あれば 11 個目は 0 行（MAX_AXES）", async () => {
    const acc = await insertFakeAccount(sql, "fake_tag_edit_limit");
    try {
      for (let i = 0; i < 10; i++) expect(await createAxis(db, acc, `軸${i}`, 10)).toEqual({ ok: true });
      expect(await createAxis(db, acc, "軸10", 10)).toEqual({ ok: false, kind: "not_found" });
    } finally {
      await sql`delete from public.accounts where id = ${acc}`;
    }
  });

  it("renameAxis / deleteAxis / moveAxis: 別のアカウントの軸は 0 行で、B の行は変わらない（S4）", async () => {
    const [bAxis] = await axesOf(accountB);
    if (!bAxis) throw new Error("B の軸がない");
    expect(await renameAxis(db, accountA, bAxis.id, "乗っ取り")).toEqual({ ok: false, kind: "not_found" });
    expect(await deleteAxis(db, accountA, bAxis.id)).toEqual({ ok: false, kind: "not_found" });
    expect(await moveAxis(db, accountA, bAxis.id, "up")).toEqual({ ok: false, kind: "not_found" });
    expect(await axesOf(accountB)).toEqual([bAxis]);
    // 消された id
    expect(await renameAxis(db, accountA, "999999999999999999", "x")).toEqual({ ok: false, kind: "not_found" });
  });

  it("moveAxis: 先頭の上へと末尾の下へは何も変えず、隣と入れ替える（T11）", async () => {
    const before = await axesOf(accountA);
    const [first, second, third] = before;
    if (!first || !second || !third) throw new Error("軸が 3 つない");
    expect(await moveAxis(db, accountA, first.id, "up")).toEqual({ ok: true });
    expect(await moveAxis(db, accountA, third.id, "down")).toEqual({ ok: true });
    expect(await axesOf(accountA)).toEqual(before);
    expect(await moveAxis(db, accountA, second.id, "up")).toEqual({ ok: true });
    expect((await axesOf(accountA)).map((a) => a.id)).toEqual([second.id, first.id, third.id]);
    expect(await moveAxis(db, accountA, second.id, "down")).toEqual({ ok: true });
    expect((await axesOf(accountA)).map((a) => a.id)).toEqual([first.id, second.id, third.id]);
  });

  it("moveAxis: 同順位は id の順に並び、入れ替えると振り直す", async () => {
    const acc = await insertFakeAccount(sql, "fake_tag_edit_tie");
    try {
      const x = await insertTagAxis(sql, { accountId: acc, name: "x", sortOrder: 0 });
      const y = await insertTagAxis(sql, { accountId: acc, name: "y", sortOrder: 0 });
      const editor = await getTagEditor(acc);
      expect(editor.ok && editor.data.map((a) => a.id)).toEqual([x, y]);
      expect(await moveAxis(db, acc, y, "up")).toEqual({ ok: true });
      expect((await axesOf(acc)).map((a) => [a.id, a.sort_order])).toEqual([
        [y, 0],
        [x, 1],
      ]);
    } finally {
      await sql`delete from public.accounts where id = ${acc}`;
    }
  });

  it("createValue: 並び順は最大値 + 1（空なら 0）。別のアカウントの軸と上限は 0 行。同じ名前は 23505", async () => {
    const [theme] = await axesOf(accountA);
    const [bAxis] = await axesOf(accountB);
    if (!theme || !bAxis) throw new Error("軸がない");
    expect(await createValue(db, accountA, theme.id, "旅", 50)).toEqual({ ok: true });
    expect(await createValue(db, accountA, theme.id, "食", 50)).toEqual({ ok: true });
    expect((await valuesOf(theme.id)).map((v) => [v.name, v.sort_order])).toEqual([
      ["旅", 0],
      ["食", 1],
    ]);
    expect(await createValue(db, accountA, theme.id, "旅", 50)).toEqual({ ok: false, kind: "db", sqlstate: "23505" });
    expect(await createValue(db, accountA, bAxis.id, "乗っ取り", 50)).toEqual({ ok: false, kind: "not_found" });
    expect(await valuesOf(bAxis.id)).toEqual([]);
    expect(await createValue(db, accountA, theme.id, "3 つ目", 2)).toEqual({ ok: false, kind: "not_found" });
  });

  it("createValue: 値 50 個あれば 51 個目は 0 行（MAX_VALUES_PER_AXIS）", async () => {
    const acc = await insertFakeAccount(sql, "fake_tag_edit_vlimit");
    try {
      const axis = await insertTagAxis(sql, { accountId: acc, name: "多い軸" });
      for (let i = 0; i < 50; i++) await insertTagValue(sql, { axisId: axis, name: `値${i}`, sortOrder: i });
      expect(await createValue(db, acc, axis, "値50", 50)).toEqual({ ok: false, kind: "not_found" });
    } finally {
      await sql`delete from public.accounts where id = ${acc}`;
    }
  });

  it("renameValue / deleteValue / moveValue: 別のアカウントの値は 0 行（S4）", async () => {
    const [bAxis] = await axesOf(accountB);
    if (!bAxis) throw new Error("B の軸がない");
    const bValue = await insertTagValue(sql, { axisId: bAxis.id, name: "B の値" });
    const bValue2 = await insertTagValue(sql, { axisId: bAxis.id, name: "B の値 2", sortOrder: 1 });
    expect(await renameValue(db, accountA, bValue, "乗っ取り")).toEqual({ ok: false, kind: "not_found" });
    expect(await deleteValue(db, accountA, bValue)).toEqual({ ok: false, kind: "not_found" });
    expect(await moveValue(db, accountA, bValue2, "up")).toEqual({ ok: false, kind: "not_found" });
    expect((await valuesOf(bAxis.id)).map((v) => [v.id, v.name, v.sort_order])).toEqual([
      [bValue, "B の値", 0],
      [bValue2, "B の値 2", 1],
    ]);
  });

  it("renameValue と moveValue（T11）", async () => {
    const [theme] = await axesOf(accountA);
    if (!theme) throw new Error("軸がない");
    const [tabi, shoku] = await valuesOf(theme.id);
    if (!tabi || !shoku) throw new Error("値がない");
    expect(await renameValue(db, accountA, tabi.id, "旅行")).toEqual({ ok: true });
    expect(await renameValue(db, accountA, tabi.id, "食")).toEqual({ ok: false, kind: "db", sqlstate: "23505" });
    expect(await moveValue(db, accountA, tabi.id, "up")).toEqual({ ok: true });
    expect(await moveValue(db, accountA, shoku.id, "down")).toEqual({ ok: true });
    expect((await valuesOf(theme.id)).map((v) => v.id)).toEqual([tabi.id, shoku.id]);
    expect(await moveValue(db, accountA, shoku.id, "up")).toEqual({ ok: true });
    expect((await valuesOf(theme.id)).map((v) => v.id)).toEqual([shoku.id, tabi.id]);
  });

  it("setMediaTags: 1 トランザクションで入れ替え、空の軸は外す。getTagMediaPage と getTagEditor に出る", async () => {
    const [theme, purpose] = await axesOf(accountA);
    if (!theme || !purpose) throw new Error("軸がない");
    const [v1, v2] = await valuesOf(theme.id);
    if (!v1 || !v2) throw new Error("値がない");
    expect(await createValue(db, accountA, purpose.id, "認知", 50)).toEqual({ ok: true });
    const [p1] = await valuesOf(purpose.id);
    if (!p1) throw new Error("値がない");

    expect(
      await setMediaTags(db, accountA, ids.a1, [
        { axisId: theme.id, valueId: v1.id },
        { axisId: purpose.id, valueId: p1.id },
      ]),
    ).toEqual({ ok: true });
    expect(await tagsOf(ids.a1)).toEqual([
      { axis_id: theme.id, value_id: v1.id },
      { axis_id: purpose.id, value_id: p1.id },
    ].sort((a, b) => Number(a.axis_id) - Number(b.axis_id)));

    expect(
      await setMediaTags(db, accountA, ids.a1, [
        { axisId: theme.id, valueId: v2.id },
        { axisId: purpose.id, valueId: null },
      ]),
    ).toEqual({ ok: true });
    expect(await tagsOf(ids.a1)).toEqual([{ axis_id: theme.id, value_id: v2.id }]);

    // 編集画面の読み出し: ストーリーズを除く新しい順。missing で未設定だけ
    const page = await getTagMediaPage(accountA, { page: 1, pageSize: 50, missingAxisId: undefined });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.data.total).toBe(2);
    expect(page.data.items.map((m) => m.media_id)).toEqual([ids.a2, ids.a1]);
    expect(page.data.items[1]?.tags).toEqual({ [theme.id]: v2.id });
    expect(page.data.items[0]?.kind).toBe("carousel");
    const missing = await getTagMediaPage(accountA, { page: 1, pageSize: 50, missingAxisId: theme.id });
    expect(missing.ok && missing.data.items.map((m) => m.media_id)).toEqual([ids.a2]);

    const editor = await getTagEditor(accountA);
    expect(editor.ok).toBe(true);
    if (!editor.ok) return;
    const themeItem = editor.data.find((a) => a.id === theme.id);
    expect(themeItem?.tagged_count).toBe(1);
    expect(themeItem?.values.find((v) => v.id === v2.id)?.media_count).toBe(1);
    expect(themeItem?.values.find((v) => v.id === v1.id)?.media_count).toBe(0);
  });

  it("setMediaTags: ストーリーズと別のアカウントの投稿には書かない（Q3、S4）", async () => {
    const [theme] = await axesOf(accountA);
    const [v1] = theme ? await valuesOf(theme.id) : [];
    if (!theme || !v1) throw new Error("軸か値がない");
    expect(await setMediaTags(db, accountA, ids.aStory, [{ axisId: theme.id, valueId: v1.id }])).toEqual({
      ok: false,
      kind: "not_found",
    });
    expect(await tagsOf(ids.aStory)).toEqual([]);
    expect(await setMediaTags(db, accountA, ids.b1, [{ axisId: theme.id, valueId: v1.id }])).toEqual({
      ok: false,
      kind: "not_found",
    });
    expect(await tagsOf(ids.b1)).toEqual([]);
  });

  it("setMediaTags: 別の軸の値、別のアカウントの軸は 23503 で、同じ呼び出しの前の変更も戻る", async () => {
    const [theme, purpose] = await axesOf(accountA);
    const [bAxis] = await axesOf(accountB);
    if (!theme || !purpose || !bAxis) throw new Error("軸がない");
    const [v1] = await valuesOf(theme.id);
    const [p1] = await valuesOf(purpose.id);
    if (!v1 || !p1) throw new Error("値がない");
    const before = await tagsOf(ids.a2);
    // 軸 theme に purpose の値
    expect(
      await setMediaTags(db, accountA, ids.a2, [
        { axisId: purpose.id, valueId: p1.id },
        { axisId: theme.id, valueId: p1.id },
      ]),
    ).toEqual({ ok: false, kind: "db", sqlstate: "23503" });
    expect(await tagsOf(ids.a2)).toEqual(before);
    // B の軸
    const bValue = (await valuesOf(bAxis.id))[0];
    if (!bValue) throw new Error("B の値がない");
    expect(await setMediaTags(db, accountA, ids.a2, [{ axisId: bAxis.id, valueId: bValue.id }])).toEqual({
      ok: false,
      kind: "db",
      sqlstate: "23503",
    });
    expect(await tagsOf(ids.a2)).toEqual(before);
  });

  it("setMediaTags: 別のアカウントの投稿のタグは外せない（delete も account_id で絞る）", async () => {
    const [bAxis] = await axesOf(accountB);
    const bValue = bAxis ? (await valuesOf(bAxis.id))[0] : undefined;
    if (!bAxis || !bValue) throw new Error("B の軸か値がない");
    await insertMediaTag(sql, { mediaId: ids.b1, accountId: accountB, axisId: bAxis.id, valueId: bValue.id });
    expect(await setMediaTags(db, accountA, ids.b1, [{ axisId: bAxis.id, valueId: null }])).toEqual({
      ok: false,
      kind: "not_found",
    });
    expect(await tagsOf(ids.b1)).toEqual([{ axis_id: bAxis.id, value_id: bValue.id }]);
  });

  it("deleteValue: 付いていれば 23503、付いていなければ消える", async () => {
    const [theme] = await axesOf(accountA);
    if (!theme) throw new Error("軸がない");
    const used = (await tagsOf(ids.a1)).find((t) => t.axis_id === theme.id);
    if (!used) throw new Error("タグがない");
    expect(await deleteValue(db, accountA, used.value_id)).toEqual({ ok: false, kind: "db", sqlstate: "23503" });
    const unused = (await valuesOf(theme.id)).find((v) => v.id !== used.value_id);
    if (!unused) throw new Error("未使用の値がない");
    expect(await deleteValue(db, accountA, unused.id)).toEqual({ ok: true });
    expect((await valuesOf(theme.id)).map((v) => v.id)).toEqual([used.value_id]);
  });

  it("deleteAxis: 値と投稿への対応ごと消える（D2）", async () => {
    const [theme] = await axesOf(accountA);
    if (!theme) throw new Error("軸がない");
    expect(await deleteAxis(db, accountA, theme.id)).toEqual({ ok: true });
    expect(await valuesOf(theme.id)).toEqual([]);
    expect((await tagsOf(ids.a1)).some((t) => t.axis_id === theme.id)).toBe(false);
    expect(await deleteAxis(db, accountA, theme.id)).toEqual({ ok: false, kind: "not_found" });
  });
});
