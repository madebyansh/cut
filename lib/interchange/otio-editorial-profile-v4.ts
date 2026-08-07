import { createHash } from "node:crypto";
import { stableJsonStringify } from "../core/stable";
import {
  compareRational,
  rational,
  type Rational,
} from "../language/rational";
import {
  validateCutOtioEditorialProfile,
  type CutOtioEditorialMetadata,
  type CutOtioEditorialProfile,
} from "./otio-editorial-profile";

/**
 * V4 is a separate, optional authority beside the frozen V2 native profile
 * and the frozen V3 audio-origin extension. It binds TimelineEdit lineage and
 * item role/metadata for nested placements without changing either historical
 * format.
 */
export const cutOtioEditorialProfileV4Format =
  "cut-otio-editorial-nested-placement-extension" as const;
export const cutOtioEditorialProfileV4Version = 4 as const;
export const cutOtioEditorialProfileV4ObservationFormat =
  "cut-otio-editorial-nested-placement-observation" as const;

export const cutOtioEditorialProfileV4Limits = Object.freeze({
  maximumLineageSegments: 100_000,
  maximumPlacements: 100_000,
  maximumStringBytes: 4_096,
  maximumRationalDigits: 128,
});

export type CutOtioEditorialNestedLineageSegment = Readonly<{
  planId: string;
  trackId: string;
  originId: string;
  segmentId: string;
  parentSegmentId?: string;
  compositionId: string;
  sourceAuthorityId: string;
  placementPolicy: "structural-only" | "static-same-track-copy";
  source: Readonly<{ start: Rational; duration: Rational }>;
  destination: Readonly<{ start: Rational; duration: Rational }>;
  role?: string;
  metadata?: CutOtioEditorialMetadata;
  lineageSha256: string;
}>;

export type CutOtioEditorialNestedPlacement = Readonly<{
  itemId: string;
  trackId: string;
  segmentId: string;
  nestingInstanceId: string;
  source: Readonly<{ start: Rational; duration: Rational }>;
  destination: Readonly<{ start: Rational; duration: Rational }>;
  role?: string;
  metadata?: CutOtioEditorialMetadata;
  lineageSha256: string;
}>;

export type CutOtioEditorialProfileV4Body = Readonly<{
  format: typeof cutOtioEditorialProfileV4Format;
  version: typeof cutOtioEditorialProfileV4Version;
  compositionId: string;
  baseProfileSemanticSha256: string;
  lineageSegments: readonly CutOtioEditorialNestedLineageSegment[];
  placements: readonly CutOtioEditorialNestedPlacement[];
}>;

export type CutOtioEditorialProfileV4 =
  CutOtioEditorialProfileV4Body & Readonly<{ semanticSha256: string }>;

export type CutOtioEditorialNestedPlacementObservation = Readonly<{
  itemId: string;
  nestingInstanceId: string;
  role?: string;
  metadata?: CutOtioEditorialMetadata;
}>;

export type CutOtioEditorialProfileV4Observation = Readonly<{
  format: typeof cutOtioEditorialProfileV4ObservationFormat;
  version: 1;
  compositionId: string;
  baseProfileSemanticSha256: string;
  placements: readonly CutOtioEditorialNestedPlacementObservation[];
}>;

export type CutOtioEditorialProfileV4Reconciliation = Readonly<{
  format: "cut-otio-editorial-nested-placement-reconciliation";
  version: 1;
  status: "pass";
  semanticSha256: string;
  baseProfileSemanticSha256: string;
  lineageSegments: number;
  placements: number;
}>;

export type CutOtioEditorialProfileV4ErrorCode =
  | "CUT_OTIO_PROFILE_V4_BUDGET"
  | "CUT_OTIO_PROFILE_V4_DUPLICATE"
  | "CUT_OTIO_PROFILE_V4_HASH"
  | "CUT_OTIO_PROFILE_V4_ID"
  | "CUT_OTIO_PROFILE_V4_RATIONAL"
  | "CUT_OTIO_PROFILE_V4_RECONCILIATION"
  | "CUT_OTIO_PROFILE_V4_REFERENCE"
  | "CUT_OTIO_PROFILE_V4_TIMING"
  | "CUT_OTIO_PROFILE_V4_TYPE"
  | "CUT_OTIO_PROFILE_V4_UNKNOWN_FIELD"
  | "CUT_OTIO_PROFILE_V4_VERSION";

