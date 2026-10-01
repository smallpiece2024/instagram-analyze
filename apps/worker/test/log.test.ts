import { describe, expect, it } from "vitest";
import { createLogger, sanitizeForLog, SecretRegistry, type LogFields } from "../src/lib/log.js";

describe("SecretRegistry", () => {
  it("登録した値の出現をすべて *** にする", () => {
    const secrets = new SecretRegistry();
    secrets.add("EAAB_TOKEN_VALUE");
    expect(secrets.mask("token=EAAB_TOKEN_VALUE and again EAAB_TOKEN_VALUE")).toBe("token=*** and again ***");
  });

  it("空文字と undefined は無視する（すべてが *** にならない）", () => {
    const secrets = new SecretRegistry();
    secrets.add("");
    secrets.add(undefined);
    expect(secrets.mask("nothing to hide")).toBe("nothing to hide");
  });

  it("長い値から置換し、短い値が長い値の一部でも取りこぼさない", () => {
    const secrets = new SecretRegistry();
    secrets.add("abc");
    secrets.add("abc123");
    expect(secrets.mask("x abc123 y abc z")).toBe("x *** y *** z");
  });

  it("addUrlParts は接続文字列のユーザー名、パスワード（デコード後も）、ホスト名を登録する", () => {
    const secrets = new SecretRegistry();
    secrets.addUrlParts("postgresql://postgres.abcdefgh:p%40ss@db.example.com:5432/postgres");
    expect(secrets.mask("user postgres.abcdefgh")).toBe("user ***");
    expect(secrets.mask("pass p%40ss")).toBe("pass ***");
    expect(secrets.mask("pass p@ss")).toBe("pass ***");
    expect(secrets.mask("host db.example.com")).toBe("host ***");
    // ポートとデータベース名は登録しない
    expect(secrets.mask("port 5432 db postgres")).toBe("port 5432 db postgres");
  });

  it("addUrlParts は URL として読めなければ文字列全体を登録する。undefined は無視", () => {
    const secrets = new SecretRegistry();
    secrets.addUrlParts("not a url at all");
    secrets.addUrlParts(undefined);
    expect(secrets.mask("x not a url at all y")).toBe("x *** y");
  });

  it("addUrlParts は SUPABASE_URL のホスト名を登録する", () => {
    const secrets = new SecretRegistry();
    secrets.addUrlParts("http://host.docker.internal:54321");
    expect(secrets.mask("connect to host.docker.internal:54321")).toBe("connect to ***:54321");
  });

  it("addUrlParts は URL 文字列そのものも登録する", () => {
    const secrets = new SecretRegistry();
    secrets.addUrlParts("http://host.docker.internal:54321");
    expect(secrets.mask("url is http://host.docker.internal:54321 ok")).toBe("url is *** ok");
  });

  it("addUrlParts は Supabase の形からプロジェクトの ref 単体も登録する（R2 の接続文字列）", () => {
    const secrets = new SecretRegistry();
    secrets.addUrlParts("postgresql://postgres.abcdefghij:secret@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres");
    secrets.addUrlParts("https://abcdefghij.supabase.co");
    expect(secrets.mask("ref abcdefghij here")).toBe("ref *** here");
    expect(secrets.mask("user postgres.abcdefghij")).toBe("user ***");
    expect(secrets.mask("host abcdefghij.supabase.co")).toBe("host ***");
  });

  it("addUrlParts は IPv6 のホストを括弧を外した形でも登録する", () => {
    const secrets = new SecretRegistry();
    secrets.addUrlParts("http://[2001:db8::1]:54321");
    expect(secrets.mask("host [2001:db8::1] and 2001:db8::1")).toBe("host *** and ***");
  });

  it("addUrlParts は 4 文字未満の断片（短いホスト名や DB 名）を登録しない", () => {
    const secrets = new SecretRegistry();
    secrets.addUrlParts("postgresql://ab:cd@db:5432/db");
    expect(secrets.mask("ab cd db <db-url>")).toBe("ab cd db <db-url>");
    // URL 文字列そのものは登録する
    expect(secrets.mask("x postgresql://ab:cd@db:5432/db y")).toBe("x *** y");
  });

  it("正規表現の特殊文字を含む秘密も文字どおりに置き換える", () => {
    const secrets = new SecretRegistry();
    secrets.add("p@ss|w.rd$(1)");
    expect(secrets.mask("password p@ss|w.rd$(1) end")).toBe("password *** end");
    expect(secrets.mask("pXss|wZrd$(1)")).toBe("pXss|wZrd$(1)");
  });
});

