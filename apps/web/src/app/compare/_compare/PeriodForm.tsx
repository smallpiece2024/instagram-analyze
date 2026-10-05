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

function DateField({ name, label, value, invalid }: { name: string; label: string; value: string; invalid: boolean }) {
  return (
    <label className="small">
      <span className="muted">{label} </span>
      <input className="input num" type="date" name={name} defaultValue={value} required aria-invalid={invalid || undefined} />
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
    <fieldset className="fieldset" aria-describedby={error ? errorId : undefined}>
      <legend>{title}</legend>
      <div className="field-row">
        <DateField name={`${side}_from`} label="開始" value={from} invalid={error !== undefined} />
        <span className="muted">〜</span>
        <DateField name={`${side}_to`} label="終了" value={to} invalid={error !== undefined} />
      </div>
      {error && (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/** 任意の期間の指定（GET のフォーム。JS なしで動く） */
export function PeriodForm({ input, errors }: { input: CompareInput; errors: { a?: string; b?: string } }) {
  return (
    <form method="get" action="/compare" className="grid grid--end">
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
