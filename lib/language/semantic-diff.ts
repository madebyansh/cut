import { hash, stableStringify } from "../core/stable";
import type { CutAVIR, IRNode, IRSignal } from "./ir";
import { validateCutAvIr } from "./ir-loader";
import { kernelPropertyValueType, referenceKernelSchema } from "./kernel-registry";
import type { IRPictureEditItem, IRPictureTrackOperationPlan } from "./picture-edit-operations";
import { cutExecutableNodeInputs } from "../runtime/graph";
import { timelineEditPlanSemanticIdentity } from "./timeline-edit-identity";

export const cutAVIRSemanticEntityKinds = [
  "ir",
  "composition",
  "scene",
  "node",
  "signal",
  "resource",
  "module",
  "job",
  "output",
  "assertion",
  "marker",
  "region",
  "linked-edit",
  "semantic-match-subject",
  "semantic-match-transition",
  "transcript-media-authority",
  "transcript-binding",
  "timeline-edit",
] as const;

export type CutAVIRSemanticEntityKind = typeof cutAVIRSemanticEntityKinds[number];
export type CutAVIRSemanticOperation = "add" | "remove" | "modify";

export type SemanticValue = null | boolean | number | string | SemanticValue[] | { [key: string]: SemanticValue };

export type CutAVIRSemanticFieldChange = {
  /** RFC 6901 JSON Pointer relative to the entity's semantic content. */
  path: string;
  before?: SemanticValue;
  after?: SemanticValue;
};

type CutAVIRSemanticChangeBase = {
  entity: CutAVIRSemanticEntityKind;
  id: string;
};

export type CutAVIRSemanticAdd = CutAVIRSemanticChangeBase & {
  operation: "add";
  afterHash: string;
  after: SemanticValue;
};

export type CutAVIRSemanticRemove = CutAVIRSemanticChangeBase & {
  operation: "remove";
  beforeHash: string;
  before: SemanticValue;
};

export type CutAVIRSemanticModify = CutAVIRSemanticChangeBase & {
  operation: "modify";
  beforeHash: string;
  afterHash: string;
  fields: CutAVIRSemanticFieldChange[];
  /** Additive domain-specific meaning for diagram edits. Generic field paths
   * remain canonical; these labels make cache/review intent machine-readable. */
  classifications?: CutDiagramSemanticChangeClass[];
};

export const cutDiagramSemanticChangeClasses = [
  "topology",
  "bounds-layout",
  "edge-geometry",
  "edge-paint",
  "node-paint",
  "progress",
] as const;

export type CutDiagramSemanticChangeClass = typeof cutDiagramSemanticChangeClasses[number];

export type CutAVIRSemanticChange = CutAVIRSemanticAdd | CutAVIRSemanticRemove | CutAVIRSemanticModify;

export type CutAVIRSemanticChangeCounts = Record<CutAVIRSemanticOperation, number>;
type CutAVIRExtensionSemanticEntityKind = "marker" | "region" | "linked-edit" | "semantic-match-subject" | "semantic-match-transition" | "transcript-media-authority" | "transcript-binding" | "timeline-edit";
type CutAVIRLegacySemanticEntityKind = Exclude<CutAVIRSemanticEntityKind, CutAVIRExtensionSemanticEntityKind>;

export type CutAVIRSemanticDiff = {
  format: "cut-av-ir-semantic-diff";
  version: 2;
  irVersion: 3;
  changes: CutAVIRSemanticChange[];
  summary: CutAVIRSemanticChangeCounts & {
    total: number;
    /** Legacy entity buckets are always present; extension buckets appear only when changed. */
    byEntity: Record<CutAVIRLegacySemanticEntityKind, CutAVIRSemanticChangeCounts> & Partial<Record<CutAVIRExtensionSemanticEntityKind, CutAVIRSemanticChangeCounts>>;
  };
};

type IndexedEntity = { id: string; content: SemanticValue };

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

/** @deprecated Use the strict public CutAVIR loader/validator directly. */
export function validateCutAVIRV3(value: unknown, label = "input"): CutAVIR {
  try { return validateCutAvIr(value); }
  catch (error) { throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
}

function assertCutAVIRV3(ir: CutAVIR, side: "before" | "after") {
  if (ir.format !== "cut-av-ir" || ir.version !== 3) throw new Error(`CUT semantic diff requires CutAVIR v3 for ${side}.`);
}

function canonicalValue(value: unknown, context: string): SemanticValue {
  try {
    const serialized = stableStringify(value);
    if (typeof serialized !== "string") throw new TypeError("value is not JSON serializable");
    return JSON.parse(serialized) as SemanticValue;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`CUT semantic diff could not serialize ${context}: ${message}`);
  }
}

