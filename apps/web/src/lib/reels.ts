/**
 * リール分析（`/reels`）の計算（R4 設計 6.2 節「計算」「区分の境界」「カードごとの母集団」）。`server-only` なし（純粋関数）。
 *
 * - 計算（順位相関、ブートストラップ、中央値、分位）はサーバーでここを呼び、数値だけを描画に渡す
 * - 入力の行は DB の読み出し（`queries/reels.ts`）の形。ここでは DB を使わない
 */
import { percentileCont } from "./metrics";
import type { ParamValue, SortOrder } from "./params";

/* ------------------------------------------------------------------
 * 行の形
 * ------------------------------------------------------------------ */

/** リール 1 件（`media_list_metrics` と `media_video_features` をつないだ行） */
export interface ReelRow {
  media_id: string;
  posted_at: Date;
  caption: string | null;
  thumbnail_path: string | null;
  gone_at: Date | null;
  /** 投稿から今までの時間（時間） */
  elapsed_hours: number;
  /** キャプションの文字数（`char_length(coalesce(caption, ''))`） */
  caption_chars: number;
  /** 今の条件の解析の状態。null はまだ解析していない */
  analysis_status: string | null;
  duration_ms: number | null;
  cut_count: number | null;
  avg_scene_ms: number | null;
  first_cut_ms: number | null;
  cuts_in_first_3s: number | null;
  reach: number | null;
  views: number | null;
  avg_watch_time_ms: number | null;
  /** 0〜1 を超えることがある */
  retention_rate: number | null;
  /** 0〜1 */
  skip_rate: number | null;
  share_rate: number | null;
  save_rate: number | null;
  reach_rate: number | null;
}

/* ------------------------------------------------------------------
 * 目的変数（Q1）と検索パラメータ
 * ------------------------------------------------------------------ */

export const OBJECTIVES = ["reach_rate", "reach", "views"] as const;
export type Objective = (typeof OBJECTIVES)[number];
export const DEFAULT_OBJECTIVE: Objective = "reach_rate";

export const OBJECTIVE_LABEL: Record<Objective, string> = {
  reach_rate: "リーチ率",
  reach: "最新のリーチ",
  views: "最新の閲覧数",
};

export function objectiveValue(row: ReelRow, y: Objective): number | null {
  const v = row[y];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 選択肢の文言（件数つき）。`リーチ率（2 件）` */
export function objectiveOptionLabel(y: Objective, count: number): string {
  return `${OBJECTIVE_LABEL[y]}（${count} 件）`;
}

/** 一覧の並べ替えのキー（列の順） */
export const REEL_SORT_KEYS = [
  "posted",
  "elapsed",
  "duration",
  "cut_count",
  "avg_scene",
  "cuts_in_first_3s",
  "views",
  "reach",
  "avg_watch_time",
  "retention_rate",
  "skip_rate",
  "share_rate",
  "save_rate",
  "reach_rate",
] as const;
export type ReelSortKey = (typeof REEL_SORT_KEYS)[number];
export const DEFAULT_REEL_SORT: ReelSortKey = "posted";

function single(value: ParamValue): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function pick<T extends string>(value: ParamValue, allowed: readonly T[]): T | undefined {
  const v = single(value);
  return v !== undefined && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

export interface ReelsParams {
  y: Objective;
  sort: ReelSortKey;
  dir: SortOrder;
}

/** `y`、`sort`、`dir` の検査。不正な値（配列を含む）は既定に戻す（R3 4.7 節） */
export function parseReelsParams(sp: Readonly<Record<string, ParamValue>>): ReelsParams {
  return {
    y: pick(sp.y, OBJECTIVES) ?? DEFAULT_OBJECTIVE,
    sort: pick(sp.sort, REEL_SORT_KEYS) ?? DEFAULT_REEL_SORT,
    dir: pick(sp.dir, ["asc", "desc"] as const) ?? "desc",
  };
}

/** URL に出すクエリ。既定の値は出さない */
export function reelsQuery(p: ReelsParams): Record<string, string | undefined> {
  return {
    y: p.y === DEFAULT_OBJECTIVE ? undefined : p.y,
    sort: p.sort === DEFAULT_REEL_SORT ? undefined : p.sort,
    dir: p.dir === "desc" ? undefined : p.dir,
  };
}

/** 並べ替えのキーの値 */
function sortValue(row: ReelRow, key: ReelSortKey): number | null {
  const n = (v: number | null) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  switch (key) {
    case "posted":
      return row.posted_at.getTime();
    case "elapsed":
      return n(row.elapsed_hours);
    case "duration":
      return n(row.duration_ms);
    case "cut_count":
      return n(row.cut_count);
    case "avg_scene":
      return n(row.avg_scene_ms);
    case "cuts_in_first_3s":
      return n(row.cuts_in_first_3s);
    case "avg_watch_time":
      return n(row.avg_watch_time_ms);
    default:
      return n(row[key]);
  }
}

function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 一覧の並べ替え。値のないものは向きによらず最後。同じ値は投稿日時の新しい順、`media_id` の降順（投稿一覧と同じ） */
export function sortReels(rows: readonly ReelRow[], key: ReelSortKey, dir: SortOrder): ReelRow[] {
  return rows.slice().sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    if (va !== null && vb !== null && va !== vb) return dir === "asc" ? va - vb : vb - va;
    if (va === null && vb !== null) return 1;
    if (va !== null && vb === null) return -1;
    const t = b.posted_at.getTime() - a.posted_at.getTime();
    return t !== 0 ? t : compareId(b.media_id, a.media_id);
  });
}

