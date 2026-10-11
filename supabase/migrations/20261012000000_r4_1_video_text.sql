-- R4.1: 動画の画面の文字（OCR）の DB
-- 設計: doc/design/r4-1-video-text.md 5 章（5.1〜5.6 節）。ロールバックはこのファイルの末尾のコメント
--
-- 1. 表 4 つ: video_text_analyses（1 本 × OCR の条件で 1 行）、video_text_frames（1 フレーム 1 行）、
--    video_text_segments（1 区間 1 行）、ocr_usage（Vision API の 1 要求 1 行。費用の根拠）
-- 2. current_video_text_condition(): 今の OCR の条件。条件を変えるたびにこの関数を作り直す
-- 3. ビュー: media_video_features と media_analysis_dataset に文字の列を足す、ocr_monthly_usage（月ごとの利用）
-- 4. 権限（web_app は 3 表と 3 ビューを読むだけ。video_text_frames は画面で使わないので与えない）
--
-- 既存の表（video_analyses、video_cuts）は変えない。文字の解析は条件の組が違い 1 本に複数の行がありうるので別の表にする

-- ---------------------------------------------------------------
-- 0. 前置き。収集のジョブと長く待ち合わないようにする（R5 の作法）
-- ---------------------------------------------------------------
set lock_timeout = '5s';

-- ---------------------------------------------------------------
-- 1. 表
-- ---------------------------------------------------------------

-- video_text_analyses: 1 本 × OCR の条件で 1 行。
-- 一意キーは (media_id, ocr_method, ocr_version, frame_interval_ms, analyzer_version) の 4 条件。
-- segmenter_version は同じ行の列で、区間化と特徴量を計算し直したら上書きする（API は呼ばない）。
-- カットの条件（しきい値）は含めない。使ったカットの解析の行は video_analysis_id に残す
create table public.video_text_analyses (
  id bigint generated always as identity primary key,
  media_id text not null references public.media (id) on delete cascade,
  ocr_method text not null,
  ocr_version text not null,
  frame_interval_ms integer not null check (frame_interval_ms > 0),
  analyzer_version text not null,
  segmenter_version text not null,
  video_analysis_id bigint references public.video_analyses (id) on delete set null,
  status text not null check (status in ('success', 'no_video_url', 'failed')),
  error text,
  analyzed_at timestamptz not null default now(),
  attempt_count integer not null default 1 check (attempt_count >= 1),
  duration_ms integer check (duration_ms > 0),
  image_width integer check (image_width > 0),
  image_height integer check (image_height > 0),
  planned_frame_count integer check (planned_frame_count >= 0),
  ocr_frame_count integer not null default 0 check (ocr_frame_count >= 0),
  units_used integer not null default 0 check (units_used >= 0),
  first_text_ms integer check (first_text_ms >= 0),
  has_text_in_first_3s boolean,
  text_coverage_ratio numeric(5, 4) check (text_coverage_ratio between 0 and 1),
  total_text_chars integer check (total_text_chars >= 0),
  segment_count integer check (segment_count >= 0),
  max_chars_per_frame integer check (max_chars_per_frame >= 0),
  avg_chars_per_frame numeric(8, 2) check (avg_chars_per_frame >= 0),
  caption_first_text_ms integer check (caption_first_text_ms >= 0),
  caption_has_text_in_first_3s boolean,
  caption_coverage_ratio numeric(5, 4) check (caption_coverage_ratio between 0 and 1),
  caption_total_chars integer check (caption_total_chars >= 0),
  unique (media_id, ocr_method, ocr_version, frame_interval_ms, analyzer_version)
);

comment on table public.video_text_analyses is
  '動画の画面の文字（OCR）の解析結果。1 本 × OCR の条件（ocr_method、ocr_version、frame_interval_ms、analyzer_version）で 1 行。segmenter_version は同じ行の列で、計算し直したら上書きする。カットの条件は含めない';
comment on column public.video_text_analyses.segmenter_version is
  '区間化の規則と特徴量の定義の版。今の版（current_video_text_condition()）と違う行は、保存したフレームの結果から API を呼ばずに計算し直す';
comment on column public.video_text_analyses.video_analysis_id is
  '使ったカットの解析（video_analyses）の行。再試行と再区間化の計画はこの行のカットから作る。消えたら null';
comment on column public.video_text_analyses.status is
  'success: 成功、no_video_url: 動画 URL が取れない、failed: 失敗（取り掛かりの記録も failed で書く）';
comment on column public.video_text_analyses.error is
  '失敗の理由。固定文言か mask 済みの文面だけ（URL、鍵、トークン、文字を入れない）。画面のクエリは select しない';
