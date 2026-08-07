import type { SourcePosition, SourceSpan, Unit } from "./ast";

export type TokenKind = "identifier" | "number" | "string" | "color" | "punctuation" | "operator" | "eof";
export type Token = { kind: TokenKind; value: string; unit?: Unit; span: SourceSpan };

const units = new Set<Unit>(["", "ms", "s", "f", "beat", "px", "%", "deg", "rad", "db", "hz", "khz", "lufs", "dbtp", "dbfs"]);

function position(offset: number, line: number, column: number): SourcePosition { return { offset, line, column }; }

export class CutLexerError extends Error {
  constructor(message: string, readonly span: SourceSpan) { super(message); }
}

export function lexCut(source: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0, line = 1, column = 1;
  const here = () => position(offset, line, column);
  const advance = () => {
    const character = source[offset++];
    if (character === "\n") { line += 1; column = 1; } else column += 1;
    return character;
  };
  const emit = (kind: TokenKind, value: string, start: SourcePosition, unit?: Unit) => tokens.push({ kind, value, unit, span: { start, end: here() } });

  while (offset < source.length) {
    const character = source[offset];
    if (/\s/.test(character)) { advance(); continue; }
    if (character === "/" && source[offset + 1] === "/") {
      while (offset < source.length && source[offset] !== "\n") advance();
      continue;
    }
    const start = here();
    if (character === '"') {
      advance(); let value = ""; let closed = false;
      while (offset < source.length) {
        const current = advance();
        if (current === '"') { closed = true; break; }
        if (current === "\\") {
          if (offset >= source.length) break;
          const escaped = advance();
          const replacements: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };
          if (!(escaped in replacements)) throw new CutLexerError(`Unknown string escape “\\${escaped}”.`, { start, end: here() });
          value += replacements[escaped];
        } else value += current;
      }
      if (!closed) throw new CutLexerError("Unterminated string literal.", { start, end: here() });
      emit("string", value, start); continue;
    }
    if (character === "#" && /^[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\b/.test(source.slice(offset + 1))) {
      advance(); let value = "#";
      while (/[0-9a-fA-F]/.test(source[offset] ?? "") && value.length < 9) value += advance();
      emit("color", value.toLowerCase(), start); continue;
    }
    if (/\d/.test(character) || character === "." && /\d/.test(source[offset + 1] ?? "")) {
      let value = "";
      while (/\d/.test(source[offset] ?? "")) value += advance();
      if (source[offset] === "." && source[offset + 1] !== ".") { value += advance(); while (/\d/.test(source[offset] ?? "")) value += advance(); }
      let suffix = "";
      while (/[a-zA-Z%]/.test(source[offset] ?? "")) suffix += advance().toLowerCase();
      if (!units.has(suffix as Unit)) throw new CutLexerError(`Unknown numeric unit “${suffix}”.`, { start, end: here() });
      emit("number", value, start, suffix as Unit); continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      let value = "";
      while (/[A-Za-z0-9_]/.test(source[offset] ?? "")) value += advance();
      emit("identifier", value, start); continue;
    }
    const two = source.slice(offset, offset + 2);
    const three = source.slice(offset, offset + 3);
    if (three === "..<") { advance(); advance(); advance(); emit("operator", three, start); continue; }
    if (["->", "..", "==", "!=", "<=", ">=", "&&", "||"].includes(two)) { advance(); advance(); emit("operator", two, start); continue; }
    if (["+", "-", "*", "/", "%", "=", "!", "<", ">"].includes(character)) { emit("operator", advance(), start); continue; }
    if (["{", "}", "(", ")", "[", "]", ":", ";", ",", "."].includes(character)) { emit("punctuation", advance(), start); continue; }
    const unexpected = String.fromCodePoint(source.codePointAt(offset)!);
    for (let index = 0; index < unexpected.length; index += 1) advance();
    throw new CutLexerError(`Unexpected character “${unexpected}”.`, { start, end: here() });
  }
  const end = here(); tokens.push({ kind: "eof", value: "", span: { start: end, end } });
  return tokens;
}
