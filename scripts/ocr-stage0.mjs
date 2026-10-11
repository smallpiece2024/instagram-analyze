// R4.1 段階 0 の計測（使い捨て。設計書 doc/design/r4-1-video-text.md 9 章の段階 0）。
// 直近のリール 1 本について、設計 3.4 節の引数（-ss を -i の前、幅 1080、品質 4）で 8 枚のフレームを取り出して
// 1 枚あたりの時間と JPEG の大きさを測り、JWT の scope を cloud-vision にしてトークンが取れることを確かめ、
// 8 枚を 1 要求で DOCUMENT_TEXT_DETECTION に送って往復時間と応答の大きさ、4.1 節の形に切り詰めた words の大きさを測り、
// 語ごとの高さの比と中心 x の比を出す（4.3 節のしきい値の材料）。結果は .local/ocr-check/stage0.md。
// 使い方（リポジトリの場所で）: node scripts/ocr-stage0.mjs   → Vision のユニット 8 を使う（検討メモ 6.2 節に記録する）
// 秘密（Meta のトークン、Google の鍵）は標準出力に出さない。動画とフレームは処理後に消す。
import { createSign } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";

const DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const KEY_PATH = process.env.GCP_VISION_KEY ?? ".local/gcp-vision-key.json";
const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
const GRAPH_VERSION = "v25.0";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = process.env.OCR_SCOPE ?? "https://www.googleapis.com/auth/cloud-vision";
const FRAME_COUNT = 8;
const INTERVAL_MS = 1000;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"], env: { PATH: process.env.PATH } });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}: ${err.slice(-300)}`))));
  });
}

async function googleAccessToken(key) {
  if (key.token_uri !== TOKEN_URL) throw new Error("鍵の token_uri が定数と違う");
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: key.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })}`;
  const sig = createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url");
  const t0 = performance.now();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
  });
  const ms = Math.round(performance.now() - t0);
  if (!res.ok) throw new Error(`Google のトークン取得に失敗: ${res.status}`);
  const json = await res.json();
  return { token: json.access_token, expiresIn: json.expires_in, ms };
}

// 4.1 節の形（語ごと: 文字、矩形、確信度、言語。symbol は捨てる）
function trimWords(page) {
  const words = [];
  for (const b of page?.blocks ?? []) {
    for (const p of b.paragraphs ?? []) {
      for (const w of p.words ?? []) {
        const text = (w.symbols ?? []).map((s) => s.text ?? "").join("");
        const v = w.boundingBox?.vertices ?? [];
        const xs = v.map((q) => q.x ?? 0);
        const ys = v.map((q) => q.y ?? 0);
        words.push({
          t: text,
          x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys),
          c: w.confidence ?? null,
          l: w.property?.detectedLanguages?.[0]?.languageCode ?? null,
          br: w.property?.detectedBreak?.type ?? null,
        });
      }
    }
  }
  return words;
}

const sql = postgres(DB_URL, { max: 1 });
let reel;
let metaToken;
try {
  const [acct] = await sql`select id from public.accounts order by created_at limit 1`;
  const [cred] = await sql`select s.decrypted_secret from private.credentials c join vault.decrypted_secrets s on s.id = c.token_secret_id where c.account_id = ${acct.id}`;
  metaToken = cred?.decrypted_secret;
  [reel] = await sql`select id, posted_at from public.media where account_id = ${acct.id} and media_product_type = 'REELS' and gone_at is null order by posted_at desc limit 1`;
} finally {
  await sql.end();
}
if (!metaToken || !reel) throw new Error("トークンかリールがない");

const key = JSON.parse(await readFile(KEY_PATH, "utf8"));
const lines = [`# 段階 0 の計測（${new Date().toISOString().slice(0, 10)}）`, ""];

// 1. トークン（scope の確認）
const tok = await googleAccessToken(key);
lines.push(`- JWT の scope \`${SCOPE}\`: トークン取得 OK（${tok.ms} ms、expires_in ${tok.expiresIn} 秒）。token_uri は定数と一致`);

