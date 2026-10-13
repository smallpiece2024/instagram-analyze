/**
 * 結合テスト（`test/db/*.test.ts`）の共通の手伝い。架空の ID と、`readEnv` が読む環境変数の差し替え。
 * 架空の値だけを使い、実データの ID やユーザー名を書かない。
 */
import type postgres from "postgres";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;
export const MINUTE_MS = 60 * 1000;

/** 架空の Instagram アカウント ID（実在しない。先頭 6 桁が 0） */
export function fakeIgUserId(): string {
  return "000000" + Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, "0");
}

/** 架空のメディア ID（数字だけ。先頭 4 桁が 0、`seq` は 3 桁で末尾） */
export function fakeMediaId(seq: number): string {
  return "0000" + Date.now().toString() + seq.toString().padStart(3, "0");
}

/**
 * `readEnv` が読む変数を設定し、元に戻す関数を返す。DB 以外は架空の値（Meta には繋がない）。
 * `META_TARGET_IG_USER_ID` は `target` を渡せば設定し、渡さなければ消す
 */
export function setWebEnv(databaseUrl: string, target?: string): () => void {
  const values: Record<string, string | undefined> = {
    DATABASE_URL: databaseUrl,
    META_APP_ID: "1",
    META_APP_SECRET: "test-secret",
    META_GRAPH_API_VERSION: "v25.0",
    APP_URL: "http://localhost:3000",
    META_TARGET_IG_USER_ID: target,
  };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(values)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

// ---------------------------------------------------------------
// R5（20261009000000_r5_analysis.sql）の表の作り方。行は postgres（TEST_DATABASE_URL）で入れる。
// アカウントを消せば、どの行もカスケードで消える。段階 3 の各担当は読むだけにする（設計 7.5 節）
// ---------------------------------------------------------------

/** `getDb()` の `Db` と `postgres()` の戻り値のどちらも受ける */
type AnySql<T extends Record<string, unknown>> = postgres.Sql<T>;

/** 架空のアカウントを作り、id を返す（`status = 'paused'` で収集対象にしない） */
export async function insertFakeAccount<T extends Record<string, unknown>>(sql: AnySql<T>, username = "fake_r5"): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into public.accounts (ig_user_id, username, name, status)
    values (${fakeIgUserId()}, ${username}, null, 'paused')
    returning id
  `;
  if (!row) throw new Error("account insert returned no row");
  return row.id;
}

export type FakeMedia = {
  id: string;
  accountId: string;
  postedAt: Date;
  /** 既定は FEED */
  productType?: "FEED" | "REELS" | "STORY";
  /** 既定は IMAGE */
  mediaType?: "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM";
  caption?: string | null;
  goneAt?: Date | null;
  /**
   * 特殊な投稿のフラグ（R6 3.6 節）。省略なら null（判定できない。本番の全投稿と同じ）。
   * true の投稿は media_outlier_flags の比較対象から外れる。null と false は入る
   */
  isCollab?: boolean | null;
  isTrialReel?: boolean | null;
  isBoosted?: boolean | null;
};

/** 投稿（ストーリーズを含む）を 1 件入れる */
export async function insertMedia<T extends Record<string, unknown>>(sql: AnySql<T>, m: FakeMedia): Promise<void> {
  await sql`
    insert into public.media (id, account_id, media_type, media_product_type, posted_at, caption, gone_at,
                              is_collab, is_trial_reel, is_boosted)
    values (${m.id}, ${m.accountId}, ${m.mediaType ?? "IMAGE"}, ${m.productType ?? "FEED"}, ${m.postedAt},
            ${m.caption ?? null}, ${m.goneAt ?? null},
            ${m.isCollab ?? null}, ${m.isTrialReel ?? null}, ${m.isBoosted ?? null})
  `;
}

/** スナップショットを 1 件入れる。`elapsed_seconds` は `fetchedAt - postedAt` から求める */
export async function insertSnapshot<T extends Record<string, unknown>>(
  sql: AnySql<T>,
  s: { mediaId: string; postedAt: Date; fetchedAt: Date; metrics: Record<string, unknown> },
): Promise<void> {
  const elapsed = Math.max(0, Math.round((s.fetchedAt.getTime() - s.postedAt.getTime()) / 1000));
  await sql`
    insert into public.media_insight_snapshots (media_id, fetched_at, elapsed_seconds, metrics)
    values (${s.mediaId}, ${s.fetchedAt}, ${elapsed}, ${sql.json(s.metrics as postgres.JSONValue)})
  `;
}

/** UTC の時刻を JST の日付（YYYY-MM-DD）にする */
export function jstDate(d: Date): string {
  return new Date(d.getTime() + 9 * HOUR_MS).toISOString().slice(0, 10);
}

/** その時刻を含む週の JST の月曜（YYYY-MM-DD）。audience_captures.week_start に入れる値 */
export function jstWeekStart(d: Date): string {
  const jst = new Date(d.getTime() + 9 * HOUR_MS);
  const isoDow = jst.getUTCDay() === 0 ? 7 : jst.getUTCDay();
  return new Date(jst.getTime() - (isoDow - 1) * DAY_MS).toISOString().slice(0, 10);
}

/**
 * profile_daily を 1 件入れる。captured_on は captured_at の JST の日付（主キーが (account_id, captured_on) なので、
 * 同じアカウントで同じ JST の日に 2 件は入れられない）
 */
export async function insertProfileDaily<T extends Record<string, unknown>>(
  sql: AnySql<T>,
  p: { accountId: string; capturedAt: Date; followersCount: number | null },
): Promise<void> {
  await sql`
    insert into public.profile_daily (account_id, captured_on, captured_at, followers_count)
    values (${p.accountId}, ${jstDate(p.capturedAt)}, ${p.capturedAt}, ${p.followersCount})
  `;
}

/** ストーリーズの指標（story_list_metrics が読む形）。navigation を省けば、そのキーのない応答になる */
export function storyMetrics(v: {
  views?: number;
  reach?: number;
  tapForward?: number;
  tapBack?: number;
  tapExit?: number;
  swipeForward?: number;
  linkClicks?: number;
  replies?: number;
  /** false なら navigation のキーを入れない（T8） */
  navigation?: boolean;
}): Record<string, unknown> {
  const metrics: Record<string, unknown> = {
    views: v.views ?? 0,
    reach: v.reach ?? 0,
    replies: v.replies ?? 0,
    link_clicks: v.linkClicks ?? 0,
  };
  if (v.navigation !== false) {
    metrics.navigation = {
      tap_forward: v.tapForward ?? 0,
      tap_back: v.tapBack ?? 0,
      tap_exit: v.tapExit ?? 0,
      swipe_forward: v.swipeForward ?? 0,
    };
  }
  return metrics;
}

/** ストーリーズを 1 件と、その確定値のスナップショットを 1 件入れる（既定は投稿の 23 時間後に取った値） */
export async function insertStory<T extends Record<string, unknown>>(
  sql: AnySql<T>,
  s: { id: string; accountId: string; postedAt: Date; metrics: Record<string, unknown>; fetchedAt?: Date; mediaType?: "IMAGE" | "VIDEO" },
): Promise<void> {
  await insertMedia(sql, { id: s.id, accountId: s.accountId, postedAt: s.postedAt, productType: "STORY", mediaType: s.mediaType ?? "IMAGE" });
  await insertSnapshot(sql, {
    mediaId: s.id,
    postedAt: s.postedAt,
    fetchedAt: s.fetchedAt ?? new Date(s.postedAt.getTime() + 23 * HOUR_MS),
    metrics: s.metrics,
  });
}

/** タグの軸を 1 つ作り、id（bigint を文字列で）を返す */
export async function insertTagAxis<T extends Record<string, unknown>>(
  sql: AnySql<T>,
  a: { accountId: string; name: string; sortOrder?: number },
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into public.tag_axes (account_id, name, sort_order)
    values (${a.accountId}, ${a.name}, ${a.sortOrder ?? 0})
    returning id::text as id
  `;
  if (!row) throw new Error("tag_axes insert returned no row");
  return row.id;
}

