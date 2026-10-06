"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PendingMark } from "./PendingMark";

/**
 * ナビの項目（R3 設計 2.2 節）。投稿詳細はナビに出さず、現在位置は「投稿一覧」にする。
 * リール分析は投稿詳細の次（見本の順。R4 設計 6.2 節）
 */
export const NAV_ITEMS = [
  { href: "/", label: "概要" },
  { href: "/media", label: "投稿一覧" },
  { href: "/reels", label: "リール分析" },
  { href: "/compare", label: "期間比較" },
  { href: "/jobs", label: "接続と収集ログ" },
] as const;

/** そのパスでどの項目を現在位置にするか。`/` は完全一致、ほかは前方一致（`/media/123` は投稿一覧） */
export function activeNavHref(pathname: string): string | undefined {
  for (const item of NAV_ITEMS) {
    if (item.href === "/") {
      if (pathname === "/") return item.href;
    } else if (pathname === item.href || pathname.startsWith(`${item.href}/`)) {
      return item.href;
    }
  }
  return undefined;
}

/** ナビのリンク。現在位置だけを Client で決める（`usePathname`） */
export function NavLinks() {
  const active = activeNavHref(usePathname());
  return (
    <nav className="nav" aria-label="主要">
      {NAV_ITEMS.map((item) => (
        <Link key={item.href} href={item.href} aria-current={item.href === active ? "page" : undefined}>
          {item.label}
          <PendingMark />
        </Link>
      ))}
    </nav>
  );
}
