/**
 * オーディエンス（`/audience`）の計算（R5 設計 6.4 節）。DB は読まない純関数だけを置く。
 *
 * - 最新の週（T9）: 指標ごとに、記録の行がある最も新しい `week_start` を全体で 1 つ決める。その週のある内訳が
 *   `empty` か行なしなら、そのカードは「—」。前の週の値で埋めない（T15）
 * - 割合の分母: その週・その内訳で返った区分の合計（上位 45 件まで）。合計が 0 なら割合は null
 * - 週ごとの推移は画面に出さない（2026-10-09、ユーザー。国はほぼ日本だけのため）。収集は続け、過去の週の行も DB に残る
 * - 区分の名前（国コード、都市名）は API の値をそのまま使う（確認事項 Q13）
 */

/** 指標（`audience_captures.metric`） */
export type AudienceMetric = "follower_demographics" | "engaged_audience_demographics";

/** 内訳（`audience_captures.breakdown`） */
export type AudienceBreakdown = "age" | "gender" | "country" | "city";

/** 画面で読む timeframe（確認事項 Q7。`this_month` だけを取る） */
export const AUDIENCE_TIMEFRAME = "this_month";

/** 画面の内訳の並び（カードの順） */
export const AUDIENCE_BREAKDOWNS: readonly AudienceBreakdown[] = ["gender", "age", "country", "city"];

/** カードの見出し */
export const BREAKDOWN_LABEL: Record<AudienceBreakdown, string> = {
  gender: "性別",
  age: "年齢",
  country: "国",
  city: "都市",
};

/** 節の見出しの名前 */
export const METRIC_LABEL: Record<AudienceMetric, string> = {
  follower_demographics: "フォロワーの属性",
  engaged_audience_demographics: "反応したユーザーの属性",
};

/** 性別の表示名（表示だけ。DB の値は `F`、`M`、`U` のまま）。並びもこの順 */
export const GENDER_LABEL: Readonly<Record<string, string>> = { F: "女性", M: "男性", U: "不明" };

const GENDER_ORDER: readonly string[] = Object.keys(GENDER_LABEL);

/** 区分の表示名。性別だけ対応表で置き換え、ほか（年齢、国コード、都市名）は API の値のまま（Q13） */
export function displayLabel(breakdown: AudienceBreakdown, key: string): string {
  return breakdown === "gender" ? (GENDER_LABEL[key] ?? key) : key;
}

/** 性別の並び（女性、男性、不明。対応表にない値はその後に名前の順） */
function compareGender(a: string, b: string): number {
  const ia = GENDER_ORDER.indexOf(a);
  const ib = GENDER_ORDER.indexOf(b);
  return (ia < 0 ? GENDER_ORDER.length : ia) - (ib < 0 ? GENDER_ORDER.length : ib) || compareKey(a, b);
}

/** 国と都市のカードに出す上位の件数。これを超えた分は「ほか n 件」 */
export const TOP_LIMIT = 10;

/** 読み出す週の数（直近 52 週） */
export const AUDIENCE_WEEKS = 52;

/** 割合の分母の注記（要件 1.3 の原則 4。確認事項 Q13） */
export const DENOMINATOR_NOTE = "分母: 返った区分の合計";

/**
 * クエリの 1 行（記録 × 区分）。`empty` の記録は区分の行がないので `value_key` と `value` が null の 1 行になる
 */
export interface AudienceRow {
  /** JST の月曜（YYYY-MM-DD） */
  week_start: string;
  breakdown: AudienceBreakdown;
  status: "ok" | "empty";
  fetched_at: Date;
  value_key: string | null;
  value: number | null;
}

/** 1 つの記録（週 × 内訳） */
export interface AudienceCapture {
  weekStart: string;
  breakdown: AudienceBreakdown;
  status: "ok" | "empty";
  fetchedAt: Date;
  /** 区分ごとの人数（`empty` なら空） */
  values: Map<string, number>;
}

/** 週 → 内訳 → 記録 */
export type CaptureIndex = Map<string, Map<AudienceBreakdown, AudienceCapture>>;

/** 横棒の 1 行（`HBars` の行と同じ形） */
export interface ShareRow {
  label: string;
  value: number;
  /** 割合（0〜1）。分母が 0 なら null */
  share: number | null;
}

/** 内訳のカード（最新の週） */
export type BreakdownCard =
  | { kind: "missing"; breakdown: AudienceBreakdown; fetchedAt: Date | null }
  | {
      kind: "ok";
      breakdown: AudienceBreakdown;
      rows: ShareRow[];
      /** 上位の切り出しで出さなかった区分の数（0 なら「ほか」を出さない） */
      others: number;
      /** 分母（返った区分の合計） */
      total: number;
      fetchedAt: Date;
    };

/** 指標 1 つ分の画面の値 */
export interface AudienceView {
  /** 記録のある週の数（どれかの内訳に行がある週） */
  weekCount: number;
  /** 最新の週（YYYY-MM-DD）。記録が 0 週なら null */
  latestWeek: string | null;
  /** 最も新しい取得時刻（最終更新）。なければ null */
  lastFetchedAt: Date | null;
  /** `ok` の記録が 1 つでもあるか（反応したユーザーの節を出すか。F-UI-41） */
  hasOk: boolean;
  /** `AUDIENCE_BREAKDOWNS` の順のカード */
  cards: BreakdownCard[];
}