/** タグの値を 1 つ作り、id（bigint を文字列で）を返す */
export async function insertTagValue<T extends Record<string, unknown>>(
  sql: AnySql<T>,
  v: { axisId: string; name: string; sortOrder?: number },
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into public.tag_values (axis_id, name, sort_order)
    values (${v.axisId}::bigint, ${v.name}, ${v.sortOrder ?? 0})
    returning id::text as id
  `;
  if (!row) throw new Error("tag_values insert returned no row");
  return row.id;
}

/** 投稿にタグを付ける（軸ごとに 1 つ） */
export async function insertMediaTag<T extends Record<string, unknown>>(
  sql: AnySql<T>,
  t: { mediaId: string; accountId: string; axisId: string; valueId: string },
): Promise<void> {
  await sql`
    insert into public.media_tags (media_id, account_id, axis_id, value_id)
    values (${t.mediaId}, ${t.accountId}, ${t.axisId}::bigint, ${t.valueId}::bigint)
  `;
}

export type FakeAudienceCapture = {
  accountId: string;
  metric?: "follower_demographics" | "engaged_audience_demographics";
  timeframe?: "this_week" | "this_month";
  breakdown: "age" | "gender" | "country" | "city";
  /** JST の月曜（YYYY-MM-DD）。`jstWeekStart()` で作る */
  weekStart: string;
  /** 区分ごとの人数。空なら status = 'empty' の行になる（D10: 値の行が 1 件以上なら ok） */
  values: Record<string, number>;
  /** 既定は weekStart の JST 6:00 */
  fetchedAt?: Date;
};

/** 属性の週次記録を 1 組入れ、capture の id（bigint を文字列で）を返す。区分の名前は架空にする（S6） */
export async function insertAudienceCapture<T extends Record<string, unknown>>(sql: AnySql<T>, c: FakeAudienceCapture): Promise<string> {
  const entries = Object.entries(c.values);
  const fetchedAt = c.fetchedAt ?? new Date(`${c.weekStart}T06:00:00+09:00`);
  const [row] = await sql<{ id: string }[]>`
    insert into public.audience_captures (account_id, metric, timeframe, breakdown, week_start, status, fetched_at)
    values (${c.accountId}, ${c.metric ?? "follower_demographics"}, ${c.timeframe ?? "this_month"}, ${c.breakdown},
            ${c.weekStart}, ${entries.length > 0 ? "ok" : "empty"}, ${fetchedAt})
    returning id::text as id
  `;
  if (!row) throw new Error("audience_captures insert returned no row");
  for (const [key, value] of entries) {
    await sql`insert into public.audience_values (capture_id, value_key, value) values (${row.id}::bigint, ${key}, ${value})`;
  }
  return row.id;
}

// ---------------------------------------------------------------
// R6（20261013000000_r6_report.sql）の表とビューの作り方（設計 doc/design/r6-report.md 7.4 節の T12）。
// 行は postgres（TEST_DATABASE_URL）で入れる。アカウントを消せば、どの行もカスケードで消える
// ---------------------------------------------------------------

/**
 * 投稿の指標（media_list_metrics と media_outlier_flags が読む形）。シェア率 = shares ÷ reach なので、
 * reach を 2 の冪（64 など）にすると 1/8、1/4 のような 2 進で正確な値になる（D5 の「ちょうど」の比較に使う）。
 * reach を null にするとキーを入れない（metric_value は strict で null → シェア率 null）
 */
export function postMetrics(v: {
  reach?: number | null;
  shares?: number;
  likes?: number;
  comments?: number;
  saved?: number;
  views?: number;
}): Record<string, unknown> {
  const metrics: Record<string, unknown> = {
    shares: v.shares ?? 0,
    likes: v.likes ?? 0,
    comments: v.comments ?? 0,
    saved: v.saved ?? 0,
    views: v.views ?? 0,
  };
  if (v.reach !== null) metrics.reach = v.reach ?? 0;
  return metrics;
}

export type FakeReportNote = {
  accountId: string;
  /** 月の 1 日（YYYY-MM-01）。check が 1 日以外を拒む */
  reportMonth: string;
  summary?: string;
  nextPlan?: string;
};

/** 月次レポートの記入欄を 1 件入れ、updated_at を返す */
export async function insertReportNote<T extends Record<string, unknown>>(sql: AnySql<T>, n: FakeReportNote): Promise<Date> {
  const [row] = await sql<{ updated_at: Date }[]>`
    insert into public.report_notes (account_id, report_month, summary, next_plan)
    values (${n.accountId}, ${n.reportMonth}, ${n.summary ?? ""}, ${n.nextPlan ?? ""})
    returning updated_at
  `;
  if (!row) throw new Error("report_notes insert returned no row");
  return row.updated_at;
}

export type FakeAccountDaily = {
  accountId: string;
  /** API の日付（米国太平洋時間の日付。YYYY-MM-DD）。account_daily_wide.metric_date になる */
  metricDate: string;
  /** 内訳なしの指標。undefined なら行を入れない（未取得）。null なら行があって値が null（欠損） */
  reach?: number | null;
  views?: number | null;
  accountsEngaged?: number | null;
  totalInteractions?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  saved?: number | null;
  /** account_daily_metrics の metric は follower_count。account_daily_wide では new_followers */
  newFollowers?: number | null;
  /** follow_type の内訳（reach、views）。undefined なら行を入れない */
  reachFollower?: number | null;
  reachNonFollower?: number | null;
  viewsFollower?: number | null;
  viewsNonFollower?: number | null;
  /** 既定は now() */
  fetchedAt?: Date;
};

/**
 * アカウントの日次指標（account_daily_metrics。縦持ち）を 1 日分入れる。account_daily_wide が 1 行にまとめて読む形。
 * 列名の対応: saved → metric 'saves'、newFollowers → metric 'follower_count'、内訳は breakdown 'follow_type'
 */
export async function insertAccountDailyMetrics<T extends Record<string, unknown>>(sql: AnySql<T>, d: FakeAccountDaily): Promise<void> {
  const rows: { metric: string; breakdown: string; breakdown_value: string; value: number | null }[] = [];
  const plain = (metric: string, value: number | null | undefined): void => {
    if (value !== undefined) rows.push({ metric, breakdown: "", breakdown_value: "", value });
  };
  const followType = (metric: string, breakdownValue: "FOLLOWER" | "NON_FOLLOWER", value: number | null | undefined): void => {
    if (value !== undefined) rows.push({ metric, breakdown: "follow_type", breakdown_value: breakdownValue, value });
  };
  plain("reach", d.reach);
  plain("views", d.views);
  plain("accounts_engaged", d.accountsEngaged);
  plain("total_interactions", d.totalInteractions);
  plain("likes", d.likes);
  plain("comments", d.comments);
  plain("shares", d.shares);
  plain("saves", d.saved);
  plain("follower_count", d.newFollowers);
  followType("reach", "FOLLOWER", d.reachFollower);
  followType("reach", "NON_FOLLOWER", d.reachNonFollower);
  followType("views", "FOLLOWER", d.viewsFollower);
  followType("views", "NON_FOLLOWER", d.viewsNonFollower);
  const fetchedAt = d.fetchedAt ?? new Date();
  for (const r of rows) {
    await sql`
      insert into public.account_daily_metrics (account_id, metric_date, metric, breakdown, breakdown_value, value, fetched_at)
      values (${d.accountId}, ${d.metricDate}, ${r.metric}, ${r.breakdown}, ${r.breakdown_value}, ${r.value}, ${fetchedAt})
    `;
  }
}

/** media_outlier_flags の kind と、それを作る media の列の組 */
export const KIND_COLUMNS: Record<"feed" | "carousel" | "reel", { productType: "FEED" | "REELS"; mediaType: "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM" }> = {
  feed: { productType: "FEED", mediaType: "IMAGE" },
  carousel: { productType: "FEED", mediaType: "CAROUSEL_ALBUM" },
  reel: { productType: "REELS", mediaType: "VIDEO" },
};

export type FakeOutlierPeerSet = {
  accountId: string;
  /** 投稿の種類。既定は feed */
  kind?: "feed" | "carousel" | "reel";
  /** 比較対象の件数（同じ種類の、外れ値より前の投稿） */
  peerCount: number;
  /** 架空の id を返す（`fakeMediaId(seq++)` など）。呼ぶ順に古い → 新しい投稿に使うので、id の順と時刻の順がそろう */
  nextId: () => string;
  /** 一番新しい投稿（外れ値）の投稿時刻。既定は 1 日前。比較対象は 1 件ずつ `stepMs`（既定 1 日）前にずらす */
  latestPostedAt?: Date;
  stepMs?: number;
  /** 比較対象のリーチ（2 の冪にする）とシェア。シェアは件数か、古い順の添字 i を受ける関数。既定は 64 と 0（全部シェア 0 → Q3 = 0） */
  peerReach?: number;
  peerShares?: number | ((i: number) => number);
  /** 外れ値のリーチとシェア。既定は 64 と 16（シェア率 1/4） */
  outlierReach?: number;
  outlierShares?: number;
  /** スナップショットの取得時刻を投稿から何ミリ秒後にするか。既定は 7 日 */
  fetchedAfterMs?: number;
};

/**
 * 「同じ種類の投稿 N 件 + シェア率が `peer_upper` を超える 1 件」を作る（各 1 スナップショット）。
 * 既定（比較対象のシェア 0、外れ値のシェア 16/64）では、比較対象が 8 件以上なら外れ値は `high` になる（D4: Q3 = 0 ならシェア 1 件で high）。
 * 戻り値の `peerIds` は古い順
 */
export async function insertOutlierPeerSet<T extends Record<string, unknown>>(
  sql: AnySql<T>,
  s: FakeOutlierPeerSet,
): Promise<{ peerIds: string[]; outlierId: string }> {
  const cols = KIND_COLUMNS[s.kind ?? "feed"];
  const latest = s.latestPostedAt ?? new Date(Date.now() - DAY_MS);
  const step = s.stepMs ?? DAY_MS;
  const fetchedAfter = s.fetchedAfterMs ?? 7 * DAY_MS;
  const peerIds: string[] = [];
  for (let i = 0; i < s.peerCount; i++) {
    const id = s.nextId();
    const postedAt = new Date(latest.getTime() - (s.peerCount - i) * step);
    const shares = typeof s.peerShares === "function" ? s.peerShares(i) : (s.peerShares ?? 0);
    await insertMedia(sql, { id, accountId: s.accountId, postedAt, ...cols });
    await insertSnapshot(sql, {
      mediaId: id,
      postedAt,
      fetchedAt: new Date(postedAt.getTime() + fetchedAfter),
      metrics: postMetrics({ reach: s.peerReach ?? 64, shares }),
    });
    peerIds.push(id);
  }
  const outlierId = s.nextId();
  await insertMedia(sql, { id: outlierId, accountId: s.accountId, postedAt: latest, ...cols });
  await insertSnapshot(sql, {
    mediaId: outlierId,
    postedAt: latest,
    fetchedAt: new Date(latest.getTime() + fetchedAfter),
    metrics: postMetrics({ reach: s.outlierReach ?? 64, shares: s.outlierShares ?? 16 }),
  });
  return { peerIds, outlierId };
}
