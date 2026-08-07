import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, lstatSync, realpathSync, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rmdir, unlink } from "node:fs/promises";
import { platform } from "node:os";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { stableJsonStringify } from "../../core/stable";
import type { CutAVIR, IRResource, IRTranscriptBindingV1 } from "../../language/ir";
import { validateCutAvIr } from "../../language/ir-loader";
import {
  resolveLockedProjectPath,
  lockedResourceProbeNeedsDecodedAudioV2Relock,
  validateEmbeddedLockedIrContract,
  type LockedAudioMediaSelection,
  type LockedMediaSelection,
  type LockedResource,
  type LockedResourceProbe,
  type LockedResourceVariant,
  type LockedVideoMediaSelection,
} from "../../language/lock";
import { assertAppliedCutLockIr, registerAppliedCutLockIr } from "../../language/locked-ir-state";
import {
  CutTranscriptLockError,
  cutTranscriptSidecarMaxBytes,
  verifyCutTranscriptBindingsForLock,
} from "../../language/transcript-lock";
import { compareRational, zeroRational } from "../../language/rational";
import { decodedAudioSamplesDuration } from "../../language/audio-sample-witness";
import { decodedVideoCadenceDuration } from "../../language/video-cadence";
import { CutProjectError, validateProjectLocator } from "../../project/manifest";
import {
  probeProjectAudioProxyAlignment,
  probeProjectBytes,
  probeProjectDecodedAudioSamples,
  probeProjectDecodedVideoCadence,
  probeProjectImage,
  probeProjectMedia,
  probeProjectVideoProxyAlignment,
  type ProbeDecodedAudioNativeProcessExecutions,
  type ProbeNativeExecutables,
  type ProbeNativeProcessExecution,
  type ProbeProxyAlignmentNativeProcessExecutions,
} from "../../project/probe";
import {
  bindReferenceNativeMediaTool,
  createReferenceNativeProcessCollector,
  type BoundReferenceNativeMediaTool,
  type ReferenceNativeMediaTool,
  type ReferenceNativeProcessCollector,
  type ReferenceNativeProcessContext,
  type ReferenceNativeProcessLifecycleEvent,
  type ReferenceNativeProcessLifecycleEvidence,
} from "../../project/native-process-authority";
import {
  selectReferenceMediaProfile,
  type ReferenceMediaProfile,
  type ReferenceMediaProfileEvidence,
} from "./media-profile";
import { validateReferenceLutResources } from "./lut-config";
import { validateReferencePlanarTrackResources } from "./planar-tracking";
import { validateReferenceMediaCamera2DGraph } from "./media-camera2d";
import { referenceReachableCompositionNodes } from "./validate";

export type ReferenceVerifiedInputSessionLimits = Readonly<{
  /** Exact ceiling for each master or proxy snapshot. */
  maxFileBytes: bigint;
  /** Exact ceiling across every master and proxy snapshot in the session. */
  maxAggregateBytes: bigint;
  /** A proxy counts as a separate variant. */
  maxVariants: number;
}>;

export const defaultReferenceVerifiedInputSessionLimits: ReferenceVerifiedInputSessionLimits = Object.freeze({
  maxFileBytes: 100n * 1024n * 1024n * 1024n,
  maxAggregateBytes: 256n * 1024n * 1024n * 1024n,
  maxVariants: 20_000,
});

/**
 * Native probes may each own a decoder/ffprobe child. Keep the production
 * width small and fixed rather than deriving it from host CPU count.
 */
export const referenceVerifiedInputProbeConcurrency = 4;

export type ReferenceVerifiedInputProbeTestEvent = Readonly<{
  phase: "start" | "settled";
  ordinal: number;
  resourceId: string;
  variant: "master" | "proxy";
  status?: "fulfilled" | "rejected";
}>;

export type ReferenceVerifiedInputOperationTestEvent = Readonly<{
  operation:
    | "post-probe-open"
    | "post-probe-stat"
    | "post-probe-read"
    | "post-probe-lstat"
    | "post-probe-close"
    | "cleanup-complete";
  resourceId?: string;
  variant?: "master" | "proxy";
}>;

export type ReferenceVerifiedInputSessionTestHooks = Readonly<{
  /** Tests may reduce, never raise, the fixed production probe width. */
  probeConcurrency?: number;
  probeEvent?: (event: ReferenceVerifiedInputProbeTestEvent) => void | Promise<void>;
  /** Test-only native executable selection for deterministic subprocess failures. */
  nativeExecutables?: ProbeNativeExecutables;
  /** Test-only operation boundary; production never accepts ambient hooks. */
  operationEvent?: (event: ReferenceVerifiedInputOperationTestEvent) => void | Promise<void>;
}>;

export type ReferenceVerifiedInputSessionErrorCode =
  | "CUT_INPUT_SESSION_CONTRACT"
  | "CUT_INPUT_SESSION_LOCK_STATE"
  | "CUT_INPUT_SESSION_PATH"
  | "CUT_INPUT_SESSION_RESOURCE_LIMIT"
  | "CUT_INPUT_SESSION_SOURCE_CHANGED"
  | "CUT_LOCK_INTEGRITY"
  | "CUT_LOCK_METADATA"
  | "CUT_LOCK_VERSION"
  | "CUT_INPUT_SESSION_PROBE";

export class ReferenceVerifiedInputSessionError extends Error {
  readonly source?: Readonly<{ module: string; line: number; column: number; resourceId: string }>;
  /** A transactional cleanup failure never replaces or hides the primary failure. */
  readonly cleanupFailure?: unknown;

  constructor(
    readonly code: ReferenceVerifiedInputSessionErrorCode,
    message: string,
    readonly detail: Readonly<{
      resourceId?: string;
      variant?: "master" | "proxy";
      locator?: string;
      reason: string;
      source?: Readonly<{ module: string; line: number; column: number; resourceId: string }>;
    }>,
    options: ErrorOptions = {},
  ) {
    super(`${code}: ${message}`, options);
    this.name = "ReferenceVerifiedInputSessionError";
    this.source = detail.source;
  }
}

export type ReferenceVerifiedInputVariantEvidence = Readonly<{
  resourceId: string;
  resourceKind: IRResource["kind"];
  variant: "master" | "proxy";
  selected: boolean;
  bytes: string;
  sha256: string;
  probeKind: LockedResourceProbe["kind"];
}>;

export type ReferenceVerifiedInputSessionEvidence = Readonly<{
  format: "cut-reference-verified-input-session";
  version: 1;
  requestedProfile: ReferenceMediaProfile;
  variants: readonly ReferenceVerifiedInputVariantEvidence[];
  variantCount: number;
  aggregateBytes: string;
  /** Copying and native verification happen in two non-overlapping phases. */
  verificationOrder: "snapshot-all-then-probe-all";
}>;

export type ReferenceVerifiedInputSession = Readonly<{
  /** Profile-selected IR. Snapshot paths never enter this graph or its build identity. */
  ir: CutAVIR;
  media: ReferenceMediaProfileEvidence;
  /** Resolve only a known selected resource to its private read-only snapshot. */
  pathFor: (resourceId: string) => string;
  /** Deliberately excludes the random session directory and absolute paths. */
  evidence: ReferenceVerifiedInputSessionEvidence;
  /** Idempotent. The private snapshots remain valid until this is called. */
  cleanup: () => Promise<void>;
}>;

export type ReferenceVerifiedInputNativeProcessEvidence = Readonly<{
  format: "cut-reference-verified-input-native-process-evidence";
  version: 1;
  parentPid: number;
  expectedProcessGroupId: number | null;
  tools: readonly ReferenceNativeProcessLifecycleEvidence[];
  receiptCount: number;
  receiptsSha256: string;
}>;

export const referenceVerifiedInputMaximumUnresolvedNativeProcesses = 5;

export type ReferenceVerifiedInputNativeProcessPlanEntry = Readonly<{
  index: number;
  entryId: string;
  tool: ReferenceNativeMediaTool;
  context: ReferenceNativeProcessContext;
}>;

export type ReferenceVerifiedInputNativeProcessPlan = Readonly<{
  format: "cut-reference-verified-input-native-process-plan";
  version: 1;
  maximumUnresolvedProcesses: typeof referenceVerifiedInputMaximumUnresolvedNativeProcesses;
  entries: readonly ReferenceVerifiedInputNativeProcessPlanEntry[];
  entryCount: number;
  ffmpegCount: number;
  ffprobeCount: number;
  planSha256: string;
}>;

export type ReferenceVerifiedInputNativeProcessLifecycleStreamEvent = Readonly<{
  format: "cut-reference-verified-input-native-process-event";
  version: 1;
  sequence: number;
  previousEventSha256: string | null;
  planSha256: string;
  event: ReferenceNativeProcessLifecycleEvent;
  eventSha256: string;
}>;

export type ReferenceVerifiedInputNativeProcessLifecycleStreamEvidence = Readonly<{
  format: "cut-reference-verified-input-native-process-stream";
  version: 1;
  planSha256: string;
  eventCount: number;
  eventsSha256: string;
  completedEntryIds: readonly string[];
  completedCount: number;
  maximumUnresolvedProcesses: typeof referenceVerifiedInputMaximumUnresolvedNativeProcesses;
  peakUnresolvedProcesses: number;
}>;

export type ReferenceVerifiedInputNativeProcessSupervision = Readonly<{
  expectedPlan: ReferenceVerifiedInputNativeProcessPlan;
  lifecycleEvent: (event: ReferenceVerifiedInputNativeProcessLifecycleStreamEvent) => void;
}>;

export type ReferenceVerifiedInputSessionWithNativeProcessEvidence = Readonly<{
  session: ReferenceVerifiedInputSession;
  nativeProcesses: ReferenceVerifiedInputNativeProcessEvidence;
  nativeProcessPlan: ReferenceVerifiedInputNativeProcessPlan;
  nativeProcessLifecycle: ReferenceVerifiedInputNativeProcessLifecycleStreamEvidence;
}>;

type VariantExpectation = Readonly<{
  resource: IRResource;
  variant: "master" | "proxy";
  locator: string;
  bytes: number;
  sha256: string;
  probe: LockedResourceProbe;
}>;

