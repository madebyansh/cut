export type SourcePosition = { offset: number; line: number; column: number };
export type SourceSpan = { start: SourcePosition; end: SourcePosition };

export type Unit = "" | "ms" | "s" | "f" | "beat" | "px" | "%" | "deg" | "rad" | "db" | "hz" | "khz" | "lufs" | "dbtp" | "dbfs";

export type TypeReference = {
  kind: "type";
  name: string;
  arguments: TypeReference[];
  span: SourceSpan;
};

export type LiteralExpression =
  | { kind: "number"; value: number; unit: Unit; raw: string; span: SourceSpan }
  | { kind: "string"; value: string; span: SourceSpan }
  | { kind: "boolean"; value: boolean; span: SourceSpan }
  | { kind: "null"; span: SourceSpan }
  | { kind: "color"; value: string; span: SourceSpan };

export type Expression = LiteralExpression
  | { kind: "identifier"; name: string; span: SourceSpan }
  | { kind: "array"; items: Expression[]; span: SourceSpan }
  | { kind: "object"; entries: Array<{ key: string; value: Expression; span: SourceSpan }>; span: SourceSpan }
  | { kind: "member"; object: Expression; property: string; span: SourceSpan }
  | { kind: "index"; object: Expression; index: Expression; span: SourceSpan }
  | { kind: "range"; start: Expression; end: Expression; exclusive: boolean; span: SourceSpan }
  | { kind: "group"; value: Expression; span: SourceSpan }
  | { kind: "call"; callee: Expression; positional: Expression[]; named: Array<{ name: string; value: Expression; span: SourceSpan }>; span: SourceSpan }
  | { kind: "unary"; operator: "-" | "!"; value: Expression; span: SourceSpan }
  | { kind: "binary"; operator: "+" | "-" | "*" | "/" | "%" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "&&" | "||"; left: Expression; right: Expression; span: SourceSpan };

export type Parameter = {
  name: string;
  type: TypeReference;
  defaultValue?: Expression;
  span: SourceSpan;
};

export type Statement =
  | { kind: "let"; name: string; type?: TypeReference; value: Expression; span: SourceSpan }
  | { kind: "node"; expression: Extract<Expression, { kind: "call" }>; binding?: string; body: Statement[]; span: SourceSpan }
  | { kind: "set"; target: Extract<Expression, { kind: "identifier" | "member" }>; value: Expression; span: SourceSpan }
  | { kind: "animate"; target: Extract<Expression, { kind: "identifier" | "member" }>; from: Expression; to: Expression; duration: Expression; delay?: Expression; easing?: Expression; span: SourceSpan }
  | { kind: "at"; time: Expression; body: Statement[]; span: SourceSpan }
  | { kind: "for"; item: string; iterable: Expression; body: Statement[]; span: SourceSpan }
  | { kind: "if"; condition: Expression; consequent: Statement[]; alternate: Statement[]; span: SourceSpan }
  | { kind: "assert"; condition: Expression; message?: string; span: SourceSpan };

export type Declaration =
  | { kind: "language"; version: string; span: SourceSpan }
  | { kind: "project"; name: string; span: SourceSpan }
  | { kind: "import"; names: Array<{ imported: string; local: string }>; module: string; span: SourceSpan }
  | { kind: "asset"; name: string; assetType?: TypeReference; value: Expression; span: SourceSpan }
  | { kind: "const"; name: string; type?: TypeReference; value: Expression; span: SourceSpan }
  | { kind: "function"; name: string; parameters: Parameter[]; returnType: TypeReference; value: Expression; span: SourceSpan }
  | { kind: "component"; name: string; parameters: Parameter[]; returnType?: TypeReference; body: Statement[]; span: SourceSpan }
  | { kind: "timeline"; name: string; arguments: Array<{ name: string; value: Expression; span: SourceSpan }>; items: TimelineItem[]; span: SourceSpan }
  | { kind: "export"; name: string; value: Expression; span: SourceSpan };

export type SceneDeclaration = {
  kind: "scene";
  name: string;
  arguments: Array<{ name: string; value: Expression; span: SourceSpan }>;
  body: Statement[];
  span: SourceSpan;
};

export type TimelineItem = SceneDeclaration | Statement;

export type CutModule = {
  kind: "module";
  source: string;
  declarations: Declaration[];
  span: SourceSpan;
};

export type LanguageDiagnostic = {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  span: SourceSpan;
  hint?: string;
  /** Canonical project-relative source module when the diagnostic is not in the entry source. */
  module?: string;
};
