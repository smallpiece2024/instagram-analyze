// design-lab v2 の 10 案。藍と朱（v1 案10）を軸に、v1 案01・04・06 の要素を混ぜた。見た目の差は tokens/tokens-XX.css のカスタムプロパティだけで表す。
// chart はグラフの 4 系列（フィード、カルーセル、リール、ストーリーズ）の色をこの順で固定。surface はグラフを置く面の色（検証に使った背景）。
window.LAB_VARIANTS = [
  { id: "01", name: "藍と朱・ゴシック", note: "v1 案10 の配色のまま、見出しもゴシックに。藍の帯、朱の差し色、藍の下線 1px。", tokens: "tokens-01.css", chart: ["#2b5d9a", "#d0473a", "#b3861c", "#4f9a55"], surface: "#fbfaf6" },
  { id: "02", name: "藍と朱・白地", note: "白い面と薄灰の地に藍と朱。ヘッダーは白で下に 1px の罫線。見出しの装飾なし。", tokens: "tokens-02.css", chart: ["#2b5d9a", "#d0473a", "#b3861c", "#4f9a55"], surface: "#ffffff" },
  { id: "03", name: "スタンダード・朱", note: "v1 案01 スタンダードの青に朱の差し色を足す。ナビの現在位置の下線、数字タイル、減少に朱。", tokens: "tokens-03.css", chart: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"], surface: "#ffffff" },
  { id: "04", name: "生成り・ゴシック", note: "v1 案04 経済紙の紙色から明朝と黒い線を抜く。ヘッダーは地と同じ色で藍の下線 1px。差し色なし。", tokens: "tokens-04.css", chart: ["#2f66b0", "#d0552a", "#1d9a6c", "#d49800"], surface: "#fbf8f1" },
  { id: "05", name: "インク・クリーム", note: "v1 案06 方眼ノートから方眼と破線を抜く。クリームの地にインクの青と赤、見出しだけ Klee One。", tokens: "tokens-05.css", chart: ["#1d4fa3", "#d0342c", "#d99a00", "#2e8b57"], surface: "#fffdf6" },
  { id: "06", name: "藍の帯・白カード", note: "薄灰の地に縁なしの白いカード。藍の帯と朱の差し色、Zen Kaku Gothic New、角丸 10px。", tokens: "tokens-06.css", chart: ["#2b5d9a", "#d0473a", "#b3861c", "#4f9a55"], surface: "#ffffff" },
  { id: "07", name: "和紙・帯なし", note: "和紙色の地に藍と朱。ヘッダーは地と同じ色で朱の下線 1px。BIZ UDPGothic、藍の下線の見出し。", tokens: "tokens-07.css", chart: ["#2b5d9a", "#d0473a", "#b3861c", "#4f9a55"], surface: "#fbfaf6" },
  { id: "08", name: "丸ゴシック改", note: "v1 案05 の丸ゴシックを、文字を濃く、罫線を足し、角丸を 10px に抑えて直す。配色は藍と朱。", tokens: "tokens-08.css", chart: ["#2b5d9a", "#d0473a", "#b3861c", "#4f9a55"], surface: "#ffffff" },
  { id: "09", name: "藍だけ", note: "和紙色の地に藍の帯。朱の差し色を外し、赤は減少と重大の表示だけ。IBM Plex Sans JP、角丸 6px。", tokens: "tokens-09.css", chart: ["#2b5d9a", "#d0473a", "#b3861c", "#4f9a55"], surface: "#fbfaf6" },
  { id: "10", name: "藍と朱・つめる", note: "案01 の配色で文字と余白を詰める。本文 13.5px、カードの内側 12px。表の多い画面向け。", tokens: "tokens-10.css", chart: ["#2b5d9a", "#d0473a", "#b3861c", "#4f9a55"], surface: "#fbfaf6" }
];
