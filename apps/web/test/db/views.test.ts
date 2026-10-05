/**
 * R3 のマイグレーション `20261005000000_r3_analysis_views.sql` の結合テスト（設計 `doc/design/r3-analysis-screens.md` 9.2 節）。
 * `TEST_DATABASE_URL`（postgres。ローカルの 127.0.0.1 か localhost）があるときだけ動く。
 * web_app の接続は `TEST_WEB_DATABASE_URL` があればそれを、なければ `TEST_DATABASE_URL` の利用者とパスワードを
 * seed.sql の公知の値（web_app / web_app_local）に替えて使う。
 * 架空のアカウント（`000000` ＋ 乱数 9 桁、`status = 'paused'`）を postgres で作り、終了時に消す（CASCADE で関連行も消える）。
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const INSUFFICIENT_PRIVILEGE = "42501";
const HOUR = 3600;
const DAY = 86400;
const DAY_MS = DAY * 1000;

const NEW_VIEWS = ["media_horizon_metrics", "media_list_metrics", "account_daily_wide"] as const;
const SECURITY_INVOKER_VIEWS = [...NEW_VIEWS, "media_metrics_at_horizon"] as const;

function fakeIgUserId(): string {
  return "000000" + Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, "0");
}

/** 架空のメディア ID（数字だけ。先頭 4 桁が 0、`seq` は 3 桁で末尾） */
function fakeMediaId(seq: number): string {
  return "0000" + Date.now().toString() + seq.toString().padStart(3, "0");
}

function isLocal(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost";
  } catch {
    return false;
  }
}

function webUrlFrom(adminUrl: string): string {
  if (process.env.TEST_WEB_DATABASE_URL) return process.env.TEST_WEB_DATABASE_URL;
  // skipIf で飛ばす場合も describe の本体は評価されるので、空なら URL を作らない
  if (!adminUrl) return "";
  const u = new URL(adminUrl);
  u.username = "web_app";
  u.password = "web_app_local";
  return u.toString();
}

