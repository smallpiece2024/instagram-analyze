/**
 * 日次指標の CSV（`GET /export/daily`。R3 設計 7 章）。
 *
 * - クエリ `from`／`to` は太平洋時間の日付。両方とも省略なら全期間。片方だけ、または不正なら 400 と固定の文言（4.7 節）
 * - 認可: proxy に加えて、先頭で `checkAccess` を呼ぶ。未ログインは 401、許可外は 403（7.1 節）
 * - 対象のアカウントが決まらなければ 409、DB の失敗は 500。どちらも固定の文言だけを返し、DB のエラー文を出さない
 * - ログには名前と SQLSTATE だけを書く（4.7 節）
 * - 数百行なので全部を文字列にしてから返す（ストリームにしない）
 */
import type { NextRequest } from "next/server";
import { checkAccess } from "@/lib/auth";
import { csvFileName, DAILY_CSV_COLUMNS, toCsv } from "@/lib/csv";
import { parseCsvDateRange } from "@/lib/params";
import { getTargetAccount, TARGET_ACCOUNT_NOT_SET } from "@/lib/queries/account";
import { DailyCsvError, listDailyCsvRows } from "@/lib/queries/compare";

const CSV_FAILED = "CSV を作れませんでした";

const TEXT_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

function textResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: TEXT_HEADERS });
}

export async function GET(request: NextRequest): Promise<Response> {
  const access = await checkAccess(request.nextUrl.pathname);
  if (access === "login") return textResponse(401, "ログインしてください");
  if (access === "forbid") return textResponse(403, "このページを開く権限がありません");

  const params = request.nextUrl.searchParams;
  const from = params.getAll("from");
  const to = params.getAll("to");
  const range = parseCsvDateRange(
    from.length === 0 ? undefined : from.length === 1 ? from[0] : from,
    to.length === 0 ? undefined : to.length === 1 ? to[0] : to,
  );
  if (range.kind === "invalid") return textResponse(400, "期間の指定が正しくありません");

  const account = await getTargetAccount();
  if (!account.ok) {
    // 未設定と一致なしは 409。環境変数の不足や DB の失敗は 500（理由の文はログにも応答にも出さない）
    if (account.reason === TARGET_ACCOUNT_NOT_SET) {
      console.warn("[export-daily] result=no_target_account");
      return textResponse(409, TARGET_ACCOUNT_NOT_SET);
    }
    console.warn("[export-daily] result=account_error");
    return textResponse(500, CSV_FAILED);
  }

  try {
    const rows = await listDailyCsvRows(account.data.id, range.kind === "range" ? range.period : null);
    const body = toCsv(DAILY_CSV_COLUMNS, rows);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${csvFileName("daily", new Date())}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    const code = e instanceof DailyCsvError ? e.code : "unknown";
    console.warn(`[export-daily] result=db_error code=${code}`);
    return textResponse(500, CSV_FAILED);
  }
}
