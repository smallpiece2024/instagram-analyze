// design-lab v1 の 10 案。見た目の差は tokens/tokens-XX.css のカスタムプロパティだけで表す。
// chart はグラフの 4 系列（フィード、カルーセル、リール、ストーリーズ）の色をこの順で固定。surface はグラフを置く面の色（検証に使った背景）。
window.LAB_VARIANTS = [
  { id: "01", name: "スタンダード", note: "白いカードに青を主役。角丸 8px と薄い影、ゴシック。迷ったら戻る基準。", tokens: "tokens-01.css", chart: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"], surface: "#ffffff" },
  { id: "02", name: "ナイトモード", note: "紺の地に明るい文字。夜に見ても目に優しい。グラフは少し暗めの 4 色。", tokens: "tokens-02.css", chart: ["#3a7fd6", "#d9673a", "#1a9e72", "#c08a08"], surface: "#171e2d" },
  { id: "03", name: "グラデーション", note: "紫から桃へのグラデーションをヘッダーと主要タイルに。角丸は大きめ。Instagram の空気に寄せる。", tokens: "tokens-03.css", chart: ["#7b4bd6", "#e0457b", "#ee8a1f", "#1c9a96"], surface: "#ffffff" },
  { id: "04", name: "経済紙", note: "生成りの紙色に明朝の見出しと細い罫線。影なし、角丸なし。数字は等幅で揃える。", tokens: "tokens-04.css", chart: ["#2f66b0", "#d0552a", "#1d9a6c", "#d49800"], surface: "#fbf8f1" },
  { id: "05", name: "やわらか", note: "丸ゴシックと大きな角丸、淡い色面。親しみやすく、数字の圧を下げる。", tokens: "tokens-05.css", chart: ["#3f82e0", "#ee6c3c", "#1aa877", "#e59f00"], surface: "#ffffff" },
  { id: "06", name: "方眼ノート", note: "方眼紙の地に手書き風の見出し。ノートに貼ったカードのような青インクと赤。", tokens: "tokens-06.css", chart: ["#1d4fa3", "#d0342c", "#d99a00", "#2e8b57"], surface: "#fffdf6" },
  { id: "07", name: "高密度", note: "文字と余白を詰め、一画面に多くの数字を出す。罫線は細く、角丸は小さい。管理画面寄り。", tokens: "tokens-07.css", chart: ["#1f6fd1", "#d9534f", "#b98900", "#20a070"], surface: "#ffffff" },
  { id: "08", name: "北欧ミニマル", note: "余白を広く、罫線も影もほぼ無し。文字の大小だけで階層を作る。色は少なく。", tokens: "tokens-08.css", chart: ["#2a7fb8", "#d06a3e", "#1f9a70", "#cf9a12"], surface: "#ffffff" },
  { id: "09", name: "ブルータル", note: "黒い太枠とずらした影、角丸なし、太い見出し。強い色をそのまま置く。", tokens: "tokens-09.css", chart: ["#2346d8", "#ff4f2e", "#e0a800", "#12a150"], surface: "#ffffff" },
  { id: "10", name: "藍と朱", note: "和紙色の地に藍を主役、朱を差し色に。明朝とゴシックの併用。落ち着いた和の配色。", tokens: "tokens-10.css", chart: ["#2b5d9a", "#d0473a", "#c99a2e", "#4f9a55"], surface: "#fbfaf6" }
];
