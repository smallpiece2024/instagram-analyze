/**
 * `jobs/account-backfill.ts` の純粋関数の単体テスト（設計 9.1 章の `nextBackfillWindow` の行）。
 * ジョブ本体は `test/db/account-daily.test.ts` の結合テストで動かす
 */
import { describe, expect, it } from "vitest";
import {
  advanceBackfillState,
  applyHistoryDays,
  BACKFILL_HISTORY_DAYS,
  BACKFILL_MAX_ATTEMPTS,
  BACKFILL_WARN_AFTER_DAYS,
  finishByHistoryLimit,
  initialBackfillState,
  isHistoryLimitError,
  job,
  nextBackfillWindow,
  type BackfillState,
} from "../src/jobs/account-backfill.js";
import { addDays } from "../src/lib/time.js";

const TODAY = "2026-10-01";
const OLDEST = "2024-10-01"; // 2026-10-01 − 730 日

function state(patch: Partial<BackfillState> = {}): BackfillState {
  return { next_date: "2026-09-30", oldest_date: OLDEST, done: false, days_done: 0, failed_dates: [], ...patch };
}

describe("account_backfill の定数", () => {
  it("job の名前と shouldRun、2 年の下限、warn の境界、試行回数", () => {
    expect(job.name).toBe("account_backfill");
    expect(job.shouldRun).toBeTypeOf("function");
    expect(BACKFILL_HISTORY_DAYS).toBe(730);
    expect(BACKFILL_WARN_AFTER_DAYS).toBe(700);
    expect(BACKFILL_MAX_ATTEMPTS).toBe(3);
    expect(isHistoryLimitError({ message: "available for the last 2 years", code: 100 })).toBe(true);
  });
});

/** 2026-10-01 − 400 日 */
const OLDEST_400 = "2025-08-27";

describe("initialBackfillState", () => {
  it("next_date は D−1、oldest_date は D−730（historyDays を渡せばその日数）", () => {
    expect(initialBackfillState(TODAY)).toEqual({ next_date: "2026-09-30", oldest_date: OLDEST, done: false, days_done: 0, failed_dates: [] });
    expect(addDays(TODAY, -BACKFILL_HISTORY_DAYS)).toBe(OLDEST);
    expect(initialBackfillState(TODAY, 400).oldest_date).toBe(OLDEST_400);
    expect(addDays(TODAY, -400)).toBe(OLDEST_400);
  });
});

describe("applyHistoryDays", () => {
  it("保存済みの oldest_date と「今日 − historyDays」の遅い方。変わらなければ同じオブジェクト", () => {
    const stored = state({ next_date: "2025-09-15", days_done: 380 });
    const shrunk = applyHistoryDays(stored, TODAY, 400);
    expect(shrunk).toEqual(state({ next_date: "2025-09-15", days_done: 380, oldest_date: OLDEST_400 }));
    expect(stored.oldest_date).toBe(OLDEST);
    // 730 に戻しても過去には広がらない
    expect(applyHistoryDays(shrunk, TODAY, 730)).toBe(shrunk);
    expect(applyHistoryDays(stored, TODAY, 730)).toBe(stored);
    // 2 年のエラーで確定した下限（新しい日）はそのまま
    const fixed = state({ oldest_date: "2026-01-01" });
    expect(applyHistoryDays(fixed, TODAY, 400)).toBe(fixed);
  });
});

