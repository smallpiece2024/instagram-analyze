import type { MediaKind } from "@/lib/metrics";

export interface ThumbProps {
  /** 署名付き URL（`signThumbnailUrls`）。null は灰色の枠 */
  src: string | null;
  kind: MediaKind;
  alt?: string;
  size?: "sm" | "lg";
}

/**
 * サムネイル（見本の `thumb`）。署名付き URL が外へ漏れないように `referrerPolicy="no-referrer"` を付ける（R3 設計 4.7 節）。
 * 署名付き URL は 1 時間で切れるので `next/image` の最適化は使わない
 */
export function Thumb({ src, kind, alt = "", size = "sm" }: ThumbProps) {
  const className = size === "lg" ? "thumb thumb--lg" : "thumb";
  if (!src) {
    return (
      <span className={`${className} thumb--none`} data-type={kind} aria-hidden={alt ? undefined : "true"}>
        {alt ? <span className="sr-only">{alt}</span> : null}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- 署名付き URL は期限があり、画像の最適化の対象にしない
    <img className={className} data-type={kind} src={src} alt={alt} referrerPolicy="no-referrer" loading="lazy" decoding="async" />
  );
}