function semanticContent(value: object, ignoredKeys: readonly string[]): SemanticValue {
  const ignored = new Set(ignoredKeys);
  return canonicalValue(Object.fromEntries(Object.entries(value).filter(([key]) => !ignored.has(key))), "entity content");
}

function indexed(
  entity: CutAVIRSemanticEntityKind,
  values: readonly object[],
  identity: (value: object) => string,
  ignoredKeys: readonly string[],
  content?: (value: object) => SemanticValue,
): Map<string, IndexedEntity> {
  const result = new Map<string, IndexedEntity>();
  for (const value of values) {
    const id = identity(value);
    if (!id) throw new Error(`CUT semantic diff found a ${entity} without a stable identity.`);
    if (result.has(id)) throw new Error(`CUT semantic diff found duplicate ${entity} identity “${id}”.`);
    result.set(id, { id, content: content ? content(value) : semanticContent(value, ignoredKeys) });
  }
  return result;
}

function pictureEditOperationSemanticIdentity(plan: IRPictureTrackOperationPlan) {
  const item = (value: IRPictureEditItem) => {
    const { provenance, ...semantic } = value;
    void provenance;
    return semantic;
  };
  return {
    version: plan.version,
    sourceDuration: plan.sourceDuration,
    baseItems: plan.baseItems.map(item),
    operations: plan.operations.map((operation) => {
      const { provenance, ...semantic } = operation;
      void provenance;
      return "item" in semantic ? { ...semantic, item: item(semantic.item) } : semantic;
    }),
  };
}

function processedAudioOperationSemanticIdentity(
  plan: Extract<NonNullable<Extract<NonNullable<IRNode["editorial"]>, { kind: "audio-track" }>["operationPlan"]>, { version: 2 }>,
) {
  return {
    version: plan.version,
    sourceDuration: plan.sourceDuration,
    baseItems: plan.baseItems.map(({ provenance, ...item }) => {
      void provenance;
      return { ...item, processorNodeIds: [...item.processorNodeIds] };
    }),
    operations: plan.operations.map(({ provenance, ...operation }) => {
      void provenance;
      return operation;
    }),
  };
}

function nodeSemanticContent(node: IRNode, ir: CutAVIR): SemanticValue {
  const pictureOperationPlan = node.editorial?.kind === "picture-track" ? node.editorial.operationPlan : undefined;
  const transitionIdentity = node.editorial?.kind === "picture-track" && node.editorial.transitions
    ? node.editorial.transitions.map((transition) => {
        const { provenance, ...executable } = transition;
        void provenance;
        return executable;
      })
    : undefined;
  const audioTransitionIdentity = node.editorial?.kind === "audio-track" && node.editorial.transitions
    ? node.editorial.transitions.map((transition) => {
        const { provenance, ...executable } = transition;
        void provenance;
        return executable;
      })
    : undefined;
  const normalizedNode = { ...node, inputs: cutExecutableNodeInputs(ir, node) };
  const normalizedNodeWithAvailability = node.op === "cut.edit.audio_region" && (node.inputs.headHandle || node.inputs.tailHandle)
    ? {
        ...normalizedNode,
        audioRegionHandleAvailability: {
          ...(node.inputs.headHandle ? { headHandle: node.inputs.headHandle } : {}),
          ...(node.inputs.tailHandle ? { tailHandle: node.inputs.tailHandle } : {}),
        },
      }
    : normalizedNode;
  const audioEditorial = node.editorial?.kind === "audio-track" ? (() => {
    const { operationPlan, ...materialized } = node.editorial;
    void operationPlan;
    return materialized;
  })() : undefined;
  const processedAudioPlan = node.editorial?.kind === "audio-track" && node.editorial.operationPlan?.version === 2
    ? node.editorial.operationPlan
    : undefined;
  const normalized = node.editorial?.kind === "picture-track" ? {
    ...node,
    editorial: {
      ...node.editorial,
      // Semantic diff records authored source availability even when surplus
      // handles are deliberately excluded from executable/cache identity.
      ...(pictureOperationPlan ? { operationPlan: pictureEditOperationSemanticIdentity(pictureOperationPlan) } : {}),
      ...(transitionIdentity ? { transitions: transitionIdentity } : {}),
    },
  } : node.editorial?.kind === "audio-track" ? {
    ...normalizedNode,
    editorial: {
      ...audioEditorial!,
      ...(processedAudioPlan ? { operationPlan: processedAudioOperationSemanticIdentity(processedAudioPlan) } : {}),
      ...(audioTransitionIdentity ? { transitions: audioTransitionIdentity } : {}),
    },
  } : normalizedNodeWithAvailability;
  return semanticContent(normalized, ["id", "contentHash", "provenance"]);
}

