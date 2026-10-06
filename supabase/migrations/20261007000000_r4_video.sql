-- R4: 動画分析（長さとカット）の DB
-- 設計: doc/design/r4-video-analysis.md 5 章（5.1 節、5.2 節）。ロールバックはこのファイルの末尾のコメント
--
-- 1. current_video_condition(): 今の解析条件（版としきい値）。しきい値を変えるたびにこの関数を作り直す
-- 2. video_analyses.attempt_count: 同じ条件で書いた回数（video_analysis の打ち切りに使う）
-- 3. media_video_features: 画面用。動画の投稿 1 件 1 行で、今の条件の解析結果だけをつなぐ
-- 4. media_analysis_dataset に retention_rate を足す（確認事項 Q5）
-- 5. video_cuts.scene_score の comment を R4 の保存の仕方に合わせる

-- ---------------------------------------------------------------
-- 1. 今の解析条件。ワーカーの ANALYZER_VERSION と DEFAULT_SCENE_THRESHOLD と一致させる（結合テストで突き合わせる）。
-- 本体は定数だけでテーブルを参照しない（immutable）。しきい値を決め直したら、このマイグレーションと同じ形で
-- 新しいマイグレーションに create or replace を書く（決めた記録にもなる）
-- ---------------------------------------------------------------
create or replace function public.current_video_condition(out analyzer_version text, out scene_threshold numeric)
language sql
immutable
parallel safe
as $$ select '1'::text, 0.300::numeric $$;

comment on function public.current_video_condition() is
  '今の動画の解析条件（analyzer_version、scene_threshold）。ワーカーの ANALYZER_VERSION と DEFAULT_SCENE_THRESHOLD と同じ値。画面のビューはこの条件の解析結果だけを使う';

-- R2 の決まり: 関数を足したら PUBLIC の実行権を取り消す（web-role.test.ts が棚卸しする）
revoke execute on function public.current_video_condition() from public;
grant execute on function public.current_video_condition() to web_app;

-- ---------------------------------------------------------------
-- 2. attempt_count。定数の既定値なので表は書き直されない（既存の行は 1 になる）
-- ---------------------------------------------------------------
alter table public.video_analyses
  add column attempt_count integer not null default 1 check (attempt_count >= 1);

comment on column public.video_analyses.attempt_count is
  '同じ条件で書いた回数。success 以外で上限（ワーカーの VIDEO_MAX_ATTEMPTS）に達したら video_analysis の対象外。ストーリーズは打ち切らない';

-- ---------------------------------------------------------------
-- 5. scene_score（R4 から保存する）
-- ---------------------------------------------------------------
comment on column public.video_cuts.scene_score is
  '画面変化の大きさ（0〜1。ffmpeg の lavfi.scene_score）。ffmpeg は小数 6 桁で出すが、この列は小数 4 桁に丸めて入るので、しきい値ちょうど付近の点は丸めで上下しうる（カットの選別は ffmpeg の値で行う）。R1 の行は null';

-- ---------------------------------------------------------------
-- 3. media_video_features: 画面用（投稿詳細のタイムライン、リール分析）。
-- 行は動画の投稿（リールとフィード動画）だけ。解析結果は今の条件の 1 行だけを使い、特徴量と状態を同じ行から取る。
-- analysis_status が null は「まだ解析していない」。success 以外の行では特徴量は null。
-- retention_rate は R3 と同じ源（media_horizon_metrics の latest）の平均視聴時間 ÷ 動画の長さ。
-- 1 を超えることがある（繰り返し再生）。丸めない。media_analysis_dataset.retention_rate と同じ式
-- ---------------------------------------------------------------
create view public.media_video_features
with (security_invoker = true) as
select
  m.id as media_id,
  m.account_id,
  m.media_product_type,
  m.media_type,
  m.posted_at,
  va.id as analysis_id,
  va.status as analysis_status,
  va.attempt_count,
  va.analyzed_at,
  va.duration_ms,
  va.width,
  va.height,
  va.fps,
  va.has_audio,
  va.cut_count,
  va.avg_scene_ms,
  va.first_cut_ms,
  va.cuts_in_first_3s,
  lt.avg_watch_time_ms::numeric / nullif(va.duration_ms, 0) as retention_rate
from public.media m
cross join public.current_video_condition() c
left join public.video_analyses va
  on va.media_id = m.id
 and va.analyzer_version = c.analyzer_version
 and va.scene_threshold = c.scene_threshold
left join public.media_horizon_metrics lt
  on lt.media_id = m.id and lt.horizon = 'latest'
where m.media_type = 'VIDEO'
  and m.media_product_type in ('REELS', 'FEED');

comment on view public.media_video_features is
  '動画の投稿（リール、フィード動画）1 件 1 行の動画の特徴量。今の条件（current_video_condition()）の解析結果だけを使う。analysis_status が null はまだ解析していない。success 以外では特徴量は null。error 列は持たない';
