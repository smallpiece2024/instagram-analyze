/**
 * `db/snapshots.ts` と `jobs/media-snapshot.ts` の結合テスト（設計 9.2 章の `db/snapshots.ts`、「各ジョブの書き込み経路」の行）。
 * 偽の `fetch` と本物の DB（ローカル Supabase）で `runJob(job)` を動かす。
 * 架空のアカウントを作り、終了時に消す（CASCADE で media、スナップショット、job_runs、raw_api_responses も消える）。
 * `media` の行はテスト内で直接 insert する（`db/media.ts` は別の担当）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WorkerConfig } from "../../src/config.js";
import { upsertAccount, upsertCredential, type CredentialInfo } from "../../src/db/accounts.js";
import { closeDb, connectDb, jsonb, type Db } from "../../src/db/client.js";
import { countSnapshots, insertSnapshot, listSnapshotCandidates } from "../../src/db/snapshots.js";
import type {
  AccountRow,
  JobRunRow,
  MediaInsightSnapshotRow,
  MediaProductType,
  MediaType,
  RawApiResponseRow,
} from "../../src/db/types.js";
import { runJob, type JobDeps } from "../../src/jobs/framework.js";
import { isSnapshotDue, job } from "../../src/jobs/media-snapshot.js";
import type { GraphError } from "../../src/lib/graph.js";
import { createLogger, SecretRegistry } from "../../src/lib/log.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 架空の Instagram アカウント ID（実在しない。先頭 6 桁が 0） */
function fakeIgUserId(): string {
  return "000000" + Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, "0");
}

/** 架空のメディア ID。数字だけにせず、実在の ID と紛れない形にする */
function fakeMediaId(label: string): string {
  return `fake-${label}-${Math.floor(Math.random() * 1_000_000_000)}`;
}

const CREDENTIAL: CredentialInfo = {
  token_type: "PAGE",
  expires_at: null,
  data_access_expires_at: new Date("2026-12-29T00:00:00Z"),
  scopes: ["instagram_basic", "instagram_manage_insights", "pages_read_engagement"],
  status: "valid",
};

const FEED_PLAIN = ["views", "reach", "likes", "comments", "saved", "shares", "reposts", "total_interactions", "profile_visits", "follows"];
const REELS_PLAIN = [
  "views",
  "reach",
  "likes",
  "comments",
  "saved",
  "shares",
  "reposts",
  "total_interactions",
  "ig_reels_avg_watch_time",
  "ig_reels_video_view_total_time",
  "reels_skip_rate",
];

const FEED_VALUES: Record<string, number> = {
  views: 1520,
  reach: 980,
  likes: 40,
  comments: 3,
  saved: 31,
  shares: 5,
  reposts: 0,
  total_interactions: 79,
  profile_visits: 12,
  follows: 2,
};
const REELS_VALUES: Record<string, number> = {
  views: 8000,
  reach: 6000,
  likes: 200,
  comments: 10,
  saved: 50,
  shares: 20,
  reposts: 1,
  total_interactions: 281,
  ig_reels_avg_watch_time: 5400,
  ig_reels_video_view_total_time: 43_200_000,
  reels_skip_rate: 35,
};

// ---------------------------------------------------------------------------
// 偽の fetch（メディア ID ごとの応答）
// ---------------------------------------------------------------------------

interface InsightRequest {
  metric: string | undefined;
  breakdown: string | undefined;
  metricType: string | undefined;
}

type Responder = (req: InsightRequest) => Response;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function graphErrorResponse(error: GraphError, status = 400): Response {
  return jsonResponse({ error }, { status });
}

function plainBody(metric: string | undefined, values: Record<string, number>): unknown {
  return {
    data: (metric ?? "").split(",").map((name) => ({
      name,
      period: "lifetime",
      values: [{ value: values[name] ?? 0 }],
      title: name,
      description: "",
      id: `x/insights/${name}/lifetime`,
    })),
  };
}

