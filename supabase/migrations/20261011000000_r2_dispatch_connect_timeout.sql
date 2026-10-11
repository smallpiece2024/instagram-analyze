-- R2: 起動の関数 private.dispatch_collect() の、GitHub への接続の制限時間を 1 秒から 10 秒に伸ばす。
--
-- 経緯: 7 日間の確認（2026-10-04〜10-11）で、169 回の起動のうち 1 回（2026-10-07 00:17 UTC）が
--   「Failed to connect to api.github.com port 443 after 1002 ms: Timeout was reached」で失敗し、その時の収集が抜けた。
--   http 拡張機能（pgsql-http）は接続の制限時間 CURLOPT_CONNECTTIMEOUT_MS を既定で 1,000 ms にしている
--   （http.c の http_get_handle()。2026-10-11 に確認）。20261003000000_r2_collect_dispatch.sql は全体の制限時間
--   CURLOPT_TIMEOUT を 15 秒にしたが、接続の制限時間は既定のままだった。
-- 変更: http_set_curlopt('CURLOPT_CONNECTTIMEOUT', '10') を 1 行足す。それ以外（本文、再試行しない方針、権限）は変えない。
--   全体の 15 秒は接続の 10 秒を含むので、最悪でも 15 秒で終わる。
-- 設計: doc/design/r2-cloud.md 5.8 章。進捗: doc/progress.md 5 章「本番の DB の結果（2026-10-11）」
-- ロールバック: 20261003000000_r2_collect_dispatch.sql の 2 の create or replace function を流し直す（接続の制限時間が既定の 1 秒に戻る）

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

  -- 接続（DNS と TCP）の制限時間は 10 秒（既定の 1 秒では 2026-10-07 に 1 回打ち切られた）。全体は 15 秒
  perform extensions.http_set_curlopt('CURLOPT_CONNECTTIMEOUT', '10');
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
  'collect.yml を workflow_dispatch で起動し、GitHub の状態コード（成功は 2xx）を返す。2xx 以外は例外。Vault の collect-dispatch-token が未登録なら何もしないで null。接続の制限時間 10 秒、全体 15 秒';

-- create or replace は既存の権限を保つが、20261002005926_r2_web_role.sql 4 の規約を明示するため取り消しを再掲する
revoke execute on function private.dispatch_collect() from public, anon, authenticated, service_role;