comment on column public.media_video_features.retention_rate is
  '視聴維持率 = 平均視聴時間（media_horizon_metrics の latest）÷ 動画の長さ。1 を超えることがある。丸めない。media_analysis_dataset.retention_rate と同じ式';

revoke all on table public.media_video_features from public, anon, authenticated;
grant select on table public.media_video_features to web_app;

-- ---------------------------------------------------------------
-- 4. media_analysis_dataset に retention_rate を足す（確認事項 Q5。create or replace では列は末尾にだけ足せる）。
-- 定義は 20261001100400_r1_views.sql の 145〜288 行と同じで、末尾に 1 列を足しただけ。
-- 既存の grant（web_app の select）と comment は create or replace で残る。
-- 動画の特徴量は R1 と同じく「最新の success（条件をまたぐ）」で、分母の duration_ms もその行のもの
-- ---------------------------------------------------------------
create or replace view public.media_analysis_dataset
with (security_invoker = true) as
select
  -- 投稿の属性
  m.id as media_id,
  m.account_id,
  m.media_product_type,
  m.media_type,
  m.posted_at,
  (m.posted_at at time zone 'Asia/Tokyo') as posted_at_jst,
  extract(isodow from m.posted_at at time zone 'Asia/Tokyo')::integer as posted_isodow_jst,
  extract(hour from m.posted_at at time zone 'Asia/Tokyo')::integer as posted_hour_jst,
  char_length(coalesce(m.caption, '')) as caption_chars,
  (
    select count(*)
    from regexp_matches(coalesce(m.caption, ''), '#[^\s#]+', 'g')
  )::integer as hashtag_count,
  m.is_collab,
  m.is_trial_reel,
  m.is_boosted,
  m.gone_at is not null as is_gone,
  -- ストーリーズの属性
  st.story_seq,
  st.story_count_of_day,
  -- 動画の特徴量（最新の成功した解析）
  v.analyzer_version,
  v.scene_threshold,
  v.duration_ms,
  v.has_audio,
  v.cut_count,
  v.avg_scene_ms,
  v.first_cut_ms,
  v.cuts_in_first_3s,
  -- 1 時間後
  h1.elapsed_seconds as elapsed_1h,
  public.metric_value(h1.metrics, '{views}') as views_1h,
  public.metric_value(h1.metrics, '{reach}') as reach_1h,
  public.metric_value(h1.metrics, '{likes}') as likes_1h,
  public.metric_value(h1.metrics, '{comments}') as comments_1h,
  public.metric_value(h1.metrics, '{shares}') as shares_1h,
  public.metric_value(h1.metrics, '{saved}') as saved_1h,
  public.metric_value(h1.metrics, '{total_interactions}') as total_interactions_1h,
  -- 24 時間後
  h24.elapsed_seconds as elapsed_24h,
  public.metric_value(h24.metrics, '{views}') as views_24h,
  public.metric_value(h24.metrics, '{reach}') as reach_24h,
  public.metric_value(h24.metrics, '{likes}') as likes_24h,
  public.metric_value(h24.metrics, '{comments}') as comments_24h,
  public.metric_value(h24.metrics, '{shares}') as shares_24h,
  public.metric_value(h24.metrics, '{saved}') as saved_24h,
  public.metric_value(h24.metrics, '{total_interactions}') as total_interactions_24h,
  -- 7 日後
  d7.elapsed_seconds as elapsed_7d,
  public.metric_value(d7.metrics, '{views}') as views_7d,
  public.metric_value(d7.metrics, '{reach}') as reach_7d,
  public.metric_value(d7.metrics, '{likes}') as likes_7d,
  public.metric_value(d7.metrics, '{comments}') as comments_7d,
  public.metric_value(d7.metrics, '{shares}') as shares_7d,
  public.metric_value(d7.metrics, '{saved}') as saved_7d,
  public.metric_value(d7.metrics, '{total_interactions}') as total_interactions_7d,
  -- 30 日後
  d30.elapsed_seconds as elapsed_30d,
  public.metric_value(d30.metrics, '{views}') as views_30d,
  public.metric_value(d30.metrics, '{reach}') as reach_30d,
  public.metric_value(d30.metrics, '{likes}') as likes_30d,
  public.metric_value(d30.metrics, '{comments}') as comments_30d,
  public.metric_value(d30.metrics, '{shares}') as shares_30d,
  public.metric_value(d30.metrics, '{saved}') as saved_30d,
  public.metric_value(d30.metrics, '{total_interactions}') as total_interactions_30d,
  -- 最新（ストーリーズでは消えた後は最終値）
  lt.fetched_at as latest_fetched_at,
  lt.elapsed_seconds as elapsed_latest,
  public.metric_value(lt.metrics, '{views}') as views_latest,
  public.metric_value(lt.metrics, '{reach}') as reach_latest,
  public.metric_value(lt.metrics, '{likes}') as likes_latest,
  public.metric_value(lt.metrics, '{comments}') as comments_latest,
  public.metric_value(lt.metrics, '{shares}') as shares_latest,
  public.metric_value(lt.metrics, '{saved}') as saved_latest,
  public.metric_value(lt.metrics, '{total_interactions}') as total_interactions_latest,
  public.metric_value(lt.metrics, '{follows}') as follows_latest,
  public.metric_value(lt.metrics, '{profile_visits}') as profile_visits_latest,
  -- リールの視聴系（最新）
  public.metric_value(lt.metrics, '{ig_reels_avg_watch_time}') as avg_watch_time_ms_latest,
  public.metric_value(lt.metrics, '{ig_reels_video_view_total_time}') as total_watch_time_ms_latest,
  public.metric_value(lt.metrics, '{reels_skip_rate}') as skip_rate_latest,
  -- ストーリーズの操作（最新）
  public.metric_value(lt.metrics, '{replies}') as replies_latest,
  public.metric_value(lt.metrics, '{navigation,tap_forward}') as tap_forward_latest,
  public.metric_value(lt.metrics, '{navigation,tap_back}') as tap_back_latest,
  public.metric_value(lt.metrics, '{navigation,tap_exit}') as tap_exit_latest,
  public.metric_value(lt.metrics, '{navigation,swipe_forward}') as swipe_forward_latest,
  public.metric_value(lt.metrics, '{link_clicks}') as link_clicks_latest,
  -- 視聴維持率（R4。media_video_features.retention_rate と同じ式）
  public.metric_value(lt.metrics, '{ig_reels_avg_watch_time}')::numeric / nullif(v.duration_ms, 0) as retention_rate