describe("nextBackfillWindow", () => {
  it("初回（state なし）は D−1 から過去へ maxDays 日。state は初期値", () => {
    const w = nextBackfillWindow(undefined, TODAY, 30);
    expect(w.dates).toHaveLength(30);
    expect(w.dates[0]).toBe("2026-09-30");
    expect(w.dates.at(-1)).toBe("2026-09-01");
    expect(w.retry).toBe(false);
    expect(w.state).toEqual(initialBackfillState(TODAY));
  });

  it("途中からの続き: next_date から過去へ maxDays 日。state は渡したもの", () => {
    const s = state({ next_date: "2026-09-15", days_done: 15 });
    const w = nextBackfillWindow(s, TODAY, 5);
    expect(w.dates).toEqual(["2026-09-15", "2026-09-14", "2026-09-13", "2026-09-12", "2026-09-11"]);
    expect(w.retry).toBe(false);
    expect(w.state).toBe(s);
  });

  it("oldest_date で止まる（oldest_date 自身は含む）", () => {
    const w = nextBackfillWindow(state({ next_date: "2024-10-03" }), TODAY, 30);
    expect(w.dates).toEqual(["2024-10-03", "2024-10-02", "2024-10-01"]);
    expect(w.retry).toBe(false);
  });

  it("通常の日を終えていれば failed_dates の attempts < 3 を最大 maxDays 件（retry: true）", () => {
    const s = state({
      next_date: "2024-09-30",
      days_done: 730,
      failed_dates: [
        { date: "2026-09-10", attempts: 1 },
        { date: "2026-08-01", attempts: 3 },
        { date: "2025-01-01", attempts: 2 },
      ],
    });
    expect(nextBackfillWindow(s, TODAY, 30)).toEqual({ dates: ["2026-09-10", "2025-01-01"], retry: true, state: s });
    expect(nextBackfillWindow(s, TODAY, 1)).toEqual({ dates: ["2026-09-10"], retry: true, state: s });
  });

  it("通常の日を終えて取り直せる日がなければ dates: []（retry: false）。done なら常に []", () => {
    expect(nextBackfillWindow(state({ next_date: "2024-09-30" }), TODAY, 30)).toEqual({ dates: [], retry: false, state: expect.anything() });
    expect(
      nextBackfillWindow(state({ next_date: "2024-09-30", failed_dates: [{ date: "2026-01-01", attempts: 3 }] }), TODAY, 30).dates,
    ).toEqual([]);
    expect(nextBackfillWindow(state({ done: true }), TODAY, 30).dates).toEqual([]);
    expect(nextBackfillWindow(state({ done: true, failed_dates: [{ date: "2026-01-01", attempts: 1 }] }), TODAY, 30).dates).toEqual([]);
  });

  it("historyDays を渡すと保存済みの oldest_date（730 日前）が縮む。next_date がそれより古ければ dates: []（done 判定へ）", () => {
    // 進行中: 2025-09-15 から 30 日取りたいが、400 日前（2025-08-27）で止まる
    const s = state({ next_date: "2025-09-15", days_done: 380 });
    const w = nextBackfillWindow(s, TODAY, 30, 400);
    expect(w.state).toEqual(state({ next_date: "2025-09-15", days_done: 380, oldest_date: OLDEST_400 }));
    expect(w.dates).toHaveLength(20);
    expect(w.dates[0]).toBe("2025-09-15");
    expect(w.dates.at(-1)).toBe(OLDEST_400);
    expect(w.retry).toBe(false);

    // next_date が新しい下限より古い → 通常の日は終わった扱い。取り直す日がなければ空（run が done にする）
    const past = state({ next_date: "2025-01-01", days_done: 600 });
    expect(nextBackfillWindow(past, TODAY, 30, 400)).toEqual({ dates: [], retry: false, state: { ...past, oldest_date: OLDEST_400 } });
    // 取り直す日があれば retry の回
    const withFailed = state({ next_date: "2025-01-01", days_done: 600, failed_dates: [{ date: "2026-09-10", attempts: 1 }] });
    expect(nextBackfillWindow(withFailed, TODAY, 30, 400)).toEqual({ dates: ["2026-09-10"], retry: true, state: { ...withFailed, oldest_date: OLDEST_400 } });

    // 初回も historyDays が効く
    const first = nextBackfillWindow(undefined, TODAY, 30, 400);
    expect(first.state.oldest_date).toBe(OLDEST_400);
    expect(first.dates).toHaveLength(30);

    // 730 のまま（省略）なら従来どおり
    expect(nextBackfillWindow(s, TODAY, 30).state).toBe(s);
    expect(nextBackfillWindow(s, TODAY, 30).dates).toHaveLength(30);
  });

  it("maxDays が 0 以下なら dates: []", () => {
    expect(nextBackfillWindow(state(), TODAY, 0).dates).toEqual([]);
    expect(nextBackfillWindow(state(), TODAY, -5).dates).toEqual([]);
  });
});

