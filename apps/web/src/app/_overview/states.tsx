import Link from "next/link";
import { Callout } from "@/components/Callout";
import { Card } from "@/components/Card";

/** カードの読み出しの失敗（3.1 節「空のとき、エラーのとき」）。理由は `describeDbError` の固定文言 */
export function LoadError({ reason }: { reason: string }) {
  return <Callout state="bad">読み出せません（{reason}）</Callout>;
}

/** データがまだない（収集前）のカードの中身 */
export function NotCollected() {
  return (
    <p className="small muted">
      まだ収集されていません。<Link href="/jobs">収集ログ</Link>
    </p>
  );
}

/** `<Suspense>` の待ちの間のカード */
export function CardLoading({ title, className }: { title: string; className?: string }) {
  return (
    <Card title={title} className={className}>
      <p className="small muted" aria-busy="true">
        読み込み中
      </p>
    </Card>
  );
}
