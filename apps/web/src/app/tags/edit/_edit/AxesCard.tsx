/**
 * 軸と値の管理のカード（R5 設計 6.2 節の 1 と 3）。Server Component。フォームは `ActionForm`（Client）に子として渡す。
 *
 * - 軸ごとに名前、タグ付きの件数、値の一覧（名前と使っている件数）。操作は足す、名前を変える、消す、上へ、下へ
 * - 先頭の「上へ」と末尾の「下へ」は出さない（T11）。値の「消す」は使っている件数が 0 のときだけ出す
 * - 軸の「消す」はリンク（`?confirm_delete={id}`）で確認の表示に移り、そこのフォームだけが削除の Action を呼ぶ（S10）
 * - 軸が 0 件なら、要件の例を文字で示し、軸を足すフォームだけを出す（確認事項 Q15）
 * - 利用者の文字（軸と値の名前）は JSX の子と属性としてだけ出す（S11）
 */
import Link from "next/link";
import { Callout } from "@/components/Callout";
import { Card } from "@/components/Card";
import { buildHref, type Query } from "@/components/href";
import type { TagAxisItem } from "@/lib/queries/tag-edit";
import { createAxis, createValue, deleteAxis, deleteValue, moveAxis, moveValue, renameAxis, renameValue } from "../actions";
import { ActionForm, SubmitButton } from "./ActionForm";
import { MAX_AXES, MAX_VALUES_PER_AXIS } from "./input";

const EDIT_PATH = "/tags/edit";

function MoveButtons({
  kind,
  id,
  name,
  first,
  last,
}: {
  kind: "axis" | "value";
  id: string;
  name: string;
  first: boolean;
  last: boolean;
}) {
  const action = kind === "axis" ? moveAxis : moveValue;
  const idName = kind === "axis" ? "axis_id" : "value_id";
  return (
    <>
      {!first && (
        <ActionForm action={action} label={`${name}を上へ`}>
          <input type="hidden" name={idName} value={id} />
          <input type="hidden" name="direction" value="up" />
          <SubmitButton ghost ariaLabel={`${name}を上へ`}>
            上へ
          </SubmitButton>
        </ActionForm>
      )}
      {!last && (
        <ActionForm action={action} label={`${name}を下へ`}>
          <input type="hidden" name={idName} value={id} />
          <input type="hidden" name="direction" value="down" />
          <SubmitButton ghost ariaLabel={`${name}を下へ`}>
            下へ
          </SubmitButton>
        </ActionForm>
      )}
    </>
  );
}

function ConfirmDelete({ axis, cancelHref }: { axis: TagAxisItem; cancelHref: string }) {
  return (
    <Callout state="warn">
      <p>
        「{axis.name}」の軸と値 {axis.values.length} 個、付いているタグ {axis.tagged_count} 件が消えます。
      </p>
      <ActionForm action={deleteAxis} label={`${axis.name}を消す`}>
        <input type="hidden" name="axis_id" value={axis.id} />
        <input type="hidden" name="confirm" value="delete" />
        <SubmitButton>消す</SubmitButton>
        <Link href={cancelHref}>やめる</Link>
      </ActionForm>
    </Callout>
  );
}