type StableStat = Readonly<{
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

type SessionDirectory = Readonly<{
  physicalRoot: string;
  path: string;
  identity: Readonly<{ dev: bigint; ino: bigint }>;
  files: Array<{ path: string; identity: StableStat }>;
  cleanup: () => Promise<void>;
}>;

const hashes = /^[a-f0-9]{64}$/u;
const codeUnitCompare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const resourceSource = (resource: IRResource) => Object.freeze({
  module: resource.provenance.module,
  line: resource.provenance.span.start.line,
  column: resource.provenance.span.start.column,
  resourceId: resource.id,
});
const byteCoverage: Readonly<Record<"font" | "data", readonly string[]>> = Object.freeze({
  font: Object.freeze(["font-table validation", "text shaping", "font fallback", "glyph rasterization"]),
  data: Object.freeze(["data schema", "semantic interpretation", "external references"]),
});

type NativeProcessInvocation = Readonly<{
  authorities: Readonly<Partial<Record<ReferenceNativeMediaTool, BoundReferenceNativeMediaTool>>>;
  collectors: Readonly<Partial<Record<ReferenceNativeMediaTool, ReferenceNativeProcessCollector>>>;
  executables: ProbeNativeExecutables;
  plan: ReferenceVerifiedInputNativeProcessPlan;
  execution: (tool: ReferenceNativeMediaTool, context: ReferenceNativeProcessContext) => ProbeNativeProcessExecution;
  seal: () => Promise<Readonly<{
    nativeProcesses: ReferenceVerifiedInputNativeProcessEvidence;
    lifecycle: ReferenceVerifiedInputNativeProcessLifecycleStreamEvidence;
  }>>;
}>;

type NativeProcessLifecycleController = Readonly<{
  issue: (tool: ReferenceNativeMediaTool, context: ReferenceNativeProcessContext) => ReferenceVerifiedInputNativeProcessPlanEntry;
  observe: (event: ReferenceNativeProcessLifecycleEvent) => void;
  seal: (receiptCount: number) => ReferenceVerifiedInputNativeProcessLifecycleStreamEvidence;
}>;

function createNativeProcessLifecycleController(
  plan: ReferenceVerifiedInputNativeProcessPlan,
  sink?: (event: ReferenceVerifiedInputNativeProcessLifecycleStreamEvent) => void,
  expectedParentPid = process.pid,
  expectedProcessGroupId: number | null = null,
): NativeProcessLifecycleController {
  const plannedById = new Map(plan.entries.map((entry) => [entry.entryId, entry]));
  const issued = new Set<string>();
  const active = new Map<string, Readonly<{
    entry: ReferenceVerifiedInputNativeProcessPlanEntry;
    phase: ReferenceNativeProcessLifecycleEvent["phase"];
    childPid: number | null;
    exit?: Readonly<{ code: number | null; signal: NodeJS.Signals | null }>;
  }>>();
  // Lifecycle evidence remains active through asynchronous post-close
  // executable revalidation, but the native-process concurrency ceiling is
  // about helpers that have not yet reached a terminal exit. Keep those two
  // states separate so already-exited helpers cannot consume live admission
  // while their close receipt is being authenticated.
  const unresolvedProcesses = new Set<string>();
  const completed = new Set<string>();
  const childPids = new Set<number>();
  const receiptIdentities = new Map<string, string>();
  const eventHashes: string[] = [];
  let previousEventSha256: string | null = null;
  let peakUnresolvedProcesses = 0;
  let lifecycleFailure: unknown;
  let sealed = false;
  const issue = (tool: ReferenceNativeMediaTool, context: ReferenceNativeProcessContext) => {
    if (sealed) failure("CUT_INPUT_SESSION_PROBE", "Verified-input native process lifecycle is sealed.", { resourceId: context.resourceId, variant: context.variant, reason: "native-process-lifecycle-sealed" });
    const entryId = nativeProcessPlanEntryId(tool, context);
    const entry = plannedById.get(entryId);
    if (!entry || stableJsonStringify(entry.context) !== stableJsonStringify(context)) {
      failure("CUT_INPUT_SESSION_PROBE", `Verified-input ${tool} process is absent from the exact locked plan.`, { resourceId: context.resourceId, variant: context.variant, reason: "native-process-plan-entry" });
    }
    if (issued.has(entryId)) {
      failure("CUT_INPUT_SESSION_PROBE", `Verified-input ${tool} process plan entry was issued twice.`, { resourceId: context.resourceId, variant: context.variant, reason: "native-process-plan-duplicate" });
    }
    issued.add(entryId);
    return entry;
  };
  const observe = (event: ReferenceNativeProcessLifecycleEvent) => {
    try {
      if (!record(event)
        || event.format !== "cut-reference-native-process-lifecycle-event"
        || event.version !== 1
        || !/^[a-f0-9]{64}$/u.test(event.receiptId)
        || !["ffmpeg", "ffprobe"].includes(event.tool)
        || event.executable?.tool !== event.tool
        || !Number.isSafeInteger(event.executable.bytes) || event.executable.bytes < 1
        || !/^[a-f0-9]{64}$/u.test(event.executable.sha256)
        || !/^[a-f0-9]{64}$/u.test(event.executable.canonicalPathSha256)
        || !Number.isSafeInteger(event.argvCount) || event.argvCount < 1
        || !/^[a-f0-9]{64}$/u.test(event.argvSha256)
        || event.parentPid !== expectedParentPid
        || event.expectedProcessGroupId !== expectedProcessGroupId) {
        failure("CUT_INPUT_SESSION_PROBE", "A native helper lifecycle event has invalid executable or ancestry authority.", { reason: "native-process-event-authority" });
      }
      if (sealed) failure("CUT_INPUT_SESSION_PROBE", "A native helper lifecycle event arrived after seal.", { resourceId: event.context.resourceId, variant: event.context.variant, reason: "native-process-late-event" });
      const entryId = nativeProcessPlanEntryId(event.tool, event.context);
      const entry = plannedById.get(entryId);
      if (!entry || stableJsonStringify(entry.context) !== stableJsonStringify(event.context)) {
        failure("CUT_INPUT_SESSION_PROBE", "A native helper lifecycle event is absent from the exact locked plan.", { resourceId: event.context.resourceId, variant: event.context.variant, reason: "native-process-unplanned-event" });
      }
      if (!issued.has(entryId)) {
        failure("CUT_INPUT_SESSION_PROBE", "A native helper lifecycle event preceded its issued plan entry.", { resourceId: event.context.resourceId, variant: event.context.variant, reason: "native-process-unissued-event" });
      }
      const identitySha256 = createHash("sha256").update(stableJsonStringify(Object.freeze({
        receiptId: event.receiptId,
        tool: event.tool,
        context: event.context,
        executable: event.executable,
        argvCount: event.argvCount,
        argvSha256: event.argvSha256,
        parentPid: event.parentPid,
        expectedProcessGroupId: event.expectedProcessGroupId,
      }))).digest("hex");
      const priorIdentity = receiptIdentities.get(entryId);
      if (priorIdentity !== undefined && priorIdentity !== identitySha256) {
        failure("CUT_INPUT_SESSION_PROBE", "A native helper lifecycle identity changed between phases.", { resourceId: event.context.resourceId, variant: event.context.variant, reason: "native-process-event-identity" });
      }
      const current = active.get(entryId);
      if (event.phase === "reserved") {
        if (current || completed.has(entryId) || event.childPid !== null) {
          failure("CUT_INPUT_SESSION_PROBE", "A native helper reservation duplicated or carried a child pid.", { resourceId: event.context.resourceId, variant: event.context.variant, reason: "native-process-reservation" });
        }
        receiptIdentities.set(entryId, identitySha256);
        if (unresolvedProcesses.size >= referenceVerifiedInputMaximumUnresolvedNativeProcesses) {
          failure("CUT_INPUT_SESSION_PROBE", `Verified-input native helper concurrency exceeds ${referenceVerifiedInputMaximumUnresolvedNativeProcesses}.`, { resourceId: event.context.resourceId, variant: event.context.variant, reason: "native-process-concurrency" });
        }
        active.set(entryId, Object.freeze({ entry, phase: "reserved", childPid: null }));
        unresolvedProcesses.add(entryId);
        peakUnresolvedProcesses = Math.max(peakUnresolvedProcesses, unresolvedProcesses.size);
      } else if (event.phase === "launched") {
        if (!current || current.phase !== "reserved" || !Number.isSafeInteger(event.childPid) || (event.childPid as number) < 1
          || childPids.has(event.childPid as number)) {
          failure("CUT_INPUT_SESSION_PROBE", "A native helper launch does not follow one unique reservation.", { resourceId: event.context.resourceId, variant: event.context.variant, reason: "native-process-launch" });
        }
        childPids.add(event.childPid as number);
        active.set(entryId, Object.freeze({ entry, phase: "launched", childPid: event.childPid }));
      } else if (event.phase === "spawn-confirmed") {
        if (!current || current.phase !== "launched" || current.childPid !== event.childPid) {
          failure("CUT_INPUT_SESSION_PROBE", "A native helper spawn receipt does not match its launch.", { resourceId: event.context.resourceId, variant: event.context.variant, reason: "native-process-spawn-confirmed" });
        }
        active.set(entryId, Object.freeze({ entry, phase: "spawn-confirmed", childPid: event.childPid }));
      } else if (event.phase === "exit") {
        if (!current || current.phase !== "spawn-confirmed" || current.childPid !== event.childPid || event.terminal === undefined) {
          failure("CUT_INPUT_SESSION_PROBE", "A native helper exit does not match its spawned lifecycle.", { resourceId: event.context.resourceId, variant: event.context.variant, reason: "native-process-exit" });
        }
        active.set(entryId, Object.freeze({ entry, phase: "exit", childPid: event.childPid, exit: event.terminal }));
        unresolvedProcesses.delete(entryId);
      } else if (event.phase === "close-verified") {
        if (!current || current.phase !== "exit" || current.childPid !== event.childPid || event.terminal === undefined
          || stableJsonStringify(current.exit) !== stableJsonStringify(event.terminal)) {
          failure("CUT_INPUT_SESSION_PROBE", "A native helper verified close does not match its exit.", { resourceId: event.context.resourceId, variant: event.context.variant, reason: "native-process-close" });
        }
        active.delete(entryId);
        completed.add(entryId);
      } else {
        if (!current || current.phase !== "reserved" || event.failureCode === undefined) {
          failure("CUT_INPUT_SESSION_PROBE", "A native helper spawn failure does not match its reservation.", { resourceId: event.context.resourceId, variant: event.context.variant, reason: "native-process-spawn-failed" });
        }
        active.delete(entryId);
        unresolvedProcesses.delete(entryId);
      }
      const base = Object.freeze({
        format: "cut-reference-verified-input-native-process-event" as const,
        version: 1 as const,
        sequence: eventHashes.length,
        previousEventSha256,
        planSha256: plan.planSha256,
        event,
      });
      const envelope = Object.freeze({
        ...base,
        eventSha256: createHash("sha256").update(stableJsonStringify(base)).digest("hex"),
      }) satisfies ReferenceVerifiedInputNativeProcessLifecycleStreamEvent;
      sink?.(envelope);
      eventHashes.push(envelope.eventSha256);
      previousEventSha256 = envelope.eventSha256;
    } catch (error) {
      lifecycleFailure ??= error;
      throw error;
    }
  };
  const seal = (receiptCount: number) => {
    if (sealed) failure("CUT_INPUT_SESSION_PROBE", "Verified-input native process lifecycle was already sealed.", { reason: "native-process-lifecycle-seal" });
    sealed = true;
    if (lifecycleFailure !== undefined) throw lifecycleFailure;
    if (active.size !== 0 || unresolvedProcesses.size !== 0 || issued.size !== plan.entryCount || completed.size !== plan.entryCount
      || receiptCount !== plan.entryCount || eventHashes.length !== plan.entryCount * 5) {
      failure("CUT_INPUT_SESSION_PROBE", "Verified-input native helper lifecycle does not exactly exhaust its locked plan.", { reason: "native-process-plan-incomplete" });
    }
    const completedEntryIds = Object.freeze(plan.entries.map((entry) => entry.entryId));
    return Object.freeze({
      format: "cut-reference-verified-input-native-process-stream" as const,
      version: 1 as const,
      planSha256: plan.planSha256,
      eventCount: eventHashes.length,
      eventsSha256: createHash("sha256").update(stableJsonStringify(eventHashes)).digest("hex"),
      completedEntryIds,
      completedCount: completedEntryIds.length,
      maximumUnresolvedProcesses: referenceVerifiedInputMaximumUnresolvedNativeProcesses,
      peakUnresolvedProcesses,
    });
  };
  return Object.freeze({ issue, observe, seal });
}

/** Focused hostile-test surface; production uses the same controller. */
export function createReferenceVerifiedInputNativeProcessLifecycleControllerForTest(
  plan: ReferenceVerifiedInputNativeProcessPlan,
  sink?: (event: ReferenceVerifiedInputNativeProcessLifecycleStreamEvent) => void,
  options: Readonly<{ parentPid?: number; expectedProcessGroupId?: number | null }> = {},
) {
  return createNativeProcessLifecycleController(
    plan,
    sink,
    options.parentPid ?? process.pid,
    options.expectedProcessGroupId ?? null,
  );
}

async function createNativeProcessInvocation(
  variants: readonly VariantExpectation[],
  authoredPaths: ProbeNativeExecutables = {},
  expectedProcessGroupId: number | null = null,
  supervision?: ReferenceVerifiedInputNativeProcessSupervision,
): Promise<NativeProcessInvocation> {
  if (supervision !== undefined && (!record(supervision)
    || Object.keys(supervision).some((key) => !["expectedPlan", "lifecycleEvent"].includes(key))
    || typeof supervision.lifecycleEvent !== "function")) {
    failure("CUT_INPUT_SESSION_CONTRACT", "Verified-input native process supervision is malformed.", { reason: "native-process-supervision" });
  }
  const plan = referenceVerifiedInputNativeProcessPlanFromVariants(variants);
  if (supervision !== undefined && stableJsonStringify(supervision.expectedPlan) !== stableJsonStringify(plan)) {
    failure("CUT_INPUT_SESSION_PROBE", "Verified-input native process supervision plan differs from the locked graph.", { reason: "native-process-plan-mismatch" });
  }
  const needsFfprobe = plan.ffprobeCount > 0;
  const needsFfmpeg = plan.ffmpegCount > 0;
  const authorities: Partial<Record<ReferenceNativeMediaTool, BoundReferenceNativeMediaTool>> = {};
  if (needsFfprobe) authorities.ffprobe = await bindReferenceNativeMediaTool("ffprobe", authoredPaths.ffprobe);
  if (needsFfmpeg) authorities.ffmpeg = await bindReferenceNativeMediaTool("ffmpeg", authoredPaths.ffmpeg);
  const lifecycleController = createNativeProcessLifecycleController(
    plan,
    supervision?.lifecycleEvent,
    process.pid,
    expectedProcessGroupId,
  );
  const collectors: Partial<Record<ReferenceNativeMediaTool, ReferenceNativeProcessCollector>> = {};
  for (const tool of ["ffmpeg", "ffprobe"] as const) {
    const authority = authorities[tool];
    if (authority) collectors[tool] = createReferenceNativeProcessCollector(authority, {
      parentPid: process.pid,
      expectedProcessGroupId,
      lifecycleEvent: lifecycleController.observe,
    });
  }
  let sealed = false;
  const execution = (tool: ReferenceNativeMediaTool, context: ReferenceNativeProcessContext): ProbeNativeProcessExecution => {
    const authority = authorities[tool], collector = collectors[tool];
    if (!authority || !collector || sealed) {
      failure("CUT_INPUT_SESSION_PROBE", `Verified-input ${tool} process authority is unavailable.`, { resourceId: context.resourceId, variant: context.variant, reason: "native-process-authority" });
    }
    lifecycleController.issue(tool, context);
    return Object.freeze({ authority, collector, context: Object.freeze({ ...context }) });
  };
  const seal = async () => {
    if (sealed) failure("CUT_INPUT_SESSION_PROBE", "Verified-input native process evidence was already sealed.", { reason: "native-process-seal" });
    sealed = true;
    const entries = (["ffmpeg", "ffprobe"] as const)
      .map((tool) => collectors[tool])
      .filter((collector): collector is ReferenceNativeProcessCollector => collector !== undefined);
    const outcomes = await Promise.allSettled(entries.map((collector) => collector.seal()));
    const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    if (failures.length) {
      throw failures.length === 1 ? failures[0].reason : new AggregateError(failures.map((outcome) => outcome.reason), "Multiple native process collectors failed to seal.");
    }
    const tools = Object.freeze((outcomes as PromiseFulfilledResult<ReferenceNativeProcessLifecycleEvidence>[])
      .map((outcome) => outcome.value)
      .sort((left, right) => codeUnitCompare(left.executable.tool, right.executable.tool)));
    const receiptPids = new Set<number>();
    for (const tool of tools) {
      if (tool.parentPid !== process.pid || tool.expectedProcessGroupId !== expectedProcessGroupId) {
        failure("CUT_INPUT_SESSION_PROBE", "Native process evidence does not match its verified-input invocation.", { reason: "native-process-parent" });
      }
      for (const receipt of tool.receipts) {
        if (receiptPids.has(receipt.childPid)) {
          failure("CUT_INPUT_SESSION_PROBE", "Native process evidence reused one child pid across tool authorities.", { resourceId: receipt.context.resourceId, variant: receipt.context.variant, reason: "native-process-pid-reuse" });
        }
        receiptPids.add(receipt.childPid);
      }
    }
    const receiptCount = tools.reduce((sum, tool) => sum + tool.receiptCount, 0);
    const nativeProcesses = Object.freeze({
      format: "cut-reference-verified-input-native-process-evidence" as const,
      version: 1 as const,
      parentPid: process.pid,
      expectedProcessGroupId,
      tools,
      receiptCount,
      receiptsSha256: createHash("sha256").update(stableJsonStringify(tools)).digest("hex"),
    });
    const lifecycle = lifecycleController.seal(receiptCount);
    return Object.freeze({ nativeProcesses, lifecycle });
  };
  return Object.freeze({
    authorities: Object.freeze({ ...authorities }),
    collectors: Object.freeze({ ...collectors }),
    executables: Object.freeze({
      ...(authorities.ffmpeg ? { ffmpeg: authorities.ffmpeg.executablePath } : {}),
      ...(authorities.ffprobe ? { ffprobe: authorities.ffprobe.executablePath } : {}),
    }),
    plan,
    execution,
    seal,
  });
}

function failure(
  code: ReferenceVerifiedInputSessionErrorCode,
  message: string,
  detail: ReferenceVerifiedInputSessionError["detail"],
  cause?: unknown,
): never {
  throw new ReferenceVerifiedInputSessionError(code, message, Object.freeze(detail), cause === undefined ? {} : { cause });
}

function attachCleanupFailure(primary: unknown, cleanupFailure: unknown) {
  if (!(primary instanceof Error)) {
    throw new AggregateError([primary, cleanupFailure], "Verified-input preparation and transactional cleanup both failed.");
  }
  Object.defineProperty(primary, "cleanupFailure", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: cleanupFailure,
  });
}

