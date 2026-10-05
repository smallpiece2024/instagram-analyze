/**
 * `queries/account.ts` の結合テスト（R3 設計 4.1 節、9.2 節）。`TEST_DATABASE_URL` があるときだけ動く。
 * 架空のアカウント 2 件を作り、`META_TARGET_IG_USER_ID` が未設定、一致なし、一致ありのときの `getTargetAccount` を確かめる。
 * 未設定と一致なしでは、DB にアカウントがあっても（実データのアカウントを含め）代わりを選ばない。
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllDb } from "@/lib/db";
import { getTargetAccount, TARGET_ACCOUNT_NOT_SET } from "@/lib/queries/account";
import { fakeIgUserId, setWebEnv } from "./fixtures";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("queries/account（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  const igUserId = fakeIgUserId();
  const igUserId2 = fakeIgUserId();
  /** どの行とも一致しない架空の ID */
  const unknownIgUserId = fakeIgUserId();
  let sql: postgres.Sql;
  let accountId = "";
  let accountId2 = "";
  let restoreEnv: () => void = () => {};

  beforeAll(async () => {
    restoreEnv = setWebEnv(url);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    const rows = await sql<{ id: string; ig_user_id: string }[]>`
      insert into public.accounts (ig_user_id, username, name)
      values (${igUserId}, 'fake_target_1', 'Fake Target'), (${igUserId2}, 'fake_target_2', null)
      returning id, ig_user_id
    `;
    accountId = rows.find((r) => r.ig_user_id === igUserId)?.id ?? "";
    accountId2 = rows.find((r) => r.ig_user_id === igUserId2)?.id ?? "";
    expect(accountId).not.toBe("");
    expect(accountId2).not.toBe("");
  });

  afterAll(async () => {
    for (const id of [accountId, accountId2]) {
      if (id !== "") await sql`delete from public.accounts where id = ${id}`;
    }
    await closeAllDb();
    await sql.end({ timeout: 5 });
    restoreEnv();
  });

  it("未設定なら固定文言で失敗し、アカウントを選ばない", async () => {
    setWebEnv(url);
    expect(await getTargetAccount()).toEqual({ ok: false, reason: TARGET_ACCOUNT_NOT_SET });
    // 空白だけも未設定
    process.env.META_TARGET_IG_USER_ID = "  ";
    expect(await getTargetAccount()).toEqual({ ok: false, reason: TARGET_ACCOUNT_NOT_SET });
  });

  it("一致する行がなければ固定文言で失敗し、ほかのアカウントを代わりに選ばない", async () => {
    setWebEnv(url, unknownIgUserId);
    expect(await getTargetAccount()).toEqual({ ok: false, reason: TARGET_ACCOUNT_NOT_SET });
  });

  it("一致する行があればそのアカウントだけを返す", async () => {
    setWebEnv(url, igUserId2);
    const result = await getTargetAccount();
    expect(result).toEqual({
      ok: true,
      data: { id: accountId2, ig_user_id: igUserId2, username: "fake_target_2", name: null, status: "active" },
    });
    setWebEnv(url, igUserId);
    const first = await getTargetAccount();
    expect(first.ok && first.data.id).toBe(accountId);
  });

  it("数字以外の値は設定の不備（変数名だけの文言）", async () => {
    setWebEnv(url, "abc");
    expect(await getTargetAccount()).toEqual({ ok: false, reason: "設定が足りません（META_TARGET_IG_USER_ID）" });
  });
});
