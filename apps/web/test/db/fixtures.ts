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
};

/** 投稿（ストーリーズを含む）を 1 件入れる */
export async function insertMedia<T extends Record<string, unknown>>(sql: AnySql<T>, m: FakeMedia): Promise<void> {
  await sql`
    insert into public.media (id, account_id, media_type, media_product_type, posted_at, caption, gone_at)
    values (${m.id}, ${m.accountId}, ${m.mediaType ?? "IMAGE"}, ${m.productType ?? "FEED"}, ${m.postedAt},
            ${m.caption ?? null}, ${m.goneAt ?? null})
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
