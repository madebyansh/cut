import type { LanguageDiagnostic, SourceSpan } from "../../language/ast";
import type { CutAVIR, IRNode, IRValue } from "../../language/ir";
import { addRational, compareRational, type Rational } from "../../language/rational";
import { assertCutGraphExecutionBudget, compositionNodeRoots } from "../graph";
import { ReferenceEasingConfigError, validateReferenceEasings } from "./easing";
import {
  ReferenceCalloutError,
  validateReferenceCalloutStaticGraph,
} from "./callout";
import { ReferenceGeoAnnotationError, validateReferenceGeoAnnotationGraph } from "./geo-annotation";
import { ReferenceParallaxCameraError, validateReferenceParallaxCameraGraph } from "./parallax-camera";
import {
  createReferenceLocalSpaceStructuralValidationIndex,
  ReferenceLocalSpaceError,
  validateReferenceLocalSpaceGraph,
} from "./local-space";
import { referenceCamera2DLocalSpacePlanAt } from "./camera2d-local-space";
import {
  referenceComponentFragmentLocalSpaceFramePreflight,
  referenceComponentFragmentLocalSpacePlanAt,
  type ReferenceComponentFragmentLocalSpaceCompositionEntry,
} from "./component-fragment-local-space";
import { ReferenceMapCameraError, validateReferenceMapCameraGeoAnnotations, validateReferenceMapCameraGraph } from "./map-camera";
import { ReferenceResponsiveStackError, validateReferenceResponsiveStackGraph } from "./responsive-layout";
import {
  ReferenceIdentityComponentFragmentError,
  validateReferenceIdentityComponentFragments,
} from "./identity-component-fragment";
import { ReferencePlanarTrackError, validateReferencePlanarTrackResourceOwnership } from "./planar-tracking";
import { ReferencePrecompError, validateReferencePrecompGraph } from "./precomp-config";

type SourceLocatedError = Error & Readonly<{
  code: string;
  source: Readonly<{ module?: string; line?: number; column?: number; nodeId?: string }>;
}>;

function nodeReferences(value: IRValue, result: Set<string>) {
  if (value.kind === "node-ref") result.add(value.id);
  else if (value.kind === "array") value.items.forEach((item) => nodeReferences(item, result));
  else if (value.kind === "object") Object.values(value.entries).forEach((item) => nodeReferences(item, result));
  else if (value.kind === "range") { nodeReferences(value.start, result); nodeReferences(value.end, result); }
  else if (value.kind === "unary") nodeReferences(value.value, result);
  else if (value.kind === "binary") { nodeReferences(value.left, result); nodeReferences(value.right, result); }
  else if (value.kind === "member") nodeReferences(value.object, result);
  else if (value.kind === "index") { nodeReferences(value.object, result); nodeReferences(value.index, result); }
  else if (value.kind === "call") {
    value.positional.forEach((item) => nodeReferences(item, result));
    Object.values(value.named).forEach((item) => nodeReferences(item, result));
  }
}

/** Reachability for asset-free structural checks. Timeline references are
 * validated when their own composition is visited; this walk follows only the
 * executable node graph owned by one composition. */
function reachableCompositionNodes(ir: CutAVIR, rootIds: readonly string[]) {
  const pending = [...rootIds], reachable = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const node = ir.nodes[id];
    if (!node) continue;
    pending.push(...node.children);
    const references = new Set<string>();
    Object.values(node.inputs).forEach((value) => nodeReferences(value, references));
    for (const value of Object.values(node.properties)) if (!("signal" in value)) nodeReferences(value, references);
    pending.push(...references);
  }
  return reachable;
}

function pointSpan(line = 1, column = 1): SourceSpan {
  return {
    start: { offset: 0, line, column },
    end: { offset: 0, line, column },
  };
}

