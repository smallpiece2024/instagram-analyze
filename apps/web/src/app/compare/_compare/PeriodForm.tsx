import Link from "next/link";
import type { ComparePreset } from "@/lib/period";

const PRESET_LABEL: Record<ComparePreset, string> = {
  "7d": "前 7 日",
  "30d": "前 30 日",
  month: "前月",
  yoy: "前年同月",
};

const PRESETS: readonly ComparePreset[] = ["7d", "30d", "month", "yoy"];

/** プリセットの切り替え（見出しの右）。今のプリセットに `aria-current` */
export function PresetLinks({ current }: { current: ComparePreset }) {
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
