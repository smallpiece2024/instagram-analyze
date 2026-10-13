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
  /**
   * 伸びた／課題の印（`media_outlier_flags.share_flag`。R6 設計 3.4 節、6.3 節 U10）。
   * `high` は「伸びた」、`low` は「課題」。`none`（判定したが印なし）と null（判定しない）は何も出さない
   */
  shareFlag?: "high" | "low" | "none" | null;
}

/** 伸びた／課題の印の文言。色は付けず、既存の `tag--special` と同じ見た目で出す（U10） */
const SHARE_FLAG_LABEL = { high: "伸びた", low: "課題" } as const;

/** 特殊な投稿の印（コラボ、お試しリール、広告、消えた投稿、伸びた／課題）。どれもなければ何も出さない */
export function SpecialTags({ isCollab, isTrialReel, isBoosted, gone, shareFlag }: SpecialFlags) {
  const items = [
    isCollab ? "コラボ" : null,
    isTrialReel ? "お試しリール" : null,
    isBoosted ? "広告" : null,
    gone ? "削除済み" : null,
    shareFlag === "high" || shareFlag === "low" ? SHARE_FLAG_LABEL[shareFlag] : null,
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
