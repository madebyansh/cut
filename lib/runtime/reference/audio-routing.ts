import type { CutAVIR, IRComposition, IRNode, IRValue } from "../../language/ir";
import { boundedDiagnosticString } from "../../core/stable";
import { referenceAudioNodeConfig } from "./audio-config";

export type ReferenceAudioRoutingErrorCode =
  | "CUT_AUDIO_ROUTING_DANGLING"
  | "CUT_AUDIO_ROUTING_DUPLICATE"
  | "CUT_AUDIO_ROUTING_GRAPH"
  | "CUT_AUDIO_ROUTING_CYCLE"
  | "CUT_AUDIO_ROUTING_LIMIT"
  | "CUT_AUDIO_ROUTING_NAME";

export class ReferenceAudioRoutingError extends Error {
  readonly source: { module: string; line: number; column: number; nodeId: string };

  constructor(readonly code: ReferenceAudioRoutingErrorCode, readonly node: IRNode, message: string) {
    const { module, span } = node.provenance;
    super(`${code}: ${message} at ${module}:${span.start.line}:${span.start.column}.`);
    this.name = "ReferenceAudioRoutingError";
    this.source = { module, line: span.start.line, column: span.start.column, nodeId: node.id };
  }
}

export type ReferenceAudioRoutingPlan = {
  format: "cut-reference-audio-routing";
  version: 1;
  compositionId: string;
  sends: ReadonlyMap<string, { amountDb: number; returnNodeId: string; sourceNodeId?: string; tap?: "pre-fader"; preFaderNodeId?: string }>;
  returns: ReadonlyMap<string, readonly string[]>;
  submixes: ReadonlyMap<string, string>;
};

export const referenceAudioRoutingLimits = Object.freeze({
  maximumSends: 256,
  maximumReturns: 64,
  maximumSendsPerReturn: 32,
  maximumSubmixes: 64,
});

const portableSubmixName = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;

function fail(code: ReferenceAudioRoutingErrorCode, node: IRNode, message: string): never {
  throw new ReferenceAudioRoutingError(code, node, message);
}

function structuralRoots(ir: CutAVIR, composition: IRComposition) {
  const roots = new Set<string>([...composition.rootAudioIds, ...composition.rootAVIds, ...composition.rootVisualIds]);
  for (const sceneId of composition.sceneIds) {
    const scene = ir.scenes[sceneId];
    if (scene) for (const id of [...scene.rootAudioIds, ...scene.rootAVIds, ...scene.rootVisualIds]) roots.add(id);
  }
  return [...roots];
}

function structuralNodes(ir: CutAVIR, composition: IRComposition) {
  const result = new Set<string>(), incoming = new Map<string, number>(), pending = structuralRoots(ir, composition);
  for (const root of pending) incoming.set(root, (incoming.get(root) ?? 0) + 1);
  while (pending.length) {
    const id = pending.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    const node = ir.nodes[id];
    if (!node) continue;
    for (const child of node.children) {
      incoming.set(child, (incoming.get(child) ?? 0) + 1);
      if (!result.has(child)) pending.push(child);
    }
  }
  return { nodes: result, incoming };
}

function executionNodes(ir: CutAVIR, composition: IRComposition) {
  const pending = structuralRoots(ir, composition), result = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    const node = ir.nodes[id];
    if (!node) continue;
    pending.push(...node.children);
    Object.values(node.inputs).forEach((value) => referencedNodes(value, pending));
  }
  return result;
}

function validateRoutingReachability(ir: CutAVIR) {
  const structural = new Set<string>(), executable = new Set<string>();
  for (const composition of ir.compositions) {
    for (const id of structuralNodes(ir, composition).nodes) structural.add(id);
    for (const id of executionNodes(ir, composition)) executable.add(id);
  }
  for (const node of Object.values(ir.nodes)) {
    if (!["cut.audio.send", "cut.audio.return", "cut.audio.submix"].includes(node.op)) continue;
    if (!executable.has(node.id)) {
      fail("CUT_AUDIO_ROUTING_DANGLING", node, `${node.op} is not structurally reachable from an audiovisual composition; detached routing nodes would ignore their authored controls`);
    }
    if ((node.op !== "cut.audio.send" || node.ownership !== "reference") && !structural.has(node.id)) {
      fail("CUT_AUDIO_ROUTING_DANGLING", node, `${node.op} must have a structural dry-path owner; only a Send(source:) may be a detached Return-reachable reference`);
    }
  }
}

