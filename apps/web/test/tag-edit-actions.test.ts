/**
 * タグの編集の Server Action（`app/tags/edit/actions.ts`）と入力の検査（`_edit/input.ts`）、並び順の計算（`planMove`）の
 * 単体テスト（R5 設計 7.3 節）。
 *
 * `headers()`、`checkAccess`、`getTargetAccount`、`revalidatePath`、`redirect` と、SQL の層（`lib/queries/tag-edit` の書き込み）を
 * 差し替える。環境変数は `vi.stubEnv` で与える（DB には繋がない）。DB の側の検査（件数の上限、並び順、別のアカウントの 0 行）は
 * `test/db/tag-edit.test.ts`。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  headers: new Map<string, string>(),
  write: {
    createAxis: vi.fn(),
    renameAxis: vi.fn(),
    deleteAxis: vi.fn(),
    moveAxis: vi.fn(),
    createValue: vi.fn(),
    renameValue: vi.fn(),
    deleteValue: vi.fn(),
    moveValue: vi.fn(),
    setMediaTags: vi.fn(),
  },
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: (name: string) => mocks.headers.get(name.toLowerCase()) ?? null })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));
vi.mock("../src/lib/auth", () => ({ checkAccess: vi.fn(async () => "pass") }));
vi.mock("../src/lib/queries/account", () => ({
  TARGET_ACCOUNT_NOT_SET: "対象のアカウントが設定されていません",
  getTargetAccount: vi.fn(async () => ({
    ok: true,
    data: { id: "00000000-0000-0000-0000-00000000000a", ig_user_id: "0000001", username: null, name: null, status: "active" },
  })),
}));
vi.mock("../src/lib/db", () => ({ dbFromEnv: vi.fn(() => ({ fake: "db" })) }));
vi.mock("../src/lib/queries/tag-edit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/queries/tag-edit")>();
  return { ...actual, ...mocks.write };
});

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import * as actions from "../src/app/tags/edit/actions";
import {
  INITIAL_TAG_EDIT_STATE,
  MAX_AXES,
  MAX_VALUES_PER_AXIS,
  normalizeTagName,
  parseMediaTagsForm,
  TAG_EDIT_MESSAGES,
} from "../src/app/tags/edit/_edit/input";
import { checkAccess } from "../src/lib/auth";
import { getTargetAccount } from "../src/lib/queries/account";
import { planMove } from "../src/lib/queries/tag-edit";

const APP_URL = "http://localhost:3000";
const ACCOUNT_ID = "00000000-0000-0000-0000-00000000000a";
const OK = { ok: true } as const;
const FAILED = { status: "error", message: TAG_EDIT_MESSAGES.failed };
const SAVED = { status: "ok", message: TAG_EDIT_MESSAGES.saved };

const BASE_ENV: Record<string, string> = {
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:1/postgres",
  META_APP_ID: "123456",
  META_APP_SECRET: "FAKE_TAG_EDIT_APP_SECRET",
  META_GRAPH_API_VERSION: "v25.0",
  APP_URL,
};

function form(entries: Record<string, string | Blob> | [string, string | Blob][]): FormData {
  const fd = new FormData();
  const list = Array.isArray(entries) ? entries : Object.entries(entries);
  for (const [k, v] of list) fd.append(k, v);
  return fd;
}

function sameOrigin(): void {
  mocks.headers.clear();
  mocks.headers.set("origin", APP_URL);
  mocks.headers.set("sec-fetch-site", "same-origin");
}

const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

function anyWriteCalled(): boolean {
  return Object.values(mocks.write).some((fn) => fn.mock.calls.length > 0);
}

beforeEach(() => {
  for (const [k, v] of Object.entries(BASE_ENV)) vi.stubEnv(k, v);
  sameOrigin();
  for (const fn of Object.values(mocks.write)) {
    fn.mockReset();
    fn.mockResolvedValue(OK);
  }
  vi.mocked(checkAccess).mockReset();
  vi.mocked(checkAccess).mockResolvedValue("pass");
  vi.mocked(revalidatePath).mockClear();
  vi.mocked(redirect).mockClear();
  errorLog.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("actions.ts の export（S3）", () => {
  it("Server Action の関数だけを export する（一覧を固定）", () => {
    expect(Object.keys(actions).sort()).toEqual(
      [
        "createAxis",
        "createValue",
        "deleteAxis",
        "deleteValue",
        "moveAxis",
        "moveValue",
        "renameAxis",
        "renameValue",
        "setMediaTags",
      ].sort(),
    );
    for (const fn of Object.values(actions)) expect(typeof fn).toBe("function");
  });
});

describe("認可（S1）", () => {
  it("checkAccess は要求の見出しによらず固定の値 /tags/edit で呼ぶ", async () => {
    mocks.headers.set("referer", `${APP_URL}/login`);
    mocks.headers.set("next-url", "/login");
    await actions.createAxis(INITIAL_TAG_EDIT_STATE, form({ name: "テーマ" }));
    expect(checkAccess).toHaveBeenCalledTimes(1);
    expect(checkAccess).toHaveBeenCalledWith("/tags/edit");
    expect(mocks.write.createAxis).toHaveBeenCalledWith({ fake: "db" }, ACCOUNT_ID, "テーマ", MAX_AXES);
  });

  it.each(["login", "forbid"] as const)("checkAccess が %s なら書かず、汎用の文言", async (decision) => {
    vi.mocked(checkAccess).mockResolvedValue(decision);
    const results = [
      await actions.createAxis(INITIAL_TAG_EDIT_STATE, form({ name: "テーマ" })),
      await actions.deleteValue(INITIAL_TAG_EDIT_STATE, form({ value_id: "1" })),
      await actions.setMediaTags(INITIAL_TAG_EDIT_STATE, form({ media_id: "1", axis_1: "2" })),
    ];
    for (const r of results) expect(r).toEqual(FAILED);
    expect(anyWriteCalled()).toBe(false);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("対象のアカウントが決まらなければ書かない", async () => {
    vi.mocked(getTargetAccount).mockResolvedValueOnce({ ok: false, reason: "対象のアカウントが設定されていません" });
    expect(await actions.createAxis(INITIAL_TAG_EDIT_STATE, form({ name: "テーマ" }))).toEqual(FAILED);
    expect(anyWriteCalled()).toBe(false);
  });

  it("対象のアカウントはフォームの account_id ではなく getTargetAccount の値", async () => {
    await actions.renameAxis(
      INITIAL_TAG_EDIT_STATE,
      form({ axis_id: "5", name: "目的", account_id: "00000000-0000-0000-0000-00000000000b" }),
    );
    expect(mocks.write.renameAxis).toHaveBeenCalledWith({ fake: "db" }, ACCOUNT_ID, "5", "目的");
  });
});

describe("同一オリジンの検査（S2）", () => {
  it.each([
    ["別のオリジン", { origin: "https://evil.example", "sec-fetch-site": "cross-site" }],
    ["Origin が同じでも Sec-Fetch-Site が cross-site", { origin: APP_URL, "sec-fetch-site": "cross-site" }],
    ["Origin がない", { "sec-fetch-site": "same-origin" }],
    ["Origin が null", { origin: "null" }],
  ])("%s なら書かず、checkAccess も呼ばない", async (_label, h) => {
    mocks.headers.clear();
    for (const [k, v] of Object.entries(h)) mocks.headers.set(k, v);
    const r = await actions.setMediaTags(INITIAL_TAG_EDIT_STATE, form({ media_id: "1", axis_1: "2" }));
    expect(r).toEqual(FAILED);
    expect(anyWriteCalled()).toBe(false);
    expect(checkAccess).not.toHaveBeenCalled();
  });
});

describe("名前の検査（S8）", () => {
  const emoji = "😀"; // 1 コードポイント（UTF-16 では 2）

  it("normalizeTagName: 前後の空白を除き、1〜30 コードポイント", () => {
    expect(normalizeTagName("  テーマ  ")).toBe("テーマ");
    expect(normalizeTagName("   ")).toBeUndefined();
    expect(normalizeTagName("")).toBeUndefined();
    expect(normalizeTagName("　")).toBeUndefined(); // 全角空白だけ
    expect(normalizeTagName(emoji.repeat(30))).toBe(emoji.repeat(30));
    expect(normalizeTagName(emoji.repeat(31))).toBeUndefined();
    expect(normalizeTagName("a".repeat(30))).toBe("a".repeat(30));
    expect(normalizeTagName("a".repeat(31))).toBeUndefined();
  });

  it("normalizeTagName: NFC にしてから数える（結合文字 31 コードポイントが NFC で 30 になれば通る）", () => {
    const decomposed = "é" + "a".repeat(29); // 31 コードポイント、NFC で 30
    expect([...decomposed].length).toBe(31);
    expect(normalizeTagName(decomposed)).toBe("é" + "a".repeat(29));
    const tooLong = "é" + "a".repeat(30); // NFC で 31
    expect(normalizeTagName(tooLong)).toBeUndefined();
  });

  it("normalizeTagName: 制御文字、ゼロ幅文字（Cf）、私用領域、孤立したサロゲートを拒む。# で始まる名前は通す", () => {
    expect(normalizeTagName("a\u0007b")).toBeUndefined();
    expect(normalizeTagName("a\nb")).toBeUndefined();
    expect(normalizeTagName("a​b")).toBeUndefined();
    expect(normalizeTagName("a‮b")).toBeUndefined();
    expect(normalizeTagName("ab")).toBeUndefined();
    expect(normalizeTagName("a\ud800b")).toBeUndefined();
    expect(normalizeTagName("#キャンペーン")).toBe("#キャンペーン");
    expect(normalizeTagName("<script>alert(1)</script>")).toBe("<script>alert(1)</script>");
    expect(normalizeTagName(123)).toBeUndefined();
  });

  it("不正な名前では書かない（空白だけ、31 コードポイント、ゼロ幅文字）", async () => {
    for (const name of ["   ", emoji.repeat(31), "a​b"]) {
      expect(await actions.createAxis(INITIAL_TAG_EDIT_STATE, form({ name }))).toEqual(FAILED);
      expect(await actions.renameValue(INITIAL_TAG_EDIT_STATE, form({ value_id: "1", name }))).toEqual(FAILED);
    }
    expect(anyWriteCalled()).toBe(false);
  });

  it("前後の空白を除いた NFC の名前で書く", async () => {
    await actions.createValue(INITIAL_TAG_EDIT_STATE, form({ axis_id: "3", name: "  é  " }));
    expect(mocks.write.createValue).toHaveBeenCalledWith({ fake: "db" }, ACCOUNT_ID, "3", "é", MAX_VALUES_PER_AXIS);
  });

  it("File の値があれば書かない", async () => {
    const file = new Blob(["x"], { type: "text/plain" });
    expect(await actions.createAxis(INITIAL_TAG_EDIT_STATE, form({ name: file }))).toEqual(FAILED);
    expect(await actions.renameAxis(INITIAL_TAG_EDIT_STATE, form({ axis_id: "1", name: "a", extra: file }))).toEqual(FAILED);
    expect(await actions.setMediaTags(INITIAL_TAG_EDIT_STATE, form({ media_id: "1", axis_1: file }))).toEqual(FAILED);
    expect(anyWriteCalled()).toBe(false);
  });

  it("同じ名前の値が 2 つあれば書かない", async () => {
    const fd = form([
      ["name", "a"],
      ["name", "b"],
    ]);
    expect(await actions.createAxis(INITIAL_TAG_EDIT_STATE, fd)).toEqual(FAILED);
    expect(anyWriteCalled()).toBe(false);
  });
});

describe("id の形", () => {
  it("軸と値の id は ^\\d{1,18}$、向きは up か down", async () => {
    const bad = ["", "abc", "1.5", "-1", "1".repeat(19), " 1"];
    for (const id of bad) {
      expect(await actions.renameAxis(INITIAL_TAG_EDIT_STATE, form({ axis_id: id, name: "a" }))).toEqual(FAILED);
      expect(await actions.deleteValue(INITIAL_TAG_EDIT_STATE, form({ value_id: id }))).toEqual(FAILED);
    }
    expect(await actions.moveAxis(INITIAL_TAG_EDIT_STATE, form({ axis_id: "1", direction: "left" }))).toEqual(FAILED);
    expect(await actions.moveValue(INITIAL_TAG_EDIT_STATE, form({ value_id: "1" }))).toEqual(FAILED);
    expect(anyWriteCalled()).toBe(false);
    expect(await actions.moveValue(INITIAL_TAG_EDIT_STATE, form({ value_id: "1".repeat(18), direction: "down" }))).toEqual(SAVED);
    expect(mocks.write.moveValue).toHaveBeenCalledWith({ fake: "db" }, ACCOUNT_ID, "1".repeat(18), "down");
  });
});

describe("setMediaTags の入力（S8）", () => {
  it("parseMediaTagsForm: axis_{id} のキーだけを読み、空は外す", () => {
    const r = parseMediaTagsForm(form({ media_id: "17890000000000001", axis_1: "10", axis_2: "", $ACTION_ID_abc: "" }));
    expect(r).toEqual({
      mediaId: "17890000000000001",
      entries: [
        { axisId: "1", valueId: "10" },
        { axisId: "2", valueId: null },
      ],
    });
  });

  it("parseMediaTagsForm: キーの形、値の形、投稿の id、同じキーが 2 回を拒む", () => {
    expect(parseMediaTagsForm(form({ media_id: "1", axis_x: "1" }))).toBeUndefined();
    expect(parseMediaTagsForm(form({ media_id: "1", axis_: "1" }))).toBeUndefined();
    expect(parseMediaTagsForm(form({ media_id: "1", ["axis_" + "1".repeat(19)]: "1" }))).toBeUndefined();
    expect(parseMediaTagsForm(form({ media_id: "1", axis_1: "abc" }))).toBeUndefined();
    expect(parseMediaTagsForm(form({ media_id: "1", axis_1: " " }))).toBeUndefined();
    expect(parseMediaTagsForm(form({ media_id: "1", axis_1: "1".repeat(19) }))).toBeUndefined();
    expect(parseMediaTagsForm(form({ media_id: "1".repeat(26), axis_1: "1" }))).toBeUndefined();
    expect(parseMediaTagsForm(form({ media_id: "abc", axis_1: "1" }))).toBeUndefined();
    expect(parseMediaTagsForm(form({ axis_1: "1" }))).toBeUndefined();
    expect(
      parseMediaTagsForm(
        form([
          ["media_id", "1"],
          ["axis_1", "1"],
          ["axis_1", "2"],
        ]),
      ),
    ).toBeUndefined();
    expect(parseMediaTagsForm(form({ media_id: "1".repeat(25) }))).toEqual({ mediaId: "1".repeat(25), entries: [] });
  });

  it("軸のキーは 10 個まで（11 個で拒む）", () => {
    const ten: [string, string][] = [["media_id", "1"]];
    for (let i = 1; i <= 10; i++) ten.push([`axis_${i}`, String(i)]);
    expect(parseMediaTagsForm(form(ten))?.entries).toHaveLength(10);
    expect(parseMediaTagsForm(form([...ten, ["axis_11", ""]]))).toBeUndefined();
  });

  it("不正な入力では書かず、正しい入力はそのまま SQL の層に渡す", async () => {
    expect(await actions.setMediaTags(INITIAL_TAG_EDIT_STATE, form({ media_id: "1", axis_x: "1" }))).toEqual(FAILED);
    expect(mocks.write.setMediaTags).not.toHaveBeenCalled();
    expect(await actions.setMediaTags(INITIAL_TAG_EDIT_STATE, form({ media_id: "7", axis_1: "", axis_2: "9" }))).toEqual(SAVED);
    expect(mocks.write.setMediaTags).toHaveBeenCalledWith({ fake: "db" }, ACCOUNT_ID, "7", [
      { axisId: "1", valueId: null },
      { axisId: "2", valueId: "9" },
    ]);
  });
});

describe("数の上限", () => {
  it("軸は MAX_AXES（10）、値は MAX_VALUES_PER_AXIS（50）を SQL の層に渡す（上限に達していれば SQL の層が 0 行で返す）", async () => {
    expect(MAX_AXES).toBe(10);
    expect(MAX_VALUES_PER_AXIS).toBe(50);
    mocks.write.createAxis.mockResolvedValue({ ok: false, kind: "not_found" });
    expect(await actions.createAxis(INITIAL_TAG_EDIT_STATE, form({ name: "11 個目" }))).toEqual(FAILED);
    expect(mocks.write.createAxis).toHaveBeenCalledWith({ fake: "db" }, ACCOUNT_ID, "11 個目", 10);
    mocks.write.createValue.mockResolvedValue({ ok: false, kind: "not_found" });
    expect(await actions.createValue(INITIAL_TAG_EDIT_STATE, form({ axis_id: "1", name: "51 個目" }))).toEqual(FAILED);
    expect(mocks.write.createValue).toHaveBeenCalledWith({ fake: "db" }, ACCOUNT_ID, "1", "51 個目", 50);
  });
});

describe("エラーの文言（S9、T6）", () => {
  const db = (sqlstate: string | undefined) => ({ ok: false, kind: "db", sqlstate }) as const;

  it("23505（同じ名前）は「同じ名前があります」", async () => {
    mocks.write.createAxis.mockResolvedValue(db("23505"));
    mocks.write.renameAxis.mockResolvedValue(db("23505"));
    mocks.write.createValue.mockResolvedValue(db("23505"));
    mocks.write.renameValue.mockResolvedValue(db("23505"));
    const expected = { status: "error", message: TAG_EDIT_MESSAGES.duplicate };
    expect(await actions.createAxis(INITIAL_TAG_EDIT_STATE, form({ name: "a" }))).toEqual(expected);
    expect(await actions.renameAxis(INITIAL_TAG_EDIT_STATE, form({ axis_id: "1", name: "a" }))).toEqual(expected);
    expect(await actions.createValue(INITIAL_TAG_EDIT_STATE, form({ axis_id: "1", name: "a" }))).toEqual(expected);
    expect(await actions.renameValue(INITIAL_TAG_EDIT_STATE, form({ value_id: "1", name: "a" }))).toEqual(expected);
  });

  it("値の削除の 23503 は「使っている投稿があります」", async () => {
    mocks.write.deleteValue.mockResolvedValue(db("23503"));
    expect(await actions.deleteValue(INITIAL_TAG_EDIT_STATE, form({ value_id: "1" }))).toEqual({
      status: "error",
      message: TAG_EDIT_MESSAGES.inUse,
    });
  });

  it("insert／update の 23503、ほかの SQLSTATE、SQLSTATE なし、0 行は汎用の文言", async () => {
    mocks.write.setMediaTags.mockResolvedValue(db("23503"));
    expect(await actions.setMediaTags(INITIAL_TAG_EDIT_STATE, form({ media_id: "1", axis_1: "2" }))).toEqual(FAILED);
    mocks.write.createValue.mockResolvedValue(db("23503"));
    expect(await actions.createValue(INITIAL_TAG_EDIT_STATE, form({ axis_id: "1", name: "a" }))).toEqual(FAILED);
    mocks.write.renameAxis.mockResolvedValue(db("23514"));
    expect(await actions.renameAxis(INITIAL_TAG_EDIT_STATE, form({ axis_id: "1", name: "a" }))).toEqual(FAILED);
    mocks.write.deleteValue.mockResolvedValue(db("23505"));
    expect(await actions.deleteValue(INITIAL_TAG_EDIT_STATE, form({ value_id: "1" }))).toEqual(FAILED);
    mocks.write.moveAxis.mockResolvedValue(db(undefined));
    expect(await actions.moveAxis(INITIAL_TAG_EDIT_STATE, form({ axis_id: "1", direction: "up" }))).toEqual(FAILED);
    mocks.write.renameValue.mockResolvedValue({ ok: false, kind: "not_found" });
    expect(await actions.renameValue(INITIAL_TAG_EDIT_STATE, form({ value_id: "1", name: "a" }))).toEqual(FAILED);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("ログは Action の名前、結果、SQLSTATE だけ（名前と投稿の id を出さない）", async () => {
    mocks.write.renameAxis.mockResolvedValue(db("23505"));
    await actions.renameAxis(INITIAL_TAG_EDIT_STATE, form({ axis_id: "424242", name: "秘密の軸名" }));
    mocks.write.setMediaTags.mockResolvedValue(db("23503"));
    await actions.setMediaTags(INITIAL_TAG_EDIT_STATE, form({ media_id: "17899999999999999", axis_1: "2" }));
    vi.mocked(checkAccess).mockResolvedValue("forbid");
    await actions.createAxis(INITIAL_TAG_EDIT_STATE, form({ name: "別の秘密" }));
    const lines = errorLog.mock.calls.map((c) => c.join(" "));
    expect(lines).toEqual([
      "[tag-edit] action=renameAxis result=db_error sqlstate=23505",
      "[tag-edit] action=setMediaTags result=db_error sqlstate=23503",
      "[tag-edit] action=createAxis result=rejected reason=access",
    ]);
  });
});

describe("描き直しの範囲（S12）", () => {
  it("軸と値の操作は /tags/edit だけ、setMediaTags はさらに /tags と /media/[id]", async () => {
    await actions.renameValue(INITIAL_TAG_EDIT_STATE, form({ value_id: "1", name: "a" }));
    expect(vi.mocked(revalidatePath).mock.calls).toEqual([["/tags/edit"]]);
    vi.mocked(revalidatePath).mockClear();
    await actions.setMediaTags(INITIAL_TAG_EDIT_STATE, form({ media_id: "1", axis_1: "2" }));
    expect(vi.mocked(revalidatePath).mock.calls).toEqual([["/tags/edit"], ["/tags"], ["/media/[id]", "page"]]);
  });
});

describe("軸の削除は確認の表示を経る（S10）", () => {
  it("confirm=delete がなければ消さない", async () => {
    expect(await actions.deleteAxis(INITIAL_TAG_EDIT_STATE, form({ axis_id: "1" }))).toEqual(FAILED);
    expect(await actions.deleteAxis(INITIAL_TAG_EDIT_STATE, form({ axis_id: "1", confirm: "yes" }))).toEqual(FAILED);
    expect(mocks.write.deleteAxis).not.toHaveBeenCalled();
  });

  it("確認の表示のフォーム（confirm=delete）で消し、/tags/edit に移る", async () => {
    await expect(actions.deleteAxis(INITIAL_TAG_EDIT_STATE, form({ axis_id: "1", confirm: "delete" }))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(mocks.write.deleteAxis).toHaveBeenCalledWith({ fake: "db" }, ACCOUNT_ID, "1");
    expect(redirect).toHaveBeenCalledWith("/tags/edit");
  });

  it("消せなかったときは移らず汎用の文言", async () => {
    mocks.write.deleteAxis.mockResolvedValue({ ok: false, kind: "not_found" });
    expect(await actions.deleteAxis(INITIAL_TAG_EDIT_STATE, form({ axis_id: "1", confirm: "delete" }))).toEqual(FAILED);
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe("並び順の計算（planMove。T11）", () => {
  const rows = [
    { id: "1", sort_order: 0 },
    { id: "2", sort_order: 1 },
    { id: "3", sort_order: 2 },
  ];

  it("先頭の上へと末尾の下へは何も変えない", () => {
    expect(planMove(rows, "1", "up")).toEqual([]);
    expect(planMove(rows, "3", "down")).toEqual([]);
  });

  it("隣と sort_order を入れ替える", () => {
    expect(planMove(rows, "2", "up")).toEqual([
      { id: "2", sort_order: 0 },
      { id: "1", sort_order: 1 },
    ]);
    expect(planMove(rows, "2", "down")).toEqual([
      { id: "2", sort_order: 2 },
      { id: "3", sort_order: 1 },
    ]);
  });

  it("隣と同順位なら入れ替えた並びで 0 から振り直す（値が変わる行だけ）", () => {
    const tied = [
      { id: "1", sort_order: 0 },
      { id: "2", sort_order: 1 },
      { id: "3", sort_order: 1 },
      { id: "4", sort_order: 2 },
    ];
    expect(planMove(tied, "3", "up")).toEqual([
      { id: "2", sort_order: 2 },
      { id: "4", sort_order: 3 },
    ]);
  });

  it("対象がなければ undefined（別のアカウント、消された id）", () => {
    expect(planMove(rows, "9", "up")).toBeUndefined();
  });
});

describe("利用者の文字は文字として出す（S11）", () => {
  const evil = '#<img src=x onerror=alert(1)>';
  const script = "<script>alert(1)</script>";
  const axes = [
    {
      id: "1",
      name: evil,
      sort_order: 0,
      tagged_count: 1,
      values: [
        { id: "10", name: script, sort_order: 0, media_count: 1 },
        { id: "11", name: "未使用", sort_order: 1, media_count: 0 },
      ],
    },
    { id: "2", name: "目的", sort_order: 1, tagged_count: 0, values: [] },
  ];

  it("軸と値の管理: 名前がエスケープされ、先頭の上へ・末尾の下へ・使っている値の消すは出ない", async () => {
    const { AxesCard } = await import("../src/app/tags/edit/_edit/AxesCard");
    const html = renderToStaticMarkup(createElement(AxesCard, { axes, confirmAxisId: "1", query: {} }));
    expect(html).not.toContain("<img src=x");
    // React 自身のフォームの再生用の <script> は出るので、利用者の文字の <script> だけを見る
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // 確認の表示: 値 2 個、タグ 1 件
    expect(html).toContain("の軸と値 2 個、付いているタグ 1 件が消えます");
    expect(html).toContain('name="confirm" value="delete"');
    // 軸の「上へ」は 2 つ目の軸だけ、「下へ」は 1 つ目の軸だけ
    expect(html.match(/目的を上へ/g)?.length).toBeGreaterThan(0);
    expect(html).not.toContain("目的を下へ");
    // 使っている値（10）には「消す」を出さず、未使用（11）には出す
    expect(html).toContain('name="value_id" value="11"');
    expect(html).not.toMatch(/aria-label="&lt;script&gt;alert\(1\)&lt;\/script&gt;を消す"/);
    expect(html).toContain('aria-label="未使用を消す"');
  });

  it("投稿へのタグ付け: キャプションと名前がエスケープされ、選択の既定値が今のタグ", async () => {
    const { MediaTagTable } = await import("../src/app/tags/edit/_edit/MediaTagTable");
    const data = {
      page: 1,
      pageCount: 1,
      total: 1,
      items: [
        {
          media_id: "17890000000000001",
          kind: "feed",
          posted_at: new Date("2026-08-01T00:00:00Z"),
          caption: `${evil}\n${script}`,
          thumbnail_path: null,
          thumbnail_url: null,
          gone_at: null,
          tags: { "1": "10" },
        },
      ],
    };
    const html = renderToStaticMarkup(createElement(MediaTagTable, { axes, data, missingAxisId: undefined }));
    expect(html).not.toContain("<img src=x");
    // React 自身のフォームの再生用の <script> は出るので、利用者の文字の <script> だけを見る
    expect(html).not.toContain("<script>alert");
    expect(html).toContain('id="m-17890000000000001"');
    expect(html).toContain('form="tag-form-17890000000000001"');
    expect(html).toMatch(/<option value="10" selected="">/);
  });
});