describe("sanitizeForLog", () => {
  const secrets = new SecretRegistry();
  secrets.add("EAAB_ACCESS_TOKEN");
  secrets.add("app_secret_value");
  secrets.add("service_role_key_value");
  secrets.addUrlParts("postgresql://postgres.projectref:db_password@aws-0.pooler.supabase.com:5432/postgres");
  secrets.addUrlParts("https://projectref.supabase.co");
  secrets.add("vault_token_value");

  it("登録した秘密が *** になる", () => {
    const text =
      "token EAAB_ACCESS_TOKEN secret app_secret_value key service_role_key_value user postgres.projectref pass db_password host aws-0.pooler.supabase.com supabase projectref.supabase.co vault vault_token_value";
    expect(sanitizeForLog(text, secrets)).toBe(
      "token *** secret *** key *** user *** pass *** host *** supabase *** vault ***",
    );
  });

  it("URL は <url>、接続文字列は <db-url> になる", () => {
    const plain = new SecretRegistry();
    expect(sanitizeForLog("see https://graph.facebook.com/v25.0/me?x=1 now", plain)).toBe("see <url> now");
    expect(sanitizeForLog("see http://example.com/a now", plain)).toBe("see <url> now");
    expect(sanitizeForLog("db postgresql://u:p@h:5432/d failed", plain)).toBe("db <db-url> failed");
    expect(sanitizeForLog("db postgres://u:p@h:5432/d failed", plain)).toBe("db <db-url> failed");
  });

  it("access_token、input_token、appsecret_proof の値と Bearer トークンを隠す", () => {
    const plain = new SecretRegistry();
    expect(sanitizeForLog("q=access_token=EAAB123&b=1", plain)).toBe("q=access_token=***&b=1");
    expect(sanitizeForLog("input_token=EAAB123 end", plain)).toBe("input_token=*** end");
    expect(sanitizeForLog("appsecret_proof=abcdef", plain)).toBe("appsecret_proof=***");
    expect(sanitizeForLog("Authorization: Bearer EAAB123 rest", plain)).toBe("Authorization: Bearer *** rest");
  });

  it("10 桁以上の数字列を隠し、9 桁以下と SQLSTATE は残す", () => {
    const plain = new SecretRegistry();
    expect(sanitizeForLog("id 123456789 ok", plain)).toBe("id 123456789 ok");
    expect(sanitizeForLog("id 1234567890 hidden", plain)).toBe("id *** hidden");
    expect(sanitizeForLog("Object with ID '17841400000000000' does not exist", plain)).toBe(
      "Object with ID '***' does not exist",
    );
    expect(sanitizeForLog("a 17841400000000000 b 18001234567890123 c", plain)).toBe("a *** b *** c");
    expect(sanitizeForLog("media 18001234567890123_17841400000000000", plain)).toBe("media ***_***");
    expect(sanitizeForLog("error_code=100 items=12 SQLSTATE 28P01 code 80004", plain)).toBe(
      "error_code=100 items=12 SQLSTATE 28P01 code 80004",
    );
  });

  it("URL の中の数字も含めて <url> になる", () => {
    const plain = new SecretRegistry();
    expect(sanitizeForLog("GET https://graph.facebook.com/v25.0/17841400000000000/media?x=1", plain)).toBe("GET <url>");
  });

  it("URL のパターン → 登録値 → 残りのパターンの順。登録値を含む URL も <url> になる", () => {
    const text = "https://graph.facebook.com/me?access_token=EAAB_ACCESS_TOKEN";
    const out = sanitizeForLog(text, secrets);
    expect(out).toBe("<url>");
    expect(out).not.toContain("EAAB_ACCESS_TOKEN");
  });

  it("ローカルの接続文字列（ユーザー名とパスワードが postgres）を登録しても <db-url> になり、登録値のマスクは残る", () => {
    const local = new SecretRegistry();
    local.addUrlParts("postgresql://postgres:postgres@127.0.0.1:54322/postgres");
    expect(
      sanitizeForLog("connect postgresql://postgres:postgres@127.0.0.1:54322/postgres failed", local),
    ).toBe("connect <db-url> failed");
    expect(sanitizeForLog('role "postgres" does not exist', local)).toBe('role "***" does not exist');
    expect(sanitizeForLog("role postgres does not exist", local)).toBe("role *** does not exist");
    expect(sanitizeForLog("host 127.0.0.1 refused", local)).toBe("host *** refused");
  });

  it("登録値のマスクがプレースホルダ <url> と <db-url> を壊さない（db が登録されていても）", () => {
    const registry = new SecretRegistry();
    registry.addUrlParts("postgresql://dbuser:dbpass@db.example:5432/db");
    registry.add("db");
    registry.add("url");
    expect(sanitizeForLog("Invalid URL: postgresql://dbuser:dbpass@db.example:5432/db", registry)).toBe(
      "Invalid URL: <db-url>",
    );
    expect(sanitizeForLog("see https://db.example/x and db", registry)).toBe("see <url> and ***");
    expect(sanitizeForLog("user dbuser host db.example", registry)).toBe("user *** host ***");
  });

  it("JSON の \"access_token\":\"…\" も隠す", () => {
    const plain = new SecretRegistry();
    expect(sanitizeForLog('{"access_token":"EAAB123","x":1}', plain)).toBe('{"access_token":"***","x":1}');
    expect(sanitizeForLog('{"input_token" : "EAAB123"}', plain)).toBe('{"input_token":"***"}');
    expect(sanitizeForLog('{"appsecret_proof":"abc"}', plain)).toBe('{"appsecret_proof":"***"}');
  });

  it("Meta のトークンの形（EAA…）を隠す", () => {
    const plain = new SecretRegistry();
    expect(sanitizeForLog("token EAABsbCS1iHgBAOZCZCx7ZBZAZCq9ZCq9 end", plain)).toBe("token *** end");
    // 短いものや単語の途中は対象外
    expect(sanitizeForLog("EAAB short", plain)).toBe("EAAB short");
  });

  it("JWT の形（サービスロールキーなど）を隠す", () => {
    const plain = new SecretRegistry();
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.abcdefghijklmnopqrstuvwxyz";
    expect(sanitizeForLog(`key ${jwt} end`, plain)).toBe("key *** end");
  });
});

