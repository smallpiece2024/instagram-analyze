/**
 * 環境変数から設定を読み込む。
 * 秘密情報（トークン、アプリシークレット）はログに出さないこと（NF-SEC-06）。
 */

export const DEFAULT_GRAPH_API_VERSION = "v25.0";

export interface MetaConfig {
  accessToken: string;
  graphApiVersion: string;
  /** 省略時は /me/accounts から接続済みの Instagram アカウントを探す */
  igUserId: string | undefined;
  /** debug_token でトークンの種類と期限を調べるために使う（任意） */
  appId: string | undefined;
  appSecret: string | undefined;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function loadMetaConfig(): MetaConfig {
  const accessToken = optional("META_ACCESS_TOKEN");
  if (!accessToken) {
    throw new Error(
      "環境変数 META_ACCESS_TOKEN が設定されていません。README の「Meta API の検証」を参照してください。",
    );
  }
  return {
    accessToken,
    graphApiVersion: optional("META_GRAPH_API_VERSION") ?? DEFAULT_GRAPH_API_VERSION,
    igUserId: optional("IG_USER_ID"),
    appId: optional("META_APP_ID"),
    appSecret: optional("META_APP_SECRET"),
  };
}

/** 検証結果などのローカル出力先（Git 管理外） */
export function outputDir(): string {
  return optional("WORKER_OUTPUT_DIR") ?? ".local";
}
