import { createHash } from "node:crypto";
import { stableJsonStringify } from "../core/stable";
import {
  addRational,
  compareRational,
  multiplyRational,
  rational,
  type Rational,
  zeroRational,
} from "../language/rational";
import {
  validateCutOtioEditorialProfile,
  type CutOtioEditorialLink,
  type CutOtioEditorialLoss,
  type CutOtioEditorialMetadata,
  type CutOtioEditorialProfile,
} from "./otio-editorial-profile";

/**
 * V3 is deliberately an extension of, rather than a replacement for, the
 * frozen V2 native-track profile. This keeps existing OTIO readers and every
 * V2 semantic hash byte-stable while binding CUT-only origin-clock meaning
 * beside the native clips that carry its visible slices.
 */
export const cutOtioEditorialProfileV3Format =
  "cut-otio-editorial-profile-extension" as const;
export const cutOtioEditorialProfileV3Version = 3 as const;
export const cutOtioEditorialProfileV3ObservationFormat =
  "cut-otio-editorial-profile-extension-observation" as const;

export const cutOtioEditorialProfileV3Limits = Object.freeze({
  maximumOrigins: 50_000,
  maximumViews: 100_000,
  maximumLineageSegments: 100_000,
  maximumProcessorNodesPerOrigin: 256,
  maximumStringBytes: 4_096,
  maximumRationalDigits: 128,
});

export type CutOtioEditorialAudioOriginKind =
  | "direct-audio"
  | "processed-audio";

export type CutOtioEditorialAudioOriginView = Readonly<{
  itemId: string;
  segmentId: string;
  parentSegmentId?: string;
  sliceOffset: Rational;
  source: Readonly<{ start: Rational; duration: Rational }>;
  destination: Readonly<{ start: Rational; duration: Rational }>;
  handles: Readonly<{ head: Rational; tail: Rational }>;
  link: CutOtioEditorialLink;
  role?: string;
  metadata?: CutOtioEditorialMetadata;
  lineageSha256: string;
}>;

export type CutOtioEditorialAudioLineageSegment = Readonly<{
  planId: string;
  trackId: string;
  originId: string;
  segmentId: string;
  parentSegmentId?: string;
  sliceOffset: Rational;
  source: Readonly<{ start: Rational; duration: Rational }>;
  destination: Readonly<{ start: Rational; duration: Rational }>;
  handles: Readonly<{ head: Rational; tail: Rational }>;
  linkId?: string;
  role?: string;
  metadata?: CutOtioEditorialMetadata;
  lineageSha256: string;
}>;

export function cutOtioEditorialAudioLineageSha256(
  value: Omit<CutOtioEditorialAudioLineageSegment, "lineageSha256">,
) {
  return createHash("sha256")
    .update(stableJsonStringify({
      planId: value.planId,
      trackId: value.trackId,
      originId: value.originId,
      segmentId: value.segmentId,
      parentSegmentId: value.parentSegmentId ?? null,
      destination: value.destination,
      source: value.source,
      sliceOffset: value.sliceOffset,
      handles: value.handles,
      role: value.role ?? null,
      metadata: value.metadata ?? {},
      linkId: value.linkId ?? null,
    }))
    .digest("hex");
}

export type CutOtioEditorialAudioOrigin = Readonly<{
  id: string;
  trackId: string;
  timelineEditPlanId: string;
  timelineEditOriginId: string;
  kind: CutOtioEditorialAudioOriginKind;
  originAuthorityId: string;
  sourceAuthorityId: string;
  graphAuthorityId?: string;
  sourceNodeId: string;
  processorNodeIds: readonly string[];
  processorGraphSemanticSha256?: string;
  statePolicy: "single-authorized-evaluation";
  source: Readonly<{ start: Rational; duration: Rational }>;
  originDuration: Rational;
  rate: Rational;
  fadeIn: Rational;
  fadeOut: Rational;
  lineageSegments: readonly CutOtioEditorialAudioLineageSegment[];
  views: readonly CutOtioEditorialAudioOriginView[];
}>;

export type CutOtioEditorialProfileV3Body = Readonly<{
  format: typeof cutOtioEditorialProfileV3Format;
  version: typeof cutOtioEditorialProfileV3Version;
  compositionId: string;
  baseProfileSemanticSha256: string;
  audioOrigins: readonly CutOtioEditorialAudioOrigin[];
  losses: readonly CutOtioEditorialLoss[];
}>;

export type CutOtioEditorialProfileV3 =
  CutOtioEditorialProfileV3Body & Readonly<{ semanticSha256: string }>;

export type CutOtioEditorialProfileV3Observation = Readonly<{
  format: typeof cutOtioEditorialProfileV3ObservationFormat;
  version: 1;
  compositionId: string;
  baseProfileSemanticSha256: string;
  audioOrigins: readonly CutOtioEditorialAudioOrigin[];
}>;

export type CutOtioEditorialProfileV3Reconciliation = Readonly<{
  format: "cut-otio-editorial-profile-extension-reconciliation";
  version: 1;
  status: "pass";
  semanticSha256: string;
  baseProfileSemanticSha256: string;
  origins: number;
  views: number;
  lineageSegments: number;
  targetScopedLosses: number;
}>;