function topLevelSemanticContent(ir: CutAVIR): SemanticValue {
  const content = semanticContent(ir, [
    "sourceHash",
    "sourceModules",
    "buildId",
    "modules",
    "resources",
    "compositions",
    "scenes",
    "nodes",
    "signals",
    "jobs",
    "outputs",
    "assertions",
    "annotations",
    "linkedEdits",
    "semanticMatches",
    "transcriptMediaAuthorities",
    "transcriptBindings",
    "timelineEdits",
  ]);
  if (content === null || Array.isArray(content) || typeof content !== "object") {
    throw new Error("CUT semantic diff could not construct the top-level IR entity.");
  }
  return {
    ...content,
    // These containers are arrays in canonical CutAVIR. Their order is part of
    // executable/reporting identity even though their members are diffed by a
    // stable ID below. Record-backed containers deliberately have no order.
    entityOrder: {
      modules: ir.modules.map((value) => value.specifier),
      compositions: ir.compositions.map((value) => value.id),
      jobs: ir.jobs.map((value) => value.id),
      outputs: ir.outputs.map((value) => value.id),
      assertions: ir.assertions.map((value) => value.id),
      markers: ir.annotations?.markers.map((value) => value.id) ?? [],
      regions: ir.annotations?.regions.map((value) => value.id) ?? [],
      linkedEdits: ir.linkedEdits?.map((value) => value.id) ?? [],
      semanticMatchSubjects: ir.semanticMatches?.subjects.map((value) => value.id) ?? [],
      semanticMatchTransitions: ir.semanticMatches?.transitions.map((value) => value.id) ?? [],
      transcriptMediaAuthorities: ir.transcriptMediaAuthorities?.map((value) => value.id) ?? [],
      transcriptBindings: ir.transcriptBindings?.map((value) => value.id) ?? [],
      ...(ir.timelineEdits ? { timelineEdits: ir.timelineEdits.map((value) => value.id) } : {}),
    },
  };
}

function schemaDerivedSignalTypes(ir: CutAVIR) {
  const bindings = new Map<string, { types: Set<string>; unresolved: boolean }>();
  for (const node of Object.values(ir.nodes)) {
    const schema = referenceKernelSchema(node.op);
    for (const [property, value] of Object.entries(node.properties)) {
      if (!("signal" in value)) continue;
      const binding = bindings.get(value.signal) ?? { types: new Set<string>(), unresolved: false };
      const expected = schema?.support === "supported" ? kernelPropertyValueType(schema, property) : undefined;
      if (expected) binding.types.add(expected);
      else binding.unresolved = true;
      bindings.set(value.signal, binding);
    }
  }
  return new Set([...bindings].flatMap(([id, binding]) => !binding.unresolved && binding.types.size === 1 ? [id] : []));
}

function signalSemanticContent(signal: IRSignal, schemaDerived: boolean) {
  return semanticContent(signal, ["id", "contentHash", "provenance", ...(schemaDerived ? ["valueType"] : [])]);
}

function diagramDescendantOwners(ir: CutAVIR) {
  const result = new Map<string, Readonly<{ layoutId: string; diagramNodeId: string }>>();
  for (const layout of Object.values(ir.nodes).filter((node) => node.op === "cut.diagram.layout")) {
    for (const diagramNodeId of layout.children) {
      const diagramNode = ir.nodes[diagramNodeId];
      if (diagramNode?.op !== "cut.diagram.node") continue;
      const pending = [...diagramNode.children], visiting = new Set<string>();
      while (pending.length) {
        const id = pending.pop()!;
        if (visiting.has(id)) continue;
        visiting.add(id);
        const prior = result.get(id);
        if (!prior || `${layout.id}\u0000${diagramNode.id}` < `${prior.layoutId}\u0000${prior.diagramNodeId}`) {
          result.set(id, Object.freeze({ layoutId: layout.id, diagramNodeId: diagramNode.id }));
        }
        const child = ir.nodes[id];
        if (child) pending.push(...child.children);
      }
    }
  }
  return result;
}