/* ------------------------------------------------------------------
 * 要因
 * ------------------------------------------------------------------ */

export const FACTOR_KEYS = [
  "duration",
  "cut_count",
  "avg_scene",
  "cuts_in_first_3s",
  "first_cut",
  "caption_chars",
  "elapsed_days",
] as const;
export type FactorKey = (typeof FACTOR_KEYS)[number];

export interface FactorDef {
  key: FactorKey;
  label: string;
  hint: string;
  /** 値の書式（秒、回、文字、日） */
  unit: "seconds" | "times" | "chars" | "days";
  /** 散布図に出す（経過日数は出さない） */
  scatter: boolean;
}

/** 要因の定義（6.2 節「カード」の順）。用語は「カット」でなく「画面変化」（要件 4.5 章） */
export const FACTORS: readonly FactorDef[] = [
  { key: "duration", label: "動画の長さ", hint: "動画の長さ = 動画の全体の秒数", unit: "seconds", scatter: true },
  {
    key: "cut_count",
    label: "画面変化の回数",
    hint: "画面変化の回数 = 画面が大きく切り替わった回数。編集上のカットと一致しないことがある（フェードやズームにも反応する）",
    unit: "times",
    scatter: true,
  },
  { key: "avg_scene", label: "平均シーン長", hint: "平均シーン長 = 動画の長さ ÷ シーンの数", unit: "seconds", scatter: true },
  {
    key: "cuts_in_first_3s",
    label: "冒頭 3 秒の画面変化",
    hint: "冒頭 3 秒の画面変化 = 最初の 3 秒に画面が大きく切り替わった回数",
    unit: "times",
    scatter: true,
  },
  {
    key: "first_cut",
    label: "最初の画面変化まで",
    hint: "最初の画面変化まで = 動画の開始から最初に画面が大きく切り替わるまでの秒数。画面変化がなければ値なし",
    unit: "seconds",
    scatter: true,
  },
  { key: "caption_chars", label: "キャプションの長さ", hint: "キャプションの長さ = キャプションの文字数", unit: "chars", scatter: true },
  { key: "elapsed_days", label: "投稿からの経過日数", hint: "投稿からの経過日数 = 投稿から今までの日数", unit: "days", scatter: false },
];

/** 要因の値の元。動画の特徴量だけの行（投稿詳細）も受け取れるように、投稿の列は省略可 */
export type FactorSource = Pick<ReelRow, "duration_ms" | "cut_count" | "avg_scene_ms" | "first_cut_ms" | "cuts_in_first_3s"> &
  Partial<Pick<ReelRow, "caption_chars" | "elapsed_hours">>;

