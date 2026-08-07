import { packageFail } from "./diagnostics";

export type CutPackageJsonLimits = {
  maxInputBytes: number;
  maxDepth: number;
  maxNodes: number;
  maxStringBytes: number;
  maxTotalStringBytes: number;
};

export const defaultCutPackageJsonLimits: Readonly<CutPackageJsonLimits> = Object.freeze({
  maxInputBytes: 1024 * 1024,
  maxDepth: 32,
  maxNodes: 100_000,
  maxStringBytes: 64 * 1024,
  maxTotalStringBytes: 512 * 1024,
});

function strictText(value: string, path: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) packageFail("CUT_PACKAGE_JSON_ENCODING", path, "contains an unpaired UTF-16 surrogate.");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) packageFail("CUT_PACKAGE_JSON_ENCODING", path, "contains an unpaired UTF-16 surrogate.");
  }
  return value;
}

function resolveLimits(overrides: Partial<CutPackageJsonLimits>): CutPackageJsonLimits {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) packageFail("CUT_PACKAGE_JSON_TYPE", "$.options.limits", "must be a plain object.");
  const allowed = new Set(Object.keys(defaultCutPackageJsonLimits));
  for (const [name, value] of Object.entries(overrides)) {
    if (!allowed.has(name)) packageFail("CUT_PACKAGE_JSON_UNKNOWN_FIELD", `$.options.limits.${name}`, "is not a supported JSON limit.");
    const ceiling = defaultCutPackageJsonLimits[name as keyof CutPackageJsonLimits];
    if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > ceiling) packageFail("CUT_PACKAGE_JSON_LIMIT", `$.options.limits.${name}`, `must be between 1 and the hard ceiling ${ceiling}.`);
  }
  return { ...defaultCutPackageJsonLimits, ...overrides };
}

class StrictJsonScanner {
  private offset = 0;
  private nodes = 0;
  private totalStringBytes = 0;

  constructor(private readonly source: string, private readonly limits: CutPackageJsonLimits) {}

  scan() {
    this.space();
    this.value(0, "$", false);
    this.space();
    if (this.offset !== this.source.length) this.syntax("unexpected trailing input");
  }

  private syntax(message: string): never {
    packageFail("CUT_PACKAGE_JSON_PARSE", "$", `${message} at text offset ${this.offset}.`);
  }

  private space() {
    while (this.offset < this.source.length && /\s/.test(this.source[this.offset])) this.offset += 1;
  }