comment on column public.video_text_analyses.attempt_count is
  '同じ条件で取り掛かった回数。success 以外で上限（ワーカーの VIDEO_TEXT_MAX_ATTEMPTS）に達したら video_text の対象外';
comment on column public.video_text_analyses.duration_ms is '解析に使った動画の長さ（video_analyses.duration_ms の写し。0 の動画は対象にしない）';
comment on column public.video_text_analyses.planned_frame_count is '計画した枚数（長さとカットから）';
comment on column public.video_text_analyses.ocr_frame_count is 'error_code が null の結果のある枚数（video_text_frames から数え直せる）';
comment on column public.video_text_analyses.units_used is
  'この行に使ったユニットの累計（再試行と再送の分を含む。要求ごとに足す）。参考値。正はいつも ocr_usage';
comment on column public.video_text_analyses.first_text_ms is '最初に文字が出る時刻（ms）。文字がなければ null';
comment on column public.video_text_analyses.has_text_in_first_3s is '冒頭 3 秒（start_ms < 3000）に文字があるか';
comment on column public.video_text_analyses.text_coverage_ratio is '文字が出ている時間の割合（区間の和集合 ÷ 長さ。0〜1）';
comment on column public.video_text_analyses.total_text_chars is '文字の総数（区間の重複を除く）';
comment on column public.video_text_analyses.segment_count is '区間の数（video_text_segments の行数）';
comment on column public.video_text_analyses.caption_first_text_ms is 'テロップらしい区間（is_caption_like）だけで見た first_text_ms';

-- video_text_frames: 1 フレーム 1 行。error_code が入っている行は読み取りに失敗したフレーム（次の回に送り直す）。
-- 文字なしの成功は text = ''、words = '[]'
create table public.video_text_frames (
  analysis_id bigint not null references public.video_text_analyses (id) on delete cascade,
  at_ms integer not null check (at_ms >= 0),
  source text not null check (source in ('interval', 'cut')),
  text text,
  words jsonb,
  word_count integer check (word_count >= 0),
  error_code integer,
  fetched_at timestamptz not null,
  primary key (analysis_id, at_ms),
  check ((error_code is null and text is not null and words is not null)
      or (error_code is not null and words is null))
);

