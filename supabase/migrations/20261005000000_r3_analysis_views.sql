-- R3: 分析画面のビューと関数
-- 設計: doc/design/r3-analysis-screens.md 4 章（4.3 節の SQL の案）。ロールバックはこのファイルの末尾のコメント
--
-- 設計書の案と違えた所:
--   - media_metrics_at_horizon の 90d の行は入れた。確認事項 Q16 は未決だが、収集は 90 日を超えても
--     30 日おきに続く（doc/design/r1-collection-jobs.md の取得間隔の表）ので、90 日時点のスナップショットはある。
--     決め直して外すときは、このビューを 30d までの values で create or replace し直せばよい
--     （行が減るだけで列は変わらない）。
--   - 列ごとの comment を足した（within_tolerance、skip_rate、reach_rate、内訳の列）。式は設計書のまま。

-- ---------------------------------------------------------------
-- 1. 投稿の種類（フィード、カルーセル、リール、ストーリーズ）
-- インライン展開させるため、set search_path も strict も付けない（R-7、再レビュー軽-1。strict があると
-- CASE を含む本体は展開されない）。引数の列（media_product_type、media_type）は NOT NULL なので、strict を外しても結果は同じ。
-- 本体は引数の比較だけでテーブルを参照しない。Supabase の linter の function_search_path_mutable の警告は受け入れる
-- ---------------------------------------------------------------
create or replace function public.media_kind(p_product_type text, p_media_type text)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when p_product_type = 'REELS' then 'reel'
    when p_product_type = 'STORY' then 'story'
    when p_media_type = 'CAROUSEL_ALBUM' then 'carousel'
    else 'feed'
  end
$$;

comment on function public.media_kind(text, text) is
  '投稿の種類。feed: フィード、carousel: カルーセル、reel: リール、story: ストーリーズ';

-- R2 の決まり: 関数を足したら PUBLIC の実行権を取り消す（結合テストが棚卸しする）
revoke execute on function public.media_kind(text, text) from public;
grant execute on function public.media_kind(text, text) to web_app;

-- ---------------------------------------------------------------
-- 2. media_metrics_at_horizon に許容幅の列を足す（create or replace では列は末尾にだけ足せる）。
-- 許容幅: 1h〜6h は + 1 時間、24h 以上は + 区分の 25%（確認事項 Q3）
-- 既存の grant（web_app の select）は create or replace で残る
-- ---------------------------------------------------------------
create or replace view public.media_metrics_at_horizon
with (security_invoker = true) as
with horizons (horizon, horizon_seconds, tolerance_seconds) as (
  values
    ('1h', 3600, 3600), ('3h', 10800, 3600), ('6h', 21600, 3600),
    ('24h', 86400, 21600), ('3d', 259200, 64800), ('7d', 604800, 151200),
    ('30d', 2592000, 648000), ('90d', 7776000, 1944000)
)
select
  m.id as media_id, h.horizon, h.horizon_seconds, s.fetched_at, s.elapsed_seconds, s.metrics,
  h.tolerance_seconds,
  (s.elapsed_seconds <= h.horizon_seconds + h.tolerance_seconds) as within_tolerance
from public.media m
cross join horizons h
cross join lateral (
  select s.fetched_at, s.elapsed_seconds, s.metrics
  from public.media_insight_snapshots s
  where s.media_id = m.id and s.elapsed_seconds >= h.horizon_seconds
  order by s.elapsed_seconds
  limit 1
) s
union all
select m.id, 'latest'::text, null::integer, s.fetched_at, s.elapsed_seconds, s.metrics,
  null::integer, true
from public.media m
cross join lateral (
  select s.fetched_at, s.elapsed_seconds, s.metrics
  from public.media_insight_snapshots s
  where s.media_id = m.id
  order by s.fetched_at desc
  limit 1
) s;

comment on view public.media_metrics_at_horizon is
  '投稿からの経過時間をそろえた指標。horizon は 1h, 3h, 6h, 24h, 3d, 7d, 30d, 90d, latest。'
  'within_tolerance は実際の経過時間が区分 + 許容幅に入るか（伸び方のグラフの点とリーチ率の 7 日時点の値にだけ使う）';
comment on column public.media_metrics_at_horizon.tolerance_seconds is
  '区分の許容幅（秒）。latest は null';
