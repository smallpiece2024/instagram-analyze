/**
 * 画面の読み込み中の骨組み（各ルートの `loading.tsx`）。リンクを押した直後に見出しと空のカードを出し、
 * 中身はサーバーの応答が届いたものから入れ替わる。灰色の部分は `.skel` でゆっくり明暗を流す（動きを減らす設定では止める）
 */
import { PageHead } from "./PageHead";

export interface PageSkeletonProps {
  /** 見出し。分からない画面（ルートの既定）では灰色の帯にする */
  title?: string;
  /** 空のカードの数 */
  cards?: number;
}

export function PageSkeleton({ title, cards = 2 }: PageSkeletonProps) {
  return (
    <main className="main stack" aria-busy="true">
      {title ? (
        <PageHead title={title} sub={<span className="skel skel--text" />} />
      ) : (
        <div className="page-head">
          <span className="skel skel--title" />
        </div>
      )}
      <p className="sr-only">読み込み中</p>
      {Array.from({ length: cards }, (_, i) => (
        <section key={i} className="card" aria-hidden="true">
          <span className="skel skel--text" />
          <span className="skel skel--block" />
        </section>
      ))}
    </main>
  );
}
