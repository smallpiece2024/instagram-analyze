-- ローカル開発専用。`supabase db reset` のたびに、マイグレーションの後で流れる。
-- 本番（Supabase Cloud）に流してはいけない: `supabase db push --include-seed` と `supabase db reset --linked` は
-- リンク先に seed を流すので使わない（README）。万一流したら、直後に psql の `\password web_app` で上書きし、
-- private.web_users の行を確かめる。
--
-- web_app のパスワードは、ローカルの Supabase CLI の既定値（DB パスワード postgres など）と同じ扱いの公知の値。
alter role web_app with password 'web_app_local';

-- Storage のサムネイルを読める利用者。結合テスト（apps/web/test/db/web-role.test.ts）が使う固定の uuid。
-- ローカルの Supabase Auth で作った自分の利用者も読めるようにするには、その auth.users.id をここに足す
-- （または psql で insert する）。
insert into private.web_users (user_id, note)
values ('00000000-0000-0000-0000-000000000001', 'ローカルの結合テスト用')
on conflict (user_id) do nothing;
