/**
 * 投稿時刻（`/timing`）の計算（R5 設計 6.5 節、要件 F-UI-42）。`server-only` なし（純粋関数。単体テストから使う）。
 *
 * - 曜日（ISO。1 = 月〜7 = 日）と時（0〜23）は SQL で JST に変換して受け取る（JS で二重に持たない。R3 6 章）
 * - 時間帯は 3 時間ごとの 8 区分（0-3、3-6、…、21-24。下端を含む。3:00 ちょうどは 3-6）
 * - 指標（`m`）と種類（`kind`）の切り替えはここでする（取得は 1 回）。データの状況で既定を変えない（T15）
 * - 中央値は `percentile_cont` と同じ線形補間（`percentileCont`）
 */
import { percentileCont } from "@/lib/metrics";
import type { KindFilter, TimingMetric } from "@/lib/params";

/** 期間の日数（過去 1 年間。R5 設計 4 章） */
export const TIMING_PERIOD_DAYS = 365;

/** 投稿 1 件（ストーリーズを除く） */
export interface TimingRow {
  media_id: string;
  kind: "reel" | "feed" | "carousel";
  posted_at: Date;
  /** JST の ISO の曜日（1 = 月〜7 = 日） */
  isodow: number;
  /** JST の時（0〜23） */
  hour: number;
  /** 24 時間時点の値（`within_tolerance` のときだけ。なければ null） */
  reach_24h: number | null;
  views_24h: number | null;
  /** 最新の値 */
  reach_latest: number | null;
  views_latest: number | null;
}

export const DAY_LABELS = ["月", "火", "水", "木", "金", "土", "日"] as const;
export const BAND_LABELS = ["0-3", "3-6", "6-9", "9-12", "12-15", "15-18", "18-21", "21-24"] as const;

/** 指標の名前（見出しと選択の文言。「初速」の語は使わない） */
export const TIMING_METRIC_LABEL: Record<TimingMetric, string> = {
  reach_24h: "24 時間リーチ",
  views_24h: "24 時間の閲覧数",
  reach_latest: "最新のリーチ",
  views_latest: "最新の閲覧数",
};

/** 種類の選択の文言 */
export const KIND_FILTER_LABEL: Record<KindFilter, string> = {
  all: "すべて",
  reel: "リール",
  feed: "フィード",
  carousel: "カルーセル",
};

/** 件数がこれ未満の棒は薄く描く */
export const TIMING_FAINT_MIN = 3;
/** 上位の組み合わせに入れる最小の件数（件数 1 件の組み合わせは除く） */
export const TOP_MIN_N = 2;
/** 上位の組み合わせの行数 */
export const TOP_ROWS = 5;

/** 選択の文言（「24 時間リーチ（3 件）」） */
export function timingMetricOptionLabel(m: TimingMetric, count: number): string {
  return `${TIMING_METRIC_LABEL[m]}（${count} 件）`;
}

/** 曜日（ISO）の行の位置（0 = 月〜6 = 日）。範囲外は null */
export function dayIndex(isodow: number): number | null {
  return Number.isInteger(isodow) && isodow >= 1 && isodow <= 7 ? isodow - 1 : null;
}

/** 時（0〜23）の時間帯の位置（0〜7。下端を含む）。範囲外は null */
export function bandIndex(hour: number): number | null {
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? Math.floor(hour / 3) : null;
}

