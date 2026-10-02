/**
 * R2 のマイグレーション `20261002005926_r2_web_role.sql` の結合テスト（設計 `doc/design/r2-cloud.md` 3.5 章）。
 * `TEST_DATABASE_URL`（postgres）と `TEST_WEB_DATABASE_URL`（web_app。ローカルは seed.sql の公知のパスワード）の
 * 両方があり、どちらもローカル（127.0.0.1 か localhost）を指すときだけ動く。
 * 架空のアカウント（`000000` ＋ 乱数 9 桁、`status = 'paused'` で収集対象にしない）を postgres で作り、
 * 終了時に消す（CASCADE と `private.credentials` のトリガーで Vault も消える）。
 *
 * Storage の署名付き URL そのもの（Storage API）はここでは確かめない。ポリシーが効く `storage.objects` の
 * `select` を同じ条件で確かめ、API の実動作は 7 日間の確認（設計 10.2 章）で見る。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllDb, getDb, type Db } from "../../src/lib/db";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_WEB_DATABASE_URL = process.env.TEST_WEB_DATABASE_URL;

const INSUFFICIENT_PRIVILEGE = "42501";
const NO_DATA_FOUND = "P0002";
const INVALID_PARAMETER_VALUE = "22023";

/** seed.sql が private.web_users に入れる、Storage を読める利用者の uuid */
const ALLOWED_USER_ID = "00000000-0000-0000-0000-000000000001";
const OTHER_USER_ID = "00000000-0000-0000-0000-000000000002";

const VIEWS = [
  "account_connection_status",
  "job_latest_runs",
  "media_latest_metrics",
  "media_metrics_at_horizon",
  "story_final_metrics",
  "media_analysis_dataset",
] as const;

const READABLE_TABLES = [
  "profile_daily",
  "account_daily_metrics",
  "media",
  "media_insight_snapshots",
  "job_runs",
  "video_analyses",
  "video_cuts",
  "metric_definitions",
] as const;

function fakeIgUserId(): string {
  return "000000" + Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, "0");
}

function isLocal(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost";
  } catch {
    return false;
  }
}

