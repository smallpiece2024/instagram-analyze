/**
 * `raw_api_responses`（設計 1.2 章、3.4 章）。
 *
 * 自動コミット（トランザクションの外）で入れる。項目の行の書き込みが失敗しても生レスポンスは残る。
 * `params` と `body` は呼び出し側（`jobs/graph-client.ts`）が `stripSecretParams` と `stripVolatileFields` を
 * 通してから渡す。この層では加工しないが、`params` に秘密のキーが残っていれば保険として拒む。
 * `db.begin` の中からは呼ばないこと（`max: 2` でロック用の接続を予約していると、空き接続を待ち続ける）
 */
import { jsonb, type Db } from "./client.js";

/** `params` に残っていてはいけないキー（設計 1.3 章の `stripSecretParams` が除く対象）。入口でも拒む */
const SECRET_PARAM_KEYS = ["access_token", "input_token", "appsecret_proof"] as const;

/** `params` に秘密のキーがあったときの固定文言。値は含めない */
export const SECRET_PARAMS_ERROR = "params に秘密のキーが含まれる";

export interface RawResponseInsert {
  account_id: string;
  /** ジョブの外（`register-token` など）からは null */
  job_run_id: string | null;
  /** 呼び出したパス。トークンを含めない */
  endpoint: string;
  /** クエリのパラメータ。トークンを含めない */
  params: Record<string, unknown>;
  api_version: string;
  fetched_at: Date;
  http_status: number;
  /** レスポンス本文。レスポンスがなければ null */
  body: unknown;
}

/**
 * 1 行入れて `id`（bigint の文字列）を返す。
 * `params` に `access_token`、`input_token`、`appsecret_proof` のキーがあれば、何も書かずに固定文言の例外を投げる
 */
export async function insertRawResponse(db: Db, row: RawResponseInsert): Promise<string> {
  if (SECRET_PARAM_KEYS.some((key) => Object.hasOwn(row.params, key))) {
    throw new Error(SECRET_PARAMS_ERROR);
  }
  const rows = await db<{ id: string }[]>`
    insert into public.raw_api_responses
      (account_id, job_run_id, endpoint, params, api_version, fetched_at, http_status, body)
    values
      (${row.account_id}, ${row.job_run_id}, ${row.endpoint}, ${jsonb(db, row.params)},
       ${row.api_version}, ${row.fetched_at}, ${row.http_status}, ${jsonb(db, row.body)})
    returning id
  `;
  const inserted = rows[0];
  if (!inserted) throw new Error("raw_api_responses の insert が id を返さなかった");
  return inserted.id;
}
