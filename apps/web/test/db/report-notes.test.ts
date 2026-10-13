/**
 * `queries/report-notes.ts` の結合テスト（R6 設計 7.1 節「画面（結合）」、5.1 節 D9）。
 * `TEST_DATABASE_URL` があるときだけ動く。架空のアカウント 2 つを作り、`afterAll` で消す（カスケードで `report_notes` も消える）。
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllDb } from "@/lib/db";
import { getReportNotes, upsertReportNotes } from "@/lib/queries/report-notes";
import { checkNote, normalizeNote } from "@/app/report/_report/input";
import { insertFakeAccount, insertReportNote, setWebEnv } from "./fixtures";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("queries/report-notes（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  let sql: postgres.Sql;
  let accountA = "";
  let accountB = "";
  let restoreEnv: () => void = () => {};

  beforeAll(async () => {
    restoreEnv = setWebEnv(url);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    accountA = await insertFakeAccount(sql, "fake_notes_a");
    accountB = await insertFakeAccount(sql, "fake_notes_b");
    await insertReportNote(sql, { accountId: accountB, reportMonth: "2026-10-01", summary: "B の総評", nextPlan: "B の施策" });
  });

  afterAll(async () => {
    if (accountA !== "") await sql`delete from public.accounts where id = ${accountA}`;
    if (accountB !== "") await sql`delete from public.accounts where id = ${accountB}`;
    await closeAllDb();
    await sql.end({ timeout: 5 });
    restoreEnv();
  });

  it("未保存の月は null", async () => {
    const r = await getReportNotes(accountA, "2026-10");
    if (!r.ok) throw new Error(r.reason);
    expect(r.data).toBeNull();
  });

  it("upsert → 読める。別のアカウントと別の月には影響しない", async () => {
    const w = await upsertReportNotes(accountA, "2026-10", "総評\n2 行目", "施策");
    expect(w).toEqual({ ok: true });
    const a = await getReportNotes(accountA, "2026-10");
    if (!a.ok) throw new Error(a.reason);
    expect(a.data).toMatchObject({ summary: "総評\n2 行目", next_plan: "施策" });
    expect(a.data?.updated_at).toBeInstanceOf(Date);

    const b = await getReportNotes(accountB, "2026-10");
    if (!b.ok) throw new Error(b.reason);
    expect(b.data).toMatchObject({ summary: "B の総評", next_plan: "B の施策" });

    const sep = await getReportNotes(accountA, "2026-09");
    if (!sep.ok) throw new Error(sep.reason);
    expect(sep.data).toBeNull();
  });

  it("同じ月に再び保存すると 2 欄とも置き換わり、updated_at が進む（後勝ち。D9、Q15）", async () => {
    const before = await getReportNotes(accountA, "2026-10");
    if (!before.ok || before.data === null) throw new Error("前の行がない");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const w = await upsertReportNotes(accountA, "2026-10", "", "新しい施策");
    expect(w).toEqual({ ok: true });
    const after = await getReportNotes(accountA, "2026-10");
    if (!after.ok || after.data === null) throw new Error("後の行がない");
    expect(after.data.summary).toBe("");
    expect(after.data.next_plan).toBe("新しい施策");
    expect(after.data.updated_at.getTime()).toBeGreaterThan(before.data.updated_at.getTime());
    const [count] = await sql<{ n: number }[]>`select count(*)::int as n from public.report_notes where account_id = ${accountA}`;
    expect(count?.n).toBe(1);
  });

  it("同じ値で保存しても updated_at が進む（D9）", async () => {
    const before = await getReportNotes(accountA, "2026-10");
    if (!before.ok || before.data === null) throw new Error("前の行がない");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await upsertReportNotes(accountA, "2026-10", before.data.summary, before.data.next_plan);
    const after = await getReportNotes(accountA, "2026-10");
    if (!after.ok || after.data === null) throw new Error("後の行がない");
    expect(after.data.updated_at.getTime()).toBeGreaterThan(before.data.updated_at.getTime());
  });

  it("DB の制約に当たると SQLSTATE だけを返す（存在しないアカウント → 外部キー 23503）", async () => {
    const w = await upsertReportNotes("00000000-0000-0000-0000-000000000000", "2026-10", "a", "b");
    expect(w).toEqual({ ok: false, kind: "db", sqlstate: "23503" });
  });

  it("Action の検査を通った本文（ZWJ でつないだ絵文字、LF、U+2028）は DB の check も通る。CR は Action で LF になるので DB に届かない（T21）", async () => {
    const raw = "家族 👨\u200D👩\u200D👧\r\n職業 👩\u200D💻\r旗 🏳️\u200D🌈\u2028末尾  \n";
    const checked = checkNote(raw);
    if (!checked.ok) throw new Error(checked.reason);
    expect(checked.value).toBe(normalizeNote(raw));
    expect(checked.value).not.toContain("\r");
    expect(checked.value).toContain("\n");
    const w = await upsertReportNotes(accountA, "2026-09", checked.value, checked.value);
    expect(w).toEqual({ ok: true });
    const r = await getReportNotes(accountA, "2026-09");
    if (!r.ok || r.data === null) throw new Error("行がない");
    expect(r.data.summary).toBe(checked.value);
    expect(r.data.next_plan).toBe(checked.value);
  });

  it("正規化していない CR は DB の check が拒む（23514。Action を通らない経路の保険。D7）", async () => {
    const bad = await upsertReportNotes(accountA, "2026-09", "a\rb", "");
    expect(bad).toEqual({ ok: false, kind: "db", sqlstate: "23514" });
    // 拒まれた呼び出しで前の値は変わらない
    const r = await getReportNotes(accountA, "2026-09");
    if (!r.ok || r.data === null) throw new Error("行がない");
    expect(r.data.next_plan).not.toBe("");
  });
});