export type CutOtioEditorialProfileV3ErrorCode =
  | "CUT_OTIO_PROFILE_V3_BUDGET"
  | "CUT_OTIO_PROFILE_V3_DUPLICATE"
  | "CUT_OTIO_PROFILE_V3_HASH"
  | "CUT_OTIO_PROFILE_V3_ID"
  | "CUT_OTIO_PROFILE_V3_LOSS"
  | "CUT_OTIO_PROFILE_V3_RATIONAL"
  | "CUT_OTIO_PROFILE_V3_RECONCILIATION"
  | "CUT_OTIO_PROFILE_V3_REFERENCE"
  | "CUT_OTIO_PROFILE_V3_TIMING"
  | "CUT_OTIO_PROFILE_V3_TYPE"
  | "CUT_OTIO_PROFILE_V3_UNKNOWN_FIELD"
  | "CUT_OTIO_PROFILE_V3_VERSION";

export class CutOtioEditorialProfileV3Error extends Error {
  constructor(
    readonly code: CutOtioEditorialProfileV3ErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(`${code} at ${path}: ${message}`);
    this.name = "CutOtioEditorialProfileV3Error";
  }
}

type JsonRecord = Record<string, unknown>;

function fail(
  code: CutOtioEditorialProfileV3ErrorCode,
  path: string,
  message: string,
): never {
  throw new CutOtioEditorialProfileV3Error(code, path, message);
}

function record(value: unknown, path: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("CUT_OTIO_PROFILE_V3_TYPE", path, "must be a plain object.");
  }
  return value as JsonRecord;
}

function closed(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  const result = record(value, path), allowed = new Set([...required, ...optional]);
  for (const field of Object.keys(result)) {
    if (!allowed.has(field)) {
      fail(
        "CUT_OTIO_PROFILE_V3_UNKNOWN_FIELD",
        `${path}.${field}`,
        "is not part of the closed V3 editorial extension.",
      );
    }
  }
  for (const field of required) {
    if (!Object.hasOwn(result, field)) {
      fail(
        "CUT_OTIO_PROFILE_V3_TYPE",
        `${path}.${field}`,
        "is required.",
      );
    }
  }
  return result;
}

function array(
  value: unknown,
  path: string,
  maximum: number,
  minimum = 0,
) {
  if (!Array.isArray(value)) {
    fail("CUT_OTIO_PROFILE_V3_TYPE", path, "must be an array.");
  }
  if (value.length < minimum || value.length > maximum) {
    fail(
      "CUT_OTIO_PROFILE_V3_BUDGET",
      path,
      `must contain ${minimum}..${maximum} entries.`,
    );
  }
  return value;
}

function boundedString(value: unknown, path: string, allowEmpty = false) {
  if (typeof value !== "string"
    || (!allowEmpty && value.length === 0)
    || Buffer.byteLength(value, "utf8")
      > cutOtioEditorialProfileV3Limits.maximumStringBytes
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(
      "CUT_OTIO_PROFILE_V3_TYPE",
      path,
      "must be one bounded control-free UTF-8 string.",
    );
  }
  return value;
}

function stableId(value: unknown, path: string) {
  const parsed = boundedString(value, path);
  if (!/^[A-Za-z_][A-Za-z0-9._:-]{0,127}$/u.test(parsed)) {
    fail("CUT_OTIO_PROFILE_V3_ID", path, "is not one stable CUT identifier.");
  }
  return parsed;
}

function sha256(value: unknown, path: string) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail("CUT_OTIO_PROFILE_V3_ID", path, "must be one lowercase SHA-256.");
  }
  return value;
}

function authorityId(value: unknown, path: string) {
  const parsed = boundedString(value, path);
  if (!/^(?:[a-f0-9]{64}|[A-Za-z_][A-Za-z0-9._:-]{0,127})$/u.test(parsed)) {
    fail(
      "CUT_OTIO_PROFILE_V3_ID",
      path,
      "must be one closed authority identifier or lowercase SHA-256.",
    );
  }
  return parsed;
}

function exactRational(
  value: unknown,
  path: string,
  sign: "any" | "non-negative" | "positive" = "any",
) {
  const object = closed(value, path, ["numerator", "denominator"]);
  if (typeof object.numerator !== "string"
    || typeof object.denominator !== "string"
    || object.numerator.length > cutOtioEditorialProfileV3Limits.maximumRationalDigits
    || object.denominator.length > cutOtioEditorialProfileV3Limits.maximumRationalDigits
    || !/^-?(?:0|[1-9][0-9]*)$/u.test(object.numerator)
    || !/^[1-9][0-9]*$/u.test(object.denominator)) {
    fail(
      "CUT_OTIO_PROFILE_V3_RATIONAL",
      path,
      "must use bounded canonical integer strings and a positive denominator.",
    );
  }
  const canonical = rational(object.numerator, object.denominator);
  if (canonical.numerator !== object.numerator
    || canonical.denominator !== object.denominator) {
    fail("CUT_OTIO_PROFILE_V3_RATIONAL", path, "must be reduced and canonical.");
  }
  const compared = compareRational(canonical, zeroRational);
  if ((sign === "non-negative" && compared < 0)
    || (sign === "positive" && compared <= 0)) {
    fail(
      "CUT_OTIO_PROFILE_V3_RATIONAL",
      path,
      `must be ${sign === "positive" ? "positive" : "non-negative"}.`,
    );
  }
  return canonical;
}

function interval(value: unknown, path: string) {
  const object = closed(value, path, ["start", "duration"]);
  return Object.freeze({
    start: exactRational(object.start, `${path}.start`, "non-negative"),
    duration: exactRational(object.duration, `${path}.duration`, "positive"),
  });
}

