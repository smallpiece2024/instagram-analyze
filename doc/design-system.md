# デザインシステム

R2.5（画面設計）で決めた分析画面のデザイントークン。2026-10-02 にユーザーが `doc/design-lab/v3/` の案 01「スタンダード・朱」に決めた。R3 で `apps/web` のグローバル CSS に下の `:root` をそのまま移す。

- 白いカードと薄灰の地。カードには 1px の境界線を付け、影は付けない
- 主役は青（#2a78d6）、差し色は朱（#d0473a）。朱はナビの現在位置、数字タイル、減少に使う
- 書体は Noto Sans JP。明朝と丸ゴシックは使わない
- 角丸は 8px（大きい面は 12px）。背景の模様は使わない
- グラフの 4 色はフィード、カルーセル、リール、ストーリーズの順で固定する。黄（#eda100）と緑（#1baf7a）は白い面とのコントラストが 3:1 未満なので、数値ラベルか表を添える
- グラフの決まりは `doc/design-lab/README.md` の「グラフの決まり」に従う

## トークン

```css
@import url("https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&display=swap");

:root {
  color-scheme: light;
  --color-bg: #f4f6f9;
  --color-surface: #ffffff;
  --color-surface-alt: #f0f3f7;
  --color-text: #1c2430;
  --color-text-muted: #5b6778;
  --color-border: #dde3ea;
  --color-border-strong: #b9c3cf;
  --color-primary: #2a78d6;
  --color-primary-contrast: #ffffff;
  --color-link: #1f5fb0;
  --color-nav-bg: #ffffff;
  --color-nav-text: #1c2430;
  --color-nav-active: #1f5fb0;
  --color-nav-active-bg: transparent;
  --nav-active-decor: inset 0 -2px 0 #d0473a;
  --color-pos: #1b8f5a;
  --color-neg: #d0473a;
  --color-neutral: #7a8594;
  --color-ok: #1b8f5a;
  --color-ok-bg: #e6f5ec;
  --color-warn: #b5780a;
  --color-warn-bg: #fdf3dc;
  --color-bad: #c03a2e;
  --color-bad-bg: #fbe6e3;
  --chart-1: #2a78d6;
  --chart-2: #eb6834;
  --chart-3: #1baf7a;
  --chart-4: #eda100;
  --chart-grid: #e6eaf0;
  --chart-axis: #8a95a3;
  --chart-ref: #5b6778;
  --chart-marker: #c5cdd7;
  --heat: #2a78d6;
  --font-body:"Noto Sans JP", system-ui, sans-serif;
  --font-heading:var(--font-body);
  --font-num:"Noto Sans JP", system-ui, sans-serif;
  --font-size-base: 14px;
  --font-size-sm: 12.5px;
  --font-size-xs: 11px;
  --font-size-h1: 23px;
  --font-size-h2: 16px;
  --font-size-kpi: 26px;
  --font-weight-heading:700;
  --font-weight-kpi: 700;
  --line-height: 1.6;
  --letter-spacing-heading: 0;
  --heading-transform: none;
  --num-variant: tabular-nums;
  --radius: 8px;
  --radius-lg: 12px;
  --radius-pill: 999px;
  --border-width: 1px;
  --shadow: none;
  --shadow-sm: none;
  --space: 8px;
  --card-pad:18px;
  --gap:18px;
  --row-pad:10px;
  --content-max: 1200px;
  --bg-texture: none;
  --bg-texture-size: auto;
  --card-border:1px solid var(--color-border);
  --card-tilt: 0deg;
  --nav-border: 1px solid var(--color-border);
  --nav-radius: 0;
  --heading-decor: none;
  --heading-pad: 0;
  --tile-accent: #d0473a;
  --thumb-radius: 6px;
  --table-head-bg: var(--color-surface-alt);
  --table-rule: 1px solid var(--color-border);
  --table-stripe: transparent;
  --tag-border: 1px solid var(--color-border);
  --tag-bg: var(--color-surface);
  --header-bg: var(--color-nav-bg);
  --header-text: var(--color-nav-text);
}

/* PC 幅だけカードの余白を広げる（2026-10-02） */
@media (min-width: 701px) {
  :root { --card-pad: 22px; }
}
```
