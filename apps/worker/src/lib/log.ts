/**
 * ログと秘密情報のマスク（設計 8.1 章、10.5 章）。
 *
 * 標準出力に 1 行ずつ出す。GitHub Actions の実行ログは公開されるため、文字列と数値の値はすべて
 * `sanitizeForLog` を通し、トークン、接続文字列、URL、ID を出さない（NF-SEC-06）。
 * `job_runs.error` などの DB に入れる文字列も同じ関数を通す。
 *
 * 適用順序は設計 8.1 章の「登録値のマスク → パターン」から次の 3 段に変えた（レビューの判断、2026-10-01）:
 *   1. URL のパターン（`https?://…` → `<url>`、`postgres(ql)?://…` → `<db-url>`）
 *   2. 登録した値のマスク（`SecretRegistry`）
 *   3. 残りのパターン（`access_token=`、JSON の `"access_token":`、`Bearer`、トークンの形、10 桁以上の数字）
 * 理由: ローカルの接続文字列はユーザー名とパスワードが `postgres` で、先に登録値を置換すると
 * `postgresql://…` が `***ql://…` になって `<db-url>` に置き換わらない。URL を先に丸ごと置けば見た目が崩れず、
 * 登録値のマスクは引き続き全体に効くので安全性は落ちない。
 */

export type LogFields = Record<string, string | number | boolean | undefined>;

export interface Logger {
  info(fields: LogFields): void;
  warn(fields: LogFields): void;
  /** `createLogger` の level が `debug` のときだけ出る */
  debug(fields: LogFields): void;
}

const MASK = "***";

/**
 * `addUrlParts` が URL から切り出した断片を登録する最小の長さ。
 * `db` のような短い断片（Docker のサービス名、短い DB 名）を登録すると、ログの一般的な語まで `***` になるため
 */
const MIN_URL_PART_LENGTH = 4;

/** URL のパターンで置いたプレースホルダ。登録値のマスクで壊さない（`db` が登録されていても `<db-url>` を保つ） */
const PLACEHOLDER_SPLIT = /(<(?:db-)?url>)/;

function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/**
 * 設定値ベースの秘密の一覧。起動時にトークン、アプリシークレット、サービスロールキー、
 * 接続文字列の各部分を登録し、Vault から読んだトークンも読んだ時点で登録する。
 */
export class SecretRegistry {
  private readonly values = new Set<string>();

  /** 空文字と undefined は無視する */
  add(value: string | undefined): void {
    if (value) this.values.add(value);
  }

  /**
   * URL 文字列そのものと、ユーザー名、パスワード（URL デコード後も）、ホスト名を登録する。
   * Supabase の形（ユーザー名 `postgres.<ref>`、ホスト `<ref>.supabase.co`）ではプロジェクトの ref 単体も、
   * IPv6 のホスト（`[2001:db8::1]`）では括弧を外した形も登録する。URL として読めなければ文字列全体だけを登録する。
   * 切り出した断片は `MIN_URL_PART_LENGTH` 文字以上のものだけ登録し、DB 名やパスは登録しない。
   */
  addUrlParts(url: string | undefined): void {
    if (!url) return;
    this.add(url);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    for (const part of [parsed.username, parsed.password]) {
      this.addPart(part);
      this.addPart(safeDecode(part));
    }
    if (parsed.username.startsWith("postgres.")) {
      this.addPart(parsed.username.slice("postgres.".length));
    }
    const host = parsed.hostname;
    this.addPart(host);
    if (host.endsWith(".supabase.co")) {
      this.addPart(host.split(".")[0]);
    }
    if (host.startsWith("[") && host.endsWith("]")) {
      this.addPart(host.slice(1, -1));
    }
  }

  private addPart(value: string | undefined): void {
    if (value && value.length >= MIN_URL_PART_LENGTH) this.values.add(value);
  }

  /** 登録した値の出現をすべて `***` に置き換える。長い値から順に置換し、部分一致の取りこぼしを防ぐ */
  mask(text: string): string {
    let out = text;
    for (const value of [...this.values].sort((a, b) => b.length - a.length)) {
      out = out.split(value).join(MASK);
    }
    return out;
  }
}

