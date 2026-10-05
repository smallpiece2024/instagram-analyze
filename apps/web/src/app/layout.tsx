import type { Metadata } from "next";
import { Noto_Sans_JP } from "next/font/google";
import { AppShell } from "@/components/AppShell";
import { checkAccess, currentClaims } from "@/lib/auth";
import { signOutAction } from "./login/actions";
import "./globals.css";

/**
 * 書体（R3 設計 5.1 節）。ビルド時に取り込み、ブラウザから Google へのリクエストを出さない。
 * Noto Sans JP の `subsets` に日本語はない（latin、latin-ext、cyrillic、vietnamese だけ）。
 * 日本語の字形は unicode-range で分けたファイルを必要なときに読むので、先読み（preload）は latin だけにする
 */
const notoSansJp = Noto_Sans_JP({
  weight: ["400", "500", "700"],
  subsets: ["latin"],
  display: "swap",
  variable: "--font-noto-sans-jp",
});

export const metadata: Metadata = {
  title: "Instagram 分析ツール",
  description: "自分の Instagram プロアカウントのデータを蓄積して分析するツール",
};

/** ブランドの表示。レイアウトは DB を読まないので、アカウント名ではなくツール名を出す */
const BRAND = "Instagram 分析";

/**
 * ナビゲーションは本人（JWT の検証に通り、`WEB_ALLOWED_USER_ID` と一致）にだけ出す。ログアウトはログイン済みなら誰にでも出す
 * （許可外の利用者が自分で抜けられるように）（R2 設計 4.3 章、R3 設計 2.2 節）。
 * ログアウトは POST の Server Action（`signOut({ scope: 'global' })` → `/login`）
 */
export default async function RootLayout({ children }: LayoutProps<"/">) {
  const claims = await currentClaims();
  const signedIn = claims !== undefined;
  const allowed = signedIn && (await checkAccess("/")) === "pass";
  return (
    <html lang="ja" className={`${notoSansJp.variable} h-full`}>
      <body className="flex min-h-full flex-col">
        <AppShell
          brand={BRAND}
          showNav={allowed}
          actions={
            signedIn ? (
              <form action={signOutAction}>
                <button type="submit">ログアウト</button>
              </form>
            ) : undefined
          }
        >
          {children}
        </AppShell>
      </body>
    </html>
  );
}