function systemCode(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stableStat(value: BigIntStats): StableStat {
  return Object.freeze({ dev: value.dev, ino: value.ino, size: value.size, mtimeNs: value.mtimeNs, ctimeNs: value.ctimeNs });
}

function sameStat(left: StableStat, right: StableStat) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function inside(root: string, candidate: string) {
  const local = relative(root, candidate);
  return local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

function lockedVariant(resource: IRResource, variant: "master" | "proxy"): VariantExpectation {
  if (resource.state !== "locked" || typeof resource.sha256 !== "string" || !hashes.test(resource.sha256)) {
    failure("CUT_INPUT_SESSION_LOCK_STATE", `Resource ${JSON.stringify(resource.id)} is not byte-locked.`, { resourceId: resource.id, variant, locator: resource.locator, reason: "unlocked" });
  }
  const metadata = resource.metadata;
  if (!record(metadata) || metadata.lockVersion !== 2 || !Number.isSafeInteger(metadata.bytes) || Number(metadata.bytes) < 0 || !record(metadata.probe)) {
    failure("CUT_INPUT_SESSION_LOCK_STATE", `Resource ${JSON.stringify(resource.id)} has no valid embedded cut.lock v3 metadata.`, { resourceId: resource.id, variant, locator: resource.locator, reason: "metadata" });
  }
  if (variant === "master") {
    return Object.freeze({
      resource,
      variant,
      locator: resource.locator,
      bytes: Number(metadata.bytes),
      sha256: resource.sha256,
      probe: metadata.probe as unknown as LockedResourceProbe,
    });
  }
  const authored = resource.proxy?.locator, proxy = metadata.proxy;
  if ((resource.kind !== "video" && resource.kind !== "audio") || !authored || !record(proxy)
    || proxy.locator !== authored || !Number.isSafeInteger(proxy.bytes) || Number(proxy.bytes) < 0
    || typeof proxy.sha256 !== "string" || !hashes.test(proxy.sha256) || !record(proxy.probe)) {
    failure("CUT_INPUT_SESSION_LOCK_STATE", `Resource ${JSON.stringify(resource.id)} has invalid embedded proxy metadata.`, { resourceId: resource.id, variant, locator: authored ?? resource.locator, reason: "proxy-metadata" });
  }
  return Object.freeze({
    resource,
    variant,
    locator: authored,
    bytes: Number(proxy.bytes),
    sha256: proxy.sha256,
    probe: proxy.probe as unknown as LockedResourceProbe,
  });
}

function assertProbeFileIdentity(expectation: VariantExpectation) {
  const { probe, resource, locator, bytes, sha256, variant } = expectation;
  const requiredKind = resource.kind === "video" || resource.kind === "audio"
    ? "media"
    : resource.kind === "image" ? "image" : "bytes";
  if (probe.kind !== requiredKind || !record(probe.identity) || !record(probe.identity.file)) {
    failure("CUT_INPUT_SESSION_LOCK_STATE", `Resource ${JSON.stringify(resource.id)} has an incompatible stored ${variant} probe.`, { resourceId: resource.id, variant, locator, reason: "probe-kind" });
  }
  const file = probe.identity.file;
  if (file.locator !== locator || file.bytes !== bytes || file.sha256 !== sha256) {
    failure("CUT_INPUT_SESSION_LOCK_STATE", `Resource ${JSON.stringify(resource.id)} stored ${variant} probe does not match its locked file identity.`, { resourceId: resource.id, variant, locator, reason: "probe-file-identity" });
  }
  if (probe.kind === "bytes") {
    const expectedCoverage = resource.kind === "font" || resource.kind === "data" ? byteCoverage[resource.kind] : undefined;
    if (!expectedCoverage || stableJsonStringify(probe.coverage) !== stableJsonStringify({ level: "bytes-only", excludes: expectedCoverage })) {
      failure("CUT_INPUT_SESSION_LOCK_STATE", `Resource ${JSON.stringify(resource.id)} has an invalid bytes-only coverage boundary.`, { resourceId: resource.id, variant, locator, reason: "probe-coverage" });
    }
  }
}

function expectations(ir: CutAVIR) {
  const result: VariantExpectation[] = [];
  for (const resource of Object.values(ir.resources).sort((left, right) => codeUnitCompare(left.id, right.id))) {
    const master = lockedVariant(resource, "master");
    assertProbeFileIdentity(master);
    result.push(master);
    if (resource.proxy) {
      const proxy = lockedVariant(resource, "proxy");
      assertProbeFileIdentity(proxy);
      result.push(proxy);
    } else if (record(resource.metadata) && resource.metadata.proxy !== undefined) {
      failure("CUT_INPUT_SESSION_LOCK_STATE", `Resource ${JSON.stringify(resource.id)} embeds a proxy that is absent from canonical source IR.`, { resourceId: resource.id, variant: "proxy", locator: resource.locator, reason: "proxy-authorship" });
    }
  }
  return result;
}

function nativeProcessPlanEntryId(tool: ReferenceNativeMediaTool, context: ReferenceNativeProcessContext) {
  return createHash("sha256").update(stableJsonStringify(Object.freeze({
    domain: "cut-reference-verified-input-native-process-plan-entry-v1",
    tool,
    context,
  }))).digest("hex");
}

function referenceVerifiedInputNativeProcessPlanFromVariants(
  variants: readonly VariantExpectation[],
): ReferenceVerifiedInputNativeProcessPlan {
  const planned: Array<Readonly<{ tool: ReferenceNativeMediaTool; context: ReferenceNativeProcessContext }>> = [];
  const add = (tool: ReferenceNativeMediaTool, context: ReferenceNativeProcessContext) => {
    planned.push(Object.freeze({ tool, context: Object.freeze({ ...context }) }));
  };
  for (let ordinal = 0; ordinal < variants.length; ordinal += 1) {
    const variant = variants[ordinal];
    if (variant.resource.kind !== "video" && variant.resource.kind !== "audio") continue;
    const base = Object.freeze({
      resourceId: variant.resource.id,
      resourceSha256: variant.sha256,
      resourceBytes: variant.bytes,
      variant: variant.variant,
    });
    add("ffprobe", Object.freeze({
      ordinal: ordinal * 4,
      operation: "media-metadata",
      ...base,
    }));
    if (variant.probe.kind !== "media") continue;
    const video = variant.probe.selected.video;
    if (video?.decodedVideoCadence) {
      add("ffprobe", Object.freeze({
        ordinal: ordinal * 4 + 1,
        operation: "decoded-video-cadence",
        ...base,
        streamIndex: video.streamIndex,
      }));
    }
    const audio = variant.probe.selected.audio;
    if (audio?.decodedAudioSamples) {
      add("ffmpeg", Object.freeze({
        ordinal: ordinal * 3,
        operation: "decoded-audio-pcm",
        ...base,
        streamIndex: audio.streamIndex,
      }));
      add("ffprobe", Object.freeze({
        ordinal: ordinal * 4 + 2,
        operation: "decoded-audio-samples",
        ...base,
        streamIndex: audio.streamIndex,
      }));
    }
  }
  const byResource = new Map<string, { master?: VariantExpectation; proxy?: VariantExpectation }>();
  for (const variant of variants) {
    const pair = byResource.get(variant.resource.id) ?? {};
    pair[variant.variant] = variant;
    byResource.set(variant.resource.id, pair);
  }
  const orderedResources = [...byResource].sort(([left], [right]) => codeUnitCompare(left, right));
  for (let pairIndex = 0; pairIndex < orderedResources.length; pairIndex += 1) {
    const [resourceId, pair] = orderedResources[pairIndex];
    const master = pair.master, proxy = pair.proxy;
    if (!master || !proxy || master.probe.kind !== "media" || proxy.probe.kind !== "media") continue;
    const masterAudio = master.probe.selected.audio?.decodedAudioSamples;
    const proxyAudio = proxy.probe.selected.audio?.decodedAudioSamples;
    const audioAlignment = (master.resource.metadata?.proxy as LockedResourceVariant | undefined)?.audioAlignment;
    if (masterAudio && proxyAudio && audioAlignment) {
      add("ffmpeg", Object.freeze({
        ordinal: variants.length * 3 + pairIndex * 4,
        operation: "audio-proxy-alignment",
        resourceId,
        resourceSha256: master.sha256,
        resourceBytes: master.bytes,
        variant: "master",
        streamIndex: masterAudio.streamIndex,
      }));
      add("ffmpeg", Object.freeze({
        ordinal: variants.length * 3 + pairIndex * 4 + 1,
        operation: "audio-proxy-alignment",
        resourceId,
        resourceSha256: proxy.sha256,
        resourceBytes: proxy.bytes,
        variant: "proxy",
        streamIndex: proxyAudio.streamIndex,
      }));
    }
    const masterVideo = master.probe.selected.video?.decodedVideoCadence;
    const proxyVideo = proxy.probe.selected.video?.decodedVideoCadence;
    const videoAlignment = (master.resource.metadata?.proxy as LockedResourceVariant | undefined)?.videoAlignment;
    if (masterVideo && proxyVideo && videoAlignment) {
      add("ffmpeg", Object.freeze({
        ordinal: variants.length * 3 + pairIndex * 4 + 2,
        operation: "video-proxy-alignment",
        resourceId,
        resourceSha256: master.sha256,
        resourceBytes: master.bytes,
        variant: "master",
        streamIndex: masterVideo.streamIndex,
      }));
      add("ffmpeg", Object.freeze({
        ordinal: variants.length * 3 + pairIndex * 4 + 3,
        operation: "video-proxy-alignment",
        resourceId,
        resourceSha256: proxy.sha256,
        resourceBytes: proxy.bytes,
        variant: "proxy",
        streamIndex: proxyVideo.streamIndex,
      }));
    }
  }
  const sorted = [...planned].sort((left, right) => {
    const tool = codeUnitCompare(left.tool, right.tool);
    if (tool !== 0) return tool;
    if (left.context.ordinal !== right.context.ordinal) return left.context.ordinal - right.context.ordinal;
    return codeUnitCompare(stableJsonStringify(left.context), stableJsonStringify(right.context));
  });
  const entries = Object.freeze(sorted.map((entry, index) => Object.freeze({
    index,
    entryId: nativeProcessPlanEntryId(entry.tool, entry.context),
    tool: entry.tool,
    context: entry.context,
  })));
  const identities = new Set(entries.map((entry) => entry.entryId));
  if (identities.size !== entries.length) {
    failure("CUT_INPUT_SESSION_PROBE", "Verified-input native process plan contains a duplicate exact operation.", { reason: "native-process-plan-duplicate" });
  }
  const planBase = Object.freeze({
    format: "cut-reference-verified-input-native-process-plan" as const,
    version: 1 as const,
    maximumUnresolvedProcesses: referenceVerifiedInputMaximumUnresolvedNativeProcesses,
    entries,
    entryCount: entries.length,
    ffmpegCount: entries.filter((entry) => entry.tool === "ffmpeg").length,
    ffprobeCount: entries.filter((entry) => entry.tool === "ffprobe").length,
  });
  return Object.freeze({
    ...planBase,
    planSha256: createHash("sha256").update(stableJsonStringify(planBase)).digest("hex"),
  });
}

/**
 * Pure, deterministic native-helper plan for an invocation-local locked IR.
 * It does not open resources or launch helpers.
 */
export function planReferenceVerifiedInputNativeProcesses(
  canonicalLockedIr: CutAVIR,
): ReferenceVerifiedInputNativeProcessPlan {
  let lockedIr: CutAVIR;
  try {
    if (Object.keys(canonicalLockedIr.resources).length > 0) assertAppliedCutLockIr(canonicalLockedIr);
    lockedIr = structuredClone(canonicalLockedIr);
    validateCutAvIr(lockedIr);
    validateEmbeddedLockedIrContract(lockedIr);
  } catch (error) {
    if (error instanceof ReferenceVerifiedInputSessionError) throw error;
    failure("CUT_INPUT_SESSION_LOCK_STATE", "Cannot plan native helpers from an invalid canonical locked IR.", { reason: "native-process-plan-lock" }, error);
  }
  return referenceVerifiedInputNativeProcessPlanFromVariants(expectations(lockedIr!));
}

function enforceTranscriptSnapshotBudgets(ir: CutAVIR, variants: readonly VariantExpectation[]) {
  if (!ir.transcriptBindings?.length) return;
  const masters = new Map(
    variants
      .filter((variant) => variant.variant === "master")
      .map((variant) => [variant.resource.id, variant]),
  );
  for (const [index, binding] of ir.transcriptBindings.entries()) {
    const path = `$.transcriptBindings[${index}].transcriptResourceId`;
    const expectation = masters.get(binding.transcriptResourceId);
    if (!expectation || expectation.resource.kind !== "data") {
      throw new CutTranscriptLockError(
        "CUT_TRANSCRIPT_LOCK_RESOURCE",
        path,
        binding,
        "must resolve to one locked DataAsset master snapshot.",
      );
    }
    if (expectation.bytes < 1 || expectation.bytes > cutTranscriptSidecarMaxBytes) {
      throw new CutTranscriptLockError(
        "CUT_TRANSCRIPT_LOCK_SIDECAR",
        path,
        binding,
        `locked transcript byte count must be 1 through ${cutTranscriptSidecarMaxBytes}; found ${expectation.bytes}.`,
      );
    }
  }
}

function normalizedLimits(value: Partial<ReferenceVerifiedInputSessionLimits> | undefined): ReferenceVerifiedInputSessionLimits {
  if (value !== undefined && !record(value)) {
    failure("CUT_INPUT_SESSION_CONTRACT", "Verified input session limits must be one plain object.", { reason: "limits-shape" });
  }
  const unknown = value ? Object.keys(value).filter((key) => !["maxFileBytes", "maxAggregateBytes", "maxVariants"].includes(key)) : [];
  if (unknown.length) failure("CUT_INPUT_SESSION_CONTRACT", `Unknown verified input limit ${JSON.stringify(unknown[0])}.`, { reason: "limits-unknown" });
  const requestedAggregate = value?.maxAggregateBytes ?? defaultReferenceVerifiedInputSessionLimits.maxAggregateBytes;
  const limits = {
    ...defaultReferenceVerifiedInputSessionLimits,
    ...value,
    maxFileBytes: value?.maxFileBytes ?? (requestedAggregate < defaultReferenceVerifiedInputSessionLimits.maxFileBytes
      ? requestedAggregate
      : defaultReferenceVerifiedInputSessionLimits.maxFileBytes),
  };
  if (typeof limits.maxFileBytes !== "bigint" || limits.maxFileBytes < 1n) {
    failure("CUT_INPUT_SESSION_CONTRACT", "maxFileBytes must be one positive bigint.", { reason: "max-file-bytes" });
  }
  if (limits.maxFileBytes > defaultReferenceVerifiedInputSessionLimits.maxFileBytes) {
    failure("CUT_INPUT_SESSION_CONTRACT", `maxFileBytes cannot exceed the hard ${defaultReferenceVerifiedInputSessionLimits.maxFileBytes}-byte ceiling.`, { reason: "max-file-bytes" });
  }
  if (typeof limits.maxAggregateBytes !== "bigint" || limits.maxAggregateBytes < 1n) {
    failure("CUT_INPUT_SESSION_CONTRACT", "maxAggregateBytes must be one positive bigint.", { reason: "max-aggregate-bytes" });
  }
  if (limits.maxAggregateBytes > defaultReferenceVerifiedInputSessionLimits.maxAggregateBytes) {
    failure("CUT_INPUT_SESSION_CONTRACT", `maxAggregateBytes cannot exceed the hard ${defaultReferenceVerifiedInputSessionLimits.maxAggregateBytes}-byte ceiling.`, { reason: "max-aggregate-bytes" });
  }
  if (limits.maxFileBytes > limits.maxAggregateBytes) {
    failure("CUT_INPUT_SESSION_CONTRACT", "maxFileBytes cannot exceed maxAggregateBytes.", { reason: "limit-order" });
  }
  if (!Number.isSafeInteger(limits.maxVariants) || limits.maxVariants < 1 || limits.maxVariants > defaultReferenceVerifiedInputSessionLimits.maxVariants) {
    failure("CUT_INPUT_SESSION_CONTRACT", `maxVariants must be an integer from 1 to ${defaultReferenceVerifiedInputSessionLimits.maxVariants}.`, { reason: "max-variants" });
  }
  return Object.freeze(limits);
}

function enforceBudgets(variants: readonly VariantExpectation[], limits: ReferenceVerifiedInputSessionLimits) {
  if (variants.length > limits.maxVariants) {
    failure("CUT_INPUT_SESSION_RESOURCE_LIMIT", `Input variant count ${variants.length} exceeds ${limits.maxVariants}.`, { reason: "variant-count" });
  }
  let aggregate = 0n;
  for (const item of variants) {
    const bytes = BigInt(item.bytes);
    if (bytes > limits.maxFileBytes) {
      failure("CUT_INPUT_SESSION_RESOURCE_LIMIT", `Locked ${item.variant} resource ${JSON.stringify(item.resource.id)} exceeds the exact per-file input budget.`, { resourceId: item.resource.id, variant: item.variant, locator: item.locator, reason: "file-bytes" });
    }
    aggregate += bytes;
    if (aggregate > limits.maxAggregateBytes) {
      failure("CUT_INPUT_SESSION_RESOURCE_LIMIT", "Locked resources exceed the exact aggregate input budget.", { resourceId: item.resource.id, variant: item.variant, locator: item.locator, reason: "aggregate-bytes" });
    }
  }
  return aggregate;
}

async function ensurePrivateParent(root: string) {
  let current = root;
  for (const segment of [".cut", "cache", "reference"]) {
    current = resolve(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (systemCode(error) !== "EEXIST") {
        failure("CUT_INPUT_SESSION_PATH", `Cannot create private input-session parent ${JSON.stringify(segment)}.`, { reason: "parent-create" }, error);
      }
    }
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try { metadata = await lstat(current); }
    catch (error) { failure("CUT_INPUT_SESSION_PATH", `Cannot inspect private input-session parent ${JSON.stringify(segment)}.`, { reason: "parent-inspect" }, error); }
    if (metadata!.isSymbolicLink() || !metadata!.isDirectory()) {
      failure("CUT_INPUT_SESSION_PATH", `Private input-session parent ${JSON.stringify(segment)} must be a direct directory, not a symlink.`, { reason: "parent-structure" });
    }
    const physical = await realpath(current);
    if (!inside(root, physical)) failure("CUT_INPUT_SESSION_PATH", "Private input-session parent escapes the project root.", { reason: "parent-escape" });
  }
  return current;
}

async function createSessionDirectory(
  projectRoot: string,
  testHooks?: ReferenceVerifiedInputSessionTestHooks,
): Promise<SessionDirectory> {
  let physicalRoot: string;
  try { physicalRoot = await realpath(resolve(projectRoot)); }
  catch (error) { failure("CUT_INPUT_SESSION_PATH", "Project root is unavailable.", { reason: "project-root" }, error); }
  const parent = await ensurePrivateParent(physicalRoot!);
  let path = "";
  for (let attempt = 0; attempt < 16; attempt += 1) {
    path = resolve(parent, `.cut-inputs-${randomBytes(16).toString("hex")}`);
    try {
      await mkdir(path, { mode: 0o700 });
      break;
    } catch (error) {
      if (systemCode(error) === "EEXIST") { path = ""; continue; }
      failure("CUT_INPUT_SESSION_PATH", "Cannot create a private verified-input session.", { reason: "session-create" }, error);
    }
  }
  if (!path) failure("CUT_INPUT_SESSION_PATH", "Cannot allocate a unique private verified-input session.", { reason: "session-collision" });
  let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (platform() !== "win32") {
      directoryHandle = await open(path, fsConstants.O_RDONLY | (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0));
      await directoryHandle.chmod(0o700);
    }
  } catch (error) {
    await rmdir(path).catch(() => undefined);
    failure("CUT_INPUT_SESSION_PATH", "Cannot enforce mode 0700 on the verified-input session.", { reason: "session-mode" }, error);
  } finally {
    await directoryHandle?.close().catch(() => undefined);
  }
  const metadata = await lstat(path, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    await rmdir(path).catch(() => undefined);
    failure("CUT_INPUT_SESSION_PATH", "Verified-input session is not a direct private directory.", { reason: "session-structure" });
  }
  if (platform() !== "win32" && (Number(metadata.mode) & 0o777) !== 0o700) {
    await rmdir(path).catch(() => undefined);
    failure("CUT_INPUT_SESSION_PATH", "Verified-input session did not retain exact mode 0700.", { reason: "session-mode" });
  }
  const identity = Object.freeze({ dev: metadata.dev, ino: metadata.ino }), files: Array<{ path: string; identity: StableStat }> = [];
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      let current: Awaited<ReturnType<typeof lstat>>;
      try { current = await lstat(path, { bigint: true }); }
      catch (error) { failure("CUT_INPUT_SESSION_PATH", "Verified-input session disappeared before cleanup.", { reason: "cleanup-identity" }, error); }
      if (current.isSymbolicLink() || !current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) {
        failure("CUT_INPUT_SESSION_PATH", "Verified-input session identity changed before cleanup; refusing to traverse it.", { reason: "cleanup-identity" });
      }
      for (const file of files) {
        let fileMetadata: Awaited<ReturnType<typeof lstat>>;
        try { fileMetadata = await lstat(file.path, { bigint: true }); }
        catch (error) {
          if (systemCode(error) === "ENOENT") continue;
          failure("CUT_INPUT_SESSION_PATH", "Cannot inspect a verified-input snapshot during cleanup.", { reason: "cleanup-file-inspect" }, error);
        }
        if (fileMetadata!.isSymbolicLink() || !fileMetadata!.isFile() || !sameStat(stableStat(fileMetadata!), file.identity)) {
          failure("CUT_INPUT_SESSION_PATH", "Verified-input snapshot identity changed before cleanup; refusing to delete it.", { reason: "cleanup-file-identity" });
        }
        try { await unlink(file.path); }
        catch (error) { failure("CUT_INPUT_SESSION_PATH", "Cannot delete a verified-input snapshot.", { reason: "cleanup-file-delete" }, error); }
      }
      try { await rmdir(path); }
      catch (error) { failure("CUT_INPUT_SESSION_PATH", "Cannot remove the verified-input session directory.", { reason: "cleanup-directory-delete" }, error); }
      try {
        await testHooks?.operationEvent?.(Object.freeze({ operation: "cleanup-complete" }));
      } catch (error) {
        failure("CUT_INPUT_SESSION_PATH", "Verified-input session cleanup completion failed.", { reason: "cleanup-complete" }, error);
      }
    })();
    return cleanupPromise;
  };
  return Object.freeze({ physicalRoot: physicalRoot!, path, identity, files, cleanup });
}

