/**
 * `accounts`、`private.credentials`、Vault（設計 3.3 章、4.1 章）。
 *
 * - トークンの値は `readCredential` の戻り値にだけ現れる。呼び出し側が秘密の一覧に登録する
 * - この層はログを出さない。Vault や DB の失敗は呼び出し側が `normalizeDbError` で固定文言にする
 * - Vault の秘密の名前は `ig-token-<accounts.id>`（内部の uuid。Instagram の ID は含めない）。
 *   `vault.secrets.name` には一意の部分索引があるので、同じ名前は 1 件しか作れない
 * - `upsertCredential` は `Tx` で呼ぶ。`vault.create_secret` は `vault.secrets` への insert なので、
 *   同じトランザクションがロールバックされれば Vault に孤児が残らない
 */
import type { Db, Tx } from "./client.js";
import type { AccountRow, CredentialStatus, TokenType } from "./types.js";

/** `private.credentials` のうち、トークン本体と内部の ID を除いた項目 */
export interface CredentialInfo {
  token_type: TokenType;
  /** トークンの有効期限。期限なしは null */
  expires_at: Date | null;
  data_access_expires_at: Date | null;
  scopes: string[];
  status: CredentialStatus;
}

/** `updateCredentialStatus` で更新できる列。指定した列だけを更新する */
export interface CredentialPatch extends Partial<CredentialInfo> {
  last_error?: string | null;
  last_checked_at?: Date;
}

export interface AccountUpsert {
  ig_user_id: string;
  /** null か省略なら、既存の値を残す */
  username?: string | null;
  name?: string | null;
  fb_page_id?: string | null;
}

const VAULT_SECRET_DESCRIPTION = "instagram-analyze: Graph API のアクセストークン";

const PATCH_COLUMNS = [
  "token_type",
  "expires_at",
  "data_access_expires_at",
  "scopes",
  "status",
  "last_error",
  "last_checked_at",
] as const;

/** Vault の秘密の名前。`accounts.id`（内部の uuid）から作る */
export function vaultSecretName(accountId: string): string {
  return `ig-token-${accountId}`;
}

/** `status = 'active'` のアカウント。登録順 */
export async function listActiveAccounts(db: Db): Promise<AccountRow[]> {
  const rows = await db<AccountRow[]>`
    select * from public.accounts where status = 'active' order by created_at, id
  `;
  return [...rows];
}

/**
 * `ig_user_id` で upsert する。insert では `status` が既定の `'active'` になり、update では触らない。
 * `username`、`name`、`fb_page_id` は、null か省略なら既存の値を残す
 */
export async function upsertAccount(tx: Tx, a: AccountUpsert): Promise<AccountRow> {
  const rows = await tx<AccountRow[]>`
    insert into public.accounts (ig_user_id, username, name, fb_page_id)
    values (${a.ig_user_id}, ${a.username ?? null}, ${a.name ?? null}, ${a.fb_page_id ?? null})
    on conflict (ig_user_id) do update set
      username = coalesce(excluded.username, accounts.username),
      name = coalesce(excluded.name, accounts.name),
      fb_page_id = coalesce(excluded.fb_page_id, accounts.fb_page_id)
    returning *
  `;
  const row = rows[0];
  if (!row) throw new Error("accounts の upsert が行を返さなかった");
  return row;
}

interface CredentialJoinRow {
  token_type: TokenType;
  expires_at: Date | null;
  data_access_expires_at: Date | null;
  scopes: string[] | null;
  status: CredentialStatus;
  decrypted_secret: string | null;
}

/**
 * `private.credentials` と `vault.decrypted_secrets` を結合して 1 回で読む。
 * 認証情報がない、または Vault の行が見つからなければ undefined。
 * 戻り値の `token` は呼び出し側が秘密の一覧に登録すること
 */
/** `private.credentials` の状態と期限だけ（Vault には触れない）。`check-alerts` が使う。行がなければ undefined */
export async function readCredentialStatus(
  db: Db,
  accountId: string,
): Promise<{ status: CredentialStatus; data_access_expires_at: Date | null } | undefined> {
  const rows = await db<{ status: CredentialStatus; data_access_expires_at: Date | null }[]>`
    select status, data_access_expires_at from private.credentials where account_id = ${accountId}
  `;
  return rows[0];
}

export async function readCredential(
  db: Db,
  accountId: string,
): Promise<{ token: string; info: CredentialInfo } | undefined> {
  const rows = await db<CredentialJoinRow[]>`
    select c.token_type, c.expires_at, c.data_access_expires_at, c.scopes, c.status, s.decrypted_secret
    from private.credentials c
    join vault.decrypted_secrets s on s.id = c.token_secret_id
    where c.account_id = ${accountId}
  `;
  const row = rows[0];
  if (!row || row.decrypted_secret === null) return undefined;
  return {
    token: row.decrypted_secret,
    info: {
      token_type: row.token_type,
      expires_at: row.expires_at,
      data_access_expires_at: row.data_access_expires_at,
      scopes: row.scopes ?? [],
      status: row.status,
    },
  };
}

/**
 * Vault を名前で探し、あれば `update_secret`、なければ `create_secret` → `private.credentials` を upsert
 * （`last_checked_at = now()`、`last_error = null`）。トランザクションの中で呼ぶ
 */
export async function upsertCredential(
  tx: Tx,
  accountId: string,
  token: string,
  info: CredentialInfo,
): Promise<void> {
  const secretId = await upsertVaultSecret(tx, vaultSecretName(accountId), token);
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

/**
 * Vault の秘密を名前で探して更新し、なければ作る。
 *
 * select → create の間に、同じ名前で別のトランザクションが先に create すると、後の方が `secrets_name_idx`
 * （`vault.secrets.name` の一意の部分索引）の違反（SQLSTATE 23505）で失敗する。呼び出し元は `register-token`
 * だけで、単一ユーザーが手で実行するコマンドなので、この競合は許容する（起きても `DB エラー（SQLSTATE 23505）`
 * で終わり、やり直せばよい）。なお、同じトランザクションで先に `upsertAccount` を呼んでいれば、`accounts` の
 * 行ロック（`insert ... on conflict do update`）で同じアカウントの処理は直列化され、この競合は起きない
 */
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

/** 指定された列だけを更新する。`undefined` の項目は触らない（null を渡せば null にする）。何も指定がなければ何もしない */
export async function updateCredentialStatus(
  db: Db,
  accountId: string,
  patch: CredentialPatch,
): Promise<void> {
  const columns: Record<string, string | string[] | Date | null> = {};
  for (const key of PATCH_COLUMNS) {
    const value = patch[key];
    if (value !== undefined) columns[key] = value;
  }
  if (Object.keys(columns).length === 0) return;
  await db`update private.credentials set ${db(columns)} where account_id = ${accountId}`;
}