comment on table public.video_text_frames is
  'フレームごとの OCR の結果。1 フレーム 1 行。成功なら text と words がある（文字なしは text = ''''、words = ''[]''）。失敗なら error_code があり words は null（次の回に送り直す）。画面では使わない';
comment on column public.video_text_frames.source is 'interval: 一定間隔、cut: カット直後';
comment on column public.video_text_frames.words is
  '語ごとの位置と確信度（切り詰めた形。設計 4.1 節）。SQL では引かない。segmenter_version を上げたときの再計算の入力';
comment on column public.video_text_frames.error_code is 'Vision が 1 枚ごとに返した error の code。null なら成功';

-- video_text_segments: 1 区間 1 行。text は表示用、text_norm は検索と重複除去用（ilike で引く。索引は要らない）
create table public.video_text_segments (
  analysis_id bigint not null references public.video_text_analyses (id) on delete cascade,
  seq integer not null check (seq >= 1),
  text text not null,
  text_norm text not null,
  start_ms integer not null check (start_ms >= 0),
  end_ms integer not null,
  vertical_position text not null check (vertical_position in ('top', 'middle', 'bottom')),
  center_x_ratio numeric(5, 4) check (center_x_ratio between 0 and 1),
  center_y_ratio numeric(5, 4) check (center_y_ratio between 0 and 1),
  char_height_ratio numeric(5, 4) check (char_height_ratio between 0 and 1),
  confidence numeric(5, 4) check (confidence between 0 and 1),
  frame_count integer not null check (frame_count >= 1),
  lang text,
  is_caption_like boolean not null,
  primary key (analysis_id, seq),
  check (end_ms > start_ms)
);

comment on table public.video_text_segments is
  '画面に出ている文字の区間（同じ文字が続くフレームをまとめたもの）。1 区間 1 行。seq は start_ms の順';
comment on column public.video_text_segments.text is '表示用の文字（最も確信度の高いフレームのもの）';
comment on column public.video_text_segments.text_norm is '検索と重複除去用に正規化した文字（NFKC、小文字。ワーカーの normalizeText と同じ規則）';
comment on column public.video_text_segments.end_ms is '表示の終わり（ms）。最後の計画フレームでだけ観測したら duration_ms';
comment on column public.video_text_segments.vertical_position is '画面の上・中・下（center_y_ratio から）';
comment on column public.video_text_segments.char_height_ratio is '文字の高さ ÷ 画像の高さ';
comment on column public.video_text_segments.is_caption_like is 'テロップらしい区間か（位置、大きさ、確信度から推定。設計 4.3 節）';

-- ocr_usage: Vision API の 1 要求 1 行（要件 5.1 章の利用記録）。
-- 投稿や解析の行を消しても残す（費用の根拠）。account_id は media を経由せずに持つ（投稿が消えても月の合計を出せる）
create table public.ocr_usage (
  id bigint generated always as identity primary key,
  account_id uuid not null references public.accounts (id) on delete cascade,
  media_id text references public.media (id) on delete set null,
  analysis_id bigint references public.video_text_analyses (id) on delete set null,
  job_run_id bigint references public.job_runs (id) on delete set null,
  ocr_method text not null,
  ocr_version text not null,
  requested_at timestamptz not null,
  elapsed_ms integer check (elapsed_ms >= 0),
  image_count integer not null check (image_count > 0),
  units integer not null check (units >= 0),
  request_bytes integer check (request_bytes >= 0),
  response_bytes integer check (response_bytes >= 0),
  word_count integer check (word_count >= 0),
  http_status integer,
  ok boolean not null,
  check (not ok or http_status is not null)
);

comment on table public.ocr_usage is
  'Vision API の利用記録。1 要求 1 行（再送も 1 行）。投稿や解析を消しても残す。月の集計は requested_at（UTC の暦月）で行う。手動の確認（scripts/ocr-check.mjs）は入らない';
comment on column public.ocr_usage.units is
  '課金のユニット（1 枚 × 1 機能 = 1）。429、401、403（Google が処理していない）は 0。5xx、制限時間切れ、2xx（1 枚ごとの error を含む）、その他の 4xx は image_count（多めに数える側に倒す）';
comment on column public.ocr_usage.media_id is
  '要求を送った投稿。消えたら null（月の本数 count(distinct media_id) に入らなくなる）';
comment on column public.ocr_usage.elapsed_ms is '要求の往復時間（ms）。動画の長さではない';
comment on column public.ocr_usage.http_status is 'HTTP の status。制限時間切れなど応答がなければ null（ok は false）';

-- 月の合計（account_id と requested_at の範囲）に使う。列に date_trunc を掛けずに範囲で引く
create index ocr_usage_account_requested_idx on public.ocr_usage (account_id, requested_at);

alter table public.video_text_analyses enable row level security;
alter table public.video_text_frames enable row level security;
alter table public.video_text_segments enable row level security;
alter table public.ocr_usage enable row level security;

-- ---------------------------------------------------------------
-- 2. 今の OCR の条件。ワーカーの定数と一致させる（結合テストで突き合わせる）。
-- 本体は定数だけで表を参照しない（immutable）。条件を変えたら、このマイグレーションと同じ形で
-- 新しいマイグレーションに create or replace を書く（決めた記録にもなる。R4 の current_video_condition() と同じ）
-- ---------------------------------------------------------------
create or replace function public.current_video_text_condition(
  out ocr_method text, out ocr_version text, out frame_interval_ms integer,
  out analyzer_version text, out segmenter_version text)
language sql
immutable
parallel safe
set search_path = ''
as $$ select 'google_vision'::text, 'v1/DOCUMENT_TEXT_DETECTION'::text, 1000, '1'::text, '1'::text $$;

comment on function public.current_video_text_condition() is
  '今の画面の文字の解析条件。ワーカーの OCR_METHOD、OCR_VERSION、FRAME_INTERVAL_MS、TEXT_ANALYZER_VERSION、SEGMENTER_VERSION と同じ値。画面のビューは前の 4 つで結合し、segmenter_version が違う行は特徴量を null にする';

-- R2 の決まり: 関数を足したら PUBLIC の実行権を取り消す（web-role.test.ts が棚卸しする）
revoke execute on function public.current_video_text_condition() from public;
grant execute on function public.current_video_text_condition() to web_app;

-- ---------------------------------------------------------------
-- 3. ビュー
-- ---------------------------------------------------------------

-- 3-1. media_video_features に文字の列を足す（create or replace では列は末尾にだけ足せる）。
-- 定義は 20261007000000_r4_video.sql の 69〜101 行と同じで、from に 2 つの結合、末尾に 16 列を足しただけ。
-- 文字の結合は一意キーの 4 列（segmenter_version を含めない）。text_status は常に行の値で、
-- 特徴量だけ segmenter_version が今の版と違えば null（打ち切り済みの failed／no_video_url が版を上げた後も
-- 失敗のまま見え、success で古い版は「まだ」として扱える）。文字の解析はカットの条件と独立なので、
-- カットの条件を変えた直後は analysis_status が null でも text_status が残る。
-- with (security_invoker = true) を省くと reloptions が置き換わって security_invoker が外れるので必ず書く
create or replace view public.media_video_features
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
  va.cuts_in_last_3s,
  lt.avg_watch_time_ms::numeric / nullif(va.duration_ms, 0) as retention_rate,
  -- 画面の文字（R4.1。今の OCR の条件の行だけ。特徴量は segmenter_version が今の版のときだけ）
  vt.id as text_analysis_id,
  vt.status as text_status,
  vt.attempt_count as text_attempt_count,
  vt.analyzed_at as text_analyzed_at,
  (vt.segmenter_version = t.segmenter_version) as text_segmenter_current,
  case when vt.segmenter_version = t.segmenter_version then vt.first_text_ms end as first_text_ms,
  case when vt.segmenter_version = t.segmenter_version then vt.has_text_in_first_3s end as has_text_in_first_3s,
  case when vt.segmenter_version = t.segmenter_version then vt.text_coverage_ratio end as text_coverage_ratio,
  case when vt.segmenter_version = t.segmenter_version then vt.total_text_chars end as total_text_chars,
  case when vt.segmenter_version = t.segmenter_version then vt.segment_count end as segment_count,
  case when vt.segmenter_version = t.segmenter_version then vt.max_chars_per_frame end as max_chars_per_frame,
  case when vt.segmenter_version = t.segmenter_version then vt.avg_chars_per_frame end as avg_chars_per_frame,
  case when vt.segmenter_version = t.segmenter_version then vt.caption_first_text_ms end as caption_first_text_ms,
  case when vt.segmenter_version = t.segmenter_version then vt.caption_has_text_in_first_3s end as caption_has_text_in_first_3s,
  case when vt.segmenter_version = t.segmenter_version then vt.caption_coverage_ratio end as caption_coverage_ratio,
  case when vt.segmenter_version = t.segmenter_version then vt.caption_total_chars end as caption_total_chars
from public.media m
cross join public.current_video_condition() c
left join public.video_analyses va
  on va.media_id = m.id
 and va.analyzer_version = c.analyzer_version
 and va.scene_threshold = c.scene_threshold
left join public.media_horizon_metrics lt
  on lt.media_id = m.id and lt.horizon = 'latest'
cross join public.current_video_text_condition() t
left join public.video_text_analyses vt
  on vt.media_id = m.id
 and vt.ocr_method = t.ocr_method and vt.ocr_version = t.ocr_version
 and vt.frame_interval_ms = t.frame_interval_ms and vt.analyzer_version = t.analyzer_version
where m.media_type = 'VIDEO'
  and m.media_product_type in ('REELS', 'FEED');

comment on view public.media_video_features is
  '動画の投稿（リール、フィード動画）1 件 1 行の動画の特徴量。今の条件（current_video_condition()）の解析結果だけを使う。analysis_status が null はまだ解析していない。success 以外では特徴量は null。error 列は持たない。画面の文字（R4.1）は今の OCR の条件（current_video_text_condition() の前の 4 つ）の行で、text_status が null はまだ読んでいない。success 以外と text_segmenter_current が偽の行では文字の特徴量は null';
comment on column public.media_video_features.text_status is
  '画面の文字の解析の状態（video_text_analyses.status）。null はまだ読んでいない。segmenter_version が古くても行の値をそのまま出す';
comment on column public.media_video_features.text_segmenter_current is
  '文字の行の segmenter_version が今の版か。偽なら特徴量は null（次の回に計算し直される）。行がなければ null';

-- 3-2. media_analysis_dataset に文字の列を足す（末尾。create or replace では列は末尾にだけ足せる）。
-- 定義は 20261007000000_r4_video.sql の 117〜264 行と同じで、from に 1 つの結合、末尾に 10 列を足しただけ。
-- 既存の grant（web_app の select）と comment は create or replace で残る。
-- 文字の特徴量は動画の特徴量と同じく「最新の success（条件をまたぐ）」で、条件の列を併せて出す（分析用。条件で分けられる）
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
  public.metric_value(lt.metrics, '{ig_reels_avg_watch_time}')::numeric / nullif(v.duration_ms, 0) as retention_rate,
  -- 最後 3 秒のカット数（R4。create or replace では列を末尾にしか足せないので、cuts_in_first_3s の隣でなくここに置く）
  v.cuts_in_last_3s,
  -- 画面の文字（R4.1。最新の success の解析。条件をまたぐので条件の列を併せて出す）
  vt.ocr_method,
  vt.ocr_version,
  vt.frame_interval_ms,
  vt.analyzer_version as text_analyzer_version,
  vt.segmenter_version,
  vt.first_text_ms,
  vt.has_text_in_first_3s,
  vt.text_coverage_ratio,
  vt.total_text_chars,
  vt.segment_count
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
) lt on true
left join lateral (
  select vt.*
  from public.video_text_analyses vt
  where vt.media_id = m.id and vt.status = 'success'
  order by vt.analyzed_at desc
  limit 1
) vt on true;

comment on column public.media_analysis_dataset.text_analyzer_version is
  '画面の文字の解析の analyzer_version（フレームの取り出し方の版。動画の analyzer_version とは別）。最新の success の行';
comment on column public.media_analysis_dataset.segmenter_version is
  '画面の文字の区間化の版。媒体の特徴量（first_text_ms 以降）はこの版の定義による';

-- 3-3. ocr_monthly_usage: 画面用（利用状況）。利用が 0 の月は行が出ない（画面で補う）。単価は持たない（画面の定数で掛ける）
create view public.ocr_monthly_usage
with (security_invoker = true) as
select
  account_id,
  (date_trunc('month', requested_at at time zone 'UTC'))::date as month_utc,
  count(*)::integer as requests,
  count(*) filter (where not ok)::integer as failed_requests,
  sum(image_count)::integer as images,
  sum(units)::integer as units,
  count(distinct media_id)::integer as videos
from public.ocr_usage
group by 1, 2;

comment on view public.ocr_monthly_usage is
  'Vision API の月ごとの利用（ocr_usage の集計）。利用が 0 の月は行が出ない（画面で補う）';
comment on column public.ocr_monthly_usage.month_utc is 'UTC の月の初日（ワーカーの月の上限と同じ境目）';
comment on column public.ocr_monthly_usage.videos is 'その月に要求を送った本（消えた投稿、区間化だけの本、0 枚の本は数えない）';

-- ---------------------------------------------------------------
-- 4. 権限。R2 の決まり（表とビューは列挙して revoke してから grant し、表には web_app 向けのポリシーを書く）。
-- video_text_frames は画面で使わないので web_app の権限を作らない（最小権限。必要になったときに足す）。
-- media_video_features と media_analysis_dataset の grant は create or replace で残る
-- ---------------------------------------------------------------
revoke all on table public.video_text_analyses, public.video_text_frames, public.video_text_segments, public.ocr_usage
  from public, anon, authenticated;
grant select on table public.video_text_analyses, public.video_text_segments, public.ocr_usage to web_app;
create policy web_app_select on public.video_text_analyses for select to web_app using (true);
create policy web_app_select on public.video_text_segments for select to web_app using (true);
create policy web_app_select on public.ocr_usage for select to web_app using (true);

-- ビュー（security_invoker なので、基の表の select とポリシーも要る）
revoke all on table public.ocr_monthly_usage from public, anon, authenticated;
grant select on table public.ocr_monthly_usage to web_app;

-- ---------------------------------------------------------------
-- ロールバック（手で流す。順番が大事）
-- ---------------------------------------------------------------
-- 1. 先にワーカーを R4.1 より前の版に戻し、hourly から video_text を外す（Web も R4.1 より前に戻す）
-- 2. ビューの作り直しは drop function と drop table より前（ビューが関数と表に依存する）
-- drop view if exists public.ocr_monthly_usage;
-- -- media_video_features と media_analysis_dataset は足した列を create or replace で消せないので、
-- -- drop して 20261007000000_r4_video.sql の定義（69〜101 行と 117〜264 行）で作り直し、
-- -- comment on view media_video_features、comment on column media_video_features.retention_rate、
-- -- comment on column media_analysis_dataset.retention_rate、grant select … to web_app をやり直す:
-- --   drop view if exists public.media_video_features;
-- --   drop view if exists public.media_analysis_dataset;
-- --   （R4 の create view と comment をそのまま流す）
-- --   revoke all on table public.media_video_features from public, anon, authenticated;
-- --   grant select on table public.media_video_features, public.media_analysis_dataset to web_app;
-- drop function if exists public.current_video_text_condition();
-- -- 3. ocr_usage は利用記録（費用の根拠）なので、消す前に copy で .local/ に退避する
-- --   \copy (select * from public.ocr_usage order by id) to '.local/ocr_usage_backup.csv' csv header
-- drop table if exists public.ocr_usage;
-- drop table if exists public.video_text_segments;
-- drop table if exists public.video_text_frames;
-- drop table if exists public.video_text_analyses;
-- delete from supabase_migrations.schema_migrations where version = '20261012000000';
