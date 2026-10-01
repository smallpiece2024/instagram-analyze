/**
 * Facebook Login で得たページトークンを `accounts`、Vault、`private.credentials` に登録する（設計 2.4 章）。
 * ワーカーの `register-token`（`apps/worker/src/db/accounts.ts`）と同じ内容を 1 つのトランザクションで行う。
 *
 * 1. `accounts` を `ig_user_id` で upsert。`username`、`name`、`fb_page_id` は null で既存を消さない。
 *    `status` は `disconnected` なら `active` に戻し、`paused` はそのまま。新規は既定の `active`
 * 2. Vault を `name = ig-token-<accounts.id>` で探し、あれば `update_secret`、なければ `create_secret`
 * 3. `private.credentials` を upsert（`last_checked_at = now()`、`last_error = null`）
 *
 * - トークンの値はこの関数の引数にだけ現れる。ログを出さず、例外のメッセージも組み立てない
 * - 失敗は `describeDbError` の固定文言で返す（例外を投げない）。`vault.create_secret` は `vault.secrets` への
 *   insert なので、同じトランザクションがロールバックされれば Vault に孤児が残らない
 */
import "server-only";
import type { Db, Tx } from "@/lib/db";
import { describeDbError } from "@/lib/db-errors";
import type { CredentialInfo } from "@/lib/meta-oauth";

export interface RegisterCredentialInput {
  igUserId: string;
  username: string | null;
  name: string | null;
  /** 選んだ Facebook ページの ID（`debug_token` の `profile_id` と一致を確認済み） */
  fbPageId: string;
  /** ページアクセストークン */
  token: string;
  credential: CredentialInfo;
}

export type RegisterCredentialResult = { ok: true; accountId: string } | { ok: false; reason: string };

const VAULT_SECRET_DESCRIPTION = "instagram-analyze: Graph API のアクセストークン";

/** Vault の秘密の名前。`accounts.id`（内部の uuid）から作る。ワーカーと同じ規則 */
export function vaultSecretName(accountId: string): string {
  return `ig-token-${accountId}`;
}

async function upsertAccount(tx: Tx, input: RegisterCredentialInput): Promise<string> {
  const rows = await tx<{ id: string }[]>`
    insert into public.accounts (ig_user_id, username, name, fb_page_id)
    values (${input.igUserId}, ${input.username}, ${input.name}, ${input.fbPageId})
    on conflict (ig_user_id) do update set
      username = coalesce(excluded.username, accounts.username),
      name = coalesce(excluded.name, accounts.name),
      fb_page_id = coalesce(excluded.fb_page_id, accounts.fb_page_id),
      status = case when accounts.status = 'disconnected' then 'active' else accounts.status end
    returning id
  `;
  const row = rows[0];
  if (!row) throw new Error("accounts の upsert が行を返さなかった");
  return row.id;
}

async function upsertVaultSecret(tx: Tx, name: string, token: string): Promise<string> {
  const existing = await tx<{ id: string }[]>`select id from vault.secrets where name = ${name}`;
  const found = existing[0];
  if (found) {
    await tx`select vault.update_secret(${found.id}::uuid, ${token})`;
    return found.id;
  }
  const created = await tx<{ id: string }[]>`
    select vault.create_secret(${token}, ${name}, ${VAULT_SECRET_DESCRIPTION}) as id
  `;
  const row = created[0];
  if (!row) throw new Error("Vault の create_secret が id を返さなかった");
  return row.id;
}

async function upsertCredential(tx: Tx, accountId: string, secretId: string, info: CredentialInfo): Promise<void> {
  await tx`
    insert into private.credentials
      (account_id, token_type, token_secret_id, expires_at, data_access_expires_at, scopes, status, last_checked_at, last_error)
    values
      (${accountId}, ${info.token_type}, ${secretId}::uuid, ${info.expires_at}, ${info.data_access_expires_at},
       ${info.scopes}, ${info.status}, now(), null)
    on conflict (account_id) do update set
      token_type = excluded.token_type,
      token_secret_id = excluded.token_secret_id,
      expires_at = excluded.expires_at,
      data_access_expires_at = excluded.data_access_expires_at,
      scopes = excluded.scopes,
      status = excluded.status,
      last_checked_at = now(),
      last_error = null
  `;
}

/** 1 つのトランザクションで `accounts` → Vault → `private.credentials` を upsert する */
export async function registerCredential(db: Db, input: RegisterCredentialInput): Promise<RegisterCredentialResult> {
  try {
    const accountId = await db.begin(async (tx) => {
      const id = await upsertAccount(tx, input);
      const secretId = await upsertVaultSecret(tx, vaultSecretName(id), input.token);
      await upsertCredential(tx, id, secretId, input.credential);
      return id;
    });
    return { ok: true, accountId };
  } catch (e) {
    return { ok: false, reason: describeDbError(e) };
  }
}