function handles(value: unknown, path: string) {
  const object = closed(value, path, ["head", "tail"]);
  return Object.freeze({
    head: exactRational(object.head, `${path}.head`, "non-negative"),
    tail: exactRational(object.tail, `${path}.tail`, "non-negative"),
  });
}

function sameRational(left: Rational, right: Rational) {
  return compareRational(left, right) === 0;
}

function sameInterval(
  left: Readonly<{ start: Rational; duration: Rational }>,
  right: Readonly<{ start: Rational; duration: Rational }>,
) {
  return sameRational(left.start, right.start)
    && sameRational(left.duration, right.duration);
}

function clone<T>(value: T): T {
  return JSON.parse(stableJsonStringify(value)) as T;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    Object.values(value as Record<string, unknown>).forEach((entry) => freeze(entry));
  }
  return value;
}

function parseView(
  value: unknown,
  path: string,
): CutOtioEditorialAudioOriginView {
  const object = closed(
    value,
    path,
    [
      "itemId",
      "segmentId",
      "sliceOffset",
      "source",
      "destination",
      "handles",
      "link",
      "lineageSha256",
    ],
    ["parentSegmentId", "role", "metadata"],
  );
  const linkObject = record(object.link, `${path}.link`);
  const link = linkObject.kind === "unlinked"
    ? (() => {
        closed(linkObject, `${path}.link`, ["kind"]);
        return Object.freeze({ kind: "unlinked" as const });
      })()
    : (() => {
        const linked = closed(
          linkObject,
          `${path}.link`,
          ["kind", "groupId", "segmentId"],
        );
        if (linked.kind !== "linked") {
          fail(
            "CUT_OTIO_PROFILE_V3_TYPE",
            `${path}.link.kind`,
            "must be unlinked or linked.",
          );
        }
        return Object.freeze({
          kind: "linked" as const,
          groupId: stableId(linked.groupId, `${path}.link.groupId`),
          segmentId: stableId(linked.segmentId, `${path}.link.segmentId`),
        });
      })();
  const role = object.role === undefined
    ? undefined
    : boundedString(object.role, `${path}.role`);
  const metadata = object.metadata === undefined
    ? undefined
    : record(object.metadata, `${path}.metadata`);
  if (metadata && !Object.keys(metadata).length) {
    fail(
      "CUT_OTIO_PROFILE_V3_TYPE",
      `${path}.metadata`,
      "must be omitted when empty.",
    );
  }
  const parsedMetadata = metadata
    ? Object.freeze(Object.fromEntries(Object.entries(metadata).map(([key, entry]) => {
        if (!/^(?![Cc][Uu][Tt]\.)(?:[A-Za-z][A-Za-z0-9_-]*\.)+[A-Za-z][A-Za-z0-9_-]*$/u.test(key)) {
          fail(
            "CUT_OTIO_PROFILE_V3_ID",
            `${path}.metadata.${key}`,
            "must be one non-CUT namespaced metadata key.",
          );
        }
        return [key, boundedString(entry, `${path}.metadata.${key}`, true)];
      })))
    : undefined;
  return Object.freeze({
    itemId: stableId(object.itemId, `${path}.itemId`),
    segmentId: stableId(object.segmentId, `${path}.segmentId`),
    ...(object.parentSegmentId === undefined
      ? {}
      : { parentSegmentId: stableId(object.parentSegmentId, `${path}.parentSegmentId`) }),
    sliceOffset: exactRational(object.sliceOffset, `${path}.sliceOffset`, "non-negative"),
    source: interval(object.source, `${path}.source`),
    destination: interval(object.destination, `${path}.destination`),
    handles: handles(object.handles, `${path}.handles`),
    link,
    ...(role === undefined ? {} : { role }),
    ...(parsedMetadata === undefined ? {} : { metadata: parsedMetadata }),
    lineageSha256: sha256(object.lineageSha256, `${path}.lineageSha256`),
  });
}

function parseLineageSegment(
  value: unknown,
  path: string,
): CutOtioEditorialAudioLineageSegment {
  const object = closed(
    value,
    path,
    [
      "planId",
      "trackId",
      "originId",
      "segmentId",
      "sliceOffset",
      "source",
      "destination",
      "handles",
      "lineageSha256",
    ],
    ["parentSegmentId", "linkId", "role", "metadata"],
  );
  const metadata = object.metadata === undefined
    ? undefined
    : record(object.metadata, `${path}.metadata`);
  if (metadata && !Object.keys(metadata).length) {
    fail(
      "CUT_OTIO_PROFILE_V3_TYPE",
      `${path}.metadata`,
      "must be omitted when empty.",
    );
  }
  const parsedMetadata = metadata
    ? Object.freeze(Object.fromEntries(Object.entries(metadata).map(([key, entry]) => {
        if (!/^(?![Cc][Uu][Tt]\.)(?:[A-Za-z][A-Za-z0-9_-]*\.)+[A-Za-z][A-Za-z0-9_-]*$/u.test(key)) {
          fail(
            "CUT_OTIO_PROFILE_V3_ID",
            `${path}.metadata.${key}`,
            "must be one non-CUT namespaced metadata key.",
          );
        }
        return [key, boundedString(entry, `${path}.metadata.${key}`, true)];
      })))
    : undefined;
  const parsed: CutOtioEditorialAudioLineageSegment = Object.freeze({
    planId: stableId(object.planId, `${path}.planId`),
    trackId: stableId(object.trackId, `${path}.trackId`),
    originId: stableId(object.originId, `${path}.originId`),
    segmentId: stableId(object.segmentId, `${path}.segmentId`),
    ...(object.parentSegmentId === undefined
      ? {}
      : {
          parentSegmentId: stableId(
            object.parentSegmentId,
            `${path}.parentSegmentId`,
          ),
        }),
    sliceOffset: exactRational(
      object.sliceOffset,
      `${path}.sliceOffset`,
      "non-negative",
    ),
    source: interval(object.source, `${path}.source`),
    destination: interval(object.destination, `${path}.destination`),
    handles: handles(object.handles, `${path}.handles`),
    ...(object.linkId === undefined
      ? {}
      : { linkId: stableId(object.linkId, `${path}.linkId`) }),
    ...(object.role === undefined
      ? {}
      : { role: boundedString(object.role, `${path}.role`) }),
    ...(parsedMetadata === undefined ? {} : { metadata: parsedMetadata }),
    lineageSha256: sha256(object.lineageSha256, `${path}.lineageSha256`),
  });
  const expected = cutOtioEditorialAudioLineageSha256(parsed);
  if (parsed.lineageSha256 !== expected) {
    fail(
      "CUT_OTIO_PROFILE_V3_HASH",
      `${path}.lineageSha256`,
      `does not match the exact TimelineEdit lineage semantics; expected ${expected}.`,
    );
  }
  return parsed;
}

