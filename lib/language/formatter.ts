import { Buffer } from "node:buffer";
import type {
  CutModule,
  Declaration,
  Expression,
  LanguageDiagnostic,
  SceneDeclaration,
  Statement,
  TypeReference,
} from "./ast";
import { lexCut, type Token } from "./lexer";
import { parseCutLanguage } from "./parser";

export type CutFormatErrorCode =
  | "CUT_FORMAT_INVALID_INPUT"
  | "CUT_FORMAT_INVALID_OPTIONS"
  | "CUT_FORMAT_INPUT_LIMIT"
  | "CUT_FORMAT_OUTPUT_LIMIT"
  | "CUT_FORMAT_SYNTAX"
  | "CUT_FORMAT_INVARIANT";

export type CutFormatOptions = {
  /** Spaces per statement-block indentation level. */
  indentWidth?: number;
  /** Maximum UTF-8 input size accepted by this formatting operation. */
  maxInputBytes?: number;
  /** Maximum UTF-8 output size produced by this formatting operation. */
  maxOutputBytes?: number;
};

type CutFormatErrorDetails = {
  diagnostic?: LanguageDiagnostic;
  limit?: number;
  actual?: number;
  cause?: unknown;
};

export class CutFormatError extends Error {
  readonly name = "CutFormatError";
  readonly diagnostic?: LanguageDiagnostic;
  readonly limit?: number;
  readonly actual?: number;

  constructor(readonly code: CutFormatErrorCode, message: string, details: CutFormatErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.diagnostic = details.diagnostic;
    this.limit = details.limit;
    this.actual = details.actual;
  }
}

const DEFAULT_INPUT_LIMIT = 8 * 1024 * 1024;
const DEFAULT_OUTPUT_LIMIT = 32 * 1024 * 1024;
const HARD_INPUT_LIMIT = 16 * 1024 * 1024;
const HARD_OUTPUT_LIMIT = 64 * 1024 * 1024;

type NormalizedOptions = Required<CutFormatOptions>;

function positiveIntegerOption(
  name: keyof CutFormatOptions,
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0 || result > maximum) {
    throw new CutFormatError(
      "CUT_FORMAT_INVALID_OPTIONS",
      `CUT formatter option “${name}” must be a positive integer no greater than ${maximum}.`,
      { limit: maximum, actual: result },
    );
  }
  return result;
}

function normalizeOptions(options: CutFormatOptions): NormalizedOptions {
  return {
    indentWidth: positiveIntegerOption("indentWidth", options.indentWidth, 2, 8),
    maxInputBytes: positiveIntegerOption("maxInputBytes", options.maxInputBytes, DEFAULT_INPUT_LIMIT, HARD_INPUT_LIMIT),
    maxOutputBytes: positiveIntegerOption("maxOutputBytes", options.maxOutputBytes, DEFAULT_OUTPUT_LIMIT, HARD_OUTPUT_LIMIT),
  };
}

class BoundedWriter {
  private readonly chunks: string[] = [];
  private pending = "";
  private bytes = 0;
  private lineStart = true;
  private trailingNewlines = 0;
  private lastCharacter = "";

  constructor(private readonly maximumBytes: number, private readonly indentWidth: number) {}

  get hasLineContent(): boolean { return !this.lineStart; }

  private append(value: string): void {
    if (!value) return;
    const bytes = Buffer.byteLength(value, "utf8");
    if (this.bytes + bytes > this.maximumBytes) {
      throw new CutFormatError(
        "CUT_FORMAT_OUTPUT_LIMIT",
        `Formatted CUT output exceeds the ${this.maximumBytes}-byte UTF-8 limit.`,
        { limit: this.maximumBytes, actual: this.bytes + bytes },
      );
    }
    if (this.pending.length > 0 && this.pending.length + value.length > 64 * 1024) {
      this.chunks.push(this.pending);
      this.pending = "";
    }
    if (value.length > 64 * 1024) this.chunks.push(value);
    else this.pending += value;
    this.bytes += bytes;
    this.lastCharacter = value[value.length - 1] ?? this.lastCharacter;
    const lastLineFeed = value.lastIndexOf("\n");
    // CUT's lexer advances logical lines and terminates // comments on LF.
    // Treating a bare CR as a structural break here would let a following
    // token remain inside the lexer comment, so layout follows that contract.
    this.lineStart = lastLineFeed === value.length - 1;
    this.trailingNewlines = this.lineStart ? this.trailingNewlines + 1 : 0;
  }

