/**
 * Google Cloud Vision の `images:annotate` のクライアント（R4.1 設計 3.5 節、3.6 節、3.8 節）。
 *
 * - 認証: サービスアカウントの鍵から RS256 の JWT を作り（`createServiceAccountJwt`）、トークンの URL に送って
 *   アクセストークンを得る。トークンはクライアントの中にだけ持ち、`expires_in − 300 秒` まで使い回す。
 *   取得したトークンは `deps.onToken`（ジョブが `ctx.addSecret` を渡す）でマスクの対象に加える。
 *   トークンと鍵は引数にも戻り値にも例外の文面にも乗せない
 * - 要求: `annotate(images, hooks)` は 1 要求を送り、試行ごとに `hooks.onAttempt`（`ocr_usage` とフレームの書き込み）
 *   を呼ぶ。429 と 5xx・ネットワークの失敗だけ 2 回まで再送（2 秒、8 秒。`deps.sleep` で差し替え）。
 *   制限時間切れと 4xx は再送しない。`hooks.canRetry` が偽（時間の予算を超えた）なら再送しない
 * - 純粋関数: `splitRequests`（枚数と本文の大きさで分ける）、`parseAnnotateResponse`（4.1 節の形に切り詰める）、
 *   `unitsFor`（`ocr_usage.units` の規則）
 * - 失敗は `VisionError`（`kind` と HTTP の `status`、固定文言）。応答の `error.message` は持ち込まない
 */
import { createSign } from "node:crypto";
import { GOOGLE_OAUTH_TOKEN_URI } from "../config.js";
import { codePoints, MAX_TEXT_CHARS_PER_FRAME, MAX_WORDS_PER_FRAME, type FrameWord } from "./video-text.js";

/** `images:annotate` の URL（設定で変えられない） */
export const VISION_ANNOTATE_URL = "https://vision.googleapis.com/v1/images:annotate";
/** JWT の scope（`cloud-platform` より狭い。段階 0 で通ることを確認） */
export const VISION_SCOPE = "https://www.googleapis.com/auth/cloud-vision";
/** 使う機能 */
export const VISION_FEATURE = "DOCUMENT_TEXT_DETECTION";
/** JWT の有効期間（秒） */
export const JWT_LIFETIME_S = 3600;
/** トークンの取得の制限時間 */
export const TOKEN_TIMEOUT_MS = 15_000;
/** `images:annotate` 1 要求の制限時間 */
export const ANNOTATE_TIMEOUT_MS = 30_000;
/** トークンを使い回すのをやめる余裕（秒） */
export const TOKEN_REFRESH_MARGIN_S = 300;
/** 1 要求の枚数の上限（API の 16 に対して半分） */
export const MAX_IMAGES_PER_REQUEST = 8;
/** 1 要求の本文の上限（API の 10 MB に対して余裕） */
export const MAX_REQUEST_BODY_BYTES = 6 * 1024 * 1024;
/** 再送の待ち（ミリ秒）。長さが再送の回数 */
export const RETRY_DELAYS_MS: readonly number[] = [2000, 8000];

/** 失敗の分類（設計 3.6 節の表）。`timeout` は `transient` と同じ分類で記録するが再送しない */
export type VisionFailureKind = "auth" | "rate" | "transient" | "timeout" | "fatal";

export const SIGN_ERROR = "Vision の鍵で署名できない";
export const RATE_LIMIT_ERROR = "Vision の頻度の上限（status 429）";
export function authFailedError(status: number): string {
  return `Vision の認証に失敗（status ${status}）`;
}
export function requestFailedError(status: number | undefined): string {
  return `Vision の要求に失敗（status ${status ?? "なし"}）`;
}

/** Vision の失敗。`message` は固定文言と HTTP の status だけ */
export class VisionError extends Error {
  override readonly name = "VisionError";

  constructor(
    readonly kind: VisionFailureKind,
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
  }
}

