/** レポートの 9 節の見出し（R6 設計 6.1 節。節の番号と見出しは要件 9.1 章の文言）。ページの `Suspense` の fallback と各カードで同じ文字を使う */
export const SECTION_TITLES = {
  summary: "1. 総評",
  kpis: "2. 主要指標のサマリー",
  followers: "3. フォロワー数の推移",
  reachViews: "4. リーチと閲覧数の推移",
  kinds: "5. 投稿の種類ごとのまとめ",
  highlights: "6. よかった投稿 3 件、課題のある投稿 3 件",
  tags: "7. タグ別の比較",
  funnel: "8. ファネルの転換率",
  nextPlan: "9. 翌月の施策",
} as const;

/** 幅ごとの描き分け（PC の全幅のカードは 1140、スマートフォンは 340。`DailyTrendCard` の `WIDTHS` と同じ形） */
export const WIDTHS = [
  { width: 1140, className: "only-d" },
  { width: 340, className: "only-m" },
] as const;
