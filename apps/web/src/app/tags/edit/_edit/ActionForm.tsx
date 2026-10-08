"use client";

import { useActionState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { INITIAL_TAG_EDIT_STATE, type TagEditState } from "./input";

export type TagEditAction = (state: TagEditState, formData: FormData) => Promise<TagEditState>;

/**
 * タグの編集のフォーム（R5 設計 6.2 節）。`useActionState` で Action の結果の固定の文言を出す。
 * JS なしでも `<form action>` として送れる（Next.js のプログレッシブエンハンスメント）。
 * 中身（入力欄と hidden）は Server Component から子として渡す。利用者の文字は JSX の子と属性としてだけ出す（S11）
 */
export function ActionForm({
  action,
  children,
  id,
  className,
  label,
}: {
  action: TagEditAction;
  children?: ReactNode;
  /** 表の行のように、ほかのセルの入力欄を `form` 属性で結び付けるときの id */
  id?: string;
  className?: string;
  /** フォームの名前（`aria-label`） */
  label?: string;
}) {
  const [state, formAction] = useActionState(action, INITIAL_TAG_EDIT_STATE);
  return (
    <form action={formAction} id={id} className={className ?? "field-row"} aria-label={label}>
      {children}
      {state.status !== "idle" && (
        <span role="status" className={state.status === "error" ? "field-error" : "small muted"} style={{ marginTop: 0 }}>
          {state.message}
        </span>
      )}
    </form>
  );
}

/** 送信のボタン。送信中は押せなくし、ナビと同じ点滅の印を出す（`PendingMark` 相当） */
export function SubmitButton({
  children,
  name,
  value,
  ghost = false,
  ariaLabel,
}: {
  children: ReactNode;
  name?: string;
  value?: string;
  ghost?: boolean;
  ariaLabel?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={ghost ? "btn btn--ghost" : "btn"}
      name={name}
      value={value}
      disabled={pending}
      aria-disabled={pending || undefined}
      aria-label={ariaLabel}
      style={{ position: "relative" }}
    >
      {children}
      <span aria-hidden="true" className="link-pending" data-pending={pending || undefined} />
    </button>
  );
}