function referencedNodes(value: IRValue, result: string[]) {
  if (value.kind === "node-ref") result.push(value.id);
  else if (value.kind === "array") value.items.forEach((item) => referencedNodes(item, result));
  else if (value.kind === "object") Object.values(value.entries).forEach((item) => referencedNodes(item, result));
  else if (value.kind === "range") { referencedNodes(value.start, result); referencedNodes(value.end, result); }
  else if (value.kind === "unary") referencedNodes(value.value, result);
  else if (value.kind === "binary") { referencedNodes(value.left, result); referencedNodes(value.right, result); }
  else if (value.kind === "member") referencedNodes(value.object, result);
  else if (value.kind === "index") { referencedNodes(value.object, result); referencedNodes(value.index, result); }
  else if (value.kind === "call") { value.positional.forEach((item) => referencedNodes(item, result)); Object.values(value.named).forEach((item) => referencedNodes(item, result)); }
}

function routingCycle(ir: CutAVIR, reachable: ReadonlySet<string>, routingNodes: readonly IRNode[]) {
  const states = new Map<string, "visiting" | "done">(), stack: string[] = [];
  const visit = (id: string) => {
    const state = states.get(id);
    if (state === "done") return;
    const node = ir.nodes[id];
    if (!node || !reachable.has(id)) return;
    if (state === "visiting") {
      const start = stack.indexOf(id), cycle = [...stack.slice(Math.max(0, start)), id];
      const owner = [...cycle].reverse().map((candidate) => ir.nodes[candidate]).find((candidate) => candidate?.op === "cut.audio.return" || candidate?.op === "cut.audio.send") ?? node;
      fail("CUT_AUDIO_ROUTING_CYCLE", owner, `audio routing cycle ${cycle.join(" -> ")} requires unsupported feedback semantics`);
    }
    states.set(id, "visiting"); stack.push(id);
    const edges = [...node.children];
    Object.values(node.inputs).forEach((value) => referencedNodes(value, edges));
    edges.forEach(visit);
    stack.pop(); states.set(id, "done");
  };
  routingNodes.forEach((node) => visit(node.id));
}

/**
 * Build the one authoritative explicit auxiliary-routing plan. Structural
 * ownership supplies exactly one dry path; Return node references supply the
 * separately gained auxiliary paths and therefore participate in IR/cache
 * identity without route-name discovery or a hidden runtime graph.
 */
