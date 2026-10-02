/**
 * `queries/*` の結合テスト（設計 4.3 章）。`TEST_DATABASE_URL` があるときだけ動く。
 * 架空のアカウント 2 件（ig_user_id の先頭 6 桁が 0。1 件は認証情報つき、1 件は name も認証情報もなし）、
 * 実行記録、投稿 52 件（うち 1 件はストーリーズ）、スナップショットを作り、`afterAll` でアカウントを消す
 * （カスケードで関連行と Vault の秘密も消える）。
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllDb } from "@/lib/db";
import { PAGE_SIZE } from "@/lib/format";
import { getConnectionStatus } from "@/lib/queries/connection-status";
import { getLatestRuns, listRecentRuns, RECENT_RUNS_LIMIT } from "@/lib/queries/jobs";
import { getMediaPage, listMedia } from "@/lib/queries/media";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
/** ページング確認用の投稿数（1 ページ分 + 1） */
const FEED_COUNT = PAGE_SIZE + 1;

/** 架空の Instagram アカウント ID（実在しない。先頭 6 桁が 0） */
function fakeIgUserId(): string {
  return "000000" + Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, "0");
}

/** 架空のメディア ID（数字だけ。先頭 4 桁が 0、`seq` は 3 桁で末尾） */
function fakeMediaId(seq: number): string {
  return "0000" + Date.now().toString() + seq.toString().padStart(3, "0");
}

