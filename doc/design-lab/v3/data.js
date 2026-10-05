// design-lab v1 の見本データ。すべて架空。アカウントも数字も実在しない。
// 時刻は日本時間（JST）。日次指標の日付だけは API の区切り（米国太平洋時間）。
window.LAB_DATA = (function () {
  // 投稿 24 件。type: feed / carousel / reel。pv（プロフィール訪問）と follows はリールでは取れないので null。
  // reel の len は秒、watch は平均視聴時間（秒）、skip はスキップ率、cuts は大きな画面変化の回数、text3 は冒頭 3 秒に文字があるか。
  var posts = [
    { id: 1,  type: "reel",     at: "2026-09-30T10:05", title: "新豆の焙煎、火入れの瞬間",             reach: 10200, views: 15300,  likes: 312, comments: 18, saves: 141, shares: 64,  pv: null, follows: null, len: 28, watch: 11.4, skip: 0.31, cuts: 9,  text3: true,  hue: 24 },
    { id: 2,  type: "carousel", at: "2026-09-28T19:30", title: "秋のブレンド、3 つの飲み比べ",           reach: 1980,  views: 2410,  likes: 176, comments: 9,  saves: 88,  shares: 12,  pv: 41,   follows: 6,    hue: 38 },
    { id: 3,  type: "feed",     at: "2026-09-27T12:00", title: "本日のドリップ、エチオピア",             reach: 1120,  views: 1260,  likes: 98,  comments: 4,  saves: 21,  shares: 3,   pv: 12,   follows: 1,    hue: 200 },
    { id: 4,  type: "reel",     at: "2026-09-25T18:00", title: "ハンドピックの地味な 1 時間を 15 秒で",   reach: 9640,  views: 15200, likes: 540, comments: 31, saves: 362, shares: 180, pv: null, follows: null, len: 15, watch: 8.9,  skip: 0.22, cuts: 6,  text3: true,  hue: 90 },
    { id: 5,  type: "feed",     at: "2026-09-24T08:30", title: "焙煎機の掃除の日",                       reach: 860,   views: 940,   likes: 71,  comments: 6,  saves: 9,   shares: 2,   pv: 9,    follows: 0,    hue: 210 },
    { id: 6,  type: "carousel", at: "2026-09-22T19:00", title: "豆の保存、よくある質問 5 つ",             reach: 3210,  views: 3880,  likes: 201, comments: 14, saves: 268, shares: 35,  pv: 58,   follows: 9,    hue: 48 },
    { id: 7,  type: "reel",     at: "2026-09-21T11:30", title: "ラテアート失敗集",                       reach: 6210,  views: 9100,  likes: 433, comments: 27, saves: 96,  shares: 142, pv: null, follows: null, len: 22, watch: 9.8,  skip: 0.27, cuts: 12, text3: false, hue: 330 },
    { id: 8,  type: "feed",     at: "2026-09-19T17:45", title: "新しいカップが届きました",               reach: 1340,  views: 1500,  likes: 121, comments: 8,  saves: 17,  shares: 4,   pv: 15,   follows: 2,    hue: 180 },
    { id: 9,  type: "reel",     at: "2026-09-17T20:00", title: "冷めても美味しい豆の選び方",             reach: 3980,  views: 5700,  likes: 268, comments: 12, saves: 210, shares: 71,  pv: null, follows: null, len: 41, watch: 13.2, skip: 0.35, cuts: 14, text3: true,  hue: 60 },
    { id: 10, type: "carousel", at: "2026-09-15T12:30", title: "産地ごとの味の地図",                     reach: 2760,  views: 3300,  likes: 189, comments: 11, saves: 231, shares: 28,  pv: 49,   follows: 7,    hue: 140 },
    { id: 11, type: "feed",     at: "2026-09-14T09:00", title: "朝の仕込み",                             reach: 910,   views: 1010,  likes: 80,  comments: 3,  saves: 11,  shares: 1,   pv: 8,    follows: 0,    hue: 30 },
    { id: 12, type: "reel",     at: "2026-09-12T18:30", title: "焙煎度で変わる豆の色、10 秒",            reach: 12800, views: 21400, likes: 710, comments: 44, saves: 480, shares: 265, pv: null, follows: null, len: 10, watch: 6.8,  skip: 0.18, cuts: 5,  text3: true,  hue: 20 },
    { id: 13, type: "feed",     at: "2026-09-11T13:00", title: "定休日のお知らせ",                       reach: 1050,  views: 1120,  likes: 64,  comments: 2,  saves: 4,   shares: 1,   pv: 6,    follows: 0,    hue: 260 },
    { id: 14, type: "carousel", at: "2026-09-09T19:30", title: "ドリップの湯温、3 パターン",             reach: 2420,  views: 2900,  likes: 160, comments: 10, saves: 198, shares: 22,  pv: 37,   follows: 5,    hue: 10 },
    { id: 15, type: "reel",     at: "2026-09-08T12:00", title: "お店の 1 日、朝から閉店まで",            reach: 2890,  views: 4100,  likes: 190, comments: 9,  saves: 72,  shares: 38,  pv: null, follows: null, len: 58, watch: 15.1, skip: 0.41, cuts: 22, text3: false, hue: 300 },
    { id: 16, type: "feed",     at: "2026-09-06T16:00", title: "常連さんの一言メモ",                     reach: 1480,  views: 1650,  likes: 139, comments: 12, saves: 24,  shares: 6,   pv: 18,   follows: 3,    hue: 45 },
    { id: 17, type: "reel",     at: "2026-09-05T18:00", title: "ミルの刃を替えたら",                     reach: 3410,  views: 4900,  likes: 221, comments: 15, saves: 133, shares: 54,  pv: null, follows: null, len: 19, watch: 9.1,  skip: 0.29, cuts: 8,  text3: true,  hue: 120 },
    { id: 18, type: "carousel", at: "2026-09-03T12:00", title: "9 月の豆のラインナップ",                 reach: 2150,  views: 2600,  likes: 150, comments: 7,  saves: 121, shares: 15,  pv: 33,   follows: 4,    hue: 70 },
    { id: 19, type: "feed",     at: "2026-09-02T10:30", title: "看板を塗り直しました",                   reach: 1230,  views: 1380,  likes: 112, comments: 9,  saves: 13,  shares: 2,   pv: 14,   follows: 1,    hue: 160 },
    { id: 20, type: "reel",     at: "2026-08-31T19:00", title: "エスプレッソの抽出、スローモーション",   reach: 5120,  views: 7600,  likes: 377, comments: 20, saves: 155, shares: 98,  pv: null, follows: null, len: 24, watch: 10.2, skip: 0.30, cuts: 7,  text3: false, hue: 15 },
    { id: 21, type: "feed",     at: "2026-08-29T08:00", title: "雨の日の店内",                           reach: 790,   views: 870,   likes: 66,  comments: 4,  saves: 7,   shares: 1,   pv: 7,    follows: 0,    hue: 220 },
    { id: 22, type: "carousel", at: "2026-08-27T19:30", title: "初めての方へ、おすすめ 3 種",            reach: 2980,  views: 3600,  likes: 212, comments: 13, saves: 245, shares: 31,  pv: 61,   follows: 11,   hue: 35 },
    { id: 23, type: "reel",     at: "2026-08-25T12:30", title: "カフェラテ 1 杯ができるまで",            reach: 4450,  views: 6500,  likes: 301, comments: 17, saves: 118, shares: 77,  pv: null, follows: null, len: 33, watch: 11.0, skip: 0.33, cuts: 11, text3: true,  hue: 28 },
    { id: 24, type: "feed",     at: "2026-08-23T17:00", title: "新メニューの試作",                       reach: 1610,  views: 1800,  likes: 143, comments: 11, saves: 29,  shares: 5,   pv: 19,   follows: 2,    hue: 100 }
  ];

  // 日次指標（30 日）。日付は API の区切り（米国太平洋時間）。
  var dailyDates = [];
  for (var i = 0; i < 30; i++) {
    var d = new Date(Date.UTC(2026, 8, 2 + i));
    dailyDates.push(d.toISOString().slice(0, 10));
  }
  var daily = {
    dates: dailyDates,
    reach:     [620, 580, 1140, 2980, 1760, 940, 710, 1650, 3420, 1890, 1020, 880, 5210, 2760, 1210, 990, 1430, 2630, 1540, 870, 760, 2210, 4810, 2120, 1080, 2340, 1310, 980, 3360, 1890],
    followers: [1842, 1843, 1845, 1851, 1856, 1857, 1857, 1860, 1868, 1872, 1873, 1873, 1889, 1895, 1897, 1898, 1900, 1905, 1908, 1908, 1909, 1913, 1924, 1928, 1929, 1934, 1936, 1937, 1945, 1948]
  };

  // 投稿詳細の見本（id 1 のリール）。伸び方と、同じ種類（リール）の中央値・四分位。
  var growth = {
    steps: ["1h", "3h", "6h", "24h", "3d", "7d", "14d", "30d", "60d", "90d"],
    reach: [420, 1220, 2280, 6050, 9070, 10200, null, null, null, null],
    medianReel: [210, 600, 1130, 3000, 4500, 5100, 5600, 6000, 6300, 6400],
    p75Reel: [300, 880, 1610, 4030, 5880, 6700, 7400, 7900, 8300, 8450],
    p25Reel: [130, 380, 720, 1960, 2880, 3350, 3700, 3950, 4150, 4250]
  };
  // カット（ミリ秒）と画面の文字の区間。
  var reelTimeline = {
    lenMs: 28000,
    cuts: [0, 2100, 3400, 6800, 9500, 12700, 16000, 19800, 23400, 26100],
    texts: [
      { text: "火入れ、はじめます", start: 400, end: 2000, pos: "下" },
      { text: "1 ハゼまで 8 分", start: 3600, end: 6500, pos: "下" },
      { text: "ここから色が変わる", start: 9800, end: 12500, pos: "中" },
      { text: "今日は中深煎り", start: 16200, end: 19500, pos: "下" },
      { text: "焼き上がり", start: 23600, end: 27800, pos: "上" }
    ]
  };

  // ストーリーズ。日ごとの並びと 1 枚ごとの数字。kind: image / video、len は秒。
  var stories = [
    { date: "2026-09-30", slides: [
      { kind: "video", len: 12, views: 612, fwd: 480, back: 22, exit: 61, swipe: 38, link: 0 },
      { kind: "image", len: 5,  views: 548, fwd: 441, back: 17, exit: 52, swipe: 31, link: 14 },
      { kind: "video", len: 15, views: 501, fwd: 402, back: 30, exit: 39, swipe: 24, link: 0 },
      { kind: "image", len: 5,  views: 470, fwd: 371, back: 11, exit: 58, swipe: 27, link: 9 },
      { kind: "video", len: 8,  views: 398, fwd: 0,   back: 15, exit: 310, swipe: 70, link: 0 }
    ] },
    { date: "2026-09-29", slides: [
      { kind: "image", len: 5,  views: 580, fwd: 462, back: 14, exit: 70, swipe: 29, link: 0 },
      { kind: "video", len: 14, views: 503, fwd: 398, back: 19, exit: 55, swipe: 26, link: 0 },
      { kind: "image", len: 5,  views: 441, fwd: 0,   back: 12, exit: 360, swipe: 66, link: 21 }
    ] },
    { date: "2026-09-28", slides: [
      { kind: "video", len: 10, views: 640, fwd: 512, back: 25, exit: 58, swipe: 40, link: 0 },
      { kind: "image", len: 5,  views: 571, fwd: 455, back: 20, exit: 61, swipe: 30, link: 0 },
      { kind: "image", len: 5,  views: 519, fwd: 412, back: 18, exit: 52, swipe: 33, link: 17 },
      { kind: "video", len: 9,  views: 466, fwd: 0,   back: 13, exit: 380, swipe: 68, link: 0 }
    ] }
  ];

  // 投稿時刻（曜日 × 時間帯）。投稿後 24 時間のリーチの中央値と件数（n）。日本時間で集計した体の架空の数字。
  var bands = ["0-3", "3-6", "6-9", "9-12", "12-15", "15-18", "18-21", "21-24"];
  var days = ["月", "火", "水", "木", "金", "土", "日"];
  var timing = { bands: bands, days: days, median: [], n: [] };
  var baseBand = [0, 0, 420, 820, 760, 980, 1320, 640];
  var dayMul = [0.9, 0.95, 1.0, 1.05, 1.1, 1.35, 1.2];
  var nTable = [
    [0, 0, 1, 2, 3, 1, 4, 1],
    [0, 0, 1, 3, 2, 1, 3, 0],
    [0, 0, 2, 2, 4, 2, 5, 1],
    [0, 0, 1, 3, 3, 1, 4, 1],
    [0, 0, 1, 2, 3, 2, 6, 2],
    [0, 0, 2, 4, 5, 3, 7, 2],
    [0, 0, 1, 3, 4, 2, 5, 1]
  ];
  for (var di = 0; di < 7; di++) {
    var mrow = [], nrow = [];
    for (var bi = 0; bi < 8; bi++) {
      var nn = nTable[di][bi];
      nrow.push(nn);
      mrow.push(nn === 0 ? null : Math.round(baseBand[bi] * dayMul[di] * (1 + ((di * 3 + bi * 7) % 5 - 2) * 0.04)));
    }
    timing.median.push(mrow);
    timing.n.push(nrow);
  }

  // 収集ジョブの実行記録（新しい順）。
  var jobs = [
    { at: "2026-10-01T23:30", job: "insights-daily", state: "ok",   ms: 4200,  items: 1,  msg: "日次指標 1 日分（PT 2026-09-30）を保存" },
    { at: "2026-10-01T23:00", job: "media-poll",     state: "ok",   ms: 2800,  items: 24, msg: "新規 0 件、更新 24 件" },
    { at: "2026-10-01T22:00", job: "media-poll",     state: "ok",   ms: 2600,  items: 24, msg: "新規 0 件、更新 24 件" },
    { at: "2026-10-01T21:00", job: "stories-poll",   state: "ok",   ms: 1900,  items: 5,  msg: "ストーリーズ 5 枚を更新、動画 2 本を解析" },
    { at: "2026-10-01T20:00", job: "media-poll",     state: "bad",  ms: 31000, items: 0,  msg: "HTTP 500 (code 2) Please retry your request later. 3 回の再試行後に失敗" },
    { at: "2026-10-01T19:00", job: "media-poll",     state: "ok",   ms: 3100,  items: 24, msg: "新規 0 件、更新 24 件" },
    { at: "2026-10-01T18:05", job: "media-poll",     state: "warn", ms: 12400, items: 24, msg: "レート制限に近づいたため 2 件の取得を次回に繰り延べ（使用率 86%）" },
    { at: "2026-10-01T18:00", job: "token-check",    state: "ok",   ms: 600,   items: 1,  msg: "有効。期限まで 47 日" },
    { at: "2026-10-01T17:00", job: "media-poll",     state: "ok",   ms: 2700,  items: 24, msg: "新規 0 件、更新 24 件" },
    { at: "2026-10-01T16:00", job: "media-poll",     state: "ok",   ms: 2900,  items: 25, msg: "新規 1 件（リール）、更新 24 件。初速の収集を開始" },
    { at: "2026-10-01T15:00", job: "stories-poll",   state: "ok",   ms: 1700,  items: 3,  msg: "ストーリーズ 3 枚を更新" },
    { at: "2026-10-01T14:00", job: "media-poll",     state: "ok",   ms: 2500,  items: 24, msg: "新規 0 件、更新 24 件" }
  ];

  return {
    account: { name: "こまち焙煎所（架空）", handle: "@komachi.roast.demo", followers: 1948, following: 312, mediaCount: 186 },
    period: { from: "2026-09-02", to: "2026-10-01", label: "過去 30 日", prevLabel: "前の 30 日" },
    updatedAt: "2026-10-01T23:30",
    // 概要の主要指標（今期と前期）
    kpis: {
      reach: { cur: 58120, prev: 51470 },
      views: { cur: 83400, prev: 70900 },
      followerGain: { cur: 106, prev: 74 },
      engagementRate: { cur: 0.0714, prev: 0.0668 },
      saveRate: { cur: 0.0326, prev: 0.0291 },
      profileVisits: { cur: 468, prev: 512 }
    },
    funnel: [
      { label: "リーチ", value: 58120 },
      { label: "反応したアカウント", value: 4310 },
      { label: "フォロー", value: 106 },
      { label: "リンクタップ", value: 61 }
    ],
    // 種類ごとの内訳（今期）
    byType: [
      { type: "feed", posts: 9, reach: 10390, saves: 135 },
      { type: "carousel", posts: 6, reach: 15500, saves: 1151 },
      { type: "reel", posts: 9, reach: 53320, saves: 1767 },
      { type: "story", posts: 38, reach: 21060, saves: 0 }
    ],
    posts: posts,
    daily: daily,
    growth: growth,
    reelTimeline: reelTimeline,
    stories: stories,
    timing: timing,
    // 時間帯別の初速（24 時間リーチの中央値と件数。曜日をまとめたもの）
    timingByBand: { bands: bands, median: [null, null, 470, 860, 820, 1010, 1450, 690], n: [0, 0, 9, 19, 24, 12, 34, 8] },
    // 曜日別（24 時間リーチの中央値と件数。時間帯をまとめたもの。n は timing の行の合計）
    timingByDay: { days: days, median: [810, 860, 900, 940, 990, 1220, 1080], n: [12, 10, 16, 13, 16, 25, 16] },
    jobs: jobs,
    connection: {
      state: "ok",
      pageName: "こまち焙煎所（架空）",
      igAccount: "@komachi.roast.demo",
      tokenIssuedAt: "2026-09-28",
      tokenExpiresAt: "2026-11-17",
      tokenDaysLeft: 47,
      tokenDaysTotal: 60,
      lastSuccessAt: "2026-10-01T23:30",
      nextRunAt: "2026-10-02T00:00",
      schedule: "毎時 00 分（投稿直後の 24 時間は 15 分おき）",
      rateUsage: 0.42
    }
  };
})();