function diagramProgressSignals(ir: CutAVIR) {
  return new Set(Object.values(ir.nodes).flatMap((node) => {
    const progress = node.op === "cut.diagram.layout" ? node.properties.progress : undefined;
    return progress && "signal" in progress ? [progress.signal] : [];
  }));
}

function diagramChangeClassifications(
  entity: CutAVIRSemanticEntityKind,
  id: string,
  fields: readonly CutAVIRSemanticFieldChange[],
  before: CutAVIR,
  after: CutAVIR,
  beforeDescendants: ReadonlyMap<string, unknown>,
  afterDescendants: ReadonlyMap<string, unknown>,
  progressSignals: ReadonlySet<string>,
) {
  const classes = new Set<CutDiagramSemanticChangeClass>();
  if (entity === "signal" && progressSignals.has(id)) classes.add("progress");
  if (entity !== "node") return cutDiagramSemanticChangeClasses.filter((item) => classes.has(item));
  const oldNode = before.nodes[id], newNode = after.nodes[id], op = newNode?.op ?? oldNode?.op;
  if (beforeDescendants.has(id) || afterDescendants.has(id)) classes.add("node-paint");
  if (op === "cut.diagram.node") {
    for (const field of fields) {
      if (/^\/inputs\/(?:width|height|rank)(?:\/|$)/u.test(field.path)) classes.add("bounds-layout");
      else if (/^\/inputs\/id(?:\/|$)/u.test(field.path)) classes.add("topology");
      else classes.add("node-paint");
    }
  }
  if (op === "cut.diagram.layout") for (const field of fields) {
    const path = field.path;
    if (/^\/(?:inputs\/progress|properties\/progress)(?:\/|$)/u.test(path)) classes.add("progress");
    else if (/^\/inputs\/(?:direction|width|height|x|y|safeX|safeY|nodeGap|rankGap|edgeGap|edgeClearance)(?:\/|$)/u.test(path)) classes.add("bounds-layout");
    else if (/^\/children(?:\/|$)/u.test(path)
      || /^\/inputs\/(?:state|fromState)\/entries\/(?:id|nodes)(?:\/|$)/u.test(path)
      || /^\/inputs\/(?:state|fromState)\/entries\/edges\/items\/\d+$/u.test(path)
      || /^\/inputs\/(?:state|fromState)\/entries\/edges\/items\/\d+\/entries\/(?:id|from|to)(?:\/|$)/u.test(path)) classes.add("topology");
    else if (/^\/inputs\/(?:state|fromState)\/entries\/edges\/items\/\d+\/entries\/(?:fromPort|toPort)(?:\/|$)/u.test(path)) classes.add("edge-geometry");
    else if (/^\/inputs\/(?:state|fromState)\/entries\/edges\/items\/\d+\/entries\/(?:stroke|width|arrow)(?:\/|$)/u.test(path)) classes.add("edge-paint");
  }
  return cutDiagramSemanticChangeClasses.filter((item) => classes.has(item));
}

