/**
 * `GET /api/meta/callback`: Facebook Login の戻り先（設計 2.1 章、2.5 章）。
 *
 * - 本文全体を try/catch し、例外を投げず必ず `/connect?result=<理由コード>` へリダイレクトする
 * - `state` の Cookie は読んだら成否にかかわらず削除する（使い捨て）
 * - リダイレクト先は `APP_URL` を基点にする（`request.url` から組み立てない）。`APP_URL` が読めないときだけ相対の Location
 * - `code`、`state`、トークン、例外オブジェクトをログや応答に出さない
 */
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { markDynamic } from "@/lib/dynamic";
import { readEnv } from "@/lib/env";
import { handleCallback } from "@/lib/meta-connect";
import { STATE_COOKIE_NAME, stateCookieOptions, type ReasonCode } from "@/lib/meta-oauth";

/** `/connect?result=...` への 303。`state` の Cookie を消す `Set-Cookie` を必ず付ける */
function redirectToConnect(result: ReasonCode, appUrl: string | undefined): NextResponse {
  const path = `/connect?result=${result}`;
  const res = appUrl
    ? NextResponse.redirect(new URL(path, appUrl), 303)
    : new NextResponse(null, { status: 303, headers: { Location: path } });
  res.cookies.set(STATE_COOKIE_NAME, "", stateCookieOptions(appUrl, { clear: true }));
  return res;
}

function param(request: NextRequest, name: string): string | undefined {
  const value = request.nextUrl.searchParams.get(name);
  return value === null ? undefined : value;
}

export async function GET(request: NextRequest): Promise<Response> {
  let appUrl: string | undefined;
  try {
    await markDynamic();
    const envResult = readEnv();
    if (!envResult.ok) {
      console.warn(`[meta-connect] result=config_missing missing=${envResult.missing.join(",")}`);
      return redirectToConnect("config_missing", undefined);
    }
    const { env } = envResult;
    appUrl = env.appUrl;

    const input = {
      code: param(request, "code"),
      state: param(request, "state"),
      cookieState: request.cookies.get(STATE_COOKIE_NAME)?.value,
      error: param(request, "error"),
      errorReason: param(request, "error_reason"),
    };
    const outcome = await handleCallback(input, { fetch, db: getDb(env.databaseUrl), env });
    return redirectToConnect(outcome.result, appUrl);
  } catch {
    console.warn("[meta-connect] result=unknown route の例外");
    return redirectToConnect("unknown", appUrl);
  }
}
