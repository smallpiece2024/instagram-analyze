import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import { currentClaims } from "@/lib/auth";
import { signOutAction } from "./login/actions";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Instagram 分析ツール",
  description: "自分の Instagram プロアカウントのデータを蓄積して分析するツール",
};

/** 共通のナビゲーション（設計 1.1 章）。レイアウトは DB を読まない */
const NAV = [
  { href: "/", label: "接続状態" },
  { href: "/jobs", label: "収集ログ" },
  { href: "/media", label: "投稿一覧" },
  { href: "/connect", label: "接続設定" },
] as const;

/**
 * ナビゲーションとログアウトはログイン済み（JWT の検証に通った）ときだけ出す（R2 設計 4.3 章）。
 * ログアウトは POST の Server Action（`signOut({ scope: 'global' })` → `/login`）
 */
export default async function RootLayout({ children }: LayoutProps<"/">) {
  const claims = await currentClaims();
  const signedIn = claims !== undefined;
  return (
    <html lang="ja" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <header className="border-b border-neutral-200 bg-white">
          <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
            <Link href="/" className="font-semibold">
              Instagram 分析ツール
            </Link>
            {signedIn && (
              <>
                <nav aria-label="主要">
                  <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                    {NAV.map((item) => (
                      <li key={item.href}>
                        <Link href={item.href} className="text-blue-700 underline-offset-2 hover:underline">
                          {item.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </nav>
                <form action={signOutAction} className="ml-auto">
                  <button type="submit" className="text-sm text-neutral-700 underline-offset-2 hover:underline">
                    ログアウト
                  </button>
                </form>
              </>
            )}
          </div>
        </header>
        {children}
        <footer className="mt-auto px-4 py-6 text-center text-xs text-neutral-500">
          R1: 最小限の画面。時刻はすべて日本時間（JST）。
        </footer>
      </body>
    </html>
  );
}
