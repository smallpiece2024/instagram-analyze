import {
  labelCapacity,
  markersFit,
  TEXT_POSITION_LABEL,
  TEXT_POSITIONS,
  textLabelsFit,
  timelineTickStepMs,
  timelineTicks,
  truncateLabel,
  type TimelineModel,
} from "@/lib/video-timeline";
import { coord } from "./scale";

export interface CutTimelineProps {
  model: TimelineModel;
  /** シーンの色（系列の色） */
  color?: string;
  /** `viewBox` の幅。`width: 100%` で縮める */
  width?: number;
  /** 文字の帯の中に文字を出す（スマートフォンの幅では false にして表で読む）。既定 true */
  labels?: boolean;
}

const M = { l: 8, r: 8 };
const RULER_Y = 16;
const SCENE_Y = 28;
const SCENE_H = 18;
/** 文字の段（上・中・下）。シーンの帯の下に 3 本 */
const LANE_Y0 = SCENE_Y + SCENE_H + 4;
const LANE_H = 14;
const LANE_GAP = 2;
const LANE_FONT = 11;
/** 文字の段がないときの高さ（R4 と同じ 52）と、3 段あるときの高さ（約 100） */
const HEIGHT_CUTS = SCENE_Y + SCENE_H + 6;
const HEIGHT_TEXTS = LANE_Y0 + TEXT_POSITIONS.length * (LANE_H + LANE_GAP) + 2;

function sec(ms: number): string {
  return `${(Math.round(ms / 100) / 10).toFixed(1)} 秒`;
}

/**
 * カットのタイムライン（見本の `cutTimeline`。R4 設計 6.1 節、R4.1 設計 6.1 節）。
 * 横軸は 0〜動画の長さ。シーンは交互の濃淡、画面変化の位置に三角の印。印が詰まるときは三角を省く。
 * 文字の区間は上・中・下の 3 段の帯（`model.texts` が null なら描かない）。テロップらしい区間は塗りを濃くし縁を描く。
 * 同じ段で重なる区間は後のものの文字を出さない。値は `<title>` と `aria-label` で持つ（吹き出しは作らない）。
 * 読み取った文字は外部由来の値なので JSX の自動エスケープに任せる
 */
export function CutTimeline({ model, color = "var(--chart-3)", width = 1140, labels = true }: CutTimelineProps) {
  const iw = Math.max(1, width - M.l - M.r);
  const x = (ms: number) => M.l + (iw * ms) / model.durationMs;
  const step = timelineTickStepMs(model.durationMs, iw);
  const tickValues = timelineTicks(model.durationMs, step);
  const showMarkers = markersFit(model, iw);
  const texts = model.texts;
  const height = texts === null ? HEIGHT_CUTS : HEIGHT_TEXTS;
  const aria =
    `カットのタイムライン: 長さ ${sec(model.durationMs)}、画面変化 ${model.cuts.length} 回、シーン ${model.scenes.length} 本` +
    (texts === null ? "" : `、文字の区間 ${texts.length} 本`);
  const fits = texts === null ? [] : textLabelsFit(texts);
  const laneY = (i: number) => LANE_Y0 + i * (LANE_H + LANE_GAP);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={aria}
      data-markers={showMarkers ? "true" : "false"}
    >
      <title>{aria}</title>
      <g className="chart-axis">
        {tickValues.map((t) => (
          <g key={t} data-part="tick">
            <line x1={coord(x(t))} x2={coord(x(t))} y1={RULER_Y - 4} y2={RULER_Y} />
            <text x={coord(x(t))} y={RULER_Y - 6} textAnchor="middle">
              {`${t / 1000}s`}
            </text>
          </g>
        ))}
        <line x1={M.l} x2={width - M.r} y1={RULER_Y} y2={RULER_Y} />
      </g>
      {model.scenes.map((s, i) => {
        const a = x(s.start);
        const b = x(s.end);
        const tip = `シーン ${i + 1}: ${sec(s.start)}〜${sec(s.end)}（${sec(s.end - s.start)}）`;
        return (
          <rect
            key={i}
            data-part="scene"
            x={coord(a)}
            y={SCENE_Y}
            width={coord(Math.max(1, b - a - (model.scenes.length > 1 ? 1 : 0)))}
            height={SCENE_H}
            rx="3"
            fill={color}
            opacity={i % 2 ? ".55" : ".85"}
            aria-label={tip}
          >
            <title>{tip}</title>
          </rect>
        );
      })}
      {showMarkers &&
        model.cuts.map((c, i) => (
          <path key={i} data-part="cut" d={`M${coord(x(c))} ${SCENE_Y - 2}l-3 -5h6z`} fill="var(--color-text)">
            <title>{`画面変化 ${i + 1}: ${sec(c)}`}</title>
          </path>
        ))}
      {texts !== null && (
        <g data-part="lanes">
          {TEXT_POSITIONS.map((p, i) => (
            <rect
              key={p}
              data-part="lane"
              data-position={p}
              x={M.l}
              y={laneY(i)}
              width={coord(iw)}
              height={LANE_H}
              fill="var(--color-surface-alt)"
            />
          ))}
          {texts.map((t, i) => {
            const a = x(t.start);
            const b = x(t.end);
            const w = Math.max(1, b - a);
            const lane = TEXT_POSITIONS.indexOf(t.position);
            const y = laneY(lane < 0 ? 1 : lane);
            const tip = `文字 ${i + 1}: ${sec(t.start)}〜${sec(t.end)}、位置 ${TEXT_POSITION_LABEL[t.position]}${
              t.captionLike ? "、テロップらしい" : ""
            }: ${t.text}`;
            const label = labels && fits[i] ? truncateLabel(t.text, labelCapacity(w - 6)) : "";
            return (
              <g key={i} data-part="text" data-caption={t.captionLike ? "true" : "false"} aria-label={tip}>
                <title>{tip}</title>
                <rect
                  x={coord(a)}
                  y={y}
                  width={coord(w)}
                  height={LANE_H}
                  rx="2"
                  fill={color}
                  opacity={t.captionLike ? ".45" : ".25"}
                  stroke={t.captionLike ? "var(--color-text)" : "none"}
                  strokeWidth={t.captionLike ? 1 : 0}
                />
                {label !== "" && (
                  <text
                    data-part="text-label"
                    x={coord(a + 3)}
                    y={y + LANE_H - 3}
                    fontSize={LANE_FONT}
                    fill="var(--color-text)"
                  >
                    {label}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      )}
    </svg>
  );
}