/** 失敗した SQL の SQLSTATE を返す。成功したら undefined */
async function sqlstate(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

/** numeric と bigint は postgres.js では文字列。null は null のまま数値にする */
function num(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

describe.skipIf(!TEST_DATABASE_URL)("r3_analysis_views（結合）", () => {
  const adminUrl = TEST_DATABASE_URL ?? "";
  const webUrl = webUrlFrom(adminUrl);
  const igUserId = fakeIgUserId();
  const now = Date.now();
  let admin: postgres.Sql;
  let web: postgres.Sql;
  let accountId = "";

  // 投稿（すべて架空）
  const ids = {
    /** 7d のスナップショットがちょうど 7 日 + 42 時間（許容幅の境目。許容内） */
    edge: fakeMediaId(1),
    /** 7d のスナップショットが 7 日 + 42 時間 + 1 秒（許容外） */
    over: fakeMediaId(2),
    /** 収集前からある投稿（最初のスナップショットが 200 日後） */
    old: fakeMediaId(3),
    /** 収集が 25 日目で止まった投稿。1h は「初めて超えた」ものを選ぶ確認にも使う */
    stopped: fakeMediaId(4),
    /** カルーセル（種類の確認） */
    carousel: fakeMediaId(5),
    /** ストーリーズ（一覧と区分のビューに出ない） */
    story: fakeMediaId(6),
  };
  const edgePostedAt = new Date(now - 30 * DAY_MS);
  const overPostedAt = new Date(now - 31 * DAY_MS);
  const oldPostedAt = new Date(now - 210 * DAY_MS);
  const stoppedPostedAt = new Date(now - 40 * DAY_MS);
  const carouselPostedAt = new Date(now - 32 * DAY_MS);
  const storyPostedAt = new Date(now - 2 * DAY_MS);

  beforeAll(async () => {
    // 本番の URL を誤って渡したときに止める（架空のアカウントを本番に作らない）
    if (!isLocal(adminUrl) || !isLocal(webUrl)) throw new Error("結合テストはローカルの Supabase にだけ接続する");
    admin = postgres(adminUrl, { max: 2, onnotice: () => {} });
    web = postgres(webUrl, { max: 1, onnotice: () => {} });

    const rows = await admin<{ id: string }[]>`
      insert into public.accounts (ig_user_id, username, name, fb_page_id, status)
      values (${igUserId}, 'fake_r3_views', 'Fake R3 Views', '000000000000096', 'paused')
      returning id
    `;
    accountId = rows[0]?.id ?? "";
    expect(accountId).not.toBe("");

    const media: [string, string, string, Date][] = [
      [ids.edge, "VIDEO", "REELS", edgePostedAt],
      [ids.over, "IMAGE", "FEED", overPostedAt],
      [ids.old, "IMAGE", "FEED", oldPostedAt],
      [ids.stopped, "IMAGE", "FEED", stoppedPostedAt],
      [ids.carousel, "CAROUSEL_ALBUM", "FEED", carouselPostedAt],
      [ids.story, "IMAGE", "STORY", storyPostedAt],
    ];
    for (const [id, mediaType, productType, postedAt] of media) {
      await admin`
        insert into public.media (id, account_id, media_type, media_product_type, posted_at)
        values (${id}, ${accountId}, ${mediaType}, ${productType}, ${postedAt})
      `;
    }

    const snap = async (mediaId: string, postedAt: Date, elapsed: number, metrics: Record<string, unknown>) => {
      const fetchedAt = new Date(postedAt.getTime() + elapsed * 1000);
      await admin`
        insert into public.media_insight_snapshots (media_id, fetched_at, elapsed_seconds, metrics)
        values (${mediaId}, ${fetchedAt}, ${elapsed}, ${admin.json(metrics as postgres.JSONValue)})
      `;
    };
    // edge: 7d の点がちょうど 7 日 + 42 時間。最新は 20 日。likes は null（欠損）、profile_visits はキーなし
    await snap(ids.edge, edgePostedAt, 7 * DAY + 42 * HOUR, { reach: 400, views: 800 });
    await snap(ids.edge, edgePostedAt, 20 * DAY, {
      reach: 500, views: 1000, likes: null, comments: 3, saved: 10, shares: 5, reels_skip_rate: 35.5, ig_reels_avg_watch_time: 4200,
    });
    // over: 7d の点が 7 日 + 42 時間 + 1 秒
    await snap(ids.over, overPostedAt, 7 * DAY + 42 * HOUR + 1, { reach: 300 });
    // old: 最初のスナップショットが 200 日後
    await snap(ids.old, oldPostedAt, 200 * DAY, { reach: 900, likes: 10, comments: 2, saved: 4, shares: 4, profile_visits: 20, follows: 2 });
    // stopped: 50 分、61 分、70 分、25 日で止まる
    await snap(ids.stopped, stoppedPostedAt, 3000, { reach: 10 });
    await snap(ids.stopped, stoppedPostedAt, 3660, { reach: 20 });
    await snap(ids.stopped, stoppedPostedAt, 4200, { reach: 30 });
    await snap(ids.stopped, stoppedPostedAt, 25 * DAY, { reach: 200 });
    await snap(ids.carousel, carouselPostedAt, 10 * DAY, { reach: 50 });
    await snap(ids.story, storyPostedAt, 20 * HOUR, { reach: 5 });

    // 投稿前のフォロワー数（edge の投稿の 1 日前と、over の投稿の 1 日前）
    const profile = async (capturedAt: Date, followers: number) => {
      const capturedOn = new Date(capturedAt.getTime() + 9 * HOUR * 1000).toISOString().slice(0, 10);
      await admin`
        insert into public.profile_daily (account_id, captured_on, captured_at, followers_count)
        values (${accountId}, ${capturedOn}, ${capturedAt}, ${followers})
      `;
    };
    await profile(new Date(edgePostedAt.getTime() - DAY_MS), 1000);
    await profile(new Date(overPostedAt.getTime() - DAY_MS), 1000);

    // 日次指標（架空の日付）
    type Row = [string, string, string, string, number | null];
    const daily: Row[] = [
      // 01: 印の値が 0 で区分の行なし → 区分は 0
      ["2001-01-01", "reach", "", "", 0],
      ["2001-01-01", "reach", "follow_type", "", 0],
      // 02: 印の行なし → null
      ["2001-01-02", "reach", "", "", 100],
      // 03: 印の値が正で区分の行なし → null
      ["2001-01-03", "reach", "", "", 500],
      ["2001-01-03", "reach", "follow_type", "", 500],
      // 04: 区分の片方だけ行がある → もう片方は 0。views も同じ形
      ["2001-01-04", "reach", "", "", 500],
      ["2001-01-04", "reach", "follow_type", "", 500],
      ["2001-01-04", "reach", "follow_type", "FOLLOWER", 200],
      ["2001-01-04", "views", "", "", 900],
      ["2001-01-04", "views", "follow_type", "", 900],
      ["2001-01-04", "views", "follow_type", "NON_FOLLOWER", 900],
      // 05: 区分の行があって value が null → null。saves は saved の列へ
      ["2001-01-05", "reach", "", "", 500],
      ["2001-01-05", "reach", "follow_type", "", 500],
      ["2001-01-05", "reach", "follow_type", "FOLLOWER", null],
      ["2001-01-05", "reach", "follow_type", "NON_FOLLOWER", 300],
      ["2001-01-05", "saves", "", "", 7],
      // 06 は行なし（返らない）
      // 07: 最新の日が follower_count だけ
      ["2001-01-07", "follower_count", "", "", 3],
    ];
    for (const [date, metric, breakdown, value, v] of daily) {
      await admin`
        insert into public.account_daily_metrics (account_id, metric_date, metric, breakdown, breakdown_value, value)
        values (${accountId}, ${date}, ${metric}, ${breakdown}, ${value}, ${v})
      `;
    }
  });

  afterAll(async () => {
    if (admin && igUserId) await admin`delete from public.accounts where ig_user_id = ${igUserId}`;
    await web?.end();
    await admin?.end();
  });

  // ------------------------------------------------------------------ 権限と reloptions

  it.each(SECURITY_INVOKER_VIEWS)("%s の reloptions に security_invoker=true がある", async (view) => {
    const [row] = await admin<{ reloptions: string[] | null }[]>`
      select c.reloptions from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = ${view}
    `;
    expect(row?.reloptions).toContain("security_invoker=true");
  });

  it.each([...SECURITY_INVOKER_VIEWS])("web_app はビュー %s を select できる", async (view) => {
    expect(await sqlstate(() => web`select * from ${web(`public.${view}`)} limit 1`)).toBeUndefined();
  });

  it("web_app は media_kind を実行でき、架空のアカウントの行が見える", async () => {
    const [row] = await web<{ k: string }[]>`select public.media_kind('FEED', 'CAROUSEL_ALBUM') as k`;
    expect(row?.k).toBe("carousel");
    const rows = await web<{ media_id: string }[]>`select media_id from public.media_list_metrics where account_id = ${accountId}`;
    expect(rows).toHaveLength(5);
  });

  it("anon と authenticated は新しいビューと media_kind を使えない", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      const queries = [
        ...NEW_VIEWS.map((v) => `select * from public.${v} limit 1`),
        "select public.media_kind('FEED', 'IMAGE')",
      ];
      for (const q of queries) {
        const state = await sqlstate(() =>
          admin.begin(async (tx) => {
            await tx.unsafe(`set local role ${role}`);
            return tx.unsafe(q);
          }),
        );
        expect(state, `${role} / ${q}`).toBe(INSUFFICIENT_PRIVILEGE);
      }
    }
  });

  it("media_kind の実行権が PUBLIC、anon、authenticated に付いていない", async () => {
    const rows = await admin<{ grantee: string }[]>`
      select grantee from information_schema.routine_privileges
      where routine_schema = 'public' and routine_name = 'media_kind'
        and grantee in ('PUBLIC', 'anon', 'authenticated')
    `;
    expect(rows).toEqual([]);
  });

  // ------------------------------------------------------------------ 区分と許容幅

  async function horizon(mediaId: string, h: string) {
    const [row] = await admin<{ elapsed_seconds: number; within_tolerance: boolean; tolerance_seconds: number | null; reach: string | null }[]>`
      select elapsed_seconds, within_tolerance, tolerance_seconds, reach
      from public.media_horizon_metrics where media_id = ${mediaId} and horizon = ${h}
    `;
    return row;
  }

  it("7d の許容幅の境目: 7 日 + 42 時間ちょうどは許容内、1 秒超えは許容外", async () => {
    const edge = await horizon(ids.edge, "7d");
    expect(edge?.elapsed_seconds).toBe(7 * DAY + 42 * HOUR);
    expect(edge?.tolerance_seconds).toBe(42 * HOUR);
    expect(edge?.within_tolerance).toBe(true);
    const over = await horizon(ids.over, "7d");
    expect(over?.elapsed_seconds).toBe(7 * DAY + 42 * HOUR + 1);
    expect(over?.within_tolerance).toBe(false);
  });

  it("区分ごとに「初めて超えた」スナップショットを選び、収集前の投稿と止まった投稿の 7d は許容外", async () => {
    const h1 = await horizon(ids.stopped, "1h");
    expect(h1?.elapsed_seconds).toBe(3660);
    expect(num(h1?.reach)).toBe(20);
    expect(h1?.within_tolerance).toBe(true);
    const stopped7d = await horizon(ids.stopped, "7d");
    expect(stopped7d?.elapsed_seconds).toBe(25 * DAY);
    expect(stopped7d?.within_tolerance).toBe(false);
    // 30d を超えるスナップショットがないので 30d の行はない
    expect(await horizon(ids.stopped, "30d")).toBeUndefined();

    const old1h = await horizon(ids.old, "1h");
    expect(old1h?.elapsed_seconds).toBe(200 * DAY);
    expect(old1h?.within_tolerance).toBe(false);
    expect((await horizon(ids.old, "7d"))?.within_tolerance).toBe(false);
    // 90d も 200 日のスナップショットで、許容幅（+ 22.5 日）の外
    expect((await horizon(ids.old, "90d"))?.within_tolerance).toBe(false);
    // latest は許容幅を持たず常に true
    const latest = await horizon(ids.old, "latest");
    expect(latest?.tolerance_seconds).toBeNull();
    expect(latest?.within_tolerance).toBe(true);
  });

  it("リーチ率は 7d が許容内の投稿だけ。許容外（境目の 1 秒超え、収集前、止まった投稿）は null", async () => {
    const rows = await admin<{ media_id: string; reach_7d: string | null; followers_at_post: number | null; reach_rate: string | null }[]>`
      select media_id, reach_7d, followers_at_post, reach_rate from public.media_list_metrics where account_id = ${accountId}
    `;
    const by = new Map(rows.map((r) => [r.media_id, r]));
    expect(num(by.get(ids.edge)?.reach_7d)).toBe(400);
    expect(by.get(ids.edge)?.followers_at_post).toBe(1000);
    expect(num(by.get(ids.edge)?.reach_rate)).toBeCloseTo(0.4, 10);
    // over はフォロワー数があるが 7d が許容外
    expect(by.get(ids.over)?.followers_at_post).toBe(1000);
    expect(by.get(ids.over)?.reach_7d).toBeNull();
    expect(by.get(ids.over)?.reach_rate).toBeNull();
    expect(by.get(ids.old)?.reach_rate).toBeNull();
    expect(by.get(ids.stopped)?.reach_rate).toBeNull();
    // ストーリーズは一覧に出ない
    expect(by.has(ids.story)).toBe(false);
  });

  // ------------------------------------------------------------------ JSON と派生指標

  it("キーがない指標と値が null の指標はともに null、reels_skip_rate は 0〜1、種類が決まる", async () => {
    const [row] = await admin<Record<string, string | null>[]>`
      select kind, reach, likes, profile_visits, skip_rate, avg_watch_time_ms, er, save_rate, profile_visit_rate, views_per_reach
      from public.media_list_metrics where media_id = ${ids.edge}
    `;
    expect(row?.kind).toBe("reel");
    expect(num(row?.reach)).toBe(500);
    expect(row?.likes).toBeNull(); // 値が null
    expect(row?.profile_visits).toBeNull(); // キーなし
    expect(row?.profile_visit_rate).toBeNull();
    expect(row?.er).toBeNull(); // likes が null なので合計も null
    expect(num(row?.save_rate)).toBeCloseTo(0.02, 10);
    expect(num(row?.views_per_reach)).toBeCloseTo(2, 10);
    expect(num(row?.avg_watch_time_ms)).toBe(4200);
    expect(num(row?.skip_rate)).toBeCloseTo(0.355, 10);

    const kinds = await admin<{ media_id: string; kind: string }[]>`
      select media_id, kind from public.media_list_metrics where media_id in (${ids.carousel}, ${ids.old})
    `;
    expect(Object.fromEntries(kinds.map((k) => [k.media_id, k.kind]))).toEqual({ [ids.carousel]: "carousel", [ids.old]: "feed" });

    // 派生指標は区分の値どうし（old の latest: (10+2+4+4)/900、follows/profile_visits）
    const [old] = await admin<{ er: string; follow_conversion_rate: string }[]>`
      select er, follow_conversion_rate from public.media_horizon_metrics where media_id = ${ids.old} and horizon = 'latest'
    `;
    expect(num(old?.er)).toBeCloseTo(20 / 900, 10);
    expect(num(old?.follow_conversion_rate)).toBeCloseTo(0.1, 10);
  });

  it("skip_rate は全行で 0〜1 に入る（架空と既存の行の両方）", async () => {
    const [row] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.media_horizon_metrics where skip_rate < 0 or skip_rate > 1
    `;
    expect(row?.n).toBe(0);
  });

  it("media_horizon_metrics にストーリーズが出ない", async () => {
    const [row] = await admin<{ n: number }[]>`select count(*)::int as n from public.media_horizon_metrics where media_id = ${ids.story}`;
    expect(row?.n).toBe(0);
  });

  // ------------------------------------------------------------------ 日次

  it("account_daily_wide の内訳の 0 と null の 5 通り、saves → saved、行のない日は返らない", async () => {
    const rows = await admin<
      {
        metric_date: string;
        reach: string | null;
        reach_follower: string | null;
        reach_non_follower: string | null;
        views_follower: string | null;
        views_non_follower: string | null;
        saved: string | null;
        new_followers: string | null;
      }[]
    >`
      select metric_date::text as metric_date, reach, reach_follower, reach_non_follower,
        views_follower, views_non_follower, saved, new_followers
      from public.account_daily_wide where account_id = ${accountId} order by metric_date
    `;
    const by = new Map(rows.map((r) => [r.metric_date, r]));
    expect([...by.keys()]).toEqual(["2001-01-01", "2001-01-02", "2001-01-03", "2001-01-04", "2001-01-05", "2001-01-07"]);

    const pair = (d: string) => [num(by.get(d)?.reach_follower), num(by.get(d)?.reach_non_follower)];
    expect(pair("2001-01-01")).toEqual([0, 0]); // 印の値が 0
    expect(pair("2001-01-02")).toEqual([null, null]); // 印の行なし
    expect(pair("2001-01-03")).toEqual([null, null]); // 印の値が正で区分の行なし
    expect(pair("2001-01-04")).toEqual([200, 0]); // 片方だけ
    expect(pair("2001-01-05")).toEqual([null, 300]); // 区分の行の value が null
    expect([num(by.get("2001-01-04")?.views_follower), num(by.get("2001-01-04")?.views_non_follower)]).toEqual([0, 900]);
    // views の印の行がない日は views の内訳も null
    expect([num(by.get("2001-01-05")?.views_follower), num(by.get("2001-01-05")?.views_non_follower)]).toEqual([null, null]);
    expect(num(by.get("2001-01-05")?.saved)).toBe(7);
  });

  it("最新の日が follower_count だけの日は reach が null で new_followers が入る", async () => {
    const [row] = await admin<{ metric_date: string; reach: string | null; new_followers: string | null }[]>`
      select metric_date::text as metric_date, reach, new_followers
      from public.account_daily_wide where account_id = ${accountId} order by metric_date desc limit 1
    `;
    expect(row?.metric_date).toBe("2001-01-07");
    expect(row?.reach).toBeNull();
    expect(num(row?.new_followers)).toBe(3);
    // 「reach のある最新の日」は前の日になる（getDailyRange の式）
    const [range] = await admin<{ last: string }[]>`
      select (max(metric_date) filter (where reach is not null))::text as last
      from public.account_daily_wide where account_id = ${accountId}
    `;
    expect(range?.last).toBe("2001-01-05");
  });
});
