/**
 * レポートの記入欄の Server Action（`app/report/actions.ts`）と入力の検査（`_report/input.ts`）の単体テスト（R6 設計 7.2 節）。
 *
 * `headers()`、`checkAccess`、`getTargetAccount`、`revalidatePath`、`getDailyRange`、`upsertReportNotes` を差し替える。
 * 環境変数は `vi.stubEnv` で与える（DB には繋がない）。DB の側（upsert、2 アカウントの分離）は `test/db/report-notes.test.ts`。
 */
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  headers: new Map<string, string>(),
  getDailyRange: vi.fn(),
  upsertReportNotes: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: (name: string) => mocks.headers.get(name.toLowerCase()) ?? null })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../src/lib/auth", () => ({ checkAccess: vi.fn(async () => "pass") }));
vi.mock("../src/lib/queries/account", () => ({
  TARGET_ACCOUNT_NOT_SET: "対象のアカウントが設定されていません",
  getTargetAccount: vi.fn(async () => ({
    ok: true,
    data: { id: "00000000-0000-0000-0000-00000000000a", ig_user_id: "0000001", username: null, name: null, status: "active" },
  })),
}));
vi.mock("../src/lib/queries/period-summary", () => ({ getDailyRange: mocks.getDailyRange }));
vi.mock("../src/lib/queries/report-notes", () => ({ upsertReportNotes: mocks.upsertReportNotes }));

import { revalidatePath } from "next/cache";
import * as actions from "../src/app/report/actions";
import {
  NextPlanForm,
  REPORT_NOTES_FORM_ID,
  type ReportNotesAction,
  ReportNotesProvider,
  SummaryField,
} from "../src/app/report/_report/ReportNotesForm";
import {
  checkNote,
  INITIAL_REPORT_NOTES_STATE,
  MAX_NOTE_LENGTH,
  normalizeNote,
  REPORT_NOTES_MESSAGES as MSG,
} from "../src/app/report/_report/input";
import { checkAccess } from "../src/lib/auth";
import { getTargetAccount } from "../src/lib/queries/account";

const APP_URL = "http://localhost:3000";
const ACCOUNT_ID = "00000000-0000-0000-0000-00000000000a";
const MONTH = "2026-09";
const BASE_ENV: Record<string, string> = {
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:1/postgres",
  META_APP_ID: "123456",
  META_APP_SECRET: "FAKE_REPORT_APP_SECRET",
  META_GRAPH_API_VERSION: "v25.0",
  APP_URL,
};
/** 日次指標は 2026-07-15 〜 2026-10-11 → 選べる月は 2026-07〜2026-10 */
const RANGE = { ok: true, data: { start: "2026-07-15", end: "2026-10-11" } } as const;

function form(entries: Record<string, string | Blob> | [string, string | Blob][]): FormData {
  const fd = new FormData();
  const list = Array.isArray(entries) ? entries : Object.entries(entries);
  for (const [k, v] of list) fd.append(k, v);
  return fd;
}

function notes(summary = "総評", next_plan = "施策", month = MONTH): FormData {
  return form({ month, summary, next_plan });
}

function sameOrigin(): void {
  mocks.headers.clear();
  mocks.headers.set("origin", APP_URL);
  mocks.headers.set("sec-fetch-site", "same-origin");
}

const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

const save = (fd: FormData) => actions.saveReportNotes(INITIAL_REPORT_NOTES_STATE, fd);

