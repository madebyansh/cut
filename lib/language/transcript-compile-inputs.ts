import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { defaultTranscriptLimits } from "../interchange/transcript";
import type {
  CutModule,
  Declaration,
  Expression,
  LanguageDiagnostic,
  SourceSpan,
  Statement,
  TimelineItem,
} from "./ast";
import type { CheckResult } from "./checker";
import type { CutCompileInputs } from "./compiler";
import { resolveLockedProjectPath } from "./lock";

export type CutTranscriptCompileInputResult = Readonly<{
  inputs: CutCompileInputs;
  diagnostics: readonly LanguageDiagnostic[];
}>;

type CutTranscriptCompileInputReadContext = Readonly<{
  resourceId: string;
  path: string;
  expectedBytes: number;
}>;

type CutTranscriptCompileInputTestHooks = Readonly<{
  __testAfterPathSnapshot?: (context: CutTranscriptCompileInputReadContext) => void | Promise<void>;
  __testAfterDescriptorSnapshot?: (context: CutTranscriptCompileInputReadContext) => void | Promise<void>;
  __testAfterBoundedRead?: (context: CutTranscriptCompileInputReadContext) => void | Promise<void>;
}>;

class CutTranscriptCompileInputReadError extends Error {}

function readFailure(message: string): never {
  throw new CutTranscriptCompileInputReadError(message);
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "filesystem";
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function stablePathStat(path: string, phase: "before" | "after") {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    readFailure(`cannot inspect the transcript DataAsset ${phase} its bounded read (${errorCode(error)}).`);
  }
}

async function readBoundedTranscriptSidecar(
  resourceId: string,
  path: string,
  expectedBytes: number,
  hooks: CutTranscriptCompileInputTestHooks,
) {
  const context = Object.freeze({ resourceId, path, expectedBytes });
  const pathBefore = await stablePathStat(path, "before");
  if (pathBefore.isSymbolicLink()
    || !pathBefore.isFile()
    || pathBefore.size !== BigInt(expectedBytes)) {
    readFailure("changed identity or size before its bounded read.");
  }
  await hooks.__testAfterPathSnapshot?.(context);

  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    readFailure("cannot be opened safely because this platform has no no-follow file-descriptor support.");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    try {
      handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      readFailure(`cannot be opened through a no-follow file descriptor (${errorCode(error)}).`);
    }
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()
      || before.size !== BigInt(expectedBytes)
      || !sameFileIdentity(pathBefore, before)) {
      readFailure("changed identity or size before its bounded read.");
    }
    await hooks.__testAfterDescriptorSnapshot?.(context);

    const bytes = Buffer.alloc(expectedBytes);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) readFailure("ended during its bounded read.");
      offset += result.bytesRead;
    }
    const overflow = Buffer.alloc(1);
    if ((await handle.read(overflow, 0, 1, expectedBytes)).bytesRead !== 0) {
      readFailure("grew during its bounded read.");
    }
    await hooks.__testAfterBoundedRead?.(context);

    const after = await handle.stat({ bigint: true });
    const pathAfter = await stablePathStat(path, "after");
    if (!after.isFile()
      || pathAfter.isSymbolicLink()
      || !pathAfter.isFile()
      || !sameFileIdentity(before, after)
      || !sameFileIdentity(after, pathAfter)) {
      readFailure("changed identity during its bounded read.");
    }
    return bytes;
  } catch (error) {
    if (error instanceof CutTranscriptCompileInputReadError) throw error;
    readFailure(`cannot be read through its bounded file descriptor (${errorCode(error)}).`);
  } finally {
    await handle?.close();
  }
}

function calleeName(expression: Expression): string | undefined {
  if (expression.kind === "identifier") return expression.name;
  if (expression.kind !== "member") return undefined;
  const parent = calleeName(expression.object);
  return parent ? `${parent}.${expression.property}` : undefined;
}

