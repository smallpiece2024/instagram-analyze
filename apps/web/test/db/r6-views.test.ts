/**
 * R6 のマイグレーション `20261013000000_r6_report.sql` の結合テスト（設計 `doc/design/r6-report.md` 3.1〜3.2 節、3.6 節、5 章、
 * 7.1 節の「DB（media_outlier_flags）」と「DB（report_notes）」）。
 * `TEST_DATABASE_URL`（postgres）があるときだけ動く。権限の節と性能の計測は `TEST_WEB_DATABASE_URL`（web_app）も要る。
 * どちらもローカル（127.0.0.1 か localhost）を指すときだけ動く。架空のアカウントを作り、`afterAll` で消す
 * （カスケードで関連行も消える）。手元の DB の本物の行は変えない。
 *
 * シェア率は shares ÷ reach。fixture の reach は 64（2 の冪）にして 1/64 の倍数の 2 進で正確な値にし、
 * 「ちょうど」の比較はビューが返す peer_upper／peer_lower と行う（D5）。
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllDb, getDb, type Db } from "../../src/lib/db";
import {
  DAY_MS,
  HOUR_MS,
  KIND_COLUMNS,
  fakeMediaId,
  insertFakeAccount,
  insertMedia,
  insertOutlierPeerSet,
  insertReportNote,
  insertSnapshot,
  postMetrics,
} from "./fixtures";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_WEB_DATABASE_URL = process.env.TEST_WEB_DATABASE_URL;

const INSUFFICIENT_PRIVILEGE = "42501";
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

/** ビューの 1 行。share_rate は numeric なので float8 に直して読む */
type FlagRow = {
  media_id: string;
  kind: string;
  share_rate: number | null;
  elapsed_latest: number | null;
  peer_n: number;
  peer_q1: number | null;
  peer_median: number | null;
  peer_q3: number | null;
  peer_iqr: number | null;
  peer_upper: number | null;
  peer_lower: number | null;
  share_flag: "high" | "low" | "none" | null;
};

async function readFlags(sql: postgres.Sql, accountId: string): Promise<Map<string, FlagRow>> {
  const rows = await sql<FlagRow[]>`
    select media_id, kind, share_rate::float8 as share_rate, elapsed_latest, peer_n,
           peer_q1, peer_median, peer_q3, peer_iqr, peer_upper, peer_lower, share_flag
    from public.media_outlier_flags
    where account_id = ${accountId}
    order by posted_at, media_id
  `;
  return new Map(rows.map((r) => [r.media_id, r]));
}

function must<T>(v: T | undefined, label: string): T {
  if (v === undefined) throw new Error(`row not found: ${label}`);
  return v;
}