function snapshotExtension(locator: string) {
  const extension = posix.extname(locator);
  return /^\.[A-Za-z0-9]{1,16}$/u.test(extension) ? extension.toLowerCase() : ".bin";
}

function snapshotLocator(root: string, path: string) {
  const value = relative(root, path).split(sep).join("/");
  return validateProjectLocator(value, "verified input snapshot locator");
}

function openReadFlags() {
  return fsConstants.O_RDONLY | (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);
}

function openExclusiveWriteFlags() {
  return fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
    | (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);
}

async function copyVariant(expectation: VariantExpectation, session: SessionDirectory, ordinal: number) {
  const destination = resolve(session.path, `${String(ordinal).padStart(5, "0")}-${expectation.variant}${snapshotExtension(expectation.locator)}`);
  let sourceHandle: Awaited<ReturnType<typeof open>> | undefined;
  let destinationHandle: Awaited<ReturnType<typeof open>> | undefined;
  let trackedFile: { path: string; identity: StableStat } | undefined;
  let failed = false;
  try {
    const resolved = await resolveLockedProjectPath(session.physicalRoot, expectation.locator);
    const initialPath = await lstat(resolved.path, { bigint: true });
    if (initialPath.isSymbolicLink() || !initialPath.isFile()) {
      failure("CUT_INPUT_SESSION_PATH", `Locked ${expectation.variant} input must resolve to a direct regular file.`, { resourceId: expectation.resource.id, variant: expectation.variant, locator: expectation.locator, reason: "source-structure" });
    }
    sourceHandle = await open(resolved.path, openReadFlags());
    const before = await sourceHandle.stat({ bigint: true });
    if (!before.isFile() || !sameStat(stableStat(initialPath), stableStat(before))) {
      failure("CUT_INPUT_SESSION_SOURCE_CHANGED", `Locked ${expectation.variant} input changed before snapshot acquisition.`, { resourceId: expectation.resource.id, variant: expectation.variant, locator: expectation.locator, reason: "source-open" });
    }
    if (before.size !== BigInt(expectation.bytes)) {
    failure("CUT_LOCK_INTEGRITY", `Locked ${expectation.variant} input size changed.`, { resourceId: expectation.resource.id, variant: expectation.variant, locator: expectation.locator, reason: "size" });
    }
    destinationHandle = await open(destination, openExclusiveWriteFlags(), 0o600);
    const destinationInitial = await destinationHandle.stat({ bigint: true });
    const destinationPath = await lstat(destination, { bigint: true });
    if (!destinationInitial.isFile() || destinationPath.isSymbolicLink() || !destinationPath.isFile()
      || destinationInitial.dev !== destinationPath.dev || destinationInitial.ino !== destinationPath.ino) {
      failure("CUT_INPUT_SESSION_PATH", "Exclusive snapshot destination is not one direct regular file.", { resourceId: expectation.resource.id, variant: expectation.variant, locator: expectation.locator, reason: "destination-structure" });
    }
    trackedFile = { path: destination, identity: stableStat(destinationInitial) };
    session.files.push(trackedFile);

    const digest = createHash("sha256"), chunk = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < expectation.bytes) {
      const requested = Math.min(chunk.byteLength, expectation.bytes - position);
      const { bytesRead } = await sourceHandle.read(chunk, 0, requested, position);
      if (bytesRead !== requested) {
        failure("CUT_INPUT_SESSION_SOURCE_CHANGED", `Locked ${expectation.variant} input changed while CUT copied it.`, { resourceId: expectation.resource.id, variant: expectation.variant, locator: expectation.locator, reason: "short-read" });
      }
      digest.update(chunk.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(chunk, written, bytesRead - written, position + written);
        if (result.bytesWritten < 1) failure("CUT_INPUT_SESSION_PATH", "Verified-input snapshot write made no progress.", { resourceId: expectation.resource.id, variant: expectation.variant, locator: expectation.locator, reason: "short-write" });
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    const trailing = Buffer.allocUnsafe(1);
    if ((await sourceHandle.read(trailing, 0, 1, expectation.bytes)).bytesRead !== 0) {
      failure("CUT_INPUT_SESSION_SOURCE_CHANGED", `Locked ${expectation.variant} input grew while CUT copied it.`, { resourceId: expectation.resource.id, variant: expectation.variant, locator: expectation.locator, reason: "trailing-byte" });
    }
    await destinationHandle.sync();
    const [sourceAfter, sourcePathAfter, destinationAfter, destinationPathAfter] = await Promise.all([
      sourceHandle.stat({ bigint: true }),
      lstat(resolved.path, { bigint: true }),
      destinationHandle.stat({ bigint: true }),
      lstat(destination, { bigint: true }),
    ]);
    if (!sameStat(stableStat(before), stableStat(sourceAfter)) || !sameStat(stableStat(before), stableStat(sourcePathAfter))) {
      failure("CUT_INPUT_SESSION_SOURCE_CHANGED", `Locked ${expectation.variant} input changed while CUT copied it.`, { resourceId: expectation.resource.id, variant: expectation.variant, locator: expectation.locator, reason: "source-stat" });
    }
    const currentResolution = await resolveLockedProjectPath(session.physicalRoot, expectation.locator).catch((error) => {
      failure("CUT_INPUT_SESSION_SOURCE_CHANGED", `Locked ${expectation.variant} locator changed while CUT copied it.`, { resourceId: expectation.resource.id, variant: expectation.variant, locator: expectation.locator, reason: "source-resolve" }, error);
    });
    if (currentResolution.path !== resolved.path || currentResolution.bytes !== expectation.bytes) {
      failure("CUT_INPUT_SESSION_SOURCE_CHANGED", `Locked ${expectation.variant} locator changed while CUT copied it.`, { resourceId: expectation.resource.id, variant: expectation.variant, locator: expectation.locator, reason: "source-path" });
    }
    if (!destinationAfter.isFile() || destinationPathAfter.isSymbolicLink() || !destinationPathAfter.isFile()
      || destinationAfter.dev !== destinationPathAfter.dev || destinationAfter.ino !== destinationPathAfter.ino
      || destinationAfter.size !== BigInt(expectation.bytes)) {
      failure("CUT_INPUT_SESSION_PATH", "Verified-input snapshot is incomplete or changed.", { resourceId: expectation.resource.id, variant: expectation.variant, locator: expectation.locator, reason: "destination-final" });
    }
    trackedFile.identity = stableStat(destinationAfter);
    const observedHash = digest.digest("hex");
    if (observedHash !== expectation.sha256) {
      failure("CUT_LOCK_INTEGRITY", `Locked ${expectation.variant} input bytes changed.`, { resourceId: expectation.resource.id, variant: expectation.variant, locator: expectation.locator, reason: "sha256" });
    }
    await destinationHandle.chmod(platform() === "win32" ? 0o600 : 0o400);
    const sealedHandle = await destinationHandle.stat({ bigint: true }), sealedPath = await lstat(destination, { bigint: true });
    if (!sealedHandle.isFile() || sealedPath.isSymbolicLink() || !sealedPath.isFile()
      || sealedHandle.dev !== sealedPath.dev || sealedHandle.ino !== sealedPath.ino
      || sealedHandle.size !== BigInt(expectation.bytes)) {
      failure("CUT_INPUT_SESSION_PATH", "Verified-input snapshot changed while CUT sealed it.", { resourceId: expectation.resource.id, variant: expectation.variant, locator: expectation.locator, reason: "destination-seal" });
    }
    trackedFile.identity = stableStat(sealedHandle);
    return Object.freeze({ expectation, path: destination, locator: snapshotLocator(session.physicalRoot, destination), identity: stableStat(sealedHandle) });
  } catch (error) {
    failed = true;
    if (error instanceof ReferenceVerifiedInputSessionError || error instanceof CutProjectError) throw error;
    failure("CUT_INPUT_SESSION_PATH", `Cannot snapshot locked ${expectation.variant} input ${JSON.stringify(expectation.locator)}.`, { resourceId: expectation.resource.id, variant: expectation.variant, locator: expectation.locator, reason: "snapshot" }, error);
  } finally {
    if (failed && destinationHandle && trackedFile) {
      try {
        const handleState = await destinationHandle.stat({ bigint: true }), pathState = await lstat(trackedFile.path, { bigint: true });
        if (handleState.isFile() && !pathState.isSymbolicLink() && pathState.isFile()
          && handleState.dev === pathState.dev && handleState.ino === pathState.ino) trackedFile.identity = stableStat(handleState);
      } catch { /* preserve the primary failure; cleanup will fail closed if identity cannot be established */ }
    }
    const closed = await Promise.allSettled([
      ...(destinationHandle ? [destinationHandle.close()] : []),
      ...(sourceHandle ? [sourceHandle.close()] : []),
    ]);
    let closeFailure: unknown;
    for (const result of closed) if (result.status === "rejected") { closeFailure = (result as PromiseRejectedResult).reason; break; }
    if (closeFailure !== undefined && !failed) {
      failure("CUT_INPUT_SESSION_PATH", "Cannot close a verified-input snapshot handle.", { resourceId: expectation.resource.id, variant: expectation.variant, locator: expectation.locator, reason: "snapshot-close" }, closeFailure);
    }
  }
}

function retargetStoredProbe(probe: LockedResourceProbe, locator: string): LockedResourceProbe {
  const result = structuredClone(probe) as LockedResourceProbe;
  result.identity.file.locator = locator;
  result.identity.file.basename = posix.basename(locator);
  return result;
}

async function selectedMediaStream(
  identity: Awaited<ReturnType<typeof probeProjectMedia>>,
  type: "video",
  expected: LockedVideoMediaSelection | undefined,
  projectRoot: string,
  nativeExecutables?: ProbeNativeExecutables,
  nativeInvocation?: NativeProcessInvocation,
  snapshotOrdinal?: number,
  resourceId?: string,
  variant?: "master" | "proxy",
): Promise<LockedVideoMediaSelection | undefined>;
async function selectedMediaStream(
  identity: Awaited<ReturnType<typeof probeProjectMedia>>,
  type: "audio",
  expected: LockedAudioMediaSelection | undefined,
  projectRoot: string,
  nativeExecutables?: ProbeNativeExecutables,
  nativeInvocation?: NativeProcessInvocation,
  snapshotOrdinal?: number,
  resourceId?: string,
  variant?: "master" | "proxy",
): Promise<LockedAudioMediaSelection | undefined>;
async function selectedMediaStream(
  identity: Awaited<ReturnType<typeof probeProjectMedia>>,
  type: "video" | "audio",
  expected: LockedMediaSelection | undefined,
  projectRoot: string,
  nativeExecutables: ProbeNativeExecutables = {},
  nativeInvocation?: NativeProcessInvocation,
  snapshotOrdinal = 0,
  resourceId = identity.file.locator,
  variant: "master" | "proxy" = "master",
): Promise<LockedMediaSelection | undefined> {
  if (!expected) return undefined;
  const stream = identity.streams.find((candidate) => candidate.index === expected.streamIndex && candidate.type === type);
  if (!stream) throw new Error(`selected ${type} stream ${expected.streamIndex} is absent from the private snapshot`);
  if (!stream.timeBase || compareRational(stream.timeBase, zeroRational) <= 0) throw new Error(`selected ${type} stream ${stream.index} has no positive exact time base`);
  if (type === "video" && (!stream.width || !stream.height)) throw new Error(`selected video stream ${stream.index} has no exact dimensions`);
  if (type === "audio" && (!stream.sampleRate || !stream.channels)) throw new Error(`selected audio stream ${stream.index} has no exact sample-rate/channel metadata`);
  const streamDuration = stream.duration && compareRational(stream.duration, zeroRational) > 0 ? stream.duration : undefined;
  if (type === "audio" && "decodedAudioSamples" in expected && expected.decodedAudioSamples) {
    const executions: ProbeDecodedAudioNativeProcessExecutions | undefined = nativeInvocation
      ? Object.freeze({
        pcm: nativeInvocation.execution("ffmpeg", Object.freeze({ ordinal: snapshotOrdinal * 3, operation: "decoded-audio-pcm", resourceId, resourceSha256: identity.file.sha256, resourceBytes: identity.file.bytes, variant, streamIndex: stream.index })),
        frames: nativeInvocation.execution("ffprobe", Object.freeze({ ordinal: snapshotOrdinal * 4 + 2, operation: "decoded-audio-samples", resourceId, resourceSha256: identity.file.sha256, resourceBytes: identity.file.bytes, variant, streamIndex: stream.index })),
      })
      : undefined;
    const samples = await probeProjectDecodedAudioSamples(projectRoot, identity.file.locator, identity, stream.index, {}, nativeExecutables, executions);
    const duration = decodedAudioSamplesDuration(samples, stream);
    return { streamIndex: stream.index, duration, durationSource: "decoded-audio-samples" as const, timeBase: stream.timeBase, decodedAudioSamples: samples };
  }
  if (streamDuration && !("decodedVideoCadence" in expected && expected.decodedVideoCadence)) return { streamIndex: stream.index, duration: streamDuration, durationSource: "stream" as const, timeBase: stream.timeBase, ...(type === "video" ? { frameRate: stream.frameRate ?? stream.averageFrameRate } : {}) };
  if (type !== "video" || !("decodedVideoCadence" in expected) || !expected.decodedVideoCadence) {
    throw new Error(`selected ${type} stream ${stream.index} has no positive exact stream duration`);
  }
  const cadence = await probeProjectDecodedVideoCadence(
    projectRoot,
    identity.file.locator,
    identity,
    stream.index,
    {},
    nativeExecutables,
    nativeInvocation?.execution("ffprobe", Object.freeze({ ordinal: snapshotOrdinal * 4 + 1, operation: "decoded-video-cadence", resourceId, resourceSha256: identity.file.sha256, resourceBytes: identity.file.bytes, variant, streamIndex: stream.index })),
  );
  const duration = decodedVideoCadenceDuration(cadence, stream);
  return { streamIndex: stream.index, duration, durationSource: "decoded-video-cadence" as const, timeBase: stream.timeBase, frameRate: cadence.frameRate, decodedVideoCadence: cadence };
}

async function probeSnapshot(
  snapshot: Awaited<ReturnType<typeof copyVariant>>,
  root: string,
  ordinal: number,
  nativeExecutables: ProbeNativeExecutables = {},
  nativeInvocation?: NativeProcessInvocation,
) {
  const { expectation, locator } = snapshot;
  let observed: LockedResourceProbe;
  try {
    if (expectation.resource.kind === "video" || expectation.resource.kind === "audio") {
      const identity = await probeProjectMedia(
        root,
        locator,
        {},
        nativeExecutables,
        nativeInvocation?.execution("ffprobe", Object.freeze({
          ordinal: ordinal * 4,
          operation: "media-metadata",
          resourceId: expectation.resource.id,
          resourceSha256: expectation.sha256,
          resourceBytes: expectation.bytes,
          variant: expectation.variant,
        })),
      );
      const expected = expectation.probe.kind === "media" ? expectation.probe.selected : {};
      const video = await selectedMediaStream(identity, "video", expected.video, root, nativeExecutables, nativeInvocation, ordinal, expectation.resource.id, expectation.variant);
      const audio = await selectedMediaStream(identity, "audio", expected.audio, root, nativeExecutables, nativeInvocation, ordinal, expectation.resource.id, expectation.variant);
      if (expectation.resource.kind === "video" && !video) throw new Error("VideoAsset snapshot has no video stream");
      if (expectation.resource.kind === "audio" && !audio) throw new Error("AudioAsset snapshot has no audio stream");
      observed = { kind: "media", identity, selected: { ...(video ? { video } : {}), ...(audio ? { audio } : {}) } };
    } else if (expectation.resource.kind === "image") {
      observed = { kind: "image", identity: await probeProjectImage(root, locator) };
    } else {
      observed = {
        kind: "bytes",
        identity: await probeProjectBytes(root, locator),
        coverage: { level: "bytes-only", excludes: [...byteCoverage[expectation.resource.kind]] },
      };
    }
  } catch (error) {
    failure(
      "CUT_INPUT_SESSION_PROBE",
      `Private ${expectation.variant} snapshot for resource ${JSON.stringify(expectation.resource.id)} could not be natively probed.`,
      {
        resourceId: expectation.resource.id,
        variant: expectation.variant,
        locator: expectation.locator,
        reason: "native-probe",
        source: resourceSource(expectation.resource),
      },
      error,
    );
  }
  const expected = retargetStoredProbe(expectation.probe, locator);
  if (stableJsonStringify(observed!) !== stableJsonStringify(expected)) {
    if (lockedResourceProbeNeedsDecodedAudioV2Relock(expected, observed!)) {
      failure(
        "CUT_LOCK_VERSION",
        `Private ${expectation.variant} snapshot for resource ${JSON.stringify(expectation.resource.id)} carries a structurally readable decoded-audio v1 witness, but current native replay emits v2 and cannot reproduce the historical v1 record digest; regenerate cut.lock with the current scanner.`,
        {
          resourceId: expectation.resource.id,
          variant: expectation.variant,
          locator: expectation.locator,
          reason: "decoded-audio-v1-relock",
          source: resourceSource(expectation.resource),
        },
      );
    }
    failure(
      "CUT_LOCK_METADATA",
      `Private ${expectation.variant} snapshot for resource ${JSON.stringify(expectation.resource.id)} does not match its exact stored probe.`,
      {
        resourceId: expectation.resource.id,
        variant: expectation.variant,
        locator: expectation.locator,
        reason: "probe-mismatch",
        source: resourceSource(expectation.resource),
      },
    );
  }
}

function normalizedProbeConcurrency(hooks: ReferenceVerifiedInputSessionTestHooks | undefined) {
  if (hooks === undefined) return referenceVerifiedInputProbeConcurrency;
  if (!record(hooks) || Object.keys(hooks).some((key) => ![
    "probeConcurrency",
    "probeEvent",
    "nativeExecutables",
    "operationEvent",
  ].includes(key))) {
    failure("CUT_INPUT_SESSION_CONTRACT", "Verified-input probe test hooks contain an unknown property.", { reason: "probe-test-hooks" });
  }
  const width = hooks.probeConcurrency ?? referenceVerifiedInputProbeConcurrency;
  if (!Number.isSafeInteger(width) || width < 1 || width > referenceVerifiedInputProbeConcurrency) {
    failure(
      "CUT_INPUT_SESSION_CONTRACT",
      `Verified-input probe test concurrency must be an integer from 1 to ${referenceVerifiedInputProbeConcurrency}.`,
      { reason: "probe-test-concurrency" },
    );
  }
  if (hooks.probeEvent !== undefined && typeof hooks.probeEvent !== "function") {
    failure("CUT_INPUT_SESSION_CONTRACT", "Verified-input probe test event hook must be callable.", { reason: "probe-test-event" });
  }
  if (hooks.operationEvent !== undefined && typeof hooks.operationEvent !== "function") {
    failure("CUT_INPUT_SESSION_CONTRACT", "Verified-input operation test event hook must be callable.", { reason: "operation-test-event" });
  }
  if (hooks.nativeExecutables !== undefined) {
    if (!record(hooks.nativeExecutables)
      || Object.keys(hooks.nativeExecutables).some((key) => !["ffmpeg", "ffprobe"].includes(key))
      || Object.values(hooks.nativeExecutables).some((value) => typeof value !== "string" || value.length < 1)) {
      failure("CUT_INPUT_SESSION_CONTRACT", "Verified-input native-executable test hooks are malformed.", { reason: "native-executable-test-hooks" });
    }
  }
  return width;
}

async function probeSnapshotWithTestEvent(
  snapshot: Awaited<ReturnType<typeof copyVariant>>,
  root: string,
  ordinal: number,
  hooks: ReferenceVerifiedInputSessionTestHooks | undefined,
  nativeInvocation?: NativeProcessInvocation,
) {
  let primaryFailure: unknown;
  try {
    await hooks?.probeEvent?.(Object.freeze({
      phase: "start",
      ordinal,
      resourceId: snapshot.expectation.resource.id,
      variant: snapshot.expectation.variant,
    }));
    await probeSnapshot(snapshot, root, ordinal, nativeInvocation?.executables ?? hooks?.nativeExecutables, nativeInvocation);
  } catch (error) {
    primaryFailure = error;
  }
  try {
    await hooks?.probeEvent?.(Object.freeze({
      phase: "settled",
      ordinal,
      resourceId: snapshot.expectation.resource.id,
      variant: snapshot.expectation.variant,
      status: primaryFailure === undefined ? "fulfilled" : "rejected",
    }));
  } catch (error) {
    if (primaryFailure === undefined) primaryFailure = error;
  }
  if (primaryFailure !== undefined) {
    if (primaryFailure instanceof ReferenceVerifiedInputSessionError) throw primaryFailure;
    failure(
      "CUT_INPUT_SESSION_PROBE",
      `Private ${snapshot.expectation.variant} snapshot for resource ${JSON.stringify(snapshot.expectation.resource.id)} could not be natively probed.`,
      {
        resourceId: snapshot.expectation.resource.id,
        variant: snapshot.expectation.variant,
        locator: snapshot.expectation.locator,
        reason: "native-probe",
        source: resourceSource(snapshot.expectation.resource),
      },
      primaryFailure,
    );
  }
}

async function probeSnapshotsBounded(
  snapshots: readonly Awaited<ReturnType<typeof copyVariant>>[],
  root: string,
  width: number,
  hooks: ReferenceVerifiedInputSessionTestHooks | undefined,
  nativeInvocation?: NativeProcessInvocation,
) {
  for (let waveStart = 0; waveStart < snapshots.length; waveStart += width) {
    const wave = snapshots.slice(waveStart, waveStart + width);
    const outcomes = await Promise.all(wave.map(async (snapshot, localIndex) => {
      try {
        await probeSnapshotWithTestEvent(snapshot, root, waveStart + localIndex, hooks, nativeInvocation);
        return Object.freeze({ status: "fulfilled" as const });
      } catch (reason) {
        return Object.freeze({ status: "rejected" as const, reason });
      }
    }));
    // Await every member of the current wave before surfacing its first
    // ordinal failure. This leaves no decoder/probe task orphaned and makes
    // failure selection independent of completion timing.
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
  }
}

async function verifySnapshotAudioProxyAlignments(
  snapshots: readonly Awaited<ReturnType<typeof copyVariant>>[],
  root: string,
  nativeInvocation?: NativeProcessInvocation,
) {
  const byResource = new Map<string, { master?: (typeof snapshots)[number]; proxy?: (typeof snapshots)[number] }>();
  for (const snapshot of snapshots) {
    const variants = byResource.get(snapshot.expectation.resource.id) ?? {};
    variants[snapshot.expectation.variant] = snapshot;
    byResource.set(snapshot.expectation.resource.id, variants);
  }
  const orderedResources = [...byResource].sort(([left], [right]) => codeUnitCompare(left, right));
  for (let pairIndex = 0; pairIndex < orderedResources.length; pairIndex += 1) {
    const [resourceId, variants] = orderedResources[pairIndex];
    const master = variants.master, proxy = variants.proxy;
    if (!master || !proxy || master.expectation.probe.kind !== "media" || proxy.expectation.probe.kind !== "media"
      || !master.expectation.probe.selected.audio || !proxy.expectation.probe.selected.audio) continue;
    const masterWitness = master.expectation.probe.selected.audio.decodedAudioSamples;
    const proxyWitness = proxy.expectation.probe.selected.audio.decodedAudioSamples;
    const stored = (master.expectation.resource.metadata?.proxy as LockedResourceVariant | undefined)?.audioAlignment;
    if (!masterWitness || !proxyWitness || !stored) {
      failure("CUT_INPUT_SESSION_LOCK_STATE", `Resource ${JSON.stringify(resourceId)} has no complete stored audio-proxy alignment authority.`, { resourceId, variant: "proxy", locator: proxy.expectation.locator, reason: "proxy-audio-alignment" });
    }
    try {
      const masterProbe = retargetStoredProbe(master.expectation.probe, master.locator);
      const proxyProbe = retargetStoredProbe(proxy.expectation.probe, proxy.locator);
      if (masterProbe.kind !== "media" || proxyProbe.kind !== "media") throw new Error("retargeted audio probes are not media probes");
      const executions: ProbeProxyAlignmentNativeProcessExecutions | undefined = nativeInvocation
        ? Object.freeze({
          master: nativeInvocation.execution("ffmpeg", Object.freeze({ ordinal: snapshots.length * 3 + pairIndex * 4, operation: "audio-proxy-alignment", resourceId, resourceSha256: master.expectation.sha256, resourceBytes: master.expectation.bytes, variant: "master", streamIndex: masterWitness.streamIndex })),
          proxy: nativeInvocation.execution("ffmpeg", Object.freeze({ ordinal: snapshots.length * 3 + pairIndex * 4 + 1, operation: "audio-proxy-alignment", resourceId, resourceSha256: proxy.expectation.sha256, resourceBytes: proxy.expectation.bytes, variant: "proxy", streamIndex: proxyWitness.streamIndex })),
        })
        : undefined;
      const observed = await probeProjectAudioProxyAlignment(
        root,
        master.locator,
        masterProbe.identity,
        masterWitness,
        proxy.locator,
        proxyProbe.identity,
        proxyWitness,
        {},
        nativeInvocation?.executables,
        executions,
      );
      if (stableJsonStringify(observed) !== stableJsonStringify(stored)) {
        failure("CUT_LOCK_METADATA", `Private proxy snapshot for resource ${JSON.stringify(resourceId)} does not match its stored audio-alignment evidence.`, { resourceId, variant: "proxy", locator: proxy.expectation.locator, reason: "proxy-audio-alignment-mismatch" });
      }
    } catch (error) {
      if (error instanceof ReferenceVerifiedInputSessionError) throw error;
      failure("CUT_INPUT_SESSION_PROBE", `Private master/proxy snapshots for resource ${JSON.stringify(resourceId)} could not reproduce their audio-alignment evidence.`, { resourceId, variant: "proxy", locator: proxy.expectation.locator, reason: "proxy-audio-alignment-probe" }, error);
    }
  }
}

async function verifySnapshotVideoProxyAlignments(
  snapshots: readonly Awaited<ReturnType<typeof copyVariant>>[],
  root: string,
  nativeInvocation?: NativeProcessInvocation,
) {
  const byResource = new Map<string, { master?: (typeof snapshots)[number]; proxy?: (typeof snapshots)[number] }>();
  for (const snapshot of snapshots) {
    const variants = byResource.get(snapshot.expectation.resource.id) ?? {};
    variants[snapshot.expectation.variant] = snapshot;
    byResource.set(snapshot.expectation.resource.id, variants);
  }
  const orderedResources = [...byResource].sort(([left], [right]) => codeUnitCompare(left, right));
  for (let pairIndex = 0; pairIndex < orderedResources.length; pairIndex += 1) {
    const [resourceId, variants] = orderedResources[pairIndex];
    const master = variants.master, proxy = variants.proxy;
    if (!master || !proxy || master.expectation.probe.kind !== "media" || proxy.expectation.probe.kind !== "media"
      || !master.expectation.probe.selected.video || !proxy.expectation.probe.selected.video) continue;
    const masterWitness = master.expectation.probe.selected.video.decodedVideoCadence;
    const proxyWitness = proxy.expectation.probe.selected.video.decodedVideoCadence;
    const stored = (master.expectation.resource.metadata?.proxy as LockedResourceVariant | undefined)?.videoAlignment;
    const source = resourceSource(master.expectation.resource);
    if (!masterWitness || !proxyWitness || !stored) {
      failure("CUT_INPUT_SESSION_LOCK_STATE", `Resource ${JSON.stringify(resourceId)} has no complete stored video-proxy alignment authority.`, { resourceId, variant: "proxy", locator: proxy.expectation.locator, reason: "proxy-video-alignment", source });
    }
    try {
      const masterProbe = retargetStoredProbe(master.expectation.probe, master.locator);
      const proxyProbe = retargetStoredProbe(proxy.expectation.probe, proxy.locator);
      if (masterProbe.kind !== "media" || proxyProbe.kind !== "media") throw new Error("retargeted video probes are not media probes");
      const executions: ProbeProxyAlignmentNativeProcessExecutions | undefined = nativeInvocation
        ? Object.freeze({
          master: nativeInvocation.execution("ffmpeg", Object.freeze({ ordinal: snapshots.length * 3 + pairIndex * 4 + 2, operation: "video-proxy-alignment", resourceId, resourceSha256: master.expectation.sha256, resourceBytes: master.expectation.bytes, variant: "master", streamIndex: masterWitness.streamIndex })),
          proxy: nativeInvocation.execution("ffmpeg", Object.freeze({ ordinal: snapshots.length * 3 + pairIndex * 4 + 3, operation: "video-proxy-alignment", resourceId, resourceSha256: proxy.expectation.sha256, resourceBytes: proxy.expectation.bytes, variant: "proxy", streamIndex: proxyWitness.streamIndex })),
        })
        : undefined;
      const observed = await probeProjectVideoProxyAlignment(
        root,
        master.locator,
        masterProbe.identity,
        masterWitness,
        proxy.locator,
        proxyProbe.identity,
        proxyWitness,
        {},
        nativeInvocation?.executables,
        executions,
      );
      if (stableJsonStringify(observed) !== stableJsonStringify(stored)) {
        failure("CUT_LOCK_METADATA", `Private proxy snapshot for resource ${JSON.stringify(resourceId)} does not match its stored video-alignment evidence.`, { resourceId, variant: "proxy", locator: proxy.expectation.locator, reason: "proxy-video-alignment-mismatch", source });
      }
    } catch (error) {
      if (error instanceof ReferenceVerifiedInputSessionError) throw error;
      failure("CUT_INPUT_SESSION_PROBE", `Private master/proxy snapshots for resource ${JSON.stringify(resourceId)} could not reproduce their video-alignment evidence.`, { resourceId, variant: "proxy", locator: proxy.expectation.locator, reason: "proxy-video-alignment-probe", source }, error);
    }
  }
}

type PostProbeOperation = Exclude<ReferenceVerifiedInputOperationTestEvent["operation"], "cleanup-complete">;

function throwPostProbeOperationFailure(
  snapshot: Awaited<ReturnType<typeof copyVariant>>,
  operation: PostProbeOperation,
  error: unknown,
): never {
  if (error instanceof ReferenceVerifiedInputSessionError) throw error;
  const expectation = snapshot.expectation;
  failure(
    "CUT_INPUT_SESSION_PATH",
    `Cannot complete ${operation.replaceAll("-", " ")} verification for private ${expectation.variant} snapshot ${JSON.stringify(expectation.resource.id)}.`,
    {
      resourceId: expectation.resource.id,
      variant: expectation.variant,
      locator: expectation.locator,
      reason: operation,
      source: resourceSource(expectation.resource),
    },
    error,
  );
}

async function verifySnapshotSealed(
  snapshot: Awaited<ReturnType<typeof copyVariant>>,
  testHooks?: ReferenceVerifiedInputSessionTestHooks,
) {
  const expectation = snapshot.expectation;
  const operationEvent = async (operation: PostProbeOperation) => testHooks?.operationEvent?.(Object.freeze({
    operation,
    resourceId: expectation.resource.id,
    variant: expectation.variant,
  }));
  let operation: PostProbeOperation = "post-probe-open";
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let primaryFailure: unknown;
  let primaryOperation: PostProbeOperation | undefined;
  try {
    await operationEvent(operation);
    handle = await open(snapshot.path, openReadFlags());

    operation = "post-probe-stat";
    await operationEvent(operation);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameStat(stableStat(before), snapshot.identity)) {
      failure("CUT_INPUT_SESSION_PATH", "Verified-input snapshot identity changed before its post-probe byte rescan.", {
        resourceId: expectation.resource.id,
        variant: expectation.variant,
        locator: expectation.locator,
        reason: "snapshot-post-probe-identity",
        source: resourceSource(expectation.resource),
      });
    }

    operation = "post-probe-read";
    await operationEvent(operation);
    const digest = createHash("sha256");
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < expectation.bytes) {
      const requested = Math.min(chunk.byteLength, expectation.bytes - position);
      const { bytesRead } = await handle.read(chunk, 0, requested, position);
      if (bytesRead !== requested) {
        failure("CUT_LOCK_INTEGRITY", `Private ${expectation.variant} snapshot ended during its post-probe byte rescan.`, {
          resourceId: expectation.resource.id,
          variant: expectation.variant,
          locator: expectation.locator,
          reason: "snapshot-post-probe",
          source: resourceSource(expectation.resource),
        });
      }
      digest.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    const trailing = Buffer.allocUnsafe(1);
    if ((await handle.read(trailing, 0, 1, expectation.bytes)).bytesRead !== 0) {
      failure("CUT_LOCK_INTEGRITY", `Private ${expectation.variant} snapshot grew during its post-probe byte rescan.`, {
        resourceId: expectation.resource.id,
        variant: expectation.variant,
        locator: expectation.locator,
        reason: "snapshot-post-probe",
        source: resourceSource(expectation.resource),
      });
    }

    operation = "post-probe-stat";
    await operationEvent(operation);
    const after = await handle.stat({ bigint: true });
    if (!after.isFile() || !sameStat(stableStat(after), snapshot.identity)) {
      failure("CUT_INPUT_SESSION_PATH", "Verified-input snapshot identity changed during its post-probe byte rescan.", {
        resourceId: expectation.resource.id,
        variant: expectation.variant,
        locator: expectation.locator,
        reason: "snapshot-post-probe-identity",
        source: resourceSource(expectation.resource),
      });
    }

    operation = "post-probe-lstat";
    await operationEvent(operation);
    const metadata = await lstat(snapshot.path, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isFile() || !sameStat(stableStat(metadata), snapshot.identity)) {
      failure("CUT_INPUT_SESSION_PATH", "Verified-input snapshot identity changed after native probing.", {
        resourceId: expectation.resource.id,
        variant: expectation.variant,
        locator: expectation.locator,
        reason: "snapshot-post-probe-identity",
        source: resourceSource(expectation.resource),
      });
    }
    if (digest.digest("hex") !== expectation.sha256) {
      failure("CUT_LOCK_INTEGRITY", `Private ${expectation.variant} snapshot bytes changed after native probing.`, {
        resourceId: expectation.resource.id,
        variant: expectation.variant,
        locator: expectation.locator,
        reason: "snapshot-post-probe",
        source: resourceSource(expectation.resource),
      });
    }
  } catch (error) {
    primaryFailure = error;
    primaryOperation = operation;
  }

  let closeFailure: unknown;
  if (handle) {
    operation = "post-probe-close";
    try {
      await operationEvent(operation);
    } catch (error) {
      closeFailure = error;
    }
    try {
      await handle.close();
    } catch (error) {
      if (closeFailure === undefined) closeFailure = error;
      else if (closeFailure instanceof Error) {
        Object.defineProperty(closeFailure, "handleCloseFailure", {
          configurable: false,
          enumerable: false,
          writable: false,
          value: error,
        });
      }
    }
  }
  if (primaryFailure !== undefined) {
    if (closeFailure !== undefined && primaryFailure instanceof Error) {
      Object.defineProperty(primaryFailure, "closeFailure", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: closeFailure,
      });
    }
    throwPostProbeOperationFailure(snapshot, primaryOperation!, primaryFailure);
  }
  if (closeFailure !== undefined) throwPostProbeOperationFailure(snapshot, "post-probe-close", closeFailure);
}