/** 要因の値（ミリ秒は秒に直す。計算し直さない） */
export function factorValue(row: FactorSource, key: FactorKey): number | null {
  const sec = (v: number | null) => (typeof v === "number" && Number.isFinite(v) ? v / 1000 : null);
  const n = (v: number | null) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  switch (key) {
    case "duration":
      return sec(row.duration_ms);
    case "cut_count":
      return n(row.cut_count);
    case "avg_scene":
      return sec(row.avg_scene_ms);
    case "cuts_in_first_3s":
      return n(row.cuts_in_first_3s);
    case "first_cut":
      return sec(row.first_cut_ms);
    case "caption_chars":
      return n(row.caption_chars ?? null);
    case "elapsed_days":
      return typeof row.elapsed_hours === "number" && Number.isFinite(row.elapsed_hours)
        ? Math.max(0, row.elapsed_hours) / 24
        : null;
  }
}

/** 要因の値の表示。`12.3 秒`、`4 回`、`120 文字`、`30 日` */
export function formatFactor(v: number | null, unit: FactorDef["unit"]): string {
  if (v === null || !Number.isFinite(v)) return "—";
  switch (unit) {
    case "seconds":
      return `${(Math.round(v * 10) / 10).toFixed(1)} 秒`;
    case "times":
      return `${Math.round(v * 10) / 10} 回`;
    case "chars":
      return `${Math.round(v)} 文字`;
    case "days":
      return `${Math.floor(v)} 日`;
  }
}

/* ------------------------------------------------------------------
 * 母集団
 * ------------------------------------------------------------------ */

/** 目的変数の値があるリール（区分の曜日と時間帯、視聴と反応） */
export function withObjective(rows: readonly ReelRow[], y: Objective): ReelRow[] {
  return rows.filter((r) => objectiveValue(r, y) !== null);
}

/** 今の条件で `success` があり、目的変数の値があるリール（要因との関係、上位と下位、散布図、区分の長さと冒頭 3 秒） */
export function analyzedWithObjective(rows: readonly ReelRow[], y: Objective): ReelRow[] {
  return rows.filter((r) => r.analysis_status === "success" && objectiveValue(r, y) !== null);
}

/** `media_id` の順（文字の順）に並べる。ブートストラップの入力の順を決めるため */
export function byMediaId(rows: readonly ReelRow[]): ReelRow[] {
  return rows.slice().sort((a, b) => compareId(a.media_id, b.media_id));
}

/* ------------------------------------------------------------------
 * 順位相関とブートストラップ
 * ------------------------------------------------------------------ */

