// R4.1 の動作確認（使い捨て。検討メモ doc/ai-decisions/r4-1-video-text-ocr.md 6 章）。
// 手元の DB の直近のリール N 本について、Graph API で media_url を取り直し、動画を一時ファイルに落とし、
// ffmpeg で一定間隔のフレームを取り出して Google Cloud Vision の TEXT_DETECTION に送り、
// フレームごとの時刻と読み取った文字を .local/ocr-check/<media_id>/result.md に書く。
//
// 使い方（リポジトリの場所で）: node scripts/ocr-check.mjs [本数=3] [秒間隔=1]
//   環境変数: OCR_DRY=1 なら Vision に送らずフレームの取り出しまで（費用 0）。OCR_MAX_UNITS（既定 100）で送る枚数の上限。
//             GCP_VISION_KEY（既定 .local/gcp-vision-key.json）、TEST_DATABASE_URL（既定は手元の Supabase）、FFMPEG（既定 ffmpeg）
// 前提: 手元の Supabase（127.0.0.1:54322）が動いていて、private.credentials に Meta のトークンがある。ffmpeg が PATH にある。
// 秘密（Meta のトークン、Google の鍵）は標準出力に出さない。動画は処理後に消す。フレームは目視のため残す
// （確認が終わったら .local/ocr-check を消す）。
import { createSign } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";

const COUNT = Number(process.argv[2] ?? 3);
const INTERVAL_S = Number(process.argv[3] ?? 1);
const DRY = process.env.OCR_DRY === "1";
const MAX_UNITS = Number(process.env.OCR_MAX_UNITS ?? 100);
const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const KEY_PATH = process.env.GCP_VISION_KEY ?? ".local/gcp-vision-key.json";
const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
const GRAPH_VERSION = "v25.0";
const OUT_ROOT = ".local/ocr-check";
const BATCH = 16; // images:annotate の 1 要求あたりの上限
// TEXT_DETECTION（既定）か DOCUMENT_TEXT_DETECTION。後者は語ごとの確信度が返る（前者は 0 のまま）
const FEATURE = process.env.OCR_FEATURE === "DOCUMENT_TEXT_DETECTION" ? "DOCUMENT_TEXT_DETECTION" : "TEXT_DETECTION";
const RESULT_FILE = FEATURE === "TEXT_DETECTION" ? "result.md" : "result-document.md";

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}: ${err.slice(-500)}`))));
  });
}

// サービスアカウントの鍵で JWT を作り、アクセストークンに替える（google-auth-library を入れずに済ませる）
async function googleAccessToken(key) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: key.token_uri,
    iat: now,
    exp: now + 3600,
  })}`;
  const sig = createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url");
  const res = await fetch(key.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
  });
  if (!res.ok) throw new Error(`Google のトークン取得に失敗: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).access_token;
}

async function annotate(token, contents) {
  const res = await fetch("https://vision.googleapis.com/v1/images:annotate", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      // languageHints は付けない（Google の文書: 空の方がよい結果になることが多い）
      requests: contents.map((content) => ({ image: { content }, features: [{ type: FEATURE }] })),
    }),
  });
  if (!res.ok) throw new Error(`Vision API が失敗: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).responses ?? [];
}

const sql = postgres(DB_URL, { max: 1 });
let reels;
let metaToken;
try {
  const [acct] = await sql`select id from public.accounts order by created_at limit 1`;
  if (!acct) throw new Error("accounts が空");
  const [cred] = await sql`
    select s.decrypted_secret
    from private.credentials c
    join vault.decrypted_secrets s on s.id = c.token_secret_id
    where c.account_id = ${acct.id}`;
  metaToken = cred?.decrypted_secret;
  if (!metaToken) throw new Error("Meta のトークンが手元の DB にない");
  reels = await sql`
    select id, posted_at from public.media
    where account_id = ${acct.id} and media_product_type = 'REELS' and gone_at is null
    order by posted_at desc limit ${COUNT}`;
} finally {
  await sql.end();
}