comment on column public.media_metrics_at_horizon.within_tolerance is
  '実際の経過時間 ≦ 区分 + 許容幅。latest は常に true';

-- ---------------------------------------------------------------
-- 3. media_horizon_metrics: 投稿（ストーリーズを除く）× 区分ごとの指標と派生指標
-- ---------------------------------------------------------------
create view public.media_horizon_metrics
with (security_invoker = true) as
with base as (
  select
    h.media_id,
    m.account_id,
    public.media_kind(m.media_product_type, m.media_type) as kind,
    m.posted_at,
    m.gone_at,
    m.is_collab, m.is_trial_reel, m.is_boosted,
    h.horizon, h.horizon_seconds, h.tolerance_seconds, h.within_tolerance,
    h.elapsed_seconds, h.fetched_at,
    public.metric_value(h.metrics, '{reach}') as reach,
    public.metric_value(h.metrics, '{views}') as views,
    public.metric_value(h.metrics, '{likes}') as likes,
    public.metric_value(h.metrics, '{comments}') as comments,
    public.metric_value(h.metrics, '{saved}') as saved,
    public.metric_value(h.metrics, '{shares}') as shares,
    public.metric_value(h.metrics, '{profile_visits}') as profile_visits,
    public.metric_value(h.metrics, '{follows}') as follows,
    public.metric_value(h.metrics, '{ig_reels_avg_watch_time}') as avg_watch_time_ms,
    -- API の unit は percent で、実値は 0〜100（確認済み）。0〜1 にそろえる（R-5）
    public.metric_value(h.metrics, '{reels_skip_rate}') / 100 as skip_rate
  from public.media_metrics_at_horizon h
  join public.media m on m.id = h.media_id
  where m.media_product_type <> 'STORY'
)
select
  b.*,
  (b.likes + b.comments + b.saved + b.shares) / nullif(b.reach, 0) as er,
  b.saved / nullif(b.reach, 0) as save_rate,
  b.shares / nullif(b.reach, 0) as share_rate,
  b.likes / nullif(b.reach, 0) as like_rate,
  b.comments / nullif(b.reach, 0) as comment_rate,
  b.profile_visits / nullif(b.reach, 0) as profile_visit_rate,
  b.follows / nullif(b.profile_visits, 0) as follow_conversion_rate,
  b.views / nullif(b.reach, 0) as views_per_reach
from base b;

comment on view public.media_horizon_metrics is
  '投稿（ストーリーズを除く）の経過時間の区分ごとの指標と派生指標。基準値は horizon = latest の行に対してクエリで計算する。within_tolerance は伸び方のグラフの点にだけ使う。skip_rate は 0〜1';
comment on column public.media_horizon_metrics.skip_rate is
  'reels_skip_rate（API は 0〜100 の percent）を 100 で割った 0〜1 の値';

-- ---------------------------------------------------------------
-- 4. media_list_metrics: 投稿一覧（1 投稿 1 行）。最新の値、7 日時点のリーチ、投稿時のフォロワー数、リーチ率
-- media_horizon_metrics を 2 回（latest と 7d）結合する。数百件を超えて遅ければ lateral 2 本の形に変える（R-8）
-- ---------------------------------------------------------------
create view public.media_list_metrics
with (security_invoker = true) as
select
  m.id as media_id,
  m.account_id,
  public.media_kind(m.media_product_type, m.media_type) as kind,
  m.media_type,
  m.media_product_type,
  m.posted_at,
  -- 日付の変換はここだけで行う（JS で二重に持たない。6 章）
  (m.posted_at at time zone 'Asia/Tokyo')::date as posted_date_jst,
  (m.posted_at at time zone 'America/Los_Angeles')::date as posted_date_pt,
  m.caption,
  m.permalink,
  m.thumbnail_path,
  m.is_collab, m.is_trial_reel, m.is_boosted,
  m.gone_at,
  lt.fetched_at as latest_fetched_at,
  lt.elapsed_seconds as elapsed_latest,
  lt.reach, lt.views, lt.likes, lt.comments, lt.saved, lt.shares,
  lt.profile_visits, lt.follows, lt.avg_watch_time_ms, lt.skip_rate,
  lt.er, lt.save_rate, lt.share_rate, lt.like_rate, lt.comment_rate,
  lt.profile_visit_rate, lt.follow_conversion_rate, lt.views_per_reach,
  d7.reach as reach_7d,
  d7.elapsed_seconds as elapsed_7d,
  pf.followers_count as followers_at_post,
  pf.captured_at as followers_captured_at,
  d7.reach / nullif(pf.followers_count, 0) as reach_rate
