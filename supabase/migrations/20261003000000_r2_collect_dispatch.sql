-- R2: 収集ワーカー（GitHub Actions の collect.yml）を Supabase の pg_cron から毎時起動する。
--     GitHub の schedule が 2026-10-02 に約 33 回中 1 回しか動かなかったため（GitHub 側の問題。設計 5.8 章）、
--     pg_cron ＋ http 拡張機能で workflow_dispatch の API を呼ぶ方式に一本化する。
-- 設計: doc/design/r2-cloud.md 5.8 章。ロールバックは同章の末尾
--
-- GitHub のトークン（Fine-grained、このリポジトリの Actions: write だけ）は Vault の名前 collect-dispatch-token に
-- ダッシュボードから入れる（マイグレーションにも seed にも書かない）。未登録なら起動しない（ローカルはこの状態のままにする）。
--
-- pg_net は使わない。pg_net は要求を net.http_request_queue に積んでから送り、その表と net スキーマは
-- PUBLIC が読み書きできる（supabase_admin の付与で、postgres からは revoke できない）。web_app から
-- Authorization ヘッダー（トークン）が読めてしまうため。http 拡張機能は同期で送り、要求を表に残さない。

-- ---------------------------------------------------------------
-- 1. 拡張機能（Supabase の文書の手順どおり）。
-- http の関数は PUBLIC が実行できるが、extensions スキーマの usage は anon／authenticated／service_role にしかなく、
-- web_app には与えていない（呼べない）。anon／authenticated は Data API からしか使われず、extensions は公開していない。
-- ---------------------------------------------------------------
-- pg_cron がすでにある DB で create extension if not exists を流すと、Supabase の拡張機能の後処理が走って
-- 「dependent privileges exist」で失敗する（ローカルで確認）。ないときだけ作る
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    create extension pg_cron with schema pg_catalog;
  end if;
end
$$;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

create extension if not exists http with schema extensions;

-- ---------------------------------------------------------------
-- 2. 起動の関数。GitHub が 2xx 以外を返したら例外にして、cron.job_run_details に failed と状態コードを残す。
-- 再試行はしない。起動の抜けは死活監視（Healthchecks。設計 5.5 章）が拾う。
-- daily を含めるかは、起動した時刻の UTC の時が 20（JST 05 時台）かで決めて入力 run_daily で渡す。
-- 宛先はこのリポジトリの collect.yml に固定する（設定の誤りで別のホストへ送らないため。
-- postgres の権限を持つ相手は関数ごと書き換えられるので、その防御にはならない）。
-- security invoker（既定）。ジョブは所有者の postgres で動く。万一ほかのロールに実行権が付いても Vault を読めず失敗する。
-- ---------------------------------------------------------------
create or replace function private.dispatch_collect()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_token text;
  v_daily boolean := extract(hour from (now() at time zone 'UTC')) = 20;
  v_res extensions.http_response;
begin
  select s.decrypted_secret into v_token
    from vault.decrypted_secrets s
    where s.name = 'collect-dispatch-token';
  if v_token is null or v_token = '' then
    raise log 'collect dispatch skipped: vault secret collect-dispatch-token is not set';
    return null;
  end if;
  -- Fine-grained PAT の形だけを通す（貼り付けの改行や空白がヘッダーに入らないように）。値は出さない
  if v_token !~ '^github_pat_[A-Za-z0-9_]+$' or length(v_token) > 255 then
    raise exception 'collect dispatch: vault secret collect-dispatch-token is not a fine-grained token'
      using errcode = '22023';
  end if;

  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '15');
  v_res := extensions.http((
    'POST',
    'https://api.github.com/repos/smallpiece2024/instagram-analyze/actions/workflows/collect.yml/dispatches',
    array[
      extensions.http_header('Accept', 'application/vnd.github+json'),
      extensions.http_header('Authorization', 'Bearer ' || v_token),
      extensions.http_header('X-GitHub-Api-Version', '2022-11-28'),
      extensions.http_header('User-Agent', 'instagram-analyze-pg-cron')   -- GitHub の REST API は User-Agent がないと拒否する
    ],
    'application/json',
    -- workflow_dispatch の入力は文字列で渡す（boolean の入力も 'true'／'false' で受ける）
    jsonb_build_object(
      'ref', 'main',
      'inputs', jsonb_build_object('run_daily', case when v_daily then 'true' else 'false' end)
    )::text
  )::extensions.http_request);

  if v_res.status not between 200 and 299 then
    -- GitHub のエラーの本文は message と documentation_url だけで、トークンは含まない
    raise exception 'collect dispatch failed: status=% body=%', v_res.status, left(v_res.content, 300)
      using errcode = 'P0001';
  end if;
  return v_res.status;
end;
$$;

comment on function private.dispatch_collect() is
  'collect.yml を workflow_dispatch で起動し、GitHub の状態コード（成功は 2xx）を返す。2xx 以外は例外。Vault の collect-dispatch-token が未登録なら何もしないで null';

-- 20261002005926_r2_web_role.sql 4 の規約。明示の付与も残さないよう、既定で付きうるロールからも取り消す
revoke execute on function private.dispatch_collect() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------
-- 3. ジョブ。cron.timezone は GMT（UTC）。同じ名前の schedule は上書きになるので、流し直しても重ならない。
-- 分は従来の collect.yml の schedule と同じ 17 分のまま（設計と README の記述を変えない）。
-- ---------------------------------------------------------------
select cron.schedule(
  'collect-dispatch',
  '17 * * * *',
  'select private.dispatch_collect()'
);

-- pg_cron は実行の記録（cron.job_run_details）を消さない。毎時 1 件でも溜まり続けるので 30 日より古いものを毎日消す。
-- 実行中に落ちて end_time が null のままの行も start_time で消す
select cron.schedule(
  'cron-history-purge',
  '47 3 * * *',
  $$delete from cron.job_run_details where coalesce(end_time, start_time) < now() - interval '30 days'$$
);