function diagnosticFromNode(error: SourceLocatedError, node: IRNode | undefined): LanguageDiagnostic {
  const messagePrefix = `${error.code}: `;
  const authoredModule = node?.provenance.module ?? error.source.module;
  return {
    severity: "error",
    code: error.code,
    message: error.message.startsWith(messagePrefix) ? error.message.slice(messagePrefix.length) : error.message,
    span: node?.provenance.span ?? pointSpan(error.source.line, error.source.column),
    ...(authoredModule && authoredModule !== "project.cut" ? { module: authoredModule } : {}),
  };
}

function isSourceLocatedError(error: unknown): error is SourceLocatedError {
  if (!(error instanceof Error)) return false;
  const candidate = error as Partial<SourceLocatedError>;
  return typeof candidate.code === "string" && typeof candidate.source === "object" && candidate.source !== null;
}

function easingDiagnostic(ir: CutAVIR, error: ReferenceEasingConfigError): LanguageDiagnostic {
  const signal = ir.signals[error.signalId];
  return {
    severity: "error",
    code: error.code,
    message: error.message.replace(`${error.code}: `, ""),
    span: signal?.provenance.span ?? pointSpan(),
    ...(signal?.provenance.module && signal.provenance.module !== "project.cut" ? { module: signal.provenance.module } : {}),
  };
}

/**
 * Asset-free runtime preflight used by `cut check`.
 *
 * This deliberately validates only deterministic visual graph semantics that
 * are completely knowable from typed IR. Resource hashes, native tools,
 * decoded media and output locking remain the responsibility of lock/render.
 */