function expressionChildren(expression: Expression): Expression[] {
  if (expression.kind === "array") return expression.items;
  if (expression.kind === "object") return expression.entries.map((entry) => entry.value);
  if (expression.kind === "member" || expression.kind === "group" || expression.kind === "unary") return [expression.kind === "member" ? expression.object : expression.value];
  if (expression.kind === "index") return [expression.object, expression.index];
  if (expression.kind === "range") return [expression.start, expression.end];
  if (expression.kind === "binary") return [expression.left, expression.right];
  if (expression.kind === "call") return [expression.callee, ...expression.positional, ...expression.named.map((item) => item.value)];
  return [];
}

function walkExpression(expression: Expression, visit: (candidate: Expression) => void) {
  visit(expression);
  expressionChildren(expression).forEach((child) => walkExpression(child, visit));
}

function walkStatement(statement: Statement, visit: (candidate: Expression) => void) {
  if (statement.kind === "let") walkExpression(statement.value, visit);
  else if (statement.kind === "node") {
    walkExpression(statement.expression, visit);
    statement.body.forEach((child) => walkStatement(child, visit));
  } else if (statement.kind === "set") {
    walkExpression(statement.target, visit);
    walkExpression(statement.value, visit);
  } else if (statement.kind === "animate") {
    walkExpression(statement.target, visit);
    walkExpression(statement.from, visit);
    walkExpression(statement.to, visit);
    walkExpression(statement.duration, visit);
    if (statement.delay) walkExpression(statement.delay, visit);
    if (statement.easing) walkExpression(statement.easing, visit);
  } else if (statement.kind === "at") {
    walkExpression(statement.time, visit);
    statement.body.forEach((child) => walkStatement(child, visit));
  } else if (statement.kind === "for") {
    walkExpression(statement.iterable, visit);
    statement.body.forEach((child) => walkStatement(child, visit));
  } else if (statement.kind === "if") {
    walkExpression(statement.condition, visit);
    statement.consequent.forEach((child) => walkStatement(child, visit));
    statement.alternate.forEach((child) => walkStatement(child, visit));
  } else if (statement.kind === "assert") {
    walkExpression(statement.condition, visit);
  }
}

function walkTimelineItem(item: TimelineItem, visit: (candidate: Expression) => void) {
  if (item.kind === "scene") {
    item.arguments.forEach((argument) => walkExpression(argument.value, visit));
    item.body.forEach((statement) => walkStatement(statement, visit));
  } else walkStatement(item, visit);
}

function walkDeclaration(declaration: Declaration, visit: (candidate: Expression) => void) {
  if (declaration.kind === "asset" || declaration.kind === "const" || declaration.kind === "function" || declaration.kind === "export") {
    walkExpression(declaration.value, visit);
  } else if (declaration.kind === "component") {
    declaration.parameters.forEach((parameter) => {
      if (parameter.defaultValue) walkExpression(parameter.defaultValue, visit);
    });
    declaration.body.forEach((statement) => walkStatement(statement, visit));
  } else if (declaration.kind === "timeline") {
    declaration.arguments.forEach((argument) => walkExpression(argument.value, visit));
    declaration.items.forEach((item) => walkTimelineItem(item, visit));
  }
}

function transcriptCalls(module: CutModule, check: CheckResult) {
  const localNames = new Set([...check.imports]
    .filter(([, imported]) => imported.symbol.lowering === "transcript-edit")
    .map(([local]) => local));
  const calls: Array<Extract<Expression, { kind: "call" }>> = [];
  for (const declaration of module.declarations) walkDeclaration(declaration, (expression) => {
    if (expression.kind === "call" && localNames.has(calleeName(expression.callee) ?? "")) calls.push(expression);
  });
  return calls;
}

function callArgument(
  expression: Extract<Expression, { kind: "call" }>,
  name: string,
  position: number,
) {
  return expression.named.find((argument) => argument.name === name)?.value
    ?? expression.positional[position];
}

function directDataLocator(asset: Extract<Declaration, { kind: "asset" }>, check: CheckResult) {
  if (asset.value.kind !== "call") return undefined;
  const constructorName = calleeName(asset.value.callee);
  const symbol = constructorName ? check.symbols.get(constructorName)?.packageSymbol : undefined;
  if (symbol?.native !== "cut.asset.data" && symbol?.native !== "cut.asset.transcript") return undefined;
  const path = callArgument(asset.value, "path", 0);
  return path?.kind === "string" ? path.value : undefined;
}

