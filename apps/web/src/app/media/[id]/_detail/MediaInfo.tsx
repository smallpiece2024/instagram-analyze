import { Card } from "@/components/Card";
import { Thumb } from "@/components/Thumb";
import { SpecialTags, TypeTag } from "@/components/TypeTag";
import { elapsedDaysLabel, formatJst, isInstagramPermalink } from "@/lib/format";
import type { MediaDetail } from "@/lib/queries/media-detail";

/**
 * 投稿の情報（見本の `detail-head`。R3 設計 3.4 節）。
 * キャプションは文字の子要素として描き、改行を保つ（`dangerouslySetInnerHTML` は使わない）
 */
export function MediaInfo({ media, title, thumbnailUrl }: { media: MediaDetail; title: string; thumbnailUrl: string | null }) {
  return (
    <Card>
      <div className="detail-head">
        <div style={{ flexShrink: 0, textAlign: "center" }}>
          <Thumb src={thumbnailUrl} kind={media.kind} size="lg" />
          {isInstagramPermalink(media.permalink) && (
            <p className="small" style={{ marginTop: 8 }}>
              <a href={media.permalink} target="_blank" rel="noopener noreferrer">
                Instagram で開く
              </a>
            </p>
          )}
        </div>
        <div className="detail-head__body">
          <div className="media-card__meta">
            <TypeTag kind={media.kind} />
            <SpecialTags
              isCollab={media.is_collab}
              isTrialReel={media.is_trial_reel}
              isBoosted={media.is_boosted}
              gone={media.gone_at !== null}
            />
            <span>{formatJst(media.posted_at)} 投稿</span>
            {/* 前回投稿からの日数（時間を日に切り捨て）。直前の投稿（ストーリーズを除く）がなければ出さない。種類で分岐しない */}
            {media.hours_since_previous_post !== null && (
              <span>前回の投稿から {Math.floor(media.hours_since_previous_post / 24)} 日</span>
            )}
            {media.elapsed_latest !== null && <span>{elapsedDaysLabel(media.elapsed_latest / 3600)}</span>}
            <span>最新の取得 {formatJst(media.latest_fetched_at)}</span>
          </div>
          <h2>{title}</h2>
          {media.caption !== null && media.caption !== "" && (
            <p className="caption" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {media.caption}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