async function readSealedTranscriptSnapshot(
  snapshot: Awaited<ReturnType<typeof copyVariant>>,
  binding: IRTranscriptBindingV1,
  bindingPath: string,
) {
  const path = `${bindingPath}.transcriptResourceId`;
  const expectedBytes = snapshot.expectation.bytes;
  if (expectedBytes < 1 || expectedBytes > cutTranscriptSidecarMaxBytes) {
    throw new CutTranscriptLockError(
      "CUT_TRANSCRIPT_LOCK_SIDECAR",
      path,
      binding,
      `private transcript snapshot must contain 1 through ${cutTranscriptSidecarMaxBytes} bytes; found ${expectedBytes}.`,
    );
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(snapshot.path, openReadFlags());
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameStat(stableStat(before), snapshot.identity)) {
      throw new CutTranscriptLockError(
        "CUT_TRANSCRIPT_LOCK_INTEGRITY",
        path,
        binding,
        "private transcript snapshot identity changed before semantic verification.",
      );
    }
    const bytes = Buffer.alloc(expectedBytes);
    let position = 0;
    while (position < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, position, bytes.byteLength - position, position);
      if (bytesRead < 1) {
        throw new CutTranscriptLockError(
          "CUT_TRANSCRIPT_LOCK_INTEGRITY",
          path,
          binding,
          "private transcript snapshot ended during semantic verification.",
        );
      }
      position += bytesRead;
    }
    const trailing = Buffer.allocUnsafe(1);
    if ((await handle.read(trailing, 0, 1, expectedBytes)).bytesRead !== 0) {
      throw new CutTranscriptLockError(
        "CUT_TRANSCRIPT_LOCK_INTEGRITY",
        path,
        binding,
        "private transcript snapshot grew during semantic verification.",
      );
    }
    const after = await handle.stat({ bigint: true });
    if (!after.isFile() || !sameStat(stableStat(after), snapshot.identity)) {
      throw new CutTranscriptLockError(
        "CUT_TRANSCRIPT_LOCK_INTEGRITY",
        path,
        binding,
        "private transcript snapshot identity changed during semantic verification.",
      );
    }
    return bytes;
  } catch (error) {
    if (error instanceof CutTranscriptLockError) throw error;
    throw new CutTranscriptLockError(
      "CUT_TRANSCRIPT_LOCK_INTEGRITY",
      path,
      binding,
      `cannot read the private transcript snapshot safely (${error instanceof Error ? error.message : String(error)}).`,
    );
  } finally {
    await handle?.close();
  }
}

