import { KIND_LABEL, type MediaKind } from "@/lib/metrics";

/** 投稿の種類のタグ（見本の `tag`）。文字は本文色、系列の色は丸だけ */
export function TypeTag({ kind }: { kind: MediaKind }) {
  return (
    <span className="tag" data-type={kind}>
      <i aria-hidden="true" />
      {KIND_LABEL[kind]}
    </span>
  );
}

export interface SpecialFlags {
  isCollab?: boolean | null;
  isTrialReel?: boolean | null;
  isBoosted?: boolean | null;
  /** 削除やアーカイブで消えた（`gone_at` あり） */
  gone?: boolean;
}

/** 特殊な投稿の印（コラボ、お試しリール、広告、消えた投稿）。どれもなければ何も出さない */
export function SpecialTags({ isCollab, isTrialReel, isBoosted, gone }: SpecialFlags) {
  const items = [
    isCollab ? "コラボ" : null,
    isTrialReel ? "お試しリール" : null,
    isBoosted ? "広告" : null,
    gone ? "削除済み" : null,
  ].filter((v): v is string => v !== null);
  if (items.length === 0) return null;
  return (
    <>
      {items.map((label) => (
        <span key={label} className="tag tag--special">
          {label}
        </span>
      ))}
    </>
  );
}