from public.media m
left join lateral (
  select
    count(*) filter (where s2.posted_at <= m.posted_at)::integer as story_seq,
    count(*)::integer as story_count_of_day
  from public.media s2
  where s2.account_id = m.account_id
    and s2.media_product_type = 'STORY'
    and (s2.posted_at at time zone 'Asia/Tokyo')::date = (m.posted_at at time zone 'Asia/Tokyo')::date
) st on m.media_product_type = 'STORY'
left join lateral (
  select v.*
  from public.video_analyses v
  where v.media_id = m.id and v.status = 'success'
  order by v.analyzed_at desc
  limit 1
) v on true
left join lateral (
  select s.elapsed_seconds, s.metrics
  from public.media_insight_snapshots s
  where s.media_id = m.id and s.elapsed_seconds >= 3600
  order by s.elapsed_seconds
  limit 1
) h1 on true
left join lateral (
  select s.elapsed_seconds, s.metrics
  from public.media_insight_snapshots s
  where s.media_id = m.id and s.elapsed_seconds >= 86400
  order by s.elapsed_seconds
  limit 1
) h24 on true
left join lateral (
  select s.elapsed_seconds, s.metrics
  from public.media_insight_snapshots s
  where s.media_id = m.id and s.elapsed_seconds >= 604800
  order by s.elapsed_seconds
  limit 1
) d7 on true
left join lateral (
  select s.elapsed_seconds, s.metrics
  from public.media_insight_snapshots s
  where s.media_id = m.id and s.elapsed_seconds >= 2592000
  order by s.elapsed_seconds
  limit 1
) d30 on true
left join lateral (
  select s.fetched_at, s.elapsed_seconds, s.metrics
  from public.media_insight_snapshots s
  where s.media_id = m.id
  order by s.fetched_at desc
  limit 1
) lt on true;

comment on column public.media_analysis_dataset.retention_rate is
  '視聴維持率 = 最新の ig_reels_avg_watch_time ÷ duration_ms（最新の success の解析）。1 を超えることがある。丸めない。media_video_features.retention_rate と同じ式';

-- ---------------------------------------------------------------
-- ロールバック（手で流す。順番が大事）
-- ---------------------------------------------------------------
-- 1. 先にワーカーを R4 より前の版に戻す（upsertVideoAnalysis が attempt_count を書くので、逆にすると stories を含む毎時のジョブが失敗する）
-- drop view if exists public.media_video_features;
-- -- media_analysis_dataset は足した列を create or replace で消せないので、drop して R1 の定義
-- -- （20261001100400_r1_views.sql の 145〜290 行）で作り直し、grant をやり直す:
-- --   drop view if exists public.media_analysis_dataset;
-- --   （R1 の create view と comment on view をそのまま流す）
-- --   grant select on table public.media_analysis_dataset to web_app;
-- drop function if exists public.current_video_condition();
-- alter table public.video_analyses drop column if exists attempt_count;
-- comment on column public.video_cuts.scene_score is '画面変化の大きさ（0〜1）。取れれば保存する';
-- delete from supabase_migrations.schema_migrations where version = '20261007000000';