export class CutOtioEditorialProfileV4Error extends Error {
  constructor(
    readonly code: CutOtioEditorialProfileV4ErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(`${code} at ${path}: ${message}`);
    this.name = "CutOtioEditorialProfileV4Error";
  }
}

type JsonRecord = Record<string, unknown>;

function fail(
  code: CutOtioEditorialProfileV4ErrorCode,
  path: string,
  message: string,
): never {
  throw new CutOtioEditorialProfileV4Error(code, path, message);
}

function record(value: unknown, path: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("CUT_OTIO_PROFILE_V4_TYPE", path, "must be a plain object.");
  }
  return value as JsonRecord;
}

function closed(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  const object = record(value, path);
  const allowed = new Set([...required, ...optional]);
  for (const field of Object.keys(object)) {
    if (!allowed.has(field)) {
      fail(
        "CUT_OTIO_PROFILE_V4_UNKNOWN_FIELD",
        `${path}.${field}`,
        "is not part of the closed V4 nested-placement extension.",
      );
    }
  }
  for (const field of required) {
    if (!Object.hasOwn(object, field)) {
      fail("CUT_OTIO_PROFILE_V4_TYPE", `${path}.${field}`, "is required.");
    }
  }
  return object;
}

function array(
  value: unknown,
  path: string,
  maximum: number,
  minimum = 0,
) {
  if (!Array.isArray(value)) {
    fail("CUT_OTIO_PROFILE_V4_TYPE", path, "must be an array.");
  }
  if (value.length < minimum || value.length > maximum) {
    fail(
      "CUT_OTIO_PROFILE_V4_BUDGET",
      path,
      `must contain ${minimum}..${maximum} entries.`,
    );
  }
  return value;
}

const idPattern = /^[A-Za-z_][A-Za-z0-9._:-]{0,127}$/u;
const authorityPattern = /^(?:[a-f0-9]{64}|[A-Za-z_][A-Za-z0-9._:-]{0,127})$/u;
const shaPattern = /^[a-f0-9]{64}$/u;
const pictureRoles = new Set([
  "primary", "b-roll", "overlay", "graphics", "captions", "reference", "custom",
]);
const metadataKeyPattern =
  /^(?![Cc][Uu][Tt]\.)(?:[A-Za-z][A-Za-z0-9_-]*\.)+[A-Za-z][A-Za-z0-9_-]*$/u;

function boundedString(value: unknown, path: string) {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > cutOtioEditorialProfileV4Limits.maximumStringBytes
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("CUT_OTIO_PROFILE_V4_TYPE", path, "must be one bounded non-control string.");
  }
  return value;
}

function role(value: unknown, path: string) {
  const result = boundedString(value, path);
  if (!pictureRoles.has(result)) {
    fail("CUT_OTIO_PROFILE_V4_TYPE", path, "must be one closed picture role.");
  }
  return result;
}

function stableId(value: unknown, path: string) {
  const result = boundedString(value, path);
  if (!idPattern.test(result)) {
    fail("CUT_OTIO_PROFILE_V4_ID", path, "must be one stable CUT identity.");
  }
  return result;
}

function authorityId(value: unknown, path: string) {
  const result = boundedString(value, path);
  if (!authorityPattern.test(result)) {
    fail("CUT_OTIO_PROFILE_V4_ID", path, "must be one authority identity.");
  }
  return result;
}

function sha256(value: unknown, path: string) {
  if (typeof value !== "string" || !shaPattern.test(value)) {
    fail("CUT_OTIO_PROFILE_V4_TYPE", path, "must be one lowercase SHA-256.");
  }
  return value;
}

