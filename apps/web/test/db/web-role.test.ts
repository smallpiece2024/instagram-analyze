/**
 * R2 のマイグレーション `20261002005926_r2_web_role.sql` の結合テスト（設計 `doc/design/r2-cloud.md` 3.5 章）。
 * `TEST_DATABASE_URL`（postgres）と `TEST_WEB_DATABASE_URL`（web_app。ローカルは seed.sql の公知のパスワード）の
 * 両方があるときだけ動く。架空のアカウント（`000000` ＋ 乱数 9 桁）を postgres で作り、終了時に消す
 * （CASCADE と `private.credentials` のトリガーで Vault も消える）。
 *
 * 確かめること:
 * - web_app は 6 つのビューと画面が使うテーブルを読める
 * - web_app は vault、raw_api_responses、job_state を読めず、job_runs に書けない（SQLSTATE 42501）
 * - private.store_token で Vault に作成・更新でき、web_app 自身は Vault を読めない
 * - private.credentials を upsert できる（select／insert／update の 3 本のポリシー）
 * - anon と authenticated は public のテーブルとビューを読めない（grant で落ちる）
 * - thumbnails の署名付き URL の基になる storage.objects の select は、匿名でない authenticated だけ通る
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllDb, getDb, type Db } from "../../src/lib/db";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_WEB_DATABASE_URL = process.env.TEST_WEB_DATABASE_URL;

const INSUFFICIENT_PRIVILEGE = "42501";
const NO_DATA_FOUND = "P0002";
const INVALID_PARAMETER_VALUE = "22023";

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
  const FAKE_TOKEN_1 = `FAKE_ROLE_TOKEN_${Math.floor(Math.random() * 1_000_000_000)}`;
  const FAKE_TOKEN_2 = `${FAKE_TOKEN_1}_UPDATED`;
  let admin: Db;
  let web: Db;
  let accountId: string;

  beforeAll(async () => {
    admin = getDb(adminUrl);
    web = getDb(webUrl);
    const rows = await admin<{ id: string }[]>`
      insert into public.accounts (ig_user_id, username, name, fb_page_id)
      values (${igUserId}, 'fake_role_user', 'Fake Role Name', '000000000000098')
      returning id
    `;
    accountId = rows[0]?.id ?? "";
    expect(accountId).not.toBe("");
  });

  afterAll(async () => {
    await admin`delete from public.accounts where ig_user_id = ${igUserId}`;
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

  it("web_app は vault、raw_api_responses、job_state を読めず、job_runs に書けない", async () => {
    expect(await sqlstate(() => web`select * from vault.secrets limit 1`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(() => web`select * from vault.decrypted_secrets limit 1`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(() => web`select vault.create_secret('x', 'ig-token-should-fail')`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(() => web`select * from public.raw_api_responses limit 1`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(() => web`select * from public.job_state limit 1`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(
      await sqlstate(() => web`insert into public.job_runs (job_name, account_id, status) values ('probe', ${accountId}, 'running')`),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(() => web`delete from public.accounts where id = ${accountId}`)).toBe(INSUFFICIENT_PRIVILEGE);
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

  it("private.store_token は空のトークンと存在しないアカウントを拒む", async () => {
    expect(await sqlstate(() => web`select private.store_token(${accountId}::uuid, '')`)).toBe(INVALID_PARAMETER_VALUE);
    expect(await sqlstate(() => web`select private.store_token('00000000-0000-0000-0000-000000000000'::uuid, 'x')`)).toBe(NO_DATA_FOUND);
  });

  it("web_app は private.credentials を upsert でき、account_connection_status に反映される", async () => {
    const [secret] = await web<{ id: string }[]>`select private.store_token(${accountId}::uuid, ${FAKE_TOKEN_2}) as id`;
    const secretId = secret?.id ?? "";
    const expires = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    const upsert = (status: string) => web`
      insert into private.credentials
        (account_id, token_type, token_secret_id, expires_at, data_access_expires_at, scopes, status, last_checked_at, last_error)
      values
        (${accountId}, 'PAGE', ${secretId}::uuid, null, ${expires}, ${["instagram_basic"]}, ${status}, now(), null)
      on conflict (account_id) do update set
        status = excluded.status, last_checked_at = now(), last_error = null
      returning account_id
    `;
    expect(await sqlstate(() => upsert("valid"))).toBeUndefined();
    expect(await sqlstate(() => upsert("error"))).toBeUndefined();

    const [row] = await web<{ credential_status: string | null; token_type: string | null }[]>`
      select credential_status, token_type from public.account_connection_status where account_id = ${accountId}
    `;
    expect(row?.credential_status).toBe("error");
    expect(row?.token_type).toBe("PAGE");

    // 更新で Vault を読む必要はない（web_app は復号ビューに触れない）
    expect(await sqlstate(() => web`update private.credentials set status = 'valid' where account_id = ${accountId}`)).toBeUndefined();
  });

  /** 1 つのトランザクションの中でロールを切り替えてクエリを 1 回だけ流す（失敗するとトランザクションが壊れるので 1 回ずつ） */
  function asRole(role: "anon" | "authenticated", query: string): () => Promise<unknown> {
    return () =>
      admin.begin(async (tx) => {
        await tx.unsafe(`set local role ${role}`);
        return tx.unsafe(query);
      });
  }

  it.each(["anon", "authenticated"] as const)("%s は public のテーブルとビューを読めない（grant で落ちる）", async (role) => {
    expect(await sqlstate(asRole(role, "select * from public.accounts limit 1"))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(asRole(role, "select * from public.media limit 1"))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(asRole(role, "select * from public.job_latest_runs limit 1"))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(asRole(role, "select * from public.media_analysis_dataset limit 1"))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(asRole(role, `select private.store_token('${accountId}'::uuid, 'x')`))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("thumbnails の storage.objects は匿名でない authenticated だけが読める", async () => {
    const objectName = `${accountId}/probe.jpg`;
    const claims = (anonymous: boolean) =>
      JSON.stringify({ role: "authenticated", sub: "00000000-0000-0000-0000-000000000001", is_anonymous: anonymous });
    // 行は postgres で入れ、トランザクションごと捨てる（Storage の実ファイルは作らない）
    await admin.begin(async (tx) => {
      await tx`insert into storage.objects (bucket_id, name) values ('thumbnails', ${objectName})`;

      await tx`select set_config('request.jwt.claims', ${claims(false)}, true)`;
      await tx.unsafe("set local role authenticated");
      const visible = await tx<{ name: string }[]>`select name from storage.objects where name = ${objectName}`;
      expect(visible.map((r) => r.name)).toEqual([objectName]);
      await tx.unsafe("reset role");

      await tx`select set_config('request.jwt.claims', ${claims(true)}, true)`;
      await tx.unsafe("set local role authenticated");
      const anonymous = await tx<{ name: string }[]>`select name from storage.objects where name = ${objectName}`;
      expect(anonymous).toHaveLength(0);
      await tx.unsafe("reset role");

      // anon は最後に（権限エラーならトランザクションが壊れるので、この後に何もしない）
      await tx.unsafe("set local role anon");
      const asAnon = await tx<{ name: string }[]>`select name from storage.objects where name = ${objectName}`.catch(() => []);
      expect(asAnon).toHaveLength(0);

      throw new Error("rollback");
    }).catch((e: unknown) => {
      if (!(e instanceof Error) || e.message !== "rollback") throw e;
    });
  });
});
