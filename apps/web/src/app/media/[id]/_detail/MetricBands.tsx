import { Callout } from "@/components/Callout";
import { Card } from "@/components/Card";
import { BandRow } from "@/components/charts/BandRow";
import { Legend } from "@/components/charts/Legend";
import { MetricHint } from "@/components/MetricHint";
import { MissingValue } from "@/components/MissingValue";
import { formatValue, type ValueFormat } from "@/lib/format";
import { METRIC_DEFINITIONS } from "@/lib/metric-definitions";
import {
  kindColor,
  MISSING_REASON_TEXT,
  ratioMissing,
  reachRateMissing,
  valueMissing,
  type Missing,
} from "@/lib/metrics";
import {
  getPeerStats,
  getVideoFeatures,
  type MediaDetail,
  type MetricPeerStats,
  type PeerMetric,
  type VideoFeatures,
} from "@/lib/queries/media-detail";
import { retentionMissing } from "@/lib/video-timeline";

/** 帯グラフの viewBox の幅（6 列のカードで指標名と値の列を除いた幅） */
const BAND_WIDTH = 340;

/** 帯グラフの 1 行の中身 */
interface BandRowDef {
  key: PeerMetric;
  value: number | null;
  missing: Missing | null;
  format: ValueFormat;
  /** 低いほどよい指標。帯グラフの向きを逆にして「右ほどよい」にそろえる */
  reverse?: boolean;
}

/** いいね + コメント + 保存 + シェア。どれかが null なら null（ER の分子） */
function engagementSum(m: MediaDetail): number | null {
  const parts = [m.likes, m.comments, m.saved, m.shares];
  return parts.every((v): v is number => typeof v === "number") ? parts.reduce((a, b) => a + b, 0) : null;
}

/** 量の指標の行（3.4 節の順） */
export function quantityRows(m: MediaDetail): BandRowDef[] {
  const k = m.kind;
  return [
    { key: "reach", value: m.reach, missing: valueMissing("reach", k, m.reach), format: "count" },
    { key: "views", value: m.views, missing: valueMissing("views", k, m.views), format: "count" },
    { key: "likes", value: m.likes, missing: valueMissing("likes", k, m.likes), format: "count" },
    { key: "saved", value: m.saved, missing: valueMissing("saved", k, m.saved), format: "count" },
    { key: "shares", value: m.shares, missing: valueMissing("shares", k, m.shares), format: "count" },
    {
      key: "profile_visits",
      value: m.profile_visits,
      missing: valueMissing("profile_visits", k, m.profile_visits),
      format: "count",
    },
    { key: "follows", value: m.follows, missing: valueMissing("follows", k, m.follows), format: "count" },
    {
      key: "avg_watch_time_s",
      // API の値はミリ秒。秒に直して表示する
      value: m.avg_watch_time_ms === null ? null : m.avg_watch_time_ms / 1000,
      missing: valueMissing("avg_watch_time_ms", k, m.avg_watch_time_ms),
      format: "seconds",
    },
  ];
}

/**
 * 質の指標の行（3.4 節の順。末尾の 2 行は確認事項 Q14 の推奨）。
 * 視聴維持率は動画の特徴量（R4 設計 6.1 節）。`video` が null（動画でない、読み出せない）なら値なし
 */
export function qualityRows(m: MediaDetail, video: VideoFeatures | null = null): BandRowDef[] {
  const k = m.kind;
  return [
    {
      key: "reach_rate",
      value: m.reach_rate,
      missing: reachRateMissing({
        kind: k,
        elapsedLatestHours: m.elapsed_latest === null ? null : m.elapsed_latest / 3600,
        reach7d: m.reach_7d,
        followersAtPost: m.followers_at_post,
      }),
      format: "percent",
    },
    { key: "save_rate", value: m.save_rate, missing: ratioMissing("save_rate", k, m.saved, m.reach), format: "percent" },
    { key: "share_rate", value: m.share_rate, missing: ratioMissing("share_rate", k, m.shares, m.reach), format: "percent" },
    { key: "like_rate", value: m.like_rate, missing: ratioMissing("like_rate", k, m.likes, m.reach), format: "percent" },
    { key: "er", value: m.er, missing: ratioMissing("er", k, engagementSum(m), m.reach), format: "percent" },
    {
      key: "retention_rate",
      value: video?.retention_rate ?? null,
      // 特徴量の行が読めない（動画でない、読み出しの失敗）ときは欠損として扱う（種類で取れないものは unsupported が先）
      missing: retentionMissing({
        kind: k,
        analysisStatus: video === null ? "failed" : video.analysis_status,
        durationMs: video?.duration_ms ?? null,
        value: video?.retention_rate ?? null,
      }),
      format: "percent",
    },
    {
      key: "skip_rate",
      value: m.skip_rate,
      missing: valueMissing("skip_rate", k, m.skip_rate),
      format: "percent",
      reverse: true,
    },
    {
      key: "profile_visit_rate",
      value: m.profile_visit_rate,
      missing: ratioMissing("profile_visit_rate", k, m.profile_visits, m.reach),
      format: "percent",
    },
    {
      key: "follow_conversion_rate",
      value: m.follow_conversion_rate,
      missing: ratioMissing("follow_conversion_rate", k, m.follows, m.profile_visits),
      format: "percent",
    },
  ];
}

