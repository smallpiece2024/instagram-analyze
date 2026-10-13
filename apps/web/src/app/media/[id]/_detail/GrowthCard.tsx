import { Callout } from "@/components/Callout";
import { Card } from "@/components/Card";
import { Legend } from "@/components/charts/Legend";
import { LineChart } from "@/components/charts/LineChart";
import { MetricHint } from "@/components/MetricHint";
import { MissingValue } from "@/components/MissingValue";
import { SpecialTags } from "@/components/TypeTag";
import { EMPTY, formatCount, formatDecimal, formatPercent } from "@/lib/format";
import { METRIC_DEFINITIONS } from "@/lib/metric-definitions";
import {
  baselineDisplay,
  baselineNote,
  kindColor,
  type Missing,
  MISSING_REASON_TEXT,
  multipleOfMedian,
} from "@/lib/metrics";
import {
  getMediaHorizons,
  getOutlierFlag,
  getPeerHorizonStats,
  getPeerStats,
  GROWTH_HORIZONS,
  type MediaDetail,
} from "@/lib/queries/media-detail";
import { HORIZON_LABEL, topPercent } from "./text";

/** 12 列のカードの viewBox の幅 */
const CHART_WIDTH = 1140;

/** 印の比較対象の四分位がない（比較対象が 0 件）ときの「—」の理由 */
const NO_PEER_QUARTILE: Missing = { reason: "no_baseline_data", text: MISSING_REASON_TEXT.no_baseline_data };

/** 印の比較対象のシェア率の四分位 1 つ（% か「—」） */
function ShareQuartile({ v }: { v: number | null }) {
  return v === null ? <MissingValue missing={NO_PEER_QUARTILE} /> : <>{formatPercent(v)}</>;
}

/**
 * リーチ数の伸び方（12 列のカード。R3 設計 3.4 節）。
 * X 軸は経過時間の区分を等間隔に置く。`within_tolerance` が偽の区分とまだ到達していない区分は点を描かず線を切る。
 * 中央値と帯は、同じ種類のほかの投稿の許容内の値から作る。上の 2 つの数字は最新の値どうしで比べる。
 * 伸びた／課題の印の行（R6 設計 6.3 節 U13）は比較対象が違う（同じ種類の直前の投稿のシェア率）ので、倍率の行に件数を添えて区別する
 */
export async function GrowthCard({ media }: { media: MediaDetail }) {
  const title = "リーチ数の伸び方";
  if (media.latest_fetched_at === null) {
    return (
      <Card title={title} className="col-12">
        <p className="small muted">指標はまだ取得されていません</p>
      </Card>
    );
  }
  const [own, peerH, peers, flag] = await Promise.all([
    getMediaHorizons(media.account_id, media.media_id),
    getPeerHorizonStats(media.account_id, media.kind, media.media_id),
    getPeerStats(media.account_id, media.kind, media.media_id),
    getOutlierFlag(media.account_id, media.media_id),
  ]);
  const failed = [own, peerH, peers, flag].find((r) => !r.ok);
  if (failed && !failed.ok) {
    return (
      <Card title={title} className="col-12">
        <Callout state="bad">読み出せません（{failed.reason}）</Callout>
      </Card>
    );
  }
  if (!own.ok || !peerH.ok || !peers.ok || !flag.ok) return null;

  const color = kindColor(media.kind);
  const labels = GROWTH_HORIZONS.map((h) => HORIZON_LABEL[h] ?? h);
  const ownBy = new Map(own.data.map((p) => [p.horizon, p]));
  const peerBy = new Map(peerH.data.map((p) => [p.horizon, p]));

  // この投稿の線: 許容内の点だけ
  const values = GROWTH_HORIZONS.map((h) => {
    const p = ownBy.get(h);
    return p && p.within_tolerance && typeof p.reach === "number" ? p.reach : null;
  });
  // 中央値は比較相手が 1 件以上、帯は 3 件以上（3.1 節の件数による出し方）
  const median = GROWTH_HORIZONS.map((h) => {
    const p = peerBy.get(h);
    return p && baselineDisplay(p.n) !== "none" ? p.median : null;
  });
  const lower = GROWTH_HORIZONS.map((h) => {
    const p = peerBy.get(h);
    return p && baselineDisplay(p.n) !== "none" && baselineDisplay(p.n) !== "range_only" ? p.p25 : null;
  });
  const upper = GROWTH_HORIZONS.map((h, i) => (lower[i] === null ? null : (peerBy.get(h)?.p75 ?? null)));
  // 比較相手が 3〜9 件の区分は中央値と帯を薄く描く（3.1 節の件数による出し方）
  const dimIndexes = GROWTH_HORIZONS.flatMap((h, i) => {
    const p = peerBy.get(h);
    return p && baselineDisplay(p.n) === "faint" ? [i] : [];
  });
  const hasPeers = median.some((v) => v !== null);
  const hasBand = lower.some((v) => v !== null);

  const lastValue = [...values].reverse().find((v): v is number => v !== null);

  const reachStats = peers.data.stats.reach;
  const multiple = multipleOfMedian(media.reach, reachStats.n > 0 ? reachStats.median : null);
  const top = topPercent(media.reach === null ? null : peers.data.reachGreater, reachStats.n);

  return (
    <Card title={title} className="col-12">
      <Legend
        items={[
          { label: "この投稿", color },
          ...(hasPeers ? [{ label: "中央値", shape: "dash" as const }] : []),
          ...(hasBand ? [{ label: "25〜75% の範囲", color: "color-mix(in oklab, #3aa6dd 22%, var(--color-surface))" }] : []),
        ]}
      />
      <div className="metrics-row" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))", margin: "0 0 var(--gap)" }}>
        <div>
          <span style={{ display: "block" }}>中央値に対する倍率</span>
          <b>
            {multiple === null ? EMPTY : `${formatDecimal(multiple, 1)} 倍`}
            <span className="xs muted">（同じ種類 {reachStats.n} 件）</span>
          </b>
        </div>
        <div>
          <span style={{ display: "block" }}>同じ種類の中の順位</span>
          <b>
            {top === null ? (
              EMPTY
            ) : (
              <>
                上位 {top.percent}%<span className="xs muted">（{top.of} 件中 {top.rank} 位）</span>
              </>
            )}
          </b>
        </div>
      </div>
      {flag.data !== null && (
        // 行の形は固定。印（pill）は high／low のときだけ出る（none と null は `SpecialTags` が何も描かない）
        <p className="small">
          <MetricHint label={`直前の同種 ${flag.data.peer_n} 件のシェア率`} text={METRIC_DEFINITIONS.share_flag.hint} />
          : 中央値 <ShareQuartile v={flag.data.peer_median} /> ・ Q1 <ShareQuartile v={flag.data.peer_q1} /> ・ Q3{" "}
          <ShareQuartile v={flag.data.peer_q3} /> <SpecialTags shareFlag={flag.data.share_flag} />
        </p>
      )}
      {!hasPeers && <p className="small muted">{baselineNote(0)}</p>}
      <div className="chart">
        <LineChart
          title={`${title}: この投稿のリーチ数（経過時間の区分ごと）`}
          labels={labels}
          band={hasBand ? { lower, upper, label: "25〜75%", dimIndexes } : undefined}
          series={[
            ...(hasPeers ? [{ label: "中央値", values: median, dashed: true, dimIndexes }] : []),
            {
              label: "この投稿",
              values,
              color,
              dots: true,
              endLabel: lastValue === undefined ? undefined : formatCount(lastValue),
            },
          ]}
          width={CHART_WIDTH}
          height={220}
        />
      </div>
    </Card>
  );
}
