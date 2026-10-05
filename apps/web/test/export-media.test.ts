/**
 * `GET /export/media`（投稿の CSV）の Route Handler の単体テスト（R3 設計 7 章）。DB を使わない。
 * `checkAccess`、`getTargetAccount`、`listMediaCsvRows` を差し替え、認可、失敗、ヘッダー、本文、クエリの検査を確かめる。
 * `markDynamic` と `server-only` は `vitest.config.mts` の alias でスタブ。
 */
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaCsvRow } from "../src/lib/csv";
import { checkAccess } from "../src/lib/auth";
import { getTargetAccount, TARGET_ACCOUNT_NOT_SET } from "../src/lib/queries/account";
import { listMediaCsvRows } from "../src/lib/queries/media";
import { GET } from "../src/app/export/media/route";

vi.mock("../src/lib/auth", () => ({ checkAccess: vi.fn(async () => "pass") }));
vi.mock("../src/lib/queries/account", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/queries/account")>();
  return { ...actual, getTargetAccount: vi.fn() };
});
vi.mock("../src/lib/queries/media", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/queries/media")>();
  return { ...actual, listMediaCsvRows: vi.fn() };
});

const APP_URL = "http://localhost:3000";
const ACCOUNT_ID = "00000000-0000-0000-0000-000000000001";

function request(query = ""): NextRequest {
  return new NextRequest(`${APP_URL}/export/media${query}`, { method: "GET" });
}

function row(overrides: Partial<MediaCsvRow> = {}): MediaCsvRow {
  return {
    media_id: "0000123",
    kind: "feed",
    posted_at_jst: new Date("2026-10-05T01:00:00Z"),
    caption: null,
    permalink: null,
    is_collab: null,
    is_trial_reel: null,
    is_boosted: null,
    gone_at_jst: null,
    latest_fetched_at_jst: null,
    elapsed_latest_hours: null,
    reach: null,
    views: null,
    likes: null,
    comments: null,
    saved: null,
    shares: null,
    profile_visits: null,
    follows: null,
    avg_watch_time_ms: null,
    skip_rate: null,
    er: null,
    save_rate: null,
    share_rate: null,
    like_rate: null,
    comment_rate: null,
    profile_visit_rate: null,
    follow_conversion_rate: null,
    views_per_reach: null,
    reach_7d: null,
    elapsed_7d_hours: null,
    followers_at_post: null,
    reach_rate: null,
    ...overrides,
  };
}

describe("GET /export/media", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(() => {
    error.mockClear();
    vi.mocked(checkAccess).mockReset();
    vi.mocked(checkAccess).mockResolvedValue("pass");
    vi.mocked(getTargetAccount).mockReset();
    vi.mocked(getTargetAccount).mockResolvedValue({
      ok: true,
      data: { id: ACCOUNT_ID, ig_user_id: "000000000000001", username: null, name: null, status: "active" },
    });
    vi.mocked(listMediaCsvRows).mockReset();
    vi.mocked(listMediaCsvRows).mockResolvedValue({ ok: true, data: [] });
  });

  afterAll(() => {
    error.mockRestore();
  });

  it("未ログインは 401、許可外は 403。DB を読まない", async () => {
    vi.mocked(checkAccess).mockResolvedValueOnce("login");
    const r1 = await GET(request());
    expect(r1.status).toBe(401);
    expect(r1.headers.get("cache-control")).toBe("private, no-store");

    vi.mocked(checkAccess).mockResolvedValueOnce("forbid");
    const r2 = await GET(request());
    expect(r2.status).toBe(403);
    expect(getTargetAccount).not.toHaveBeenCalled();
    expect(listMediaCsvRows).not.toHaveBeenCalled();
  });

  it("対象のアカウントが決まらなければ 409 と固定の文言", async () => {
    vi.mocked(getTargetAccount).mockResolvedValueOnce({ ok: false, reason: TARGET_ACCOUNT_NOT_SET });
    const res = await GET(request());
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(TARGET_ACCOUNT_NOT_SET);
    expect(listMediaCsvRows).not.toHaveBeenCalled();
  });

  it("DB の失敗は 500 と固定の文言。DB のエラー文を返さず、ログはクエリの名前と理由だけ", async () => {
    vi.mocked(listMediaCsvRows).mockResolvedValueOnce({ ok: false, reason: "DB エラー（SQLSTATE 42P01）" });
    const res = await GET(request());
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toBe("CSV を作れませんでした");
    expect(body).not.toContain("SQLSTATE");
    expect(error).toHaveBeenCalledWith("[export-media] query=listMediaCsvRows DB エラー（SQLSTATE 42P01）");

    vi.mocked(getTargetAccount).mockResolvedValueOnce({ ok: false, reason: "DB 接続に失敗（SQLSTATE 08006）" });
    const res2 = await GET(request());
    expect(res2.status).toBe(500);
    expect(await res2.text()).toBe("CSV を作れませんでした");
  });

  it("想定外の例外も 500 と固定の文言", async () => {
    vi.mocked(listMediaCsvRows).mockRejectedValueOnce(new Error("secret detail"));
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("CSV を作れませんでした");
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret detail");
  });

  it("200: ヘッダー、BOM、CRLF、見出しの並び、数式の注入の無害化", async () => {
    vi.mocked(listMediaCsvRows).mockResolvedValueOnce({
      ok: true,
      data: [row({ caption: "=HYPERLINK(\"x\")", reach: 100, er: 0.0213 })],
    });
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="instagram-media-\d{8}\.csv"$/);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");

    const buf = new Uint8Array(await res.arrayBuffer());
    expect([...buf.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf).slice(1);
    const lines = text.split("\r\n");
    expect(lines[0]).toBe(
      "media_id,kind,posted_at_jst,caption,permalink,is_collab,is_trial_reel,is_boosted,gone_at_jst," +
        "latest_fetched_at_jst,elapsed_latest_hours,reach,views,likes,comments,saved,shares,profile_visits,follows," +
        "avg_watch_time_ms,skip_rate,er,save_rate,share_rate,like_rate,comment_rate,profile_visit_rate," +
        "follow_conversion_rate,views_per_reach,reach_7d,elapsed_7d_hours,followers_at_post,reach_rate",
    );
    expect(lines[1]).toContain(`,"'=HYPERLINK(""x"")",`);
    expect(lines[1]).toContain("2026-10-05 10:00:00");
    expect(lines[1]).toContain(",100,");
    expect(lines[1]).toContain(",0.0213,");
    expect(lines[2]).toBe("");
    expect(text).not.toContain("thumbnail_path");
    expect(text).not.toContain("account_id");
  });

  it("sort と order を検査して渡す。外れた値と重なったキーは既定（posted、desc）", async () => {
    await GET(request("?sort=reach&order=asc"));
    expect(listMediaCsvRows).toHaveBeenLastCalledWith(ACCOUNT_ID, { sort: "reach", order: "asc" });

    await GET(request("?sort=caption;drop&order=up"));
    expect(listMediaCsvRows).toHaveBeenLastCalledWith(ACCOUNT_ID, { sort: "posted", order: "desc" });

    await GET(request("?sort=reach&sort=likes&order=asc&order=desc"));
    expect(listMediaCsvRows).toHaveBeenLastCalledWith(ACCOUNT_ID, { sort: "posted", order: "desc" });
  });
});
