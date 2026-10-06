"use client";

import { useId, useRef, type ToggleEvent } from "react";

export interface MetricHintProps {
  /** 指標名（ボタンの文字） */
  label: string;
  /** 定義の文言（計算式、分母、API で取れない範囲を 1〜2 文）。文字として描き、HTML として解釈しない */
  text: string;
}

/**
 * 指標の定義のヒント（F-UI-29、R3 設計 3.1 節）。
 * タップとクリックは `popovertarget` で JS なしに開閉する。マウスを乗せたときの表示と位置合わせだけをここで足す。
 * `title` 属性はスマートフォンで出ないので使わない
 */
export function MetricHint({ label, text }: MetricHintProps) {
  const id = `hint-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const openedByHover = useRef(false);

  // ボタンの下に置く（画面の右端からはみ出さないように寄せる）
  function place() {
    const b = buttonRef.current?.getBoundingClientRect();
    const p = popRef.current;
    if (!b || !p) return;
    const left = Math.max(8, Math.min(b.left, window.innerWidth - p.offsetWidth - 8));
    p.style.top = `${Math.round(b.bottom + 6)}px`;
    p.style.left = `${Math.round(left)}px`;
  }

  function isOpen(): boolean {
    return popRef.current?.matches(":popover-open") ?? false;
  }

  function show() {
    const p = popRef.current;
    if (!p || isOpen() || typeof p.showPopover !== "function") return;
    openedByHover.current = true;
    p.showPopover();
  }

  function hide() {
    const p = popRef.current;
    if (!p || !openedByHover.current || !isOpen()) return;
    openedByHover.current = false;
    p.hidePopover();
  }

  function onToggle(e: ToggleEvent<HTMLDivElement>) {
    if (e.newState === "open") place();
    else openedByHover.current = false;
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="hint"
        popoverTarget={id}
        onMouseEnter={show}
        onMouseLeave={hide}
        onClick={() => {
          // クリックで開いたものはマウスが離れても閉じない
          openedByHover.current = false;
        }}
      >
        {label}
      </button>
      <div ref={popRef} id={id} popover="auto" role="tooltip" className="hint-pop" onToggle={onToggle}>
        {text}
      </div>
    </>
  );
}
