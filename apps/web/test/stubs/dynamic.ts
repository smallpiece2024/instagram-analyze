// `@/lib/dynamic` の vitest 用スタブ。`connection()` は Next.js のリクエスト外では例外になるので、テストでは何もしない
export async function markDynamic(): Promise<void> {}