function exactRational(
  value: unknown,
  path: string,
  requirement: "non-negative" | "positive" = "non-negative",
) {
  const object = closed(value, path, ["numerator", "denominator"]);
  if (typeof object.numerator !== "string"
    || typeof object.denominator !== "string"
    || object.numerator.length
      > cutOtioEditorialProfileV4Limits.maximumRationalDigits
    || object.denominator.length
      > cutOtioEditorialProfileV4Limits.maximumRationalDigits
    || !/^-?(?:0|[1-9][0-9]*)$/u.test(object.numerator)
    || !/^[1-9][0-9]*$/u.test(object.denominator)) {
    fail("CUT_OTIO_PROFILE_V4_RATIONAL", path, "must be one bounded rational.");
  }
  const result = rational(BigInt(object.numerator), BigInt(object.denominator));
  if (result.numerator !== object.numerator
    || result.denominator !== object.denominator) {
    fail("CUT_OTIO_PROFILE_V4_RATIONAL", path, "must be reduced canonically.");
  }
  const sign = compareRational(result, rational(0));
  if ((requirement === "positive" && sign <= 0)
    || (requirement === "non-negative" && sign < 0)) {
    fail(
      "CUT_OTIO_PROFILE_V4_RATIONAL",
      path,
      `must be ${requirement}.`,
    );
  }
  return result;
}

function interval(value: unknown, path: string) {
  const object = closed(value, path, ["start", "duration"]);
  return Object.freeze({
    start: exactRational(object.start, `${path}.start`),
    duration: exactRational(object.duration, `${path}.duration`, "positive"),
  });
}

function metadata(value: unknown, path: string) {
  const object = record(value, path);
  const entries = Object.entries(object);
  if (!entries.length || entries.length > 64) {
    fail("CUT_OTIO_PROFILE_V4_BUDGET", path, "must contain 1..64 entries.");
  }
  const result: Record<string, string> = {};
  let bytes = 0;
  for (const [key, raw] of entries) {
    if (key.length > 128 || !metadataKeyPattern.test(key)) {
      fail("CUT_OTIO_PROFILE_V4_TYPE", `${path}.${key}`, "has an invalid namespaced key.");
    }
    if (typeof raw !== "string"
      || raw.length > 1_024
      || /[\u0000-\u001f\u007f]/u.test(raw)) {
      fail(
        "CUT_OTIO_PROFILE_V4_TYPE",
        `${path}.${key}`,
        "must be a printable String of at most 1024 characters.",
      );
    }
    bytes += Buffer.byteLength(key, "utf8") + Buffer.byteLength(raw, "utf8");
    if (bytes > 16_384) {
      fail("CUT_OTIO_PROFILE_V4_BUDGET", path, "exceeds the 16384-byte metadata ceiling.");
    }
    result[key] = raw;
  }
  return Object.freeze(result);
}

function parseLineage(
  value: unknown,
  path: string,
): CutOtioEditorialNestedLineageSegment {
  const object = closed(
    value,
    path,
    [
      "planId", "trackId", "originId", "segmentId", "compositionId",
      "sourceAuthorityId", "placementPolicy", "source", "destination",
      "lineageSha256",
    ],
    ["parentSegmentId", "role", "metadata"],
  );
  return Object.freeze({
    planId: stableId(object.planId, `${path}.planId`),
    trackId: stableId(object.trackId, `${path}.trackId`),
    originId: stableId(object.originId, `${path}.originId`),
    segmentId: stableId(object.segmentId, `${path}.segmentId`),
    ...(object.parentSegmentId === undefined
      ? {}
      : { parentSegmentId: stableId(object.parentSegmentId, `${path}.parentSegmentId`) }),
    compositionId: stableId(object.compositionId, `${path}.compositionId`),
    sourceAuthorityId: authorityId(
      object.sourceAuthorityId,
      `${path}.sourceAuthorityId`,
    ),
    placementPolicy: (() => {
      if (object.placementPolicy !== "structural-only"
        && object.placementPolicy !== "static-same-track-copy") {
        fail(
          "CUT_OTIO_PROFILE_V4_TYPE",
          `${path}.placementPolicy`,
          "must be structural-only or static-same-track-copy.",
        );
      }
      return object.placementPolicy;
    })(),
    source: interval(object.source, `${path}.source`),
    destination: interval(object.destination, `${path}.destination`),
    ...(object.role === undefined
      ? {}
      : { role: role(object.role, `${path}.role`) }),
    ...(object.metadata === undefined
      ? {}
      : { metadata: metadata(object.metadata, `${path}.metadata`) }),
    lineageSha256: sha256(object.lineageSha256, `${path}.lineageSha256`),
  });
}

