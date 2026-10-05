/**
 * `GET /export/media`: 投稿の CSV（R3 設計 7 章、F-UI-27）。
 *
 * - 投稿一覧の全件（ページで切らない）。並びは一覧と同じ `sort`、`order`（4.7 節の検査。外れたら既定）
 * - 認可は proxy が通すが、ここでも `checkAccess` を呼ぶ。未ログインは 401、許可外は 403
 * - 対象のアカウントが決まらなければ 409、DB の失敗は 500。どちらも固定の文言だけを返し、DB のエラー文を出さない
 * - ログにはクエリの名前と固定の理由（SQLSTATE を含む）だけを書く。キャプション、ID、SQL は書かない
 * - Route Handler はキャッシュされない（Next.js 16「Route Handlers」の「Caching」）。`markDynamic` で明示もする
 */
import type { NextRequest } from "next/server";
import { checkAccess } from "@/lib/auth";
import { csvFileName, MEDIA_CSV_COLUMNS, toCsv } from "@/lib/csv";
import { markDynamic } from "@/lib/dynamic";
import { DEFAULT_SORT, parseOrder, parseSort, type ParamValue } from "@/lib/params";
import { getTargetAccount, TARGET_ACCOUNT_NOT_SET } from "@/lib/queries/account";
import { listMediaCsvRows, MEDIA_SORT_KEYS } from "@/lib/queries/media";

/** 失敗の固定の文言（route.ts は HTTP メソッドと設定以外を export しない） */
const CSV_FAILED_TEXT = "CSV を作れませんでした";

function textResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** クエリの 1 つの値。同じキーが 2 回以上あれば配列（不正として既定に戻る） */
function param(request: NextRequest, name: string): ParamValue {
  const all = request.nextUrl.searchParams.getAll(name);
  if (all.length === 0) return undefined;
  return all.length === 1 ? all[0] : all;
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    await markDynamic();
    const access = await checkAccess(request.nextUrl.pathname);
    if (access === "login") return textResponse(401, "Unauthorized");
    if (access === "forbid") return textResponse(403, "Forbidden");

    const account = await getTargetAccount();
    if (!account.ok) {
      if (account.reason === TARGET_ACCOUNT_NOT_SET) return textResponse(409, TARGET_ACCOUNT_NOT_SET);
      console.error(`[export-media] query=getTargetAccount ${account.reason}`);
      return textResponse(500, CSV_FAILED_TEXT);
    }

    const sort = parseSort(param(request, "sort"), MEDIA_SORT_KEYS, DEFAULT_SORT);
    const order = parseOrder(param(request, "order"));
    const rows = await listMediaCsvRows(account.data.id, { sort, order });
    if (!rows.ok) {
      console.error(`[export-media] query=listMediaCsvRows ${rows.reason}`);
      return textResponse(500, CSV_FAILED_TEXT);
    }

    return new Response(toCsv(MEDIA_CSV_COLUMNS, rows.data), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${csvFileName("media", new Date())}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    // 例外の文面は出さない
    console.error("[export-media] result=unknown 例外");
    return textResponse(500, CSV_FAILED_TEXT);
  }
}
