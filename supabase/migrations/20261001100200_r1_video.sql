-- R1: 動画の解析結果（長さとカット）
-- 設計: doc/design/r1-db-design.md 5 章
-- R1 ではストーリーズの動画を、R4 ではリールを同じ表に入れる。
-- 動画ファイルは保存しない。解析結果だけを残す。

-- ---------------------------------------------------------------
-- video_analyses: 動画 1 本の解析結果。解析条件ごとに 1 行
-- ---------------------------------------------------------------
create table public.video_analyses (
  id bigint generated always as identity primary key,
  media_id text not null references public.media (id) on delete cascade,
  analyzer_version text not null,
  scene_threshold numeric(4, 3) not null,
  status text not null
    check (status in ('success', 'no_video_url', 'failed')),
  error text,
  analyzed_at timestamptz not null default now(),
  duration_ms integer,
  width integer,
  height integer,
  fps numeric(8, 3),
  bitrate bigint,
  file_size bigint,
  has_audio boolean,
  cut_count integer,
  avg_scene_ms integer,
  first_cut_ms integer,
  cuts_in_first_3s integer,
  unique (media_id, analyzer_version, scene_threshold)
);

comment on table public.video_analyses is '動画の解析結果。しきい値と解析プログラムの版ごとに 1 行。同じ条件で解析し直したら上書きする';
comment on column public.video_analyses.scene_threshold is 'ffmpeg のシーン検出のしきい値（既定 0.3）';
comment on column public.video_analyses.status is 'success: 成功、no_video_url: 動画 URL が取れない、failed: 失敗';
comment on column public.video_analyses.cut_count is 'カットの数（大きな画面変化の回数）。video_cuts から計算し直せる';
comment on column public.video_analyses.first_cut_ms is '最初のカットまでの時間。カットがなければ null';

create index video_analyses_media_idx on public.video_analyses (media_id, analyzed_at desc);

alter table public.video_analyses enable row level security;

-- ---------------------------------------------------------------
-- video_cuts: カットのタイミング。1 カット 1 行
-- ---------------------------------------------------------------
create table public.video_cuts (
  analysis_id bigint not null references public.video_analyses (id) on delete cascade,
  seq integer not null,
  at_ms integer not null,
  scene_score numeric(5, 4),
  primary key (analysis_id, seq)
);

comment on table public.video_cuts is 'カットのタイミング（動画の開始からのミリ秒）。精度はフレーム単位';
comment on column public.video_cuts.seq is '何番目のカットか（1 から）';
comment on column public.video_cuts.scene_score is '画面変化の大きさ（0〜1）。取れれば保存する';

alter table public.video_cuts enable row level security;
