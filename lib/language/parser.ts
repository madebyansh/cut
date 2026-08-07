import type { CutModule, Declaration, Expression, LanguageDiagnostic, Parameter, SceneDeclaration, SourceSpan, Statement, TimelineItem, TypeReference } from "./ast";
import { CutLexerError, lexCut, type Token } from "./lexer";

class ParseFailure extends Error {
  constructor(message: string, readonly token: Token, readonly hint?: string) { super(message); }
}

const binaryPrecedence: Record<string, number> = { "||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, "<=": 4, ">": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6 };
const merge = (start: SourceSpan, end: SourceSpan): SourceSpan => ({ start: start.start, end: end.end });
const maximumParseDepth = 256;
export const maximumParseDiagnostics = 256;

class Parser {
  private index = 0;
  private blockDepth = 0;
  private expressionDepth = 0;
  private typeDepth = 0;
  private readonly diagnostics: LanguageDiagnostic[] = [];
  private readonly diagnosticIdentities = new Set<string>();
  private diagnosticLimitReached = false;
  constructor(private readonly source: string, private readonly tokens: Token[]) {}
  private current() { return this.tokens[this.index]; }
  private peek(distance = 1) { return this.tokens[Math.min(this.index + distance, this.tokens.length - 1)]; }
  private consume() { return this.tokens[this.index++]; }
  private is(value: string) { return this.current().value === value; }
  private match(value: string) { if (!this.is(value)) return undefined; return this.consume(); }
  private expect(value: string, hint?: string) {
    if (!this.is(value)) throw new ParseFailure(`Expected “${value}”, found “${this.current().value || "end of file"}”.`, this.current(), hint);
    return this.consume();
  }
  private identifier(context: string) {
    const token = this.current();
    if (token.kind !== "identifier") throw new ParseFailure(`Expected ${context}, found “${token.value || "end of file"}”.`, token);
    this.consume(); return token;
  }
  private string(context: string) {
    const token = this.current();
    if (token.kind !== "string") throw new ParseFailure(`Expected ${context} string.`, token);
    this.consume(); return token;
  }
  private semicolon() { return this.expect(";", "CUT statements end with a semicolon."); }

  private recordParseFailure(error: ParseFailure) {
    if (this.diagnosticLimitReached) return;
    const diagnostic: LanguageDiagnostic = {
      severity: "error",
      code: "CUT1002",
      message: error.message,
      span: error.token.span,
      ...(error.hint === undefined ? {} : { hint: error.hint }),
    };
    const identity = `${diagnostic.code}:${diagnostic.span.start.offset}:${diagnostic.span.end.offset}:${diagnostic.message}`;
    if (this.diagnosticIdentities.has(identity)) return;
    this.diagnosticIdentities.add(identity);
    if (this.diagnostics.length === maximumParseDiagnostics - 1) {
      this.diagnostics.push({
        severity: "error",
        code: "CUT_DIAGNOSTIC_LIMIT",
        message: `CUT syntax diagnostics reached the bounded limit of ${maximumParseDiagnostics}.`,
        span: error.token.span,
        hint: "Repair the reported syntax errors before requesting another diagnostic pass.",
      });
      this.diagnosticLimitReached = true;
      return;
    }
    this.diagnostics.push(diagnostic);
  }

  private synchronize(startIndex: number, boundary: "top-level" | "nested") {
    const failureIndex = this.index;
    const blockDeclaration = boundary === "top-level"
      && ["component", "timeline"].includes(this.tokens[startIndex]?.value ?? "");
    let braces = 0, brackets = 0, parentheses = 0, sawBrace = false;
    for (let cursor = startIndex; cursor < this.tokens.length; cursor += 1) {
      const token = this.tokens[cursor]!;
      if (token.kind === "eof") { this.index = cursor; return; }
      if (token.kind !== "punctuation") continue;
      if (token.value === "{") { braces += 1; sawBrace = true; }
      else if (token.value === "[") brackets += 1;
      else if (token.value === "(") parentheses += 1;
      else if (token.value === "}") {
        if (braces === 0) {
          if (cursor >= failureIndex && boundary === "nested") { this.index = cursor; return; }
        } else {
          braces -= 1;
          if (cursor >= failureIndex && blockDeclaration && sawBrace && braces === 0 && brackets === 0 && parentheses === 0) {
            this.index = cursor + 1;
            return;
          }
          if (cursor >= failureIndex && boundary === "nested" && sawBrace && braces === 0 && brackets === 0 && parentheses === 0) {
            this.index = cursor + 1;
            return;
          }
        }
      } else if (token.value === "]") brackets = Math.max(0, brackets - 1);
      else if (token.value === ")") parentheses = Math.max(0, parentheses - 1);
      else if (token.value === ";" && cursor >= failureIndex && braces === 0) {
        this.index = cursor + 1;
        return;
      }
    }
    this.index = this.tokens.length - 1;
  }

  parseModule(): { module: CutModule | null; diagnostics: LanguageDiagnostic[] } {
    const declarations: Declaration[] = []; const start = this.current().span;
    while (this.current().kind !== "eof" && !this.diagnosticLimitReached) {
      const declarationStart = this.index;
      try {
        declarations.push(this.declaration());
      } catch (error) {
        if (!(error instanceof ParseFailure)) throw error;
        this.recordParseFailure(error);
        this.synchronize(declarationStart, "top-level");
        if (this.index <= declarationStart) this.index = Math.min(declarationStart + 1, this.tokens.length - 1);
      }
    }
    const diagnostics = [...this.diagnostics].sort((left, right) =>
      left.span.start.offset - right.span.start.offset
      || left.span.end.offset - right.span.end.offset
      || left.code.localeCompare(right.code));
    return {
      module: diagnostics.length
        ? null
        : { kind: "module", source: this.source, declarations, span: merge(start, this.current().span) },
      diagnostics,
    };
  }

  private declaration(): Declaration {
    const keyword = this.identifier("a top-level declaration");
    if (keyword.value === "cut") {
      const version = this.current(); if (version.kind !== "number") throw new ParseFailure("Expected a CUT language version such as 0.4.", version);
      if (version.unit) throw new ParseFailure("A CUT language version cannot have a unit.", version);
      if (version.value !== "0.4") throw new ParseFailure(`Unsupported CUT language version “${version.value}”.`, version, "This compiler supports cut 0.4.");
      this.consume(); const end = this.semicolon(); return { kind: "language", version: version.value, span: merge(keyword.span, end.span) };
    }
    if (keyword.value === "project") {
      const name = this.string("project name"); const end = this.semicolon(); return { kind: "project", name: name.value, span: merge(keyword.span, end.span) };
    }
    if (keyword.value === "import") return this.importDeclaration(keyword);
    if (keyword.value === "asset") return this.valueDeclaration(keyword, "asset");
    if (keyword.value === "const") return this.valueDeclaration(keyword, "const");
    if (keyword.value === "function") return this.functionDeclaration(keyword);
    if (keyword.value === "component") return this.componentDeclaration(keyword);
    if (keyword.value === "timeline") return this.timelineDeclaration(keyword);
    if (keyword.value === "export") {
      const name = this.identifier("export name"); this.expect("="); const value = this.expression(); const end = this.semicolon();
      return { kind: "export", name: name.value, value, span: merge(keyword.span, end.span) };
    }
    throw new ParseFailure(`Unknown top-level declaration “${keyword.value}”.`, keyword, "Use cut, project, import, asset, const, function, component, timeline, or export.");
  }

  private importDeclaration(start: Token): Declaration {
    this.expect("{"); const names: Array<{ imported: string; local: string }> = [];
    while (!this.is("}")) {
      const imported = this.identifier("import name"); let local = imported.value;
      if (this.match("as")) local = this.identifier("local import name").value;
      names.push({ imported: imported.value, local });
      if (!this.match(",") || this.is("}")) break;
    }
    this.expect("}"); this.expect("from"); const moduleSpecifier = this.string("module specifier"); const end = this.semicolon();
    return { kind: "import", names, module: moduleSpecifier.value, span: merge(start.span, end.span) };
  }

  private valueDeclaration(start: Token, kind: "asset" | "const"): Declaration {
    const name = this.identifier(`${kind} name`); const type = this.match(":") ? this.typeReference() : undefined;
    this.expect("="); const value = this.expression(); const end = this.semicolon();
    return { kind, name: name.value, ...(kind === "asset" ? { assetType: type } : { type }), value, span: merge(start.span, end.span) } as Declaration;
  }

  private typeReference(): TypeReference {
    this.typeDepth += 1;
    if (this.typeDepth > maximumParseDepth) { this.typeDepth -= 1; throw new ParseFailure(`CUT type nesting exceeds ${maximumParseDepth}.`, this.current()); }
    try {
      const name = this.identifier("type name"); const args: TypeReference[] = [];
      if (this.match("<")) {
        do args.push(this.typeReference()); while (this.match(","));
        const end = this.expect(">"); return { kind: "type", name: name.value, arguments: args, span: merge(name.span, end.span) };
      }
      return { kind: "type", name: name.value, arguments: [], span: name.span };
    } finally { this.typeDepth -= 1; }
  }

  private parameters(): Parameter[] {
    const parameters: Parameter[] = []; this.expect("(");
    while (!this.is(")")) {
      const name = this.identifier("parameter name"); this.expect(":"); const type = this.typeReference();
      const defaultValue = this.match("=") ? this.expression() : undefined;
      parameters.push({ name: name.value, type, defaultValue, span: merge(name.span, defaultValue?.span ?? type.span) });
      if (!this.match(",") || this.is(")")) break;
    }
    this.expect(")"); return parameters;
  }

  private componentDeclaration(start: Token): Declaration {
    const name = this.identifier("component name"); const parameters = this.parameters();
    const returnType = this.match("->") ? this.typeReference() : undefined;
    const { body, end } = this.block();
    return { kind: "component", name: name.value, parameters, returnType, body, span: merge(start.span, end.span) };
  }

  private functionDeclaration(start: Token): Declaration {
    const name = this.identifier("function name");
    const parameters = this.parameters();
    this.expect("->", "Pure CUT functions require an explicit return type.");
    const returnType = this.typeReference();
    this.expect("=", "Pure CUT functions use one compile-time expression body.");
    const value = this.expression();
    const end = this.semicolon();
    return { kind: "function", name: name.value, parameters, returnType, value, span: merge(start.span, end.span) };
  }

  private namedArguments() {
    const args: Array<{ name: string; value: Expression; span: SourceSpan }> = []; this.expect("(");
    while (!this.is(")")) {
      const name = this.identifier("argument name"); this.expect(":"); const value = this.expression();
      args.push({ name: name.value, value, span: merge(name.span, value.span) });
      if (!this.match(",") || this.is(")")) break;
    }
    this.expect(")"); return args;
  }

  private timelineDeclaration(start: Token): Declaration {
    const name = this.identifier("timeline name"); const args = this.namedArguments(); this.expect("{");
    const items: TimelineItem[] = [];
    while (!this.is("}") && this.current().kind !== "eof" && !this.diagnosticLimitReached) {
      const itemStart = this.index;
      try {
        items.push(this.is("scene") ? this.sceneDeclaration() : this.statement());
      } catch (error) {
        if (!(error instanceof ParseFailure)) throw error;
        this.recordParseFailure(error);
        this.synchronize(itemStart, "nested");
        if (this.index <= itemStart && !this.is("}")) this.index = Math.min(itemStart + 1, this.tokens.length - 1);
      }
    }
    const end = this.expect("}"); return { kind: "timeline", name: name.value, arguments: args, items, span: merge(start.span, end.span) };
  }

  private sceneDeclaration(): SceneDeclaration {
    const start = this.expect("scene"); const name = this.identifier("scene name"); const args = this.namedArguments(); const block = this.block();
    return { kind: "scene", name: name.value, arguments: args, body: block.body, span: merge(start.span, block.end.span) };
  }

  private block() {
    this.blockDepth += 1;
    if (this.blockDepth > maximumParseDepth) { this.blockDepth -= 1; throw new ParseFailure(`CUT block nesting exceeds ${maximumParseDepth}.`, this.current()); }
    try {
      this.expect("{"); const body: Statement[] = [];
      while (!this.is("}") && this.current().kind !== "eof" && !this.diagnosticLimitReached) {
        const statementStart = this.index;
        try {
          body.push(this.statement());
        } catch (error) {
          if (!(error instanceof ParseFailure)) throw error;
          this.recordParseFailure(error);
          this.synchronize(statementStart, "nested");
          if (this.index <= statementStart && !this.is("}")) this.index = Math.min(statementStart + 1, this.tokens.length - 1);
        }
      }
      return { body, end: this.expect("}") };
    } finally { this.blockDepth -= 1; }
  }

  private statement(): Statement {
    const token = this.current();
    if (token.kind !== "identifier") throw new ParseFailure("Expected a statement.", token);
    if (token.value === "let") {
      const start = this.consume(); const name = this.identifier("binding name"); const type = this.match(":") ? this.typeReference() : undefined;
      this.expect("="); const value = this.expression(); const end = this.semicolon(); return { kind: "let", name: name.value, type, value, span: merge(start.span, end.span) };
    }
    if (token.value === "set") {
      const start = this.consume(); const target = this.target(); this.expect("="); const value = this.expression(); const end = this.semicolon();
      return { kind: "set", target, value, span: merge(start.span, end.span) };
    }
    if (token.value === "animate") return this.animateStatement();
    if (token.value === "at") {
      const start = this.consume(); const time = this.expression(); const block = this.block(); return { kind: "at", time, body: block.body, span: merge(start.span, block.end.span) };
    }
    if (token.value === "for") {
      const start = this.consume(); const item = this.identifier("loop binding"); this.expect("in"); const iterable = this.expression(); const block = this.block();
      return { kind: "for", item: item.value, iterable, body: block.body, span: merge(start.span, block.end.span) };
    }
    if (token.value === "if") {
      const start = this.consume(); const condition = this.expression(); const consequent = this.block(); let alternate: Statement[] = []; let end = consequent.end;
      if (this.match("else")) { const block = this.block(); alternate = block.body; end = block.end; }
      return { kind: "if", condition, consequent: consequent.body, alternate, span: merge(start.span, end.span) };
    }
    if (token.value === "assert") {
      const start = this.consume(); const condition = this.expression(); const message = this.match(",") ? this.string("assertion message").value : undefined; const end = this.semicolon();
      return { kind: "assert", condition, message, span: merge(start.span, end.span) };
    }
    const expression = this.expression();
    if (expression.kind !== "call") throw new ParseFailure("A node statement must call a component.", token);
    const binding = this.match("as") ? this.identifier("node binding").value : undefined;
    if (this.is("{")) { const block = this.block(); return { kind: "node", expression, binding, body: block.body, span: merge(expression.span, block.end.span) }; }
    const end = this.semicolon(); return { kind: "node", expression, binding, body: [], span: merge(expression.span, end.span) };
  }

  private target() {
    let value: Expression = { kind: "identifier", name: this.identifier("assignment target").value, span: this.tokens[this.index - 1].span };
    while (this.match(".")) {
      const property = this.identifier("property name"); value = { kind: "member", object: value, property: property.value, span: merge(value.span, property.span) };
    }
    if (value.kind !== "identifier" && value.kind !== "member") throw new ParseFailure("Invalid assignment target.", this.current());
    return value;
  }

  private animateStatement(): Statement {
    const start = this.expect("animate"); const target = this.target(); this.expect("from"); const from = this.expression(); this.expect("to"); const to = this.expression(); this.expect("over"); const duration = this.expression();
    const delay = this.match("delay") ? this.expression() : undefined; const easing = this.match("ease") ? this.expression() : undefined; const end = this.semicolon();
    return { kind: "animate", target, from, to, duration, delay, easing, span: merge(start.span, end.span) };
  }

  private expression(minimumPrecedence = 0): Expression {
    this.expressionDepth += 1;
    if (this.expressionDepth > maximumParseDepth) { this.expressionDepth -= 1; throw new ParseFailure(`CUT expression nesting exceeds ${maximumParseDepth}.`, this.current()); }
    try {
      let left = this.prefix();
      while (true) {
        if (this.is(".")) {
          this.consume(); const property = this.identifier("property name"); left = { kind: "member", object: left, property: property.value, span: merge(left.span, property.span) }; continue;
        }
        if (this.is("(")) { left = this.callExpression(left); continue; }
        if (this.is("[")) {
          this.consume(); const index = this.expression(); const end = this.expect("]");
          left = { kind: "index", object: left, index, span: merge(left.span, end.span) }; continue;
        }
        if (this.is("..") || this.is("..<")) {
          if (minimumPrecedence > 0) break;
          const operator = this.consume(); const end = this.expression(1);
          left = { kind: "range", start: left, end, exclusive: operator.value === "..<", span: merge(left.span, end.span) }; continue;
        }
        const precedence = binaryPrecedence[this.current().value] ?? -1;
        if (precedence < minimumPrecedence) break;
        const operator = this.consume(); const right = this.expression(precedence + 1);
        left = { kind: "binary", operator: operator.value as Extract<Expression, { kind: "binary" }>["operator"], left, right, span: merge(left.span, right.span) };
      }
      return left;
    } finally { this.expressionDepth -= 1; }
  }

  private prefix(): Expression {
    const token = this.current();
    if (token.value === "-" || token.value === "!") { this.consume(); const value = this.expression(7); return { kind: "unary", operator: token.value as "-" | "!", value, span: merge(token.span, value.span) }; }
    if (token.kind === "number") { this.consume(); return { kind: "number", value: Number(token.value), unit: token.unit ?? "", raw: `${token.value}${token.unit ?? ""}`, span: token.span }; }
    if (token.kind === "string") { this.consume(); return { kind: "string", value: token.value, span: token.span }; }
    if (token.kind === "color") { this.consume(); return { kind: "color", value: token.value, span: token.span }; }
    if (token.value === "true" || token.value === "false") { this.consume(); return { kind: "boolean", value: token.value === "true", span: token.span }; }
    if (token.value === "null") { this.consume(); return { kind: "null", span: token.span }; }
    if (token.kind === "identifier") { this.consume(); return { kind: "identifier", name: token.value, span: token.span }; }
    if (this.match("[")) {
      const items: Expression[] = []; const start = token.span;
      while (!this.is("]")) { items.push(this.expression()); if (!this.match(",") || this.is("]")) break; }
      const end = this.expect("]"); return { kind: "array", items, span: merge(start, end.span) };
    }
    if (this.match("{")) {
      const entries: Array<{ key: string; value: Expression; span: SourceSpan }> = []; const start = token.span;
      while (!this.is("}")) {
        const key = this.current().kind === "string" ? this.consume() : this.identifier("object key"); this.expect(":"); const value = this.expression();
        entries.push({ key: key.value, value, span: merge(key.span, value.span) }); if (!this.match(",") || this.is("}")) break;
      }
      const end = this.expect("}"); return { kind: "object", entries, span: merge(start, end.span) };
    }
    if (this.match("(")) { const value = this.expression(); const end = this.expect(")"); return { kind: "group", value, span: merge(token.span, end.span) }; }
    throw new ParseFailure(`Expected an expression, found “${token.value || "end of file"}”.`, token);
  }

  private callExpression(callee: Expression): Expression {
    this.expect("("); const positional: Expression[] = []; const named: Array<{ name: string; value: Expression; span: SourceSpan }> = [];
    let sawNamed = false;
    while (!this.is(")")) {
      if (this.current().kind === "identifier" && this.peek().value === ":") {
        sawNamed = true; const name = this.consume(); this.consume(); const value = this.expression();
        if (named.some((item) => item.name === name.value)) throw new ParseFailure(`Argument “${name.value}” is supplied more than once.`, name);
        named.push({ name: name.value, value, span: merge(name.span, value.span) });
      } else {
        if (sawNamed) throw new ParseFailure("Positional arguments cannot follow named arguments.", this.current());
        positional.push(this.expression());
      }
      if (!this.match(",") || this.is(")")) break;
    }
    const end = this.expect(")"); return { kind: "call", callee, positional, named, span: merge(callee.span, end.span) };
  }
}

export function parseCutLanguage(source: string): { module: CutModule | null; diagnostics: LanguageDiagnostic[] } {
  try {
    const parser = new Parser(source, lexCut(source));
    return parser.parseModule();
  } catch (error) {
    if (error instanceof CutLexerError) return { module: null, diagnostics: [{ severity: "error", code: "CUT1001", message: error.message, span: error.span }] };
    if (error instanceof ParseFailure) return { module: null, diagnostics: [{ severity: "error", code: "CUT1002", message: error.message, span: error.token.span, hint: error.hint }] };
    throw error;
  }
}
