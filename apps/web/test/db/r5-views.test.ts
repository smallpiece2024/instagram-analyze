/**
 * R5 のマイグレーション `20261009000000_r5_analysis.sql` の結合テスト（設計 `doc/design/r5-analysis.md` 5 章、7.1 節の DB、7.2 節）。
 * `TEST_DATABASE_URL`（postgres）があるときだけ動く。権限の節は `TEST_WEB_DATABASE_URL`（web_app）も要る。
 * どちらもローカル（127.0.0.1 か localhost）を指すときだけ動く。架空のアカウントを作り、`afterAll` で消す
 * （カスケードで関連行も消える）。手元の DB の本物の行は変えない。
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllDb, getDb, type Db } from "../../src/lib/db";
import {
  DAY_MS,
  HOUR_MS,
  fakeMediaId,
  insertAudienceCapture,
  insertFakeAccount,
  insertMedia,
  insertMediaTag,
  insertProfileDaily,
  insertStory,
  insertTagAxis,
  insertTagValue,
  jstWeekStart,
  storyMetrics,
} from "./fixtures";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_WEB_DATABASE_URL = process.env.TEST_WEB_DATABASE_URL;

const INSUFFICIENT_PRIVILEGE = "42501";
const FOREIGN_KEY_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

function isLocal(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost";
  } catch {
    return false;
  }
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

/** 月曜の日付（YYYY-MM-DD）。2026-07-06 は月曜 */
const MONDAY = "2026-07-06";