/** 文字列の比較（コードポイント順ではなく UTF-16 の順。照合順序に依らず決まる） */
function compareKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 行を週 × 内訳の記録にまとめる */
export function indexCaptures(rows: readonly AudienceRow[]): CaptureIndex {
  const index: CaptureIndex = new Map();
  for (const r of rows) {
    let byBreakdown = index.get(r.week_start);
    if (!byBreakdown) {
      byBreakdown = new Map();
      index.set(r.week_start, byBreakdown);
    }
    let cap = byBreakdown.get(r.breakdown);
    if (!cap) {
      cap = { weekStart: r.week_start, breakdown: r.breakdown, status: r.status, fetchedAt: r.fetched_at, values: new Map() };
      byBreakdown.set(r.breakdown, cap);
    }
    if (r.status === "ok" && r.value_key !== null && typeof r.value === "number" && Number.isFinite(r.value)) {
      cap.values.set(r.value_key, r.value);
    }
  }
  return index;
}

/** 記録のある最も新しい週（内訳を問わず全体で 1 つ。T9）。0 週なら null */
export function latestWeekOf(index: CaptureIndex): string | null {
  let latest: string | null = null;
  for (const w of index.keys()) {
    if (latest === null || compareKey(w, latest) > 0) latest = w;
  }
  return latest;
}

/** 値のある記録（`ok` で区分が 1 つ以上）なら区分ごとの人数。`empty` と行なしは null */
function usableValues(cap: AudienceCapture | undefined): Map<string, number> | null {
  return cap !== undefined && cap.status === "ok" && cap.values.size > 0 ? cap.values : null;
}

/** 区分の合計（割合の分母） */
function totalOf(values: Map<string, number>): number {
  let total = 0;
  for (const v of values.values()) total += v;
  return total;
}

/**
 * 区分ごとの人数と割合。年齢と性別は区分の名前の順（年齢は文字列の順が若い順。5.1 (2)）、
 * 国と都市は人数の多い順（同数は名前の順。API の `results` は並んでいない）
 */
export function shareRows(values: Map<string, number>, breakdown: AudienceBreakdown): ShareRow[] {
  const total = totalOf(values);
  const entries = [...values.entries()];
  if (breakdown === "country" || breakdown === "city") {
    entries.sort((a, b) => b[1] - a[1] || compareKey(a[0], b[0]));
  } else if (breakdown === "gender") {
    entries.sort((a, b) => compareGender(a[0], b[0]));
  } else {
    entries.sort((a, b) => compareKey(a[0], b[0]));
  }
  return entries.map(([key, value]) => ({ label: displayLabel(breakdown, key), value, share: total > 0 ? value / total : null }));
}

/** 上位の切り出し。`limit` を超えたら上位 `limit` 件と、出さなかった件数 */
export function topRows(rows: readonly ShareRow[], limit: number): { rows: ShareRow[]; others: number } {
  return rows.length > limit ? { rows: rows.slice(0, limit), others: rows.length - limit } : { rows: [...rows], others: 0 };
}

/** 最新の週の内訳のカード。`empty` か行なしは「—」（前の週で埋めない。T15） */
export function breakdownCard(index: CaptureIndex, latestWeek: string | null, breakdown: AudienceBreakdown): BreakdownCard {
  const cap = latestWeek === null ? undefined : index.get(latestWeek)?.get(breakdown);
  const values = usableValues(cap);
  if (cap === undefined || values === null) return { kind: "missing", breakdown, fetchedAt: cap?.fetchedAt ?? null };
  const all = shareRows(values, breakdown);
  const limited = breakdown === "country" || breakdown === "city" ? topRows(all, TOP_LIMIT) : { rows: all, others: 0 };
  return { kind: "ok", breakdown, rows: limited.rows, others: limited.others, total: totalOf(values), fetchedAt: cap.fetchedAt };
}

/** `YYYY-MM-DD` に日数を足す（UTC の日付として計算するので時差の影響がない） */
export function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 指標 1 つ分の行から画面の値を作る */
export function buildAudienceView(rows: readonly AudienceRow[]): AudienceView {
  const index = indexCaptures(rows);
  const latestWeek = latestWeekOf(index);
  let lastFetchedAt: Date | null = null;
  let hasOk = false;
  for (const byBreakdown of index.values()) {
    for (const cap of byBreakdown.values()) {
      if (lastFetchedAt === null || cap.fetchedAt.getTime() > lastFetchedAt.getTime()) lastFetchedAt = cap.fetchedAt;
      if (usableValues(cap) !== null) hasOk = true;
    }
  }
  return {
    weekCount: index.size,
    latestWeek,
    lastFetchedAt,
    hasOk,
    cards: AUDIENCE_BREAKDOWNS.map((b) => breakdownCard(index, latestWeek, b)),
  };
}

/** カードの下の時点（R3 3.1 節）。「2026-10-12 の週（日本時間）の記録・取得 …」の前半 */
export function weekLabel(week: string): string {
  return `${week} の週（日本時間）の記録`;
}