function parseOrigin(
  value: unknown,
  path: string,
): CutOtioEditorialAudioOrigin {
  const object = closed(
    value,
    path,
    [
      "id",
      "trackId",
      "timelineEditPlanId",
      "timelineEditOriginId",
      "kind",
      "originAuthorityId",
      "sourceAuthorityId",
      "sourceNodeId",
      "processorNodeIds",
      "statePolicy",
      "source",
      "originDuration",
      "rate",
      "fadeIn",
      "fadeOut",
      "lineageSegments",
      "views",
    ],
    ["graphAuthorityId", "processorGraphSemanticSha256"],
  );
  if (object.kind !== "direct-audio" && object.kind !== "processed-audio") {
    fail(
      "CUT_OTIO_PROFILE_V3_TYPE",
      `${path}.kind`,
      "must be direct-audio or processed-audio.",
    );
  }
  if (object.statePolicy !== "single-authorized-evaluation") {
    fail(
      "CUT_OTIO_PROFILE_V3_TYPE",
      `${path}.statePolicy`,
      "must be single-authorized-evaluation.",
    );
  }
  const processorNodeIds = array(
    object.processorNodeIds,
    `${path}.processorNodeIds`,
    cutOtioEditorialProfileV3Limits.maximumProcessorNodesPerOrigin,
  ).map((entry, index) =>
    stableId(entry, `${path}.processorNodeIds[${index}]`));
  if (new Set(processorNodeIds).size !== processorNodeIds.length) {
    fail(
      "CUT_OTIO_PROFILE_V3_DUPLICATE",
      `${path}.processorNodeIds`,
      "must not contain duplicate node identities.",
    );
  }
  if (object.kind === "direct-audio"
    && (object.graphAuthorityId !== undefined
      || object.processorGraphSemanticSha256 !== undefined
      || processorNodeIds.length)) {
    fail(
      "CUT_OTIO_PROFILE_V3_TYPE",
      path,
      "a direct-audio origin must omit processor graph authority.",
    );
  }
  if (object.kind === "processed-audio"
    && (object.graphAuthorityId === undefined
      || object.processorGraphSemanticSha256 === undefined
      || !processorNodeIds.length)) {
    fail(
      "CUT_OTIO_PROFILE_V3_TYPE",
      path,
      "a processed-audio origin requires graph authority, semantic digest, and processor nodes.",
    );
  }
  const views = array(
    object.views,
    `${path}.views`,
    cutOtioEditorialProfileV3Limits.maximumViews,
    1,
  ).map((entry, index) => parseView(entry, `${path}.views[${index}]`));
  const lineageSegments = array(
    object.lineageSegments,
    `${path}.lineageSegments`,
    cutOtioEditorialProfileV3Limits.maximumLineageSegments,
    1,
  ).map((entry, index) =>
    parseLineageSegment(entry, `${path}.lineageSegments[${index}]`));
  return Object.freeze({
    id: stableId(object.id, `${path}.id`),
    trackId: stableId(object.trackId, `${path}.trackId`),
    timelineEditPlanId: stableId(
      object.timelineEditPlanId,
      `${path}.timelineEditPlanId`,
    ),
    timelineEditOriginId: stableId(
      object.timelineEditOriginId,
      `${path}.timelineEditOriginId`,
    ),
    kind: object.kind,
    originAuthorityId: authorityId(object.originAuthorityId, `${path}.originAuthorityId`),
    sourceAuthorityId: authorityId(object.sourceAuthorityId, `${path}.sourceAuthorityId`),
    ...(object.graphAuthorityId === undefined
      ? {}
      : { graphAuthorityId: authorityId(object.graphAuthorityId, `${path}.graphAuthorityId`) }),
    sourceNodeId: stableId(object.sourceNodeId, `${path}.sourceNodeId`),
    processorNodeIds: Object.freeze(processorNodeIds),
    ...(object.processorGraphSemanticSha256 === undefined
      ? {}
      : {
          processorGraphSemanticSha256: sha256(
            object.processorGraphSemanticSha256,
            `${path}.processorGraphSemanticSha256`,
          ),
        }),
    statePolicy: "single-authorized-evaluation",
    source: interval(object.source, `${path}.source`),
    originDuration: exactRational(
      object.originDuration,
      `${path}.originDuration`,
      "positive",
    ),
    rate: exactRational(object.rate, `${path}.rate`, "positive"),
    fadeIn: exactRational(object.fadeIn, `${path}.fadeIn`, "non-negative"),
    fadeOut: exactRational(object.fadeOut, `${path}.fadeOut`, "non-negative"),
    lineageSegments: Object.freeze(lineageSegments),
    views: Object.freeze(views),
  });
}