/**
 * Bind one render/review invocation to private copies of every locked resource
 * variant. No decoder or native probe sees the caller-controlled source paths.
 */
async function prepareReferenceVerifiedInputSessionInternal(
  canonicalLockedIr: CutAVIR,
  projectRoot: string,
  requestedProfile: ReferenceMediaProfile,
  options: Readonly<{ limits?: Partial<ReferenceVerifiedInputSessionLimits> }> = {},
  testHooks?: ReferenceVerifiedInputSessionTestHooks,
  expectedProcessGroupId: number | null = null,
  nativeProcessSupervision?: ReferenceVerifiedInputNativeProcessSupervision,
): Promise<ReferenceVerifiedInputSessionWithNativeProcessEvidence> {
  if (!record(options) || Object.keys(options).some((key) => key !== "limits")) {
    failure("CUT_INPUT_SESSION_CONTRACT", "Verified input session options contain an unknown property.", { reason: "options" });
  }
  const probeConcurrency = normalizedProbeConcurrency(testHooks);
  if (requestedProfile !== "master" && requestedProfile !== "proxy") {
    failure("CUT_INPUT_SESSION_CONTRACT", "Verified input media profile must be master or proxy.", { reason: "media-profile" });
  }
  // Detach synchronously from caller-owned objects before the first await.
  // The strict public IR loader and pure embedded-lock contract run before
  // media profile selection or any project filesystem mutation.
  let lockedIr: CutAVIR;
  try {
    // Structural lock metadata cannot distinguish a legitimate one-variant
    // canonical resource from a serialized selected-proxy IR whose deletable
    // profile markers were stripped. Require the invocation-local applyCutLock
    // authority at the execution boundary before cloning it into this session.
    // A resource-free graph has no external byte authority to launder and may
    // execute directly. Any graph carrying resources must be the unchanged
    // invocation-local applyCutLock result.
    if (Object.keys(canonicalLockedIr.resources).length > 0) assertAppliedCutLockIr(canonicalLockedIr);
    lockedIr = structuredClone(canonicalLockedIr);
    validateCutAvIr(lockedIr);
    validateEmbeddedLockedIrContract(lockedIr);
    registerAppliedCutLockIr(lockedIr);
  } catch (error) {
    if (error instanceof ReferenceVerifiedInputSessionError) throw error;
    failure("CUT_INPUT_SESSION_LOCK_STATE", "Canonical CutAVIR or embedded cut.lock state is invalid.", { reason: "canonical-lock-state" }, error);
  }
  // MediaCamera2D no-op admission is pure over the locked graph and locked
  // native dimensions. Run it before creating a session directory or opening
  // any caller-controlled source path, so an unobservable authored control
  // cannot trigger filesystem or decoder work.
  const selectedForCameraAdmission = selectReferenceMediaProfile(lockedIr!, requestedProfile);
  for (const composition of [...selectedForCameraAdmission.ir.compositions].sort((left, right) => left.id.localeCompare(right.id))) {
    validateReferenceMediaCamera2DGraph(
      selectedForCameraAdmission.ir,
      composition,
      referenceReachableCompositionNodes(selectedForCameraAdmission.ir, composition),
    );
  }
  const variants = expectations(lockedIr!), limits = normalizedLimits(options.limits);
  enforceTranscriptSnapshotBudgets(lockedIr!, variants);
  const aggregateBytes = enforceBudgets(variants, limits);
  const nativeInvocation = await createNativeProcessInvocation(
    variants,
    testHooks?.nativeExecutables,
    expectedProcessGroupId,
    nativeProcessSupervision,
  );
  const session = await createSessionDirectory(projectRoot, testHooks);
  let nativeProcesses: ReferenceVerifiedInputNativeProcessEvidence | undefined;
  let nativeProcessLifecycle: ReferenceVerifiedInputNativeProcessLifecycleStreamEvidence | undefined;
  try {
    const snapshots = [] as Awaited<ReturnType<typeof copyVariant>>[];
    // Deliberately finish the complete byte-binding phase before the first
    // image decoder or ffprobe invocation.
    for (let index = 0; index < variants.length; index += 1) snapshots.push(await copyVariant(variants[index], session, index));
    await probeSnapshotsBounded(snapshots, session.physicalRoot, probeConcurrency, testHooks, nativeInvocation);
    await verifySnapshotAudioProxyAlignments(snapshots, session.physicalRoot, nativeInvocation);
    await verifySnapshotVideoProxyAlignments(snapshots, session.physicalRoot, nativeInvocation);
    ({ nativeProcesses, lifecycle: nativeProcessLifecycle } = await nativeInvocation.seal());
    for (const snapshot of snapshots) await verifySnapshotSealed(snapshot, testHooks);

    const snapshotByVariant = new Map(snapshots.map((snapshot) => [`${snapshot.expectation.resource.id}\0${snapshot.expectation.variant}`, snapshot]));
    const lockedMasterResources: Record<string, LockedResource> = {};
    for (const snapshot of snapshots) {
      if (snapshot.expectation.variant !== "master") continue;
      const expectation = snapshot.expectation;
      lockedMasterResources[expectation.resource.id] = {
        id: expectation.resource.id,
        kind: expectation.resource.kind,
        locator: expectation.locator,
        sha256: expectation.sha256,
        bytes: expectation.bytes,
        probe: expectation.probe,
      };
    }
    await verifyCutTranscriptBindingsForLock(
      lockedIr!,
      lockedMasterResources,
      async (resource, _locked, binding, path) => {
        const snapshot = snapshotByVariant.get(`${resource.id}\0master`);
        if (!snapshot) {
          throw new CutTranscriptLockError(
            "CUT_TRANSCRIPT_LOCK_RESOURCE",
            `${path}.transcriptResourceId`,
            binding,
            "has no authenticated private master snapshot.",
          );
        }
        return readSealedTranscriptSnapshot(snapshot, binding, path);
      },
    );
    await validateReferenceLutResources(lockedIr!, async (resourceId) => {
      const snapshot = snapshotByVariant.get(`${resourceId}\0master`);
      if (!snapshot) failure("CUT_INPUT_SESSION_LOCK_STATE", `Locked LUT resource ${JSON.stringify(resourceId)} has no private master snapshot.`, { resourceId, variant: "master", reason: "lut-snapshot" });
      return readFile(snapshot.path);
    });
    for (const composition of [...lockedIr!.compositions].sort((left, right) => left.id.localeCompare(right.id))) {
      await validateReferencePlanarTrackResources(lockedIr!, composition, async (resourceId) => {
        const snapshot = snapshotByVariant.get(`${resourceId}\0master`);
        if (!snapshot) failure("CUT_INPUT_SESSION_LOCK_STATE", `Locked PlanarTrack resource ${JSON.stringify(resourceId)} has no private master snapshot.`, { resourceId, variant: "master", reason: "planar-track-snapshot" });
        return readFile(snapshot.path);
      });
    }
    const selected = selectReferenceMediaProfile(lockedIr!, requestedProfile);
    const mediaSelection = new Map(selected.evidence.resources.map((resource) => [resource.resourceId, resource.selected]));
    const selectedPaths = new Map<string, (typeof snapshots)[number]>();
    const evidenceVariants = variants.map((variant) => {
      const profile = mediaSelection.get(variant.resource.id) ?? "master";
      const selectedVariant = variant.variant === profile;
      if (selectedVariant) selectedPaths.set(variant.resource.id, snapshotByVariant.get(`${variant.resource.id}\0${variant.variant}`)!);
      return Object.freeze({
        resourceId: variant.resource.id,
        resourceKind: variant.resource.kind,
        variant: variant.variant,
        selected: selectedVariant,
        bytes: String(variant.bytes),
        sha256: variant.sha256,
        probeKind: variant.probe.kind,
      }) satisfies ReferenceVerifiedInputVariantEvidence;
    });
    if (selectedPaths.size !== Object.keys(lockedIr!.resources).length) {
      failure("CUT_INPUT_SESSION_LOCK_STATE", "A selected private snapshot could not be resolved for every locked resource.", { reason: "selected-paths" });
    }
    const evidence: ReferenceVerifiedInputSessionEvidence = Object.freeze({
      format: "cut-reference-verified-input-session",
      version: 1,
      requestedProfile,
      variants: Object.freeze(evidenceVariants),
      variantCount: variants.length,
      aggregateBytes: aggregateBytes.toString(),
      verificationOrder: "snapshot-all-then-probe-all",
    });
    let usable = true;
    const pathFor = (resourceId: string) => {
      if (typeof resourceId !== "string" || !resourceId) {
        failure("CUT_INPUT_SESSION_CONTRACT", "Verified input resource id must be one non-empty string.", { reason: "resource-id" });
      }
      if (!usable) failure("CUT_INPUT_SESSION_CONTRACT", "Verified input session was already cleaned up.", { resourceId, reason: "session-cleaned" });
      const snapshot = selectedPaths.get(resourceId);
      if (!snapshot) failure("CUT_INPUT_SESSION_CONTRACT", `Verified input session has no selected resource ${JSON.stringify(resourceId)}.`, { resourceId, reason: "unknown-resource" });
      try {
        const directory = lstatSync(session.path, { bigint: true });
        if (directory.isSymbolicLink() || !directory.isDirectory() || directory.dev !== session.identity.dev || directory.ino !== session.identity.ino || realpathSync(session.path) !== session.path) {
          failure("CUT_INPUT_SESSION_PATH", "Verified-input session identity changed before resource handoff.", { resourceId, reason: "handoff-session-identity" });
        }
        const metadata = lstatSync(snapshot.path, { bigint: true });
        if (metadata.isSymbolicLink() || !metadata.isFile() || !sameStat(stableStat(metadata), snapshot.identity) || realpathSync(snapshot.path) !== snapshot.path) {
          failure("CUT_INPUT_SESSION_PATH", "Verified-input snapshot identity changed before resource handoff.", { resourceId, variant: snapshot.expectation.variant, locator: snapshot.expectation.locator, reason: "handoff-file-identity" });
        }
      } catch (error) {
        if (error instanceof ReferenceVerifiedInputSessionError) throw error;
        failure("CUT_INPUT_SESSION_PATH", "Cannot verify a private snapshot before resource handoff.", { resourceId, variant: snapshot.expectation.variant, locator: snapshot.expectation.locator, reason: "handoff-inspect" }, error);
      }
      return snapshot.path;
    };
    const cleanup = () => { usable = false; return session.cleanup(); };
    const preparedSession = Object.freeze({ ir: selected.ir, media: selected.evidence, pathFor, evidence, cleanup });
    return Object.freeze({
      session: preparedSession,
      nativeProcesses,
      nativeProcessPlan: nativeInvocation.plan,
      nativeProcessLifecycle,
    });
  } catch (error) {
    let cleanupFailure: unknown;
    if (nativeProcesses === undefined) {
      try { await nativeInvocation.seal(); }
      catch (nativeProcessError) { cleanupFailure = nativeProcessError; }
    }
    try { await session.cleanup(); }
    catch (cleanupError) {
      cleanupFailure = cleanupFailure === undefined
        ? cleanupError
        : new AggregateError([cleanupFailure, cleanupError], "Native-process sealing and verified-input cleanup both failed.");
    }
    if (cleanupFailure !== undefined) attachCleanupFailure(error, cleanupFailure);
    throw error;
  }
}