function parsePlacement(
  value: unknown,
  path: string,
): CutOtioEditorialNestedPlacement {
  const object = closed(
    value,
    path,
    [
      "itemId", "trackId", "segmentId", "nestingInstanceId", "source",
      "destination", "lineageSha256",
    ],
    ["role", "metadata"],
  );
  return Object.freeze({
    itemId: stableId(object.itemId, `${path}.itemId`),
    trackId: stableId(object.trackId, `${path}.trackId`),
    segmentId: stableId(object.segmentId, `${path}.segmentId`),
    nestingInstanceId: stableId(
      object.nestingInstanceId,
      `${path}.nestingInstanceId`,
    ),
    source: interval(object.source, `${path}.source`),
    destination: interval(object.destination, `${path}.destination`),
    ...(object.role === undefined
      ? {}
      : { role: role(object.role, `${path}.role`) }),
    ...(object.metadata === undefined
      ? {}
      : { metadata: metadata(object.metadata, `${path}.metadata`) }),
    lineageSha256: sha256(object.lineageSha256, `${path}.lineageSha256`),
  });
}

export function cutOtioEditorialNestedLineageSha256(
  value: Omit<CutOtioEditorialNestedLineageSegment, "lineageSha256">,
) {
  return createHash("sha256").update(stableJsonStringify({
    planId: value.planId,
    trackId: value.trackId,
    originId: value.originId,
    segmentId: value.segmentId,
    parentSegmentId: value.parentSegmentId ?? null,
    compositionId: value.compositionId,
    sourceAuthorityId: value.sourceAuthorityId,
    placementPolicy: value.placementPolicy,
    source: value.source,
    destination: value.destination,
    role: value.role ?? null,
    metadata: value.metadata ?? {},
  })).digest("hex");
}

function sameInterval(
  left: Readonly<{ start: Rational; duration: Rational }>,
  right: Readonly<{ start: Rational; duration: Rational }>,
) {
  return compareRational(left.start, right.start) === 0
    && compareRational(left.duration, right.duration) === 0;
}

function validateRelationships(
  base: CutOtioEditorialProfile,
  body: CutOtioEditorialProfileV4Body,
) {
  if (body.compositionId !== base.compositionId
    || body.baseProfileSemanticSha256 !== base.semanticSha256) {
    fail(
      "CUT_OTIO_PROFILE_V4_REFERENCE",
      "$.baseProfileSemanticSha256",
      "must bind the exact V2 profile and composition.",
    );
  }
  const nestedItems = new Map<string, {
    trackId: string;
    item: Extract<CutOtioEditorialProfile["tracks"][number]["items"][number], {
      kind: "nested-sequence";
    }>;
  }>();
  for (const track of base.tracks) {
    for (const item of track.items) {
      if (item.kind === "nested-sequence") {
        nestedItems.set(item.id, { trackId: track.id, item });
      }
    }
  }

  const lineages = new Map<string, CutOtioEditorialNestedLineageSegment>();
  for (const [index, segment] of body.lineageSegments.entries()) {
    const path = `$.lineageSegments[${index}]`;
    if (lineages.has(segment.segmentId)) {
      fail("CUT_OTIO_PROFILE_V4_DUPLICATE", `${path}.segmentId`, "duplicates a lineage segment.");
    }
    const expectedSha = cutOtioEditorialNestedLineageSha256(segment);
    if (segment.lineageSha256 !== expectedSha) {
      fail("CUT_OTIO_PROFILE_V4_HASH", `${path}.lineageSha256`, `expected ${expectedSha}.`);
    }
    if (segment.parentSegmentId) {
      const parent = lineages.get(segment.parentSegmentId);
      if (!parent) {
        fail(
          "CUT_OTIO_PROFILE_V4_REFERENCE",
          `${path}.parentSegmentId`,
          "must name one earlier lineage segment.",
        );
      }
      if (parent.planId !== segment.planId
        || parent.trackId !== segment.trackId
        || parent.compositionId !== segment.compositionId
        || parent.sourceAuthorityId !== segment.sourceAuthorityId) {
        fail(
          "CUT_OTIO_PROFILE_V4_REFERENCE",
          `${path}.parentSegmentId`,
          "must retain the same plan, track, composition, and source authority.",
        );
      }
    }
    lineages.set(segment.segmentId, segment);
  }

  const placementItems = new Set<string>();
  const visibleSegments = new Set<string>();
  for (const [index, placement] of body.placements.entries()) {
    const path = `$.placements[${index}]`;
    if (placementItems.has(placement.itemId)
      || visibleSegments.has(placement.segmentId)) {
      fail(
        "CUT_OTIO_PROFILE_V4_DUPLICATE",
        path,
        "duplicates a native item or visible segment.",
      );
    }
    placementItems.add(placement.itemId);
    visibleSegments.add(placement.segmentId);
    const owner = nestedItems.get(placement.itemId);
    const lineage = lineages.get(placement.segmentId);
    if (!owner
      || owner.trackId !== placement.trackId
      || owner.item.nesting.instanceId !== placement.nestingInstanceId) {
      fail(
        "CUT_OTIO_PROFILE_V4_REFERENCE",
        path,
        "must name one nested item and its exact native instance.",
      );
    }
    if (!lineage
      || lineage.trackId !== placement.trackId
      || placement.lineageSha256 !== lineage.lineageSha256
      || !sameInterval(placement.source, owner.item.source)
      || !sameInterval(placement.destination, owner.item.destination)
      || !sameInterval(placement.source, lineage.source)
      || !sameInterval(placement.destination, lineage.destination)
      || placement.role !== lineage.role
      || stableJsonStringify(placement.metadata ?? {})
        !== stableJsonStringify(lineage.metadata ?? {})) {
      fail(
        "CUT_OTIO_PROFILE_V4_RECONCILIATION",
        path,
        "does not exactly match native timing and authenticated TimelineEdit lineage.",
      );
    }
  }
  const required = new Set<string>();
  const retain = (segmentId: string): void => {
    if (required.has(segmentId)) return;
    const segment = lineages.get(segmentId);
    if (!segment) {
      fail("CUT_OTIO_PROFILE_V4_REFERENCE", "$.lineageSegments", `is missing ${segmentId}.`);
    }
    if (segment.parentSegmentId) retain(segment.parentSegmentId);
    required.add(segmentId);
  };
  visibleSegments.forEach(retain);
  if (required.size !== lineages.size) {
    fail(
      "CUT_OTIO_PROFILE_V4_REFERENCE",
      "$.lineageSegments",
      "must contain only the complete ancestor closure of visible placements.",
    );
  }
}

