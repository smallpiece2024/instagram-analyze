import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Callout } from "@/components/Callout";
import { Card } from "@/components/Card";
import { PageHead } from "@/components/PageHead";
import { lastUpdatedLabel, mediaTitle } from "@/lib/format";
import { parseMediaId } from "@/lib/params";
import { getTargetAccount, TARGET_ACCOUNT_NOT_SET } from "@/lib/queries/account";
import { getMedia, signMediaThumbnail } from "@/lib/queries/media-detail";
import { CutTimelineCard } from "./_detail/CutTimelineCard";
import { GrowthCard } from "./_detail/GrowthCard";
import { MediaInfo } from "./_detail/MediaInfo";
import { QualityCard, QuantityCard } from "./_detail/MetricBands";

const TITLE = "投稿詳細";

function CardLoading({ title, className }: { title: string; className: string }) {
  return (
    <Card title={title} className={className}>
      <p className="small muted" aria-busy="true">
        読み込み中
      </p>
    </Card>
  );
}

/**
 * 投稿詳細（R3 設計 3.4 節、見本の `S["media-detail"]`）。
 * ID が形に合わない、該当がない、ストーリーズ、対象のアカウントのものでないなら 404。
 * 指標のカードは `<Suspense>` で包み、1 枚の失敗でほかを止めない（4.5 節）
 */
export default async function MediaDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await params;
  const id = parseMediaId(rawId);
  if (id === null) notFound();

  const account = await getTargetAccount();
  if (!account.ok) {
    return (
      <main className="main">
        <PageHead title={TITLE} />
        {account.reason === TARGET_ACCOUNT_NOT_SET ? (
          <Callout state="warn">
            {TARGET_ACCOUNT_NOT_SET}。<Link href="/connect">接続設定</Link>
          </Callout>
        ) : (
          <Callout state="bad">読み出せません（{account.reason}）</Callout>
        )}
      </main>
    );
  }

  const result = await getMedia(account.data.id, id);
  if (!result.ok) {
    return (
      <main className="main">
        <PageHead title={TITLE} />
        <Callout state="bad">読み出せません（{result.reason}）</Callout>
      </main>
    );
  }
  const media = result.data;
  if (media === null) notFound();

  const title = mediaTitle(media.caption);
  // リールとフィード動画（R4 設計 6.1 節。`media_video_features` の行の条件と同じ）
  const isVideo = media.media_type === "VIDEO" && (media.media_product_type === "REELS" || media.media_product_type === "FEED");
  const thumbnailUrl = await signMediaThumbnail(media.thumbnail_path);

  return (
    <main className="main stack">
      <nav className="crumbs" aria-label="パンくずリスト">
        <ol>
          <li>
            <Link href="/media">投稿一覧</Link>
          </li>
          <li aria-current="page">{title}</li>
        </ol>
      </nav>
      <PageHead title={TITLE} sub={lastUpdatedLabel(media.latest_fetched_at)} />
      <MediaInfo media={media} title={title} thumbnailUrl={thumbnailUrl} />
      <div className="grid">
        <Suspense fallback={<CardLoading title="量の指標" className="col-6" />}>
          <QuantityCard media={media} />
        </Suspense>
        <Suspense fallback={<CardLoading title="質の指標" className="col-6" />}>
          <QualityCard media={media} />
        </Suspense>
        <Suspense fallback={<CardLoading title="リーチ数の伸び方" className="col-12" />}>
          <GrowthCard media={media} />
        </Suspense>
        {isVideo && (
          <Suspense fallback={<CardLoading title="カットのタイムライン" className="col-12" />}>
            <CutTimelineCard media={media} />
          </Suspense>
        )}
      </div>
    </main>
  );
}
