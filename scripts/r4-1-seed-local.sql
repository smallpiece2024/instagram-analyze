-- R4.1 の種データ（設計 doc/design/r4-1-video-text.md 9 章）。手元の Docker の Supabase 専用。本番には流さない。
-- 直近のリール 3 本（消えていないもの）に、画面の文字の解析結果（video_text_analyses、video_text_segments）と
-- Vision API の利用記録（ocr_usage）の偽の行を入れる。段階 3 の画面と DB テストの確認に使う。
-- 投稿の ID はこのファイルに書かず、流すたびに select で選ぶ（公開リポジトリに ID を残さない）。
--
-- 流し方:
--   docker exec -i supabase_db_instagram-analyze psql -U postgres -v ON_ERROR_STOP=1 -f - < scripts/r4-1-seed-local.sql
--
-- 何度流しても重複しない:
--   - video_text_analyses は一意キー（media_id、ocr_method、ocr_version、frame_interval_ms、analyzer_version）で upsert する
--   - video_text_segments と ocr_usage は、その解析（analysis_id）に紐づく行を消してから入れ直す
-- 本物のワーカー（video_text ジョブ）は同じ一意キーに書くので、種データの行は次の本番相当の処理で上書きされる。
-- 種データだけを消したいときは、この解析に紐づく ocr_usage を先に消してから video_text_analyses を消す（下の「消し方」）。
-- 文字は架空のもの（店名、電話番号、実在の地名を含まない）。

\set ON_ERROR_STOP on

begin;

-- ---------------------------------------------------------------
-- 対象: 直近のリール 3 本。動画の長さは今のカットの条件の success の解析があればそれを使い、なければ 20 秒とみなす
-- ---------------------------------------------------------------
create temporary table seed_targets on commit drop as
select m.id as media_id,
       m.account_id,
       row_number() over (order by m.posted_at desc, m.id)::integer as k,
       va.id as video_analysis_id,
       coalesce(nullif(va.duration_ms, 0), 20000) as duration_ms
from public.media m
cross join public.current_video_condition() c
left join public.video_analyses va
  on va.media_id = m.id
 and va.analyzer_version = c.analyzer_version
 and va.scene_threshold = c.scene_threshold
 and va.status = 'success'
where m.media_product_type = 'REELS'
  and m.media_type = 'VIDEO'
  and m.gone_at is null
order by m.posted_at desc, m.id
limit 3;

-- ---------------------------------------------------------------
-- 解析の行（success、今の OCR の条件）。既にあれば上書きする（attempt_count は増やさない。種データなので）
-- ---------------------------------------------------------------
insert into public.video_text_analyses (
  media_id, ocr_method, ocr_version, frame_interval_ms, analyzer_version, segmenter_version,
  video_analysis_id, status, error, analyzed_at, attempt_count, duration_ms, image_width, image_height,
  planned_frame_count, ocr_frame_count, units_used)
select s.media_id, t.ocr_method, t.ocr_version, t.frame_interval_ms, t.analyzer_version, t.segmenter_version,
       s.video_analysis_id, 'success', null, now() - make_interval(hours => s.k), 1, s.duration_ms, 720, 1280,
       s.duration_ms / t.frame_interval_ms + 2, s.duration_ms / t.frame_interval_ms + 2, s.duration_ms / t.frame_interval_ms + 2
from seed_targets s
cross join public.current_video_text_condition() t
on conflict (media_id, ocr_method, ocr_version, frame_interval_ms, analyzer_version) do update set
  segmenter_version = excluded.segmenter_version,
  video_analysis_id = excluded.video_analysis_id,
  status = excluded.status,
  error = excluded.error,
  analyzed_at = excluded.analyzed_at,
  duration_ms = excluded.duration_ms,
  image_width = excluded.image_width,
  image_height = excluded.image_height,
  planned_frame_count = excluded.planned_frame_count,
  ocr_frame_count = excluded.ocr_frame_count,
  units_used = excluded.units_used;

