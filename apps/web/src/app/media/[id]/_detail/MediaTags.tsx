/**
 * 投稿詳細のタグの表示（R5 設計 6.2 節「投稿詳細の変更」）。見出しの下に「軸: 値」のチップを軸の並び順で並べ、
 * 右に「タグを編集」（編集画面のこの投稿の行へのリンク。`/tags/edit?page=n#m-{id}`）。タグがなければリンクだけ。
 * 名前は JSX の子としてだけ出す（S11）
 */
import Link from "next/link";
import { buildHref } from "@/components/href";
import { TAG_MEDIA_PAGE_SIZE } from "@/app/tags/edit/_edit/input";
import { getMediaTagSummary } from "@/lib/queries/tag-edit";

/** 編集画面の表での位置（前にある投稿の数）からリンクを作る。1 ページ目には `page` を付けない */
export function tagEditHref(mediaId: string, position: number): string {
  const page = Math.floor(Math.max(0, position) / TAG_MEDIA_PAGE_SIZE) + 1;
  return `${buildHref("/tags/edit", { page: page > 1 ? page : undefined })}#m-${mediaId}`;
}

export async function MediaTags({ accountId, mediaId }: { accountId: string; mediaId: string }) {
  const result = await getMediaTagSummary(accountId, mediaId);
  if (!result.ok) {
    return (
      <p className="small muted">
        タグを読み出せません（{result.reason}）。<Link href="/tags/edit">タグを編集</Link>
      </p>
    );
  }
  const { tags, position } = result.data;
  return (
    <div className="field-row" style={{ justifyContent: "space-between" }}>
      <ul className="chips" aria-label="タグ" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {tags.map((t) => (
          <li key={t.axis_name} className="tag tag--special">
            {t.axis_name}: {t.value_name}
          </li>
        ))}
      </ul>
      <Link className="small" href={tagEditHref(mediaId, position)}>
        タグを編集
      </Link>
    </div>
  );
}
