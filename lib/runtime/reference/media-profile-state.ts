import { hash } from "../../core/stable";
import type { CutAVIR } from "../../language/ir";

export type ReferenceMediaProfileResourceState = Readonly<{
  resourceId: string;
  selected: "master" | "proxy";
  authoredProxy: boolean;
  digest: string;
}>;

export type ReferenceMediaProfileExecutionAuthority = Readonly<{
  format: "cut-reference-media-profile-execution-authority";
  version: 1;
  irSemanticHash: string;
  resources: readonly ReferenceMediaProfileResourceState[];
  authoritySha256: string;
}>;

// Selection authority is invocation-local and deliberately does not survive
// JSON serialization or structured cloning. The digest also prevents mutable
// selected metadata from becoming an authority after registration.
const selectedExecutions = new WeakMap<CutAVIR, ReadonlyMap<string, ReferenceMediaProfileResourceState>>();

export class ReferenceMediaProfileStateError extends Error {
  readonly code = "CUT_PROXY_PROFILE_STATE" as const;

  constructor(message: string) {
    super(`CUT_PROXY_PROFILE_STATE: ${message}`);
    this.name = "ReferenceMediaProfileStateError";
  }
}

function fail(message: string): never {
  throw new ReferenceMediaProfileStateError(message);
}

function resourceDigest(resource: CutAVIR["resources"][string]) {
  // Selection authorizes this exact resource record. Include identity, kind,
  // proxy locator, provenance, and all locked execution metadata so no field
  // can be added or swapped after registration without invalidating authority.
  return hash(resource);
}

function marker(resource: CutAVIR["resources"][string]) {
  const metadata = resource.metadata as { activeMediaVariant?: unknown; authoredProxy?: unknown } | undefined;
  if (metadata?.activeMediaVariant === undefined) {
    if (metadata?.authoredProxy !== undefined) fail(`resource ${resource.id} has authoredProxy without an active media variant.`);
    return undefined;
  }
  if (metadata.activeMediaVariant !== "master" && metadata.activeMediaVariant !== "proxy") {
    fail(`resource ${resource.id} has an invalid active media variant.`);
  }
  if (metadata.authoredProxy !== undefined && typeof metadata.authoredProxy !== "boolean") {
    fail(`resource ${resource.id} has invalid authoredProxy evidence.`);
  }
  return { selected: metadata.activeMediaVariant, authoredProxy: metadata.authoredProxy === true } as const;
}

function mediaResourceEntries(ir: CutAVIR) {
  return Object.entries(ir.resources).filter(([, resource]) => resource.kind === "video" || resource.kind === "audio");
}

function assertResourceMapBinding(key: string, resource: CutAVIR["resources"][string]) {
  if (key !== resource.id) fail(`resource map key ${JSON.stringify(key)} does not match embedded id ${JSON.stringify(resource.id)}.`);
}

function executionState(ir: CutAVIR) {
  const state = new Map<string, ReferenceMediaProfileResourceState>();
  for (const [key, resource] of mediaResourceEntries(ir)) {
    assertResourceMapBinding(key, resource);
    const marked = marker(resource);
    if (!marked) fail(`selected resource ${resource.id} has no active media variant.`);
    state.set(key, Object.freeze({ resourceId: resource.id, ...marked, digest: resourceDigest(resource) }));
  }
  return state;
}

function authorityContent(ir: CutAVIR, state: ReadonlyMap<string, ReferenceMediaProfileResourceState>) {
  return Object.freeze({
    format: "cut-reference-media-profile-execution-authority" as const,
    version: 1 as const,
    irSemanticHash: hash(ir),
    resources: Object.freeze([...state.values()].sort((left, right) => left.resourceId.localeCompare(right.resourceId))),
  });
}

function executionAuthority(ir: CutAVIR, state: ReadonlyMap<string, ReferenceMediaProfileResourceState>) {
  const content = authorityContent(ir, state);
  return Object.freeze({ ...content, authoritySha256: hash(content) });
}

