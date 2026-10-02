/**
 * `commands/check-alerts.ts` の結合テスト（R2 設計 10.1 章）。本物の DB（ローカル Supabase）で、架空のアカウントを
 * 作って `runCheckAlerts` を動かす。常駐のワーカーが同じ DB で動いているので、DB の行は `status = 'paused'` にし、
 * `deps.listAccounts` の注入で「判定の上では active」として渡す（他の担当のテストや実アカウントに触らない）。
 * 終了時にアカウントを消す（CASCADE で credentials と job_runs も消える）
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCheckAlerts, type CheckAlertsDeps } from "../../src/commands/check-alerts.js";
import { upsertAccount, upsertCredential, vaultSecretName, type CredentialInfo } from "../../src/db/accounts.js";
import { closeDb, connectDb, type Db } from "../../src/db/client.js";
import { finishJobRun, listRecentRuns, startJobRun } from "../../src/db/job-runs.js";
import type { AccountRow, JobStatus } from "../../src/db/types.js";
import { createLogger, SecretRegistry } from "../../src/lib/log.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const NOW = new Date("2026-10-01T05:30:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const FAKE_TOKEN = `FAKE_VAULT_TOKEN_${Math.floor(Math.random() * 1_000_000_000)}`;

function fakeIgUserId(): string {
  return "000000" + Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, "0");
}

/** 残り 10 日と少し（daily で `days_left=10` の警告になる） */
const CREDENTIAL: CredentialInfo = {
  token_type: "PAGE",
  expires_at: null,
  data_access_expires_at: new Date(NOW.getTime() + 10 * DAY_MS + HOUR_MS),
  scopes: ["instagram_basic", "instagram_manage_insights", "pages_read_engagement"],
  status: "valid",
};