function parseLoss(value: unknown, path: string): CutOtioEditorialLoss {
  const object = closed(
    value,
    path,
    ["code", "category", "disposition", "target", "subject", "message"],
  );
  const target = closed(object.target, `${path}.target`, ["kind"], ["id"]);
  if (target.kind !== "cut-roundtrip"
    && target.kind !== "generic-otio"
    && target.kind !== "adapter") {
    fail(
      "CUT_OTIO_PROFILE_V3_TYPE",
      `${path}.target.kind`,
      "must be cut-roundtrip, generic-otio, or adapter.",
    );
  }
  if (target.kind === "adapter" && target.id === undefined) {
    fail(
      "CUT_OTIO_PROFILE_V3_TYPE",
      `${path}.target.id`,
      "is required for an adapter target.",
    );
  }
  if (target.kind !== "adapter" && target.id !== undefined) {
    fail(
      "CUT_OTIO_PROFILE_V3_UNKNOWN_FIELD",
      `${path}.target.id`,
      "is accepted only for adapter targets.",
    );
  }
  const subject = closed(object.subject, `${path}.subject`, ["kind", "id"]);
  if (![
    "composition",
    "track",
    "item",
    "link-group",
    "linked-cut",
    "transition",
    "nesting",
  ].includes(String(subject.kind))) {
    fail(
      "CUT_OTIO_PROFILE_V3_TYPE",
      `${path}.subject.kind`,
      "is not one closed editorial subject kind.",
    );
  }
  if (![
    "effect",
    "linkage",
    "metadata",
    "nesting",
    "retime",
    "timing",
    "transaction",
    "transition",
  ].includes(String(object.category))
    || !["approximated", "dropped", "metadata-required", "unsupported"]
      .includes(String(object.disposition))) {
    fail(
      "CUT_OTIO_PROFILE_V3_TYPE",
      path,
      "contains an unsupported loss category or disposition.",
    );
  }
  const result: CutOtioEditorialLoss = {
    code: boundedString(object.code, `${path}.code`),
    category: object.category as CutOtioEditorialLoss["category"],
    disposition: object.disposition as CutOtioEditorialLoss["disposition"],
    target: target.kind === "adapter"
      ? {
          kind: "adapter",
          id: boundedString(target.id, `${path}.target.id`),
        }
      : { kind: target.kind },
    subject: {
      kind: subject.kind as CutOtioEditorialLoss["subject"]["kind"],
      id: stableId(subject.id, `${path}.subject.id`),
    },
    message: boundedString(object.message, `${path}.message`),
  };
  return Object.freeze(result);
}

function parseBody(
  baseValue: unknown,
  value: unknown,
): {
  base: CutOtioEditorialProfile;
  body: CutOtioEditorialProfileV3Body;
} {
  const base = validateCutOtioEditorialProfile(baseValue);
  const object = closed(
    value,
    "$",
    [
      "format",
      "version",
      "compositionId",
      "baseProfileSemanticSha256",
      "audioOrigins",
      "losses",
    ],
  );
  if (object.format !== cutOtioEditorialProfileV3Format) {
    fail(
      "CUT_OTIO_PROFILE_V3_VERSION",
      "$.format",
      `must be ${cutOtioEditorialProfileV3Format}.`,
    );
  }
  if (object.version !== cutOtioEditorialProfileV3Version) {
    fail("CUT_OTIO_PROFILE_V3_VERSION", "$.version", "must be 3.");
  }
  const body = Object.freeze({
    format: cutOtioEditorialProfileV3Format,
    version: cutOtioEditorialProfileV3Version,
    compositionId: stableId(object.compositionId, "$.compositionId"),
    baseProfileSemanticSha256: sha256(
      object.baseProfileSemanticSha256,
      "$.baseProfileSemanticSha256",
    ),
    audioOrigins: Object.freeze(array(
      object.audioOrigins,
      "$.audioOrigins",
      cutOtioEditorialProfileV3Limits.maximumOrigins,
      1,
    ).map((entry, index) => parseOrigin(entry, `$.audioOrigins[${index}]`))),
    losses: Object.freeze(array(
      object.losses,
      "$.losses",
      100_000,
    ).map((entry, index) => parseLoss(entry, `$.losses[${index}]`))),
  });
  if (body.compositionId !== base.compositionId
    || body.baseProfileSemanticSha256 !== base.semanticSha256) {
    fail(
      "CUT_OTIO_PROFILE_V3_REFERENCE",
      "$.baseProfileSemanticSha256",
      "does not bind the supplied V2 native editorial profile and composition.",
    );
  }
  return { base, body };
}