describe("advanceBackfillState", () => {
  it("通常の回の成功: next_date が 1 日戻り、days_done が増える。入力は変更しない", () => {
    const s = state();
    const next = advanceBackfillState(s, "2026-09-30", false, false);
    expect(next).toEqual(state({ next_date: "2026-09-29", days_done: 1 }));
    expect(s).toEqual(state());
  });

  it("通常の回の失敗: failed_dates に attempts 1 で加わり、既にあれば attempts が増える", () => {
    const first = advanceBackfillState(state(), "2026-09-30", true, false);
    expect(first.failed_dates).toEqual([{ date: "2026-09-30", attempts: 1 }]);
    expect(first.next_date).toBe("2026-09-29");
    expect(first.days_done).toBe(1);

    const again = advanceBackfillState(state({ failed_dates: [{ date: "2026-09-30", attempts: 1 }] }), "2026-09-30", true, false);
    expect(again.failed_dates).toEqual([{ date: "2026-09-30", attempts: 2 }]);
  });

  it("oldest_date を終えたら、取り直せる日がなければ done。あれば done にしない", () => {
    const clean = advanceBackfillState(state({ next_date: OLDEST, days_done: 729 }), OLDEST, false, false);
    expect(clean).toEqual(state({ next_date: "2024-09-30", days_done: 730, done: true }));

    const withRetry = advanceBackfillState(state({ next_date: OLDEST, failed_dates: [{ date: "2026-09-10", attempts: 1 }] }), OLDEST, false, false);
    expect(withRetry.done).toBe(false);

    const lastFailed = advanceBackfillState(state({ next_date: OLDEST }), OLDEST, true, false);
    expect(lastFailed.done).toBe(false);
    expect(lastFailed.failed_dates).toEqual([{ date: OLDEST, attempts: 1 }]);

    const exhausted = advanceBackfillState(state({ next_date: OLDEST, failed_dates: [{ date: "2026-09-10", attempts: 3 }] }), OLDEST, false, false);
    expect(exhausted.done).toBe(true);
  });

  it("取り直しの回: 成功なら failed_dates から消え、失敗なら attempts が増える。next_date と days_done は変わらない", () => {
    const s = state({
      next_date: "2024-09-30",
      days_done: 730,
      failed_dates: [
        { date: "2026-09-10", attempts: 2 },
        { date: "2025-01-01", attempts: 1 },
      ],
    });
    const ok = advanceBackfillState(s, "2025-01-01", false, true);
    expect(ok.failed_dates).toEqual([{ date: "2026-09-10", attempts: 2 }]);
    expect(ok.next_date).toBe("2024-09-30");
    expect(ok.days_done).toBe(730);
    expect(ok.done).toBe(false);

    const ng = advanceBackfillState(ok, "2026-09-10", true, true);
    expect(ng.failed_dates).toEqual([{ date: "2026-09-10", attempts: 3 }]);
    // 3 回失敗した日だけが残り、取り直せる日がない → done。日は残る
    expect(ng.done).toBe(true);

    const allOk = advanceBackfillState(ok, "2026-09-10", false, true);
    expect(allOk).toEqual(state({ next_date: "2024-09-30", days_done: 730, done: true }));
  });

  it("通常の回で失敗した日を取り直しで消すと、通常の日を終えていれば done", () => {
    const s = state({ next_date: "2024-09-30", days_done: 730, failed_dates: [{ date: "2026-09-10", attempts: 1 }] });
    expect(advanceBackfillState(s, "2026-09-10", false, true)).toEqual(state({ next_date: "2024-09-30", days_done: 730, done: true }));
  });

  it("取り直しの回で失敗しても attempts < 3 の日が残れば done にしない", () => {
    const s = state({
      next_date: "2024-09-30",
      days_done: 730,
      failed_dates: [
        { date: "2026-09-10", attempts: 1 },
        { date: "2025-01-01", attempts: 1 },
      ],
    });
    const ng = advanceBackfillState(s, "2026-09-10", true, true);
    expect(ng.failed_dates).toEqual([
      { date: "2026-09-10", attempts: 2 },
      { date: "2025-01-01", attempts: 1 },
    ]);
    expect(ng.done).toBe(false);
  });
});