beforeEach(() => {
  for (const [k, v] of Object.entries(BASE_ENV)) vi.stubEnv(k, v);
  sameOrigin();
  mocks.getDailyRange.mockReset();
  mocks.getDailyRange.mockResolvedValue(RANGE);
  mocks.upsertReportNotes.mockReset();
  mocks.upsertReportNotes.mockResolvedValue({ ok: true });
  vi.mocked(checkAccess).mockReset();
  vi.mocked(checkAccess).mockResolvedValue("pass");
  vi.mocked(getTargetAccount).mockReset();
  vi.mocked(getTargetAccount).mockResolvedValue({
    ok: true,
    data: { id: ACCOUNT_ID, ig_user_id: "0000001", username: null, name: null, status: "active" },
  });
  vi.mocked(revalidatePath).mockClear();
  errorLog.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("actions.ts の export", () => {
  it("saveReportNotes だけを export する", () => {
    expect(Object.keys(actions)).toEqual(["saveReportNotes"]);
  });
});

describe("検査の順（env → origin → access → account）", () => {
  it("環境変数が足りなければ書かず、origin と認可も見ない", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const r = await save(notes());
    expect(r.status).toBe("error");
    expect(r.message).toBe(MSG.failed);
    expect(mocks.upsertReportNotes).not.toHaveBeenCalled();
    expect(checkAccess).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("reason=config"));
  });

  it("同一オリジンの POST でなければ書かず、認可を見ない", async () => {
    mocks.headers.set("sec-fetch-site", "cross-site");
    mocks.headers.set("origin", "https://evil.example");
    const r = await save(notes());
    expect(r).toMatchObject({ status: "error", message: MSG.failed });
    expect(mocks.upsertReportNotes).not.toHaveBeenCalled();
    expect(checkAccess).not.toHaveBeenCalled();
  });

  it("checkAccess は固定の経路 /report で呼ばれ、pass でなければ書かない", async () => {
    vi.mocked(checkAccess).mockResolvedValue("login");
    const r = await save(notes());
    expect(r).toMatchObject({ status: "error", message: MSG.failed });
    expect(checkAccess).toHaveBeenCalledTimes(1);
    expect(checkAccess).toHaveBeenCalledWith("/report");
    expect(mocks.upsertReportNotes).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("対象のアカウントがなければ書かない", async () => {
    vi.mocked(getTargetAccount).mockResolvedValue({ ok: false, reason: "対象のアカウントが設定されていません" });
    const r = await save(notes());
    expect(r).toMatchObject({ status: "error", message: MSG.failed });
    expect(mocks.upsertReportNotes).not.toHaveBeenCalled();
  });
});

describe("入力の形（S4）", () => {
  it("余分な項目に File があれば拒む", async () => {
    const fd = notes();
    fd.append("extra", new Blob(["x"]));
    const r = await save(fd);
    expect(r).toMatchObject({ status: "error", message: MSG.failed });
    expect(mocks.upsertReportNotes).not.toHaveBeenCalled();
  });

  it("summary が 2 つあれば拒む", async () => {
    const r = await save(
      form([
        ["month", MONTH],
        ["summary", "a"],
        ["summary", "b"],
        ["next_plan", "c"],
      ]),
    );
    expect(r).toMatchObject({ status: "error", message: MSG.failed });
    expect(mocks.upsertReportNotes).not.toHaveBeenCalled();
  });

  it("month がなければ拒む", async () => {
    const r = await save(form({ summary: "a", next_plan: "b" }));
    expect(r).toMatchObject({ status: "error", message: MSG.failed });
    expect(mocks.upsertReportNotes).not.toHaveBeenCalled();
  });
});

describe("月（S6 (2)(3)、T14）", () => {
  it.each([["2026-9"], ["2026-13"], ["202609"], ["2026-06"], ["2026-11"], ["0000-01"], ["9999-12"]])(
    "%s は「月が正しくありません」で、例外にならない",
    async (month) => {
      const r = await save(notes("a", "b", month));
      expect(r).toMatchObject({ status: "error", message: MSG.month });
      expect(mocks.upsertReportNotes).not.toHaveBeenCalled();
    },
  );

  it("選べる月が空（日次指標がない）なら拒む", async () => {
    mocks.getDailyRange.mockResolvedValue({ ok: true, data: null });
    const r = await save(notes());
    expect(r).toMatchObject({ status: "error", message: MSG.month });
    expect(mocks.upsertReportNotes).not.toHaveBeenCalled();
  });

  it("getDailyRange の読み出しに失敗したら「保存できませんでした」", async () => {
    mocks.getDailyRange.mockResolvedValue({ ok: false, reason: "x" });
    const r = await save(notes());
    expect(r).toMatchObject({ status: "error", message: MSG.failed });
    expect(mocks.upsertReportNotes).not.toHaveBeenCalled();
  });

  it("選べる範囲の両端（データの始まりの月と latest の月）は通る", async () => {
    await save(notes("a", "b", "2026-07"));
    await save(notes("a", "b", "2026-10"));
    expect(mocks.upsertReportNotes).toHaveBeenCalledTimes(2);
    expect(mocks.upsertReportNotes).toHaveBeenNthCalledWith(1, ACCOUNT_ID, "2026-07", "a", "b");
    expect(mocks.upsertReportNotes).toHaveBeenNthCalledWith(2, ACCOUNT_ID, "2026-10", "a", "b");
  });
});

describe("本文（S2）", () => {
  it("2,000 コードポイントは通り、2,001 は「2,000 文字までです」", async () => {
    const ok = "あ".repeat(MAX_NOTE_LENGTH);
    expect((await save(notes(ok, ""))).status).toBe("ok");
    const r = await save(notes("", `${ok}い`));
    expect(r).toMatchObject({ status: "error", message: MSG.tooLong });
    expect(mocks.upsertReportNotes).toHaveBeenCalledTimes(1);
  });

  it("絵文字（サロゲートペア）はコードポイントで数える", async () => {
    const r = await save(notes("😀".repeat(MAX_NOTE_LENGTH), ""));
    expect(r.status).toBe("ok");
  });

  it("\\r\\n と \\r は \\n に、末尾の空白と改行は除く", async () => {
    await save(notes("1 行目\r\n2 行目\r3 行目\n\n  \n", "施策 \r\n"));
    expect(mocks.upsertReportNotes).toHaveBeenCalledWith(ACCOUNT_ID, MONTH, "1 行目\n2 行目\n3 行目", "施策");
  });

  it("NFC で長さが変わるもの（結合文字）は NFC の後の長さで検査する", async () => {
    // 「か」+ 結合の濁点（2 コードポイント）→ NFC で「が」（1 コードポイント）
    const decomposed = "が".repeat(1001); // 2,002 コードポイント → NFC で 1,001
    const r = await save(notes(decomposed, ""));
    expect(r.status).toBe("ok");
    expect(mocks.upsertReportNotes).toHaveBeenCalledWith(ACCOUNT_ID, MONTH, "が".repeat(1001), "");
  });

  it("空で保存できる（空にして保存 = 消す）", async () => {
    const r = await save(notes("", ""));
    expect(r).toEqual({ status: "ok", message: MSG.saved });
    expect(mocks.upsertReportNotes).toHaveBeenCalledWith(ACCOUNT_ID, MONTH, "", "");
  });

  it.each([
    ["家族", "👨\u200D👩\u200D👧"],
    ["職業", "👩\u200D💻"],
    ["旗", "🏳️\u200D🌈"],
    ["改行", "a\nb"],
  ])("%s は通る", async (_label, text) => {
    const r = await save(notes(text, text));
    expect(r.status).toBe("ok");
    expect(mocks.upsertReportNotes).toHaveBeenCalledWith(ACCOUNT_ID, MONTH, text, text);
  });

  it("U+2028（行区切り）と U+2029（段落区切り）は拒まず、\n に正規化して保存する（normalizeNote。設計 S2 の「通る」は拒まないの意）", async () => {
    const r = await save(notes("a\u2028b", "c\u2029d"));
    expect(r.status).toBe("ok");
    expect(mocks.upsertReportNotes).toHaveBeenCalledWith(ACCOUNT_ID, MONTH, "a\nb", "c\nd");
  });

  it.each([
    ["U+202E（RLO）", "a\u202Eb"],
    ["U+200B（ZWSP）", "a\u200Bb"],
    ["U+0000", "a\u0000b"],
    ["タブ", "a\tb"],
    ["U+007F", "a\u007Fb"],
  ])("%s は「使えない文字があります」", async (_label, text) => {
    const r = await save(notes("ok", text));
    expect(r).toMatchObject({ status: "error", message: MSG.badChars });
    expect(mocks.upsertReportNotes).not.toHaveBeenCalled();
  });

  it("checkNote と normalizeNote（純粋関数）", () => {
    expect(normalizeNote("a\r\nb\r c \n\n")).toBe("a\nb\n c");
    expect(checkNote("")).toEqual({ ok: true, value: "" });
    expect(checkNote("x".repeat(2001))).toEqual({ ok: false, reason: "too_long" });
    expect(checkNote("\u200D")).toEqual({ ok: true, value: "\u200D" });
    expect(checkNote("\u200B")).toEqual({ ok: false, reason: "bad_chars" });
    // 長さの検査は文字の検査より先
    expect(checkNote(`${"x".repeat(2001)}\u0000`)).toEqual({ ok: false, reason: "too_long" });
  });
});

describe("文言、戻り値、ログ、revalidatePath（S13、U3）", () => {
  it("成功は「保存しました」で values なし、revalidatePath は /report だけ", async () => {
    const r = await save(notes("総評", "施策"));
    expect(r).toEqual({ status: "ok", message: MSG.saved });
    expect("values" in r).toBe(false);
    expect(revalidatePath).toHaveBeenCalledTimes(1);
    expect(revalidatePath).toHaveBeenCalledWith("/report");
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("失敗時は送られた本文（正規化前）を values に返し、revalidatePath を呼ばない", async () => {
    const raw = "総評\r\n  ";
    const r = await save(notes(raw, "a\tb"));
    expect(r.status).toBe("error");
    expect(r.values).toEqual({ summary: raw, next_plan: "a\tb" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("認可で落ちても values は返す（本文は本人に戻すだけ）", async () => {
    vi.mocked(checkAccess).mockResolvedValue("login");
    const r = await save(notes("s", "n"));
    expect(r.values).toEqual({ summary: "s", next_plan: "n" });
  });

  it("DB のエラーは SQLSTATE に関わらず「保存できませんでした」で、ログに SQLSTATE だけ出し、本文を出さない", async () => {
    for (const sqlstate of ["23514", "42501", "57014", undefined]) {
      mocks.upsertReportNotes.mockResolvedValue({ ok: false, kind: "db", sqlstate });
      errorLog.mockClear();
      const r = await save(notes("秘密の総評", "秘密の施策"));
      expect(r).toMatchObject({ status: "error", message: MSG.failed, values: { summary: "秘密の総評", next_plan: "秘密の施策" } });
      expect(revalidatePath).not.toHaveBeenCalled();
      const logged = errorLog.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("result=db_error");
      if (sqlstate) expect(logged).toContain(`sqlstate=${sqlstate}`);
      expect(logged).not.toContain("秘密");
      expect(logged).not.toContain(MONTH);
    }
  });

  it("ログに本文と月を出さない（拒否のとき）", async () => {
    await save(notes("秘密", "秘密", "2026-13"));
    const logged = errorLog.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("action=saveReportNotes");
    expect(logged).not.toContain("秘密");
    expect(logged).not.toContain("2026-13");
  });
});

describe("フォームの部品（ReportNotesForm。ページ側の固定値。T21、U2、U3）", () => {
  const noop: ReportNotesAction = async (state) => state;
  /** 1 節の入力欄と 9 節のフォームを、ページと同じく 1 つの Provider で包んで描く */
  function render(summary: string, nextPlan: string, savedAt: string | null = null): string {
    // Provider の props は children を要るので、オブジェクトで組んで渡す
    const props: ComponentProps<typeof ReportNotesProvider> = {
      action: noop,
      children: [
        createElement(SummaryField, { key: "summary", saved: summary }),
        createElement(NextPlanForm, { key: "next_plan", month: MONTH, saved: nextPlan, savedAt }),
      ],
    };
    return renderToStaticMarkup(createElement(ReportNotesProvider, props));
  }

  it("隠し month は渡した（検査済みの）月。form は 1 つで、1 節の textarea は form 属性で 9 節のフォームに結び付く", () => {
    const html = render("s", "n");
    expect(html).toContain(`<input type="hidden" name="month" value="${MONTH}"/>`);
    expect(html.match(/<form /g) ?? []).toHaveLength(1);
    expect(html).toContain(`<form id="${REPORT_NOTES_FORM_ID}"`);
    expect(html).toMatch(new RegExp(`<textarea[^>]*name="summary"[^>]*form="${REPORT_NOTES_FORM_ID}"`));
    expect(html).toMatch(/<textarea[^>]*name="next_plan"/);
    // 本文は textarea の中身（defaultValue）として出る
    expect(html).toMatch(/<textarea[^>]*name="summary"[^>]*>s<\/textarea>/);
    expect(html).toMatch(/<textarea[^>]*name="next_plan"[^>]*>n<\/textarea>/);
  });

  it("<script> を含む総評と翌月の施策は文字として出る（HTML にならない。T21）", () => {
    const html = render("<script>alert(1)</script>総評", '<img src="x" onerror="alert(1)">施策');
    // React は form の再生用の <script> を出すので、本文の script が素のタグになっていないことだけを見る
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;総評");
    expect(html).toContain("&lt;img src=&quot;x&quot; onerror=&quot;alert(1)&quot;&gt;施策");
  });

  it("初期の状態: 文言は空で aria-live の領域はある。保存日時は null なら出ず、あれば「保存:」で出る。ボタンは有効", () => {
    const html = render("", "", null);
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("保存:");
    expect(html).not.toMatch(/<button[^>]*disabled/);
    expect(html).not.toMatch(/<textarea[^>]*disabled/);
    expect(html).toContain(">保存<");
    const withDate = render("", "", "2026-10-13 09:00");
    expect(withDate).toContain("保存: 2026-10-13 09:00");
  });
});
