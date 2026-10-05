import { periodLength, type Period } from "@/lib/period";
import { jpRange } from "./labels";

function Block({ tag, label, period, side }: { tag: "A" | "B"; label: string; period: Period; side: "a" | "b" }) {
  return (
    <div className={`period-block period-block--${side}`}>
      <div className="period-block__label">
        <b>{tag}</b> {label}
      </div>
      <div className={`period-block__range is-${side}`}>{jpRange(period)}</div>
      <div className="period-block__days">{periodLength(period)} 日間</div>
    </div>
  );
}

/** 期間の帯（見本 v4 の `periodStrip`）。見出しのすぐ下に、A（最新の期間）と B（比べる期間）を大きめに出す */
export function PeriodStrip({ a, b }: { a: Period; b: Period }) {
  return (
    <section className="card period-strip" aria-label="比べている期間">
      <Block tag="A" label="最新の期間" period={a} side="a" />
      <Block tag="B" label="比べる期間" period={b} side="b" />
    </section>
  );
}