const googleToken = DRY ? null : await googleAccessToken(JSON.parse(await readFile(KEY_PATH, "utf8")));
let units = 0;

for (const reel of reels) {
  const u = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${reel.id}`);
  u.searchParams.set("fields", "id,media_type,media_url");
  u.searchParams.set("access_token", metaToken);
  const infoRes = await fetch(u);
  const info = await infoRes.json();
  if (!infoRes.ok || !info.media_url) {
    console.log(`${reel.id}: media_url が取れない（status ${infoRes.status}, code ${info.error?.code ?? "-"}）`);
    continue;
  }
  const dir = join(OUT_ROOT, String(reel.id));
  const frames = join(dir, "frames");
  // フレームが前回の実行で残っていればそのまま使う（同じ間隔で取り直す必要がないため。取り直すなら .local/ocr-check を消す）
  let files = await readdir(frames).then((fs) => fs.filter((f) => f.endsWith(".jpg")).sort()).catch(() => []);
  if (files.length === 0) {
    await mkdir(frames, { recursive: true });
    const video = join(tmpdir(), `ocr-check-${reel.id}.mp4`);
    const vres = await fetch(info.media_url);
    if (!vres.ok) {
      console.log(`${reel.id}: 動画のダウンロードに失敗（${vres.status}）`);
      continue;
    }
    await writeFile(video, Buffer.from(await vres.arrayBuffer()));
    try {
      await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", video, "-vf", `fps=1/${INTERVAL_S}`, "-q:v", "3", join(frames, "f%04d.jpg")]);
    } finally {
      await rm(video, { force: true });
    }
    files = (await readdir(frames)).filter((f) => f.endsWith(".jpg")).sort();
  }
  const lines = [
    `# ${reel.id}（投稿 ${reel.posted_at.toISOString().slice(0, 10)}）`,
    "",
    `フレーム ${files.length} 枚（${INTERVAL_S} 秒ごと）。${FEATURE}、言語ヒントなし`,
    "",
    "| 時刻(秒) | 読み取った文字（改行は ／） | 語の確信度の平均 | 語数 |",
    "|---|---|---|---|",
  ];
  if (DRY) {
    lines.push("（OCR_DRY=1 のため Vision には送っていない）");
  } else {
    for (let i = 0; i < files.length; i += BATCH) {
      const batch = files.slice(i, i + BATCH);
      if (units + batch.length > MAX_UNITS) {
        lines.push(`（上限 ${MAX_UNITS} ユニットに達したので打ち切り）`);
        break;
      }
      const contents = await Promise.all(batch.map((f) => readFile(join(frames, f)).then((b) => b.toString("base64"))));
      const responses = await annotate(googleToken, contents);
      units += batch.length;
      responses.forEach((r, j) => {
        const t = (i + j) * INTERVAL_S;
        if (r.error) {
          lines.push(`| ${t} | error: ${String(r.error.message ?? "").slice(0, 120)} | — | — |`);
          return;
        }
        const text = (r.textAnnotations?.[0]?.description ?? "").replace(/\r?\n/g, " ／ ").replace(/\|/g, "｜");
        const words = (r.fullTextAnnotation?.pages ?? [])
          .flatMap((p) => p.blocks ?? [])
          .flatMap((b) => b.paragraphs ?? [])
          .flatMap((p) => p.words ?? []);
        const conf = words.length ? (words.reduce((s, w) => s + (w.confidence ?? 0), 0) / words.length).toFixed(2) : "—";
        lines.push(`| ${t} | ${text || "（なし）"} | ${conf} | ${words.length} |`);
      });
    }
  }
  await writeFile(join(dir, RESULT_FILE), `${lines.join("\n")}\n`);
  console.log(`${reel.id}: フレーム ${files.length} 枚 → ${dir}/${RESULT_FILE}`);
}
console.log(`Vision に送った枚数（ユニット）: ${units}`);