/** 平均の順位（同順位は平均。1 始まり。見本の `ranks`） */
export function ranks(values: readonly number[]): number[] {
  const idx = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(values.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && (idx[j + 1] as readonly [number, number])[0] === (idx[i] as readonly [number, number])[0]) j++;
    for (let k = i; k <= j; k++) out[(idx[k] as readonly [number, number])[1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return out;
}

/** 計算に要る最小の件数 */
export const SPEARMAN_MIN_N = 3;

/**
 * スピアマンの順位相関（平均の順位のピアソン相関）。
 * n が 3 未満、長さが違う、どちらかの分散が 0 なら null（0 と表示しない）
 */
export function spearman(xs: readonly number[], ys: readonly number[]): number | null {
  const n = xs.length;
  if (n !== ys.length || n < SPEARMAN_MIN_N) return null;
  const rx = ranks(xs);
  const ry = ranks(ys);
  const m = (n + 1) / 2;
  let a = 0;
  let b = 0;
  let c = 0;
  for (let i = 0; i < n; i++) {
    const dx = (rx[i] as number) - m;
    const dy = (ry[i] as number) - m;
    a += dx * dy;
    b += dx * dx;
    c += dy * dy;
  }
  if (!(b > 0) || !(c > 0)) return null;
  const r = a / Math.sqrt(b * c);
  return Math.max(-1, Math.min(1, r));
}

/** ブートストラップの回数 */
export const BOOTSTRAP_B = 1000;
/** Park-Miller の種（固定の定数。1〜2147483646） */
export const BOOTSTRAP_SEED = 20261006;

/** Park-Miller の乱数（見本と同じ）。0〜1 */
export function parkMiller(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** 再標本の index の組（B 回分、1 回 n 個）。全要因で使い回す */
export function bootstrapIndexSets(n: number, b: number = BOOTSTRAP_B, seed: number = BOOTSTRAP_SEED): number[][] {
  const rnd = parkMiller(seed);
  const sets: number[][] = [];
  if (n <= 0) return sets;
  for (let k = 0; k < b; k++) {
    const set = new Array<number>(n);
    for (let i = 0; i < n; i++) set[i] = Math.min(n - 1, Math.floor(rnd() * n));
    sets.push(set);
  }
  return sets;
}

export interface Correlation {
  key: FactorKey;
  /** その要因と目的変数がともにある件数 */
  n: number;
  r: number | null;
  /** 95% の幅。r が null、または使える回がなければ null */
  lo: number | null;
  hi: number | null;
}

/**
 * 1 つの要因の順位相関と幅。`xs` と `ys` は母集団（`media_id` の順）と同じ長さで、`xs` の null は除く。
 * 再標本は母集団の index の組から取り、その回の中で要因が null の行を除いて計算する。分散 0 などで null になった回は捨てる
 */
export function correlationWithInterval(
  key: FactorKey,
  xs: readonly (number | null)[],
  ys: readonly number[],
  sets: readonly (readonly number[])[],
): Correlation {
  const px: number[] = [];
  const py: number[] = [];
  xs.forEach((x, i) => {
    if (x !== null) {
      px.push(x);
      py.push(ys[i] as number);
    }
  });
  const r = spearman(px, py);
  if (r === null) return { key, n: px.length, r: null, lo: null, hi: null };
  const boots: number[] = [];
  for (const set of sets) {
    const sx: number[] = [];
    const sy: number[] = [];
    for (const i of set) {
      const x = xs[i];
      if (x === null || x === undefined) continue;
      sx.push(x);
      sy.push(ys[i] as number);
    }
    const rb = spearman(sx, sy);
    if (rb !== null) boots.push(rb);
  }
  boots.sort((a, b) => a - b);
  return { key, n: px.length, r, lo: percentileCont(boots, 0.025), hi: percentileCont(boots, 0.975) };
}

/** 7 つの要因の順位相関（要因の定義の順）。母集団は `analyzedWithObjective` */
export function factorCorrelations(population: readonly ReelRow[], y: Objective): Correlation[] {
  const rows = byMediaId(population);
  const ys = rows.map((r) => objectiveValue(r, y) as number);
  const sets = bootstrapIndexSets(rows.length);
  return FACTORS.map((f) =>
    correlationWithInterval(
      f.key,
      rows.map((r) => factorValue(r, f.key)),
      ys,
      sets,
    ),
  );
}

/** 幅が 0 をまたがない（はっきりしている） */
export function isClear(c: Pick<Correlation, "lo" | "hi">): boolean {
  return c.lo !== null && c.hi !== null && (c.lo > 0 || c.hi < 0);
}

/* ------------------------------------------------------------------
 * 上位と下位
 * ------------------------------------------------------------------ */

export const TOP_BOTTOM_MIN_N = 4;

export interface TopBottom {
  n: number;
  /** 上位と下位の件数（`floor(n / 4)`） */
  q: number;
  top: ReelRow[];
  bottom: ReelRow[];
}

/** 目的変数の上位 25% と下位 25%。n が 4 未満なら null。同じ値は `media_id` の順で決める */
export function topBottom(population: readonly ReelRow[], y: Objective): TopBottom | null {
  const n = population.length;
  if (n < TOP_BOTTOM_MIN_N) return null;
  const sorted = population.slice().sort((a, b) => {
    const d = (objectiveValue(b, y) as number) - (objectiveValue(a, y) as number);
    return d !== 0 ? d : compareId(a.media_id, b.media_id);
  });
  const q = Math.floor(n / 4);
  return { n, q, top: sorted.slice(0, q), bottom: sorted.slice(n - q) };
}

function median(values: readonly (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  return percentileCont(v, 0.5);
}

/** 群の要因の中央値。冒頭 3 秒の画面変化は「1 回以上の割合」（0〜1） */
export function groupFactorSummary(group: readonly ReelRow[], key: FactorKey): number | null {
  if (key === "cuts_in_first_3s") {
    const v = group.map((r) => r.cuts_in_first_3s).filter((x): x is number => typeof x === "number");
    return v.length === 0 ? null : v.filter((x) => x >= 1).length / v.length;
  }
  return median(group.map((r) => factorValue(r, key)));
}

export function groupObjectiveMedian(group: readonly ReelRow[], y: Objective): number | null {
  return median(group.map((r) => objectiveValue(r, y)));
}

/* ------------------------------------------------------------------
 * 区分
 * ------------------------------------------------------------------ */

export type LengthBucket = "lt15" | "lt30" | "lt60" | "ge60";
export const LENGTH_BUCKETS: readonly { key: LengthBucket; label: string }[] = [
  { key: "lt15", label: "0〜15 秒" },
  { key: "lt30", label: "15〜30 秒" },
  { key: "lt60", label: "30〜60 秒" },
  { key: "ge60", label: "60 秒〜" },
];

/** 長さの区分（下端を含む）。長さがなければ null */
export function lengthBucket(durationMs: number | null): LengthBucket | null {
  if (durationMs === null || !Number.isFinite(durationMs)) return null;
  if (durationMs < 15000) return "lt15";
  if (durationMs < 30000) return "lt30";
  if (durationMs < 60000) return "lt60";
  return "ge60";
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 日本時間の曜日（0 = 日曜）と時（0〜23） */
export function jstDayHour(d: Date): { day: number; hour: number } {
  const j = new Date(d.getTime() + JST_OFFSET_MS);
  return { day: j.getUTCDay(), hour: j.getUTCHours() };
}

export type DayType = "weekday" | "weekend";
export function dayType(d: Date): DayType {
  const { day } = jstDayHour(d);
  return day === 0 || day === 6 ? "weekend" : "weekday";
}

export type TimeBand = "morning" | "daytime" | "night";
/** 朝は 11 時より前、昼は 11 時以上 17 時未満、夜は 17 時以上（日本時間） */
export function timeBand(d: Date): TimeBand {
  const { hour } = jstDayHour(d);
  if (hour < 11) return "morning";
  if (hour < 17) return "daytime";
  return "night";
}

export interface GroupBar {
  label: string;
  n: number;
  /** 目的変数の中央値。0 件なら null */
  value: number | null;
}

/** 3 件未満の区分は薄く */
export const GROUP_FAINT_MIN = 3;

function bars<T extends string>(
  rows: readonly ReelRow[],
  y: Objective,
  groups: readonly { key: T; label: string }[],
  of: (r: ReelRow) => T | null,
): GroupBar[] {
  return groups.map((g) => {
    const members = rows.filter((r) => of(r) === g.key);
    return { label: g.label, n: members.length, value: groupObjectiveMedian(members, y) };
  });
}

export interface GroupCards {
  length: GroupBar[];
  first3s: GroupBar[];
  day: GroupBar[];
  band: GroupBar[];
}

/** 区分ごとの目的変数の中央値。長さと冒頭 3 秒は解析済みの母集団、曜日と時間帯は目的変数の値がある母集団 */
export function groupCards(rows: readonly ReelRow[], y: Objective): GroupCards {
  const analyzed = analyzedWithObjective(rows, y);
  const all = withObjective(rows, y);
  return {
    length: bars(analyzed, y, LENGTH_BUCKETS, (r) => lengthBucket(r.duration_ms)),
    first3s: bars(
      analyzed,
      y,
      [
        { key: "zero", label: "0 回" },
        { key: "some", label: "1 回以上" },
      ] as const,
      (r) => (r.cuts_in_first_3s === null ? null : r.cuts_in_first_3s >= 1 ? "some" : "zero"),
    ),
    day: bars(
      all,
      y,
      [
        { key: "weekday", label: "平日" },
        { key: "weekend", label: "土日" },
      ] as const,
      (r) => dayType(r.posted_at),
    ),
    band: bars(
      all,
      y,
      [
        { key: "morning", label: "朝" },
        { key: "daytime", label: "昼" },
        { key: "night", label: "夜" },
      ] as const,
      (r) => timeBand(r.posted_at),
    ),
  };
}

/* ------------------------------------------------------------------
 * 散布図の点
 * ------------------------------------------------------------------ */

export interface ScatterPointData {
  x: number;
  y: number;
  media_id: string;
  caption: string | null;
}

/** x の値がある行だけの点 */
export function scatterPoints(
  rows: readonly ReelRow[],
  y: Objective,
  x: (r: ReelRow) => number | null,
): ScatterPointData[] {
  const out: ScatterPointData[] = [];
  for (const r of rows) {
    const xv = x(r);
    const yv = objectiveValue(r, y);
    if (xv === null || !Number.isFinite(xv) || yv === null) continue;
    out.push({ x: xv, y: yv, media_id: r.media_id, caption: r.caption });
  }
  return out;
}

/** 視聴と反応の指標（F-VID-11） */
export const RESPONSE_METRICS = ["retention_rate", "skip_rate", "share_rate", "save_rate"] as const;
export type ResponseMetric = (typeof RESPONSE_METRICS)[number];

/* ------------------------------------------------------------------
 * 画面全体の計算（ページ全体を 1 回で計算する）
 * ------------------------------------------------------------------ */

export interface ReelsView {
  y: Objective;
  /** 期間内のリールの数 */
  total: number;
  /** 今の条件で `success` のあるリールの数（目的変数を問わない） */
  analyzedCount: number;
  /** 目的変数ごとの、値があるリールの数（選択肢の文言） */
  objectiveCounts: Record<Objective, number>;
  /** 解析済みで目的変数の値があるリールの数（要因との関係などの母集団） */
  analyzedN: number;
  /** 目的変数の値があるリールの数（曜日、時間帯、視聴と反応の母集団） */
  objectiveN: number;
  /** 解析済みの母集団の目的変数の中央値（散布図の破線） */
  analyzedMedian: number | null;
  /** 目的変数の値がある母集団の中央値（視聴と反応の破線） */
  objectiveMedian: number | null;
  correlations: Correlation[];
  topBottom: TopBottom | null;
  factorScatter: { key: FactorKey; points: ScatterPointData[] }[];
  responseScatter: { key: ResponseMetric; points: ScatterPointData[] }[];
  groups: GroupCards;
}

export function buildReelsView(rows: readonly ReelRow[], y: Objective): ReelsView {
  const analyzed = analyzedWithObjective(rows, y);
  const all = withObjective(rows, y);
  const objectiveCounts = Object.fromEntries(OBJECTIVES.map((o) => [o, withObjective(rows, o).length])) as Record<
    Objective,
    number
  >;
  return {
    y,
    total: rows.length,
    analyzedCount: rows.filter((r) => r.analysis_status === "success").length,
    objectiveCounts,
    analyzedN: analyzed.length,
    objectiveN: all.length,
    analyzedMedian: groupObjectiveMedian(analyzed, y),
    objectiveMedian: groupObjectiveMedian(all, y),
    correlations: factorCorrelations(analyzed, y),
    topBottom: topBottom(analyzed, y),
    factorScatter: FACTORS.filter((f) => f.scatter).map((f) => ({
      key: f.key,
      points: scatterPoints(analyzed, y, (r) => factorValue(r, f.key)),
    })),
    responseScatter: RESPONSE_METRICS.map((k) => ({ key: k, points: scatterPoints(all, y, (r) => r[k]) })),
    groups: groupCards(rows, y),
  };
}