from public.media m
left join public.media_horizon_metrics lt
  on lt.media_id = m.id and lt.horizon = 'latest'
left join public.media_horizon_metrics d7
  on d7.media_id = m.id and d7.horizon = '7d' and d7.within_tolerance
left join lateral (
  -- 投稿より前の、最も近い記録（3 日以内）。投稿の後に取った記録は使わない（R-10）
  select p.followers_count, p.captured_at
  from public.profile_daily p
  where p.account_id = m.account_id
    and p.captured_at <= m.posted_at
    and p.captured_at >= m.posted_at - interval '3 days'
  order by p.captured_at desc
  limit 1
) pf on true
where m.media_product_type <> 'STORY';

comment on view public.media_list_metrics is
  '投稿一覧（ストーリーズを除く）。指標は最新のスナップショット。リーチ率は 7 日時点（許容幅内）のリーチ ÷ 投稿前 3 日以内の記録のフォロワー数';
comment on column public.media_list_metrics.reach_7d is
  '7 日時点のリーチ。実際の経過時間が 7 日 + 42 時間を超えたスナップショットしかなければ null';
comment on column public.media_list_metrics.reach_rate is
  'reach_7d ÷ followers_at_post。どちらかがなければ null';

-- ---------------------------------------------------------------
-- 5. account_daily_wide: アカウント日次指標を 1 日 1 行にする（日付は API の日付 = 米国太平洋時間）
-- 内訳の列の決め方（R-2、再レビュー中-1、軽-3）:
--   区分の行がある            → その値（value が null なら null のまま。0 にしない）
--   区分の行がなく、同じ指標・内訳の別の区分の行がある、または印の行の value が 0 → 0（値が 0 の区分は行がない）
--   それ以外（印の値が正なのに区分の行が 1 つもない、印の行がない） → null（未取得）
-- ---------------------------------------------------------------
create view public.account_daily_wide
with (security_invoker = true) as
select
  d.account_id,
  d.metric_date,
  max(d.value) filter (where d.metric = 'reach' and d.breakdown = '') as reach,
  max(d.value) filter (where d.metric = 'views' and d.breakdown = '') as views,
  max(d.value) filter (where d.metric = 'accounts_engaged' and d.breakdown = '') as accounts_engaged,
  max(d.value) filter (where d.metric = 'total_interactions' and d.breakdown = '') as total_interactions,
  max(d.value) filter (where d.metric = 'likes' and d.breakdown = '') as likes,
  max(d.value) filter (where d.metric = 'comments' and d.breakdown = '') as comments,
  max(d.value) filter (where d.metric = 'shares' and d.breakdown = '') as shares,
  max(d.value) filter (where d.metric = 'saves' and d.breakdown = '') as saved,
  max(d.value) filter (where d.metric = 'follower_count' and d.breakdown = '') as new_followers,
  case
    when bool_or(d.metric = 'reach' and d.breakdown = 'follow_type' and d.breakdown_value = 'FOLLOWER')
      then max(d.value) filter (where d.metric = 'reach' and d.breakdown = 'follow_type' and d.breakdown_value = 'FOLLOWER')
    when bool_or(d.metric = 'reach' and d.breakdown = 'follow_type' and d.breakdown_value <> '')
      or bool_or(d.metric = 'reach' and d.breakdown = 'follow_type' and d.breakdown_value = '' and d.value = 0)
      then 0
  end as reach_follower,
  case
    when bool_or(d.metric = 'reach' and d.breakdown = 'follow_type' and d.breakdown_value = 'NON_FOLLOWER')
      then max(d.value) filter (where d.metric = 'reach' and d.breakdown = 'follow_type' and d.breakdown_value = 'NON_FOLLOWER')
    when bool_or(d.metric = 'reach' and d.breakdown = 'follow_type' and d.breakdown_value <> '')
      or bool_or(d.metric = 'reach' and d.breakdown = 'follow_type' and d.breakdown_value = '' and d.value = 0)
      then 0
  end as reach_non_follower,
  case
    when bool_or(d.metric = 'views' and d.breakdown = 'follow_type' and d.breakdown_value = 'FOLLOWER')
      then max(d.value) filter (where d.metric = 'views' and d.breakdown = 'follow_type' and d.breakdown_value = 'FOLLOWER')
    when bool_or(d.metric = 'views' and d.breakdown = 'follow_type' and d.breakdown_value <> '')
      or bool_or(d.metric = 'views' and d.breakdown = 'follow_type' and d.breakdown_value = '' and d.value = 0)
      then 0
  end as views_follower,
  case
    when bool_or(d.metric = 'views' and d.breakdown = 'follow_type' and d.breakdown_value = 'NON_FOLLOWER')
      then max(d.value) filter (where d.metric = 'views' and d.breakdown = 'follow_type' and d.breakdown_value = 'NON_FOLLOWER')
    when bool_or(d.metric = 'views' and d.breakdown = 'follow_type' and d.breakdown_value <> '')
      or bool_or(d.metric = 'views' and d.breakdown = 'follow_type' and d.breakdown_value = '' and d.value = 0)
      then 0
  end as views_non_follower,
  max(d.fetched_at) as fetched_at
