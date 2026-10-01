/**
 * 投稿の簡易一覧の読み出し（設計 1.1 章、1.4 章、1.8 章）。`media_latest_metrics` からストーリーズを除き、
 * 投稿日時の新しい順に 50 件ずつ。51 件取って次ページの有無を決める。キャプションは読まない（画面に出さない）。
 */
import "server-only";
import { cache } from "react";
import { getDb } from "@/lib/db";
import { describeDbError, type QueryResult } from "@/lib/db-errors";
import { markDynamic } from "@/lib/dynamic";
import { configMissingReason, readEnv } from "@/lib/env";
import { PAGE_SIZE, type MediaMetrics } from "@/lib/format";
import { signThumbnailUrls } from "@/lib/storage";

export interface MediaListItem {
  id: string;
  media_type: string;
  media_product_type: string;
  posted_at: Date;
  permalink: string | null;
  thumbnail_path: string | null;
  gone_at: Date | null;
  /** 最新のスナップショットの取得時刻。スナップショットがなければ null */
  metrics_fetched_at: Date | null;
  elapsed_seconds: number | null;
  /** 最新のスナップショットの指標。スナップショットがなければ null */
  metrics: MediaMetrics | null;
}

export interface MediaPage<T extends MediaListItem = MediaListItem> {
  page: number;
  items: T[];
  hasNext: boolean;
}

export interface MediaListItemWithThumbnail extends MediaListItem {
  /** 署名付き URL（1 時間）。署名できなければ null */
  thumbnail_url: string | null;
}

/** 1 ページ分の投稿（サムネイルの署名なし）。`page` は `parsePage` で正規化済みの 1 以上の整数 */
export const listMedia = cache(async (page: number): Promise<QueryResult<MediaPage>> => {
  await markDynamic();
  const env = readEnv();
  if (!env.ok) return { ok: false, reason: configMissingReason(env.missing) };
  const safePage = Number.isSafeInteger(page) && page >= 1 ? page : 1;
  const offset = (safePage - 1) * PAGE_SIZE;
  try {
    const db = getDb(env.env.databaseUrl);
    const rows = await db<MediaListItem[]>`
      select
        id, media_type, media_product_type, posted_at, permalink, thumbnail_path, gone_at,
        metrics_fetched_at, elapsed_seconds, metrics
      from public.media_latest_metrics
      where media_product_type <> 'STORY'
      order by posted_at desc, id desc
      limit ${PAGE_SIZE + 1} offset ${offset}
    `;
    const items = [...rows];
    return { ok: true, data: { page: safePage, items: items.slice(0, PAGE_SIZE), hasNext: items.length > PAGE_SIZE } };
  } catch (e) {
    return { ok: false, reason: describeDbError(e) };
  }
});

/** 1 ページ分の投稿に署名付き URL を付ける。署名に失敗してもページは返す */
export const getMediaPage = cache(async (page: number): Promise<QueryResult<MediaPage<MediaListItemWithThumbnail>>> => {
  const list = await listMedia(page);
  if (!list.ok) return list;
  const env = readEnv();
  const paths = list.data.items.map((m) => m.thumbnail_path).filter((p): p is string => typeof p === "string");
  const signed = env.ok && paths.length > 0 ? await signThumbnailUrls(env.env, paths) : new Map<string, string>();
  const items = list.data.items.map((m) => ({
    ...m,
    thumbnail_url: m.thumbnail_path === null ? null : (signed.get(m.thumbnail_path) ?? null),
  }));
  return { ok: true, data: { page: list.data.page, items, hasNext: list.data.hasNext } };
});
