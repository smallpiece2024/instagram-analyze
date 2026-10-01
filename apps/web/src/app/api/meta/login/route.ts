/**
 * `POST /api/meta/login`: Facebook Login の開始（設計 2.1 章）。GET は export しない（405）。
 *
 * - `Sec-Fetch-Site`／`Origin` で同じオリジンからのフォーム送信だけを受け付ける（403）
 * - `state` を httpOnly の Cookie（`path=/api/meta`、10 分）に入れ、認可 URL へ 303 でリダイレクトする
 *   （`redirect()` は 307 で POST が再送されるため使わない）
 * - 環境変数が足りなければ `/connect?result=config_missing` へ（`APP_URL` 自体が欠けうるので相対の Location）
 */
import { NextResponse, type NextRequest } from "next/server";
import { markDynamic } from "@/lib/dynamic";
import { readEnv } from "@/lib/env";
import { startLogin } from "@/lib/meta-connect";
import { STATE_COOKIE_NAME, stateCookieOptions } from "@/lib/meta-oauth";
import { isSameOriginPost } from "@/lib/request-guard";

export async function POST(request: NextRequest): Promise<Response> {
  await markDynamic();
  const envResult = readEnv();
  if (!envResult.ok) {
    console.warn(`[meta-connect] result=config_missing missing=${envResult.missing.join(",")}`);
    return new NextResponse(null, { status: 303, headers: { Location: "/connect?result=config_missing" } });
  }
  const { env } = envResult;

  const headers = { secFetchSite: request.headers.get("sec-fetch-site"), origin: request.headers.get("origin") };
  if (!isSameOriginPost(headers, env.appUrl)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const { url, state } = startLogin({ env });
  const res = NextResponse.redirect(url, 303);
  res.cookies.set(STATE_COOKIE_NAME, state, stateCookieOptions(env.appUrl));
  return res;
}
