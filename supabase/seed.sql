-- ローカル開発専用。`supabase db reset` のたびに、マイグレーションの後で流れる（`supabase db push` では流れない）。
-- web_app のパスワードは、ローカルの Supabase CLI の既定値（DB パスワード postgres など）と同じ扱いの公知の値。
-- 本番（Supabase Cloud）では使わない。本番は psql の `\password web_app` で別の値を設定する（README）。
alter role web_app with password 'web_app_local';