/** 失敗した SQL の SQLSTATE を返す。成功したら undefined */
async function sqlstate(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

describe.skipIf(!TEST_DATABASE_URL || !TEST_WEB_DATABASE_URL)("r2_web_role（結合）", () => {
  const adminUrl = TEST_DATABASE_URL ?? "";
  const webUrl = TEST_WEB_DATABASE_URL ?? "";
  const igUserId = fakeIgUserId();
  const extraIgUserId = fakeIgUserId();
  const FAKE_TOKEN_1 = `FAKE_ROLE_TOKEN_${Math.floor(Math.random() * 1_000_000_000)}`;
  const FAKE_TOKEN_2 = `${FAKE_TOKEN_1}_UPDATED`;
  let admin: Db;
  let web: Db;
  let accountId: string;

  /** 1 つのトランザクションの中でロールを切り替えてクエリを 1 回だけ流す（失敗するとトランザクションが壊れるので 1 回ずつ） */
  function asRole(role: "anon" | "authenticated", query: string, claims?: Record<string, unknown>): () => Promise<unknown> {
    return () =>
      admin.begin(async (tx) => {
        if (claims) await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
        await tx.unsafe(`set local role ${role}`);
        return tx.unsafe(query);
      });
  }

  beforeAll(async () => {
    // 本番の URL を誤って渡したときに止める（架空のアカウントを本番に作らない）
    if (!isLocal(adminUrl) || !isLocal(webUrl)) throw new Error("結合テストはローカルの Supabase にだけ接続する");
    admin = getDb(adminUrl);
    web = getDb(webUrl);
    const rows = await admin<{ id: string }[]>`
      insert into public.accounts (ig_user_id, username, name, fb_page_id, status)
      values (${igUserId}, 'fake_role_user', 'Fake Role Name', '000000000000098', 'paused')
      returning id
    `;
    accountId = rows[0]?.id ?? "";
    expect(accountId).not.toBe("");
  });

  afterAll(async () => {
    await admin`delete from public.accounts where ig_user_id in (${igUserId}, ${extraIgUserId})`;
    const [row] = await admin<{ n: number }[]>`select count(*)::int as n from vault.secrets where name = ${"ig-token-" + accountId}`;
    expect(row?.n).toBe(0);
    await closeAllDb();
  });

  it("web_app は現在のロールが web_app で、statement_timeout が 15 秒", async () => {
    const [row] = await web<{ role: string; timeout: string }[]>`select current_user as role, current_setting('statement_timeout') as timeout`;
    expect(row?.role).toBe("web_app");
    expect(row?.timeout).toBe("15s");
  });

  it.each(VIEWS)("web_app はビュー %s を読める", async (view) => {
    expect(await sqlstate(() => web`select * from ${web(`public.${view}`)} limit 1`)).toBeUndefined();
  });

  it.each(READABLE_TABLES)("web_app はテーブル %s を読める", async (table) => {
    expect(await sqlstate(() => web`select * from ${web(`public.${table}`)} limit 1`)).toBeUndefined();
  });

  it("web_app は vault、raw_api_responses、job_state、private.web_users を読めず、job_runs に書けず、accounts を消せない", async () => {
    expect(await sqlstate(() => web`select * from vault.secrets limit 1`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(() => web`select * from vault.decrypted_secrets limit 1`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(() => web`select vault.create_secret('x', 'ig-token-should-fail')`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(() => web`select * from public.raw_api_responses limit 1`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(() => web`select * from public.job_state limit 1`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(() => web`select * from private.web_users limit 1`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(
      await sqlstate(() => web`insert into public.job_runs (job_name, account_id, status) values ('probe', ${accountId}, 'running')`),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(() => web`delete from public.accounts where id = ${accountId}`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(() => web`delete from private.credentials where account_id = ${accountId}`)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("private.store_token で Vault に作成・更新でき、名前は ig-token-<accounts.id> で 1 件のまま", async () => {
    const [created] = await web<{ id: string }[]>`select private.store_token(${accountId}::uuid, ${FAKE_TOKEN_1}) as id`;
    expect(created?.id).toMatch(/^[0-9a-f-]{36}$/);
    const [updated] = await web<{ id: string }[]>`select private.store_token(${accountId}::uuid, ${FAKE_TOKEN_2}) as id`;
    expect(updated?.id).toBe(created?.id);

    const secrets = await admin<{ id: string; name: string; decrypted_secret: string }[]>`
      select id, name, decrypted_secret from vault.decrypted_secrets where name = ${"ig-token-" + accountId}
    `;
    expect(secrets).toHaveLength(1);
    expect(secrets[0]?.id).toBe(created?.id);
    expect(secrets[0]?.decrypted_secret).toBe(FAKE_TOKEN_2);
  });

  it("private.store_token は空・長すぎる・ASCII でないトークンと、存在しないアカウントを拒む", async () => {
    expect(await sqlstate(() => web`select private.store_token(${accountId}::uuid, '')`)).toBe(INVALID_PARAMETER_VALUE);
    expect(await sqlstate(() => web`select private.store_token(${accountId}::uuid, ${"A".repeat(1025)})`)).toBe(INVALID_PARAMETER_VALUE);
    expect(await sqlstate(() => web`select private.store_token(${accountId}::uuid, 'トークン')`)).toBe(INVALID_PARAMETER_VALUE);
    expect(await sqlstate(() => web`select private.store_token(${accountId}::uuid, 'has space')`)).toBe(INVALID_PARAMETER_VALUE);
    expect(await sqlstate(() => web`select private.store_token('00000000-0000-0000-0000-000000000000'::uuid, 'x')`)).toBe(NO_DATA_FOUND);
  });

  it("web_app は private.credentials を upsert でき、account_connection_status に反映される。token_secret_id と account_id は書けない", async () => {
    const [secret] = await web<{ id: string }[]>`select private.store_token(${accountId}::uuid, ${FAKE_TOKEN_2}) as id`;
    const secretId = secret?.id ?? "";
    const expires = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    const upsert = (status: string) => web`
      insert into private.credentials
        (account_id, token_type, token_secret_id, expires_at, data_access_expires_at, scopes, status, last_checked_at, last_error)
      values
        (${accountId}, 'PAGE', ${secretId}::uuid, null, ${expires}, ${["instagram_basic"]}, ${status}, now(), null)
      on conflict (account_id) do update set
        token_type = excluded.token_type, expires_at = excluded.expires_at, data_access_expires_at = excluded.data_access_expires_at,
        scopes = excluded.scopes, status = excluded.status, last_checked_at = now(), last_error = null
      returning account_id
    `;
    expect(await sqlstate(() => upsert("valid"))).toBeUndefined();
    expect(await sqlstate(() => upsert("error"))).toBeUndefined();

    const [row] = await web<{ credential_status: string | null; token_type: string | null }[]>`
      select credential_status, token_type from public.account_connection_status where account_id = ${accountId}
    `;
    expect(row?.credential_status).toBe("error");
    expect(row?.token_type).toBe("PAGE");

    expect(await sqlstate(() => web`update private.credentials set status = 'valid' where account_id = ${accountId}`)).toBeUndefined();
    expect(
      await sqlstate(() => web`update private.credentials set token_secret_id = gen_random_uuid() where account_id = ${accountId}`),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(
      await sqlstate(() => web`update private.credentials set account_id = gen_random_uuid() where account_id = ${accountId}`),
    ).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("Vault の秘密が消えていたら、private.store_token が作り直して credentials.token_secret_id を同期する", async () => {
    const [before] = await admin<{ token_secret_id: string }[]>`select token_secret_id from private.credentials where account_id = ${accountId}`;
    expect(before?.token_secret_id).toBeDefined();
    await admin`delete from vault.secrets where id = ${before?.token_secret_id ?? ""}::uuid`;

    const [recreated] = await web<{ id: string }[]>`select private.store_token(${accountId}::uuid, ${FAKE_TOKEN_1}) as id`;
    expect(recreated?.id).not.toBe(before?.token_secret_id);
    const [after] = await admin<{ token_secret_id: string }[]>`select token_secret_id from private.credentials where account_id = ${accountId}`;
    expect(after?.token_secret_id).toBe(recreated?.id);
  });

  it("web_app は accounts を upsert できる（insert の件数上限のポリシーがある）", async () => {
    const rows = await web<{ id: string }[]>`
      insert into public.accounts (ig_user_id, username, name, fb_page_id, status)
      values (${extraIgUserId}, 'fake_role_user_2', null, '000000000000097', 'paused')
      on conflict (ig_user_id) do update set username = excluded.username
      returning id
    `;
    expect(rows[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    const [policy] = await admin<{ with_check: string }[]>`
      select with_check from pg_policies where schemaname = 'public' and tablename = 'accounts' and policyname = 'web_app_insert'
    `;
    expect(policy?.with_check).toContain("count(*)");
  });

  it("anon と authenticated は public のすべてのテーブルとビューを読めない（grant で落ちる）", async () => {
    const relations = await admin<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'public' order by table_name
    `;
    expect(relations.length).toBeGreaterThanOrEqual(READABLE_TABLES.length + VIEWS.length + 2);
    for (const role of ["anon", "authenticated"] as const) {
      for (const { table_name } of relations) {
        expect(await sqlstate(asRole(role, `select * from public."${table_name}" limit 1`)), `${role} / ${table_name}`).toBe(INSUFFICIENT_PRIVILEGE);
      }
      expect(await sqlstate(asRole(role, `select private.store_token('${accountId}'::uuid, 'x')`))).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await sqlstate(asRole(role, "select * from private.web_users"))).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await sqlstate(asRole(role, "select public.metric_value('{}'::jsonb, array['a'])"))).toBe(INSUFFICIENT_PRIVILEGE);
    }
    expect(await sqlstate(asRole("anon", "select private.is_web_user()"))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("anon、authenticated、PUBLIC への権限が public／private／vault に残っていない", async () => {
    const [tables] = await admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.role_table_grants
      where grantee in ('anon', 'authenticated') and table_schema in ('public', 'private', 'vault')
    `;
    expect(tables?.n).toBe(0);
    // 意図して与えたのは authenticated → private.is_web_user の execute だけ
    const routines = await admin<{ grantee: string; routine_schema: string; routine_name: string }[]>`
      select grantee, routine_schema, routine_name from information_schema.routine_privileges
      where grantee in ('anon', 'authenticated', 'PUBLIC') and routine_schema in ('public', 'private')
    `;
    expect(routines).toEqual([{ grantee: "authenticated", routine_schema: "private", routine_name: "is_web_user" }]);
    const [defaults] = await admin<{ n: number }[]>`
      select count(*)::int as n
      from pg_default_acl d
      join pg_roles r on r.oid = d.defaclrole
      join pg_namespace n on n.oid = d.defaclnamespace
      where r.rolname = 'postgres' and n.nspname in ('public', 'private')
        and exists (
          select 1 from unnest(d.defaclacl) a
          where a::text like 'anon=%' or a::text like 'authenticated=%' or a::text like '=%'
        )
    `;
    expect(defaults?.n).toBe(0);
  });

  it("postgres が新しく作るテーブルに anon／authenticated の権限が付かない（default privileges）", async () => {
    // 関数は組み込みの既定で PUBLIC が実行できるままになる（スキーマ単位の default privileges では打ち消せない）。
    // 関数を足すマイグレーションは revoke execute … from public を書く規約で守り、上の棚卸しで検出する
    await admin
      .begin(async (tx) => {
        await tx`create table public.__probe_r2 (id int)`;
        const [row] = await tx<{ t_anon: boolean; t_auth: boolean }[]>`
          select has_table_privilege('anon', 'public.__probe_r2', 'select') as t_anon,
                 has_table_privilege('authenticated', 'public.__probe_r2', 'select') as t_auth
        `;
        expect(row).toEqual({ t_anon: false, t_auth: false });
        throw new Error("rollback");
      })
      .catch((e: unknown) => {
        if (!(e instanceof Error) || e.message !== "rollback") throw e;
      });
  });

  it("private.is_web_user は許可した利用者だけ true（uid がなければ false）", async () => {
    const call = "select private.is_web_user() as ok";
    const run = async (claims?: Record<string, unknown>): Promise<boolean> =>
      ((await asRole("authenticated", call, claims)()) as { ok: boolean }[])[0]?.ok ?? false;
    expect(await run({ role: "authenticated", sub: ALLOWED_USER_ID })).toBe(true);
    expect(await run({ role: "authenticated", sub: OTHER_USER_ID })).toBe(false);
    expect(await run({ role: "authenticated" })).toBe(false);
    expect(await run()).toBe(false);
  });

  it("thumbnails の storage.objects は許可した利用者だけが読め、他のバケットは読めない", async () => {
    const objectName = `${accountId}/probe.jpg`;
    const claims = (sub: string | undefined) => JSON.stringify({ role: "authenticated", ...(sub ? { sub } : {}) });
    // 行は postgres で入れ、トランザクションごと捨てる（Storage の実ファイルは作らない）
    await admin
      .begin(async (tx) => {
        await tx`insert into storage.buckets (id, name) values ('probe-r2', 'probe-r2')`;
        await tx`insert into storage.objects (bucket_id, name) values ('thumbnails', ${objectName})`;
        await tx`insert into storage.objects (bucket_id, name) values ('probe-r2', ${objectName})`;

        const visibleTo = async (sub: string | undefined): Promise<string[]> => {
          await tx`select set_config('request.jwt.claims', ${claims(sub)}, true)`;
          await tx.unsafe("set local role authenticated");
          const rows = await tx<{ bucket_id: string }[]>`select bucket_id from storage.objects where name = ${objectName} order by bucket_id`;
          await tx.unsafe("reset role");
          return rows.map((r) => r.bucket_id);
        };
        expect(await visibleTo(ALLOWED_USER_ID)).toEqual(["thumbnails"]);
        expect(await visibleTo(OTHER_USER_ID)).toEqual([]);
        expect(await visibleTo(undefined)).toEqual([]);
        throw new Error("rollback");
      })
      .catch((e: unknown) => {
        if (!(e instanceof Error) || e.message !== "rollback") throw e;
      });

    // anon は表権限があれば RLS で 0 件、なければ権限エラー。どちらも読めない
    const asAnon = await sqlstate(asRole("anon", `select name from storage.objects where name = '${objectName}'`));
    expect(asAnon === undefined || asAnon === INSUFFICIENT_PRIVILEGE).toBe(true);
    if (asAnon === undefined) {
      const rows = (await asRole("anon", `select name from storage.objects where name = '${objectName}'`)()) as unknown[];
      expect(rows).toHaveLength(0);
    }
  });
});
