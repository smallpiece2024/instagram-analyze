/**
 * シーン検出のしきい値を決めるための手元のコマンド（`worker video-tune <media-id> [...] [--thresholds 0.2,0.3]`。
 * R4 設計 4 章）。
 *
 * 1. 環境変数 `CI` か `GITHUB_ACTIONS` があれば何もせず終わる（公開ログに投稿の情報を出さない）。最初に接続先の DB の
 *    ホスト名を 1 行出す（手元か本番かを目で確かめる）
 * 2. ID を `isMediaId` で確かめ、`media_url` を取り直し（`persist: false`。生の応答も保存しない）、一時ファイルに落とす
 *    （`content-type` が `video/`、200 MB、60 秒、許可するホスト）
 * 3. シーン検出を低いしきい値（`TUNE_BASE_THRESHOLD` = 0.1）で 1 回だけ走らせ、各フレームの時刻と点数を取る
 *    （点数は直前のフレームとの比較なので、0.1 で選んだ後にしきい値で絞っても、しきい値ごとに走らせた結果と同じ）
 * 4. しきい値ごとに `score > t`（本番の `gt` と同じ「より大きい」）のカットの数と時刻（秒、小数 1 桁）を標準出力に出す
 * 5. DB には書かない（`job_runs` も `raw_api_responses` も書かない）。一時ディレクトリは `finally` で消す
 *
 * - 出力に投稿の ID と URL は出さない（引数の何番目かで示す）。例外は固定文言かマスク済みの 1 行だけ
 * - トークンはこのモジュールの中（`GraphClient`）にだけ置き、`processSecrets` に登録する
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { isCiEnvironment, loadWorkerConfig, type WorkerConfig } from "../config.js";
import { readCredential } from "../db/accounts.js";
import type { Db } from "../db/client.js";
import { closeJobDeps, createJobDeps, describeError, TMP_DIR_PREFIX } from "../jobs/framework.js";
import { createJobGraphClient, type JobGraphClient } from "../jobs/graph-client.js";
import { isMediaId } from "../jobs/media-sync.js";
import { RateMonitor } from "../jobs/rate.js";
import { videoDownloadLimits } from "../jobs/video-store.js";
import { downloadToFile } from "../lib/download.js";
import { detectScenes, probeVideo, sceneDetectTimeoutMs, type SceneChange } from "../lib/ffmpeg.js";
import { GraphClient } from "../lib/graph.js";
import { MAX_VIDEO_DURATION_MS, VIDEO_CONTENT_TYPE_PREFIX } from "../lib/video-analysis.js";

/** 1 回だけ走らせるシーン検出のしきい値（これより大きいフレームを全部拾い、しきい値ごとに絞る） */
export const TUNE_BASE_THRESHOLD = 0.1;
/** `--thresholds` の既定値 */
export const DEFAULT_TUNE_THRESHOLDS: readonly number[] = [0.2, 0.25, 0.3, 0.4, 0.5];

export const TUNE_ARGS_ERROR = "引数が不正（worker video-tune <media-id> [<media-id> ...] [--thresholds 0.2,0.3]）";
export const TUNE_ID_ERROR = "メディア ID の形が不正（数字だけ）";
export const TUNE_THRESHOLDS_ERROR = `--thresholds は ${TUNE_BASE_THRESHOLD} より大きく 1 未満の数をカンマ区切りで`;
export const TUNE_CI_MESSAGE = "CI では video-tune を動かさない（公開ログに投稿の情報が出るため）";

export interface TuneArgs {
  mediaIds: string[];
  thresholds: number[];
}

export type ParsedTuneArgs = { ok: true; args: TuneArgs } | { ok: false; error: string };

/**
 * 引数を読む純粋関数。位置引数はメディア ID（数字だけ、1 本以上）、`--thresholds` はカンマ区切りの数
 * （`TUNE_BASE_THRESHOLD` より大きく 1 未満。昇順に並べ、重複を除く）。エラーは固定文言（値は含めない）
 */
