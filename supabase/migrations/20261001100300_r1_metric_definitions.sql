-- R1: 指標の定義
-- 設計: doc/design/r1-db-design.md 3.10 章
-- 初期データは R0 の実機検証（doc/verification/r0-meta-api-verification.md）に基づく。

create table public.metric_definitions (
  scope text not null check (scope in ('account_daily', 'media')),
  metric text not null,
  label_ja text not null,
  description text,
  unit text not null default 'count' check (unit in ('count', 'ms', 'percent')),
  breakdowns text[],
  media_product_types text[],
  available_from date,
  deprecated_on date,
  successor text,
  primary key (scope, metric)
);

comment on table public.metric_definitions is '指標の定義。画面の表示名と、使える期間、廃止と後継を持つ';
comment on column public.metric_definitions.scope is 'account_daily: アカウント日次指標、media: 投稿とストーリーズの指標';
comment on column public.metric_definitions.breakdowns is 'account_daily で指定できる内訳の種類';
comment on column public.metric_definitions.media_product_types is 'media で取れる投稿の種類（FEED、REELS、STORY）';

alter table public.metric_definitions enable row level security;

-- アカウント日次指標
insert into public.metric_definitions
  (scope, metric, label_ja, description, unit, breakdowns, available_from, deprecated_on, successor)
values
  ('account_daily', 'reach', 'リーチ', '投稿やストーリーズを見たアカウントの数', 'count', array['follow_type', 'media_product_type'], null, null, null),
  ('account_daily', 'views', '閲覧数', '投稿やストーリーズが表示された回数。2025-04-21 に impressions から統一', 'count', array['follow_type', 'media_product_type'], '2025-04-21', null, null),
  ('account_daily', 'impressions', 'インプレッション', '2025-04-21 に views へ統一され廃止', 'count', null, null, '2025-04-21', 'views'),
  ('account_daily', 'accounts_engaged', '反応したアカウント数', 'いいね、コメント、保存、シェアなどをしたアカウントの数', 'count', null, null, null, null),
  ('account_daily', 'total_interactions', '反応の合計', 'いいね、コメント、保存、シェアなどの合計', 'count', array['media_product_type'], null, null, null),
  ('account_daily', 'likes', 'いいね', null, 'count', null, null, null, null),
  ('account_daily', 'comments', 'コメント', null, 'count', null, null, null, null),
  ('account_daily', 'shares', 'シェア', null, 'count', null, null, null, null),
  ('account_daily', 'saves', '保存', null, 'count', null, null, null, null),
  ('account_daily', 'replies', 'ストーリーズへの返信', null, 'count', null, null, null, null),
  ('account_daily', 'reposts', 'リポスト', null, 'count', null, null, null, null),
  ('account_daily', 'follows_and_unfollows', 'フォローとフォロー解除', null, 'count', array['follow_type'], null, null, null),
  ('account_daily', 'profile_links_taps', 'プロフィールのリンクのタップ', 'ウェブサイト、メール、電話などのボタンのタップ', 'count', array['contact_button_type'], null, null, null),
  ('account_daily', 'follower_count', '新規フォロワー数', '1 日ごとの新規フォロワー数。API では直近 30 日しか取れない', 'count', null, null, null, null),
  ('account_daily', 'online_followers', '時間帯別オンラインフォロワー数', 'R0 検証では中身が空だった（V6）。取れるようになったら使う', 'count', null, null, null, null);

-- 投稿とストーリーズの指標
insert into public.metric_definitions
  (scope, metric, label_ja, description, unit, media_product_types)
values
  ('media', 'views', '閲覧数', '表示された回数', 'count', array['FEED', 'REELS', 'STORY']),
  ('media', 'reach', 'リーチ', '見たアカウントの数', 'count', array['FEED', 'REELS', 'STORY']),
  ('media', 'likes', 'いいね', null, 'count', array['FEED', 'REELS']),
  ('media', 'comments', 'コメント', null, 'count', array['FEED', 'REELS']),
  ('media', 'saved', '保存', null, 'count', array['FEED', 'REELS']),
  ('media', 'shares', 'シェア', null, 'count', array['FEED', 'REELS', 'STORY']),
  ('media', 'reposts', 'リポスト', null, 'count', array['FEED', 'REELS', 'STORY']),
  ('media', 'total_interactions', '反応の合計', null, 'count', array['FEED', 'REELS', 'STORY']),
  ('media', 'profile_visits', 'プロフィール訪問', 'リールでは取れない（R0 検証 V7）', 'count', array['FEED', 'STORY']),
  ('media', 'profile_activity', 'プロフィールでの行動', '内訳は action_type。リールでは取れない', 'count', array['FEED', 'STORY']),
  ('media', 'follows', 'フォロー', 'リールでは取れない（R0 検証 V7）', 'count', array['FEED', 'STORY']),
  ('media', 'ig_reels_avg_watch_time', '平均視聴時間', 'ミリ秒', 'ms', array['REELS']),
  ('media', 'ig_reels_video_view_total_time', '総視聴時間', 'ミリ秒', 'ms', array['REELS']),
  ('media', 'reels_skip_rate', 'スキップ率', '冒頭 3 秒で離脱した割合（パーセント）', 'percent', array['REELS']),
  ('media', 'replies', '返信', '日本のアカウントでは常に 0', 'count', array['STORY']),
  ('media', 'navigation', '操作', '内訳は tap_forward、tap_back、tap_exit、swipe_forward', 'count', array['STORY']),
  ('media', 'link_clicks', 'リンクのクリック', null, 'count', array['STORY']);