export function validateReferenceStaticVisualGraphs(ir: CutAVIR): readonly LanguageDiagnostic[] {
  const diagnostics: LanguageDiagnostic[] = [], identities = new Set<string>();
  const append = (diagnostic: LanguageDiagnostic) => {
    const identity = `${diagnostic.code}\u0000${diagnostic.module ?? ""}\u0000${diagnostic.span.start.line}\u0000${diagnostic.span.start.column}`;
    if (!identities.has(identity)) { identities.add(identity); diagnostics.push(diagnostic); }
  };

  let easingsValid = true;
  try { validateReferenceEasings(ir); }
  catch (error) {
    if (error instanceof ReferenceEasingConfigError) { easingsValid = false; append(easingDiagnostic(ir, error)); }
    else throw error;
  }

  try { validateReferencePlanarTrackResourceOwnership(ir); }
  catch (error) {
    if (!(error instanceof ReferencePlanarTrackError) && !isSourceLocatedError(error)) throw error;
    const located = error as SourceLocatedError;
    append(diagnosticFromNode(located, located.source.nodeId ? ir.nodes[located.source.nodeId] : undefined));
  }

  const localSpaceStructuralIndex = createReferenceLocalSpaceStructuralValidationIndex(ir);

  for (const composition of ir.compositions) {
    const selected = compositionNodeRoots(ir, composition.id);
    if (!selected) continue;
    try { assertCutGraphExecutionBudget(ir, selected.roots); }
    catch (error) {
      if (!isSourceLocatedError(error)) throw error;
      append(diagnosticFromNode(error, error.source.nodeId ? ir.nodes[error.source.nodeId] : undefined));
      continue;
    }
    try { validateReferencePrecompGraph(ir, composition); }
    catch (error) {
      if (!(error instanceof ReferencePrecompError) && !isSourceLocatedError(error)) throw error;
      const located = error as SourceLocatedError;
      append(diagnosticFromNode(located, located.source.nodeId ? ir.nodes[located.source.nodeId] : undefined));
      continue;
    }
    const reachable = reachableCompositionNodes(ir, selected.roots);
    let localSpaces;
    try {
      localSpaces = validateReferenceLocalSpaceGraph(ir, composition, reachable, {
        retainedMediaPlanning: "topology-only",
        structuralIndex: localSpaceStructuralIndex,
      });
      // Close authored/initial component-fragment and Camera2D retained
      // allocations before `cut check` can report success. Dynamic samples
      // are re-planned on every rendered frame through the same source-located
      // work contract.
      const componentEntriesByScene = new Map<string, ReferenceComponentFragmentLocalSpaceCompositionEntry[]>();
      const initialComponentPlanByOwner = new Map<string, ReturnType<typeof referenceComponentFragmentLocalSpacePlanAt>>();
      for (const localSpace of localSpaces.values()) {
        if (localSpace.owner === "component-fragment" && localSpace.ownerNodeId) {
          const fragment = ir.nodes[localSpace.ownerNodeId];
          if (fragment) {
            const initial = referenceComponentFragmentLocalSpacePlanAt(ir, composition, fragment, localSpace, fragment.interval.start);
            initialComponentPlanByOwner.set(fragment.id, initial);
            const entries = componentEntriesByScene.get(fragment.sceneId!) ?? [];
            entries.push(Object.freeze({ owner: fragment, localSpace, exactTime: fragment.interval.start }));
            componentEntriesByScene.set(fragment.sceneId!, entries);
          }
          continue;
        }
        if (localSpace.owner !== "camera-2d" || !localSpace.ownerNodeId) continue;
        const camera = ir.nodes[localSpace.ownerNodeId];
        if (camera) referenceCamera2DLocalSpacePlanAt(ir, composition, camera, localSpace, camera.interval.start);
      }
      // Sweep static work, not raw owner count. A larger set of opacity-zero or
      // tiny owners must not hide a smaller overlap whose retained transform
      // peaks exceed the aggregate envelope. At most two distinct maxima are
      // sampled, so this stays O(n log n) rather than checking every boundary
      // against every component. Exact dynamic samples are rechecked by the
      // renderer immediately before any frame pixels.
      for (const entries of componentEntriesByScene.values()) {
        const visibleEntries = entries.filter((entry) => initialComponentPlanByOwner.get(entry.owner.id)?.status === "visible");
        const events = new Map<string, { time: Rational; starts: ReferenceComponentFragmentLocalSpaceCompositionEntry[]; ends: ReferenceComponentFragmentLocalSpaceCompositionEntry[] }>();
        const event = (time: Rational, kind: "starts" | "ends", entry: ReferenceComponentFragmentLocalSpaceCompositionEntry) => {
          const key = `${time.numerator}/${time.denominator}`;
          const existing = events.get(key) ?? { time, starts: [], ends: [] };
          existing[kind].push(entry);
          events.set(key, existing);
        };
        for (const entry of visibleEntries) {
          const end = addRational(entry.owner.interval.start, entry.owner.interval.duration);
          event(entry.owner.interval.start, "starts", entry);
          event(end, "ends", entry);
        }
        const ordered = [...events.values()].sort((left, right) => compareRational(left.time, right.time));
        let maximumCountTime: Rational | undefined, maximumPeakTime: Rational | undefined;
        let maximumActive = -1, maximumPeak = -1, active = 0, peak = 0;
        const weight = (entry: ReferenceComponentFragmentLocalSpaceCompositionEntry) => initialComponentPlanByOwner
          .get(entry.owner.id)?.transformWork?.perTransform.peakLiveBytesUpperBound ?? 0;
        for (const point of ordered) {
          for (const entry of point.ends) { active -= 1; peak -= weight(entry); }
          for (const entry of point.starts) { active += 1; peak += weight(entry); }
          if (active > maximumActive) { maximumActive = active; maximumCountTime = point.time; }
          if (peak > maximumPeak) { maximumPeak = peak; maximumPeakTime = point.time; }
        }
        const maxima = new Map<string, Rational>();
        for (const time of [maximumCountTime, maximumPeakTime]) if (time) maxima.set(`${time.numerator}/${time.denominator}`, time);
        for (const maximumTime of maxima.values()) {
          const activeEntries = visibleEntries
            .filter((entry) => compareRational(maximumTime, entry.owner.interval.start) >= 0
              && compareRational(maximumTime, addRational(entry.owner.interval.start, entry.owner.interval.duration)) < 0)
            .map((entry) => Object.freeze({ ...entry, exactTime: maximumTime }));
          referenceComponentFragmentLocalSpaceFramePreflight(ir, composition, {
            sceneId: entries[0]!.owner.sceneId!,
            exactTime: maximumTime,
          }, activeEntries);
        }
      }
    }
    catch (error) {
      if (!(error instanceof ReferenceLocalSpaceError) && !isSourceLocatedError(error)) throw error;
      const located = error as SourceLocatedError;
      append(diagnosticFromNode(located, located.source.nodeId ? ir.nodes[located.source.nodeId] : undefined));
      continue;
    }
    let identityComponentFragments:
      ReturnType<typeof validateReferenceIdentityComponentFragments>;
    try {
      identityComponentFragments = validateReferenceIdentityComponentFragments(
        ir,
        composition,
        reachable,
        localSpaceStructuralIndex.componentFragmentAdmissionIndex,
      );
    } catch (error) {
      if (!(error instanceof ReferenceIdentityComponentFragmentError) && !isSourceLocatedError(error)) throw error;
      const located = error as SourceLocatedError;
      append(diagnosticFromNode(located, located.source.nodeId ? ir.nodes[located.source.nodeId] : undefined));
      continue;
    }
    try {
      validateReferenceCalloutStaticGraph(
        ir,
        composition,
        reachable,
        localSpaces,
        identityComponentFragments,
      );
    } catch (error) {
      if (!(error instanceof ReferenceCalloutError) && !isSourceLocatedError(error)) throw error;
      const located = error as SourceLocatedError;
      append(diagnosticFromNode(located, located.source.nodeId ? ir.nodes[located.source.nodeId] : undefined));
      continue;
    }
    try {
      validateReferenceResponsiveStackGraph(
        ir,
        composition,
        reachable,
        identityComponentFragments,
      );
    }
    catch (error) {
      if (!(error instanceof ReferenceResponsiveStackError) && !isSourceLocatedError(error)) throw error;
      const located = error as SourceLocatedError;
      append(diagnosticFromNode(located, located.source.nodeId ? ir.nodes[located.source.nodeId] : undefined));
      continue;
    }
    // Camera and annotation no-op analysis samples signals. Never sample an
    // easing graph after its prerequisite validator failed; the stable easing
    // diagnostic above is the causative source error.
    if (!easingsValid) continue;
    try {
      const mapCameras = validateReferenceMapCameraGraph(ir, composition, reachable);
      for (const config of mapCameras.values()) validateReferenceMapCameraGeoAnnotations(ir, composition, config);
    } catch (error) {
      if (!(error instanceof ReferenceMapCameraError) && !(error instanceof ReferenceGeoAnnotationError) && !isSourceLocatedError(error)) throw error;
      const located = error as SourceLocatedError;
      append(diagnosticFromNode(located, located.source.nodeId ? ir.nodes[located.source.nodeId] : undefined));
      continue;
    }
    let parallax;
    try {
      parallax = validateReferenceParallaxCameraGraph(ir, composition, reachable, {
        easingsValidated: true,
        localSpaceConfigs: localSpaces,
      });
    } catch (error) {
      if (!(error instanceof ReferenceParallaxCameraError) && !isSourceLocatedError(error)) throw error;
      const located = error as SourceLocatedError;
      append(diagnosticFromNode(located, located.source.nodeId ? ir.nodes[located.source.nodeId] : undefined));
      continue;
    }
    try { validateReferenceGeoAnnotationGraph(ir, composition, parallax, reachable, localSpaces); }
    catch (error) {
      if (!(error instanceof ReferenceGeoAnnotationError) && !isSourceLocatedError(error)) throw error;
      const located = error as SourceLocatedError;
      append(diagnosticFromNode(located, located.source.nodeId ? ir.nodes[located.source.nodeId] : undefined));
    }
  }
  return Object.freeze(diagnostics);
}