  write(value: string, indentation: number): void {
    if (!value) return;
    if (this.lineStart) this.append(" ".repeat(Math.max(0, indentation) * this.indentWidth));
    this.append(value);
  }

  space(): void {
    if (this.hasLineContent && this.lastCharacter !== " " && this.lastCharacter !== "\t") this.append(" ");
  }

  newlines(count = 1): void {
    if (this.bytes === 0) return;
    if (!this.lineStart) this.append("\n");
    while (this.trailingNewlines < count) this.append("\n");
  }

  finish(): string {
    if (this.pending) this.chunks.push(this.pending);
    return this.chunks.join("");
  }
}

type CommentTrivia = {
  kind: "comment";
  offset: number;
  line: number;
  inline: boolean;
  text: string;
};

type TokenItem = { kind: "token"; offset: number; token: Token; raw: string };
type FormatItem = CommentTrivia | TokenItem;

function sourceLineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) if (source.charCodeAt(index) === 10) starts.push(index + 1);
  return starts;
}

function sourceLineAt(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function commentsInTrivia(source: string, lineStarts: number[], start: number, end: number): CommentTrivia[] {
  const comments: CommentTrivia[] = [];
  let cursor = start;
  while (cursor < end) {
    const offset = source.indexOf("//", cursor);
    if (offset < 0 || offset >= end) break;
    let commentEnd = offset + 2;
    // Match the lexer exactly: a CUT line comment terminates at LF. A CR is
    // preserved as authored comment text, including in CRLF input.
    while (commentEnd < end && source[commentEnd] !== "\n") commentEnd += 1;
    const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
    comments.push({
      kind: "comment",
      offset,
      line: sourceLineAt(lineStarts, offset),
      inline: source.slice(lineStart, offset).trim().length > 0,
      text: source.slice(offset, commentEnd),
    });
    cursor = commentEnd;
  }
  return comments;
}

function collectItems(source: string, tokens: Token[]): { items: FormatItem[]; comments: CommentTrivia[] } {
  const items: FormatItem[] = [];
  const comments: CommentTrivia[] = [];
  const lineStarts = sourceLineStarts(source);
  let cursor = 0;
  for (const token of tokens) {
    const found = commentsInTrivia(source, lineStarts, cursor, token.span.start.offset);
    comments.push(...found);
    items.push(...found);
    if (token.kind !== "eof") {
      items.push({
        kind: "token",
        offset: token.span.start.offset,
        token,
        raw: source.slice(token.span.start.offset, token.span.end.offset),
      });
      cursor = token.span.end.offset;
    } else cursor = token.span.start.offset;
  }
  return { items, comments };
}

type SyntaxRoles = {
  inlineBraceOpen: Set<number>;
  inlineBraceClose: Set<number>;
  arrayLiteralOpen: Set<number>;
  groupOpen: Set<number>;
  typeOpen: Set<number>;
  typeClose: Set<number>;
  unaryOperator: Set<number>;
  rangeOperator: Set<number>;
};

function classifySyntax(module: CutModule, tokens: Token[]): SyntaxRoles {
  const roles: SyntaxRoles = {
    inlineBraceOpen: new Set(),
    inlineBraceClose: new Set(),
    arrayLiteralOpen: new Set(),
    groupOpen: new Set(),
    typeOpen: new Set(),
    typeClose: new Set(),
    unaryOperator: new Set(),
    rangeOperator: new Set(),
  };

  const significant = tokens.filter((token) => token.kind !== "eof");
  const starts = new Map(significant.map((token) => [token.span.start.offset, token]));
  const ends = new Map(significant.map((token) => [token.span.end.offset, token]));
  const lowerBound = (offset: number): number => {
    let low = 0;
    let high = significant.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (significant[middle].span.start.offset < offset) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const tokenEndingAt = (offset: number, value: string) => {
    const token = ends.get(offset);
    return token?.value === value ? token : undefined;
  };
  const tokenStartingAt = (offset: number, value: string) => {
    const token = starts.get(offset);
    return token?.value === value ? token : undefined;
  };
  const tokensInside = (start: number, end: number) => {
    const inside: Token[] = [];
    for (let index = lowerBound(start); index < significant.length && significant[index].span.end.offset <= end; index += 1) inside.push(significant[index]);
    return inside;
  };

  const visitType = (type: TypeReference): void => {
    if (type.arguments.length > 0) {
      const inside = tokensInside(type.span.start.offset, type.span.end.offset);
      const open = inside.find((token) => token.value === "<");
      const close = tokenEndingAt(type.span.end.offset, ">");
      if (open) roles.typeOpen.add(open.span.start.offset);
      if (close) roles.typeClose.add(close.span.start.offset);
    }
    for (const argument of type.arguments) visitType(argument);
  };

  const visitExpression = (expression: Expression): void => {
    switch (expression.kind) {
      case "array":
        roles.arrayLiteralOpen.add(expression.span.start.offset);
        for (const item of expression.items) visitExpression(item);
        return;
      case "object": {
        roles.inlineBraceOpen.add(expression.span.start.offset);
        const close = tokenEndingAt(expression.span.end.offset, "}");
        if (close) roles.inlineBraceClose.add(close.span.start.offset);
        for (const entry of expression.entries) visitExpression(entry.value);
        return;
      }
      case "group":
        roles.groupOpen.add(expression.span.start.offset);
        visitExpression(expression.value);
        return;
      case "member":
        visitExpression(expression.object);
        return;
      case "index":
        visitExpression(expression.object);
        visitExpression(expression.index);
        return;
      case "range": {
        visitExpression(expression.start);
        visitExpression(expression.end);
        const operator = tokensInside(expression.start.span.end.offset, expression.end.span.start.offset)
          .find((token) => token.value === ".." || token.value === "..<");
        if (operator) roles.rangeOperator.add(operator.span.start.offset);
        return;
      }
      case "call":
        visitExpression(expression.callee);
        for (const argument of expression.positional) visitExpression(argument);
        for (const argument of expression.named) visitExpression(argument.value);
        return;
      case "unary":
        roles.unaryOperator.add(expression.span.start.offset);
        visitExpression(expression.value);
        return;
      case "binary":
        visitExpression(expression.left);
        visitExpression(expression.right);
        return;
      default:
        return;
    }
  };

  const visitStatement = (statement: Statement): void => {
    switch (statement.kind) {
      case "let":
        if (statement.type) visitType(statement.type);
        visitExpression(statement.value);
        return;
      case "node":
        visitExpression(statement.expression);
        for (const child of statement.body) visitStatement(child);
        return;
      case "set":
        visitExpression(statement.target);
        visitExpression(statement.value);
        return;
      case "animate":
        visitExpression(statement.target);
        visitExpression(statement.from);
        visitExpression(statement.to);
        visitExpression(statement.duration);
        if (statement.delay) visitExpression(statement.delay);
        if (statement.easing) visitExpression(statement.easing);
        return;
      case "at":
        visitExpression(statement.time);
        for (const child of statement.body) visitStatement(child);
        return;
      case "for":
        visitExpression(statement.iterable);
        for (const child of statement.body) visitStatement(child);
        return;
      case "if":
        visitExpression(statement.condition);
        for (const child of statement.consequent) visitStatement(child);
        for (const child of statement.alternate) visitStatement(child);
        return;
      case "assert":
        visitExpression(statement.condition);
        return;
    }
  };

  const visitScene = (scene: SceneDeclaration): void => {
    for (const argument of scene.arguments) visitExpression(argument.value);
    for (const statement of scene.body) visitStatement(statement);
  };

  const visitDeclaration = (declaration: Declaration): void => {
    switch (declaration.kind) {
      case "import": {
        const inside = tokensInside(declaration.span.start.offset, declaration.span.end.offset);
        const open = inside.find((token) => token.value === "{");
        const close = inside.find((token) => token.value === "}");
        if (open) roles.inlineBraceOpen.add(open.span.start.offset);
        if (close) roles.inlineBraceClose.add(close.span.start.offset);
        return;
      }
      case "asset":
        if (declaration.assetType) visitType(declaration.assetType);
        visitExpression(declaration.value);
        return;
      case "const":
        if (declaration.type) visitType(declaration.type);
        visitExpression(declaration.value);
        return;
      case "function":
        for (const parameter of declaration.parameters) {
          visitType(parameter.type);
          if (parameter.defaultValue) visitExpression(parameter.defaultValue);
        }
        visitType(declaration.returnType);
        visitExpression(declaration.value);
        return;
      case "component":
        for (const parameter of declaration.parameters) {
          visitType(parameter.type);
          if (parameter.defaultValue) visitExpression(parameter.defaultValue);
        }
        if (declaration.returnType) visitType(declaration.returnType);
        for (const statement of declaration.body) visitStatement(statement);
        return;
      case "timeline":
        for (const argument of declaration.arguments) visitExpression(argument.value);
        for (const item of declaration.items) {
          if (item.kind === "scene") visitScene(item);
          else visitStatement(item);
        }
        return;
      case "export":
        visitExpression(declaration.value);
        return;
      default:
        return;
    }
  };

  for (const declaration of module.declarations) visitDeclaration(declaration);

  // A valid object/group/array span must begin on its opening token. Failing
  // closed here keeps future grammar additions from being formatted as blocks.
  for (const offset of roles.inlineBraceOpen) {
    if (!tokenStartingAt(offset, "{")) throw new CutFormatError("CUT_FORMAT_INVARIANT", `Object/import brace classification failed at offset ${offset}.`);
  }
  for (const offset of roles.arrayLiteralOpen) {
    if (!tokenStartingAt(offset, "[")) throw new CutFormatError("CUT_FORMAT_INVARIANT", `Array classification failed at offset ${offset}.`);
  }
  for (const offset of roles.groupOpen) {
    if (!tokenStartingAt(offset, "(")) throw new CutFormatError("CUT_FORMAT_INVARIANT", `Group classification failed at offset ${offset}.`);
  }
  return roles;
}

type TokenRole =
  | "block-open"
  | "block-close"
  | "inline-open"
  | "inline-close"
  | "array-open"
  | "index-open"
  | "bracket-close"
  | "group-open"
  | "paren-open"
  | "paren-close"
  | "type-open"
  | "type-close"
  | "unary"
  | "range"
  | "ordinary";

function tokenRole(item: TokenItem, roles: SyntaxRoles): TokenRole {
  const { token, offset } = item;
  if (token.value === "{") return roles.inlineBraceOpen.has(offset) ? "inline-open" : "block-open";
  if (token.value === "}") return roles.inlineBraceClose.has(offset) ? "inline-close" : "block-close";
  if (token.value === "[") return roles.arrayLiteralOpen.has(offset) ? "array-open" : "index-open";
  if (token.value === "]") return "bracket-close";
  if (token.value === "(") return roles.groupOpen.has(offset) ? "group-open" : "paren-open";
  if (token.value === ")") return "paren-close";
  if (token.value === "<" && roles.typeOpen.has(offset)) return "type-open";
  if (token.value === ">" && roles.typeClose.has(offset)) return "type-close";
  if ((token.value === "-" || token.value === "!") && roles.unaryOperator.has(offset)) return "unary";
  if ((token.value === ".." || token.value === "..<") && roles.rangeOperator.has(offset)) return "range";
  return "ordinary";
}

function isOpeningRole(role: TokenRole): boolean {
  return role === "inline-open" || role === "array-open" || role === "index-open" || role === "group-open" || role === "paren-open" || role === "type-open";
}

function needsSpace(previous: TokenItem | undefined, current: TokenItem, roles: SyntaxRoles): boolean {
  if (!previous) return false;
  const previousRole = tokenRole(previous, roles);
  const currentRole = tokenRole(current, roles);
  const previousValue = previous.token.value;
  const currentValue = current.token.value;

  if (currentRole === "block-open") return true;
  if (currentRole === "block-close") return false;
  if (currentRole === "inline-open") return previousRole !== "unary" && previousRole !== "range" && previousValue !== "(" && previousValue !== "[" && previousValue !== "{";
  if (currentRole === "array-open") return previousRole !== "unary" && previousRole !== "range" && !isOpeningRole(previousRole) && previousValue !== ".";
  if (currentRole === "index-open") return false;
  if (currentRole === "group-open") return previousRole !== "unary" && previousRole !== "range" && !isOpeningRole(previousRole) && previousValue !== ".";
  if (currentRole === "paren-open") return false;
  if (currentRole === "type-open") return false;
  if (currentRole === "inline-close") return previousRole !== "inline-open";
  if (currentRole === "type-close" || currentRole === "paren-close" || currentRole === "bracket-close") return false;
  if (currentRole === "unary") return previousRole !== "unary" && !isOpeningRole(previousRole) && previousValue !== ".";
  if (currentRole === "range") return false;

  if (currentValue === ";" || currentValue === "," || currentValue === ":" || currentValue === ".") return false;
  if (current.token.kind === "operator") return true;
  if (previousRole === "inline-open") return true;
  if (isOpeningRole(previousRole) || previousValue === ".") return false;
  if (previousRole === "unary" || previousRole === "range" || previousRole === "type-open") return false;
  if (previousValue === ":" || previousValue === "," || previous.token.kind === "operator") return true;
  return true;
}

function formatValidatedSource(source: string, module: CutModule, tokens: Token[], options: NormalizedOptions): string {
  const roles = classifySyntax(module, tokens);
  const { items } = collectItems(source, tokens);
  const writer = new BoundedWriter(options.maxOutputBytes, options.indentWidth);
  let blockDepth = 0;
  const inlineContainers: TokenRole[] = [];
  let previousToken: TokenItem | undefined;
  let deferredBreak = 0;

  const indentation = () => blockDepth + (inlineContainers.length > 0 ? 1 : 0);
  const isTrailingComment = (index: number, token: TokenItem): boolean => {
    const next = items[index + 1];
    return next?.kind === "comment" && next.inline && next.line === token.token.span.end.line;
  };

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.kind === "comment") {
      if (item.inline && writer.hasLineContent) writer.space();
      else if (writer.hasLineContent) writer.newlines(1);
      writer.write(item.text, indentation());
      writer.newlines(deferredBreak || 1);
      deferredBreak = 0;
      previousToken = undefined;
      continue;
    }

    const role = tokenRole(item, roles);
    if (role === "block-close") {
      if (blockDepth === 0) throw new CutFormatError("CUT_FORMAT_INVARIANT", `Unmatched statement-block close at offset ${item.offset}.`);
      blockDepth -= 1;
    }
    if (role === "inline-close" || role === "bracket-close" || role === "paren-close" || role === "type-close") {
      const opening = inlineContainers.pop();
      const matches = role === "inline-close" ? opening === "inline-open"
        : role === "bracket-close" ? opening === "array-open" || opening === "index-open"
          : role === "paren-close" ? opening === "group-open" || opening === "paren-open"
            : opening === "type-open";
      if (!matches) throw new CutFormatError("CUT_FORMAT_INVARIANT", `Mismatched inline delimiter at offset ${item.offset}.`);
    }

    if (writer.hasLineContent && needsSpace(previousToken, item, roles)) writer.space();
    writer.write(item.raw, indentation());

    if (role === "block-open") blockDepth += 1;
    if (role === "inline-open" || role === "array-open" || role === "index-open" || role === "group-open" || role === "paren-open" || role === "type-open") inlineContainers.push(role);

    const next = items[index + 1];
    const trailingComment = isTrailingComment(index, item);
    const afterTrailingIndex = index + (trailingComment ? 2 : 1);
    const hasFollowingItem = afterTrailingIndex < items.length;
    const compactEmptyBlock = role === "block-open" && next?.kind === "token" && tokenRole(next, roles) === "block-close";
    let desiredBreak = 0;
    if (role === "block-open" && !compactEmptyBlock) desiredBreak = 1;
    else if (role === "block-close") {
      const followedByElse = next?.kind === "token" && next.token.value === "else";
      if (!followedByElse) desiredBreak = blockDepth === 0 && hasFollowingItem ? 2 : 1;
    } else if (item.token.value === ";") desiredBreak = blockDepth === 0 && hasFollowingItem ? 2 : 1;

    if (desiredBreak > 0) {
      if (trailingComment) deferredBreak = desiredBreak;
      else writer.newlines(desiredBreak);
    }
    previousToken = desiredBreak > 0 && !trailingComment ? undefined : item;
  }

  if (blockDepth !== 0 || inlineContainers.length !== 0) {
    throw new CutFormatError("CUT_FORMAT_INVARIANT", "CUT formatter delimiter accounting did not close at end of file.");
  }
  if (writer.hasLineContent) writer.newlines(1);
  return writer.finish();
}