function breakdownBody(metric: string, dimension: string, results: Record<string, number>): unknown {
  return {
    data: [
      {
        name: metric,
        period: "lifetime",
        total_value: {
          breakdowns: [{ dimension_keys: [dimension], results: Object.entries(results).map(([k, v]) => ({ dimension_values: [k], value: v })) }],
        },
        title: metric,
        description: "",
        id: `x/insights/${metric}/lifetime`,
      },
    ],
  };
}

const feedResponder: Responder = (req) =>
  req.breakdown === "action_type"
    ? jsonResponse(breakdownBody("profile_activity", "action_type", { BIO_LINK_CLICKED: 3, CALL: 0 }))
    : jsonResponse(plainBody(req.metric, FEED_VALUES));

const reelsResponder: Responder = (req) => jsonResponse(plainBody(req.metric, REELS_VALUES));

const NOT_EXIST: GraphError = {
  message: "Unsupported get request. Object with ID '17841400000000002' does not exist, cannot be loaded due to missing permissions, or does not support this operation. Please read the Graph API documentation at https://developers.facebook.com/docs/graph-api",
  type: "GraphMethodException",
  code: 100,
  error_subcode: 33,
  fbtrace_id: "AbCdEf",
};

const notExistResponder: Responder = () => graphErrorResponse(NOT_EXIST);

const serverErrorResponder: Responder = () => new Response("<html>502</html>", { status: 502, headers: { "content-type": "text/html" } });

