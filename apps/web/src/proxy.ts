/**
 * `Host` ヘッダの検査（設計 3 章。DNS リバインディング対策）。
 * `APP_URL` のホストと、ローカルの既定（`127.0.0.1:3000`、`[::1]:3000`、`localhost:3000`）以外は 403。
 *
 * `readEnv()` は `server-only` で Proxy からは使えないため、ここだけ `process.env.APP_URL` を直接読む（設計 1.2 章の例外）。
 * LAN の攻撃者には効かないので、`package.json` の `-H 127.0.0.1` の代わりにはならない。
 */
import { NextResponse, type NextRequest } from "next/server";
import { isAllowedHost } from "@/lib/request-guard";

export function proxy(request: NextRequest): NextResponse {
  if (!isAllowedHost(request.headers.get("host"), process.env.APP_URL)) {
    return new NextResponse("Forbidden", { status: 403 });
  }
  return NextResponse.next();
}

/** 静的資産以外のすべての要求に適用する（ルートを足したときに漏れないよう、列挙しない） */
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