describe.skipIf(!TEST_DATABASE_URL)("queries（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  const igUserId = fakeIgUserId();
  const igUserId2 = fakeIgUserId();
  const now = new Date();
  /** 投稿日時の新しい順に並ぶよう、seq が小さいほど新しい（seq 0 が最新。実アカウントの投稿より新しい） */
  const feedIds = Array.from({ length: FEED_COUNT }, (_, seq) => fakeMediaId(seq));
  const storyId = fakeMediaId(900);
  const t0 = new Date(now.getTime() - 6 * HOUR_MS);
  const mediaSyncFinished = new Date(t0.getTime() + 1 * HOUR_MS);
  const tokenCheckFinished = new Date(t0.getTime() + 2 * HOUR_MS);
  const storiesStarted = new Date(t0.getTime() + 2 * HOUR_MS + 30 * MINUTE_MS);
  const storiesFinished = new Date(t0.getTime() + 2 * HOUR_MS + 31 * MINUTE_MS);
  const runningStarted = new Date(t0.getTime() + 3 * HOUR_MS);
  const partialStarted = new Date(t0.getTime() + 3 * HOUR_MS + 30 * MINUTE_MS);
  const partialFinished = new Date(t0.getTime() + 3 * HOUR_MS + 31 * MINUTE_MS);
  const rateUsage = { call_count: 1, total_cputime: 2, total_time: 3, estimated_time_to_regain_access: 12 };
  let sql: postgres.Sql;
  let accountId = "";
  let accountId2 = "";
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    // readEnv が読む変数。DB 以外は架空の値（Meta には繋がない。Storage は thumbnail_path が null なので呼ばれない）
    const env: Record<string, string> = {
      DATABASE_URL: url,
      META_APP_ID: "1",
      META_APP_SECRET: "test-secret",
      META_GRAPH_API_VERSION: "v25.0",
      APP_URL: "http://localhost:3000",
    };
    for (const [k, v] of Object.entries(env)) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
    savedEnv.META_TARGET_IG_USER_ID = process.env.META_TARGET_IG_USER_ID;
    delete process.env.META_TARGET_IG_USER_ID;

    sql = postgres(url, { max: 1, onnotice: () => {} });
    const [account] = await sql<{ id: string }[]>`
      insert into public.accounts (ig_user_id, username, name)
      values (${igUserId}, 'fake_web_user', 'Fake Web')
      returning id
    `;
    accountId = account?.id ?? "";
    expect(accountId).not.toBe("");
    const [account2] = await sql<{ id: string }[]>`
      insert into public.accounts (ig_user_id, username, name)
      values (${igUserId2}, 'fake_web_user_2', null)
      returning id
    `;
    accountId2 = account2?.id ?? "";
    expect(accountId2).not.toBe("");

    const [secret] = await sql<{ id: string }[]>`
      select vault.create_secret('fake-token', ${`ig-token-${accountId}`}, 'test') as id
    `;
    await sql`
      insert into private.credentials
        (account_id, token_type, token_secret_id, expires_at, data_access_expires_at, scopes, status, last_checked_at)
      values
        (${accountId}, 'PAGE', ${secret?.id ?? ""}, null, ${new Date(now.getTime() + 90 * DAY_MS)},
         ${sql.array(["instagram_basic", "instagram_manage_insights"])}, 'valid', now())
    `;
    // media_sync の成功より後に token_check の成功、stories の失敗、media_snapshot の実行中を置く
    await sql`
      insert into public.job_runs (job_name, account_id, started_at, finished_at, status, items_fetched, api_calls, error, rate_usage)
      values
        ('media_sync', ${accountId}, ${t0}, ${mediaSyncFinished}, 'success', 3, 2, null, ${sql.json(rateUsage)}),
        ('token_check', ${accountId}, ${t0}, ${tokenCheckFinished}, 'success', 0, 1, null, null),
        ('stories', ${accountId}, ${storiesStarted}, ${storiesFinished}, 'failed', 0, 1, 'テスト用の失敗', null),
        ('media_snapshot', ${accountId}, ${runningStarted}, null, 'running', null, null, null, null)
    `;
    const feedRows = feedIds.map((id, seq) => ({
      id,
      account_id: accountId,
      media_type: "IMAGE",
      media_product_type: "FEED",
      posted_at: new Date(now.getTime() - seq * MINUTE_MS),
      permalink: "https://www.instagram.com/p/fake/",
    }));
    await sql`insert into public.media ${sql(feedRows, "id", "account_id", "media_type", "media_product_type", "posted_at", "permalink")}`;
    await sql`
      insert into public.media (id, account_id, media_type, media_product_type, posted_at, permalink)
      values (${storyId}, ${accountId}, 'VIDEO', 'STORY', ${new Date(now.getTime() + MINUTE_MS)}, null)
    `;
    await sql`
      insert into public.media_insight_snapshots (media_id, fetched_at, elapsed_seconds, metrics)
      values (${feedIds[0] ?? ""}, now(), 3600, ${sql.json({ views: 10, reach: null })})
    `;
  });

  afterAll(async () => {
    for (const id of [accountId, accountId2]) {
      if (id === "") continue;
      await sql`delete from public.accounts where id = ${id}`;
      const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from vault.secrets where name = ${`ig-token-${id}`}
      `;
      expect(row?.n).toBe(0);
    }
    await closeAllDb();
    await sql.end({ timeout: 5 });
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("getConnectionStatus: accounts.name を補い、最終収集は token_check と失敗・実行中を除く。partial は含む", async () => {
    const result = await getConnectionStatus();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const s = result.data.find((r) => r.account_id === accountId);
    expect(s).toBeDefined();
    if (!s) return;
    expect(s.username).toBe("fake_web_user");
    expect(s.name).toBe("Fake Web");
    expect(s.account_status).toBe("active");
    expect(s.token_type).toBe("PAGE");
    expect(s.token_expires_at).toBeNull();
    expect(s.data_access_expires_at).toBeInstanceOf(Date);
    expect(s.scopes).toEqual(["instagram_basic", "instagram_manage_insights"]);
    expect(s.credential_status).toBe("valid");
    expect(s.last_checked_at).toBeInstanceOf(Date);
    expect(s.last_error).toBeNull();
    // token_check（後の成功）、stories（後の失敗）、media_snapshot（実行中）があっても media_sync の時刻
    expect(s.last_collected_at?.getTime()).toBe(mediaSyncFinished.getTime());

    // name も認証情報もないアカウント
    const s2 = result.data.find((r) => r.account_id === accountId2);
    expect(s2).toBeDefined();
    if (!s2) return;
    expect(s2.username).toBe("fake_web_user_2");
    expect(s2.name).toBeNull();
    expect(s2.token_type).toBeNull();
    expect(s2.scopes).toBeNull();
    expect(s2.credential_status).toBeNull();
    expect(s2.last_collected_at).toBeNull();

    // partial を最後に入れると最終収集に含まれる
    await sql`
      insert into public.job_runs (job_name, account_id, started_at, finished_at, status, items_fetched, api_calls, error)
      values ('account_backfill', ${accountId}, ${partialStarted}, ${partialFinished}, 'partial', 5, 6, '一部失敗')
    `;
    const after = await getConnectionStatus();
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.data.find((r) => r.account_id === accountId)?.last_collected_at?.getTime()).toBe(partialFinished.getTime());
  });

  it("getLatestRuns: 実行順に並び、数値と JSON の型が合う", async () => {
    const result = await getLatestRuns();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mine = result.data.filter((r) => r.account_id === accountId);
    expect(mine.map((r) => r.job_name)).toEqual(["token_check", "media_sync", "media_snapshot", "stories", "account_backfill"]);
    const mediaSync = mine[1];
    expect(typeof mediaSync?.id).toBe("string");
    expect(mediaSync?.username).toBe("fake_web_user");
    expect(mediaSync?.items_fetched).toBe(3);
    expect(mediaSync?.api_calls).toBe(2);
    expect(mediaSync?.rate_usage).toEqual(rateUsage);
    expect(mediaSync?.started_at).toBeInstanceOf(Date);
    expect(mediaSync?.finished_at?.getTime()).toBe(mediaSyncFinished.getTime());
    const running = mine[2];
    expect(running?.status).toBe("running");
    expect(running?.finished_at).toBeNull();
    expect(running?.items_fetched).toBeNull();
    expect(mine[3]?.error).toBe("テスト用の失敗");
    expect(mine[3]?.rate_usage).toBeNull();
    expect(mine[4]?.status).toBe("partial");
  });

  it("listRecentRuns: 絞り込みと上限", async () => {
    const stories = await listRecentRuns("stories");
    expect(stories.ok).toBe(true);
    if (!stories.ok) return;
    expect(stories.data.every((r) => r.job_name === "stories")).toBe(true);
    expect(stories.data.some((r) => r.account_id === accountId)).toBe(true);

    const all = await listRecentRuns();
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.data.length).toBeLessThanOrEqual(RECENT_RUNS_LIMIT);
    expect(all.data.some((r) => r.account_id === accountId && r.job_name === "media_sync")).toBe(true);
    // 新しい順
    for (let i = 1; i < all.data.length; i += 1) {
      const prev = all.data[i - 1];
      const cur = all.data[i];
      if (prev && cur) expect(prev.started_at.getTime()).toBeGreaterThanOrEqual(cur.started_at.getTime());
    }
  });

  it("listMedia と getMediaPage: ストーリーズを除き、最新のスナップショットを付け、51 件で次ページがある", async () => {
    const page1 = await listMedia(1);
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;
    expect(page1.data.page).toBe(1);
    expect(page1.data.items).toHaveLength(PAGE_SIZE);
    expect(page1.data.hasNext).toBe(true);
    // 架空の投稿は実アカウントの投稿より新しいので、1 ページ目の先頭 50 件がそのまま並ぶ
    expect(page1.data.items.map((m) => m.id)).toEqual(feedIds.slice(0, PAGE_SIZE));
    expect(page1.data.items.find((m) => m.id === storyId)).toBeUndefined();
    expect(page1.data.items.every((m) => m.media_product_type !== "STORY")).toBe(true);

    const newest = page1.data.items[0];
    expect(newest?.id).toBe(feedIds[0]);
    expect(newest?.media_product_type).toBe("FEED");
    expect(newest?.posted_at).toBeInstanceOf(Date);
    expect(newest?.metrics_fetched_at).toBeInstanceOf(Date);
    expect(newest?.elapsed_seconds).toBe(3600);
    expect(newest?.metrics).toEqual({ views: 10, reach: null });
    expect(newest?.thumbnail_path).toBeNull();
    expect(newest?.gone_at).toBeNull();
    expect(newest !== undefined && "caption" in newest).toBe(false);
    // スナップショットのない投稿
    const second = page1.data.items[1];
    expect(second?.metrics).toBeNull();
    expect(second?.metrics_fetched_at).toBeNull();
    expect(second?.elapsed_seconds).toBeNull();

    const page2 = await listMedia(2);
    expect(page2.ok).toBe(true);
    if (!page2.ok) return;
    expect(page2.data.page).toBe(2);
    expect(page2.data.items[0]?.id).toBe(feedIds[PAGE_SIZE]);
    expect(page2.data.items.find((m) => m.id === storyId)).toBeUndefined();

    const withThumbs = await getMediaPage(1);
    expect(withThumbs.ok).toBe(true);
    if (!withThumbs.ok) return;
    expect(withThumbs.data.hasNext).toBe(true);
    expect(withThumbs.data.items.find((m) => m.id === feedIds[0])?.thumbnail_url).toBeNull();

    const far = await listMedia(100_000);
    expect(far.ok).toBe(true);
    if (!far.ok) return;
    expect(far.data.items).toEqual([]);
    expect(far.data.hasNext).toBe(false);
  });

  it("設定が足りなければ変数名だけの固定文言", async () => {
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "";
    try {
      const result = await getConnectionStatus();
      expect(result).toEqual({ ok: false, reason: "設定が足りません（DATABASE_URL）" });
    } finally {
      process.env.DATABASE_URL = saved;
    }
  });

  it("DB に繋がらなければ固定文言（接続先を含まない）", async () => {
    const saved = process.env.DATABASE_URL;
    const bad = "postgresql://postgres:postgres@127.0.0.1:1/postgres";
    process.env.DATABASE_URL = bad;
    try {
      const result = await getLatestRuns();
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toMatch(/^DB 接続に失敗（[A-Z_]+）$/);
      expect(result.reason).not.toContain("127.0.0.1");
      expect(result.reason).not.toContain("postgres");
    } finally {
      process.env.DATABASE_URL = saved;
    }
  });
});