/** 選んだ指標の値。有限でなければ null */
export function timingValue(row: TimingRow, m: TimingMetric): number | null {
  const v = row[m];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function matchesKind(row: TimingRow, kind: KindFilter): boolean {
  return kind === "all" || row.kind === kind;
}

/** 並べ替え済みでない値の中央値（線形補間）。0 件は null */
export function median(values: readonly number[]): number | null {
  return percentileCont([...values].sort((a, b) => a - b), 0.5);
}

/** 集計に使う投稿 1 件（値がある投稿だけ） */
export interface TimingPoint {
  media_id: string;
  posted_at: Date;
  value: number;
}

export interface TopCombination {
  /** 行の位置（0 = 月） */
  day: number;
  /** 時間帯の位置（0 = 0-3） */
  band: number;
  median: number;
  n: number;
  /** 投稿ごとの値（投稿日時の古い順、同時刻は id の順） */
  points: TimingPoint[];
}

export interface TimingView {
  m: TimingMetric;
  kind: KindFilter;
  /** 対象（種類が合い、選んだ指標の値がある投稿）の件数 */
  total: number;
  /** 指標ごとの件数（選んだ種類の中で値がある投稿。選択の文言に使う） */
  metricCounts: Record<TimingMetric, number>;
  /** `heat.median[曜日][時間帯]`、`heat.n[曜日][時間帯]`。件数 0 は null と 0 */
  heat: { median: (number | null)[][]; n: number[][] };
  byBand: { median: (number | null)[]; n: number[] };
  byDay: { median: (number | null)[]; n: number[] };
  /** 全投稿（対象）の中央値 */
  overallMedian: number | null;
  /** 件数 2 件以上の組み合わせの上位 5 */
  top: TopCombination[];
}

function byPostedThenId(a: TimingPoint, b: TimingPoint): number {
  const d = a.posted_at.getTime() - b.posted_at.getTime();
  if (d !== 0) return d;
  return a.media_id < b.media_id ? -1 : a.media_id > b.media_id ? 1 : 0;
}

/**
 * 選んだ指標と種類で、曜日 × 時間帯、時間帯別、曜日別の中央値と件数、上位の組み合わせを作る。
 * 曜日か時が範囲外の行（来ないはず）は数えない
 */
export function buildTimingView(rows: readonly TimingRow[], m: TimingMetric, kind: KindFilter): TimingView {
  const inKind = rows.filter((r) => matchesKind(r, kind));
  const metricCounts = {} as Record<TimingMetric, number>;
  for (const key of Object.keys(TIMING_METRIC_LABEL) as TimingMetric[]) {
    metricCounts[key] = inKind.filter((r) => timingValue(r, key) !== null && dayIndex(r.isodow) !== null && bandIndex(r.hour) !== null).length;
  }

  const cells: TimingPoint[][][] = DAY_LABELS.map(() => BAND_LABELS.map(() => []));
  const all: number[] = [];
  for (const r of inKind) {
    const v = timingValue(r, m);
    const di = dayIndex(r.isodow);
    const bi = bandIndex(r.hour);
    if (v === null || di === null || bi === null) continue;
    cells[di]![bi]!.push({ media_id: r.media_id, posted_at: r.posted_at, value: v });
    all.push(v);
  }

  const heatMedian = cells.map((row) => row.map((c) => median(c.map((p) => p.value))));
  const heatN = cells.map((row) => row.map((c) => c.length));
  const bandValues = BAND_LABELS.map((_, bi) => cells.flatMap((row) => row[bi]!.map((p) => p.value)));
  const dayValues = cells.map((row) => row.flatMap((c) => c.map((p) => p.value)));

  const combos: TopCombination[] = [];
  cells.forEach((row, di) =>
    row.forEach((c, bi) => {
      const med = heatMedian[di]![bi];
      if (c.length >= TOP_MIN_N && med !== null && med !== undefined) {
        combos.push({ day: di, band: bi, median: med, n: c.length, points: [...c].sort(byPostedThenId) });
      }
    }),
  );
  // 中央値の高い順。同じなら曜日、時間帯の順
  combos.sort((a, b) => b.median - a.median || a.day - b.day || a.band - b.band);

  return {
    m,
    kind,
    total: all.length,
    metricCounts,
    heat: { median: heatMedian, n: heatN },
    byBand: { median: bandValues.map(median), n: bandValues.map((v) => v.length) },
    byDay: { median: dayValues.map(median), n: dayValues.map((v) => v.length) },
    overallMedian: median(all),
    top: combos.slice(0, TOP_ROWS),
  };
}

/** 件数が少ない棒の位置（薄く描く） */
export function faintIndexes(n: readonly number[]): number[] {
  return n.flatMap((c, i) => (c < TIMING_FAINT_MIN ? [i] : []));
}

/** 画面のクエリ（既定の値も出す。リンクの形を一定にする） */
export function timingQuery(m: TimingMetric, kind: KindFilter): Record<string, string> {
  return { m, kind };
}