function ValueTable({ axis }: { axis: TagAxisItem }) {
  if (axis.values.length === 0) return null;
  const last = axis.values.length - 1;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">値</th>
            <th scope="col" className="num">
              件数
            </th>
            <th scope="col">名前の変更</th>
            <th scope="col">並び</th>
            <th scope="col">
              <span className="sr-only">消す</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {axis.values.map((v, i) => (
            <tr key={v.id}>
              <th scope="row" className="row-head">
                {v.name}
              </th>
              <td className="num">{v.media_count}</td>
              <td>
                <ActionForm key={`${v.id}:${v.name}`} action={renameValue} label={`${v.name}の名前を変える`}>
                  <input type="hidden" name="value_id" value={v.id} />
                  <input className="input" name="name" defaultValue={v.name} required aria-label={`${v.name}の新しい名前`} />
                  <SubmitButton ghost>変える</SubmitButton>
                </ActionForm>
              </td>
              <td>
                <div className="field-row">
                  <MoveButtons kind="value" id={v.id} name={v.name} first={i === 0} last={i === last} />
                </div>
              </td>
              <td>
                {v.media_count === 0 && (
                  <ActionForm action={deleteValue} label={`${v.name}を消す`}>
                    <input type="hidden" name="value_id" value={v.id} />
                    <SubmitButton ghost ariaLabel={`${v.name}を消す`}>
                      消す
                    </SubmitButton>
                  </ActionForm>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AxisBlock({
  axis,
  first,
  last,
  query,
}: {
  axis: TagAxisItem;
  first: boolean;
  last: boolean;
  query: Query;
}) {
  return (
    <section className="stack" style={{ borderTop: "var(--table-rule)", paddingTop: 12 }} aria-label={axis.name}>
      <div className="field-row">
        <h3 style={{ margin: 0 }}>{axis.name}</h3>
        <span className="small muted">
          値 {axis.values.length} 個・タグ付き {axis.tagged_count} 件
        </span>
        <MoveButtons kind="axis" id={axis.id} name={axis.name} first={first} last={last} />
        <Link className="small" href={buildHref(EDIT_PATH, query, { confirm_delete: axis.id })}>
          軸を消す
        </Link>
      </div>
      <ActionForm key={`${axis.id}:${axis.name}`} action={renameAxis} label={`${axis.name}の名前を変える`}>
        <input type="hidden" name="axis_id" value={axis.id} />
        <input className="input" name="name" defaultValue={axis.name} required aria-label={`${axis.name}の新しい名前`} />
        <SubmitButton ghost>軸の名前を変える</SubmitButton>
      </ActionForm>
      <ValueTable axis={axis} />
      {axis.values.length < MAX_VALUES_PER_AXIS ? (
        <ActionForm action={createValue} label={`${axis.name}に値を足す`}>
          <input type="hidden" name="axis_id" value={axis.id} />
          <input className="input" name="name" required placeholder="値の名前" aria-label={`${axis.name}に足す値の名前`} />
          <SubmitButton ghost>値を足す</SubmitButton>
        </ActionForm>
      ) : (
        <p className="small muted">値は 1 つの軸に {MAX_VALUES_PER_AXIS} 個までです</p>
      )}
    </section>
  );
}

export function AxesCard({
  axes,
  confirmAxisId,
  query,
}: {
  axes: readonly TagAxisItem[];
  /** 検査済みの `confirm_delete`（対象のアカウントの、いまある軸の id）。なければ undefined */
  confirmAxisId: string | undefined;
  /** 確認の表示を閉じたときに残すクエリ（`page`、`missing`） */
  query: Query;
}) {
  const confirmAxis = confirmAxisId === undefined ? undefined : axes.find((a) => a.id === confirmAxisId);
  const lastIndex = axes.length - 1;
  return (
    <Card title="軸と値" sub={`軸 ${axes.length} 個（${MAX_AXES} 個まで）`}>
      <div className="stack">
        {confirmAxis && <ConfirmDelete axis={confirmAxis} cancelHref={buildHref(EDIT_PATH, query)} />}
        {axes.length === 0 && <p className="small muted">軸の例: テーマ、目的、CTA、キャンペーン</p>}
        {axes.map((a, i) => (
          <AxisBlock key={a.id} axis={a} first={i === 0} last={i === lastIndex} query={query} />
        ))}
        {axes.length < MAX_AXES ? (
          <ActionForm action={createAxis} label="軸を足す">
            <input className="input" name="name" required placeholder="軸の名前" aria-label="足す軸の名前" />
            <SubmitButton>軸を足す</SubmitButton>
          </ActionForm>
        ) : (
          <p className="small muted">軸は {MAX_AXES} 個までです</p>
        )}
      </div>
    </Card>
  );
}