function validateRelationships(
  base: CutOtioEditorialProfile,
  body: CutOtioEditorialProfileV3Body,
) {
  const tracks = new Map(base.tracks.map((track) => [track.id, track]));
  const items = new Map(base.tracks.flatMap((track) =>
    track.items.map((item) => [item.id, { track, item }] as const)));
  const originIds = new Set<string>(), viewItems = new Set<string>();
  let totalViews = 0, totalLineageSegments = 0;
  for (const [originIndex, origin] of body.audioOrigins.entries()) {
    const path = `$.audioOrigins[${originIndex}]`;
    if (originIds.has(origin.id)) {
      fail("CUT_OTIO_PROFILE_V3_DUPLICATE", `${path}.id`, "duplicates an origin.");
    }
    originIds.add(origin.id);
    const track = tracks.get(origin.trackId);
    if (!track || track.kind !== "Audio") {
      fail(
        "CUT_OTIO_PROFILE_V3_REFERENCE",
        `${path}.trackId`,
        "must name one Audio track from the bound V2 profile.",
      );
    }
    if (!sameRational(
      multiplyRational(origin.originDuration, origin.rate),
      origin.source.duration,
    )
      || compareRational(addRational(origin.fadeIn, origin.fadeOut), origin.originDuration) > 0) {
      fail(
        "CUT_OTIO_PROFILE_V3_TIMING",
        path,
        "originDuration multiplied by rate must equal source duration and bound origin-clock fades.",
      );
    }
    const lineageSegments = new Map<
      string,
      CutOtioEditorialAudioLineageSegment
    >();
    for (const [segmentIndex, segment] of origin.lineageSegments.entries()) {
      totalLineageSegments += 1;
      const segmentPath = `${path}.lineageSegments[${segmentIndex}]`;
      if (totalLineageSegments
        > cutOtioEditorialProfileV3Limits.maximumLineageSegments) {
        fail(
          "CUT_OTIO_PROFILE_V3_BUDGET",
          "$.audioOrigins",
          "aggregate lineage segment count exceeds the V3 ceiling.",
        );
      }
      if (lineageSegments.has(segment.segmentId)) {
        fail(
          "CUT_OTIO_PROFILE_V3_DUPLICATE",
          `${segmentPath}.segmentId`,
          "duplicates one TimelineEdit lineage segment.",
        );
      }
      const segmentTrack = tracks.get(segment.trackId);
      if (!segmentTrack || segmentTrack.kind !== "Audio") {
        fail(
          "CUT_OTIO_PROFILE_V3_REFERENCE",
          `${segmentPath}.trackId`,
          "must name one Audio track from the bound V2 profile.",
        );
      }
      if (segment.planId !== origin.timelineEditPlanId) {
        fail(
          "CUT_OTIO_PROFILE_V3_REFERENCE",
          segmentPath,
          "must belong to the exact TimelineEdit plan owned by this origin clock.",
        );
      }
      if (segment.originId !== origin.timelineEditOriginId
        && segment.parentSegmentId === undefined) {
        fail(
          "CUT_OTIO_PROFILE_V3_REFERENCE",
          `${segmentPath}.originId`,
          "a placed origin may differ from the shared authority origin only when its lineage names an authenticated parent segment.",
        );
      }
      if (segment.parentSegmentId
        && !lineageSegments.has(segment.parentSegmentId)) {
        fail(
          "CUT_OTIO_PROFILE_V3_REFERENCE",
          `${segmentPath}.parentSegmentId`,
          "must refer to an earlier segment of the same origin.",
        );
      }
      const expectedLineageSource = {
        start: addRational(
          origin.source.start,
          multiplyRational(segment.sliceOffset, origin.rate),
        ),
        duration: multiplyRational(
          segment.destination.duration,
          origin.rate,
        ),
      };
      if (!sameInterval(segment.source, expectedLineageSource)
        || compareRational(
          addRational(segment.sliceOffset, segment.destination.duration),
          origin.originDuration,
        ) > 0) {
        fail(
          "CUT_OTIO_PROFILE_V3_TIMING",
          segmentPath,
          "must preserve the exact origin-clock source mapping and stay within the authored origin duration.",
        );
      }
      lineageSegments.set(segment.segmentId, segment);
    }
    if (!origin.lineageSegments.some((segment) =>
      segment.trackId === origin.trackId
      && segment.originId === origin.timelineEditOriginId
      && segment.parentSegmentId === undefined)) {
      fail(
        "CUT_OTIO_PROFILE_V3_REFERENCE",
        `${path}.lineageSegments`,
        "must retain the source-track base segment that owns the shared origin clock.",
      );
    }
    const visibleSegmentIds = new Set<string>();
    for (const [viewIndex, view] of origin.views.entries()) {
      totalViews += 1;
      if (totalViews > cutOtioEditorialProfileV3Limits.maximumViews) {
        fail(
          "CUT_OTIO_PROFILE_V3_BUDGET",
          "$.audioOrigins",
          "aggregate view count exceeds the V3 ceiling.",
        );
      }
      const viewPath = `${path}.views[${viewIndex}]`;
      if (visibleSegmentIds.has(view.segmentId) || viewItems.has(view.itemId)) {
        fail(
          "CUT_OTIO_PROFILE_V3_DUPLICATE",
          viewPath,
          "duplicates a segment or native item view.",
        );
      }
      visibleSegmentIds.add(view.segmentId);
      viewItems.add(view.itemId);
      const owner = items.get(view.itemId);
      const lineage = lineageSegments.get(view.segmentId);
      if (!owner
        || !lineage
        || owner.track.id !== lineage.trackId
        || owner.track.kind !== "Audio"
        || owner.item.kind !== "clip") {
        fail(
          "CUT_OTIO_PROFILE_V3_REFERENCE",
          `${viewPath}.itemId`,
          "must name one clip on the exact Audio track carried by its lineage segment.",
        );
      }
      const expectedSource = {
        start: addRational(
          origin.source.start,
          multiplyRational(view.sliceOffset, origin.rate),
        ),
        duration: multiplyRational(view.destination.duration, origin.rate),
      };
      if (!sameInterval(view.source, expectedSource)
        || !sameInterval(owner.item.source, view.source)
        || !sameInterval(owner.item.destination, view.destination)
        || stableJsonStringify(owner.item.link) !== stableJsonStringify(view.link)
        || owner.item.role !== view.role
        || stableJsonStringify(owner.item.metadata ?? {})
          !== stableJsonStringify(view.metadata ?? {})) {
        fail(
          "CUT_OTIO_PROFILE_V3_RECONCILIATION",
          viewPath,
          "does not exactly match its native clip timing, role, metadata, link, and origin clock.",
        );
      }
      const expectedRetime = sameRational(origin.rate, rational(1))
        ? { kind: "identity" as const }
        : {
            kind: "constant" as const,
            direction: "forward" as const,
            rate: origin.rate,
          };
      if (stableJsonStringify(owner.item.retime)
        !== stableJsonStringify(expectedRetime)) {
        fail(
          "CUT_OTIO_PROFILE_V3_TIMING",
          `${viewPath}.itemId`,
          "origin-clock Audio views must carry the same exact constant forward retime in the native V2 profile.",
        );
      }
      if (compareRational(
        addRational(view.sliceOffset, view.destination.duration),
        origin.originDuration,
      ) > 0) {
        fail(
          "CUT_OTIO_PROFILE_V3_TIMING",
          viewPath,
          "extends past the immutable origin clock.",
        );
      }
      const expectedLinkedGroupId = lineage.linkId === undefined
        ? undefined
        : `otio_link_${createHash("sha256")
            .update(stableJsonStringify({ linkId: lineage.linkId }))
            .digest("hex")
            .slice(0, 20)}`;
      if (view.parentSegmentId !== lineage.parentSegmentId
        || !sameRational(view.sliceOffset, lineage.sliceOffset)
        || !sameInterval(view.source, lineage.source)
        || !sameInterval(view.destination, lineage.destination)
        || !sameRational(view.handles.head, lineage.handles.head)
        || !sameRational(view.handles.tail, lineage.handles.tail)
        || view.role !== lineage.role
        || stableJsonStringify(view.metadata ?? {})
          !== stableJsonStringify(lineage.metadata ?? {})
        || view.lineageSha256 !== lineage.lineageSha256
        || (lineage.linkId === undefined
          ? view.link.kind !== "unlinked"
          : view.link.kind !== "linked"
            || view.link.groupId !== expectedLinkedGroupId)) {
        fail(
          "CUT_OTIO_PROFILE_V3_RECONCILIATION",
          viewPath,
          "does not exactly match its authenticated TimelineEdit lineage segment.",
        );
      }
    }
    const requiredLineageIds = new Set<string>();
    const retainLineage = (segmentId: string): void => {
      if (requiredLineageIds.has(segmentId)) return;
      const segment = lineageSegments.get(segmentId);
      if (!segment) {
        fail(
          "CUT_OTIO_PROFILE_V3_REFERENCE",
          `${path}.lineageSegments`,
          `is missing ancestor segment ${segmentId}.`,
        );
      }
      if (segment.parentSegmentId) retainLineage(segment.parentSegmentId);
      requiredLineageIds.add(segmentId);
    };
    origin.views.forEach((view) => retainLineage(view.segmentId));
    if (requiredLineageIds.size !== lineageSegments.size) {
      fail(
        "CUT_OTIO_PROFILE_V3_REFERENCE",
        `${path}.lineageSegments`,
        "must contain only the complete ancestor closure of visible origin views.",
      );
    }
    const intersectingTransitions = base.transitions.filter((transition) =>
      origin.views.some((view) =>
        transition.outgoingItemId === view.itemId
        || transition.incomingItemId === view.itemId));
    if (intersectingTransitions.length) {
      const transitionLosses = new Set(body.losses
        .filter((loss) =>
          loss.target.kind === "cut-roundtrip"
          && loss.code === "CUT_OTIO_AUDIO_ORIGIN_TRANSITION_UNSUPPORTED")
        .map((loss) => loss.subject.id));
      for (const transition of intersectingTransitions) {
        if (!transitionLosses.has(transition.id)) {
          fail(
            "CUT_OTIO_PROFILE_V3_LOSS",
            "$.losses",
            `transition ${transition.id} intersects origin ${origin.id} without an exact CUT-roundtrip refusal.`,
          );
        }
      }
    }
    if (origin.kind === "processed-audio") {
      for (const view of origin.views) {
        const cutLosses = body.losses.filter((loss) =>
          loss.code === "CUT_OTIO_AUDIO_ORIGIN_GRAPH_RECONSTRUCTION_UNSUPPORTED"
          && loss.target.kind === "cut-roundtrip"
          && loss.subject.kind === "item"
          && loss.subject.id === view.itemId);
        const genericLosses = body.losses.filter((loss) =>
          loss.code === "CUT_OTIO_AUDIO_ORIGIN_GRAPH_METADATA_REQUIRED"
          && loss.target.kind === "generic-otio"
          && loss.subject.kind === "item"
          && loss.subject.id === view.itemId);
        if (cutLosses.length !== 1 || genericLosses.length !== 1) {
          fail(
            "CUT_OTIO_PROFILE_V3_LOSS",
            "$.losses",
            `processed origin ${origin.id} view ${view.itemId} must declare exactly one current CUT-source reconstruction refusal and one generic-OTIO graph/clock metadata loss.`,
          );
        }
      }
    }
  }
}

