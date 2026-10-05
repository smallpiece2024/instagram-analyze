/**
 * 投稿一覧のカードの並び（スマートフォン。R3 設計 3.3 節、見本の `media-cards`）。
 * 出す指標はリーチ、保存、保存率、ER。基準値は出さない
 */
import Link from "next/link";
import { Thumb } from "@/components/Thumb";
import { SpecialTags, TypeTag } from "@/components/TypeTag";
import { formatJst } from "@/lib/format";
import type { ErDenominator } from "@/lib/params";
import { type MediaListRowWithThumbnail, mediaTitle } from "@/lib/queries/media";
import { elapsedDays, type ListMetric, MetricValue, rowKind } from "./cells";

const CARD_METRICS: readonly { key: ListMetric; label: string }[] = [
  { key: "reach", label: "リーチ" },
  { key: "saved", label: "保存" },
  { key: "save_rate", label: "保存率" },
  { key: "er", label: "ER" },
];

export function MediaCards({ items, er }: { items: readonly MediaListRowWithThumbnail[]; er: ErDenominator }) {
  return (
    <div className="only-m media-cards">
      {items.map((m) => {
        const kind = rowKind(m);
        const href = `/media/${m.media_id}`;
        const title = mediaTitle(m.caption) ?? "（キャプションなし）";
        return (
          <div key={m.media_id} className="media-card" style={m.gone_at ? { opacity: 0.55 } : undefined}>
            <Link href={href} aria-label={title}>
              <Thumb src={m.thumbnail_url} kind={kind} />
            </Link>
            <div>
              <div className="media-card__meta">
                <TypeTag kind={kind} />
                <SpecialTags
                  isCollab={m.is_collab}
                  isTrialReel={m.is_trial_reel}
                  isBoosted={m.is_boosted}
                  gone={m.gone_at !== null}
                />
                <span className="num">{formatJst(m.posted_at)}</span>
                <span>{elapsedDays(m.elapsed_hours)}</span>
              </div>
              <div className="media-card__title">
                <Link href={href}>{title}</Link>
              </div>
              <div className="media-card__nums">
                {CARD_METRICS.map((c) => (
                  <div key={c.key}>
                    <b>
                      <MetricValue row={m} metric={c.key} er={er} />
                    </b>
                    <span>{c.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
