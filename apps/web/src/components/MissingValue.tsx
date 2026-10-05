import type { Missing } from "@/lib/metrics";
import { MetricHint } from "./MetricHint";

/**
 * 値を出せないときの「—」（R3 設計 3.1 節「—」の理由）。文言は理由から `lib/metrics.ts` で決まる。
 * 文言がない理由（`not_yet`）は「—」だけを出す
 */
export function MissingValue({ missing }: { missing: Missing }) {
  if (missing.text === null) return <span className="muted">—</span>;
  return <MetricHint label="—" text={missing.text} />;
}
