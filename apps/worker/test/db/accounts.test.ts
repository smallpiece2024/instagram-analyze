import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  listActiveAccounts,
  readCredential,
  updateCredentialStatus,
  upsertAccount,
  upsertCredential,
  vaultSecretName,
  type CredentialInfo,
} from "../../src/db/accounts.js";
import { closeDb, connectDb, normalizeDbError, type Db } from "../../src/db/client.js";
import type { CredentialRow, CredentialStatus } from "../../src/db/types.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** 架空の Instagram アカウント ID（実在しない。先頭 6 桁が 0） */
function fakeIgUserId(): string {
  return "000000" + Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, "0");
}

const INFO: CredentialInfo = {
  token_type: "PAGE",
  expires_at: null,
  data_access_expires_at: new Date("2026-12-29T00:00:00Z"),
  scopes: ["instagram_basic", "instagram_manage_insights", "pages_read_engagement"],
  status: "valid",
};

describe.skipIf(!TEST_DATABASE_URL)("db/accounts（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  const igUserId = fakeIgUserId();
  let db: Db;
  let accountId: string;
  const createdAccountIds: string[] = [];

  async function countVaultSecrets(name: string): Promise<number> {
    const [row] = await db<{ n: number }[]>`select count(*)::int as n from vault.secrets where name = ${name}`;
    return row?.n ?? -1;
  }

  async function readCredentialRow(id: string): Promise<CredentialRow | undefined> {
    const rows = await db<CredentialRow[]>`select * from private.credentials where account_id = ${id}`;
    return rows[0];
  }

  beforeAll(async () => {
    db = connectDb(url);
    const account = await db.begin((tx) => upsertAccount(tx, { ig_user_id: igUserId, username: "fake_user" }));
    accountId = account.id;
    createdAccountIds.push(accountId);
  });

  afterAll(async () => {
    for (const id of createdAccountIds) {
      await db`delete from public.accounts where id = ${id}`;
      expect(await countVaultSecrets(vaultSecretName(id))).toBe(0);
    }
    await closeDb(db);
  });

  it("upsertAccount を同じ入力で 2 回呼んでも行は 1 つで、status は変わらない", async () => {
    const first = await db.begin((tx) => upsertAccount(tx, { ig_user_id: igUserId, username: "fake_user" }));
    expect(first.id).toBe(accountId);
    expect(first.status).toBe("active");

    await db`update public.accounts set status = 'paused' where id = ${accountId}`;
    const second = await db.begin((tx) => upsertAccount(tx, { ig_user_id: igUserId, username: "fake_user" }));
    expect(second.id).toBe(accountId);
    expect(second.status).toBe("paused");

    const [count] = await db<{ n: number }[]>`
      select count(*)::int as n from public.accounts where ig_user_id = ${igUserId}
    `;
    expect(count?.n).toBe(1);
    await db`update public.accounts set status = 'active' where id = ${accountId}`;
  });

  it("upsertAccount は null や省略の項目で既存の値を消さず、値があれば更新する", async () => {
    const updated = await db.begin((tx) =>
      upsertAccount(tx, { ig_user_id: igUserId, username: null, name: "Fake Name", fb_page_id: "000000000000001" }),
    );
    expect(updated.username).toBe("fake_user");
    expect(updated.name).toBe("Fake Name");
    expect(updated.fb_page_id).toBe("000000000000001");

    const again = await db.begin((tx) => upsertAccount(tx, { ig_user_id: igUserId, username: "fake_user2" }));
    expect(again.username).toBe("fake_user2");
    expect(again.name).toBe("Fake Name");
  });

  it("listActiveAccounts は active だけを返す", async () => {
    const active = await listActiveAccounts(db);
    expect(active.some((a) => a.id === accountId)).toBe(true);

    await db`update public.accounts set status = 'paused' where id = ${accountId}`;
    const afterPause = await listActiveAccounts(db);
    expect(afterPause.some((a) => a.id === accountId)).toBe(false);
    await db`update public.accounts set status = 'active' where id = ${accountId}`;
  });

  it("upsertCredential → readCredential で同じトークンが読める。別のトークンで更新しても Vault の行は 1 件のまま", async () => {
    const name = vaultSecretName(accountId);
    await db.begin((tx) => upsertCredential(tx, accountId, "FAKE_TOKEN_1", INFO));
    const first = await readCredential(db, accountId);
    expect(first?.token).toBe("FAKE_TOKEN_1");
    expect(first?.info).toEqual(INFO);
    expect(await countVaultSecrets(name)).toBe(1);

    const before = await readCredentialRow(accountId);
    expect(before?.last_checked_at).toBeInstanceOf(Date);
    expect(before?.last_error).toBeNull();

    const changed: CredentialInfo = {
      ...INFO,
      token_type: "USER",
      expires_at: new Date("2026-11-30T00:00:00Z"),
      status: "insufficient_scope",
      scopes: ["instagram_basic"],
    };
    await db.begin((tx) => upsertCredential(tx, accountId, "FAKE_TOKEN_2", changed));
    const second = await readCredential(db, accountId);
    expect(second?.token).toBe("FAKE_TOKEN_2");
    expect(second?.info).toEqual(changed);
    expect(await countVaultSecrets(name)).toBe(1);

    const after = await readCredentialRow(accountId);
    expect(after?.token_secret_id).toBe(before?.token_secret_id);
    const [count] = await db<{ n: number }[]>`
      select count(*)::int as n from private.credentials where account_id = ${accountId}
    `;
    expect(count?.n).toBe(1);
  });

  it("updateCredentialStatus は指定した列だけを更新する", async () => {
    await db.begin((tx) => upsertCredential(tx, accountId, "FAKE_TOKEN_3", INFO));
    const before = await readCredentialRow(accountId);
    expect(before).toBeDefined();

    await updateCredentialStatus(db, accountId, { status: "expired", last_error: "トークンが無効（コード 190）" });
    const after = await readCredentialRow(accountId);
    expect(after?.status).toBe("expired");
    expect(after?.last_error).toBe("トークンが無効（コード 190）");
    expect(after?.token_type).toBe(before?.token_type);
    expect(after?.token_secret_id).toBe(before?.token_secret_id);
    expect(after?.expires_at).toEqual(before?.expires_at);
    expect(after?.data_access_expires_at).toEqual(before?.data_access_expires_at);
    expect(after?.scopes).toEqual(before?.scopes);
    expect(after?.last_checked_at).toEqual(before?.last_checked_at);

    const checkedAt = new Date("2026-10-01T01:02:03Z");
    await updateCredentialStatus(db, accountId, {
      status: "valid",
      last_error: null,
      last_checked_at: checkedAt,
      scopes: ["instagram_basic"],
      expires_at: null,
    });
    const again = await readCredentialRow(accountId);
    expect(again?.status).toBe("valid");
    expect(again?.last_error).toBeNull();
    expect(again?.last_checked_at).toEqual(checkedAt);
    expect(again?.scopes).toEqual(["instagram_basic"]);
    expect(again?.expires_at).toBeNull();

    // 何も指定しなければ何もしない
    await updateCredentialStatus(db, accountId, {});
    expect(await readCredentialRow(accountId)).toEqual(again);

    // トークンは変わらない
    expect((await readCredential(db, accountId))?.token).toBe("FAKE_TOKEN_3");
  });

  it("トランザクションがロールバックされると Vault に孤児が残らない", async () => {
    const other = await db.begin((tx) => upsertAccount(tx, { ig_user_id: fakeIgUserId() }));
    createdAccountIds.push(other.id);
    const name = vaultSecretName(other.id);

    await expect(
      db.begin(async (tx) => {
        await upsertCredential(tx, other.id, "FAKE_TOKEN_ROLLBACK", INFO);
        throw new Error("意図的に失敗させる");
      }),
    ).rejects.toThrow("意図的に失敗させる");

    expect(await countVaultSecrets(name)).toBe(0);
    expect(await readCredentialRow(other.id)).toBeUndefined();
    expect(await readCredential(db, other.id)).toBeUndefined();
  });

  it("accounts を消すと private.credentials と vault.secrets の行も消える", async () => {
    const victim = await db.begin((tx) => upsertAccount(tx, { ig_user_id: fakeIgUserId() }));
    const name = vaultSecretName(victim.id);
    await db.begin((tx) => upsertCredential(tx, victim.id, "FAKE_TOKEN_DELETE", INFO));
    expect(await countVaultSecrets(name)).toBe(1);

    await db`delete from public.accounts where id = ${victim.id}`;
    expect(await readCredentialRow(victim.id)).toBeUndefined();
    expect(await countVaultSecrets(name)).toBe(0);
  });

  it("upsertCredential が CHECK 違反で失敗するとロールバックされ、Vault に孤児が残らない", async () => {
    const other = await db.begin((tx) => upsertAccount(tx, { ig_user_id: fakeIgUserId() }));
    createdAccountIds.push(other.id);
    const name = vaultSecretName(other.id);
    const bogus: CredentialInfo = { ...INFO, status: "bogus" as CredentialStatus };

    const error = await db
      .begin((tx) => upsertCredential(tx, other.id, "FAKE_TOKEN_CHECK", bogus))
      .then(() => undefined, (e: unknown) => e);
    expect(error).toBeDefined();
    expect(normalizeDbError(error)).toBe("DB エラー（SQLSTATE 23514）");

    expect(await countVaultSecrets(name)).toBe(0);
    expect(await readCredentialRow(other.id)).toBeUndefined();
    expect(await readCredential(db, other.id)).toBeUndefined();
  });

  it("readCredential は存在しないアカウントでは undefined", async () => {
    expect(await readCredential(db, randomUUID())).toBeUndefined();
  });
});