/** 判定では値を出せるのに値がない（ビューと判定の食い違い）ときは欠損として扱う */
function effectiveMissing(row: BandRowDef): Missing | null {
  if (row.missing !== null) return row.missing;
  if (typeof row.value !== "number" || !Number.isFinite(row.value)) {
    return { reason: "missing", text: MISSING_REASON_TEXT.missing };
  }
  return null;
}

/** 帯グラフの凡例（見本の `LEG`） */
function BandLegend({ color }: { color: string }) {
  return (
    <Legend
      items={[
        { label: "この投稿", color },
        { label: "中央値", shape: "dash" },
        { label: "25〜75% の範囲", color: "color-mix(in oklab, #3aa6dd 22%, var(--color-surface))" },
      ]}
    />
  );
}

/** 指標名・この投稿の値・帯グラフの行の並び（見本の `cmpRow` の subgrid） */
function BandRows({ rows, stats, color }: { rows: BandRowDef[]; stats: Record<PeerMetric, MetricPeerStats>; color: string }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "max-content max-content minmax(0, 1fr)", columnGap: 12 }}>
      {rows.map((row) => {
        const text = METRIC_DEFINITIONS[row.key];
        const missing = effectiveMissing(row);
        const peer = stats[row.key];
        return (
          <div
            key={row.key}
            style={{ display: "grid", gridColumn: "1 / -1", gridTemplateColumns: "subgrid", alignItems: "center", padding: "4px 0" }}
          >
            <span className="small">
              <MetricHint label={text.label} text={text.hint} />
            </span>
            <b className="num right">{missing === null ? formatValue(row.value, row.format) : <MissingValue missing={missing} />}</b>
            <div className="chart">
              <BandRow
                label={text.label}
                value={missing === null ? row.value : null}
                stats={peer}
                format={row.format}
                width={BAND_WIDTH}
                color={color}
                reverse={row.reverse}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** カードの中身の共通部分（スナップショットなし、読み出しの失敗） */
async function BandCard({
  title,
  media,
  rows,
  foot,
}: {
  title: string;
  media: MediaDetail;
  rows: (m: MediaDetail, video: VideoFeatures | null) => BandRowDef[];
  foot?: string;
}) {
  if (media.latest_fetched_at === null) {
    return (
      <Card title={title} className="col-6">
        <p className="small muted">指標はまだ取得されていません</p>
      </Card>
    );
  }
  // 動画の投稿（リールとフィード動画）だけ特徴量を読む。読み出せなければ視聴維持率は「取得できなかった」
  const [peers, video] = await Promise.all([
    getPeerStats(media.account_id, media.kind, media.media_id),
    media.media_type === "VIDEO" ? getVideoFeatures(media.account_id, media.media_id) : null,
  ]);
  if (!peers.ok) {
    return (
      <Card title={title} className="col-6">
        <Callout state="bad">読み出せません（{peers.reason}）</Callout>
      </Card>
    );
  }
  const color = kindColor(media.kind);
  return (
    <Card title={title} className="col-6" foot={foot}>
      <BandLegend color={color} />
      <BandRows rows={rows(media, video !== null && video.ok ? video.data : null)} stats={peers.data.stats} color={color} />
    </Card>
  );
}

/** 量の指標（6 列のカード） */
export function QuantityCard({ media }: { media: MediaDetail }) {
  return <BandCard title="量の指標" media={media} rows={quantityRows} />;
}

/** 質の指標（6 列のカード） */
export function QualityCard({ media }: { media: MediaDetail }) {
  return (
    <BandCard
      title="質の指標"
      media={media}
      rows={qualityRows}
      foot="右ほどよい。スキップ率は低いほどよいので、向きを逆にしている。"
    />
  );
}