export interface ServiceAccountKey {
  clientEmail: string;
  privateKey: string;
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

/** RS256 の JWT（`iss`、`scope`、`aud`、`iat`、`exp = iat + 3600`）。署名の失敗は OpenSSL の例外のまま投げる */
export function createServiceAccountJwt(key: ServiceAccountKey, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({ iss: key.clientEmail, scope: VISION_SCOPE, aud: GOOGLE_OAUTH_TOKEN_URI, iat, exp: iat + JWT_LIFETIME_S }),
  );
  const unsigned = `${header}.${claims}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key.privateKey, "base64url");
  return `${unsigned}.${signature}`;
}

/** base64 にしたときの文字数 */
export function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

export interface SplitOptions {
  maxImages: number;
  maxBodyBytes: number;
}

export const DEFAULT_SPLIT_OPTIONS: SplitOptions = { maxImages: MAX_IMAGES_PER_REQUEST, maxBodyBytes: MAX_REQUEST_BODY_BYTES };

/**
 * 時刻順に詰め、`maxImages` 枚か base64 の合計が `maxBodyBytes` を超える手前で切る（設計 3.5 節）。
 * 1 枚で `maxBodyBytes` を超えるものは `tooLarge` に分けて送らない
 */
export function splitRequests<T extends { byteLength: number }>(
  frames: readonly T[],
  options: SplitOptions = DEFAULT_SPLIT_OPTIONS,
): { batches: T[][]; tooLarge: T[] } {
  const batches: T[][] = [];
  const tooLarge: T[] = [];
  let current: T[] = [];
  let currentBytes = 0;
  for (const frame of frames) {
    const encoded = base64Length(frame.byteLength);
    if (encoded > options.maxBodyBytes) {
      tooLarge.push(frame);
      continue;
    }
    if (current.length >= options.maxImages || currentBytes + encoded > options.maxBodyBytes) {
      if (current.length > 0) batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(frame);
    currentBytes += encoded;
  }
  if (current.length > 0) batches.push(current);
  return { batches, tooLarge };
}

/** 1 枚の結果（成功）。`width`／`height` は `pages[0]` から（文字のないフレームでは null） */
export interface ParsedFrameOk {
  ok: true;
  text: string;
  words: FrameWord[];
  /** 切り詰める前の語数 */
  wordCount: number;
  width: number | null;
  height: number | null;
}

/** 1 枚の結果（`responses[].error`）。`code` だけを持つ */
export interface ParsedFrameError {
  ok: false;
  errorCode: number;
}

export type ParsedFrame = ParsedFrameOk | ParsedFrameError;

interface Vertex {
  x?: unknown;
  y?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boxOf(boundingBox: unknown): { x0: number; y0: number; x1: number; y1: number } {
  const vertices = isRecord(boundingBox) ? asArray(boundingBox["vertices"]) : [];
  const xs = vertices.map((v) => numberOr((v as Vertex).x, 0));
  const ys = vertices.map((v) => numberOr((v as Vertex).y, 0));
  if (xs.length === 0) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

function detectedLanguage(property: unknown): string | null {
  if (!isRecord(property)) return null;
  const first = asArray(property["detectedLanguages"])[0];
  const code = isRecord(first) ? first["languageCode"] : undefined;
  return typeof code === "string" && code !== "" ? code : null;
}

function detectedBreak(property: unknown): string | null {
  if (!isRecord(property)) return null;
  const brk = property["detectedBreak"];
  const type = isRecord(brk) ? brk["type"] : undefined;
  return typeof type === "string" && type !== "" ? type : null;
}

/** `fullTextAnnotation` を 4.1 節の形に切り詰める */
function trimAnnotation(annotation: Record<string, unknown>): ParsedFrameOk {
  const words: FrameWord[] = [];
  let wordCount = 0;
  let width: number | null = null;
  let height: number | null = null;
  const pages = asArray(annotation["pages"]);
  const firstPage = pages[0];
  if (isRecord(firstPage)) {
    const w = numberOr(firstPage["width"], 0);
    const h = numberOr(firstPage["height"], 0);
    if (w > 0 && h > 0) {
      width = w;
      height = h;
    }
  }
  let blockIndex = 0;
  for (const page of pages) {
    if (!isRecord(page)) continue;
    for (const block of asArray(page["blocks"])) {
      if (!isRecord(block)) continue;
      let paragraphIndex = 0;
      for (const paragraph of asArray(block["paragraphs"])) {
        if (!isRecord(paragraph)) continue;
        for (const word of asArray(paragraph["words"])) {
          if (!isRecord(word)) continue;
          wordCount += 1;
          if (words.length >= MAX_WORDS_PER_FRAME) continue;
          const symbols = asArray(word["symbols"]).filter(isRecord);
          const text = symbols.map((s) => (typeof s["text"] === "string" ? s["text"] : "")).join("");
          const lastSymbol = symbols[symbols.length - 1];
          const confidence = Math.round(Math.min(1, Math.max(0, numberOr(word["confidence"], 0))) * 1000) / 1000;
          words.push({
            b: blockIndex,
            p: paragraphIndex,
            t: text,
            c: confidence,
            l: detectedLanguage(word["property"]),
            ...boxOf(word["boundingBox"]),
            br: lastSymbol ? detectedBreak(lastSymbol["property"]) : null,
          });
        }
        paragraphIndex += 1;
      }
      blockIndex += 1;
    }
  }
  const rawText = typeof annotation["text"] === "string" ? annotation["text"] : "";
  const chars = codePoints(rawText);
  const text = chars.length > MAX_TEXT_CHARS_PER_FRAME ? chars.slice(0, MAX_TEXT_CHARS_PER_FRAME).join("") : rawText;
  return { ok: true, text, words, wordCount, width, height };
}

/**
 * 応答の解釈（設計 3.5 節）。本文が JSON でない、`responses` がない、長さが枚数と違えば undefined（要求全体の失敗）。
 * 各要素は `error` があれば `code` だけ、なければ `fullTextAnnotation` を切り詰める。`fullTextAnnotation` がなければ
 * 文字なしの成功（`text = ''`、`words = []`）
 */
export function parseAnnotateResponse(body: string | unknown, imageCount: number): ParsedFrame[] | undefined {
  let json: unknown = body;
  if (typeof body === "string") {
    try {
      json = JSON.parse(body);
    } catch {
      return undefined;
    }
  }
  if (!isRecord(json)) return undefined;
  const responses = json["responses"];
  if (!Array.isArray(responses) || responses.length !== imageCount) return undefined;
  const frames: ParsedFrame[] = [];
  for (const response of responses) {
    if (!isRecord(response)) return undefined;
    const error = response["error"];
    if (isRecord(error)) {
      frames.push({ ok: false, errorCode: Math.trunc(numberOr(error["code"], 0)) });
      continue;
    }
    const annotation = response["fullTextAnnotation"];
    if (!isRecord(annotation)) {
      frames.push({ ok: true, text: "", words: [], wordCount: 0, width: null, height: null });
      continue;
    }
    frames.push(trimAnnotation(annotation));
  }
  return frames;
}

/** `ocr_usage.units` の規則（設計 3.3 節）。429、401、403 は 0。それ以外（応答なしを含む）は枚数 */
export function unitsFor(httpStatus: number | undefined, imageCount: number): number {
  return httpStatus === 429 || httpStatus === 401 || httpStatus === 403 ? 0 : imageCount;
}

/** 1 回の試行の結果（`ocr_usage` の 1 行の材料）。トークンは含まない */
export interface AnnotateAttempt {
  ok: boolean;
  httpStatus: number | undefined;
  elapsedMs: number;
  imageCount: number;
  requestBytes: number;
  responseBytes: number | null;
  /** 成功した試行の語数の合計（切り詰める前）。失敗なら null */
  wordCount: number | null;
  /** 成功した試行の各フレーム。失敗なら undefined */
  frames: ParsedFrame[] | undefined;
  /** 失敗の理由。成功なら undefined */
  error: VisionError | undefined;
}

export interface AnnotateHooks {
  /** 試行ごとに呼ぶ（`ocr_usage` とフレームの書き込み）。例外は再送せずそのまま外へ出す */
  onAttempt: (attempt: AnnotateAttempt) => Promise<void>;
  /** 再送の前に呼ぶ。偽なら再送しない（時間の予算） */
  canRetry?: () => boolean;
}

export interface VisionClientDeps {
  fetch?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** 取得したトークンをマスクの対象に加える（`ctx.addSecret`） */
  onToken?: (token: string) => void;
}

export interface VisionClient {
  /** トークンを取る（期限内なら何もしない）。失敗は `VisionError`（`auth` か `transient`） */
  ensureToken(): Promise<void>;
  /** 1 要求（`images` は JPEG のバイト列）。最後の試行を返す。試行ごとに `hooks.onAttempt` を呼ぶ */
  annotate(images: readonly Uint8Array[], hooks: AnnotateHooks): Promise<AnnotateAttempt>;
}

function isTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "TimeoutError";
}

/** `createVisionClient`。`fetch`、`now`、`sleep` はテストで差し替える */
export function createVisionClient(key: ServiceAccountKey, deps: VisionClientDeps = {}): VisionClient {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let token: string | undefined;
  let expiresAtMs = 0;

  async function ensureToken(): Promise<void> {
    if (token !== undefined && now().getTime() < expiresAtMs) return;
    let assertion: string;
    try {
      assertion = createServiceAccountJwt(key, now());
    } catch {
      throw new VisionError("auth", undefined, SIGN_ERROR);
    }
    // 署名済みの JWT もトークンと同じく 1 時間有効な資格情報なので、マスクの対象に加える（セキュリティレビュー S6）
    deps.onToken?.(assertion);
    let res: Response;
    try {
      res = await fetchImpl(GOOGLE_OAUTH_TOKEN_URI, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      });
    } catch {
      throw new VisionError("transient", undefined, requestFailedError(undefined));
    }
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      await res.text().catch(() => undefined);
      throw new VisionError("auth", res.status, authFailedError(res.status));
    }
    if (!res.ok) {
      await res.text().catch(() => undefined);
      throw new VisionError("transient", res.status, requestFailedError(res.status));
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new VisionError("transient", res.status, requestFailedError(res.status));
    }
    const accessToken = isRecord(json) ? json["access_token"] : undefined;
    const expiresIn = isRecord(json) ? numberOr(json["expires_in"], JWT_LIFETIME_S) : JWT_LIFETIME_S;
    if (typeof accessToken !== "string" || accessToken === "") {
      throw new VisionError("transient", res.status, requestFailedError(res.status));
    }
    token = accessToken;
    expiresAtMs = now().getTime() + Math.max(0, expiresIn - TOKEN_REFRESH_MARGIN_S) * 1000;
    deps.onToken?.(accessToken);
  }

  async function annotateOnce(images: readonly Uint8Array[]): Promise<AnnotateAttempt> {
    const body = JSON.stringify({
      requests: images.map((image) => ({
        image: { content: Buffer.from(image).toString("base64") },
        features: [{ type: VISION_FEATURE }],
      })),
    });
    const requestBytes = Buffer.byteLength(body);
    const imageCount = images.length;
    const startedAt = now().getTime();
    const elapsed = (): number => Math.max(0, now().getTime() - startedAt);
    const failed = (kind: VisionFailureKind, status: number | undefined, responseBytes: number | null, message: string): AnnotateAttempt => ({
      ok: false,
      httpStatus: status,
      elapsedMs: elapsed(),
      imageCount,
      requestBytes,
      responseBytes,
      wordCount: null,
      frames: undefined,
      error: new VisionError(kind, status, message),
    });
    let res: Response;
    try {
      res = await fetchImpl(VISION_ANNOTATE_URL, {
        method: "POST",
        redirect: "error",
        headers: { authorization: `Bearer ${token ?? ""}`, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(ANNOTATE_TIMEOUT_MS),
      });
    } catch (error) {
      return isTimeout(error)
        ? failed("timeout", undefined, null, requestFailedError(undefined))
        : failed("transient", undefined, null, requestFailedError(undefined));
    }
    let text: string;
    try {
      text = await res.text();
    } catch (error) {
      return failed(isTimeout(error) ? "timeout" : "transient", res.status, null, requestFailedError(res.status));
    }
    const responseBytes = Buffer.byteLength(text);
    if (res.status === 401 || res.status === 403) return failed("auth", res.status, responseBytes, authFailedError(res.status));
    if (res.status === 429) return failed("rate", res.status, responseBytes, RATE_LIMIT_ERROR);
    if (res.status >= 500) return failed("transient", res.status, responseBytes, requestFailedError(res.status));
    if (!res.ok) return failed("fatal", res.status, responseBytes, requestFailedError(res.status));
    const frames = parseAnnotateResponse(text, imageCount);
    if (!frames) return failed("transient", res.status, responseBytes, requestFailedError(res.status));
    return {
      ok: true,
      httpStatus: res.status,
      elapsedMs: elapsed(),
      imageCount,
      requestBytes,
      responseBytes,
      wordCount: frames.reduce((sum, f) => sum + (f.ok ? f.wordCount : 0), 0),
      frames,
      error: undefined,
    };
  }

  async function annotate(images: readonly Uint8Array[], hooks: AnnotateHooks): Promise<AnnotateAttempt> {
    for (let attempt = 0; ; attempt += 1) {
      await ensureToken();
      const result = await annotateOnce(images);
      await hooks.onAttempt(result);
      if (result.ok) return result;
      const kind = result.error?.kind;
      const retryable = kind === "rate" || kind === "transient";
      const delay = RETRY_DELAYS_MS[attempt];
      if (!retryable || delay === undefined || (hooks.canRetry && !hooks.canRetry())) return result;
      await sleep(delay);
    }
  }

  return { ensureToken, annotate };
}