export async function prepareReferenceVerifiedInputSession(
  canonicalLockedIr: CutAVIR,
  projectRoot: string,
  requestedProfile: ReferenceMediaProfile,
  options: Readonly<{ limits?: Partial<ReferenceVerifiedInputSessionLimits> }> = {},
): Promise<ReferenceVerifiedInputSession> {
  return (await prepareReferenceVerifiedInputSessionInternal(canonicalLockedIr, projectRoot, requestedProfile, options)).session;
}

/**
 * Production evidence boundary for supervised invocations whose parent is the
 * process-group leader. The lifecycle evidence is nondeterministic invocation
 * evidence and deliberately never enters build or persistent cache identity.
 */
export async function prepareReferenceVerifiedInputSessionWithNativeProcessEvidence(
  canonicalLockedIr: CutAVIR,
  projectRoot: string,
  requestedProfile: ReferenceMediaProfile,
  options: Readonly<{ limits?: Partial<ReferenceVerifiedInputSessionLimits> }> = {},
  supervision?: ReferenceVerifiedInputNativeProcessSupervision,
): Promise<ReferenceVerifiedInputSessionWithNativeProcessEvidence> {
  return prepareReferenceVerifiedInputSessionInternal(
    canonicalLockedIr,
    projectRoot,
    requestedProfile,
    options,
    undefined,
    process.pid,
    supervision,
  );
}

/** Focused-test entry point; production callers always use the fixed width. */
export async function prepareReferenceVerifiedInputSessionForTest(
  canonicalLockedIr: CutAVIR,
  projectRoot: string,
  requestedProfile: ReferenceMediaProfile,
  options: Readonly<{ limits?: Partial<ReferenceVerifiedInputSessionLimits> }> = {},
  hooks: ReferenceVerifiedInputSessionTestHooks = {},
): Promise<ReferenceVerifiedInputSession> {
  return (await prepareReferenceVerifiedInputSessionInternal(canonicalLockedIr, projectRoot, requestedProfile, options, hooks)).session;
}