function assertClosedExecutionAuthority(value: ReferenceMediaProfileExecutionAuthority) {
  if (!value || typeof value !== "object"
    || Object.keys(value).sort().join(",") !== "authoritySha256,format,irSemanticHash,resources,version"
    || value.format !== "cut-reference-media-profile-execution-authority"
    || value.version !== 1
    || !/^[a-f0-9]{64}$/u.test(value.irSemanticHash)
    || !/^[a-f0-9]{64}$/u.test(value.authoritySha256)
    || !Array.isArray(value.resources)) {
    fail("worker media-profile authority has an invalid closed envelope.");
  }
  for (const resource of value.resources) {
    if (!resource || typeof resource !== "object"
      || Object.keys(resource).sort().join(",") !== "authoredProxy,digest,resourceId,selected"
      || typeof resource.resourceId !== "string" || resource.resourceId.length < 1
      || (resource.selected !== "master" && resource.selected !== "proxy")
      || typeof resource.authoredProxy !== "boolean"
      || !/^[a-f0-9]{64}$/u.test(resource.digest)) {
      fail("worker media-profile authority has an invalid resource entry.");
    }
  }
}

export function registerReferenceMediaProfileExecution(ir: CutAVIR) {
  if (selectedExecutions.has(ir)) fail("media-profile execution authority is already registered for this IR object.");
  const state = executionState(ir);
  selectedExecutions.set(ir, state);
}

/**
 * Export the exact invocation-local selection authority for one static worker
 * bootstrap. The returned value is evidence, not transferable authority by
 * itself: a worker must independently authenticate the cloned IR and selected
 * resource bytes before re-registering it below.
 */
export function referenceMediaProfileExecutionAuthority(ir: CutAVIR) {
  const state = validatedExecutionState(ir);
  return state ? executionAuthority(ir, state) : undefined;
}

/** Re-establish authority only after the worker has authenticated this IR. */
export function registerReferenceMediaProfileExecutionAuthority(
  ir: CutAVIR,
  authority: ReferenceMediaProfileExecutionAuthority | undefined,
) {
  const mediaResources = mediaResourceEntries(ir);
  if (!mediaResources.length) {
    if (authority !== undefined) fail("resource-free worker IR carries unexpected media-profile authority.");
    return;
  }
  if (authority === undefined) fail("worker IR with selected media resources has no parent invocation authority.");
  if (selectedExecutions.has(ir)) fail("worker media-profile execution authority is already registered for this IR object.");
  assertClosedExecutionAuthority(authority);
  const state = executionState(ir);
  const expected = executionAuthority(ir, state);
  if (hash(authority) !== hash(expected)) fail("worker media-profile authority differs from the authenticated selected IR.");
  selectedExecutions.set(ir, state);
}

function validatedExecutionState(ir: CutAVIR) {
  const state = selectedExecutions.get(ir);
  const mediaResources = mediaResourceEntries(ir);
  for (const [key, resource] of mediaResources) assertResourceMapBinding(key, resource);
  const markedResources = mediaResources.filter(([, resource]) => marker(resource));
  if (!state) {
    if (markedResources.length) fail("serialized or cloned active media-profile evidence has no invocation-local authority.");
    return undefined;
  }
  if (mediaResources.length !== state.size || markedResources.length !== mediaResources.length) fail("selected resource set changed after media-profile selection.");
  for (const [key, resource] of mediaResources) {
    const expected = state.get(key);
    if (!expected || expected.digest !== resourceDigest(resource)) {
      fail(`selected resource ${resource.id} changed after media-profile selection.`);
    }
  }
  return state;
}

export function assertReferenceMediaProfileExecutionState(ir: CutAVIR) {
  // Never expose the actual Map stored in the WeakMap. ReadonlyMap is only a
  // TypeScript promise; returning it would let deep-import callers mutate the
  // invocation authority at runtime.
  validatedExecutionState(ir);
}

export function referenceMediaProfileResourceState(ir: CutAVIR, resourceId: string) {
  const resource = ir.resources[resourceId], state = selectedExecutions.get(ir);
  if (!resource) return undefined;
  assertResourceMapBinding(resourceId, resource);
  const marked = marker(resource);
  if (!state) {
    if (marked) fail(`resource ${resourceId} has no invocation-local media-profile authority.`);
    return undefined;
  }
  const expected = state.get(resourceId);
  if (!expected || !marked || expected.digest !== resourceDigest(resource)) {
    fail(`selected resource ${resourceId} changed after media-profile selection.`);
  }
  return expected;
}

export function isReferenceMediaProfileExecution(ir: CutAVIR) {
  return selectedExecutions.has(ir);
}