export function parseTuneArgs(argv: string[]): ParsedTuneArgs {
  let values: { thresholds?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: { thresholds: { type: "string" } },
      strict: true,
      allowPositionals: true,
    }));
  } catch {
    return { ok: false, error: TUNE_ARGS_ERROR };
  }
  if (positionals.length === 0) return { ok: false, error: TUNE_ARGS_ERROR };
  if (!positionals.every((id) => /^\d+$/.test(id) && isMediaId(id))) return { ok: false, error: TUNE_ID_ERROR };

  let thresholds = [...DEFAULT_TUNE_THRESHOLDS];
  if (values.thresholds !== undefined) {
    const parts = values.thresholds.split(",").map((p) => p.trim());
    if (parts.some((p) => !/^\d*\.?\d+$/.test(p))) return { ok: false, error: TUNE_THRESHOLDS_ERROR };
    const nums = parts.map(Number);
    if (nums.some((t) => !(t > TUNE_BASE_THRESHOLD && t < 1))) return { ok: false, error: TUNE_THRESHOLDS_ERROR };
    thresholds = [...new Set(nums)].sort((a, b) => a - b);
  }
  return { ok: true, args: { mediaIds: positionals, thresholds } };
}

export interface ThresholdRow {
  threshold: number;
  /** `score > threshold` のフレームの数 */
  count: number;
  /** その時刻（秒、小数 1 桁の文字列。時刻の順） */
  timesSec: string[];
}

/**
 * しきい値ごとの集計（純粋関数）。`score > t`（ちょうど t は含めない。本番の `gt` と同じ）のフレームを時刻の順に数える。
 * 点数が null のフレームは数えない
 */
export function summarizeByThreshold(changes: readonly SceneChange[], thresholds: readonly number[]): ThresholdRow[] {
  const sorted = [...changes].sort((a, b) => a.atMs - b.atMs);
  return thresholds.map((threshold) => {
    const picked = sorted.filter((c) => c.score !== null && c.score > threshold);
    return { threshold, count: picked.length, timesSec: picked.map((c) => (c.atMs / 1000).toFixed(1)) };
  });
}

/** 集計を表の行にする（純粋関数） */
export function formatThresholdTable(rows: readonly ThresholdRow[]): string[] {
  const lines = ["  しきい値  カット数  時刻（秒）"];
  for (const row of rows) {
    lines.push(
      `  ${row.threshold.toFixed(2).padEnd(8)}  ${String(row.count).padStart(8)}  ${row.timesSec.length > 0 ? row.timesSec.join(", ") : "—"}`,
    );
  }
  return lines;
}

/** 取り直しの応答の形 */
interface MediaVideoFields {
  media_type?: unknown;
  media_url?: unknown;
}

/** テスト用の差し替え */
export interface VideoTuneDeps {
  /** 環境変数（CI の判定）。省略時は `process.env`（`config.ts` が読む） */
  env?: Record<string, string | undefined>;
  /** 標準出力の 1 行。省略時は `process.stdout` */
  out?: (line: string) => void;
}

/** 投稿の `account_id`（手元の DB にある投稿だけを扱う）。なければ undefined */
async function mediaAccountId(db: Db, mediaId: string): Promise<string | undefined> {
  const rows = await db<{ account_id: string }[]>`select account_id from public.media where id = ${mediaId}`;
  return rows[0]?.account_id;
}

/** DB に書かない Graph API のクライアント（`persist: false` で呼ぶ。`persistRaw` は使われない） */
function createTuneGraph(token: string, config: WorkerConfig): JobGraphClient {
  return createJobGraphClient({
    graph: new GraphClient(token, config.graphApiVersion, 200, fetch, undefined, config.metaAppSecret),
    rate: new RateMonitor(),
    rateThreshold: config.rateHardLimit,
    appToken: `${config.metaAppId}|${config.metaAppSecret}`,
    persistRaw: () => Promise.reject(new Error("video-tune は生の応答を保存しない")),
    onApiCall: () => undefined,
    onAuthError: () => Promise.resolve(),
  });
}

