import type { ReactNode } from "react";
import type { Delta as DeltaValue } from "@/lib/metrics";
import { Delta } from "./Delta";
import { MetricHint } from "./MetricHint";

export interface KpiProps {
  label: string;
  /** 指標の定義のヒント（F-UI-29）。あればラベルを `MetricHint` で包む */
  hint?: string;
  /** 書式を済ませた値（`—` を含む） */
  value: ReactNode;
  unit?: string;
  delta?: DeltaValue | null;
  /** 分母の表示（「分母: リーチ数」） */
  denom?: string;
  /** タイルの下に置く部品（ER の分母の切り替えなど） */
  children?: ReactNode;
}

/** 数字タイル（見本の `kpi`）。`kpis` のグリッドの中に並べる */
export function Kpi({ label, hint, value, unit, delta, denom, children }: KpiProps) {
  return (
    <div className="card kpi">
      <div className="kpi__label">{hint ? <MetricHint label={label} text={hint} /> : label}</div>
      <div className="kpi__value">
        {value}
        {unit && <small>{unit}</small>}
      </div>
      <div className="kpi__delta">
        <Delta delta={delta ?? null} />
        {denom && <span className="kpi__denom">{denom}</span>}
      </div>
      {children && <div className="kpi__extra">{children}</div>}
    </div>
  );
}