describe.skipIf(!TEST_DATABASE_URL)("commands/check-alerts（結合）", () => {
  const url = TEST_DATABASE_URL ?? "";
  let db: Db;
  /** A: credential あり。B: credential なし */
  let accountA: AccountRow;
  let accountB: AccountRow;
  const lines: string[] = [];
  let deps: CheckAlertsDeps;
  let runCount = 0;

  async function createPausedAccount(): Promise<AccountRow> {
    const row = await db.begin((tx) => upsertAccount(tx, { ig_user_id: fakeIgUserId(), username: "fake_alert_user" }));
    await db`update public.accounts set status = 'paused' where id = ${row.id}`;
    return { ...row, status: "paused" };
  }

  /** `stories` の実行を 1 件作る。`started_at` は NOW から順に古くならないよう、作った順に新しくする */
  async function addStoriesRun(accountId: string, status: Exclude<JobStatus, "running">): Promise<void> {
    runCount += 1;
    const id =
      status === "skipped"
        ? await startJobRun(db, "stories", accountId, { status: "skipped", error: "テスト用の見送り" })
        : await startJobRun(db, "stories", accountId);
    if (status !== "skipped") await finishJobRun(db, id, { status, items_fetched: 0, api_calls: 1, error: status === "failed" ? "テスト用の失敗" : null });
    await db`update public.job_runs set started_at = ${new Date(NOW.getTime() - 48 * HOUR_MS + runCount * HOUR_MS)} where id = ${id}`;
  }

  beforeAll(async () => {
    db = connectDb(url);
    accountA = await createPausedAccount();
    accountB = await createPausedAccount();
    await db.begin((tx) => upsertCredential(tx, accountA.id, FAKE_TOKEN, CREDENTIAL));
    const secrets = new SecretRegistry();
    secrets.addUrlParts(url);
    secrets.add(FAKE_TOKEN);
    deps = {
      config: { simulateAlert: false },
      db,
      log: createLogger("debug", secrets, (line) => lines.push(line), () => NOW),
      secrets,
      now: () => NOW,
      // DB では paused のまま。判定の上でだけ active として渡す
      listAccounts: async () => [
        { ...accountA, status: "active" },
        { ...accountB, status: "active" },
      ],
    };
  });

  afterAll(async () => {
    await db`delete from public.accounts where id in (${accountA.id}, ${accountB.id})`;
    const [rest] = await db<{ n: number }[]>`
      select count(*)::int as n from public.job_runs where account_id in (${accountA.id}, ${accountB.id})
    `;
    expect(rest?.n).toBe(0);
    // credentials のトリガーで Vault の秘密も消えている
    const [vault] = await db<{ n: number }[]>`
      select count(*)::int as n from vault.secrets where name in (${vaultSecretName(accountA.id)}, ${vaultSecretName(accountB.id)})
    `;
    expect(vault?.n).toBe(0);
    await closeDb(db);
  });

  it("履歴がなければ hourly は alerts=0 reason=no_history で true", async () => {
    lines.length = 0;
    await expect(runCheckAlerts("hourly", deps)).resolves.toBe(true);
    expect(lines).toEqual(["2026-10-01T05:30:00.000Z INFO  command=check-alerts scope=hourly accounts=2 alerts=0 reason=no_history"]);
  });

  it("daily はトークンを判定する: A は days_left=10、B は credential なし（status=none）", async () => {
    lines.length = 0;
    await expect(runCheckAlerts("daily", deps)).resolves.toBe(false);
    expect(lines).toEqual([
      "2026-10-01T05:30:00.000Z WARN  alert=token account=1/2 days_left=10 status=valid",
      "2026-10-01T05:30:00.000Z WARN  alert=token account=2/2 days_left=unknown status=none",
      "2026-10-01T05:30:00.000Z INFO  command=check-alerts scope=daily accounts=2 alerts=2",
    ]);
  });

  it("stories が failed,failed なら stories_failed（running と partial は数えない）", async () => {
    await addStoriesRun(accountA.id, "partial");
    await addStoriesRun(accountA.id, "failed");
    await addStoriesRun(accountA.id, "failed");
    const runningId = await startJobRun(db, "stories", accountA.id);
    await db`update public.job_runs set started_at = ${new Date(NOW.getTime() - HOUR_MS)} where id = ${runningId}`;

    const recent = await listRecentRuns(db, accountA.id, "stories", 3);
    expect(recent.map((run) => run.status)).toEqual(["failed", "failed", "partial"]);

    lines.length = 0;
    await expect(runCheckAlerts("hourly", deps)).resolves.toBe(false);
    expect(lines).toEqual([
      "2026-10-01T05:30:00.000Z WARN  alert=stories_failed account=1/2 runs=2",
      "2026-10-01T05:30:00.000Z INFO  command=check-alerts scope=hourly accounts=2 alerts=1",
    ]);
    await finishJobRun(db, runningId, { status: "success", items_fetched: 1, api_calls: 1 });
  });

  it("stories が skipped × 3 なら stories_skipped。履歴がそろえば reason は出ない", async () => {
    await addStoriesRun(accountB.id, "skipped");
    await addStoriesRun(accountB.id, "skipped");
    await addStoriesRun(accountB.id, "skipped");
    lines.length = 0;
    await expect(runCheckAlerts("hourly", deps)).resolves.toBe(false);
    // A は直近が success,failed,failed になったので該当しない
    expect(lines).toEqual([
      "2026-10-01T05:30:00.000Z WARN  alert=stories_skipped account=2/2 runs=3",
      "2026-10-01T05:30:00.000Z INFO  command=check-alerts scope=hourly accounts=2 alerts=1",
    ]);
  });

  it("simulate は先頭に alert=simulated", async () => {
    lines.length = 0;
    await expect(runCheckAlerts("hourly", { ...deps, config: { simulateAlert: true } })).resolves.toBe(false);
    expect(lines[0]).toBe("2026-10-01T05:30:00.000Z WARN  alert=simulated");
    expect(lines.at(-1)).toBe("2026-10-01T05:30:00.000Z INFO  command=check-alerts scope=hourly accounts=2 alerts=2");
  });

  it("ログに ID、ユーザー名、URL、10 桁の数字、トークンが出ない", () => {
    const text = lines.join("\n");
    expect(text).not.toContain(accountA.id);
    expect(text).not.toContain(accountB.id);
    expect(text).not.toContain(accountA.ig_user_id);
    expect(text).not.toContain("fake_alert_user");
    expect(text).not.toContain("://");
    expect(text).not.toMatch(/\d{10}/);
    expect(text).not.toContain(FAKE_TOKEN);
  });
});