function entityIndexes(ir: CutAVIR): Record<CutAVIRSemanticEntityKind, Map<string, IndexedEntity>> {
  const derivedSignalTypes = schemaDerivedSignalTypes(ir);
  return {
    ir: new Map([["$", { id: "$", content: topLevelSemanticContent(ir) }]]),
    composition: indexed("composition", ir.compositions, (value) => (value as { id: string }).id, ["id", "provenance"]),
    scene: indexed("scene", Object.values(ir.scenes), (value) => (value as { id: string }).id, ["id", "provenance"]),
    node: indexed("node", Object.values(ir.nodes), (value) => (value as IRNode).id, [], (value) => nodeSemanticContent(value as IRNode, ir)),
    signal: indexed("signal", Object.values(ir.signals), (value) => (value as IRSignal).id, [], (value) => {
      const signal = value as IRSignal;
      return signalSemanticContent(signal, derivedSignalTypes.has(signal.id));
    }),
    resource: indexed("resource", Object.values(ir.resources), (value) => (value as { id: string }).id, ["id", "provenance"]),
    module: indexed("module", ir.modules, (value) => (value as { specifier: string }).specifier, ["specifier"]),
    job: indexed("job", ir.jobs, (value) => (value as { id: string }).id, ["id", "provenance"]),
    output: indexed("output", ir.outputs, (value) => (value as { id: string }).id, ["id", "provenance"]),
    assertion: indexed("assertion", ir.assertions, (value) => (value as { id: string }).id, ["id", "provenance"]),
    marker: indexed("marker", ir.annotations?.markers ?? [], (value) => (value as { id: string }).id, ["id", "provenance"]),
    region: indexed("region", ir.annotations?.regions ?? [], (value) => (value as { id: string }).id, ["id", "provenance"]),
    "linked-edit": indexed("linked-edit", ir.linkedEdits ?? [], (value) => (value as { id: string }).id, ["id", "provenance"]),
    "semantic-match-subject": indexed("semantic-match-subject", ir.semanticMatches?.subjects ?? [], (value) => (value as { id: string }).id, ["id", "provenance"]),
    "semantic-match-transition": indexed("semantic-match-transition", ir.semanticMatches?.transitions ?? [], (value) => (value as { id: string }).id, ["id", "provenance"]),
    "transcript-media-authority": indexed("transcript-media-authority", ir.transcriptMediaAuthorities ?? [], (value) => (value as { id: string }).id, ["id", "provenance"]),
    "transcript-binding": indexed("transcript-binding", ir.transcriptBindings ?? [], (value) => (value as { id: string }).id, ["id", "provenance"]),
    "timeline-edit": indexed(
      "timeline-edit",
      ir.timelineEdits ?? [],
      (value) => (value as { id: string }).id,
      [],
      (value) => canonicalValue(
        timelineEditPlanSemanticIdentity(value as NonNullable<CutAVIR["timelineEdits"]>[number]),
        "TimelineEdit semantic content",
      ),
    ),
  };
}

function escapeJsonPointer(segment: string) { return segment.replaceAll("~", "~0").replaceAll("/", "~1"); }

function fieldChanges(before: SemanticValue, after: SemanticValue, path = ""): CutAVIRSemanticFieldChange[] {
  if (stableStringify(before) === stableStringify(after)) return [];

  if (Array.isArray(before) && Array.isArray(after)) {
    const changes: CutAVIRSemanticFieldChange[] = [];
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      const itemPath = `${path}/${index}`;
      if (index >= before.length) changes.push({ path: itemPath, after: after[index] });
      else if (index >= after.length) changes.push({ path: itemPath, before: before[index] });
      else changes.push(...fieldChanges(before[index], after[index], itemPath));
    }
    return changes;
  }

  const beforeObject = before !== null && typeof before === "object" && !Array.isArray(before);
  const afterObject = after !== null && typeof after === "object" && !Array.isArray(after);
  if (beforeObject && afterObject) {
    const changes: CutAVIRSemanticFieldChange[] = [];
    const oldRecord = before as Record<string, SemanticValue>;
    const newRecord = after as Record<string, SemanticValue>;
    const keys = [...new Set([...Object.keys(oldRecord), ...Object.keys(newRecord)])].sort(compareText);
    for (const key of keys) {
      const itemPath = `${path}/${escapeJsonPointer(key)}`;
      if (!Object.hasOwn(oldRecord, key)) changes.push({ path: itemPath, after: newRecord[key] });
      else if (!Object.hasOwn(newRecord, key)) changes.push({ path: itemPath, before: oldRecord[key] });
      else changes.push(...fieldChanges(oldRecord[key], newRecord[key], itemPath));
    }
    return changes;
  }

  return [{ path, before, after }];
}

function emptyCounts(): CutAVIRSemanticChangeCounts { return { add: 0, remove: 0, modify: 0 }; }

