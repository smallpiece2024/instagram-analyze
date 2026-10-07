import { markersFit, timelineTickStepMs, timelineTicks, type TimelineModel } from "@/lib/video-timeline";
import { coord } from "./scale";

export interface CutTimelineProps {
  model: TimelineModel;
  /** シーンの色（系列の色） */
  color?: string;
  /** `viewBox` の幅。`width: 100%` で縮める */
  width?: number;
}

const M = { l: 8, r: 8 };
const RULER_Y = 16;
const SCENE_Y = 28;
const SCENE_H = 18;
const HEIGHT = SCENE_Y + SCENE_H + 6;

function sec(ms: number): string {
  return `${(Math.round(ms / 100) / 10).toFixed(1)} 秒`;
}

/**
 * カットのタイムライン（見本の `cutTimeline` から文字の区間を除いたもの。R4 設計 6.1 節）。
 * 横軸は 0〜動画の長さ。シーンは交互の濃淡、画面変化の位置に三角の印。印が詰まるときは三角を省く。
 * 値は `<title>` と `aria-label` で持つ（吹き出しは作らない）
 */
export function CutTimeline({ model, color = "var(--chart-3)", width = 1140 }: CutTimelineProps) {
  const iw = Math.max(1, width - M.l - M.r);
  const x = (ms: number) => M.l + (iw * ms) / model.durationMs;
  const step = timelineTickStepMs(model.durationMs, iw);
  const tickValues = timelineTicks(model.durationMs, step);
  const showMarkers = markersFit(model, iw);
  const aria = `カットのタイムライン: 長さ ${sec(model.durationMs)}、画面変化 ${model.cuts.length} 回、シーン ${model.scenes.length} 本`;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${width} ${HEIGHT}`}
      width={width}
      height={HEIGHT}
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
    </svg>
  );
}