/** 1 本分: 取り直し → ダウンロード → ffprobe → 低いしきい値で 1 回検出。表示用の文言か、検出結果を返す */
async function analyzeForTune(
  graph: JobGraphClient,
  mediaId: string,
  config: WorkerConfig,
): Promise<{ durationMs: number; changes: SceneChange[] } | { error: string }> {
  const res = await graph.get<MediaVideoFields>(mediaId, { fields: "id,media_type,media_url" }, { persist: false });
  if (!res.ok || !res.data) return { error: `メディア情報の取得に失敗（code ${res.error?.code ?? "なし"}）` };
  if (res.data.media_type !== "VIDEO") return { error: "動画ではない" };
  const url = typeof res.data.media_url === "string" && res.data.media_url !== "" ? res.data.media_url : undefined;
  if (!url) return { error: "media_url が返らなかった" };

  const dir = await mkdtemp(join(tmpdir(), `${TMP_DIR_PREFIX}tune-`));
  try {
    const file = join(dir, "video.mp4");
    await downloadToFile(
      url,
      file,
      { ...videoDownloadLimits(config.downloadAllowedHosts), contentTypePrefix: VIDEO_CONTENT_TYPE_PREFIX },
      fetch,
    );
    const probe = await probeVideo(file);
    if (probe.durationMs > MAX_VIDEO_DURATION_MS) return { error: "動画が長すぎる（15 分を超える）" };
    const changes = await detectScenes(file, TUNE_BASE_THRESHOLD, sceneDetectTimeoutMs(probe.durationMs));
    return { durationMs: probe.durationMs, changes };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** `worker video-tune` の本体。CI では何もせず true。引数の不備は固定文言の例外 */
export async function videoTune(argv: string[], deps: VideoTuneDeps = {}): Promise<boolean> {
  const out = deps.out ?? ((line: string) => void process.stdout.write(`${line}\n`));
  if (isCiEnvironment(deps.env)) {
    out(TUNE_CI_MESSAGE);
    return true;
  }
  const parsed = parseTuneArgs(argv);
  if (!parsed.ok) throw new Error(parsed.error);
  const { mediaIds, thresholds } = parsed.args;

  const config = loadWorkerConfig();
  out(`DB のホスト: ${new URL(config.databaseUrl).hostname}`);
  const jobDeps = createJobDeps(config);
  let allOk = true;
  try {
    for (const [index, mediaId] of mediaIds.entries()) {
      const label = `動画 ${index + 1}/${mediaIds.length}（引数の ${index + 1} 番目）`;
      try {
        const accountId = await mediaAccountId(jobDeps.db, mediaId);
        if (!accountId) {
          out(`${label}: 手元の DB にない投稿`);
          allOk = false;
          continue;
        }
        const credential = await readCredential(jobDeps.db, accountId);
        if (!credential) {
          out(`${label}: 認証情報がない`);
          allOk = false;
          continue;
        }
        jobDeps.secrets.add(credential.token);
        const result = await analyzeForTune(createTuneGraph(credential.token, config), mediaId, config);
        if ("error" in result) {
          out(`${label}: ${result.error}`);
          allOk = false;
          continue;
        }
        out(`${label}: 長さ ${(result.durationMs / 1000).toFixed(1)} 秒、score > ${TUNE_BASE_THRESHOLD} のフレーム ${result.changes.length}`);
        for (const line of formatThresholdTable(summarizeByThreshold(result.changes, thresholds))) out(line);
      } catch (error) {
        // RateLimitExceeded、AuthError、DownloadError、CommandError など。固定文言かマスク済みの 1 行だけ出す
        const failure = describeError(error, jobDeps.secrets);
        out(`${label}: 失敗（${failure.errorClass}、code ${failure.code ?? "なし"}）`);
        allOk = false;
      }
    }
  } finally {
    await closeJobDeps(jobDeps);
  }
  return allOk;
}
