import type { ReactNode } from "react";

export interface PageHeadProps {
  title: string;
  /** 見出しの下の 1 行（「最終更新 2026-10-05 08:30」など） */
  sub?: ReactNode;
  /** 右側の操作（期間の切り替え、CSV のリンクなど） */
  tools?: ReactNode;
}

/** ページの見出し（見本の `pageHead`） */
export function PageHead({ title, sub, tools }: PageHeadProps) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {tools && <div className="tools">{tools}</div>}
    </div>
  );
}
