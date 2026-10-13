import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { NavLinks } from "./NavLinks";
import brandMark from "./brand-mark.png";

export interface AppShellProps {
  /** ブランドの表示（アカウント名。分からなければツール名） */
  brand: string;
  /** ナビを出すか。本人（`checkAccess` が `pass`）だけ（R2 の決まり） */
  showNav: boolean;
  /** バーの右端（ログアウトのフォーム）。ログイン済みなら誰にでも出す */
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * 上部のバーとナビ（見本の `shell`、R3 設計 2.2 節）。
 * 中身（`children`）は各ページが `<main className="main">` で包む（レイアウトは `<main>` を持たない）。
 *
 * ブランドの印は静的に取り込んだ PNG（88px。22px 表示の 4 倍）。`unoptimized` にして `/_next/static/media/` から
 * そのまま配る（`/_next/image` を通すと proxy の matcher に掛かり、未ログインのログイン画面で 303 になる。R2 設計 4.3 章）
 */
export function AppShell({ brand, showNav, actions, children }: AppShellProps) {
  return (
    <>
      <header className="topbar">
        <div className="topbar__in">
          <Link href="/" className="brand">
            <Image src={brandMark} alt="" width={22} height={22} className="brand__mark" unoptimized />
            {brand}
          </Link>
          {showNav && <NavLinks />}
          {actions && <div className="topbar__actions">{actions}</div>}
        </div>
      </header>
      {children}
    </>
  );
}
