/**
 * `video_analyses`、`video_cuts`（設計 3.4 章、5.6 章、10.2 章。DB 設計 5 章）。
 *
 * - 解析結果 1 本は「`video_analyses` 1 行 ＋ `video_cuts` 全行」で 1 トランザクション。`upsertVideoAnalysis` は
 *   `Tx` で呼ぶ
 * - 一意キーは (media_id, analyzer_version, scene_threshold)。同じ条件で解析し直したら全列を上書きし、
 *   `video_cuts` はその `analysis_id` の行をすべて消してから入れ直す
 * - `numeric`（`scene_threshold`、`fps`、`scene_score`）と計測値の `bigint`（`bitrate`、`file_size`）は
 *   postgres.js では文字列で返るので、読み出しで `Number()` に変換する（設計 3.5 章、13.2 章）。
 *   書くときは数値をそのまま渡す（型は Postgres が列から推定する）
 * - ID 列の `bigint`（`id`、`analysis_id`）は文字列のまま
 * - この層はログを出さず、`error` 列の文字列も加工しない。呼び出し側がマスク済みの文字列を渡す
 */
import type { Db, Tx } from "./client.js";
import type { VideoAnalysisRow, VideoAnalysisStatus, VideoCutRow } from "./types.js";

/** `video_analyses` に書く行（`id` は自動採番） */
export type VideoAnalysisInsert = Omit<VideoAnalysisRow, "id">;

/** `video_cuts` に書く行（`analysis_id` は upsert した `video_analyses.id` を使う） */
export type VideoCutInsert = Omit<VideoCutRow, "analysis_id">;

/** `latestAnalysis` の戻り値。再試行の判定（`isAnalysisRetryDue`）に必要な列だけ */
export interface VideoAnalysisSummary {
  status: VideoAnalysisStatus;
  analyzed_at: Date;
}

/** postgres.js が返す形（`numeric` と計測値の `bigint` は文字列） */
interface RawVideoAnalysisRow {
  id: string;
  media_id: string;
  analyzer_version: string;
  scene_threshold: string;
  status: VideoAnalysisStatus;
  error: string | null;
  analyzed_at: Date;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  fps: string | null;
  bitrate: string | null;
  file_size: string | null;
  has_audio: boolean | null;
  cut_count: number | null;
  avg_scene_ms: number | null;
  first_cut_ms: number | null;
  cuts_in_first_3s: number | null;
}

interface RawVideoCutRow {
  analysis_id: string;
  seq: number;
  at_ms: number;
  scene_score: string | null;
}

