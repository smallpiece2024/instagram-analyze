/**
 * クエリ付きの URL を組み立てる（ページ送りと並べ替えの見出し）。画面の状態は URL のクエリに持つ（R3 設計 2.1 節）。
 * undefined と空文字のキーは出さない
 */
export type Query = Readonly<Record<string, string | number | undefined>>;

export function buildHref(path: string, query: Query, overrides: Query = {}): string {
  const params = new URLSearchParams();
  const merged = { ...query, ...overrides };
  for (const key of Object.keys(merged).sort()) {
    const v = merged[key];
    if (v === undefined || v === "") continue;
    params.set(key, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}