describe.skipIf(!TEST_DATABASE_URL)("r5_analysis（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  let sql: postgres.Sql;
  let accountA = "";
  let accountB = "";
  let seq = 100;
  const nextMediaId = (): string => fakeMediaId(seq++);

  beforeAll(async () => {
    if (!isLocal(url)) throw new Error("結合テストはローカルの Supabase にだけ接続する");
    sql = postgres(url, { max: 1, onnotice: () => {} });
    accountA = await insertFakeAccount(sql, "fake_r5_a");
    accountB = await insertFakeAccount(sql, "fake_r5_b");
  });

  afterAll(async () => {
    const created = [accountA, accountB].filter((id) => id !== "");
    if (created.length > 0) await sql`delete from public.accounts where id in ${sql(created)}`;
    await sql.end({ timeout: 5 });
  });

  describe("マイグレーションの前提", () => {
    it("データベースの文字コードが UTF8（normalize の前提）", async () => {
      const [row] = await sql<{ enc: string }[]>`
        select pg_encoding_to_char(encoding) as enc from pg_database where datname = current_database()
      `;
      expect(row?.enc).toBe("UTF8");
    });

    it("新しいビューは security_invoker", async () => {
      const rows = await sql<{ relname: string; opts: string[] | null }[]>`
        select c.relname, c.reloptions as opts
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname in ('media_hashtags', 'story_list_metrics')
        order by c.relname
      `;
      expect(rows.map((r) => r.relname)).toEqual(["media_hashtags", "story_list_metrics"]);
      for (const r of rows) expect(r.opts ?? []).toContain("security_invoker=true");
    });

    it("caption_hashtags は stable で、PUBLIC は実行できない", async () => {
      const [row] = await sql<{ vol: string; public_exec: boolean }[]>`
        select p.provolatile as vol,
               has_function_privilege('public', p.oid, 'execute') as public_exec
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'caption_hashtags'
      `;
      expect(row?.vol).toBe("s");
      expect(row?.public_exec).toBe(false);
    });

    it("media に (id, account_id) の一意制約がある", async () => {
      const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_constraint
        where conrelid = 'public.media'::regclass and conname = 'media_id_account_key' and contype = 'u'
      `;
      expect(row?.n).toBe(1);
    });
  });

  describe("独自タグ（tag_axes、tag_values、media_tags）", () => {
    it("複合の外部キー: 別のアカウントの投稿、軸 A に軸 B の値、消された値の id を拒む（T6）", async () => {
      const mediaA = nextMediaId();
      const mediaB = nextMediaId();
      await insertMedia(sql, { id: mediaA, accountId: accountA, postedAt: new Date(Date.now() - 5 * DAY_MS) });
      await insertMedia(sql, { id: mediaB, accountId: accountB, postedAt: new Date(Date.now() - 5 * DAY_MS) });
      const axisA = await insertTagAxis(sql, { accountId: accountA, name: "FK テーマ" });
      const axisA2 = await insertTagAxis(sql, { accountId: accountA, name: "FK 目的" });
      const axisB = await insertTagAxis(sql, { accountId: accountB, name: "FK テーマ" });
      const valueA = await insertTagValue(sql, { axisId: axisA, name: "料理" });
      const valueA2 = await insertTagValue(sql, { axisId: axisA2, name: "集客" });
      const valueB = await insertTagValue(sql, { axisId: axisB, name: "料理" });

      // 別のアカウントの投稿（account_id を A にしても B の投稿とは組にならない）
      expect(await sqlstate(() => insertMediaTag(sql, { mediaId: mediaB, accountId: accountA, axisId: axisA, valueId: valueA }))).toBe(
        FOREIGN_KEY_VIOLATION,
      );
      // 別のアカウントの軸（account_id を B にすると投稿の組が合わない）
      expect(await sqlstate(() => insertMediaTag(sql, { mediaId: mediaA, accountId: accountA, axisId: axisB, valueId: valueB }))).toBe(
        FOREIGN_KEY_VIOLATION,
      );
      // 軸 A に軸 A2 の値
      expect(await sqlstate(() => insertMediaTag(sql, { mediaId: mediaA, accountId: accountA, axisId: axisA, valueId: valueA2 }))).toBe(
        FOREIGN_KEY_VIOLATION,
      );
      // 消された値の id
      const gone = await insertTagValue(sql, { axisId: axisA, name: "消す値" });
      await sql`delete from public.tag_values where id = ${gone}::bigint`;
      expect(await sqlstate(() => insertMediaTag(sql, { mediaId: mediaA, accountId: accountA, axisId: axisA, valueId: gone }))).toBe(
        FOREIGN_KEY_VIOLATION,
      );
      // 正しい組は入る
      expect(await sqlstate(() => insertMediaTag(sql, { mediaId: mediaA, accountId: accountA, axisId: axisA, valueId: valueA }))).toBeUndefined();
    });

    it("軸ごとに 1 つ。別の値を同じ軸に付けると 23505、update で付け替えられる", async () => {
      const media = nextMediaId();
      await insertMedia(sql, { id: media, accountId: accountA, postedAt: new Date(Date.now() - 4 * DAY_MS) });
      const axis = await insertTagAxis(sql, { accountId: accountA, name: "一つだけ" });
      const v1 = await insertTagValue(sql, { axisId: axis, name: "値1" });
      const v2 = await insertTagValue(sql, { axisId: axis, name: "値2" });
      await insertMediaTag(sql, { mediaId: media, accountId: accountA, axisId: axis, valueId: v1 });
      expect(await sqlstate(() => insertMediaTag(sql, { mediaId: media, accountId: accountA, axisId: axis, valueId: v2 }))).toBe(UNIQUE_VIOLATION);
      await sql`update public.media_tags set value_id = ${v2}::bigint where media_id = ${media} and axis_id = ${axis}::bigint`;
      const [row] = await sql<{ value_id: string }[]>`select value_id::text from public.media_tags where media_id = ${media}`;
      expect(row?.value_id).toBe(v2);
    });

    it("値の削除: 付いていれば 23503、付いていなければ消える（D2）", async () => {
      const media = nextMediaId();
      await insertMedia(sql, { id: media, accountId: accountA, postedAt: new Date(Date.now() - 3 * DAY_MS) });
      const axis = await insertTagAxis(sql, { accountId: accountA, name: "値の削除" });
      const used = await insertTagValue(sql, { axisId: axis, name: "使用中" });
      const unused = await insertTagValue(sql, { axisId: axis, name: "未使用" });
      await insertMediaTag(sql, { mediaId: media, accountId: accountA, axisId: axis, valueId: used });

      expect(await sqlstate(() => sql`delete from public.tag_values where id = ${used}::bigint`)).toBe(FOREIGN_KEY_VIOLATION);
      expect(await sqlstate(() => sql`delete from public.tag_values where id = ${unused}::bigint`)).toBeUndefined();
      const rows = await sql<{ id: string }[]>`select id::text from public.tag_values where axis_id = ${axis}::bigint order by id`;
      expect(rows.map((r) => r.id)).toEqual([used]);
    });

    it("タグが付いた投稿がある軸を消すと、値と対応が消える（D2: no action は連鎖の順に左右されない）", async () => {
      const m1 = nextMediaId();
      const m2 = nextMediaId();
      await insertMedia(sql, { id: m1, accountId: accountA, postedAt: new Date(Date.now() - 2 * DAY_MS) });
      await insertMedia(sql, { id: m2, accountId: accountA, postedAt: new Date(Date.now() - 2 * DAY_MS) });
      const axis = await insertTagAxis(sql, { accountId: accountA, name: "消す軸" });
      const keep = await insertTagAxis(sql, { accountId: accountA, name: "残す軸" });
      const v1 = await insertTagValue(sql, { axisId: axis, name: "値1" });
      const v2 = await insertTagValue(sql, { axisId: axis, name: "値2" });
      const k1 = await insertTagValue(sql, { axisId: keep, name: "残る値" });
      await insertMediaTag(sql, { mediaId: m1, accountId: accountA, axisId: axis, valueId: v1 });
      await insertMediaTag(sql, { mediaId: m2, accountId: accountA, axisId: axis, valueId: v2 });
      await insertMediaTag(sql, { mediaId: m1, accountId: accountA, axisId: keep, valueId: k1 });

      expect(await sqlstate(() => sql`delete from public.tag_axes where id = ${axis}::bigint`)).toBeUndefined();
      const [counts] = await sql<{ values: number; tags: number; kept: number }[]>`
        select
          (select count(*)::int from public.tag_values where axis_id = ${axis}::bigint) as values,
          (select count(*)::int from public.media_tags where axis_id = ${axis}::bigint) as tags,
          (select count(*)::int from public.media_tags where axis_id = ${keep}::bigint) as kept
      `;
      expect(counts).toEqual({ values: 0, tags: 0, kept: 1 });
    });

    it("投稿を消すと、その投稿のタグが消える", async () => {
      const media = nextMediaId();
      await insertMedia(sql, { id: media, accountId: accountA, postedAt: new Date(Date.now() - DAY_MS) });
      const axis = await insertTagAxis(sql, { accountId: accountA, name: "投稿の削除" });
      const v = await insertTagValue(sql, { axisId: axis, name: "値" });
      await insertMediaTag(sql, { mediaId: media, accountId: accountA, axisId: axis, valueId: v });
      await sql`delete from public.media where id = ${media}`;
      const [row] = await sql<{ n: number }[]>`select count(*)::int as n from public.media_tags where media_id = ${media}`;
      expect(row?.n).toBe(0);
    });

    it("名前の check（D15）: 空、前後の空白、制御文字、31 コードポイントを拒み、絵文字を含む 30 コードポイントは通る", async () => {
      const bad = ["", " 前に空白", "後ろに空白 ", "タブ\tあり", "改行\nあり", "a".repeat(31), "😀".repeat(31)];
      for (const name of bad) {
        expect(await sqlstate(() => insertTagAxis(sql, { accountId: accountA, name })), JSON.stringify(name)).toBe(CHECK_VIOLATION);
      }
      const axis = await insertTagAxis(sql, { accountId: accountA, name: "😀".repeat(30) });
      for (const name of bad) {
        expect(await sqlstate(() => insertTagValue(sql, { axisId: axis, name })), JSON.stringify(name)).toBe(CHECK_VIOLATION);
      }
      expect(await sqlstate(() => insertTagValue(sql, { axisId: axis, name: "あ".repeat(29) + "😀" }))).toBeUndefined();
      // 同じ名前は同じアカウント（軸）の中で 23505。大文字小文字は区別する
      expect(await sqlstate(() => insertTagAxis(sql, { accountId: accountA, name: "😀".repeat(30) }))).toBe(UNIQUE_VIOLATION);
      expect(await sqlstate(() => insertTagAxis(sql, { accountId: accountB, name: "😀".repeat(30) }))).toBeUndefined();
      await insertTagValue(sql, { axisId: axis, name: "Coffee" });
      expect(await sqlstate(() => insertTagValue(sql, { axisId: axis, name: "Coffee" }))).toBe(UNIQUE_VIOLATION);
      expect(await sqlstate(() => insertTagValue(sql, { axisId: axis, name: "coffee" }))).toBeUndefined();
    });

    it("トリガーが updated_at を入れる（明示した値も上書きする。D14）", async () => {
      const axis = await insertTagAxis(sql, { accountId: accountA, name: "トリガー" });
      const v = await insertTagValue(sql, { axisId: axis, name: "値" });
      await sql`update public.tag_axes set sort_order = 1, updated_at = '2000-01-01T00:00:00Z' where id = ${axis}::bigint`;
      await sql`update public.tag_values set sort_order = 1, updated_at = '2000-01-01T00:00:00Z' where id = ${v}::bigint`;
      const [row] = await sql<{ a: Date; v: Date }[]>`
        select (select updated_at from public.tag_axes where id = ${axis}::bigint) as a,
               (select updated_at from public.tag_values where id = ${v}::bigint) as v
      `;
      expect(row?.a.getUTCFullYear()).toBeGreaterThan(2000);
      expect(row?.v.getUTCFullYear()).toBeGreaterThan(2000);
    });
  });

  describe("属性の週次記録（audience_captures、audience_values）", () => {
    const insertCapture = (over: Partial<Record<"metric" | "timeframe" | "breakdown" | "week_start" | "status", string>>) => () =>
      sql`
        insert into public.audience_captures (account_id, metric, timeframe, breakdown, week_start, status, fetched_at)
        values (${accountA}, ${over.metric ?? "follower_demographics"}, ${over.timeframe ?? "this_month"},
                ${over.breakdown ?? "age"}, ${over.week_start ?? "2026-06-01"}, ${over.status ?? "ok"}, now())
      `;

    it("check の列挙外（metric、timeframe、breakdown、status）と月曜でない week_start を拒む（D8、D9）", async () => {
      expect(await sqlstate(insertCapture({ metric: "online_followers" }))).toBe(CHECK_VIOLATION);
      expect(await sqlstate(insertCapture({ timeframe: "last_30_days" }))).toBe(CHECK_VIOLATION);
      expect(await sqlstate(insertCapture({ breakdown: "region" }))).toBe(CHECK_VIOLATION);
      expect(await sqlstate(insertCapture({ status: "error" }))).toBe(CHECK_VIOLATION);
      expect(await sqlstate(insertCapture({ week_start: "2026-06-02" }))).toBe(CHECK_VIOLATION); // 火曜
      expect(await sqlstate(insertCapture({ week_start: "2026-06-07" }))).toBe(CHECK_VIOLATION); // 日曜
      expect(await sqlstate(insertCapture({ week_start: "2026-06-01", timeframe: "this_week" }))).toBeUndefined(); // 月曜
    });

    it("同じ組と週は 1 行。on conflict do nothing returning は行を返さない（D11、D12）", async () => {
      const weekStart = "2026-06-08";
      await insertAudienceCapture(sql, { accountId: accountA, breakdown: "gender", weekStart, values: { F: 10, M: 5 } });
      expect(
        await sqlstate(() => insertAudienceCapture(sql, { accountId: accountA, breakdown: "gender", weekStart, values: {} })),
      ).toBe(UNIQUE_VIOLATION);
      const rows = await sql`
        insert into public.audience_captures (account_id, metric, timeframe, breakdown, week_start, status, fetched_at)
        values (${accountA}, 'follower_demographics', 'this_month', 'gender', ${weekStart}, 'empty', now())
        on conflict (account_id, metric, timeframe, breakdown, week_start) do nothing
        returning id
      `;
      expect(rows).toHaveLength(0);
      // 指標、timeframe、内訳、アカウントが違えば別の行
      await insertAudienceCapture(sql, { accountId: accountA, metric: "engaged_audience_demographics", breakdown: "gender", weekStart, values: {} });
      await insertAudienceCapture(sql, { accountId: accountA, timeframe: "this_week", breakdown: "gender", weekStart, values: {} });
      await insertAudienceCapture(sql, { accountId: accountA, breakdown: "age", weekStart, values: {} });
      await insertAudienceCapture(sql, { accountId: accountB, breakdown: "gender", weekStart, values: {} });
    });

    it("値の check（負の数、空と 201 文字の区分）と、capture を消すと値も消える", async () => {
      const id = await insertAudienceCapture(sql, {
        accountId: accountA,
        breakdown: "city",
        weekStart: jstWeekStart(new Date("2026-06-17T00:00:00Z")),
        values: { CityA: 3, ["😀".repeat(200)]: 1 },
      });
      const insertValue = (key: string, value: number) => () =>
        sql`insert into public.audience_values (capture_id, value_key, value) values (${id}::bigint, ${key}, ${value})`;
      expect(await sqlstate(insertValue("CityB", -1))).toBe(CHECK_VIOLATION);
      expect(await sqlstate(insertValue("", 1))).toBe(CHECK_VIOLATION);
      expect(await sqlstate(insertValue("a".repeat(201), 1))).toBe(CHECK_VIOLATION);
      expect(await sqlstate(insertValue("CityA", 1))).toBe(UNIQUE_VIOLATION);
      expect(await sqlstate(insertValue("CityC", 0))).toBeUndefined();
      await sql`delete from public.audience_captures where id = ${id}::bigint`;
      const [row] = await sql<{ n: number }[]>`select count(*)::int as n from public.audience_values where capture_id = ${id}::bigint`;
      expect(row?.n).toBe(0);
    });

    it("年齢の value_key は文字列の順で若い順になる（D10）", async () => {
      const id = await insertAudienceCapture(sql, {
        accountId: accountA,
        breakdown: "age",
        weekStart: MONDAY,
        values: { "65+": 1, "18-24": 2, "45-54": 3, "25-34": 4, "55-64": 5, "35-44": 6, "13-17": 7 },
      });
      const rows = await sql<{ value_key: string }[]>`
        select value_key from public.audience_values where capture_id = ${id}::bigint order by value_key
      `;
      expect(rows.map((r) => r.value_key)).toEqual(["13-17", "18-24", "25-34", "35-44", "45-54", "55-64", "65+"]);
    });
  });

  describe("ハッシュタグ（caption_hashtags、media_hashtags。7.2 節）", () => {
    const tags = async (caption: string | null): Promise<string[]> => {
      const [row] = await sql<{ tags: string[] }[]>`
        select coalesce(array(select t from public.caption_hashtags(${caption}::text) as t order by t), '{}') as tags
      `;
      return row?.tags ?? [];
    };

    it.each([
      ["#Coffee #coffee", ["coffee"]],
      ["＃珈琲", ["珈琲"]],
      ["#a　#b", ["a", "b"]],
      ["#a\n#b", ["a", "b"]],
      ["#コーヒー。", ["コーヒー"]],
      ["#coffee!", ["coffee"]],
      ["(#coffee)", ["coffee"]],
      ["#ｺｰﾋｰ", ["コーヒー"]],
      ["#Ｃｏｆｆｅｅ", ["coffee"]],
      ["#coffee☕", ["coffee"]],
      ["#👨‍👩‍👧", []],
      ["#2026", []],
      ["#2026年", ["2026年"]],
      ["https://example.com/#top", []],
      ["a#b", []],
      ["##coffee", ["coffee"]],
      ["#", []],
      ["#cafe_latte #ケーキ屋 #佐々木 #〆切 #ヶ月", ["cafe_latte", "ケーキ屋", "佐々木", "〆切", "ヶ月"].sort()],
      ["AT&#x と /#y", []],
    ] as const)("%j → %j", async (caption, expected) => {
      expect((await tags(caption)).sort()).toEqual([...expected].sort());
    });

    it("キャプションが null なら 0 行", async () => {
      expect(await tags(null)).toEqual([]);
    });

    it("media_hashtags はストーリーズを除き、1 投稿の同じタグは 1 行", async () => {
      const feed = nextMediaId();
      const story = nextMediaId();
      await insertMedia(sql, { id: feed, accountId: accountB, postedAt: new Date(Date.now() - DAY_MS), caption: "#Tea と #tea と #お茶" });
      await insertMedia(sql, { id: story, accountId: accountB, postedAt: new Date(Date.now() - HOUR_MS), productType: "STORY", caption: "#tea" });
      const rows = await sql<{ media_id: string; account_id: string; tag: string }[]>`
        select media_id, account_id, tag from public.media_hashtags where media_id in (${feed}, ${story})
      `;
      expect(rows.map((r) => `${r.media_id}|${r.account_id}|${r.tag}`).sort()).toEqual(
        [`${feed}|${accountB}|tea`, `${feed}|${accountB}|お茶`].sort(),
      );
    });
  });

  describe("story_list_metrics（T8）", () => {
    // 架空の過去の日付。ストーリーズを 10 日ずつ離し、profile_daily の JST の日付が重ならないようにする
    const base = new Date("2026-05-01T03:00:00Z").getTime();
    const at = (i: number): Date => new Date(base + i * 10 * DAY_MS);
    const ids = Array.from({ length: 8 }, () => "");

    beforeAll(async () => {
      for (let i = 0; i < ids.length; i++) ids[i] = fakeMediaId(900 + i);
      // 0: 同時刻の記録を使う。views 50 ÷ 200 = 0.25、tap_exit 5 ÷ 50 = 0.1
      await insertStory(sql, { id: ids[0] ?? "", accountId: accountA, postedAt: at(0), metrics: storyMetrics({ views: 50, reach: 40, tapExit: 5, tapForward: 30, tapBack: 2, swipeForward: 3, linkClicks: 1 }) });
      await insertProfileDaily(sql, { accountId: accountA, capturedAt: at(0), followersCount: 200 });
      // 1: ちょうど 3 日前の記録を使う
      await insertStory(sql, { id: ids[1] ?? "", accountId: accountA, postedAt: at(1), metrics: storyMetrics({ views: 30 }) });
      await insertProfileDaily(sql, { accountId: accountA, capturedAt: new Date(at(1).getTime() - 3 * DAY_MS), followersCount: 300 });
      // 2: 3 日と 1 秒前の記録は使わない
      await insertStory(sql, { id: ids[2] ?? "", accountId: accountA, postedAt: at(2), metrics: storyMetrics({ views: 30 }) });
      await insertProfileDaily(sql, { accountId: accountA, capturedAt: new Date(at(2).getTime() - 3 * DAY_MS - 1000), followersCount: 400 });
      // 3: 投稿の後の記録は使わない
      await insertStory(sql, { id: ids[3] ?? "", accountId: accountA, postedAt: at(3), metrics: storyMetrics({ views: 30 }) });
      await insertProfileDaily(sql, { accountId: accountA, capturedAt: new Date(at(3).getTime() + HOUR_MS), followersCount: 500 });
      // 4: 3 日以内に 2 件あれば近いほう
      await insertStory(sql, { id: ids[4] ?? "", accountId: accountA, postedAt: at(4), metrics: storyMetrics({ views: 30 }) });
      await insertProfileDaily(sql, { accountId: accountA, capturedAt: new Date(at(4).getTime() - 2 * DAY_MS), followersCount: 600 });
      await insertProfileDaily(sql, { accountId: accountA, capturedAt: new Date(at(4).getTime() - DAY_MS), followersCount: 700 });
      // 5: 閲覧 0 なら離脱率は null
      await insertStory(sql, { id: ids[5] ?? "", accountId: accountA, postedAt: at(5), metrics: storyMetrics({ views: 0, tapExit: 0 }) });
      await insertProfileDaily(sql, { accountId: accountA, capturedAt: at(5), followersCount: 0 });
      // 6: navigation のキーがない
      await insertStory(sql, { id: ids[6] ?? "", accountId: accountA, postedAt: at(6), metrics: storyMetrics({ views: 10, navigation: false }) });
      // 7: 別のアカウントの記録は使わない
      await insertStory(sql, { id: ids[7] ?? "", accountId: accountA, postedAt: at(7), metrics: storyMetrics({ views: 10 }) });
      await insertProfileDaily(sql, { accountId: accountB, capturedAt: at(7), followersCount: 900 });
    });

    type Row = {
      media_id: string;
      account_id: string;
      views: string | null;
      reach: string | null;
      tap_forward: string | null;
      tap_back: string | null;
      tap_exit: string | null;
      swipe_forward: string | null;
      link_clicks: string | null;
      replies: string | null;
      followers_at_post: number | null;
      view_rate: string | null;
      exit_rate: string | null;
      story_seq: string;
      story_count_of_day: string;
    };
    const load = async (): Promise<Map<string, Row>> => {
      const rows = await sql<Row[]>`select * from public.story_list_metrics where media_id in ${sql(ids)}`;
      return new Map(rows.map((r) => [r.media_id, r]));
    };

    it("割合は整数の割り算にならない（50 ÷ 200 = 0.25）。操作の件数を列にする", async () => {
      const r = (await load()).get(ids[0] ?? "");
      expect(r?.followers_at_post).toBe(200);
      expect(Number(r?.view_rate)).toBeCloseTo(0.25, 10);
      expect(Number(r?.exit_rate)).toBeCloseTo(0.1, 10);
      expect([r?.views, r?.reach, r?.tap_forward, r?.tap_back, r?.tap_exit, r?.swipe_forward, r?.link_clicks, r?.replies].map(Number)).toEqual([
        50, 40, 30, 2, 5, 3, 1, 0,
      ]);
      expect(r?.account_id).toBe(accountA);
      expect(Number(r?.story_seq)).toBe(1);
      expect(Number(r?.story_count_of_day)).toBe(1);
    });

    it("分母の 3 日の境目: 同時刻とちょうど 3 日前は使い、3 日と 1 秒前と投稿の後と別のアカウントは使わない。近いほうを使う", async () => {
      const m = await load();
      expect(m.get(ids[1] ?? "")?.followers_at_post).toBe(300);
      expect(m.get(ids[2] ?? "")?.followers_at_post).toBeNull();
      expect(m.get(ids[2] ?? "")?.view_rate).toBeNull();
      expect(m.get(ids[3] ?? "")?.followers_at_post).toBeNull();
      expect(m.get(ids[4] ?? "")?.followers_at_post).toBe(700);
      expect(m.get(ids[7] ?? "")?.followers_at_post).toBeNull();
    });

    it("閲覧 0 で離脱率 null、フォロワー 0 で閲覧率 null", async () => {
      const r = (await load()).get(ids[5] ?? "");
      expect(r?.exit_rate).toBeNull();
      expect(r?.view_rate).toBeNull();
    });

    it("navigation のキーがなければ操作の列と離脱率は null", async () => {
      const r = (await load()).get(ids[6] ?? "");
      expect(Number(r?.views)).toBe(10);
      expect([r?.tap_forward, r?.tap_back, r?.tap_exit, r?.swipe_forward, r?.exit_rate]).toEqual([null, null, null, null, null]);
    });
  });
});

describe.skipIf(!TEST_DATABASE_URL || !TEST_WEB_DATABASE_URL)("r5_analysis の権限（web_app。結合）", () => {
  const adminUrl = TEST_DATABASE_URL ?? "";
  const webUrl = TEST_WEB_DATABASE_URL ?? "";
  let admin: postgres.Sql;
  let web: Db;
  let accountId = "";
  const mediaId = fakeMediaId(950);

  /** 1 つのトランザクションの中でロールを切り替えてクエリを 1 回だけ流す */
  function asRole(role: "anon" | "authenticated", query: string): () => Promise<unknown> {
    return () =>
      admin.begin(async (tx) => {
        await tx.unsafe(`set local role ${role}`);
        return tx.unsafe(query);
      });
  }

  beforeAll(async () => {
    if (!isLocal(adminUrl) || !isLocal(webUrl)) throw new Error("結合テストはローカルの Supabase にだけ接続する");
    admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
    web = getDb(webUrl);
    accountId = await insertFakeAccount(admin, "fake_r5_web");
    await insertMedia(admin, { id: mediaId, accountId, postedAt: new Date(Date.now() - DAY_MS) });
  });

  afterAll(async () => {
    if (accountId !== "") await admin`delete from public.accounts where id = ${accountId}`;
    await closeAllDb();
    await admin.end({ timeout: 5 });
  });

  it("web_app は R5 の表とビューを読め、caption_hashtags を実行できる", async () => {
    for (const rel of ["tag_axes", "tag_values", "media_tags", "audience_captures", "audience_values", "media_hashtags", "story_list_metrics"]) {
      expect(await sqlstate(() => web`select * from ${web(`public.${rel}`)} limit 1`), rel).toBeUndefined();
    }
    const [row] = await web<{ tags: string[] }[]>`select array(select public.caption_hashtags('#Web')) as tags`;
    expect(row?.tags).toEqual(["web"]);
  });

  it("web_app は identity の列に insert でき、sequence の権限は持たない（D4、S13）", async () => {
    const [seq] = await admin<{ axes: boolean; values: boolean }[]>`
      select has_sequence_privilege('web_app', pg_get_serial_sequence('public.tag_axes', 'id'), 'usage') as axes,
             has_sequence_privilege('web_app', pg_get_serial_sequence('public.tag_values', 'id'), 'usage') as values
    `;
    expect(seq).toEqual({ axes: false, values: false });
    const [axis] = await web<{ id: string }[]>`
      insert into public.tag_axes (account_id, name) values (${accountId}, 'Web の軸') returning id::text as id
    `;
    expect(axis?.id).toMatch(/^\d+$/);
    // id を指定した insert は generated always で拒まれる
    expect(await sqlstate(() => web`insert into public.tag_axes (id, account_id, name) values (999999999, ${accountId}, '指定')`)).toBe("428C9");
  });

  it("web_app はタグを書け（insert、列の update、delete）、トリガーが updated_at を入れる", async () => {
    const [axis] = await web<{ id: string; updated_at: Date }[]>`
      insert into public.tag_axes (account_id, name) values (${accountId}, '書く軸') returning id::text as id, updated_at
    `;
    const axisId = axis?.id ?? "";
    const [v1] = await web<{ id: string }[]>`insert into public.tag_values (axis_id, name) values (${axisId}::bigint, '値1') returning id::text as id`;
    const [v2] = await web<{ id: string }[]>`insert into public.tag_values (axis_id, name) values (${axisId}::bigint, '値2') returning id::text as id`;
    await web`
      insert into public.media_tags (media_id, account_id, axis_id, value_id)
      values (${mediaId}, ${accountId}, ${axisId}::bigint, ${v1?.id ?? ""}::bigint)
    `;

    await new Promise((r) => setTimeout(r, 20));
    expect(await sqlstate(() => web`update public.tag_axes set name = '書く軸2', sort_order = 3 where id = ${axisId}::bigint`)).toBeUndefined();
    expect(await sqlstate(() => web`update public.tag_values set name = '値1b', sort_order = 2 where id = ${v1?.id ?? ""}::bigint`)).toBeUndefined();
    expect(
      await sqlstate(() => web`update public.media_tags set value_id = ${v2?.id ?? ""}::bigint where media_id = ${mediaId} and axis_id = ${axisId}::bigint`),
    ).toBeUndefined();
    const [after] = await admin<{ updated_at: Date }[]>`select updated_at from public.tag_axes where id = ${axisId}::bigint`;
    expect(after?.updated_at.getTime()).toBeGreaterThan(axis?.updated_at.getTime() ?? Infinity);

    expect(await sqlstate(() => web`delete from public.media_tags where media_id = ${mediaId} and axis_id = ${axisId}::bigint`)).toBeUndefined();
    expect(await sqlstate(() => web`delete from public.tag_values where id = ${v1?.id ?? ""}::bigint`)).toBeUndefined();
    expect(await sqlstate(() => web`delete from public.tag_axes where id = ${axisId}::bigint`)).toBeUndefined();
    const [left] = await admin<{ n: number }[]>`select count(*)::int as n from public.tag_values where axis_id = ${axisId}::bigint`;
    expect(left?.n).toBe(0);
  });

  it("web_app は列の grant の外の列（account_id、axis_id、updated_at など）を update できない（S5）", async () => {
    const axisId = await insertTagAxis(admin, { accountId, name: "列の権限" });
    const valueId = await insertTagValue(admin, { axisId, name: "値" });
    await insertMediaTag(admin, { mediaId, accountId, axisId, valueId });
    const denied = [
      () => web`update public.tag_axes set account_id = ${accountId} where id = ${axisId}::bigint`,
      () => web`update public.tag_axes set updated_at = now() where id = ${axisId}::bigint`,
      () => web`update public.tag_values set axis_id = ${axisId}::bigint where id = ${valueId}::bigint`,
      () => web`update public.tag_values set updated_at = now() where id = ${valueId}::bigint`,
      () => web`update public.media_tags set account_id = ${accountId} where media_id = ${mediaId}`,
      () => web`update public.media_tags set axis_id = ${axisId}::bigint where media_id = ${mediaId}`,
      () => web`update public.media_tags set media_id = ${mediaId} where media_id = ${mediaId}`,
      () => web`update public.media_tags set updated_at = now() where media_id = ${mediaId}`,
    ];
    for (const [i, run] of denied.entries()) expect(await sqlstate(run), `#${i}`).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("web_app は属性を書けない（insert、update、delete）", async () => {
    const captureId = await insertAudienceCapture(admin, { accountId, breakdown: "gender", weekStart: MONDAY, values: { F: 1 } });
    expect(
      await sqlstate(
        () => web`
          insert into public.audience_captures (account_id, metric, timeframe, breakdown, week_start, status, fetched_at)
          values (${accountId}, 'follower_demographics', 'this_month', 'age', ${MONDAY}, 'empty', now())
        `,
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(() => web`update public.audience_captures set status = 'empty' where id = ${captureId}::bigint`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(() => web`delete from public.audience_captures where id = ${captureId}::bigint`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(
      await sqlstate(() => web`insert into public.audience_values (capture_id, value_key, value) values (${captureId}::bigint, 'M', 1)`),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(() => web`update public.audience_values set value = 2 where capture_id = ${captureId}::bigint`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(() => web`delete from public.audience_values where capture_id = ${captureId}::bigint`)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("anon と authenticated は R5 の表とビューを読めず、caption_hashtags を実行できない", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      for (const rel of ["tag_axes", "tag_values", "media_tags", "audience_captures", "audience_values", "media_hashtags", "story_list_metrics"]) {
        expect(await sqlstate(asRole(role, `select * from public.${rel} limit 1`)), `${role} / ${rel}`).toBe(INSUFFICIENT_PRIVILEGE);
      }
      expect(await sqlstate(asRole(role, "select public.caption_hashtags('#x')"))).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it("タグの 3 表に web_app 向けのポリシーが 4 本ずつ、属性の 2 表に select が 1 本ずつある", async () => {
    const rows = await admin<{ tablename: string; cmd: string }[]>`
      select tablename, cmd from pg_policies
      where schemaname = 'public' and 'web_app' = any (roles)
        and tablename in ('tag_axes', 'tag_values', 'media_tags', 'audience_captures', 'audience_values')
      order by tablename, cmd
    `;
    const byTable = new Map<string, string[]>();
    for (const r of rows) byTable.set(r.tablename, [...(byTable.get(r.tablename) ?? []), r.cmd]);
    for (const t of ["tag_axes", "tag_values", "media_tags"]) expect(byTable.get(t), t).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
    for (const t of ["audience_captures", "audience_values"]) expect(byTable.get(t), t).toEqual(["SELECT"]);
  });
});
