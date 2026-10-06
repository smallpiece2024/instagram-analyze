/**
 * 投稿詳細の「カットのタイムライン」（R4 設計 6.1 節）。リールとフィード動画だけに出す（呼び出し側で判定）。
 * 上段の数字はビューの値をそのまま使い、画面で計算し直さない。解析結果がないときもカードは出し、数字とタイムラインを「—」にする
 */
import { Callout } from "@/components/Callout";
import { Card } from "@/components/Card";
import { CutTimeline } from "@/components/charts/CutTimeline";
import { MetricHint } from "@/components/MetricHint";
import { MissingValue } from "@/components/MissingValue";
import { kindColor, type Missing } from "@/lib/metrics";
import { getVideoFeatures, type MediaDetail, type VideoFeatures } from "@/lib/queries/media-detail";
import { FACTORS, factorValue, formatFactor, type FactorKey } from "@/lib/reels";
import { timelineModel, videoAnalysisMissing } from "@/lib/video-timeline";

const TITLE = "カットのタイムライン";
/** 12 列のカードの viewBox の幅（PC）とスマートフォンの幅 */
const WIDTH_D = 1140;
const WIDTH_M = 340;

/** 上段の数字（6.1 節の順） */
const TOP_FACTORS: readonly FactorKey[] = ["duration", "cut_count", "avg_scene", "cuts_in_first_3s", "first_cut"];

function TopNumbers({ video, missing }: { video: VideoFeatures | null; missing: Missing | null }) {
  const show = video !== null && missing === null;
  return (
    <div className="metrics-row" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(9em, 1fr))", margin: "0 0 var(--gap)" }}>
      {TOP_FACTORS.map((key) => {
        const def = FACTORS.find((f) => f.key === key);
        if (def === undefined) return null;
        const v = show ? factorValue(video, key) : null;
        return (
          <div key={key}>
            <span style={{ display: "block" }}>
              <MetricHint label={def.label} text={def.hint} />
            </span>
            <b>
              {missing !== null ? (
                <MissingValue missing={missing} />
              ) : v === null ? (
                <span className="muted">—</span>
              ) : (
                formatFactor(v, def.unit)
              )}
            </b>
          </div>
        );
      })}
    </div>
  );
}

export async function CutTimelineCard({ media }: { media: MediaDetail }) {
  const result = await getVideoFeatures(media.account_id, media.media_id);
  if (!result.ok) {
    return (
      <Card title={TITLE} className="col-12">
        <Callout state="bad">読み出せません（{result.reason}）</Callout>
      </Card>
    );
  }
  const video = result.data;
  const missing = videoAnalysisMissing(video?.analysis_status ?? null);
  const model = video !== null && missing === null ? timelineModel(video.cut_times_ms, video.duration_ms) : null;
  const color = kindColor(media.kind);
  return (
    <Card title={TITLE} className="col-12">
      <TopNumbers video={video} missing={missing} />
      {model === null ? (
        <p className="small">{missing !== null ? <MissingValue missing={missing} /> : <span className="muted">—</span>}</p>
      ) : (
        <>
          <div className="chart only-d">
            <CutTimeline model={model} color={color} width={WIDTH_D} />
          </div>
          <div className="chart only-m">
            <CutTimeline model={model} color={color} width={WIDTH_M} />
          </div>
        </>
      )}
    </Card>
  );
}