function projection(body: CutOtioEditorialProfileV3Body) {
  return {
    ...body,
    audioOrigins: [...body.audioOrigins]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((origin) => ({
        ...origin,
        views: [...origin.views].sort((left, right) =>
          left.itemId.localeCompare(right.itemId)),
      })),
    losses: [...body.losses].sort((left, right) =>
      stableJsonStringify(left).localeCompare(stableJsonStringify(right))),
  };
}

function semanticSha256(body: CutOtioEditorialProfileV3Body) {
  return createHash("sha256")
    .update(stableJsonStringify(projection(body)))
    .digest("hex");
}

export function createCutOtioEditorialProfileV3(
  baseValue: unknown,
  value: unknown,
): CutOtioEditorialProfileV3 {
  const { base, body } = parseBody(baseValue, value);
  validateRelationships(base, body);
  const canonical = clone(body);
  return freeze({
    ...canonical,
    semanticSha256: semanticSha256(canonical),
  });
}

export function validateCutOtioEditorialProfileV3(
  baseValue: unknown,
  value: unknown,
): CutOtioEditorialProfileV3 {
  const object = closed(
    value,
    "$",
    [
      "format",
      "version",
      "compositionId",
      "baseProfileSemanticSha256",
      "audioOrigins",
      "losses",
      "semanticSha256",
    ],
  );
  const { base, body } = parseBody(baseValue, {
    format: object.format,
    version: object.version,
    compositionId: object.compositionId,
    baseProfileSemanticSha256: object.baseProfileSemanticSha256,
    audioOrigins: object.audioOrigins,
    losses: object.losses,
  });
  validateRelationships(base, body);
  const expected = semanticSha256(body);
  if (sha256(object.semanticSha256, "$.semanticSha256") !== expected) {
    fail(
      "CUT_OTIO_PROFILE_V3_HASH",
      "$.semanticSha256",
      `does not match canonical V3 extension semantics; expected ${expected}.`,
    );
  }
  return freeze({ ...clone(body), semanticSha256: expected });
}

