/**
 * 投稿詳細の「カットのタイムライン」（R4 設計 6.1 節、R4.1 設計 6.1 節）。リールとフィード動画だけに出す（呼び出し側で判定）。
 * 上段の数字はビューの値をそのまま使い、画面で計算し直さない。解析結果がないときもカードは出し、数字とタイムラインを「—」にする。
 * 文字（R4.1）は、カットが `success` のときだけ 2 段目の数字、3 段の帯、区間の表を出す。文字の状態が
 * まだ・計算し直し待ちなら「—」、失敗なら「取得できなかった」（`videoTextMissing`）。
 * 読み取った文字は外部由来の値なので JSX の自動エスケープに任せる（`dangerouslySetInnerHTML` を使わない）
 */
import { Callout } from "@/components/Callout";
import { Card } from "@/components/Card";
import { CutTimeline } from "@/components/charts/CutTimeline";
import { MetricHint } from "@/components/MetricHint";
import { MissingValue } from "@/components/MissingValue";
import { formatPercent } from "@/lib/format";
import { kindColor, type Missing } from "@/lib/metrics";
import { getVideoFeatures, type MediaDetail, type TextSegment, type VideoFeatures } from "@/lib/queries/media-detail";
import { FACTORS, factorValue, FIRST_3S_TEXT, formatFactor, formatHasText, type FactorKey } from "@/lib/reels";
import {
  TEXT_POSITION_LABEL,
  textPosition,
  timelineModel,
  videoAnalysisMissing,
  videoTextMissing,
  type TextSpan,
} from "@/lib/video-timeline";

const TITLE = "カットのタイムライン";
/** 12 列のカードの viewBox の幅（PC）とスマートフォンの幅 */
const WIDTH_D = 1140;
const WIDTH_M = 340;

/** 上段の数字（6.1 節の順） */
const TOP_FACTORS: readonly FactorKey[] = ["duration", "cut_count", "avg_scene", "cuts_in_first_3s", "cuts_in_last_3s", "first_cut"];
/** 2 段目の数字（R4.1 6.1 節の順）。「冒頭 3 秒の文字」は 2 値なので `FACTORS` と別に 1 枚 */
const TEXT_FACTORS: readonly FactorKey[] = ["first_text", "text_coverage", "total_text_chars"];

const ROW_STYLE = { gridTemplateColumns: "repeat(auto-fit, minmax(9em, 1fr))", margin: "0 0 var(--gap)" } as const;

function NumberCell({ label, hint, missing, value }: { label: string; hint: string; missing: Missing | null; value: string | null }) {
  return (
    <div>
      <span style={{ display: "block" }}>
        <MetricHint label={label} text={hint} />
      </span>
      <b>{missing !== null ? <MissingValue missing={missing} /> : value === null ? <span className="muted">—</span> : value}</b>
    </div>
  );
}

function TopNumbers({ video, missing }: { video: VideoFeatures | null; missing: Missing | null }) {
  const show = video !== null && missing === null;
  return (
    <div className="metrics-row" style={ROW_STYLE}>
      {TOP_FACTORS.map((key) => {
        const def = FACTORS.find((f) => f.key === key);
        if (def === undefined) return null;
        const v = show ? factorValue(video, key) : null;
        return <NumberCell key={key} label={def.label} hint={def.hint} missing={missing} value={v === null ? null : formatFactor(v, def.unit)} />;
      })}
    </div>
  );
}

/** 2 段目: 最初の文字まで、冒頭 3 秒の文字、文字の表示割合、総文字数 */
function TextNumbers({ video, missing }: { video: VideoFeatures; missing: Missing | null }) {
  const cell = (key: FactorKey) => {
    const def = FACTORS.find((f) => f.key === key);
    if (def === undefined) return null;
    const v = missing === null ? factorValue(video, key) : null;
    return <NumberCell key={key} label={def.label} hint={def.hint} missing={missing} value={v === null ? null : formatFactor(v, def.unit)} />;
  };
  return (
    <div className="metrics-row" style={ROW_STYLE}>
      {cell("first_text")}
      <NumberCell
        label={FIRST_3S_TEXT.label}
        hint={FIRST_3S_TEXT.hint}
        missing={missing}
        value={missing === null && typeof video.has_text_in_first_3s === "boolean" ? formatHasText(video.has_text_in_first_3s) : null}
      />
      {TEXT_FACTORS.filter((k) => k !== "first_text").map(cell)}
    </div>
  );
}

function sec(ms: number): string {
  return `${(Math.round(ms / 100) / 10).toFixed(1)}`;
}

/** 区間の表。0 本なら本体を出さない（新しい文言は足さない。`sub` の「0 本」と上段の数字で読める） */
function SegmentTable({ video }: { video: VideoFeatures }) {
  const segments = video.text_segments;
  const sub = `${video.segment_count ?? segments.length} 本・うちテロップらしい区間: ${video.caption_segment_count}（総文字数 ${
    video.caption_total_chars ?? 0
  }）`;
  return (
    <div style={{ marginTop: "var(--gap)" }}>
      <div className="card__head">
        <h3 style={{ margin: 0 }}>文字の区間</h3>
        <span className="card__sub">{sub}</span>
      </div>
      {segments.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col" className="num">
                  #
                </th>
                <th scope="col" className="num">
                  開始（秒）
                </th>
                <th scope="col" className="num">
                  終了（秒）
                </th>
                <th scope="col">位置</th>
                <th scope="col">文字</th>
                <th scope="col">テロップらしさ</th>
                <th scope="col" className="num">
                  確信度
                </th>
              </tr>
            </thead>
            <tbody>
              {segments.map((s: TextSegment) => (
                <tr key={s.seq}>
                  <td className="num">{s.seq}</td>
                  <td className="num">{sec(s.start_ms)}</td>
                  <td className="num">{sec(s.end_ms)}</td>
                  <td>{TEXT_POSITION_LABEL[textPosition(s.position)]}</td>
                  <td style={{ overflowWrap: "anywhere", maxWidth: "28em" }}>{s.text}</td>
                  <td>{s.is_caption_like ? "●" : ""}</td>
                  <td className="num">{formatPercent(s.confidence, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** ビューの区間をタイムラインの形に（クリップは `timelineModel` で行う） */
function toSpans(segments: readonly TextSegment[]): TextSpan[] {
  return segments.map((s) => ({
    start: s.start_ms,
    end: s.end_ms,
    text: s.text,
    position: textPosition(s.position),
    captionLike: s.is_caption_like,
  }));
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
  const cutsOk = video !== null && missing === null;
  const textMissing = cutsOk ? videoTextMissing(video.text_status, video.text_segmenter_current) : null;
  const textsOk = cutsOk && textMissing === null;
  const model = cutsOk ? timelineModel(video.cut_times_ms, video.duration_ms, textsOk ? toSpans(video.text_segments) : null) : null;
  const color = kindColor(media.kind);
  return (
    <Card title={TITLE} className="col-12">
      <TopNumbers video={video} missing={missing} />
      {cutsOk && <TextNumbers video={video} missing={textMissing} />}
      {model === null ? (
        <p className="small">{missing !== null ? <MissingValue missing={missing} /> : <span className="muted">—</span>}</p>
      ) : (
        <>
          <div className="chart only-d">
            <CutTimeline model={model} color={color} width={WIDTH_D} />
          </div>
          <div className="chart only-m">
            <CutTimeline model={model} color={color} width={WIDTH_M} labels={false} />
          </div>
        </>
      )}
      {textsOk && <SegmentTable video={video} />}
    </Card>
  );
}