describe.skipIf(!TEST_DATABASE_URL)("db/snapshots と jobs/media-snapshot（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  let db: Db;
  const createdAccountIds: string[] = [];
  const responders = new Map<string, Responder>();
  const requests: URL[] = [];
  const lines: string[] = [];
  let deps: JobDeps;

  const config: WorkerConfig = {
    databaseUrl: url,
    supabaseUrl: "http://127.0.0.1:54321",
    supabaseServiceRoleKey: "FAKE_SERVICE_ROLE_KEY",
    graphApiVersion: "v25.0",
    metaAppId: "0",
    metaAppSecret: "FAKE_APP_SECRET",
    hourlyMinute: 5,
    dailyTimeJst: { hour: 5, minute: 30 },
    backfillMaxDays: 30,
    backfillHistoryDays: 730,
    rateHardLimit: 90,
    rateSoftLimit: 50,
    logLevel: "debug",
    outputDir: ".local",
    downloadAllowedHosts: ["cdninstagram.com"],
    videoMaxPerRun: 5,
    videoBudgetMs: 480_000,
  };

  const fetchImpl: typeof fetch = async (input) => {
    const target = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
    requests.push(target);
    const match = /^\/v25\.0\/(.+)\/insights$/.exec(target.pathname);
    const mediaId = match?.[1];
    const responder = mediaId === undefined ? undefined : responders.get(mediaId);
    if (!responder) return graphErrorResponse({ message: "応答の用意がない", code: 999_999 });
    return responder({
      metric: target.searchParams.get("metric") ?? undefined,
      breakdown: target.searchParams.get("breakdown") ?? undefined,
      metricType: target.searchParams.get("metric_type") ?? undefined,
    });
  };

  async function newAccount(): Promise<AccountRow> {
    const account = await db.begin((tx) => upsertAccount(tx, { ig_user_id: fakeIgUserId(), username: "fake_user" }));
    createdAccountIds.push(account.id);
    await db.begin((tx) => upsertCredential(tx, account.id, `FAKE_VAULT_TOKEN_${account.id}`, CREDENTIAL));
    return account;
  }

  interface MediaSeed {
    id: string;
    account_id: string;
    media_type: MediaType;
    media_product_type: MediaProductType;
    posted_at: Date;
    gone_at?: Date;
  }

  async function insertMedia(seed: MediaSeed): Promise<void> {
    const expiresAt = seed.media_product_type === "STORY" ? new Date(seed.posted_at.getTime() + DAY) : null;
    await db`
      insert into public.media (id, account_id, media_type, media_product_type, posted_at, expires_at, gone_at)
      values (${seed.id}, ${seed.account_id}, ${seed.media_type}, ${seed.media_product_type}, ${seed.posted_at}, ${expiresAt}, ${seed.gone_at ?? null})
    `;
  }

  async function snapshotsOf(mediaId: string): Promise<MediaInsightSnapshotRow[]> {
    return [
      ...(await db<MediaInsightSnapshotRow[]>`
        select * from public.media_insight_snapshots where media_id = ${mediaId} order by fetched_at, id
      `),
    ];
  }

  async function latestRun(accountId: string): Promise<JobRunRow | undefined> {
    const rows = await db<JobRunRow[]>`
      select * from public.job_runs where account_id = ${accountId} and job_name = 'media_snapshot' order by id desc limit 1
    `;
    return rows[0];
  }

  async function rawById(id: string): Promise<RawApiResponseRow | undefined> {
    return (await db<RawApiResponseRow[]>`select * from public.raw_api_responses where id = ${id}`)[0];
  }

  function logText(): string {
    return lines.join("\n");
  }

  beforeAll(async () => {
    db = connectDb(url);
    const secrets = new SecretRegistry();
    secrets.add(config.metaAppSecret);
    secrets.add(config.supabaseServiceRoleKey);
    secrets.addUrlParts(config.databaseUrl);
    secrets.addUrlParts(config.supabaseUrl);
    const log = createLogger("debug", secrets, (line) => lines.push(line));
    deps = { db, config, log, secrets, fetchImpl, sleep: async () => {} };
  });

  beforeEach(() => {
    requests.length = 0;
    lines.length = 0;
  });

  afterAll(async () => {
    for (const id of createdAccountIds) {
      await db`delete from public.accounts where id = ${id}`;
      const [runs] = await db<{ n: number }[]>`select count(*)::int as n from public.job_runs where account_id = ${id}`;
      expect(runs?.n).toBe(0);
      const [media] = await db<{ n: number }[]>`select count(*)::int as n from public.media where account_id = ${id}`;
      expect(media?.n).toBe(0);
    }
    await closeDb(db);
  });

  // -------------------------------------------------------------------------
  // db/snapshots.ts
  // -------------------------------------------------------------------------

  it("insertSnapshot は同じ (media_id, fetched_at) の 2 回目に false を返し、行は増えない。raw_response_id は null でもよい", async () => {
    const account = await newAccount();
    const mediaId = fakeMediaId("feed");
    const postedAt = new Date(Date.now() - 2 * HOUR);
    await insertMedia({ id: mediaId, account_id: account.id, media_type: "IMAGE", media_product_type: "FEED", posted_at: postedAt });
    const [run] = await db<{ id: string }[]>`
      insert into public.job_runs (job_name, account_id, status, finished_at) values ('media_snapshot', ${account.id}, 'success', now()) returning id
    `;
    const jobRunId = run?.id ?? "";
    const fetchedAt = new Date(postedAt.getTime() + HOUR);
    const row = {
      media_id: mediaId,
      fetched_at: fetchedAt,
      elapsed_seconds: 3600,
      metrics: { views: 10, reach: 8, follows: null, profile_activity: { bio_link_clicked: 1 } },
      raw_response_id: null,
      job_run_id: jobRunId,
    };

    expect(await db.begin((tx) => insertSnapshot(tx, row))).toBe(true);
    expect(await db.begin((tx) => insertSnapshot(tx, row))).toBe(false);
    expect(await countSnapshots(db, mediaId)).toBe(1);

    const [stored] = await snapshotsOf(mediaId);
    expect(stored?.fetched_at).toEqual(fetchedAt);
    expect(stored?.elapsed_seconds).toBe(3600);
    expect(stored?.metrics).toEqual(row.metrics);
    expect(stored?.raw_response_id).toBeNull();
    expect(stored?.job_run_id).toBe(jobRunId);

    // 別の fetched_at なら入る
    expect(await db.begin((tx) => insertSnapshot(tx, { ...row, fetched_at: new Date(fetchedAt.getTime() + HOUR) }))).toBe(true);
    expect(await countSnapshots(db, mediaId)).toBe(2);
    expect(await countSnapshots(db, fakeMediaId("none"))).toBe(0);
  });

  it("listSnapshotCandidates は gone_at のある投稿と指定外の種類を返さず、posted_at 降順で、last_fetched_at は最大の fetched_at", async () => {
    const account = await newAccount();
    const now = Date.now();
    const feed = fakeMediaId("feed");
    const reel = fakeMediaId("reel");
    const story = fakeMediaId("story");
    const gone = fakeMediaId("gone");
    await insertMedia({ id: feed, account_id: account.id, media_type: "IMAGE", media_product_type: "FEED", posted_at: new Date(now - 2 * DAY) });
    await insertMedia({ id: reel, account_id: account.id, media_type: "VIDEO", media_product_type: "REELS", posted_at: new Date(now - 1 * DAY) });
    await insertMedia({ id: story, account_id: account.id, media_type: "IMAGE", media_product_type: "STORY", posted_at: new Date(now - 1 * HOUR) });
    await insertMedia({
      id: gone,
      account_id: account.id,
      media_type: "CAROUSEL_ALBUM",
      media_product_type: "FEED",
      posted_at: new Date(now - 3 * HOUR),
      gone_at: new Date(now - 1 * MINUTE),
    });
    const older = new Date(now - 36 * HOUR);
    const newer = new Date(now - 12 * HOUR);
    for (const fetchedAt of [newer, older]) {
      await db`
        insert into public.media_insight_snapshots (media_id, fetched_at, elapsed_seconds, metrics)
        values (${feed}, ${fetchedAt}, ${Math.floor((fetchedAt.getTime() - (now - 2 * DAY)) / 1000)}, ${jsonb(db, { views: null })})
      `;
    }

    const candidates = await listSnapshotCandidates(db, account.id, ["FEED", "REELS"]);
    expect(candidates.map((c) => c.id)).toEqual([reel, feed]);
    expect(candidates[0]).toMatchObject({ media_type: "VIDEO", media_product_type: "REELS", last_fetched_at: null });
    expect(candidates[0]?.posted_at).toEqual(new Date(now - 1 * DAY));
    expect(candidates[1]).toMatchObject({ media_type: "IMAGE", media_product_type: "FEED" });
    expect(candidates[1]?.last_fetched_at).toEqual(newer);

    expect((await listSnapshotCandidates(db, account.id, ["STORY"])).map((c) => c.id)).toEqual([story]);
    expect((await listSnapshotCandidates(db, account.id, ["FEED"])).map((c) => c.id)).toEqual([feed]);
    expect(await listSnapshotCandidates(db, account.id, [])).toEqual([]);

    // 別のアカウントの投稿は返さない
    const other = await newAccount();
    expect(await listSnapshotCandidates(db, other.id, ["FEED", "REELS", "STORY"])).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // jobs/media-snapshot.ts（runJob）
  // -------------------------------------------------------------------------

  let successAccount: AccountRow;
  let successFeedId: string;
  let successReelId: string;
  const successNow = new Date();

  it("FEED 1 件（2 リクエスト）と REELS 1 件（1 リクエスト）で 2 行入る。metrics の形、elapsed_seconds、job_run_id、raw_response_id", async () => {
    successAccount = await newAccount();
    successFeedId = fakeMediaId("feed");
    successReelId = fakeMediaId("reel");
    const feedPostedAt = new Date(successNow.getTime() - 3 * HOUR);
    const reelPostedAt = new Date(successNow.getTime() - 2 * HOUR);
    await insertMedia({ id: successFeedId, account_id: successAccount.id, media_type: "IMAGE", media_product_type: "FEED", posted_at: feedPostedAt });
    await insertMedia({ id: successReelId, account_id: successAccount.id, media_type: "VIDEO", media_product_type: "REELS", posted_at: reelPostedAt });
    responders.set(successFeedId, feedResponder);
    responders.set(successReelId, reelsResponder);

    const outcome = await runJob(job, { ...deps, now: () => successNow }, successAccount);
    expect(outcome).toBe("success");

    const run = await latestRun(successAccount.id);
    expect(run?.status).toBe("success");
    expect(run?.items_fetched).toBe(2);
    expect(run?.api_calls).toBe(3);
    expect(run?.error).toBeNull();

    // 新しい順（REELS → FEED）。内訳つきは metric_type=total_value を付け、URL にトークンを載せない。
    // appsecret_proof（R2 設計 5.6 章）は全リクエストに付く。比較からは除く（値は test/appsecret-proof.test.ts で確かめる）
    for (const u of requests) expect(u.searchParams.get("appsecret_proof")).toMatch(/^[0-9a-f]{64}$/);
    const described = requests.map((u) => {
      const query = new URLSearchParams(u.searchParams);
      query.delete("appsecret_proof");
      return `${u.pathname.replace("/v25.0/", "")}?${query.toString()}`;
    });
    expect(described).toEqual([
      `${successReelId}/insights?metric=${encodeURIComponent(REELS_PLAIN.join(","))}`,
      `${successFeedId}/insights?metric=${encodeURIComponent(FEED_PLAIN.join(","))}`,
      `${successFeedId}/insights?metric=profile_activity&breakdown=action_type&metric_type=total_value`,
    ]);
    for (const u of requests) expect(u.searchParams.has("access_token")).toBe(false);

    const [feedRow] = await snapshotsOf(successFeedId);
    expect(feedRow?.metrics).toEqual({ ...FEED_VALUES, profile_activity: { bio_link_clicked: 3, call: 0 } });
    expect(feedRow?.fetched_at).toEqual(successNow);
    expect(feedRow?.elapsed_seconds).toBe(3 * 60 * 60);
    expect(feedRow?.job_run_id).toBe(run?.id);
    const feedRaw = await rawById(feedRow?.raw_response_id ?? "");
    expect(feedRaw?.endpoint).toBe(`${successFeedId}/insights`);
    expect(feedRaw?.params).toEqual({ metric: FEED_PLAIN.join(",") });
    expect(feedRaw?.job_run_id).toBe(run?.id);
    expect(feedRaw?.http_status).toBe(200);

    const [reelRow] = await snapshotsOf(successReelId);
    expect(reelRow?.metrics).toEqual(REELS_VALUES);
    expect(reelRow?.metrics).not.toHaveProperty("follows");
    expect(reelRow?.metrics).not.toHaveProperty("profile_visits");
    expect(reelRow?.metrics).not.toHaveProperty("profile_activity");
    expect(reelRow?.elapsed_seconds).toBe(2 * 60 * 60);
    expect(reelRow?.job_run_id).toBe(run?.id);
    expect((await rawById(reelRow?.raw_response_id ?? ""))?.params).toEqual({ metric: REELS_PLAIN.join(",") });

    expect(logText()).toMatch(/INFO {2}job=media_snapshot candidates=2 due=2 written=2$/m);
    expect(logText()).toMatch(/DEBUG job=media_snapshot progress=2\/2$/m);
    expect(logText()).toMatch(/INFO {2}job=media_snapshot status=success items=2 calls=3 failures=0/m);
    expect(logText()).not.toContain(successFeedId);
    expect(logText()).not.toContain(successReelId);
  });

  it("同じ now で 2 回目を流しても対象がなく、API を呼ばず行数も変わらない（間隔の規則。insertSnapshot の重複は上のテスト）", async () => {
    const outcome = await runJob(job, { ...deps, now: () => successNow }, successAccount);
    expect(outcome).toBe("success");
    expect(requests).toHaveLength(0);
    expect(await countSnapshots(db, successFeedId)).toBe(1);
    expect(await countSnapshots(db, successReelId)).toBe(1);
    const run = await latestRun(successAccount.id);
    expect(run?.items_fetched).toBe(0);
    expect(run?.api_calls).toBe(0);
    expect(logText()).toMatch(/INFO {2}job=media_snapshot candidates=2 due=0 written=0$/m);

    // 50 分後（1 時間 − 10 分）なら対象になり、別の fetched_at で 1 行ずつ増える
    const later = new Date(successNow.getTime() + 50 * MINUTE);
    expect(await runJob(job, { ...deps, now: () => later }, successAccount)).toBe("success");
    expect(await countSnapshots(db, successFeedId)).toBe(2);
    expect(await countSnapshots(db, successReelId)).toBe(2);
    expect((await snapshotsOf(successFeedId)).at(-1)?.fetched_at).toEqual(later);
  });

  it("fatal（存在しないメディア）なら null だけの行が入り、raw_response_id はエラー応答。次回は通常の間隔で再試行", async () => {
    const account = await newAccount();
    const mediaId = fakeMediaId("deleted");
    const now = new Date();
    const postedAt = new Date(now.getTime() - 40 * DAY);
    await insertMedia({ id: mediaId, account_id: account.id, media_type: "IMAGE", media_product_type: "FEED", posted_at: postedAt });
    responders.set(mediaId, notExistResponder);

    const outcome = await runJob(job, { ...deps, now: () => now }, account);
    // 行は書けた（items 1）が失敗もある → partial
    expect(outcome).toBe("partial");
    const run = await latestRun(account.id);
    expect(run?.status).toBe("partial");
    expect(run?.items_fetched).toBe(1);
    // subcode 33 は 1 指標ずつ取り直さず、内訳つきも出さない（まとめた取得の 1 回だけ）
    expect(run?.api_calls).toBe(1);
    expect(run?.error).toBe("Unsupported get request. Object with ID '***' does not exist, cannot be loaded due to missing permissions, or does not support this operation. Please read the Graph API documentation at <url>");

    const rows = await snapshotsOf(mediaId);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.metrics).toEqual(Object.fromEntries([...FEED_PLAIN, "profile_activity"].map((m) => [m, null])));
    expect(row?.fetched_at).toEqual(now);
    expect(row?.elapsed_seconds).toBe(40 * 24 * 60 * 60);
    expect(row?.job_run_id).toBe(run?.id);
    const raw = await rawById(row?.raw_response_id ?? "");
    expect(raw?.http_status).toBe(400);
    expect(raw?.params).toEqual({ metric: FEED_PLAIN.join(",") });
    expect((raw?.body as { error: GraphError }).error.code).toBe(100);
    expect(JSON.stringify(raw?.body)).not.toContain("://");

    // null だけの行も「前回」になる。40 日時点が前回なので間隔は 7 日
    const [candidate] = await listSnapshotCandidates(db, account.id, ["FEED"]);
    expect(candidate?.last_fetched_at).toEqual(now);
    expect(isSnapshotDue(postedAt, now, new Date(now.getTime() + 1 * MINUTE))).toBe(false);
    expect(isSnapshotDue(postedAt, now, new Date(now.getTime() + 1 * DAY))).toBe(false);
    expect(isSnapshotDue(postedAt, now, new Date(now.getTime() + 7 * DAY - 10 * MINUTE))).toBe(true);

    expect(logText()).toMatch(/WARN {2}job=media_snapshot error_code=100 error_subcode=33 class=fatal error="メディアが存在しないか権限がない（指標をすべて null にした行を書く）"$/m);
    expect(logText()).toMatch(/WARN {2}job=media_snapshot status=partial items=1 calls=1 failures=1 .* error_code=100 class=fatal$/m);
    expect(logText()).not.toContain(mediaId);
    expect(logText()).not.toContain("://");
  });

  it("transient（再試行を使い切った）なら行を書かず partial。次回も対象のまま", async () => {
    const account = await newAccount();
    const feedId = fakeMediaId("feed");
    const reelId = fakeMediaId("reel-down");
    const now = new Date();
    await insertMedia({ id: feedId, account_id: account.id, media_type: "IMAGE", media_product_type: "FEED", posted_at: new Date(now.getTime() - 5 * HOUR) });
    await insertMedia({ id: reelId, account_id: account.id, media_type: "VIDEO", media_product_type: "REELS", posted_at: new Date(now.getTime() - 1 * HOUR) });
    responders.set(feedId, feedResponder);
    responders.set(reelId, serverErrorResponder);

    const outcome = await runJob(job, { ...deps, now: () => now }, account);
    expect(outcome).toBe("partial");
    const run = await latestRun(account.id);
    expect(run?.status).toBe("partial");
    expect(run?.items_fetched).toBe(1);
    // REELS 3 回（再試行）＋ FEED 2 回
    expect(run?.api_calls).toBe(5);
    expect(run?.error).toBe("HTTP 502");

    expect(await countSnapshots(db, reelId)).toBe(0);
    expect(await countSnapshots(db, feedId)).toBe(1);
    const [candidate] = await listSnapshotCandidates(db, account.id, ["REELS"]);
    expect(candidate?.last_fetched_at).toBeNull();
    expect(isSnapshotDue(candidate?.posted_at ?? now, candidate?.last_fetched_at ?? null, now)).toBe(true);
    expect(logText()).toMatch(/WARN {2}job=media_snapshot status=partial items=1 calls=5 failures=1 .* error_code=none class=transient$/m);
    expect(logText()).toMatch(/INFO {2}job=media_snapshot candidates=2 due=2 written=1$/m);
  });

  it("途中で RateLimitExceeded になったら、それまでの行は残り partial。次回は残りの投稿だけが対象", async () => {
    const account = await newAccount();
    const feedId = fakeMediaId("feed");
    const reelId = fakeMediaId("reel-limited");
    const now = new Date();
    // 新しい順に処理されるので FEED（2 時間前）→ REELS（3 時間前）
    await insertMedia({ id: feedId, account_id: account.id, media_type: "IMAGE", media_product_type: "FEED", posted_at: new Date(now.getTime() - 2 * HOUR) });
    await insertMedia({ id: reelId, account_id: account.id, media_type: "VIDEO", media_product_type: "REELS", posted_at: new Date(now.getTime() - 3 * HOUR) });
    responders.set(feedId, feedResponder);
    responders.set(reelId, () => graphErrorResponse({ message: "Application request limit reached", type: "OAuthException", code: 4 }));

    const first = await runJob(job, { ...deps, now: () => now }, account);
    expect(first).toBe("partial");
    let run = await latestRun(account.id);
    expect(run?.status).toBe("partial");
    expect(run?.items_fetched).toBe(1);
    // FEED 2 回 ＋ REELS 1 回（レート制限は再試行しない）
    expect(run?.api_calls).toBe(3);
    expect(run?.error).toBe("レート制限のエラー（コード 4）");
    expect(await countSnapshots(db, feedId)).toBe(1);
    expect(await countSnapshots(db, reelId)).toBe(0);
    expect(logText()).toMatch(/WARN {2}job=media_snapshot status=partial items=1 calls=3 failures=0 .* error_code=none class=rate$/m);

    // 次回: FEED は間隔の規則で対象外、REELS だけ取る
    requests.length = 0;
    lines.length = 0;
    responders.set(reelId, reelsResponder);
    const second = await runJob(job, { ...deps, now: () => new Date(now.getTime() + 5 * MINUTE) }, account);
    expect(second).toBe("success");
    run = await latestRun(account.id);
    expect(run?.items_fetched).toBe(1);
    expect(run?.api_calls).toBe(1);
    expect(requests.map((u) => u.pathname)).toEqual([`/v25.0/${reelId}/insights`]);
    expect(await countSnapshots(db, feedId)).toBe(1);
    expect(await countSnapshots(db, reelId)).toBe(1);
    expect((await snapshotsOf(reelId))[0]?.metrics).toEqual(REELS_VALUES);
    expect(logText()).toMatch(/INFO {2}job=media_snapshot candidates=2 due=1 written=1$/m);
  });

  it("対象がなければ API を呼ばず success（items 0）", async () => {
    const account = await newAccount();
    const story = fakeMediaId("story");
    await insertMedia({ id: story, account_id: account.id, media_type: "IMAGE", media_product_type: "STORY", posted_at: new Date() });
    expect(await runJob(job, deps, account)).toBe("success");
    expect(requests).toHaveLength(0);
    expect((await latestRun(account.id))?.items_fetched).toBe(0);
    expect(logText()).toMatch(/INFO {2}job=media_snapshot candidates=0 due=0 written=0$/m);
  });
});
