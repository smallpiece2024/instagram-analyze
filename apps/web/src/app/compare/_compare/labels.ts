/** 期間比較の表示の小さな部品（文言の定数と期間の表記） */
import type { Period } from "@/lib/period";

/**
 * 日次指標と投稿単位の日付の区切りの注記（見本 `render.js` の `PT_NOTE` と同じ文）。
 * 概要と共通にするなら `lib/` へ移す（共通部品への依頼）
 */
export const PT_NOTE =
  "日次指標の日付は API の区切り（米国太平洋時間）。日本時間では 16 時（冬時間は 17 時）に日が変わるため、日本時間の日付には組み替えられない。投稿単位の集計（投稿日時、初速、曜日×時間帯）は日本時間。";

/** `2026-09-01〜2026-09-30` */
export function periodLabel(p: Period): string {
  return `${p.from}〜${p.to}`;
}