from public.account_daily_metrics d
group by d.account_id, d.metric_date;

comment on view public.account_daily_wide is
  'アカウント日次指標の横持ち。metric_date は API の日付（米国太平洋時間の 0 時区切り）。行がない日は欠け。'
  '内訳の列は、区分の行があればその値、別の区分の行があるか印の値が 0 なら 0、それ以外は null（未取得）。'
  'saved は API の saves。new_followers は直近 30 日のみ。最新の日は follower_count だけで reach が null のことがある';

-- ---------------------------------------------------------------
-- 6. web_app への権限（R2 の決まり: 列挙する）
-- media_metrics_at_horizon は create or replace なので既存の grant が残る
-- ---------------------------------------------------------------
grant select on table
  public.media_horizon_metrics,
  public.media_list_metrics,
  public.account_daily_wide
to web_app;

-- ---------------------------------------------------------------
-- ロールバック（R-13。手で流す。依存の順に消す）
-- ---------------------------------------------------------------
-- drop view if exists public.media_list_metrics;
-- drop view if exists public.media_horizon_metrics;
-- drop view if exists public.account_daily_wide;
--
-- -- media_metrics_at_horizon は足した列を create or replace で消せないので、消して R1 の定義
-- -- （20261001100400_r1_views.sql の 94〜139 行）で作り直し、comment と grant をやり直す
-- drop view if exists public.media_metrics_at_horizon;
--
-- create view public.media_metrics_at_horizon
-- with (security_invoker = true) as
-- with horizons (horizon, horizon_seconds) as (
--   values
--     ('1h', 3600),
--     ('3h', 10800),
--     ('6h', 21600),
--     ('24h', 86400),
--     ('3d', 259200),
--     ('7d', 604800),
--     ('30d', 2592000)
-- )
-- select
--   m.id as media_id,
--   h.horizon,
--   h.horizon_seconds,
--   s.fetched_at,
--   s.elapsed_seconds,
--   s.metrics
-- from public.media m
-- cross join horizons h
-- cross join lateral (
--   select s.fetched_at, s.elapsed_seconds, s.metrics
--   from public.media_insight_snapshots s
--   where s.media_id = m.id and s.elapsed_seconds >= h.horizon_seconds
--   order by s.elapsed_seconds
--   limit 1
-- ) s
-- union all
-- select
--   m.id as media_id,
--   'latest'::text as horizon,
--   null::integer as horizon_seconds,
--   s.fetched_at,
--   s.elapsed_seconds,
--   s.metrics
-- from public.media m
-- cross join lateral (
--   select s.fetched_at, s.elapsed_seconds, s.metrics
--   from public.media_insight_snapshots s
--   where s.media_id = m.id
--   order by s.fetched_at desc
--   limit 1
-- ) s;
--
-- comment on view public.media_metrics_at_horizon is '投稿からの経過時間をそろえた指標。horizon は 1h, 3h, 6h, 24h, 3d, 7d, 30d, latest';
--
-- grant select on table public.media_metrics_at_horizon to web_app;
--
-- drop function if exists public.media_kind(text, text);
--
-- -- マイグレーションの記録も消す（CLI の履歴と合わせる）
-- delete from supabase_migrations.schema_migrations where version = '20261005000000';