function parseBody(
  baseValue: unknown,
  value: unknown,
): { base: CutOtioEditorialProfile; body: CutOtioEditorialProfileV4Body } {
  const base = validateCutOtioEditorialProfile(baseValue);
  const object = closed(value, "$", [
    "format", "version", "compositionId", "baseProfileSemanticSha256",
    "lineageSegments", "placements",
  ]);
  if (object.format !== cutOtioEditorialProfileV4Format
    || object.version !== cutOtioEditorialProfileV4Version) {
    fail("CUT_OTIO_PROFILE_V4_VERSION", "$", "must be the V4 nested-placement extension.");
  }
  const body: CutOtioEditorialProfileV4Body = Object.freeze({
    format: cutOtioEditorialProfileV4Format,
    version: cutOtioEditorialProfileV4Version,
    compositionId: stableId(object.compositionId, "$.compositionId"),
    baseProfileSemanticSha256: sha256(
      object.baseProfileSemanticSha256,
      "$.baseProfileSemanticSha256",
    ),
    lineageSegments: Object.freeze(array(
      object.lineageSegments,
      "$.lineageSegments",
      cutOtioEditorialProfileV4Limits.maximumLineageSegments,
      1,
    ).map((entry, index) => parseLineage(entry, `$.lineageSegments[${index}]`))),
    placements: Object.freeze(array(
      object.placements,
      "$.placements",
      cutOtioEditorialProfileV4Limits.maximumPlacements,
      1,
    ).map((entry, index) => parsePlacement(entry, `$.placements[${index}]`))),
  });
  validateRelationships(base, body);
  return { base, body };
}

function semanticSha256(body: CutOtioEditorialProfileV4Body) {
  return createHash("sha256").update(stableJsonStringify(body)).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
  }
  return value;
}

function clone<T>(value: T): T {
  return JSON.parse(stableJsonStringify(value)) as T;
}

export function createCutOtioEditorialProfileV4(
  baseValue: unknown,
  bodyValue: unknown,
): CutOtioEditorialProfileV4 {
  const { body } = parseBody(baseValue, bodyValue);
  return deepFreeze({ ...clone(body), semanticSha256: semanticSha256(body) });
}