function toNumberOrNull(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function toVideoAnalysisRow(raw: RawVideoAnalysisRow): VideoAnalysisRow {
  return {
    id: raw.id,
    media_id: raw.media_id,
    analyzer_version: raw.analyzer_version,
    scene_threshold: Number(raw.scene_threshold),
    status: raw.status,
    error: raw.error,
    analyzed_at: raw.analyzed_at,
    duration_ms: raw.duration_ms,
    width: raw.width,
    height: raw.height,
    fps: toNumberOrNull(raw.fps),
    bitrate: toNumberOrNull(raw.bitrate),
    file_size: toNumberOrNull(raw.file_size),
    has_audio: raw.has_audio,
    cut_count: raw.cut_count,
    avg_scene_ms: raw.avg_scene_ms,
    first_cut_ms: raw.first_cut_ms,
    cuts_in_first_3s: raw.cuts_in_first_3s,
  };
}

function toVideoCutRow(raw: RawVideoCutRow): VideoCutRow {
  return {
    analysis_id: raw.analysis_id,
    seq: raw.seq,
    at_ms: raw.at_ms,
    scene_score: toNumberOrNull(raw.scene_score),
  };
}

/**
 * 解析結果を (media_id, analyzer_version, scene_threshold) で upsert し（衝突したら全列を上書き）、
 * `video_cuts` をその `analysis_id` で消してから `cuts` を全行入れる。`video_analyses.id`（文字列）を返す。
 * トランザクションの中で呼ぶこと（1 本分の結果が途中の状態で残らないように）
 */
export async function upsertVideoAnalysis(
  tx: Tx,
  row: VideoAnalysisInsert,
  cuts: VideoCutInsert[],
): Promise<string> {
  const rows = await tx<{ id: string }[]>`
    insert into public.video_analyses
      (media_id, analyzer_version, scene_threshold, status, error, analyzed_at,
       duration_ms, width, height, fps, bitrate, file_size, has_audio,
       cut_count, avg_scene_ms, first_cut_ms, cuts_in_first_3s)
    values
      (${row.media_id}, ${row.analyzer_version}, ${row.scene_threshold}, ${row.status}, ${row.error}, ${row.analyzed_at},
       ${row.duration_ms}, ${row.width}, ${row.height}, ${row.fps}, ${row.bitrate}, ${row.file_size}, ${row.has_audio},
       ${row.cut_count}, ${row.avg_scene_ms}, ${row.first_cut_ms}, ${row.cuts_in_first_3s})
    on conflict (media_id, analyzer_version, scene_threshold) do update set
      status = excluded.status,
      error = excluded.error,
      analyzed_at = excluded.analyzed_at,
      duration_ms = excluded.duration_ms,
      width = excluded.width,
      height = excluded.height,
      fps = excluded.fps,
      bitrate = excluded.bitrate,
      file_size = excluded.file_size,
      has_audio = excluded.has_audio,
      cut_count = excluded.cut_count,
      avg_scene_ms = excluded.avg_scene_ms,
      first_cut_ms = excluded.first_cut_ms,
      cuts_in_first_3s = excluded.cuts_in_first_3s
    returning id
  `;
  const inserted = rows[0];
  if (!inserted) throw new Error("video_analyses の upsert が id を返さなかった");
  const analysisId = inserted.id;

  await tx`delete from public.video_cuts where analysis_id = ${analysisId}`;
  if (cuts.length > 0) {
    const cutRows = cuts.map((cut) => ({
      analysis_id: analysisId,
      seq: cut.seq,
      at_ms: cut.at_ms,
      scene_score: cut.scene_score,
    }));
    await tx`insert into public.video_cuts ${tx(cutRows, "analysis_id", "seq", "at_ms", "scene_score")}`;
  }
  return analysisId;
}

/**
 * 同じ解析条件の結果の `status` と `analyzed_at`。なければ undefined。
 * 一意キーなので 1 行しかない（「最新」は同じ条件で解析し直した結果のこと）
 */
export async function latestAnalysis(
  db: Db,
  mediaId: string,
  version: string,
  threshold: number,
): Promise<VideoAnalysisSummary | undefined> {
  const rows = await db<{ status: VideoAnalysisStatus; analyzed_at: Date }[]>`
    select status, analyzed_at
    from public.video_analyses
    where media_id = ${mediaId} and analyzer_version = ${version} and scene_threshold = ${threshold}
  `;
  const row = rows[0];
  if (!row) return undefined;
  return { status: row.status, analyzed_at: row.analyzed_at };
}

/**
 * 解析結果 1 本をカットごと読む（テストと実機確認用）。`numeric` と計測値の `bigint` は `number` に変換済み。
 * カットは `seq` 順。なければ undefined
 */
export async function getVideoAnalysis(
  db: Db,
  mediaId: string,
  version: string,
  threshold: number,
): Promise<{ row: VideoAnalysisRow; cuts: VideoCutRow[] } | undefined> {
  const rows = await db<RawVideoAnalysisRow[]>`
    select id, media_id, analyzer_version, scene_threshold, status, error, analyzed_at,
           duration_ms, width, height, fps, bitrate, file_size, has_audio,
           cut_count, avg_scene_ms, first_cut_ms, cuts_in_first_3s
    from public.video_analyses
    where media_id = ${mediaId} and analyzer_version = ${version} and scene_threshold = ${threshold}
  `;
  const raw = rows[0];
  if (!raw) return undefined;
  const cutRows = await db<RawVideoCutRow[]>`
    select analysis_id, seq, at_ms, scene_score
    from public.video_cuts
    where analysis_id = ${raw.id}
    order by seq
  `;
  return { row: toVideoAnalysisRow(raw), cuts: cutRows.map(toVideoCutRow) };
}