  private value(depth: number, path: string, key: boolean) {
    this.nodes += 1;
    if (this.nodes > this.limits.maxNodes) packageFail("CUT_PACKAGE_JSON_LIMIT", path, `exceeds maxNodes (${this.limits.maxNodes}).`);
    if (depth > this.limits.maxDepth) packageFail("CUT_PACKAGE_JSON_LIMIT", path, `exceeds maxDepth (${this.limits.maxDepth}).`);
    this.space();
    const character = this.source[this.offset];
    if (character === "{") return this.object(depth, path);
    if (character === "[") return this.array(depth, path);
    if (character === '"') return this.string(path, key);
    if (this.source.startsWith("true", this.offset)) { this.offset += 4; return; }
    if (this.source.startsWith("false", this.offset)) { this.offset += 5; return; }
    if (this.source.startsWith("null", this.offset)) { this.offset += 4; return; }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.source.slice(this.offset));
    if (!number) this.syntax("expected a JSON value");
    this.offset += number[0].length;
  }

  private string(path: string, key: boolean): string {
    const start = this.offset;
    this.offset += 1;
    while (this.offset < this.source.length) {
      const character = this.source[this.offset];
      if (character === '"') {
        this.offset += 1;
        let decoded: unknown;
        try { decoded = JSON.parse(this.source.slice(start, this.offset)); }
        catch { this.syntax("invalid JSON string"); }
        if (typeof decoded !== "string") this.syntax("invalid JSON string");
        strictText(decoded, path);
        const bytes = Buffer.byteLength(decoded, "utf8");
        if (bytes > this.limits.maxStringBytes) packageFail("CUT_PACKAGE_JSON_LIMIT", path, `string exceeds ${this.limits.maxStringBytes} UTF-8 bytes.`);
        this.totalStringBytes += bytes;
        if (this.totalStringBytes > this.limits.maxTotalStringBytes) packageFail("CUT_PACKAGE_JSON_LIMIT", path, `strings exceed ${this.limits.maxTotalStringBytes} UTF-8 bytes in total.`);
        if (key && (decoded === "__proto__" || decoded === "prototype" || decoded === "constructor")) packageFail("CUT_PACKAGE_UNSAFE_KEY", path, `unsafe object key ${JSON.stringify(decoded)} is forbidden.`);
        return decoded;
      }
      if (character === "\\") {
        this.offset += 1;
        if (this.offset >= this.source.length) this.syntax("unterminated escape");
        if (this.source[this.offset] === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(this.source.slice(this.offset + 1, this.offset + 5))) this.syntax("invalid Unicode escape");
          this.offset += 5;
        } else {
          if (!/["\\/bfnrt]/.test(this.source[this.offset])) this.syntax("invalid string escape");
          this.offset += 1;
        }
        continue;
      }
      if (character.charCodeAt(0) < 0x20) this.syntax("unescaped control character in string");
      this.offset += 1;
    }
    this.syntax("unterminated JSON string");
  }

  private object(depth: number, path: string) {
    this.offset += 1;
    this.space();
    const keys = new Set<string>();
    if (this.source[this.offset] === "}") { this.offset += 1; return; }
    while (true) {
      if (this.source[this.offset] !== '"') this.syntax("expected an object key");
      const key = this.string(path, true);
      if (keys.has(key)) packageFail("CUT_PACKAGE_JSON_DUPLICATE_KEY", path, `contains duplicate decoded key ${JSON.stringify(key)}.`);
      keys.add(key);
      this.space();
      if (this.source[this.offset] !== ":") this.syntax("expected ':' after object key");
      this.offset += 1;
      this.value(depth + 1, `${path}[${JSON.stringify(key)}]`, false);
      this.space();
      if (this.source[this.offset] === "}") { this.offset += 1; return; }
      if (this.source[this.offset] !== ",") this.syntax("expected ',' or '}'");
      this.offset += 1;
      this.space();
    }
  }

  private array(depth: number, path: string) {
    this.offset += 1;
    this.space();
    if (this.source[this.offset] === "]") { this.offset += 1; return; }
    let index = 0;
    while (true) {
      this.value(depth + 1, `${path}[${index}]`, false);
      index += 1;
      this.space();
      if (this.source[this.offset] === "]") { this.offset += 1; return; }
      if (this.source[this.offset] !== ",") this.syntax("expected ',' or ']'");
      this.offset += 1;
      this.space();
    }
  }
}

export function parseStrictPackageJson(input: string | Uint8Array, options: { limits?: Partial<CutPackageJsonLimits> } = {}): unknown {
  if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some((key) => key !== "limits")) packageFail("CUT_PACKAGE_JSON_UNKNOWN_FIELD", "$.options", "contains an unsupported option.");
  const limits = resolveLimits(options.limits ?? {});
  let source: string;
  if (typeof input === "string") {
    strictText(input, "$input");
    source = input;
  } else if (input instanceof Uint8Array) {
    try { source = new TextDecoder("utf-8", { fatal: true }).decode(input); }
    catch { packageFail("CUT_PACKAGE_JSON_ENCODING", "$input", "is not valid UTF-8."); }
  } else packageFail("CUT_PACKAGE_JSON_TYPE", "$input", "must be a string or Uint8Array.");
  const bytes = Buffer.byteLength(source, "utf8");
  if (bytes > limits.maxInputBytes) packageFail("CUT_PACKAGE_JSON_LIMIT", "$input", `is ${bytes} bytes; limit is ${limits.maxInputBytes}.`);
  new StrictJsonScanner(source, limits).scan();
  try { return JSON.parse(source) as unknown; }
  catch (error) { packageFail("CUT_PACKAGE_JSON_PARSE", "$", error instanceof Error ? error.message : "invalid JSON."); }
}
