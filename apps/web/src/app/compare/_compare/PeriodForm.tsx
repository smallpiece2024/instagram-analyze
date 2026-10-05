import Link from "next/link";
import type { ComparePreset } from "@/lib/period";
import type { CompareInput } from "./periods";

const PRESET_LABEL: Record<ComparePreset, string> = {
  "7d": "前 7 日",
  "30d": "前 30 日",
  month: "前月",
  yoy: "前年同月",
};

const PRESETS: readonly ComparePreset[] = ["7d", "30d", "month", "yoy"];

/** プリセットの切り替え（見出しの右）。今のプリセットに `aria-current` */
export function PresetLinks({ current }: { current: ComparePreset | null }) {
  return (
    <nav className="seg" aria-label="比べる期間">
      {PRESETS.map((p) => (
        <Link key={p} href={`/compare?preset=${p}`} aria-current={p === current ? "page" : undefined}>
          {PRESET_LABEL[p]}
        </Link>
      ))}
    </nav>
  );
}

function DateField({ name, label, value }: { name: string; label: string; value: string }) {
  return (
    <label className="small">
      <span className="muted">{label} </span>
      <input className="select num" type="date" name={name} defaultValue={value} required />
    </label>
  );
}

function Side({
  side,
  title,
  from,
  to,
  error,
}: {
  side: "a" | "b";
  title: string;
  from: string;
  to: string;
  error: string | undefined;
}) {
  const errorId = `compare-${side}-error`;
  return (
    <fieldset aria-describedby={error ? errorId : undefined} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <legend className="small" style={{ fontWeight: 700, marginBottom: 4 }}>
        {title}
      </legend>
      <div className="chips" style={{ alignItems: "center" }}>
        <DateField name={`${side}_from`} label="開始" value={from} />
        <span className="muted">〜</span>
        <DateField name={`${side}_to`} label="終了" value={to} />
      </div>
      {error && (
        <p id={errorId} className="small" role="alert" style={{ color: "var(--color-bad)", marginTop: 4 }}>
          {error}
        </p>
      )}
    </fieldset>
  );
}

/** 任意の期間の指定（GET のフォーム。JS なしで動く） */
export function PeriodForm({ input, errors }: { input: CompareInput; errors: { a?: string; b?: string } }) {
  return (
    <form method="get" action="/compare" className="grid" style={{ alignItems: "end" }}>
      <div className="col-4">
        <Side side="a" title="期間 A（新しい方）" from={input.aFrom} to={input.aTo} error={errors.a} />
      </div>
      <div className="col-4">
        <Side side="b" title="期間 B（比べる方）" from={input.bFrom} to={input.bTo} error={errors.b} />
      </div>
      <div className="col-4">
        <button type="submit" className="btn">
          比べる
        </button>
      </div>
    </form>
  );
}