export function validateCutOtioEditorialProfileV4(
  baseValue: unknown,
  value: unknown,
): CutOtioEditorialProfileV4 {
  const object = closed(value, "$", [
    "format", "version", "compositionId", "baseProfileSemanticSha256",
    "lineageSegments", "placements", "semanticSha256",
  ]);
  const { body } = parseBody(baseValue, {
    format: object.format,
    version: object.version,
    compositionId: object.compositionId,
    baseProfileSemanticSha256: object.baseProfileSemanticSha256,
    lineageSegments: object.lineageSegments,
    placements: object.placements,
  });
  const observed = sha256(object.semanticSha256, "$.semanticSha256");
  const expected = semanticSha256(body);
  if (observed !== expected) {
    fail("CUT_OTIO_PROFILE_V4_HASH", "$.semanticSha256", `expected ${expected}.`);
  }
  return deepFreeze({ ...clone(body), semanticSha256: observed });
}

export function cutOtioEditorialProfileV4ObservationFromProfile(
  baseValue: unknown,
  profileValue: unknown,
): CutOtioEditorialProfileV4Observation {
  const profile = validateCutOtioEditorialProfileV4(baseValue, profileValue);
  return deepFreeze({
    format: cutOtioEditorialProfileV4ObservationFormat,
    version: 1,
    compositionId: profile.compositionId,
    baseProfileSemanticSha256: profile.baseProfileSemanticSha256,
    placements: profile.placements.map((placement) => ({
      itemId: placement.itemId,
      nestingInstanceId: placement.nestingInstanceId,
      ...(placement.role === undefined ? {} : { role: placement.role }),
      ...(placement.metadata === undefined ? {} : { metadata: placement.metadata }),
    })),
  });
}

function parseObservation(
  value: unknown,
): CutOtioEditorialProfileV4Observation {
  const object = closed(value, "$", [
    "format", "version", "compositionId", "baseProfileSemanticSha256",
    "placements",
  ]);
  if (object.format !== cutOtioEditorialProfileV4ObservationFormat
    || object.version !== 1) {
    fail("CUT_OTIO_PROFILE_V4_VERSION", "$", "must be one V4 native observation.");
  }
  return deepFreeze({
    format: cutOtioEditorialProfileV4ObservationFormat,
    version: 1,
    compositionId: stableId(object.compositionId, "$.compositionId"),
    baseProfileSemanticSha256: sha256(
      object.baseProfileSemanticSha256,
      "$.baseProfileSemanticSha256",
    ),
    placements: array(
      object.placements,
      "$.placements",
      cutOtioEditorialProfileV4Limits.maximumPlacements,
      1,
    ).map((value, index) => {
      const path = `$.placements[${index}]`;
      const placement = closed(
        value,
        path,
        ["itemId", "nestingInstanceId"],
        ["role", "metadata"],
      );
      return {
        itemId: stableId(placement.itemId, `${path}.itemId`),
        nestingInstanceId: stableId(
          placement.nestingInstanceId,
          `${path}.nestingInstanceId`,
        ),
        ...(placement.role === undefined
          ? {}
          : { role: role(placement.role, `${path}.role`) }),
        ...(placement.metadata === undefined
          ? {}
          : { metadata: metadata(placement.metadata, `${path}.metadata`) }),
      };
    }),
  });
}

export function reconcileCutOtioEditorialProfileV4(
  baseValue: unknown,
  profileValue: unknown,
  observationValue: unknown,
): CutOtioEditorialProfileV4Reconciliation {
  const profile = validateCutOtioEditorialProfileV4(baseValue, profileValue);
  const observation = parseObservation(observationValue);
  const expected = cutOtioEditorialProfileV4ObservationFromProfile(
    baseValue,
    profile,
  );
  if (stableJsonStringify(observation) !== stableJsonStringify(expected)) {
    fail(
      "CUT_OTIO_PROFILE_V4_RECONCILIATION",
      "$.placements",
      "native nested-placement role/metadata does not match the V4 authority.",
    );
  }
  return deepFreeze({
    format: "cut-otio-editorial-nested-placement-reconciliation",
    version: 1,
    status: "pass",
    semanticSha256: profile.semanticSha256,
    baseProfileSemanticSha256: profile.baseProfileSemanticSha256,
    lineageSegments: profile.lineageSegments.length,
    placements: profile.placements.length,
  });
}