describe("createLogger", () => {
  const fixedNow = () => new Date("2026-10-02T20:05:01.000Z");

  function capture(level: "info" | "debug", secrets = new SecretRegistry()): { lines: string[]; log: ReturnType<typeof createLogger> } {
    const lines: string[] = [];
    const log = createLogger(level, secrets, (line) => lines.push(line), fixedNow);
    return { lines, log };
  }

  it("1 行の形式: 時刻、5 文字幅のレベル、key=value", () => {
    const { lines, log } = capture("info");
    log.info({ job: "stories", status: "success", items: 4, calls: 13, failures: 0, duration_ms: 5120, rate: "2%" });
    expect(lines).toEqual([
      "2026-10-02T20:05:01.000Z INFO  job=stories status=success items=4 calls=13 failures=0 duration_ms=5120 rate=2%",
    ]);
  });

  it("WARN と DEBUG のラベル幅", () => {
    const { lines, log } = capture("debug");
    log.warn({ job: "media_snapshot", status: "partial" });
    log.debug({ job: "media_snapshot", progress: "120/300" });
    expect(lines).toEqual([
      "2026-10-02T20:05:01.000Z WARN  job=media_snapshot status=partial",
      "2026-10-02T20:05:01.000Z DEBUG job=media_snapshot progress=120/300",
    ]);
  });

  it("level が info のときは debug を出さない", () => {
    const { lines, log } = capture("info");
    log.debug({ job: "x" });
    log.info({ job: "y" });
    expect(lines).toEqual(["2026-10-02T20:05:01.000Z INFO  job=y"]);
  });

  it("undefined の項目は出さない。真偽値はそのまま", () => {
    const { lines, log } = capture("info");
    const fields: LogFields = { job: "x", error: undefined, full: true, gone: false };
    log.info(fields);
    expect(lines).toEqual(["2026-10-02T20:05:01.000Z INFO  job=x full=true gone=false"]);
  });

  it("数値もマスクを通す（10 桁以上の ID は隠れ、件数はそのまま）", () => {
    const { lines, log } = capture("info");
    log.info({ media_id: 17841400000000000, items: 12, rate: 2.5 });
    expect(lines).toEqual(["2026-10-02T20:05:01.000Z INFO  media_id=*** items=12 rate=2.5"]);
  });

  it("空白、=、\" を含む文字列は引用符で囲み、内側の \" はエスケープする", () => {
    const { lines, log } = capture("info");
    log.info({ error: "[100] Unsupported get request", a: "k=v", b: 'say "hi"', c: "plain" });
    expect(lines).toEqual([
      '2026-10-02T20:05:01.000Z INFO  error="[100] Unsupported get request" a="k=v" b="say \\"hi\\"" c=plain',
    ]);
  });

  it("文字列の値は sanitizeForLog を通す", () => {
    const secrets = new SecretRegistry();
    secrets.add("EAAB_ACCESS_TOKEN");
    const { lines, log } = capture("debug", secrets);
    log.debug({ error: "[190] token EAAB_ACCESS_TOKEN at https://graph.facebook.com/me for 17841400000000000" });
    expect(lines).toEqual(['2026-10-02T20:05:01.000Z DEBUG error="[190] token *** at <url> for ***"']);
  });

  it("改行は 1 行の形式を保つために \\n にする", () => {
    const { lines, log } = capture("info");
    log.warn({ error: "line1\nline2\r\nline3" });
    expect(lines).toEqual(['2026-10-02T20:05:01.000Z WARN  error=line1\\nline2\\nline3']);
  });

  it("既定の now は現在時刻", () => {
    const lines: string[] = [];
    const before = Date.now();
    const log = createLogger("info", new SecretRegistry(), (line) => lines.push(line));
    log.info({ job: "x" });
    const stamp = lines[0]?.slice(0, 24) ?? "";
    expect(new Date(stamp).getTime()).toBeGreaterThanOrEqual(before - 1);
    expect(new Date(stamp).getTime()).toBeLessThanOrEqual(Date.now() + 1);
  });
});
