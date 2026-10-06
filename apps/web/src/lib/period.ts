/**
 * 期間の計算（R3 設計 6 章）。`server-only` なし（純粋関数）。
 *
 * - 日付は時刻を持たない `YYYY-MM-DD` の文字列で扱い、年月日の数で計算する（`Date` の時刻計算を使わない）
 * - 日本時間と太平洋時間の日付への変換は SQL で行う。ここで行うのは日付の足し引きと、太平洋時間の「今日」の取得だけ
 */

/** `YYYY-MM-DD` */
export type Ymd = string;

/** 期間（両端を含む） */
export interface Period {
  from: Ymd;
  to: Ymd;
}

interface YmdParts {
  y: number;
  m: number;
  d: number;
}

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y: number, m: number): number {
  return [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

/** 形と暦の両方が正しければ年月日、違えば null（2026-02-30、2025-02-29 は null） */
export function parseYmd(s: unknown): YmdParts | null {
  if (typeof s !== "string") return null;
  const m = YMD_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return { y, m: mo, d };
}

export function isValidYmd(s: unknown): s is Ymd {
  return parseYmd(s) !== null;
}

function pad(n: number, w: number): string {
  return String(n).padStart(w, "0");
}

function toYmd(p: YmdParts): Ymd {
  return `${pad(p.y, 4)}-${pad(p.m, 2)}-${pad(p.d, 2)}`;
}

/** 0000-03-01 を起点にした通し日数（Howard Hinnant の days_from_civil）。整数だけで計算する */
function toDayNumber({ y, m, d }: YmdParts): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe;
}

function fromDayNumber(z: number): YmdParts {
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}

function must(s: Ymd): YmdParts {
  const p = parseYmd(s);
  if (!p) throw new RangeError(`日付の形が正しくありません: ${String(s)}`);
  return p;
}

/** 日を足す（負で引く） */
export function addDays(s: Ymd, days: number): Ymd {
  return toYmd(fromDayNumber(toDayNumber(must(s)) + days));
}

/** b − a の日数 */
export function diffDays(a: Ymd, b: Ymd): number {
  return toDayNumber(must(b)) - toDayNumber(must(a));
}

/** 期間の日数（両端を含む） */
export function periodLength(p: Period): number {
  return diffDays(p.from, p.to) + 1;
}

export function compareYmd(a: Ymd, b: Ymd): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 期間の日付の並び（グラフの X 軸）。逆順なら空 */
export function eachDay(p: Period): Ymd[] {
  const out: Ymd[] = [];
  const len = periodLength(p);
  for (let i = 0; i < len; i++) out.push(addDays(p.from, i));
  return out;
}

/** 最新の日で終わる N 日（概要の 7／30／90 日、期間比較の 7d／30d） */
export function lastNDays(latest: Ymd, n: number): Period {
  return { from: addDays(latest, -(n - 1)), to: latest };
}

/** 同じ長さの直前の期間（前 7 日、前 30 日） */
export function previousPeriod(p: Period): Period {
  const len = periodLength(p);
  return { from: addDays(p.from, -len), to: addDays(p.from, -1) };
}

/** その日を含む暦月（1 日〜末日） */
export function monthOf(s: Ymd): Period {
  const { y, m } = must(s);
  return { from: toYmd({ y, m, d: 1 }), to: toYmd({ y, m, d: daysInMonth(y, m) }) };
}

/** その日を含む月の前月（暦月） */
export function previousMonth(s: Ymd): Period {
  const { y, m } = must(s);
  return m === 1 ? monthOf(toYmd({ y: y - 1, m: 12, d: 1 })) : monthOf(toYmd({ y, m: m - 1, d: 1 }));
}

/** その日を含む月の前年同月（暦月。うるう年の 2 月の前年は 28 日まで） */
export function sameMonthLastYear(s: Ymd): Period {
  const { y, m } = must(s);
  return monthOf(toYmd({ y: y - 1, m, d: 1 }));
}

/**
 * データのある範囲（データの始まり〜最新の日）に切り詰める。
 * 全部が範囲の外なら null。`truncated` は切り詰めたかどうか（画面の注記に使う）
 */
export function clampPeriod(
  p: Period,
  dataStart: Ymd | null,
  latest: Ymd,
): { period: Period; truncated: boolean } | null {
  let from = p.from;
  let to = p.to;
  if (compareYmd(to, latest) > 0) to = latest;
  if (dataStart !== null && compareYmd(from, dataStart) < 0) from = dataStart;
  if (compareYmd(from, to) > 0) return null;
  return { period: { from, to }, truncated: from !== p.from || to !== p.to };
}

/** 期間比較のプリセット（4.7 節） */
export const COMPARE_PRESETS = ["7d", "30d", "90d", "month", "yoy"] as const;
export type ComparePreset = (typeof COMPARE_PRESETS)[number];

/**
 * プリセットの 2 つの期間（R3 設計 3.5 節の表）。`a` は新しい方、`b` は比べる方。`latest` は日次指標の最新の日
 * （`account_daily_wide` の `max(metric_date) filter (where reach is not null)`。3.2 節、6 章）。
 * - 7d／30d／90d: 最新の日までの N 日と、その直前の N 日（90d は画面で「前 3 か月」。2026-10-05 ユーザーの決定で直近 90 日）
 * - month: 最新の日を含む月の前の月（暦月、1 日〜末日）と、その前の月
 * - yoy: 最新の日を含む月の前の月と、その 1 年前の同じ月（うるう年の 2 月の前年は 28 日まで）
 * 暦月はどちらも 1 日〜末日のまま返す（`a` は最新の日より前に終わるので切り詰めは要らない）
 */
export function presetPeriods(preset: ComparePreset, latest: Ymd): { a: Period; b: Period } {
  switch (preset) {
    case "7d":
    case "30d":
    case "90d": {
      const a = lastNDays(latest, preset === "7d" ? 7 : preset === "30d" ? 30 : 90);
      return { a, b: previousPeriod(a) };
    }
    case "month": {
      const a = previousMonth(latest);
      return { a, b: previousMonth(a.from) };
    }
    case "yoy": {
      const a = previousMonth(latest);
      return { a, b: sameMonthLastYear(a.from) };
    }
  }
}

const PT_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * 太平洋時間の今日（古いデータの警告に使う）。表示用の変換ではなく現在日の取得なので、
 * 「変換は SQL の 1 か所」の例外（6 章）
 */
export function todayPacific(now: Date): Ymd {
  const parts: Record<string, string> = {};
  for (const part of PT_DATE_FORMATTER.formatToParts(now)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** 古いデータの警告の日数（確認事項 Q10 の推奨） */
export const STALE_DAYS = 3;

/** 日次指標の最新の日が、太平洋時間の今日から数えて `days` 日より前なら true。最新の日がなければ false（空の表示に任せる） */
export function isStale(latest: Ymd | null, todayPt: Ymd, days = STALE_DAYS): boolean {
  if (latest === null || !isValidYmd(latest) || !isValidYmd(todayPt)) return false;
  return diffDays(latest, todayPt) > days;
}