function resolveTranscriptDataAsset(
  argument: Expression | undefined,
  assets: ReadonlyMap<string, Extract<Declaration, { kind: "asset" }>>,
  constants: ReadonlyMap<string, Extract<Declaration, { kind: "const" }>>,
) {
  if (argument?.kind !== "identifier") return undefined;
  let name = argument.name;
  const seen = new Set<string>();
  for (let depth = 0; depth < 64; depth += 1) {
    const asset = assets.get(name);
    if (asset) return asset;
    if (seen.has(name)) return undefined;
    seen.add(name);
    const declaration = constants.get(name);
    if (!declaration || declaration.value.kind !== "identifier") return undefined;
    name = declaration.value.name;
  }
  return undefined;
}

function diagnostic(code: string, message: string, span: SourceSpan): LanguageDiagnostic {
  return { severity: "error", code, message, span };
}

/**
 * Securely preload only transcript sidecars referenced by direct
 * transcriptEdit calls. Ordinary DataAssets remain untouched.
 */
export async function loadCutTranscriptCompileInputs(
  entryPath: string,
  module: CutModule,
  check: CheckResult,
  hooks: CutTranscriptCompileInputTestHooks = {},
): Promise<CutTranscriptCompileInputResult> {
  const calls = transcriptCalls(module, check);
  if (!calls.length) return { inputs: {}, diagnostics: [] };
  const assets = new Map(module.declarations
    .filter((declaration): declaration is Extract<Declaration, { kind: "asset" }> => declaration.kind === "asset")
    .map((declaration) => [declaration.name, declaration]));
  const constants = new Map(module.declarations
    .filter((declaration): declaration is Extract<Declaration, { kind: "const" }> => declaration.kind === "const")
    .map((declaration) => [declaration.name, declaration]));
  const requested = new Map<string, { locator: string; span: SourceSpan }>();
  for (const call of calls) {
    const argument = callArgument(call, "transcript", 0);
    const asset = resolveTranscriptDataAsset(argument, assets, constants);
    if (!asset) continue;
    const locator = directDataLocator(asset, check);
    if (locator === undefined) continue;
    const previous = requested.get(asset.name);
    if (previous && previous.locator !== locator) {
      return {
        inputs: {},
        diagnostics: [diagnostic(
          "CUT_TRANSCRIPT_RESOURCE",
          `Transcript DataAsset ${asset.name} resolves to conflicting project locators.`,
          argument?.span ?? call.span,
        )],
      };
    }
    requested.set(asset.name, { locator, span: argument?.span ?? call.span });
  }
  if (!requested.size) return { inputs: {}, diagnostics: [] };

  const projectRoot = dirname(resolve(entryPath));
  const sidecars = new Map<string, Uint8Array>();
  const diagnostics: LanguageDiagnostic[] = [];
  for (const [resourceId, request] of [...requested].sort(([left], [right]) => left.localeCompare(right))) {
    try {
      const resolved = await resolveLockedProjectPath(projectRoot, request.locator);
      if (!Number.isSafeInteger(resolved.bytes)
        || resolved.bytes < 1
        || resolved.bytes > defaultTranscriptLimits.maxBytes) {
        diagnostics.push(diagnostic(
          "CUT_TRANSCRIPT_LIMIT",
          `Transcript DataAsset ${resourceId} must contain 1 through ${defaultTranscriptLimits.maxBytes} bytes; found ${resolved.bytes}.`,
          request.span,
        ));
        continue;
      }
      const bytes = await readBoundedTranscriptSidecar(
        resourceId,
        resolved.path,
        resolved.bytes,
        hooks,
      );
      sidecars.set(resourceId, bytes);
    } catch (error) {
      diagnostics.push(diagnostic(
        "CUT_TRANSCRIPT_RESOURCE",
        `Cannot securely load transcript DataAsset ${resourceId}: ${error instanceof Error ? error.message : String(error)}`,
        request.span,
      ));
    }
  }
  return {
    inputs: sidecars.size ? { transcriptSidecars: sidecars } : {},
    diagnostics,
  };
}
