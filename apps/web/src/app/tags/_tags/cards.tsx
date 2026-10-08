/**
 * タグ分析（`/tags`）のカード（R5 設計 6.1 節「カード」）。Server Component。
 * 利用者の文字（値の名前、ハッシュタグ）は JSX の子として出す（S11）
 */
import Link from "next/link";
import { Card } from "@/components/Card";
import { Strip, stripDomain } from "@/components/charts/Strip";
import { EMPTY, formatElapsedDays, formatJst, formatValue } from "@/lib/format";
import { KIND_LABEL } from "@/lib/metrics";
import type { TagMetric } from "@/lib/params";
import {
  HASHTAG_FAINT_MIN,
  POST_KINDS,
  TAG_COLUMNS,
  TAG_METRIC_FORMAT,
  TAG_METRIC_LABEL,
  type HashtagTable,
  type MedianCell,
  type TagGroupRow,
} from "@/lib/tags";

/** 中央値の表示。n が 0 なら「—」 */
function cellText(c: MedianCell, m: TagMetric): string {
  return c.n === 0 ? EMPTY : formatValue(c.value, TAG_METRIC_FORMAT[m]);
}

/** スマートフォンで隠す列（閲覧数、ER、経過日数。6.1 節） */
const HIDE_M: ReadonlySet<TagMetric> = new Set<TagMetric>(["views", "er"]);

/** 種類の内訳（`リール 3・フィード 1`）。0 件の種類は書かない */
function kindBreakdown(r: TagGroupRow): string {
  return POST_KINDS.filter((k) => r.kindCounts[k] > 0)
    .map((k) => `${KIND_LABEL[k]} ${r.kindCounts[k]}`)
    .join("・");
}

function GroupTable({ rows, caption, showKinds }: { rows: readonly TagGroupRow[]; caption: string; showKinds: boolean }) {
  return (
    <div className="table-wrap table-wrap--sticky">
      <table className="table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" className="sticky-col">
              {showKinds ? "値" : "種類"}
            </th>
            <th scope="col" className="num">
              件数
            </th>
            <th scope="col" className="num hide-m">
              経過日数
            </th>
            {TAG_COLUMNS.map((k) => (
              <th key={k} scope="col" className={HIDE_M.has(k) ? "num hide-m" : "num"}>
                {TAG_METRIC_LABEL[k]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id ?? `row-${i}`} className={r.n === 0 ? "muted" : undefined}>
              <th scope="row" className="row-head sticky-col">
                {r.label}
              </th>
              <td className="num">
                {r.n}
                {showKinds && r.n > 0 && (
                  <>
                    <br />
                    <span className="small muted">{kindBreakdown(r)}</span>
                  </>
                )}
              </td>
              <td className="num hide-m">{r.elapsedHours.n === 0 ? EMPTY : formatElapsedDays(r.elapsedHours.value)}</td>
              {TAG_COLUMNS.map((k) => (
                <td key={k} className={HIDE_M.has(k) ? "num hide-m" : "num"}>
                  {cellText(r.medians[k], k)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** タグごとの比較（全幅、F-UI-31）。表の下に、選んだ指標の帯グラフを行ごとに並べる（目盛は行で共通） */
export function TagCompareCard({
  axisName,
  rows,
  m,
  overall,
}: {
  axisName: string;
  rows: readonly TagGroupRow[];
  m: TagMetric;
  overall: number | null;
}) {
  const domain = stripDomain(
    rows.map((r) => r.points),
    overall,
  );
  const format = TAG_METRIC_FORMAT[m];
  return (
    <Card title="タグごとの比較" sub={axisName} className="col-12">
      <GroupTable rows={rows} caption={`${axisName}の値ごとの中央値`} showKinds />
      <h3 className="small" style={{ marginTop: "var(--gap)" }}>
        {TAG_METRIC_LABEL[m]}の分布
        <span className="muted">（点 = 投稿、帯 = 25〜75%、縦線 = 中央値、灰色の線 = 全投稿の中央値 {formatValue(overall, format)}）</span>
      </h3>
      <div>
        {rows.map((r, i) => (
          <div key={r.id ?? `strip-${i}`}>
            <div className="small">
              {r.label}
              <span className="muted">（n={r.points.length}）</span>
            </div>
            <div className="chart">
              <Strip
                label={r.label}
                points={r.points}
                domain={domain}
                overall={overall}
                format={format}
                dim={r.points.length < HASHTAG_FAINT_MIN}
              />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** 軸が 0 件のとき（タグの比較のカードの代わり） */
export function NoAxisCard() {
  return (
    <Card title="タグごとの比較" className="col-12">
      <p>
        タグの軸がありません。<Link href="/tags/edit">タグを編集</Link>
      </p>
    </Card>
  );
}

/** 種類ごとの比較（半幅）。`kind` の選択には従わない */
export function KindCompareCard({ rows }: { rows: readonly TagGroupRow[] }) {
  return (
    <Card title="種類ごとの比較" className="col-6">
      <GroupTable rows={rows} caption="種類ごとの中央値" showKinds={false} />
    </Card>
  );
}

/** ハッシュタグ（全幅、F-UI-32）。上位 30 行と残りの行数 */
export function HashtagCard({ table, m }: { table: HashtagTable; m: TagMetric }) {
  return (
    <Card
      title="ハッシュタグ"
      className="col-12"
      foot={table.rest > 0 ? `ほか ${table.rest} 件` : undefined}
    >
      {table.rows.length === 0 ? (
        <p className="muted">ハッシュタグを使った投稿がありません</p>
      ) : (
        <div className="table-wrap table-wrap--sticky">
          <table className="table">
            <caption className="sr-only">ハッシュタグごとの件数と中央値</caption>
            <thead>
              <tr>
                <th scope="col" className="sticky-col">
                  ハッシュタグ
                </th>
                <th scope="col" className="num">
                  件数
                </th>
                <th scope="col" className="num">
                  {TAG_METRIC_LABEL[m]}
                </th>
                {m !== "reach" && (
                  <th scope="col" className="num">
                    {TAG_METRIC_LABEL.reach}
                  </th>
                )}
                {m !== "save_rate" && (
                  <th scope="col" className="num">
                    {TAG_METRIC_LABEL.save_rate}
                  </th>
                )}
                <th scope="col" className="num">
                  最後に使った日
                </th>
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r) => (
                <tr key={r.tag} className={r.n < HASHTAG_FAINT_MIN ? "dim" : undefined}>
                  <th scope="row" className="row-head sticky-col">
                    #{r.tag}
                  </th>
                  <td className="num">{r.n}</td>
                  <td className="num">{cellText(r.metric, m)}</td>
                  {m !== "reach" && <td className="num">{cellText(r.reach, "reach")}</td>}
                  {m !== "save_rate" && <td className="num">{cellText(r.saveRate, "save_rate")}</td>}
                  <td className="num">{formatJst(r.lastUsedAt).slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