function sameTokenStream(firstSource: string, first: Token[], secondSource: string, second: Token[]): boolean {
  if (first.length !== second.length) return false;
  for (let index = 0; index < first.length; index += 1) {
    const left = first[index];
    const right = second[index];
    if (left.kind !== right.kind || left.value !== right.value || (left.unit ?? null) !== (right.unit ?? null)) return false;
    if (left.kind === "number" || left.kind === "string" || left.kind === "color") {
      const leftSpelling = firstSource.slice(left.span.start.offset, left.span.end.offset);
      const rightSpelling = secondSource.slice(right.span.start.offset, right.span.end.offset);
      if (leftSpelling !== rightSpelling) return false;
    }
  }
  return true;
}

/**
 * Format a complete CUT 0.4 module.
 *
 * The formatter is deliberately syntax-preserving: the existing CUT parser
 * validates the input, original literal token spellings are emitted verbatim,
 * and the output is parsed and token-compared before it is returned.
 */
export function formatCutSource(source: string, options: CutFormatOptions = {}): string {
  if (typeof source !== "string") {
    throw new CutFormatError("CUT_FORMAT_INVALID_INPUT", "CUT formatter input must be a string.");
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new CutFormatError("CUT_FORMAT_INVALID_OPTIONS", "CUT formatter options must be an object.");
  }
  const normalized = normalizeOptions(options);
  const inputBytes = Buffer.byteLength(source, "utf8");
  if (inputBytes > normalized.maxInputBytes) {
    throw new CutFormatError(
      "CUT_FORMAT_INPUT_LIMIT",
      `CUT source is ${inputBytes} UTF-8 bytes, exceeding the ${normalized.maxInputBytes}-byte formatter input limit.`,
      { limit: normalized.maxInputBytes, actual: inputBytes },
    );
  }

  const parsed = parseCutLanguage(source);
  if (!parsed.module) {
    const diagnostic = parsed.diagnostics[0];
    const location = diagnostic ? ` at ${diagnostic.span.start.line}:${diagnostic.span.start.column}` : "";
    throw new CutFormatError(
      "CUT_FORMAT_SYNTAX",
      `Cannot format invalid CUT source${location}: ${diagnostic?.message ?? "unknown syntax error"}`,
      { diagnostic },
    );
  }

  const originalTokens = lexCut(source);
  const originalComments = collectItems(source, originalTokens).comments.map((comment) => comment.text);
  const formatted = formatValidatedSource(source, parsed.module, originalTokens, normalized);
  const reparsed = parseCutLanguage(formatted);
  if (!reparsed.module) {
    throw new CutFormatError(
      "CUT_FORMAT_INVARIANT",
      `CUT formatter produced invalid source: ${reparsed.diagnostics[0]?.message ?? "unknown syntax error"}`,
      { diagnostic: reparsed.diagnostics[0] },
    );
  }

  const formattedTokens = lexCut(formatted);
  if (!sameTokenStream(source, originalTokens, formatted, formattedTokens)) {
    throw new CutFormatError("CUT_FORMAT_INVARIANT", "CUT formatter changed the source token stream or a literal spelling.");
  }
  const formattedComments = collectItems(formatted, formattedTokens).comments.map((comment) => comment.text);
  if (originalComments.length !== formattedComments.length
    || originalComments.some((comment, index) => comment !== formattedComments[index])) {
    throw new CutFormatError("CUT_FORMAT_INVARIANT", "CUT formatter changed or reordered a line comment.");
  }
  return formatted;
}
