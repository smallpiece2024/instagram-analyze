/** 期間比較の表示の小さな部品（期間の表記） */
import type { Period } from "@/lib/period";

/** `2026-09-01〜2026-09-30` */
export function periodLabel(p: Period): string {
  return `${p.from}〜${p.to}`;
}