export function cutOtioEditorialProfileV3ObservationFromProfile(
  baseValue: unknown,
  value: unknown,
): CutOtioEditorialProfileV3Observation {
  const profile = validateCutOtioEditorialProfileV3(baseValue, value);
  return freeze(clone({
    format: cutOtioEditorialProfileV3ObservationFormat,
    version: 1 as const,
    compositionId: profile.compositionId,
    baseProfileSemanticSha256: profile.baseProfileSemanticSha256,
    audioOrigins: profile.audioOrigins,
  }));
}

function firstDifference(
  expected: unknown,
  observed: unknown,
  path = "$",
): string | null {
  if (stableJsonStringify(expected) === stableJsonStringify(observed)) return null;
  if (Array.isArray(expected) && Array.isArray(observed)) {
    if (expected.length !== observed.length) return `${path}.length`;
    for (let index = 0; index < expected.length; index += 1) {
      const difference = firstDifference(
        expected[index],
        observed[index],
        `${path}[${index}]`,
      );
      if (difference) return difference;
    }
    return path;
  }
  if (expected && observed
    && typeof expected === "object"
    && typeof observed === "object"
    && !Array.isArray(expected)
    && !Array.isArray(observed)) {
    const keys = [...new Set([
      ...Object.keys(expected as JsonRecord),
      ...Object.keys(observed as JsonRecord),
    ])].sort();
    for (const key of keys) {
      const difference = firstDifference(
        (expected as JsonRecord)[key],
        (observed as JsonRecord)[key],
        `${path}.${key}`,
      );
      if (difference) return difference;
    }
  }
  return path;
}

export function reconcileCutOtioEditorialProfileV3(
  baseValue: unknown,
  profileValue: unknown,
  observationValue: unknown,
): CutOtioEditorialProfileV3Reconciliation {
  const profile = validateCutOtioEditorialProfileV3(baseValue, profileValue);
  const observed = closed(
    observationValue,
    "$",
    [
      "format",
      "version",
      "compositionId",
      "baseProfileSemanticSha256",
      "audioOrigins",
    ],
  );
  if (observed.format !== cutOtioEditorialProfileV3ObservationFormat
    || observed.version !== 1) {
    fail(
      "CUT_OTIO_PROFILE_V3_VERSION",
      "$",
      "is not a V3 extension observation.",
    );
  }
  const expected = cutOtioEditorialProfileV3ObservationFromProfile(
    baseValue,
    profile,
  );
  const difference = firstDifference(expected, observed);
  if (difference) {
    fail(
      "CUT_OTIO_PROFILE_V3_RECONCILIATION",
      difference,
      "native OTIO origin/view metadata does not match the declared V3 extension.",
    );
  }
  return freeze({
    format: "cut-otio-editorial-profile-extension-reconciliation",
    version: 1,
    status: "pass",
    semanticSha256: profile.semanticSha256,
    baseProfileSemanticSha256: profile.baseProfileSemanticSha256,
    origins: profile.audioOrigins.length,
    views: profile.audioOrigins.reduce(
      (total, origin) => total + origin.views.length,
      0,
    ),
    lineageSegments: profile.audioOrigins.reduce(
      (total, origin) => total + origin.lineageSegments.length,
      0,
    ),
    targetScopedLosses: profile.losses.length,
  });
}
