import type { ReactNode } from "react";

/** 目立つ注意（見本の `callout`）。warn は古いデータの警告、bad は読み出しの失敗 */
export function Callout({ state = "warn", children }: { state?: "warn" | "bad" | "ok"; children: ReactNode }) {
  return (
    <div className="callout" data-state={state} role={state === "bad" ? "alert" : undefined}>
      {children}
    </div>
  );
}

/** 小さな注記（見本の `note`） */
export function Note({ children }: { children: ReactNode }) {
  return <p className="note">{children}</p>;
}
