/**
 * `src/lib/queries/register-credential.ts` の結合テスト（設計 4.3 章。R2 設計 3.5 章）。
 * `TEST_DATABASE_URL`（postgres。Vault の復号と後始末）と `TEST_WEB_DATABASE_URL`（web_app。登録の実行）の両方があるときだけ動く。
 * 登録は `web_app` で行い（`private.store_token` 経由。`vault.secrets` は読めない）、結果は postgres で読んで確かめる。
 * 架空の Instagram アカウント ID（`000000` ＋ 乱数 9 桁）と偽のトークンで登録し、終了時に `accounts` を消す
 * （CASCADE と `private.credentials` のトリガーで Vault も消える）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllDb, getDb, type Db } from "../../src/lib/db";
import type { CredentialInfo } from "../../src/lib/meta-oauth";
import { registerCredential, vaultSecretName, type RegisterCredentialInput } from "../../src/lib/queries/register-credential";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_WEB_DATABASE_URL = process.env.TEST_WEB_DATABASE_URL;

function fakeIgUserId(): string {
  return "000000" + Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, "0");
}

const FAKE_TOKEN = `FAKE_WEB_PAGE_TOKEN_${Math.floor(Math.random() * 1_000_000_000)}`;
const FB_PAGE_ID = "000000000000099";
const ALL_SCOPES = ["instagram_basic", "instagram_manage_insights", "pages_read_engagement"];

const VALID: CredentialInfo = {
  token_type: "PAGE",
  expires_at: null,
  data_access_expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
  scopes: [...ALL_SCOPES, "pages_show_list"],
  status: "valid",
};

interface AccountRow {
  id: string;
  ig_user_id: string;
  username: string | null;
  name: string | null;
  fb_page_id: string | null;
  status: string;
}

interface CredentialRow {
  token_type: string;
  token_secret_id: string;
  expires_at: Date | null;
  data_access_expires_at: Date | null;
  scopes: string[] | null;
  status: string;
  last_checked_at: Date | null;
  last_error: string | null;
  decrypted_secret: string | null;
}

describe.skipIf(!TEST_DATABASE_URL || !TEST_WEB_DATABASE_URL)("queries/register-credential（結合。web_app で登録）", () => {
  const url = TEST_DATABASE_URL ?? "";
  const webUrl = TEST_WEB_DATABASE_URL ?? "";
  const igUserId = fakeIgUserId();
  const otherIgUserId = fakeIgUserId();
  /** postgres（確認と後始末） */
  let db: Db;
  /** web_app（登録の実行） */
  let web: Db;

  function input(overrides: Partial<RegisterCredentialInput> = {}): RegisterCredentialInput {
    return {
      igUserId,
      username: "fake_web_user",
      name: "Fake Web Name",
      fbPageId: FB_PAGE_ID,
      token: FAKE_TOKEN,
      credential: VALID,
      ...overrides,
    };
  }

  async function account(id = igUserId): Promise<AccountRow | undefined> {
    return (await db<AccountRow[]>`select id, ig_user_id, username, name, fb_page_id, status from public.accounts where ig_user_id = ${id}`)[0];
  }

  async function credential(accountId: string): Promise<CredentialRow | undefined> {
    return (
      await db<CredentialRow[]>`
        select c.token_type, c.token_secret_id, c.expires_at, c.data_access_expires_at, c.scopes, c.status,
               c.last_checked_at, c.last_error, s.decrypted_secret
        from private.credentials c
        left join vault.decrypted_secrets s on s.id = c.token_secret_id
        where c.account_id = ${accountId}
      `
    )[0];
  }

  async function vaultCount(accountId: string): Promise<number> {
    const [row] = await db<{ n: number }[]>`select count(*)::int as n from vault.secrets where name = ${vaultSecretName(accountId)}`;
    return row?.n ?? -1;
  }

  async function allTokenSecrets(): Promise<number> {
    const [row] = await db<{ n: number }[]>`select count(*)::int as n from vault.secrets where name like 'ig-token-%'`;
    return row?.n ?? -1;
  }

  beforeAll(() => {
    db = getDb(url);
    web = getDb(webUrl);
  });

  afterAll(async () => {
    const before = await account();
    await db`delete from public.accounts where ig_user_id in (${igUserId}, ${otherIgUserId})`;
    if (before) expect(await vaultCount(before.id)).toBe(0);
    await closeAllDb();
  });

  it("新規登録で accounts、private.credentials、Vault に 1 件ずつ入り、トークンは Vault から復号できる", async () => {
    const result = await registerCredential(web, input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = await account();
    expect(row).toBeDefined();
    expect(row?.id).toBe(result.accountId);
    expect(row?.username).toBe("fake_web_user");
    expect(row?.name).toBe("Fake Web Name");
    expect(row?.fb_page_id).toBe(FB_PAGE_ID);
    expect(row?.status).toBe("active");
    expect(await vaultCount(result.accountId)).toBe(1);

    const cred = await credential(result.accountId);
    expect(cred?.token_type).toBe("PAGE");
    expect(cred?.status).toBe("valid");
    expect(cred?.expires_at).toBeNull();
    expect(cred?.data_access_expires_at).toBeInstanceOf(Date);
    expect(cred?.scopes).toEqual([...ALL_SCOPES, "pages_show_list"]);
    expect(cred?.last_checked_at).toBeInstanceOf(Date);
    expect(cred?.last_error).toBeNull();
    expect(cred?.decrypted_secret).toBe(FAKE_TOKEN);
  });

  it("2 回目は行が増えず、token_secret_id は同じまま値が差し替わる。null の username と name は既存を消さない", async () => {
    const before = await account();
    const beforeCred = await credential(before?.id ?? "");
    const secondToken = `${FAKE_TOKEN}_2`;
    const result = await registerCredential(
      web,
      input({ username: null, name: null, token: secondToken, credential: { ...VALID, scopes: ALL_SCOPES } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.accountId).toBe(before?.id);

    const row = await account();
    expect(row?.username).toBe("fake_web_user");
    expect(row?.name).toBe("Fake Web Name");
    expect(await vaultCount(result.accountId)).toBe(1);
    const cred = await credential(result.accountId);
    expect(cred?.token_secret_id).toBe(beforeCred?.token_secret_id);
    expect(cred?.decrypted_secret).toBe(secondToken);
    expect(cred?.scopes).toEqual(ALL_SCOPES);
    const [count] = await db<{ n: number }[]>`select count(*)::int as n from private.credentials where account_id = ${result.accountId}`;
    expect(count?.n).toBe(1);
  });

  it("disconnected のアカウントは active に戻り、paused はそのまま", async () => {
    await db`update public.accounts set status = 'disconnected' where ig_user_id = ${igUserId}`;
    expect((await registerCredential(web, input())).ok).toBe(true);
    expect((await account())?.status).toBe("active");

    await db`update public.accounts set status = 'paused' where ig_user_id = ${igUserId}`;
    expect((await registerCredential(web, input())).ok).toBe(true);
    expect((await account())?.status).toBe("paused");

    await db`update public.accounts set status = 'active' where ig_user_id = ${igUserId}`;
  });

  it("expired と last_error を持つ認証情報は、再登録で valid に戻り、last_error は null、last_checked_at が進む（設計 2.6 章）", async () => {
    const row = await account();
    expect(row).toBeDefined();
    const accountId = row?.id ?? "";
    await db`
      update private.credentials
      set status = 'expired', last_error = 'テスト', last_checked_at = now() - interval '1 day'
      where account_id = ${accountId}
    `;
    const before = await credential(accountId);
    expect(before?.status).toBe("expired");
    expect(before?.last_error).toBe("テスト");

    expect((await registerCredential(web, input())).ok).toBe(true);
    const after = await credential(accountId);
    expect(after?.status).toBe("valid");
    expect(after?.last_error).toBeNull();
    expect(after?.last_checked_at?.getTime() ?? 0).toBeGreaterThan(before?.last_checked_at?.getTime() ?? 0);
  });

  it("scopes が空配列でも登録でき、空配列で読める", async () => {
    const result = await registerCredential(web, input({ credential: { ...VALID, scopes: [], status: "insufficient_scope" } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const cred = await credential(result.accountId);
    expect(cred?.scopes).toEqual([]);
    expect(cred?.status).toBe("insufficient_scope");
  });

  it("fb_page_id を別の値で再登録すると置き換わる", async () => {
    expect((await registerCredential(web, input({ fbPageId: "000000000000098" }))).ok).toBe(true);
    expect((await account())?.fb_page_id).toBe("000000000000098");
    expect((await registerCredential(web, input())).ok).toBe(true);
    expect((await account())?.fb_page_id).toBe(FB_PAGE_ID);
  });

  it("expires_at が非 null の Date なら保存され、同じ時刻で読める", async () => {
    const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 60 * 24 * 60 * 60 * 1000);
    const result = await registerCredential(web, input({ credential: { ...VALID, expires_at: expiresAt } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const cred = await credential(result.accountId);
    expect(cred?.expires_at).toEqual(expiresAt);
    expect((await registerCredential(web, input())).ok).toBe(true);
    expect((await credential(result.accountId))?.expires_at).toBeNull();
  });

  it("権限が足りなければ insufficient_scope で登録する", async () => {
    const result = await registerCredential(
      web,
      input({ credential: { ...VALID, scopes: ["instagram_basic"], status: "insufficient_scope" } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const cred = await credential(result.accountId);
    expect(cred?.status).toBe("insufficient_scope");
    expect(cred?.scopes).toEqual(["instagram_basic"]);
  });

  it("トランザクション途中の失敗（credentials の check 違反）では、新規アカウントも Vault の孤児も残らない。理由は固定文言", async () => {
    const vaultBefore = await allTokenSecrets();
    const result = await registerCredential(
      web,
      input({ igUserId: otherIgUserId, token: "FAKE_WEB_ORPHAN_TOKEN", credential: { ...VALID, status: "bogus" as "valid" } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/23514/);
    expect(result.reason).not.toContain("FAKE_WEB_ORPHAN_TOKEN");
    expect(result.reason).not.toContain(otherIgUserId);
    expect(await account(otherIgUserId)).toBeUndefined();
    expect(await allTokenSecrets()).toBe(vaultBefore);
  });

  it("既存アカウントでの途中の失敗では、Vault の値が元のまま残る", async () => {
    const before = await account();
    const beforeCred = await credential(before?.id ?? "");
    const result = await registerCredential(
      web,
      input({ token: "FAKE_WEB_ROLLBACK_TOKEN", credential: { ...VALID, status: "bogus" as "valid" } }),
    );
    expect(result.ok).toBe(false);
    const after = await credential(before?.id ?? "");
    expect(after?.decrypted_secret).toBe(beforeCred?.decrypted_secret);
    expect(after?.token_secret_id).toBe(beforeCred?.token_secret_id);
    expect((await account())?.status).toBe("active");
  });
});