create temporary table seed_analyses on commit drop as
select vt.id as analysis_id, s.media_id, s.account_id, s.k, s.duration_ms, vt.planned_frame_count
from seed_targets s
cross join public.current_video_text_condition() t
join public.video_text_analyses vt
  on vt.media_id = s.media_id
 and vt.ocr_method = t.ocr_method and vt.ocr_version = t.ocr_version
 and vt.frame_interval_ms = t.frame_interval_ms and vt.analyzer_version = t.analyzer_version;

-- ---------------------------------------------------------------
-- 区間。テロップらしい区間（上寄り、大きい、確信度が高い）と背景の区間（看板やメニュー。小さい、確信度が低い）を混ぜる。
-- 時刻は動画の長さに対する割合で決める。本数は k ごとに変える（k=1: 5 本、k=2: 6 本、k=3: 4 本）
-- ---------------------------------------------------------------
delete from public.video_text_segments where analysis_id in (select analysis_id from seed_analyses);

insert into public.video_text_segments (
  analysis_id, seq, text, text_norm, start_ms, end_ms, vertical_position,
  center_x_ratio, center_y_ratio, char_height_ratio, confidence, frame_count, lang, is_caption_like)
select a.analysis_id,
       row_number() over (partition by a.analysis_id order by tpl.start_frac, tpl.idx)::integer as seq,
       tpl.text,
       lower(normalize(tpl.text, NFKC)) as text_norm,
       floor(a.duration_ms * tpl.start_frac)::integer as start_ms,
       floor(a.duration_ms * tpl.end_frac)::integer as end_ms,
       tpl.vertical_position,
       tpl.center_x_ratio, tpl.center_y_ratio, tpl.char_height_ratio, tpl.confidence,
       greatest(1, floor(a.duration_ms * (tpl.end_frac - tpl.start_frac) / 1000))::integer as frame_count,
       tpl.lang,
       tpl.is_caption_like
from seed_analyses a
cross join (
  values
    (1, 'ランチ営業はじめました', 0.00, 0.15, 'top',    0.50, 0.30, 0.035, 0.99, 'ja', true),
    (2, 'MENU',                  0.10, 0.30, 'middle', 0.70, 0.55, 0.012, 0.62, 'en', false),
    (3, '駅から徒歩4分',          0.20, 0.35, 'top',    0.50, 0.31, 0.034, 0.98, 'ja', true),
    (4, '営業中',                0.40, 0.55, 'bottom', 0.25, 0.85, 0.020, 0.45, 'ja', false),
    (5, '本日のおすすめ',         0.50, 0.65, 'top',    0.50, 0.30, 0.036, 0.99, 'ja', true),
    (6, 'ありがとうございました', 0.85, 1.00, 'top',    0.50, 0.32, 0.035, 0.97, 'ja', true)
) as tpl(idx, text, start_frac, end_frac, vertical_position, center_x_ratio, center_y_ratio, char_height_ratio, confidence, lang, is_caption_like)
where tpl.idx <= 4 + (a.k % 3);

-- 特徴量を区間から埋める。表示割合は区間の和集合（重なりを 1 回だけ数える）を 1 秒の桝で近似し、1 で頭打ちにする
update public.video_text_analyses vt
set first_text_ms = agg.first_text_ms,
    has_text_in_first_3s = agg.first_text_ms < 3000,
    text_coverage_ratio = least(1, round(cov.covered_s * 1000::numeric / vt.duration_ms, 4)),
    total_text_chars = agg.total_chars,
    segment_count = agg.segment_count,
    max_chars_per_frame = agg.max_chars,
    avg_chars_per_frame = round(agg.char_frames::numeric / greatest(1, vt.planned_frame_count), 2),
    caption_first_text_ms = agg.caption_first_text_ms,
    caption_has_text_in_first_3s = agg.caption_first_text_ms < 3000,
    caption_coverage_ratio = least(1, round(cov.caption_covered_s * 1000::numeric / vt.duration_ms, 4)),
    caption_total_chars = coalesce(agg.caption_chars, 0)