describe.skipIf(!TEST_DATABASE_URL)("r6_report（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  let sql: postgres.Sql;
  const accounts: string[] = [];
  let seq = 100;
  const nextMediaId = (): string => fakeMediaId(seq++);
  /** 架空のアカウントを 1 つ作る（テストごとに分けて、比較対象が混ざらないようにする） */
  const newAccount = async (name: string): Promise<string> => {
    const id = await insertFakeAccount(sql, name);
    accounts.push(id);
    return id;
  };
  /** 投稿 1 件（と省略しなければスナップショット 1 件）を入れ、id を返す。reach は 64 が既定 */
  async function post(
    accountId: string,
    postedAt: Date,
    o: {
      shares?: number;
      reach?: number | null;
      /** false ならスナップショットを入れない */
      snapshot?: boolean;
      kind?: "feed" | "carousel" | "reel";
      productType?: "FEED" | "REELS" | "STORY";
      isCollab?: boolean | null;
      isTrialReel?: boolean | null;
      isBoosted?: boolean | null;
      goneAt?: Date | null;
    } = {},
  ): Promise<string> {
    const id = nextMediaId();
    const cols = KIND_COLUMNS[o.kind ?? "feed"];
    await insertMedia(sql, {
      id,
      accountId,
      postedAt,
      productType: o.productType ?? cols.productType,
      mediaType: cols.mediaType,
      isCollab: o.isCollab,
      isTrialReel: o.isTrialReel,
      isBoosted: o.isBoosted,
      goneAt: o.goneAt,
    });
    if (o.snapshot !== false) {
      await insertSnapshot(sql, {
        mediaId: id,
        postedAt,
        fetchedAt: new Date(postedAt.getTime() + 7 * DAY_MS),
        metrics: postMetrics({ reach: o.reach === undefined ? 64 : o.reach, shares: o.shares ?? 0 }),
      });
    }
    return id;
  }
  const daysAgo = (n: number): Date => new Date(Date.now() - n * DAY_MS);

  beforeAll(async () => {
    if (!isLocal(url)) throw new Error("結合テストはローカルの Supabase にだけ接続する");
    sql = postgres(url, { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    if (accounts.length > 0) await sql`delete from public.accounts where id in ${sql(accounts)}`;
    await sql.end({ timeout: 5 });
  });

  describe("マイグレーションの前提", () => {
    it("media_outlier_flags は security_invoker", async () => {
      const [row] = await sql<{ opts: string[] | null }[]>`
        select c.reloptions as opts from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'media_outlier_flags'
      `;
      expect(row?.opts ?? []).toContain("security_invoker=true");
    });

    it("report_notes の制約に名前が付いている（D9）。トリガーが set_updated_at を呼ぶ", async () => {
      const rows = await sql<{ conname: string; contype: string }[]>`
        select conname, contype from pg_constraint where conrelid = 'public.report_notes'::regclass order by conname
      `;
      expect(rows.map((r) => r.conname)).toEqual([
        "report_notes_account_id_fkey",
        "report_notes_month_is_first_day",
        "report_notes_next_plan_chars",
        "report_notes_next_plan_length",
        "report_notes_pkey",
        "report_notes_summary_chars",
        "report_notes_summary_length",
      ]);
      const [trg] = await sql<{ fn: string }[]>`
        select p.proname as fn from pg_trigger t join pg_proc p on p.oid = t.tgfoid
        where t.tgrelid = 'public.report_notes'::regclass and t.tgname = 'report_notes_set_updated_at'
      `;
      expect(trg?.fn).toBe("set_updated_at");
    });
  });

  describe("media_outlier_flags（3.1 節、3.2 節、3.6 節）", () => {
    it("(c) ストーリーズを除く全投稿が 1 行ずつ出る。スナップショットのない投稿も share_rate null で出る。自分自身は比較対象に含まない", async () => {
      const a = await newAccount("fake_r6_c");
      const withSnap = await post(a, daysAgo(3), { shares: 8 });
      const noSnap = await post(a, daysAgo(2), { snapshot: false });
      const story = await post(a, daysAgo(1), { productType: "STORY", shares: 1 });
      const flags = await readFlags(sql, a);
      expect([...flags.keys()].sort()).toEqual([withSnap, noSnap].sort());
      expect(flags.has(story)).toBe(false);
      const first = must(flags.get(withSnap), "withSnap");
      expect(first.kind).toBe("feed");
      expect(first.share_rate).toBe(0.125);
      expect(first.elapsed_latest).toBe(7 * 24 * 60 * 60);
      expect(first.peer_n).toBe(0); // 1 件目: 自分自身は含まないので 0
      expect(first.share_flag).toBeNull();
      expect(first.peer_q1).toBeNull();
      const second = must(flags.get(noSnap), "noSnap");
      expect(second.share_rate).toBeNull();
      expect(second.elapsed_latest).toBeNull();
      expect(second.peer_n).toBe(1);
      expect(second.share_flag).toBeNull();
    });

    it("IQR = 0: Q3 = 0 ならシェア 1 件で high（D4）。比較対象の側は 8 件未満で null、8 件以上で none", async () => {
      const a = await newAccount("fake_r6_iqr0");
      const { peerIds, outlierId } = await insertOutlierPeerSet(sql, { accountId: a, peerCount: 20, nextId: nextMediaId });
      const flags = await readFlags(sql, a);
      const o = must(flags.get(outlierId), "outlier");
      expect(o.share_rate).toBe(0.25);
      expect(o.peer_n).toBe(20);
      expect([o.peer_q1, o.peer_median, o.peer_q3, o.peer_iqr, o.peer_upper, o.peer_lower]).toEqual([0, 0, 0, 0, 0, 0]);
      expect(o.share_flag).toBe("high");
      for (const [i, id] of peerIds.entries()) {
        const p = must(flags.get(id), `peer ${i}`);
        expect(p.peer_n, `peer ${i}`).toBe(i);
        // シェア率 0 は upper = 0 を上回らず、lower = 0 を下回らない → none
        expect(p.share_flag, `peer ${i}`).toBe(i < 8 ? null : "none");
      }
    });

    it("全部同じ正の値なら fence = 中央値で、上回る 1 件だけ high。ちょうど（share_rate = peer_upper）は none（D5）", async () => {
      const a = await newAccount("fake_r6_same");
      const latest = daysAgo(2);
      const { peerIds, outlierId } = await insertOutlierPeerSet(sql, {
        accountId: a,
        peerCount: 10,
        peerShares: 8, // 1/8
        outlierShares: 16, // 1/4
        latestPostedAt: latest,
        nextId: nextMediaId,
      });
      // 外れ値の後に、比較対象と同じ 1/8 の投稿。比較対象は 10 件の 1/8 と 1 件の 1/4 → Q3 = 1/8、upper = 1/8 でちょうど
      const exact = await post(a, new Date(latest.getTime() + HOUR_MS), { shares: 8 });
      const flags = await readFlags(sql, a);
      const o = must(flags.get(outlierId), "outlier");
      expect(o.peer_n).toBe(10);
      expect([o.peer_q1, o.peer_median, o.peer_q3, o.peer_iqr, o.peer_upper, o.peer_lower]).toEqual([0.125, 0.125, 0.125, 0, 0.125, 0.125]);
      expect(o.share_flag).toBe("high");
      const e = must(flags.get(exact), "exact");
      expect(e.peer_n).toBe(11);
      expect(e.share_rate).toBe(e.peer_upper);
      expect(e.share_rate).toBe(e.peer_lower);
      expect(e.share_flag).toBe("none");
      // 比較対象の側（8 件以上）は全部同じ値で none
      for (const id of peerIds.slice(8)) expect(must(flags.get(id), id).share_flag).toBe("none");
    });

    it("境目: fence のちょうどは none、1/64 上回れば high、下回れば low。percentile_cont が補間する（偶数件の中央値、Q1、Q3）。特殊な投稿も自分の判定はされる", async () => {
      const a = await newAccount("fake_r6_fence");
      // 比較対象 8 件（1/64 単位: 32, 32, 36, 36, 40, 40, 44, 44）。
      // 位置 0.25 × 7 = 1.75 → Q1 = 32 + 0.75 × 4 = 35、位置 3.5 → 中央値 = (36 + 40) / 2 = 38、位置 5.25 → Q3 = 40 + 0.25 × 4 = 41
      // IQR = 6、1.5 × IQR = 9 → upper = 50、lower = 26（すべて 1/64 の倍数で 2 進で正確）
      const sharesList = [32, 32, 36, 36, 40, 40, 44, 44];
      for (const [i, shares] of sharesList.entries()) await post(a, daysAgo(20 - i), { shares });
      // 判定する投稿は is_boosted = true にして、互いの比較対象にならないようにする（同じ 8 件と比べる）
      const at = (h: number): Date => new Date(daysAgo(1).getTime() + h * HOUR_MS);
      const lowerExact = await post(a, at(0), { shares: 26, isBoosted: true });
      const below = await post(a, at(1), { shares: 25, isBoosted: true });
      const upperExact = await post(a, at(2), { shares: 50, isBoosted: true });
      const above = await post(a, at(3), { shares: 51, isBoosted: true });
      const flags = await readFlags(sql, a);
      for (const id of [lowerExact, below, upperExact, above]) {
        const r = must(flags.get(id), id);
        expect(r.peer_n, id).toBe(8);
        expect(r.peer_q1, id).toBe(35 / 64);
        expect(r.peer_median, id).toBe(38 / 64);
        expect(r.peer_q3, id).toBe(41 / 64);
        expect(r.peer_iqr, id).toBe(6 / 64);
        expect(r.peer_upper, id).toBe(50 / 64);
        expect(r.peer_lower, id).toBe(26 / 64);
      }
      expect(must(flags.get(lowerExact), "lowerExact").share_rate).toBe(must(flags.get(lowerExact), "lowerExact").peer_lower);
      expect(must(flags.get(lowerExact), "lowerExact").share_flag).toBe("none");
      expect(must(flags.get(below), "below").share_flag).toBe("low");
      expect(must(flags.get(upperExact), "upperExact").share_rate).toBe(must(flags.get(upperExact), "upperExact").peer_upper);
      expect(must(flags.get(upperExact), "upperExact").share_flag).toBe("none");
      expect(must(flags.get(above), "above").share_flag).toBe("high");
    });

    it("比較対象は直前 20 件で切れ、21 件目以降は入らない（Q2）", async () => {
      const a = await newAccount("fake_r6_window");
      // 古い 10 件はシェア率 1、新しい 20 件はシェア率 0。30 件が入れば Q3 = 1 で none になるが、直前 20 件なら Q3 = 0 で high
      const { outlierId } = await insertOutlierPeerSet(sql, {
        accountId: a,
        peerCount: 30,
        peerShares: (i) => (i < 10 ? 64 : 0),
        outlierShares: 1,
        nextId: nextMediaId,
      });
      const o = must((await readFlags(sql, a)).get(outlierId), "outlier");
      expect(o.peer_n).toBe(20);
      expect(o.peer_q3).toBe(0);
      expect(o.peer_upper).toBe(0);
      expect(o.share_flag).toBe("high");
    });

    it("同時刻の投稿は id の小さい方が比較対象に入り、大きい方は入らない（T3）。8 件目は 7 件で null、9 件目は 8 件で判定", async () => {
      const a = await newAccount("fake_r6_t3");
      const same = daysAgo(5);
      const ids: string[] = [];
      for (let i = 0; i < 9; i++) ids.push(await post(a, same, { shares: i === 8 ? 8 : 0 }));
      const flags = await readFlags(sql, a);
      for (const [i, id] of ids.entries()) expect(must(flags.get(id), `#${i}`).peer_n, `#${i}`).toBe(i);
      expect(must(flags.get(ids[7] ?? ""), "#7").share_flag).toBeNull();
      expect(must(flags.get(ids[8] ?? ""), "#8").share_flag).toBe("high");
    });

    it("(b) 除外される投稿は 20 件の枠を使わない。is_* = true とシェア率 null の投稿は比較対象から外れ、自分の判定はされる（T21: 自分の share_rate が null なら peer_n があっても null）", async () => {
      const a = await newAccount("fake_r6_excl");
      const normals: string[] = [];
      for (let i = 0; i < 20; i++) normals.push(await post(a, daysAgo(40 - i), { shares: 0 }));
      // 直前 25 件のうち 5 件が除外 → peer_n は 20（15 でも 25 でもない）
      const boosted = await post(a, daysAgo(10), { shares: 64, isBoosted: true });
      const collab = await post(a, daysAgo(9), { shares: 64, isCollab: true });
      const trial = await post(a, daysAgo(8), { shares: 64, isTrialReel: true });
      const zeroReach = await post(a, daysAgo(7), { shares: 3, reach: 0 });
      const noSnapshot = await post(a, daysAgo(6), { snapshot: false });
      const outlier = await post(a, daysAgo(5), { shares: 1 });
      const flags = await readFlags(sql, a);
      const o = must(flags.get(outlier), "outlier");
      expect(o.peer_n).toBe(20);
      expect(o.peer_q3).toBe(0);
      expect(o.share_flag).toBe("high");
      // 特殊な投稿の自分の判定（比較対象は 20 件の 0）
      for (const id of [boosted, collab, trial]) {
        const r = must(flags.get(id), id);
        expect(r.peer_n, id).toBe(20);
        expect(r.share_rate, id).toBe(1);
        expect(r.share_flag, id).toBe("high");
      }
      // シェア率 null の投稿は peer_n があっても判定しない
      for (const id of [zeroReach, noSnapshot]) {
        const r = must(flags.get(id), id);
        expect(r.share_rate, id).toBeNull();
        expect(r.peer_n, id).toBe(20);
        expect(r.share_flag, id).toBeNull();
      }
      expect(normals.every((id) => flags.has(id))).toBe(true);
    });

    it("(a) 特殊フラグが null の投稿は比較対象に入る（D1）。false も入る", async () => {
      const a = await newAccount("fake_r6_null");
      const peers: string[] = [];
      for (let i = 0; i < 8; i++) {
        const explicit = i < 4 ? { isCollab: null, isTrialReel: null, isBoosted: null } : { isCollab: false, isTrialReel: false, isBoosted: false };
        peers.push(await post(a, daysAgo(20 - i), { shares: 0, ...explicit }));
      }
      const outlier = await post(a, daysAgo(1), { shares: 1 });
      const [nulls] = await sql<{ n: number }[]>`
        select count(*)::int as n from public.media
        where account_id = ${a} and is_collab is null and is_trial_reel is null and is_boosted is null
      `;
      expect(nulls?.n).toBe(5); // null の 4 件 + 外れ値（省略 → null）
      const o = must((await readFlags(sql, a)).get(outlier), "outlier");
      expect(o.peer_n).toBe(8);
      expect(o.share_flag).toBe("high");
      expect(peers).toHaveLength(8);
    });

    it("同じ kind だけが比較対象（feed、carousel、reel）", async () => {
      const a = await newAccount("fake_r6_kind");
      for (let i = 0; i < 8; i++) {
        await post(a, daysAgo(30 - i), { shares: 0, kind: "feed" });
        await post(a, daysAgo(30 - i), { shares: 0, kind: "carousel" });
      }
      const feed = await post(a, daysAgo(3), { shares: 8, kind: "feed" });
      const carousel = await post(a, daysAgo(2), { shares: 8, kind: "carousel" });
      const reel = await post(a, daysAgo(1), { shares: 8, kind: "reel" });
      const flags = await readFlags(sql, a);
      expect(must(flags.get(feed), "feed")).toMatchObject({ kind: "feed", peer_n: 8, share_flag: "high" });
      expect(must(flags.get(carousel), "carousel")).toMatchObject({ kind: "carousel", peer_n: 8, share_flag: "high" });
      expect(must(flags.get(reel), "reel")).toMatchObject({ kind: "reel", peer_n: 0, share_flag: null });
    });

    it("別のアカウントの投稿は比較対象に入らない", async () => {
      const a = await newAccount("fake_r6_acc_a");
      const b = await newAccount("fake_r6_acc_b");
      for (let i = 0; i < 8; i++) await post(a, daysAgo(20 - i), { shares: 0 });
      const own = await post(b, daysAgo(1), { shares: 8 });
      const o = must((await readFlags(sql, b)).get(own), "own");
      expect(o.peer_n).toBe(0);
      expect(o.share_flag).toBeNull();
      expect((await readFlags(sql, a)).size).toBe(8);
    });

    it("消えた投稿（gone_at）は比較対象に入る", async () => {
      const a = await newAccount("fake_r6_gone");
      for (let i = 0; i < 8; i++) await post(a, daysAgo(20 - i), { shares: 0, goneAt: daysAgo(10 - i) });
      const outlier = await post(a, daysAgo(1), { shares: 1 });
      const o = must((await readFlags(sql, a)).get(outlier), "outlier");
      expect(o.peer_n).toBe(8);
      expect(o.share_flag).toBe("high");
    });

    it("(d) 全行で share_flag と peer_upper／peer_lower が整合する（high は >、low は <、none はその間、null は share_rate null か 8 件未満）", async () => {
      const [row] = await sql<{ total: number; judged: number; bad: number }[]>`
        select count(*)::int as total,
               count(*) filter (where share_flag is not null)::int as judged,
               count(*) filter (where not (
                 case share_flag
                   when 'high' then share_rate > peer_upper
                   when 'low'  then share_rate < peer_lower
                   when 'none' then share_rate >= peer_lower and share_rate <= peer_upper
                   else share_rate is null or peer_n < 8
                 end
               ))::int as bad
        from public.media_outlier_flags
        where account_id in ${sql(accounts)}
      `;
      expect(row?.total ?? 0).toBeGreaterThan(50);
      expect(row?.judged ?? 0).toBeGreaterThan(20);
      expect(row?.bad).toBe(0);
    });

    it("(e) 全行で share_rate が media_list_metrics と一致し、行数も同じ（回帰）", async () => {
      const [row] = await sql<{ only_flags: number; only_list: number; mismatch: number; total: number }[]>`
        select count(*) filter (where l.media_id is null)::int as only_flags,
               count(*) filter (where f.media_id is null)::int as only_list,
               count(*) filter (where f.share_rate is distinct from l.share_rate)::int as mismatch,
               count(*)::int as total
        from public.media_outlier_flags f
        full join public.media_list_metrics l on l.media_id = f.media_id
        where coalesce(f.account_id, l.account_id) in ${sql(accounts)}
      `;
      expect(row?.total ?? 0).toBeGreaterThan(50);
      expect(row?.only_flags).toBe(0);
      expect(row?.only_list).toBe(0);
      expect(row?.mismatch).toBe(0);
    });
  });

  describe("report_notes（5.1 節）", () => {
    let a = "";
    beforeAll(async () => {
      a = await newAccount("fake_r6_notes");
    });

    it("report_month は月の 1 日だけ（2 日は拒む。D8）", async () => {
      expect(await sqlstate(() => insertReportNote(sql, { accountId: a, reportMonth: "2026-09-02" }))).toBe(CHECK_VIOLATION);
      expect(await sqlstate(() => insertReportNote(sql, { accountId: a, reportMonth: "2026-09-01" }))).toBeUndefined();
    });

    it("2,001 コードポイント（絵文字を含む）は拒み、2,000 は通る（Q13。char_length はコードポイント）", async () => {
      const over = "あ".repeat(1999) + "😀😀";
      const max = "あ".repeat(1998) + "😀😀";
      expect([...over].length).toBe(2001);
      expect([...max].length).toBe(2000);
      expect(await sqlstate(() => insertReportNote(sql, { accountId: a, reportMonth: "2026-01-01", summary: over }))).toBe(CHECK_VIOLATION);
      expect(await sqlstate(() => insertReportNote(sql, { accountId: a, reportMonth: "2026-01-01", nextPlan: over }))).toBe(CHECK_VIOLATION);
      expect(await sqlstate(() => insertReportNote(sql, { accountId: a, reportMonth: "2026-01-01", summary: max, nextPlan: max }))).toBeUndefined();
    });

    it("改行（LF）は通り、CR、タブ、ほかの制御文字は拒む（D7）", async () => {
      expect(await sqlstate(() => insertReportNote(sql, { accountId: a, reportMonth: "2026-02-01", summary: "1 行目\n2 行目\n", nextPlan: "\n" }))).toBeUndefined();
      const rejected = ["a\rb", "a\r\nb", "a\tb", "a\u0007b", "a\u001bb", "a\u007fb"];
      for (const [i, s] of rejected.entries()) {
        expect(await sqlstate(() => insertReportNote(sql, { accountId: a, reportMonth: "2026-03-01", summary: s })), `summary #${i}`).toBe(CHECK_VIOLATION);
        expect(await sqlstate(() => insertReportNote(sql, { accountId: a, reportMonth: "2026-03-01", nextPlan: s })), `next_plan #${i}`).toBe(CHECK_VIOLATION);
      }
    });

    it("日本語、ZWJ でつないだ絵文字、U+2028 が通る", async () => {
      const text = "総評。家族の絵文字 👨‍👩‍👧 と行区切り の文字";
      expect(await sqlstate(() => insertReportNote(sql, { accountId: a, reportMonth: "2026-04-01", summary: text, nextPlan: text }))).toBeUndefined();
      const [row] = await sql<{ summary: string }[]>`select summary from public.report_notes where account_id = ${a} and report_month = '2026-04-01'`;
      expect(row?.summary).toBe(text);
    });

    it("トリガーが updated_at を入れる。accounts を消すと消える", async () => {
      const b = await newAccount("fake_r6_notes_cascade");
      const before = await insertReportNote(sql, { accountId: b, reportMonth: "2026-05-01", summary: "前" });
      await new Promise((r) => setTimeout(r, 20));
      await sql`update public.report_notes set summary = '後' where account_id = ${b} and report_month = '2026-05-01'`;
      const [after] = await sql<{ updated_at: Date }[]>`select updated_at from public.report_notes where account_id = ${b} and report_month = '2026-05-01'`;
      expect(after?.updated_at.getTime()).toBeGreaterThan(before.getTime());
      await sql`delete from public.accounts where id = ${b}`;
      accounts.splice(accounts.indexOf(b), 1);
      const [left] = await sql<{ n: number }[]>`select count(*)::int as n from public.report_notes where account_id = ${b}`;
      expect(left?.n).toBe(0);
    });
  });
});

describe.skipIf(!TEST_DATABASE_URL || !TEST_WEB_DATABASE_URL)("r6_report の権限と性能（web_app。結合）", () => {
  const adminUrl = TEST_DATABASE_URL ?? "";
  const webUrl = TEST_WEB_DATABASE_URL ?? "";
  let admin: postgres.Sql;
  let web: Db;
  const accounts: string[] = [];
  let accountId = "";
  const MONTH = "2026-09-01";

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
    accountId = await insertFakeAccount(admin, "fake_r6_web");
    accounts.push(accountId);
  });

  afterAll(async () => {
    if (accounts.length > 0) await admin`delete from public.accounts where id in ${admin(accounts)}`;
    await closeAllDb();
    await admin.end({ timeout: 5 });
  });

  it("web_app は media_outlier_flags と report_notes を読める", async () => {
    for (const rel of ["media_outlier_flags", "report_notes"]) {
      expect(await sqlstate(() => web`select * from ${web(`public.${rel}`)} limit 1`), rel).toBeUndefined();
    }
  });

  it("anon と authenticated は media_outlier_flags と report_notes を読めない (f)", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      for (const rel of ["media_outlier_flags", "report_notes"]) {
        expect(await sqlstate(asRole(role, `select * from public.${rel} limit 1`)), `${role} / ${rel}`).toBe(INSUFFICIENT_PRIVILEGE);
      }
    }
  });

  it("report_notes に web_app 向けのポリシーが select、insert、update の 3 本（delete はない）", async () => {
    const rows = await admin<{ cmd: string }[]>`
      select cmd from pg_policies where schemaname = 'public' and tablename = 'report_notes' and 'web_app' = any (roles) order by cmd
    `;
    expect(rows.map((r) => r.cmd)).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });

  it("web_app は report_notes を insert（4 列）、update（summary、next_plan）でき、トリガーが updated_at を入れる", async () => {
    const [ins] = await web<{ updated_at: Date }[]>`
      insert into public.report_notes (account_id, report_month, summary, next_plan)
      values (${accountId}, ${MONTH}, '総評', '施策') returning updated_at
    `;
    expect(ins?.updated_at).toBeInstanceOf(Date);
    await new Promise((r) => setTimeout(r, 20));
    expect(
      await sqlstate(() => web`update public.report_notes set summary = '総評2', next_plan = '' where account_id = ${accountId} and report_month = ${MONTH}`),
    ).toBeUndefined();
    const [after] = await web<{ summary: string; next_plan: string; updated_at: Date }[]>`
      select summary, next_plan, updated_at from public.report_notes where account_id = ${accountId} and report_month = ${MONTH}
    `;
    expect(after?.summary).toBe("総評2");
    expect(after?.next_plan).toBe("");
    expect(after?.updated_at.getTime()).toBeGreaterThan(ins?.updated_at.getTime() ?? Infinity);
  });

  it("updated_at を含む insert は拒まれる（S7）。report_month、account_id、updated_at は update できず、delete できない", async () => {
    expect(
      await sqlstate(
        () => web`
          insert into public.report_notes (account_id, report_month, summary, next_plan, updated_at)
          values (${accountId}, '2026-08-01', '', '', now())
        `,
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    const denied = [
      () => web`update public.report_notes set report_month = '2026-07-01' where account_id = ${accountId} and report_month = ${MONTH}`,
      () => web`update public.report_notes set account_id = ${accountId} where account_id = ${accountId} and report_month = ${MONTH}`,
      () => web`update public.report_notes set updated_at = now() where account_id = ${accountId} and report_month = ${MONTH}`,
      () => web`delete from public.report_notes where account_id = ${accountId} and report_month = ${MONTH}`,
    ];
    for (const [i, run] of denied.entries()) expect(await sqlstate(run), `#${i}`).toBe(INSUFFICIENT_PRIVILEGE);
    const [row] = await admin<{ n: number }[]>`select count(*)::int as n from public.report_notes where account_id = ${accountId}`;
    expect(row?.n).toBe(1);
  });

  it("upsert（on conflict do update）が列指定の権限で通り、同じ値で 2 回 upsert しても 1 行のままで updated_at が進む（D13 (h)）", async () => {
    const month = "2026-06-01";
    const upsert = () => web<{ updated_at: Date }[]>`
      insert into public.report_notes (account_id, report_month, summary, next_plan)
      values (${accountId}, ${month}, '同じ総評', '同じ施策')
      on conflict (account_id, report_month) do update set summary = excluded.summary, next_plan = excluded.next_plan
      returning updated_at
    `;
    const [first] = await upsert();
    await new Promise((r) => setTimeout(r, 20));
    const [second] = await upsert();
    expect(second?.updated_at.getTime()).toBeGreaterThan(first?.updated_at.getTime() ?? Infinity);
    const [row] = await admin<{ n: number }[]>`select count(*)::int as n from public.report_notes where account_id = ${accountId} and report_month = ${month}`;
    expect(row?.n).toBe(1);
  });

  it("(i) 300 件の投稿で explain (analyze, buffers) を取り、計画の形と時間を記録する（D3。時間は assert しない）", async () => {
    const perf = await insertFakeAccount(admin, "fake_r6_perf");
    accounts.push(perf);
    expect(perf).toMatch(/^[0-9a-f-]{36}$/);
    let perfSeq = 0;
    await insertOutlierPeerSet(admin, {
      accountId: perf,
      peerCount: 299,
      nextId: () => fakeMediaId(perfSeq++),
      stepMs: 6 * HOUR_MS,
      peerShares: (i) => i % 16,
    });
    const [count] = await admin<{ n: number }[]>`select count(*)::int as n from public.media where account_id = ${perf}`;
    expect(count?.n).toBe(300);
    // 投入直後は統計が古く（media の見積もりが数十行のまま）、計画が実運用と違う形（ビューを外側の行数ぶん再実行する nested loop）になる。
    // 本番では autovacuum が行うことを先に行い、統計がそろった状態で測る
    await admin`analyze public.media, public.media_insight_snapshots`;

    const explain = async (label: string, query: string): Promise<string> => {
      const rows = (await web.unsafe(`explain (analyze, buffers) ${query}`)) as { "QUERY PLAN": string }[];
      const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");
      const time = /Execution Time: ([\d.]+) ms/.exec(plan)?.[1] ?? "?";
      // 3.2 節の 6 点: 基（CTE base）が 1 回、lateral の loops、最新スナップショットの索引、limit 20 の見積もりと実際、時間
      const summary = {
        label,
        execution_ms: Number(time),
        cte_definitions: (plan.match(/^\s*CTE base$/gm) ?? []).length,
        cte_scans: (plan.match(/CTE Scan on base/g) ?? []).length,
        materialize_nodes: (plan.match(/->\s+Materialize/g) ?? []).length,
        snapshot_index_backward: /Index Scan Backward using media_insight_snapshots_media_id_fetched_at_key/.test(plan),
        limit_nodes: plan.split("\n").filter((l) => /^\s*(->\s+)?Limit\s+\(cost/.test(l)).map((l) => l.trim()),
        lateral_loops: [...plan.matchAll(/CTE Scan on base s[^\n]*loops=(\d+)/g)].map((m) => Number(m[1])),
        join_nodes: plan.split("\n").filter((l) => /(Hash|Merge|Nested Loop)[^\n]*Join/.test(l)).map((l) => l.trim()),
      };
      console.log(`[r6 explain] ${JSON.stringify(summary, null, 1)}`);
      if (process.env.R6_EXPLAIN_VERBOSE) console.log(plan);
      return plan;
    };

    const viewPlan = await explain("media_outlier_flags where account_id", `select * from public.media_outlier_flags where account_id = '${perf}'`);
    expect(viewPlan).toContain("Execution Time");

    // /media 一覧の SQL（lib/queries/media.ts の listMedia）。left join public.media_outlier_flags を足した形（3.3 節）と、足す前の基準
    const listSql = (join: boolean): string => `
      with r as (
        select
          m.media_id, m.kind, m.posted_at,
          (extract(epoch from (now() - m.posted_at)) / 3600)::float8 as elapsed_hours,
          m.caption, m.thumbnail_path, m.is_collab, m.is_trial_reel, m.is_boosted, m.gone_at,
          m.reach::float8 as reach, m.views::float8 as views, m.likes::float8 as likes,
          m.comments::float8 as comments, m.saved::float8 as saved, m.shares::float8 as shares,
          m.profile_visits::float8 as profile_visits, m.followers_at_post::float8 as followers_at_post,
          m.save_rate::float8 as save_rate, m.share_rate::float8 as share_rate,
          m.er::float8 as er,
          coalesce(m.posted_date_pt < (
            select min(d.available_from) from public.metric_definitions d where d.metric = 'views'
          ), false) as views_before_change
          ${join ? ", f.share_flag, f.peer_n" : ""}
        from public.media_list_metrics m
        ${join ? "left join public.media_outlier_flags f on f.media_id = m.media_id and f.account_id = m.account_id" : ""}
        where m.account_id = '${perf}'
      )
      select * from r
      order by posted_at desc nulls last, posted_at desc, media_id desc
      limit 20 offset 0
    `;
    const basePlan = await explain("/media list（結合なし。基準）", listSql(false));
    expect(basePlan).toContain("Execution Time");
    const listPlan = await explain("/media list + left join media_outlier_flags", listSql(true));
    expect(listPlan).toContain("Execution Time");
  }, 120_000);
});