export function planReferenceAudioRouting(ir: CutAVIR, composition: IRComposition): ReferenceAudioRoutingPlan {
  validateRoutingReachability(ir);
  const structural = structuralNodes(ir, composition);
  const executable = executionNodes(ir, composition);
  const routing = [...executable].map((id) => ir.nodes[id]).filter((node): node is IRNode => Boolean(node && ["cut.audio.send", "cut.audio.return", "cut.audio.submix"].includes(node.op)));
  const sends = routing.filter((node) => node.op === "cut.audio.send");
  const returns = routing.filter((node) => node.op === "cut.audio.return");
  const submixes = routing.filter((node) => node.op === "cut.audio.submix");
  const limitOwner = routing[0];
  if (limitOwner && sends.length > referenceAudioRoutingLimits.maximumSends) fail("CUT_AUDIO_ROUTING_LIMIT", limitOwner, `composition declares ${sends.length} Sends; maximum is ${referenceAudioRoutingLimits.maximumSends}`);
  if (limitOwner && returns.length > referenceAudioRoutingLimits.maximumReturns) fail("CUT_AUDIO_ROUTING_LIMIT", limitOwner, `composition declares ${returns.length} Returns; maximum is ${referenceAudioRoutingLimits.maximumReturns}`);
  if (limitOwner && submixes.length > referenceAudioRoutingLimits.maximumSubmixes) fail("CUT_AUDIO_ROUTING_LIMIT", limitOwner, `composition declares ${submixes.length} Submixes; maximum is ${referenceAudioRoutingLimits.maximumSubmixes}`);

  for (const node of routing) {
    const config = referenceAudioNodeConfig(ir, composition, node);
    const detachedSend = config?.kind === "send" && config.sourceNodeId !== undefined;
    const expected = detachedSend ? 0 : 1, actual = structural.incoming.get(node.id) ?? 0;
    if (actual !== expected) {
      fail("CUT_AUDIO_ROUTING_DUPLICATE", node, detachedSend
        ? `detached Send(source:) must have no structural dry-path owner; found ${actual}`
        : `${node.op} must have exactly one structural dry-path owner; found ${actual}`);
    }
  }

  const submixPlan = new Map<string, string>(), foldedNames = new Map<string, IRNode>();
  for (const node of submixes) {
    const config = referenceAudioNodeConfig(ir, composition, node);
    if (config?.kind !== "submix") fail("CUT_AUDIO_ROUTING_GRAPH", node, "Submix has no valid typed runtime config");
    if (!portableSubmixName.test(config.name)) fail("CUT_AUDIO_ROUTING_NAME", node, `Submix name ${boundedDiagnosticString(config.name)} must be 1–64 portable ASCII characters beginning with a letter`);
    const folded = config.name.toLowerCase(), previous = foldedNames.get(folded);
    if (previous) fail("CUT_AUDIO_ROUTING_DUPLICATE", node, `Submix name ${boundedDiagnosticString(config.name)} duplicates the submix at ${previous.provenance.module}:${previous.provenance.span.start.line}:${previous.provenance.span.start.column}`);
    foldedNames.set(folded, node); submixPlan.set(node.id, config.name);
  }

  const returnPlan = new Map<string, readonly string[]>(), claims = new Map<string, IRNode>();
  for (const node of returns) {
    const config = referenceAudioNodeConfig(ir, composition, node);
    if (config?.kind !== "return") fail("CUT_AUDIO_ROUTING_GRAPH", node, "Return has no valid typed runtime config");
    if (!config.sendNodeIds.length) fail("CUT_AUDIO_ROUTING_DANGLING", node, "Return requires at least one explicitly referenced Send");
    if (config.sendNodeIds.length > referenceAudioRoutingLimits.maximumSendsPerReturn) fail("CUT_AUDIO_ROUTING_LIMIT", node, `Return references ${config.sendNodeIds.length} Sends; maximum is ${referenceAudioRoutingLimits.maximumSendsPerReturn}`);
    const local = new Set<string>();
    for (const sendId of config.sendNodeIds) {
      if (local.has(sendId)) fail("CUT_AUDIO_ROUTING_DUPLICATE", node, `Return references Send ${sendId} more than once`);
      local.add(sendId);
      const send = ir.nodes[sendId];
      if (!send || send.op !== "cut.audio.send") fail("CUT_AUDIO_ROUTING_GRAPH", node, `Return reference ${sendId} is not a Send node`);
      if (!executable.has(sendId)) fail("CUT_AUDIO_ROUTING_GRAPH", node, `Return references Send ${sendId} outside composition ${composition.name}'s executable graph`);
      const previous = claims.get(sendId);
      if (previous) fail("CUT_AUDIO_ROUTING_DUPLICATE", node, `Send ${sendId} is already claimed by Return ${previous.id}; one Send cannot be counted by multiple Returns`);
      claims.set(sendId, node);
    }
    returnPlan.set(node.id, [...config.sendNodeIds]);
  }

  const sendPlan = new Map<string, { amountDb: number; returnNodeId: string; sourceNodeId?: string; tap?: "pre-fader"; preFaderNodeId?: string }>();
  for (const node of sends) {
    const config = referenceAudioNodeConfig(ir, composition, node);
    if (config?.kind !== "send") fail("CUT_AUDIO_ROUTING_GRAPH", node, "Send has no valid typed runtime config");
    const destination = claims.get(node.id);
    if (!destination) fail("CUT_AUDIO_ROUTING_DANGLING", node, "Send is not claimed by an explicit reachable Return and its amount would be a no-op");
    let preFaderNodeId: string | undefined;
    if (config.sourceNodeId !== undefined) {
      const source = ir.nodes[config.sourceNodeId];
      if (!source || (source.domain !== "audio" && source.domain !== "av")) fail("CUT_AUDIO_ROUTING_GRAPH", node, `Send source ${config.sourceNodeId} is not an AudioNode`);
      if (!structural.nodes.has(config.sourceNodeId)) fail("CUT_AUDIO_ROUTING_GRAPH", node, `Send source ${config.sourceNodeId} is not structurally owned by composition ${composition.name}`);
      if (config.tap === "pre-fader") {
        const fader = source.op === "cut.audio.gain"
          ? source
          : source.op === "cut.audio.bus" && source.children.length === 1
            ? ir.nodes[source.children[0]!]
            : undefined;
        if (!fader || fader.op !== "cut.audio.gain" || fader.children.length < 1) {
          fail("CUT_AUDIO_ROUTING_GRAPH", node, `Send tap: pre-fader requires source ${config.sourceNodeId} to be one explicit Gain or a Bus whose sole direct child is one explicit Gain`);
        }
        preFaderNodeId = fader.id;
      }
    }
    sendPlan.set(node.id, {
      amountDb: config.amountDb,
      returnNodeId: destination.id,
      ...(config.sourceNodeId === undefined ? {} : { sourceNodeId: config.sourceNodeId }),
      ...(config.tap === "pre-fader" ? { tap: config.tap } : {}),
      ...(preFaderNodeId === undefined ? {} : { preFaderNodeId }),
    });
  }

  routingCycle(ir, executable, routing);
  return { format: "cut-reference-audio-routing", version: 1, compositionId: composition.id, sends: sendPlan, returns: returnPlan, submixes: submixPlan };
}
