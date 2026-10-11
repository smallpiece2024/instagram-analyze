/**
 * 文字で探す（`/reels`。R4.1 設計 6.3 節）の検索語の正規化とエスケープ。`server-only` なし（純粋関数）。
 *
 * - 正規化はワーカーの `normalizeText` と同じ処理（`normalize("NFKC")` → 空白を除く → ASCII を小文字）。
 *   別パッケージなので複製し、同じ入出力のテストを両方に置く
 * - 順は **正規化 → 空白除去 → 長さの検査 → エスケープ**。NFKC は `％`→`%`、`＿`→`_`、`＼`→`\` に変換するので、
 *   エスケープは正規化の後に行う（7 章）
 * - 正規化後に 1〜100 コードポイントでなければ null（既定の画面）。空白だけの `q` もここで空になる
 * - SQL では正規化しない。`'%' + escaped + '%'` をパラメータとして渡し、`text_norm ilike $1 escape '\'` で引く
 */

/** 検索語の長さの上限（正規化後のコードポイント数） */
export const SEARCH_MAX_CODE_POINTS = 100;

/** ワーカーの `normalizeText` と同じ: NFKC → 空白（`\s`）を除く → ASCII の大文字を小文字に */
export function normalizeText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/\s/gu, "")
    .replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * 検索パラメータ `q` の検査。文字列でない（配列を含む）、正規化後に 1〜100 コードポイントでなければ null。
 * 返す値は正規化後の文字列（画面の入力欄と URL のリンクにもこの値を使う）
 */
export function parseSearchText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const norm = normalizeText(raw);
  const length = Array.from(norm).length;
  if (length < 1 || length > SEARCH_MAX_CODE_POINTS) return null;
  return norm;
}

/** `like` のワイルドカードとエスケープ文字（`\`、`%`、`_`）を `\` でエスケープする */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** `ilike` に渡す部分一致のパターン。`'%' + escaped + '%'` */
export function likePattern(norm: string): string {
  return `%${escapeLike(norm)}%`;
}