function summarize(changes: readonly CutAVIRSemanticChange[]): CutAVIRSemanticDiff["summary"] {
  const extensions = new Set<CutAVIRSemanticEntityKind>(["marker", "region", "linked-edit", "semantic-match-subject", "semantic-match-transition", "transcript-media-authority", "transcript-binding", "timeline-edit"]);
  const legacyKinds = cutAVIRSemanticEntityKinds.filter((entity): entity is CutAVIRLegacySemanticEntityKind => !extensions.has(entity));
  const byEntity = Object.fromEntries(legacyKinds.map((entity) => [entity, emptyCounts()])) as CutAVIRSemanticDiff["summary"]["byEntity"];
  const summary = { ...emptyCounts(), total: changes.length, byEntity };
  for (const change of changes) {
    summary[change.operation] += 1;
    const counts = summary.byEntity[change.entity] ?? (summary.byEntity[change.entity] = emptyCounts());
    counts[change.operation] += 1;
  }
  return summary;
}

/**
 * Compare the semantic graph carried by two CutAVIR v3 artifacts.
 *
 * Source/build hashes, provenance spans, derived node/signal content hashes,
 * and schema-derived signal valueType are deliberately excluded. valueType is
 * not an independent executable degree of freedom only when every attachment
 * is a closed kernel property declaring the same type. Unknown, third-party,
 * or conflicting attachment types remain semantic and appear in the diff.
 * Every other current public CutAVIR v3 field is covered. Stable entity
 * identity and authored/runtime content remain
 * significant, including ordered top-level array entities, children, layers,
 * scenes, jobs, outputs, and assertions.
 */
export function diffCutAVIR(before: CutAVIR, after: CutAVIR): CutAVIRSemanticDiff {
  assertCutAVIRV3(before, "before");
  assertCutAVIRV3(after, "after");
  const oldIndexes = entityIndexes(before);
  const newIndexes = entityIndexes(after);
  const beforeDiagramDescendants = diagramDescendantOwners(before);
  const afterDiagramDescendants = diagramDescendantOwners(after);
  const diagramProgressSignalIds = new Set([...diagramProgressSignals(before), ...diagramProgressSignals(after)]);
  const changes: CutAVIRSemanticChange[] = [];

  for (const entity of cutAVIRSemanticEntityKinds) {
    const oldIndex = oldIndexes[entity];
    const newIndex = newIndexes[entity];
    const ids = [...new Set([...oldIndex.keys(), ...newIndex.keys()])].sort(compareText);
    for (const id of ids) {
      const oldEntity = oldIndex.get(id);
      const newEntity = newIndex.get(id);
      if (!oldEntity && newEntity) {
        changes.push({ entity, id, operation: "add", afterHash: hash(newEntity.content), after: newEntity.content });
      } else if (oldEntity && !newEntity) {
        changes.push({ entity, id, operation: "remove", beforeHash: hash(oldEntity.content), before: oldEntity.content });
      } else if (oldEntity && newEntity && stableStringify(oldEntity.content) !== stableStringify(newEntity.content)) {
        const fields = fieldChanges(oldEntity.content, newEntity.content);
        const classifications = diagramChangeClassifications(
          entity,
          id,
          fields,
          before,
          after,
          beforeDiagramDescendants,
          afterDiagramDescendants,
          diagramProgressSignalIds,
        );
        changes.push({
          entity,
          id,
          operation: "modify",
          beforeHash: hash(oldEntity.content),
          afterHash: hash(newEntity.content),
          fields,
          ...(classifications.length ? { classifications } : {}),
        });
      }
    }
  }

  return { format: "cut-av-ir-semantic-diff", version: 2, irVersion: 3, changes, summary: summarize(changes) };
}

export function formatCutAVIRSemanticDiff(diff: CutAVIRSemanticDiff): string {
  if (diff.changes.length === 0) return "No semantic audiovisual changes.";
  const { add, remove, modify, total } = diff.summary;
  const lines = [`CUT semantic diff: ${total} change${total === 1 ? "" : "s"} (${add} added, ${remove} removed, ${modify} modified).`];
  for (const change of diff.changes) {
    const marker = change.operation === "add" ? "+" : change.operation === "remove" ? "-" : "~";
    if (change.operation !== "modify") lines.push(`${marker} ${change.entity} ${change.id}`);
    else {
      const visible = change.fields.slice(0, 3).map((field) => field.path || "/");
      const remaining = change.fields.length - visible.length;
      lines.push(`${marker} ${change.entity} ${change.id}${change.classifications?.length ? ` [${change.classifications.join(", ")}]` : ""}: ${visible.join(", ")}${remaining > 0 ? ` (+${remaining} more)` : ""}`);
    }
  }
  return lines.join("\n");
}
