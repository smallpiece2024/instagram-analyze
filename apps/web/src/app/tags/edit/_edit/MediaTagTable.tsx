/**
 * 投稿へのタグ付けのカード（R5 設計 6.2 節の 2）。Server Component。
 *
 * - 投稿の表（ストーリーズを除く、新しい順、1 ページ 50 件）。列はサムネイル、題名、投稿日、種類、軸ごとの `<select>`、保存
 * - 1 行 1 フォーム。表の中にフォームを入れられないので、保存のセルに `<form id>` を置き、`<select>` は `form` 属性で結び付ける
 * - 行の `key` に今のタグを含め、保存の後に描き直したとき選択の既定値が新しい値になるようにする
 * - 行の id は `m-{投稿の id}`（投稿詳細の「タグを編集」のリンクの行き先）
 * - 絞り込みは「この軸が未設定の投稿だけ」（`?missing={axis_id}`）
 */
import Link from "next/link";
import { Card } from "@/components/Card";
import { ChoiceChips } from "@/components/ChoiceChips";
import { buildHref } from "@/components/href";
import { Pager } from "@/components/Pager";
import { Thumb } from "@/components/Thumb";
import { TypeTag } from "@/components/TypeTag";
import { formatJst, mediaTitle } from "@/lib/format";
import { isMediaKind, type MediaKind } from "@/lib/metrics";
import type { TagAxisItem, TagMediaPage } from "@/lib/queries/tag-edit";
import { setMediaTags } from "../actions";
import { ActionForm, SubmitButton } from "./ActionForm";
import { TAG_MEDIA_PAGE_SIZE } from "./input";

const EDIT_PATH = "/tags/edit";

function kindOf(kind: string): MediaKind {
  return isMediaKind(kind) ? kind : "feed";
}

export function MediaTagTable({
  axes,
  data,
  missingAxisId,
}: {
  axes: readonly TagAxisItem[];
  data: TagMediaPage;
  /** 検査済みの `missing` */
  missingAxisId: string | undefined;
}) {
  const options = [
    { value: "", label: "すべて", href: EDIT_PATH },
    ...axes.map((a) => ({ value: a.id, label: `「${a.name}」が未設定`, href: buildHref(EDIT_PATH, { missing: a.id }) })),
  ];
  return (
    <Card title="投稿へのタグ付け" sub={`${data.total} 件`}>
      <div className="stack">
        <ChoiceChips label="絞り込み" options={options} current={missingAxisId ?? ""} />
        {data.items.length === 0 ? (
          <p className="small muted">該当する投稿はありません</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">
                    <span className="sr-only">サムネイル</span>
                  </th>
                  <th scope="col">投稿</th>
                  <th scope="col">投稿日</th>
                  <th scope="col">種類</th>
                  {axes.map((a) => (
                    <th key={a.id} scope="col">
                      {a.name}
                    </th>
                  ))}
                  <th scope="col">
                    <span className="sr-only">保存</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((m) => {
                  const kind = kindOf(m.kind);
                  const title = mediaTitle(m.caption);
                  const formId = `tag-form-${m.media_id}`;
                  const href = `/media/${m.media_id}`;
                  // key は投稿の id だけ。タグを含めると保存のたびに行が作り直され、「保存しました」の状態が消える
                  return (
                    <tr key={m.media_id} id={`m-${m.media_id}`} className={m.gone_at ? "dim" : undefined}>
                      <td>
                        <Link href={href} aria-label={title}>
                          <Thumb src={m.thumbnail_url} kind={kind} />
                        </Link>
                      </td>
                      <td className="title">
                        <Link href={href}>{title}</Link>
                      </td>
                      <td className="nowrap">{formatJst(m.posted_at)}</td>
                      <td>
                        <TypeTag kind={kind} />
                      </td>
                      {axes.map((a) => (
                        <td key={a.id}>
                          {/* 保存後のフォームのリセットは defaultValue に戻すが、select は defaultValue の変更を DOM に写さない。
                              保存済みの値を key に含め、値が変わったら select だけを作り直す（行を作り直すと「保存しました」が消える） */}
                          <select
                            key={m.tags[a.id] ?? ""}
                            className="input"
                            name={`axis_${a.id}`}
                            form={formId}
                            defaultValue={m.tags[a.id] ?? ""}
                            aria-label={`${title}の${a.name}`}
                          >
                            <option value="">なし</option>
                            {a.values.map((v) => (
                              <option key={v.id} value={v.id}>
                                {v.name}
                              </option>
                            ))}
                          </select>
                        </td>
                      ))}
                      <td>
                        <ActionForm action={setMediaTags} id={formId} label={`${title}のタグを保存`}>
                          <input type="hidden" name="media_id" value={m.media_id} />
                          <SubmitButton>保存</SubmitButton>
                        </ActionForm>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <Pager
          page={data.page}
          pageCount={data.pageCount}
          path={EDIT_PATH}
          query={{ missing: missingAxisId }}
          total={data.total}
          pageSize={TAG_MEDIA_PAGE_SIZE}
        />
      </div>
    </Card>
  );
}
