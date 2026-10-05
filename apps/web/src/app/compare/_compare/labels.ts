/** 期間比較の表示の小さな部品（期間の表記） */
import type { Period, Ymd } from "@/lib/period";

/** `2026-09-01〜2026-09-30` */
export function periodLabel(p: Period): string {
  return `${p.from}〜${p.to}`;
}

/** `2026年9月1日`（`withYear` が false なら `9月1日`） */
function jpDate(ymd: Ymd, withYear: boolean): string {
  const [y, m, d] = ymd.split("-");
  return `${withYear ? `${Number(y)}年` : ""}${Number(m)}月${Number(d)}日`;
}

/** 期間の帯の日付。`2026年9月1日 〜 9月30日`。年をまたぐときは終わりにも年を付ける */
export function jpRange(p: Period): string {
  return `${jpDate(p.from, true)} 〜 ${jpDate(p.to, p.to.slice(0, 4) !== p.from.slice(0, 4))}`;
}

/** グラフの X 軸の日付。`9/1` */
export function monthDay(ymd: Ymd): string {
  return `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;
}