describe("finishByHistoryLimit", () => {
  it("取り直せる失敗日が残っていなければ done。oldest_date は date + 1、next_date は date（通常の日は終わった扱い）。入力は変更しない", () => {
    const s = state({ next_date: "2024-10-15", days_done: 350 });
    const next = finishByHistoryLimit(s, "2024-10-15");
    expect(next).toEqual(state({ next_date: "2024-10-15", oldest_date: "2024-10-16", days_done: 350, done: true }));
    expect(s).toEqual(state({ next_date: "2024-10-15", days_done: 350 }));
    // 次の窓は通常の日を終えた扱い（取り直しの回）で、何も残っていなければ空
    expect(nextBackfillWindow(next, TODAY, 30).dates).toEqual([]);
  });

  it("date より新しい失敗日が attempts < 3 で残っていれば done にしない（次回に取り直す）", () => {
    const s = state({
      next_date: "2024-10-15",
      days_done: 350,
      failed_dates: [
        { date: "2026-09-10", attempts: 1 },
        { date: "2025-01-01", attempts: 2 },
      ],
    });
    const next = finishByHistoryLimit(s, "2024-10-15");
    expect(next.done).toBe(false);
    expect(next.failed_dates).toEqual(s.failed_dates);
    expect(next.oldest_date).toBe("2024-10-16");
    expect(nextBackfillWindow(next, TODAY, 30)).toEqual({ dates: ["2026-09-10", "2025-01-01"], retry: true, state: next });
  });

  it("date 以前の失敗日（date 自身を含む）は除かれる。残った失敗日がすべて attempts >= 3 なら done", () => {
    const s = state({
      next_date: "2024-10-15",
      failed_dates: [
        { date: "2026-09-10", attempts: 3 },
        { date: "2024-10-15", attempts: 1 },
        { date: "2024-10-14", attempts: 1 },
        { date: "2024-01-01", attempts: 2 },
      ],
    });
    const next = finishByHistoryLimit(s, "2024-10-15");
    expect(next.failed_dates).toEqual([{ date: "2026-09-10", attempts: 3 }]);
    expect(next.done).toBe(true);

    const mixed = finishByHistoryLimit(
      state({ failed_dates: [{ date: "2026-09-10", attempts: 3 }, { date: "2026-09-11", attempts: 2 }, { date: "2024-10-15", attempts: 1 }] }),
      "2024-10-15",
    );
    expect(mixed.failed_dates).toEqual([
      { date: "2026-09-10", attempts: 3 },
      { date: "2026-09-11", attempts: 2 },
    ]);
    expect(mixed.done).toBe(false);
  });

  it("取り直しの回に 2 年のエラーが返っても同じ: next_date と oldest_date が date 基準になり、古い失敗日が消える", () => {
    const s = state({
      next_date: "2024-09-30",
      days_done: 730,
      failed_dates: [
        { date: "2024-10-05", attempts: 1 },
        { date: "2024-10-01", attempts: 2 },
        { date: "2026-01-01", attempts: 1 },
      ],
    });
    const next = finishByHistoryLimit(s, "2024-10-05");
    expect(next).toEqual(
      state({ next_date: "2024-10-05", oldest_date: "2024-10-06", days_done: 730, failed_dates: [{ date: "2026-01-01", attempts: 1 }] }),
    );
  });
});