type Pattern = readonly [RegExp, string];

/** 1 段目: URL を丸ごと置き換える */
const URL_PATTERNS: readonly Pattern[] = [
  [/https?:\/\/\S+/g, "<url>"],
  [/postgres(?:ql)?:\/\/\S+/g, "<db-url>"],
];

/** 3 段目: 残りのパターン。上から順に適用する */
const VALUE_PATTERNS: readonly Pattern[] = [
  [/(access_token|input_token|appsecret_proof)=[^&\s]+/g, `$1=${MASK}`],
  [/"(access_token|input_token|appsecret_proof)"\s*:\s*"[^"]*"/g, `"$1":"${MASK}"`],
  [/Bearer \S+/g, `Bearer ${MASK}`],
  // Meta のアクセストークンの形（EAA で始まる英数字）
  [/\bEAA[A-Za-z0-9]{20,}/g, MASK],
  // JWT の形（サービスロールキーなど）
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, MASK],
  // Graph API のエラー文にはメディア ID（10 桁以上）が入ることがある
  [/\d{10,}/g, MASK],
];

function applyPatterns(text: string, patterns: readonly Pattern[]): string {
  let out = text;
  for (const [pattern, replacement] of patterns) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * ログや DB に入れる文字列から秘密情報を落とす。
 * URL のパターン → 登録した値の置換 → 残りのパターン、の順（冒頭のコメント）。
 * 登録値の置換は、1 段目で置いたプレースホルダ（`<url>`、`<db-url>`）の外側にだけ掛ける。
 */
export function sanitizeForLog(text: string, secrets: SecretRegistry): string {
  const withPlaceholders = applyPatterns(text, URL_PATTERNS);
  // split の捕捉グループでプレースホルダを残す。奇数番目がプレースホルダ
  const masked = withPlaceholders
    .split(PLACEHOLDER_SPLIT)
    .map((part, index) => (index % 2 === 1 ? part : secrets.mask(part)))
    .join("");
  return applyPatterns(masked, VALUE_PATTERNS);
}

type Label = "INFO" | "WARN" | "DEBUG";

/** ラベルの幅（`INFO `、`WARN `、`DEBUG`） */
const LABEL_WIDTH = 5;

function formatValue(value: string | number | boolean, secrets: SecretRegistry): string {
  if (typeof value === "boolean") return String(value);
  // 数値も通す（メディア ID のような 10 桁以上の数値を隠す）
  if (typeof value === "number") return sanitizeForLog(String(value), secrets);
  // 1 行の形式を保つため、改行は文字どおりの `\n` にする
  const clean = sanitizeForLog(value, secrets).replace(/\r\n|\r|\n/g, "\\n");
  return /[\s="]/.test(clean) ? `"${clean.replace(/"/g, '\\"')}"` : clean;
}

function formatFields(fields: LogFields, secrets: SecretRegistry): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(`${key}=${formatValue(value, secrets)}`);
  }
  return parts.join(" ");
}

/**
 * 1 行の形式: `2026-10-02T20:05:01.000Z INFO  job=stories status=success items=4`。
 * `undefined` の項目は出さない。文字列と数値は `sanitizeForLog` を通し、文字列は空白か `=` か `"` を含めば
 * `"..."` で囲む。`write` と `now` はテスト用に差し替えられる。
 */
export function createLogger(
  level: "info" | "debug",
  secrets: SecretRegistry,
  write: (line: string) => void = (line) => console.log(line),
  now: () => Date = () => new Date(),
): Logger {
  const emit = (label: Label, fields: LogFields): void => {
    const text = formatFields(fields, secrets);
    write(`${now().toISOString()} ${label.padEnd(LABEL_WIDTH)} ${text}`.trimEnd());
  };
  return {
    info: (fields) => emit("INFO", fields),
    warn: (fields) => emit("WARN", fields),
    debug: (fields) => {
      if (level === "debug") emit("DEBUG", fields);
    },
  };
}
