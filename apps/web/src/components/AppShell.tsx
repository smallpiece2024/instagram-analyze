import type { ReactNode } from "react";
import Link from "next/link";
import { NavLinks } from "./NavLinks";

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
 * 中身（`children`）は各ページが `<main className="main">` で包む（レイアウトは `<main>` を持たない）
 */
export function AppShell({ brand, showNav, actions, children }: AppShellProps) {
  return (
    <>
      <header className="topbar">
        <div className="topbar__in">
          <Link href="/" className="brand">
            <span className="brand__mark" aria-hidden="true" />
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