// 2. 動画の取得とフレームの取り出し
const u = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${reel.id}`);
u.searchParams.set("fields", "id,media_type,media_url");
u.searchParams.set("access_token", metaToken);
const info = await (await fetch(u)).json();
if (!info.media_url) throw new Error("media_url が取れない");
const dir = await mkdtemp(join(tmpdir(), "ocr-stage0-"));
const sizes = [];
const extractMs = [];
let probe = "";
try {
  const video = join(dir, "video.mp4");
  const t0 = performance.now();
  const vres = await fetch(info.media_url);
  const buf = Buffer.from(await vres.arrayBuffer());
  await writeFile(video, buf);
  lines.push(`- 動画: ${(buf.length / 1024 / 1024).toFixed(1)} MB、ダウンロード ${Math.round(performance.now() - t0)} ms`);
  // ffprobe で長さと大きさ
  await new Promise((resolve, reject) => {
    const p = spawn("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,duration", "-of", "csv=p=0", video], { env: { PATH: process.env.PATH } });
    p.stdout.on("data", (d) => (probe += d));
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error("ffprobe failed"))));
  });
  lines.push(`- ffprobe（幅,高さ,秒）: ${probe.trim()}`);
  const frames = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const atMs = i * INTERVAL_MS * 2; // 0, 2, 4, … 秒（テロップの変わり目を拾いやすいよう 2 秒おき）
    const out = join(dir, `f${i}.jpg`);
    const t1 = performance.now();
    await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file", "-f", "mp4", "-ss", String(atMs / 1000), "-i", video, "-frames:v", "1", "-vf", "scale='min(1080,iw)':-2", "-q:v", "4", "-y", out]);
    extractMs.push(Math.round(performance.now() - t1));
    const st = await stat(out);
    sizes.push(st.size);
    frames.push({ atMs, content: (await readFile(out)).toString("base64") });
  }
  lines.push(`- フレームの取り出し（-ss を -i の前、幅 1080、品質 4）: 1 枚 ${Math.min(...extractMs)}〜${Math.max(...extractMs)} ms（中央値 ${extractMs.sort((a, b) => a - b)[Math.floor(extractMs.length / 2)]} ms）`);
  lines.push(`- JPEG の大きさ: ${Math.min(...sizes) / 1024 | 0}〜${Math.max(...sizes) / 1024 | 0} KB（平均 ${(sizes.reduce((a, b) => a + b, 0) / sizes.length / 1024) | 0} KB）。8 枚の base64 の合計 ${((frames.reduce((a, f) => a + f.content.length, 0)) / 1024 / 1024).toFixed(2)} MB`);

  // 3. Vision に 8 枚を 1 要求
  const body = JSON.stringify({ requests: frames.map((f) => ({ image: { content: f.content }, features: [{ type: "DOCUMENT_TEXT_DETECTION" }] })) });
  const t2 = performance.now();
  const res = await fetch("https://vision.googleapis.com/v1/images:annotate", {
    method: "POST",
    redirect: "error",
    headers: { authorization: `Bearer ${tok.token}`, "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  const ms = Math.round(performance.now() - t2);
  lines.push(`- images:annotate（8 枚、DOCUMENT_TEXT_DETECTION）: status ${res.status}、往復 ${ms} ms、要求 ${(body.length / 1024 / 1024).toFixed(2)} MB、応答 ${(text.length / 1024) | 0} KB`);
  if (!res.ok) throw new Error(`Vision が失敗: ${res.status} ${text.slice(0, 200)}`);
  const json = JSON.parse(text);
  lines.push("", "| 時刻(秒) | 画像の幅×高さ | 語数 | 切り詰めた words の大きさ | 語（文字: 高さの比 / 中心 x の比 / 確信度）上位 6 語（高さ順） |", "|---|---|---|---|---|");
  for (let i = 0; i < frames.length; i++) {
    const r = json.responses[i] ?? {};
    const page = r.fullTextAnnotation?.pages?.[0];
    const W = page?.width ?? 0;
    const H = page?.height ?? 0;
    const words = trimWords(page);
    const sizeKb = (JSON.stringify(words).length / 1024).toFixed(1);
    const top = [...words]
      .map((w) => ({ t: w.t, h: H ? (w.y1 - w.y0) / H : 0, cx: W ? (w.x0 + w.x1) / 2 / W : 0, c: w.c }))
      .sort((a, b) => b.h - a.h)
      .slice(0, 6)
      .map((w) => `${w.t}: ${(w.h * 100).toFixed(1)}% / ${w.cx.toFixed(2)} / ${w.c == null ? "—" : w.c.toFixed(2)}`)
      .join("、");
    lines.push(`| ${frames[i].atMs / 1000} | ${W}×${H} | ${words.length} | ${sizeKb} KB | ${top.replace(/\|/g, "｜")} |`);
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
await mkdir(".local/ocr-check", { recursive: true });
await writeFile(".local/ocr-check/stage0.md", `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
console.log("\nVision に送った枚数（ユニット）: 8");
