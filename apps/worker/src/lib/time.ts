/**
 * 日付と時刻の純粋関数（設計 5.0 章、9.1 章）。
 *
 * API の日次指標は米国太平洋時間（PT）の 0 時で区切られ、プロフィールの日次記録は日本時間（JST）の日付で持つ。
 * タイムゾーンの変換は `Intl.DateTimeFormat` で行い、ライブラリは入れない（Node 24 の公式イメージは ICU を含む）。
 * 日付の文字列はすべて `YYYY-MM-DD`。
 */

export type Tz = "America/Los_Angeles" | "Asia/Tokyo";

/** 米国太平洋時間（API の日次指標の区切り。R0 検証 V4） */
export const PT: Tz = "America/Los_Angeles";

/** 日本時間 */
export const JST: Tz = "Asia/Tokyo";

/** ストーリーズが消えるまでの時間 */
export const STORY_LIFETIME_MS = 24 * 60 * 60 * 1000;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const formatters = new Map<Tz, Intl.DateTimeFormat>();

function formatterFor(tz: Tz): Intl.DateTimeFormat {
  let formatter = formatters.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, formatter);
  }
  return formatter;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** 時刻をそのタイムゾーンの壁時計に分解する */
function wallClock(d: Date, tz: Tz): WallClock {
  if (Number.isNaN(d.getTime())) throw new RangeError("不正な日時");
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
  for (const part of formatterFor(tz).formatToParts(d)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 0,
    day: parts.day ?? 0,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  };
}

/**
 * UTC の年月日時分秒からエポックミリ秒を作る。`Date.UTC` は年 0〜99 を 1900 年代に読み替えるので
 * `setUTCFullYear` を使う。日や時の桁あふれは `Date.UTC` と同じく繰り上がる。範囲外なら NaN
 */
function utcMs(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(hour, minute, second, 0);
  return d.getTime();
}

/** そのタイムゾーンの UTC からのずれ（ミリ秒。東が正）。秒未満は切り捨てて比べる */
function tzOffsetMs(d: Date, tz: Tz): number {
  const w = wallClock(d, tz);
  return utcMs(w.year, w.month, w.day, w.hour, w.minute, w.second) - Math.floor(d.getTime() / 1000) * 1000;
}

function formatDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** `YYYY-MM-DD` を分解する。書式が違うか存在しない日付なら `RangeError` */
function parseDate(date: string): { year: number; month: number; day: number } {
  const match = DATE_PATTERN.exec(date);
  if (!match) throw new RangeError("日付の書式が不正（YYYY-MM-DD）");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(utcMs(year, month, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new RangeError("存在しない日付");
  }
  return { year, month, day };
}

/** 時刻をそのタイムゾーンの日付（`YYYY-MM-DD`）にする */
export function zonedDate(d: Date, tz: Tz): string {
  const w = wallClock(d, tz);
  return formatDate(w.year, w.month, w.day);
}

/**
 * その日の 0 時（そのタイムゾーン）を表す時刻。
 * 壁時計の 0 時をいったん UTC として扱い、その時点のずれで補正する。夏時間の切り替え日は 1 回目の補正で
 * ずれが変わりうるので、補正後の時点のずれでもう一度補正する（PT と JST ではこれで確定する）。
 */
export function zonedMidnightUtc(date: string, tz: Tz): Date {
  const { year, month, day } = parseDate(date);
  const wall = utcMs(year, month, day);
  let utc = wall;
  for (let i = 0; i < 2; i += 1) {
    utc = wall - tzOffsetMs(new Date(utc), tz);
  }
  return new Date(utc);
}

/** `YYYY-MM-DD` に日数を足す。UTC で計算し、月末と年末をまたぐ。整数でない日数や `Date` の範囲外は `RangeError` */
export function addDays(date: string, n: number): string {
  if (!Number.isInteger(n)) throw new RangeError("日数は整数");
  const { year, month, day } = parseDate(date);
  const d = new Date(utcMs(year, month, day + n));
  if (Number.isNaN(d.getTime())) throw new RangeError("日付が範囲外");
  return formatDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/**
 * アカウント日次指標の 1 日分の `since`／`until`（UNIX 秒）。
 * `since` はその日の PT 0 時、`until` は翌日の PT 0 時 − 1 秒（夏時間の切り替え日は 1 日が 23 時間または
 * 25 時間なので `since + 86399` にしない）。
 *
 * 実機確認（設計 11.1 章 P3、2026-10-01）で確定。`until` を翌日 0 時ちょうどにすると翌日分が混ざって 2 件返る。
 */
export function pacificDayRange(date: string): { since: number; until: number } {
  const since = Math.floor(zonedMidnightUtc(date, PT).getTime() / 1000);
  const until = Math.floor(zonedMidnightUtc(addDays(date, 1), PT).getTime() / 1000) - 1;
  return { since, until };
}

/**
 * time_series の `end_time`（例 `2026-11-02T08:00:00+0000`）から、その値が属する PT の日付を求める。
 * `end_time` はその日の PT 0 時（例は PT 2026-11-02 00:00）で、PT の日付がそのまま指標の日付になる。
 *
 * 実機確認（設計 11.1 章 P3、2026-10-01）で確定。PT 2026-09-27 の 1 日分を取ると
 * `end_time = 2026-09-27T07:00:00+0000` が 1 件返った（前日ではない）。
 */
export function metricDateFromEndTime(endTime: string): string {
  // `+0000` の形は環境によって解釈が揺れるので `+00:00` にそろえる
  const normalized = endTime.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  // オフセットのない文字列は実行環境のタイムゾーンで解釈されてしまうので受け付けない
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(normalized)) throw new RangeError("end_time にタイムゾーンのオフセットがない");
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) throw new RangeError("end_time の書式が不正");
  return zonedDate(d, PT);
}

/**
 * 投稿から取得までの経過秒（切り捨て）。`fetchedAt` が `postedAt` より前なら負の値をそのまま返し、
 * 呼び出し側が判断する。
 */
export function elapsedSeconds(postedAt: Date, fetchedAt: Date): number {
  return Math.floor((fetchedAt.getTime() - postedAt.getTime()) / 1000);
}

/** ストーリーズが消える時刻（投稿の 24 時間後） */
export function storyExpiresAt(postedAt: Date): Date {
  return new Date(postedAt.getTime() + STORY_LIFETIME_MS);
}
