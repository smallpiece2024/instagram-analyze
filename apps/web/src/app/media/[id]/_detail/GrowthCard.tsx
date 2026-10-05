import { Callout } from "@/components/Callout";
import { Card } from "@/components/Card";
import { Legend } from "@/components/charts/Legend";
import { LineChart } from "@/components/charts/LineChart";
import { EMPTY, formatCount, formatDecimal } from "@/lib/format";
import { baselineDisplay, baselineNote, kindColor, multipleOfMedian } from "@/lib/metrics";
import {
  getMediaHorizons,
  getPeerHorizonStats,
  getPeerStats,
  GROWTH_HORIZONS,
  type MediaDetail,
} from "@/lib/queries/media-detail";
import { HORIZON_LABEL, topPercent } from "./text";

/** 12 列のカードの viewBox の幅 */
const CHART_WIDTH = 1140;

/**
 * リーチの伸び方（12 列のカード。R3 設計 3.4 節）。
 * X 軸は経過時間の区分を等間隔に置く。`within_tolerance` が偽の区分とまだ到達していない区分は点を描かず線を切る。
 * 中央値と帯は、同じ種類のほかの投稿の許容内の値から作る。上の 2 つの数字は最新の値どうしで比べる
 */
export async function GrowthCard({ media }: { media: MediaDetail }) {
  const title = "リーチの伸び方";
  if (media.latest_fetched_at === null) {
    return (
      <Card title={title} className="col-12">
        <p className="small muted">指標はまだ取得されていません</p>
      </Card>
    );
  }
  const [own, peerH, peers] = await Promise.all([
    getMediaHorizons(media.account_id, media.media_id),
    getPeerHorizonStats(media.account_id, media.kind, media.media_id),
    getPeerStats(media.account_id, media.kind, media.media_id),
  ]);
  const failed = [own, peerH, peers].find((r) => !r.ok);
  if (failed && !failed.ok) {
    return (
      <Card title={title} className="col-12">
        <Callout state="bad">読み出せません（{failed.reason}）</Callout>
      </Card>
    );
  }
  if (!own.ok || !peerH.ok || !peers.ok) return null;

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
          <b>{multiple === null ? EMPTY : `${formatDecimal(multiple, 1)} 倍`}</b>
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
      {!hasPeers && <p className="small muted">{baselineNote(0)}</p>}
      <div className="chart">
        <LineChart
          title={`${title}: この投稿のリーチ（経過時間の区分ごと）`}
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
