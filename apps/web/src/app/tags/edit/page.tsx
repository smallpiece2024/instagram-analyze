/**
 * タグの編集（`/tags/edit`。R5 設計 6.2 節）。
 *
 * - 軸と値の管理（`AxesCard`）と、投稿へのタグ付けの表（`MediaTagTable`。軸が 0 件のときは出さない。確認事項 Q15）
 * - クエリ `page`、`missing`、`confirm_delete` を検査し、不正なら既定に戻す（`missing` と `confirm_delete` は
 *   対象のアカウントのいまある軸の id のときだけ有効。T12）
 * - 書き込みは `actions.ts` の Server Action。応答は `Cache-Control: private, no-store`（`next.config.ts`。S12）
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { Callout } from "@/components/Callout";
import { Card } from "@/components/Card";
import { PageHead } from "@/components/PageHead";
import { parseAxisId, parsePageNumber } from "@/lib/params";
import { getTargetAccount, TARGET_ACCOUNT_NOT_SET } from "@/lib/queries/account";
import { getTagEditor, getTagMediaPage } from "@/lib/queries/tag-edit";
import { AxesCard } from "./_edit/AxesCard";
import { TAG_MEDIA_PAGE_SIZE } from "./_edit/input";
import { MediaTagTable } from "./_edit/MediaTagTable";

const TITLE = "タグの編集";

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="main main--wide stack">
      <PageHead title={TITLE} tools={<Link href="/tags">タグ分析へ</Link>} />
      {children}
    </main>
  );
}

export default async function TagEditPage(props: PageProps<"/tags/edit">) {
  const sp = await props.searchParams;
  const page = parsePageNumber(sp.page);

  const account = await getTargetAccount();
  if (!account.ok) {
    return (
      <Shell>
        {account.reason === TARGET_ACCOUNT_NOT_SET ? (
          <Callout state="warn">
            {TARGET_ACCOUNT_NOT_SET}。<Link href="/connect">接続設定</Link>
          </Callout>
        ) : (
          <Callout state="bad">読み出せません（{account.reason}）</Callout>
        )}
      </Shell>
    );
  }
  const accountId = account.data.id;

  const editor = await getTagEditor(accountId);
  if (!editor.ok) {
    return (
      <Shell>
        <Card>
          <Callout state="bad">読み出せません（{editor.reason}）</Callout>
        </Card>
      </Shell>
    );
  }
  const axes = editor.data;
  const axisIds = axes.map((a) => a.id);
  const missingAxisId = parseAxisId(sp.missing, axisIds);
  const confirmAxisId = parseAxisId(sp.confirm_delete, axisIds);
  // 確認の表示を閉じたとき、軸を消したあとに残すクエリ（既定の値は URL に出さない）
  const query = { page: page > 1 ? page : undefined, missing: missingAxisId };

  if (axes.length === 0) {
    return (
      <Shell>
        <AxesCard axes={axes} confirmAxisId={undefined} query={query} />
      </Shell>
    );
  }

  const media = await getTagMediaPage(accountId, { page, pageSize: TAG_MEDIA_PAGE_SIZE, missingAxisId });
  return (
    <Shell>
      <AxesCard axes={axes} confirmAxisId={confirmAxisId} query={query} />
      {media.ok ? (
        <MediaTagTable axes={axes} data={media.data} missingAxisId={missingAxisId} />
      ) : (
        <Card title="投稿へのタグ付け">
          <Callout state="bad">読み出せません（{media.reason}）</Callout>
        </Card>
      )}
    </Shell>
  );
}