from (
  select seg.analysis_id,
         min(seg.start_ms) as first_text_ms,
         sum(char_length(seg.text))::integer as total_chars,
         count(*)::integer as segment_count,
         max(char_length(seg.text))::integer as max_chars,
         sum(char_length(seg.text) * seg.frame_count) as char_frames,
         min(seg.start_ms) filter (where seg.is_caption_like) as caption_first_text_ms,
         sum(char_length(seg.text)) filter (where seg.is_caption_like)::integer as caption_chars
  from public.video_text_segments seg
  where seg.analysis_id in (select analysis_id from seed_analyses)
  group by seg.analysis_id
) agg
join (
  -- 区間の和集合（秒）。各区間が掛かる 1 秒の桝を列挙し、重複を除いて数える
  select seg.analysis_id,
         count(distinct b.s) as covered_s,
         count(distinct b.s) filter (where seg.is_caption_like) as caption_covered_s
  from public.video_text_segments seg
  cross join lateral generate_series(seg.start_ms / 1000, (seg.end_ms - 1) / 1000) as b(s)
  where seg.analysis_id in (select analysis_id from seed_analyses)
  group by seg.analysis_id
) cov on cov.analysis_id = agg.analysis_id
where vt.id = agg.analysis_id;

-- ---------------------------------------------------------------
-- 利用記録。1 本につき「成功 8 枚」「429 で 0 ユニット」「残りの枚数の成功」の 3 要求。
-- k=1 の本には前の月（UTC）の行も 1 つ入れ、利用状況の画面で 2 か月分が見えるようにする
-- ---------------------------------------------------------------
delete from public.ocr_usage where analysis_id in (select analysis_id from seed_analyses);

insert into public.ocr_usage (
  account_id, media_id, analysis_id, job_run_id, ocr_method, ocr_version, requested_at,
  elapsed_ms, image_count, units, request_bytes, response_bytes, word_count, http_status, ok)
select a.account_id, a.media_id, a.analysis_id, null, t.ocr_method, t.ocr_version,
       now() - make_interval(hours => a.k) + r.offset_s * interval '1 second',
       r.elapsed_ms, r.image_count, r.units, r.request_bytes, r.response_bytes, r.word_count, r.http_status, r.ok
from seed_analyses a
cross join public.current_video_text_condition() t
cross join lateral (
  values
    (0,  529, 8,                                    8,                                    920000, 172000, 310, 200, true),
    (2, 1800, 8,                                    0,                                    910000,    512,   0, 429, false),
    (12, 610, greatest(1, a.planned_frame_count - 8), greatest(1, a.planned_frame_count - 8), 880000, 160000, 280, 200, true)
) as r(offset_s, elapsed_ms, image_count, units, request_bytes, response_bytes, word_count, http_status, ok);

insert into public.ocr_usage (
  account_id, media_id, analysis_id, job_run_id, ocr_method, ocr_version, requested_at,
  elapsed_ms, image_count, units, request_bytes, response_bytes, word_count, http_status, ok)
select a.account_id, a.media_id, a.analysis_id, null, t.ocr_method, t.ocr_version,
       (date_trunc('month', now() at time zone 'UTC') at time zone 'UTC') - interval '5 days',
       540, 6, 6, 700000, 120000, 200, 200, true
from seed_analyses a
cross join public.current_video_text_condition() t
where a.k = 1;

-- ---------------------------------------------------------------
-- 結果の表示（投稿の ID は出さない）
-- ---------------------------------------------------------------
select a.k,
       a.duration_ms,
       vt.segment_count,
       vt.first_text_ms,
       vt.text_coverage_ratio,
       vt.caption_total_chars,
       (select count(*) from public.ocr_usage u where u.analysis_id = a.analysis_id) as usage_rows
from seed_analyses a
join public.video_text_analyses vt on vt.id = a.analysis_id
order by a.k;

select month_utc, requests, failed_requests, images, units, videos
from public.ocr_monthly_usage
where account_id in (select account_id from seed_analyses)
order by month_utc;

commit;

-- 消し方（種データの 3 本だけを消す。直近のリールが変わっていたら対象もずれるので、消す前に上の select で確かめる）:
--   delete from public.ocr_usage where analysis_id in (
--     select vt.id from public.video_text_analyses vt
--     where vt.media_id in (select id from public.media where media_product_type = 'REELS' and gone_at is null order by posted_at desc limit 3));
--   delete from public.video_text_analyses
--   where media_id in (select id from public.media where media_product_type = 'REELS' and gone_at is null order by posted_at desc limit 3);
