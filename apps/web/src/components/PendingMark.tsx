"use client";

import { useLinkStatus } from "next/link";

/**
 * 押したリンク（ナビのタブ、期間などの切り替えボタン）の遷移中の印（下線の点滅）。
 * `useLinkStatus` は `Link` の子孫でだけ使える。位置がずれないように常に描き、`data-pending` で見え方だけを切り替える
 */
export function PendingMark() {
  const { pending } = useLinkStatus();
  return <span aria-hidden="true" className="link-pending" data-pending={pending || undefined} />;
}
