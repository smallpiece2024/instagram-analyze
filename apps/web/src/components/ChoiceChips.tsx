import Link from "next/link";
import type { ReactNode } from "react";
import { PendingMark } from "./PendingMark";

/** チップ 1 つ。`href` は呼び出し側が `buildHref`（`URLSearchParams`）で組み立てる */
export interface ChoiceChip {
  value: string;
  /** 文言（件数を含めるなら呼び出し側で「24 時間リーチ（3 件）」の形にする） */
  label: string;
  href: string;
  /** ヒント（`title`） */
  title?: string;
}

export interface ChoiceChipsProps {
  /** 選択の名前（`<nav>` の `aria-label`。「比べる指標」「種類」など） */
  label: string;
  options: readonly ChoiceChip[];
  /** 選ばれている値。どのチップとも合わなければ、どれも選択中にしない */
  current: string;
  /** チップの前に置くもの（`MetricHint` など）。省略時は何も置かない */
  lead?: ReactNode;
}

/**
 * リンクのチップによる選択（R4 の `ObjectiveChips` の形を共通にしたもの。R5 設計 6.6 節）。
 * JS なしで動く。選択中のチップは `aria-current="true"`。Server Component から使える（`PendingMark` だけが Client）
 */
export function ChoiceChips({ label, options, current, lead }: ChoiceChipsProps) {
  return (
    <nav className="chips" aria-label={label} style={{ alignItems: "center" }}>
      {lead !== undefined && <span className="small muted">{lead}</span>}
      {options.map((o) => (
        <Link
          key={o.value}
          className="chip"
          href={o.href}
          aria-current={o.value === current ? "true" : undefined}
          title={o.title}
        >
          {o.label}
          <PendingMark />
        </Link>
      ))}
    </nav>
  );
}
