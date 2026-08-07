import type { CutAVIR, IRValue } from "./ir";
import { builtinPackages } from "./packages";
import { cutDomainAssertionPredicates } from "./domain-assertions";
import { cutAnchoredSpatialOps } from "./anchored-path-contract";
import {
  cutTimelineAudioOriginOp,
  cutTimelineAudioViewOp,
} from "./timeline-edit-audio-origin-contract";

export class CutIrResolutionError extends Error {
  constructor(readonly path: string, message: string) { super(`CUT IR is unresolved at ${path}: ${message}`); }
}

const intrinsicSymbols = new Set(["cut:intrinsic#linear"]);
const sourcePackageSpecifier = /^(?:@[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/)?[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const sourcePackageVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const packageIntegrity = /^[a-f0-9]{64}$/;

function canonicalSymbol(value: string) {
  const hash = value.lastIndexOf("#"), at = hash > 0 ? value.lastIndexOf("@", hash) : -1;
  if (hash <= 0 || at <= 0) return undefined;
  return { specifier: value.slice(0, at), version: value.slice(at + 1, hash), symbol: value.slice(hash + 1) };
}

function registeredOps(ir: CutAVIR) {
  const all = new Set<string>(), values = new Set<string>();
  for (let index = 0; index < ir.modules.length; index += 1) {
    const pinnedModule = ir.modules[index];
    const package_ = builtinPackages.get(pinnedModule.specifier);
    if (!package_) {
      // Source packages are fully expanded to ordinary CUT nodes by the
      // compiler. Their pin remains in the IR for identity/cache invalidation,
      // but it contributes no runtime operation that could bypass this closed
      // executable-kernel registry.
      if (!sourcePackageSpecifier.test(pinnedModule.specifier) || pinnedModule.specifier.startsWith("@cut/")) throw new CutIrResolutionError(`modules[${index}].specifier`, `source package specifier “${pinnedModule.specifier}” is invalid or reserved`);
      if (!sourcePackageVersion.test(pinnedModule.version)) throw new CutIrResolutionError(`modules[${index}].version`, `source package “${pinnedModule.specifier}” has an invalid semantic version`);
      if (!packageIntegrity.test(pinnedModule.integrity)) throw new CutIrResolutionError(`modules[${index}].integrity`, `source package “${pinnedModule.specifier}” has an invalid integrity digest`);
      continue;
    }
    if (package_.version !== pinnedModule.version || package_.integrity !== pinnedModule.integrity) throw new CutIrResolutionError(`modules[${index}]`, `package “${pinnedModule.specifier}” does not match an executable built-in implementation`);
    for (const symbol of Object.values(package_.symbols)) {
      if (symbol.native) all.add(symbol.native);
      if (symbol.kind === "function" && symbol.returns === "Easing" && symbol.native) values.add(symbol.native);
      if (pinnedModule.specifier === "cut:visual" && symbol.lowering === "anchored-spatial-call") {
        const op = cutAnchoredSpatialOps[symbol.name as keyof typeof cutAnchoredSpatialOps];
        if (!op) throw new CutIrResolutionError(`modules[${index}]`, `anchored spatial lowering ${symbol.name} has no registered persisted value operation`);
        values.add(op);
      }
    }
    // These nodes are persisted executable @cut/edit implementation details,
    // but intentionally have no public constructor symbol. They may appear
    // only after the compiler lowers an authored TimelineEdit.
    if (pinnedModule.specifier === "@cut/edit") {
      all.add(cutTimelineAudioOriginOp);
      all.add(cutTimelineAudioViewOp);
    }
  }
  return { all, values };
}

function assertValue(ir: CutAVIR, value: IRValue, path: string, valueOps: Set<string>): void {
  if (["null", "boolean", "string", "color", "quantity"].includes(value.kind)) return;
  if (value.kind === "array") { value.items.forEach((item, index) => assertValue(ir, item, `${path}[${index}]`, valueOps)); return; }
  if (value.kind === "object") { Object.entries(value.entries).forEach(([key, item]) => assertValue(ir, item, `${path}.${key}`, valueOps)); return; }
  if (value.kind === "range") { assertValue(ir, value.start, `${path}.start`, valueOps); assertValue(ir, value.end, `${path}.end`, valueOps); return; }
  if (value.kind === "resource-ref") {
    if (!ir.resources[value.id]) throw new CutIrResolutionError(path, `resource “${value.id}” does not exist`);
    return;
  }
  if (value.kind === "timeline-ref") {
    if (!ir.compositions.some((item) => item.id === value.id)) throw new CutIrResolutionError(path, `timeline “${value.id}” does not exist`);
    return;
  }
  if (value.kind === "node-ref") {
    if (!ir.nodes[value.id]) throw new CutIrResolutionError(path, `node “${value.id}” does not exist`);
    return;
  }
  if (value.kind === "symbol") {
    if (intrinsicSymbols.has(value.name)) return;
    const symbol = canonicalSymbol(value.name), pinnedModule = symbol && ir.modules.find((item) => item.specifier === symbol.specifier && item.version === symbol.version);
    const package_ = symbol && builtinPackages.get(symbol.specifier), packageSymbol = symbol && pinnedModule && package_?.symbols[symbol.symbol];
    if (!symbol || !pinnedModule || pinnedModule.integrity !== package_?.integrity || packageSymbol?.kind !== "value") throw new CutIrResolutionError(path, `symbol “${value.name}” is not a pinned package value or CUT intrinsic`);
    return;
  }
  if (value.kind === "call") {
    if (!valueOps.has(value.op)) throw new CutIrResolutionError(path, `call “${value.op}” was not reduced to a runtime value kernel`);
    value.positional.forEach((item, index) => assertValue(ir, item, `${path}.positional[${index}]`, valueOps));
    Object.entries(value.named).forEach(([key, item]) => assertValue(ir, item, `${path}.named.${key}`, valueOps));
    return;
  }
  throw new CutIrResolutionError(path, `${value.kind} expression was not reduced during compilation`);
}

const domainAssertionOps: ReadonlySet<string> = new Set(cutDomainAssertionPredicates);

function assertAssertionExpression(ir: CutAVIR, value: IRValue, path: string, operations: ReturnType<typeof registeredOps>): void {
  if (value.kind === "boolean") return;
  if (value.kind === "unary") {
    if (value.operator !== "!") throw new CutIrResolutionError(path, `assertion unary operator “${value.operator}” is not executable`);
    assertAssertionExpression(ir, value.value, `${path}.value`, operations);
    return;
  }
  if (value.kind === "binary") {
    if (value.operator !== "&&" && value.operator !== "||") throw new CutIrResolutionError(path, `assertion binary operator “${value.operator}” is not executable`);
    assertAssertionExpression(ir, value.left, `${path}.left`, operations);
    assertAssertionExpression(ir, value.right, `${path}.right`, operations);
    return;
  }
  if (value.kind === "call") {
    if (!domainAssertionOps.has(value.op) || !operations.all.has(value.op)) throw new CutIrResolutionError(path, `assertion call “${value.op}” is not a pinned domain predicate`);
    value.positional.forEach((item, index) => assertValue(ir, item, `${path}.positional[${index}]`, operations.values));
    Object.entries(value.named).forEach(([key, item]) => assertValue(ir, item, `${path}.named.${key}`, operations.values));
    return;
  }
  throw new CutIrResolutionError(path, `${value.kind} assertion expression was not reduced to a Boolean or pinned domain predicate`);
}

export function assertResolvedCutIr(ir: CutAVIR, additionalValues: Array<{ path: string; value: IRValue }> = []) {
  const operations = registeredOps(ir), valueOps = operations.values;
  for (const [nodeId, node] of Object.entries(ir.nodes)) {
    if (node.op !== "cut.kernel.fragment" && !operations.all.has(node.op)) throw new CutIrResolutionError(`nodes.${nodeId}.op`, `operation “${node.op}” has no implementation in the pinned package set`);
    Object.entries(node.inputs).forEach(([key, value]) => assertValue(ir, value, `nodes.${nodeId}.inputs.${key}`, valueOps));
    Object.entries(node.properties).forEach(([key, value]) => {
      if ("signal" in value) { if (!ir.signals[value.signal]) throw new CutIrResolutionError(`nodes.${nodeId}.properties.${key}`, `signal “${value.signal}” does not exist`); }
      else assertValue(ir, value, `nodes.${nodeId}.properties.${key}`, valueOps);
    });
  }
  for (const [signalId, signal] of Object.entries(ir.signals)) {
    if (signal.kind === "constant") assertValue(ir, signal.value, `signals.${signalId}.value`, valueOps);
    else if (signal.kind === "step") signal.points.forEach((point, index) => assertValue(ir, point.value, `signals.${signalId}.points[${index}].value`, valueOps));
    else if (signal.kind === "keyframes") signal.keyframes.forEach((point, index) => { assertValue(ir, point.value, `signals.${signalId}.keyframes[${index}].value`, valueOps); assertValue(ir, point.curve, `signals.${signalId}.keyframes[${index}].curve`, valueOps); });
    else {
      assertValue(ir, signal.initial, `signals.${signalId}.initial`, valueOps);
      if (signal.producer) {
        assertValue(ir, signal.producer.source, `signals.${signalId}.producer.source`, valueOps);
        assertValue(ir, signal.producer.mapping.from, `signals.${signalId}.producer.mapping.from`, valueOps);
        assertValue(ir, signal.producer.mapping.to, `signals.${signalId}.producer.mapping.to`, valueOps);
        if (!ir.compositions.some((item) => item.id === signal.producer!.scope.compositionId)) {
          throw new CutIrResolutionError(`signals.${signalId}.producer.scope.compositionId`, `composition “${signal.producer.scope.compositionId}” does not exist`);
        }
        if (!ir.scenes[signal.producer.scope.sceneId]) {
          throw new CutIrResolutionError(`signals.${signalId}.producer.scope.sceneId`, `scene “${signal.producer.scope.sceneId}” does not exist`);
        }
      }
      signal.events.forEach((event, index) => {
      if (event.kind === "set") assertValue(ir, event.value, `signals.${signalId}.events[${index}].value`, valueOps);
      else {
        assertValue(ir, event.from, `signals.${signalId}.events[${index}].from`, valueOps);
        assertValue(ir, event.to, `signals.${signalId}.events[${index}].to`, valueOps);
        assertValue(ir, event.curve, `signals.${signalId}.events[${index}].curve`, valueOps);
      }
      });
    }
  }
  ir.jobs.forEach((job, index) => { if (!operations.all.has(job.op)) throw new CutIrResolutionError(`jobs[${index}].op`, `operation “${job.op}” is not pinned`); Object.entries(job.inputs).forEach(([key, value]) => assertValue(ir, value, `jobs[${index}].inputs.${key}`, valueOps)); });
  ir.outputs.forEach((output, index) => {
    if (!operations.all.has(output.op)) throw new CutIrResolutionError(`outputs[${index}].op`, `operation “${output.op}” is not pinned`);
    if (!ir.compositions.some((item) => item.id === output.timelineId)) throw new CutIrResolutionError(`outputs[${index}].timelineId`, `timeline “${output.timelineId}” does not exist`);
    Object.entries(output.parameters).forEach(([key, value]) => assertValue(ir, value, `outputs[${index}].parameters.${key}`, valueOps));
  });
  ir.assertions.forEach((assertion, index) => assertAssertionExpression(ir, assertion.expression, `assertions[${index}].expression`, operations));
  additionalValues.forEach(({ path, value }) => assertValue(ir, value, path, valueOps));
  return ir;
}
