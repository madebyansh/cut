import { createHash } from "node:crypto";
import { stableJsonStringify } from "../core/stable";
import {
  addRational,
  compareRational,
  rational,
  subtractRational,
  type Rational,
  zeroRational,
} from "../language/rational";
import {
  validateCutOtioEditorialProfile,
  type CutOtioEditorialLink,
  type CutOtioEditorialMetadata,
  type CutOtioEditorialProfile,
  type CutOtioEditorialRetime,
} from "./otio-editorial-profile";

/**
 * V5 is an optional authority beside the frozen V2/V3/V4 formats. It closes
 * direct PictureClip/AudioClip source availability and selected-stream clock
 * identity. It deliberately does not describe processor graphs, nesting, or
 * transcript reconstruction.
 */
export const cutOtioEditorialProfileV5Format =
  "cut-otio-editorial-direct-media-extension" as const;
export const cutOtioEditorialProfileV5Version = 5 as const;
export const cutOtioEditorialProfileV5ObservationFormat =
  "cut-otio-editorial-direct-media-observation" as const;

export const cutOtioEditorialProfileV5Limits = Object.freeze({
  maximumAuthorities: 100_000,
  maximumStringBytes: 4_096,
  maximumRationalDigits: 128,
});

export type CutOtioDirectMediaClock = Readonly<{
  kind: "frame" | "sample";
  streamIndex: number;
  timeBase: Rational;
  rate: Rational;
}>;

export type CutOtioDirectMediaAuthorityBody = Readonly<{
  authorityId: string;
  itemId: string;
  trackId: string;
  mediaKind: "picture" | "audio";
  execution: "direct-media-no-processor-graph";
  resource: Readonly<{
    id: string;
    kind: "video" | "audio";
    sha256: string;
  }>;
  clock: CutOtioDirectMediaClock;
  source: Readonly<{ start: Rational; duration: Rational }>;
  availableSource: Readonly<{ start: Rational; duration: Rational }>;
  destination: Readonly<{ start: Rational; duration: Rational }>;
  declaredHandles: Readonly<{ head: Rational; tail: Rational }>;
  consumedHandles: Readonly<{ head: Rational; tail: Rational }>;
  retime: CutOtioEditorialRetime;
  link: CutOtioEditorialLink;
  role?: string;
  metadata?: CutOtioEditorialMetadata;
  linkedCutIds: readonly string[];
  transitionIds: readonly string[];
}>;

export type CutOtioDirectMediaAuthority =
  CutOtioDirectMediaAuthorityBody & Readonly<{ authoritySha256: string }>;

export type CutOtioEditorialProfileV5Body = Readonly<{
  format: typeof cutOtioEditorialProfileV5Format;
  version: typeof cutOtioEditorialProfileV5Version;
  compositionId: string;
  baseProfileSemanticSha256: string;
  authorities: readonly CutOtioDirectMediaAuthority[];
}>;

export type CutOtioEditorialProfileV5 =
  CutOtioEditorialProfileV5Body & Readonly<{ semanticSha256: string }>;

export type CutOtioEditorialProfileV5Observation = Readonly<{
  format: typeof cutOtioEditorialProfileV5ObservationFormat;
  version: 1;
  compositionId: string;
  baseProfileSemanticSha256: string;
  authorities: readonly CutOtioDirectMediaAuthority[];
}>;

export type CutOtioEditorialProfileV5Reconciliation = Readonly<{
  format: "cut-otio-editorial-direct-media-reconciliation";
  version: 1;
  status: "pass";
  semanticSha256: string;
  baseProfileSemanticSha256: string;
  authorities: number;
}>;

export type CutOtioEditorialProfileV5ErrorCode =
  | "CUT_OTIO_PROFILE_V5_BUDGET"
  | "CUT_OTIO_PROFILE_V5_DUPLICATE"
  | "CUT_OTIO_PROFILE_V5_HASH"
  | "CUT_OTIO_PROFILE_V5_ID"
  | "CUT_OTIO_PROFILE_V5_RATIONAL"
  | "CUT_OTIO_PROFILE_V5_RECONCILIATION"
  | "CUT_OTIO_PROFILE_V5_REFERENCE"
  | "CUT_OTIO_PROFILE_V5_TIMING"
  | "CUT_OTIO_PROFILE_V5_TYPE"
  | "CUT_OTIO_PROFILE_V5_UNKNOWN_FIELD"
  | "CUT_OTIO_PROFILE_V5_VERSION";

export class CutOtioEditorialProfileV5Error extends Error {
  constructor(
    readonly code: CutOtioEditorialProfileV5ErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(`${code} at ${path}: ${message}`);
    this.name = "CutOtioEditorialProfileV5Error";
  }
}

type JsonRecord = Record<string, unknown>;

function fail(
  code: CutOtioEditorialProfileV5ErrorCode,
  path: string,
  message: string,
): never {
  throw new CutOtioEditorialProfileV5Error(code, path, message);
}

function record(value: unknown, path: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("CUT_OTIO_PROFILE_V5_TYPE", path, "must be a plain object.");
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
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      fail(
        "CUT_OTIO_PROFILE_V5_UNKNOWN_FIELD",
        `${path}.${key}`,
        "is outside the closed V5 direct-media authority.",
      );
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(object, key)) {
      fail("CUT_OTIO_PROFILE_V5_TYPE", `${path}.${key}`, "is required.");
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
    fail("CUT_OTIO_PROFILE_V5_TYPE", path, "must be an array.");
  }
  if (value.length < minimum || value.length > maximum) {
    fail(
      "CUT_OTIO_PROFILE_V5_BUDGET",
      path,
      `must contain ${minimum}..${maximum} entries.`,
    );
  }
  return value;
}

const stableIdPattern = /^[A-Za-z_][A-Za-z0-9._:-]{0,127}$/u;
const authorityIdPattern = /^otio_direct_media_[a-f0-9]{24}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const metadataKeyPattern =
  /^(?![Cc][Uu][Tt]\.)(?:[A-Za-z][A-Za-z0-9_-]*\.)+[A-Za-z][A-Za-z0-9_-]*$/u;

function boundedString(value: unknown, path: string) {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > cutOtioEditorialProfileV5Limits.maximumStringBytes
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(
      "CUT_OTIO_PROFILE_V5_TYPE",
      path,
      "must be one bounded non-control string.",
    );
  }
  return value;
}

function stableId(value: unknown, path: string) {
  const result = boundedString(value, path);
  if (!stableIdPattern.test(result)) {
    fail("CUT_OTIO_PROFILE_V5_ID", path, "must be one stable CUT identity.");
  }
  return result;
}

function authorityId(value: unknown, path: string) {
  const result = boundedString(value, path);
  if (!authorityIdPattern.test(result)) {
    fail(
      "CUT_OTIO_PROFILE_V5_ID",
      path,
      "must be one derived V5 direct-media authority identity.",
    );
  }
  return result;
}

function sha256(value: unknown, path: string) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail(
      "CUT_OTIO_PROFILE_V5_TYPE",
      path,
      "must be one lowercase SHA-256.",
    );
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
      > cutOtioEditorialProfileV5Limits.maximumRationalDigits
    || object.denominator.length
      > cutOtioEditorialProfileV5Limits.maximumRationalDigits
    || !/^-?(?:0|[1-9][0-9]*)$/u.test(object.numerator)
    || !/^[1-9][0-9]*$/u.test(object.denominator)) {
    fail(
      "CUT_OTIO_PROFILE_V5_RATIONAL",
      path,
      "must be one bounded exact rational.",
    );
  }
  const result = rational(
    BigInt(object.numerator),
    BigInt(object.denominator),
  );
  if (result.numerator !== object.numerator
    || result.denominator !== object.denominator) {
    fail(
      "CUT_OTIO_PROFILE_V5_RATIONAL",
      path,
      "must be reduced canonically.",
    );
  }
  const sign = compareRational(result, zeroRational);
  if ((requirement === "positive" && sign <= 0)
    || (requirement === "non-negative" && sign < 0)) {
    fail(
      "CUT_OTIO_PROFILE_V5_RATIONAL",
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

function handles(value: unknown, path: string) {
  const object = closed(value, path, ["head", "tail"]);
  return Object.freeze({
    head: exactRational(object.head, `${path}.head`),
    tail: exactRational(object.tail, `${path}.tail`),
  });
}

function metadata(value: unknown, path: string) {
  const object = record(value, path);
  const entries = Object.entries(object);
  if (!entries.length || entries.length > 64) {
    fail("CUT_OTIO_PROFILE_V5_BUDGET", path, "must contain 1..64 entries.");
  }
  const result: Record<string, string> = {};
  let totalBytes = 0;
  for (const [key, raw] of entries) {
    if (!metadataKeyPattern.test(key) || key.length > 128) {
      fail(
        "CUT_OTIO_PROFILE_V5_TYPE",
        `${path}.${key}`,
        "must use one non-CUT namespaced key.",
      );
    }
    if (typeof raw !== "string"
      || raw.length > 1_024
      || /[\u0000-\u001f\u007f]/u.test(raw)) {
      fail(
        "CUT_OTIO_PROFILE_V5_TYPE",
        `${path}.${key}`,
        "must be a printable String of at most 1024 characters.",
      );
    }
    totalBytes += Buffer.byteLength(key, "utf8")
      + Buffer.byteLength(raw, "utf8");
    if (totalBytes > 16_384) {
      fail(
        "CUT_OTIO_PROFILE_V5_BUDGET",
        path,
        "exceeds the 16384-byte metadata ceiling.",
      );
    }
    result[key] = raw;
  }
  return Object.freeze(result);
}

function parseLink(value: unknown, path: string): CutOtioEditorialLink {
  const object = record(value, path);
  if (object.kind === "unlinked") {
    closed(value, path, ["kind"]);
    return Object.freeze({ kind: "unlinked" });
  }
  const linked = closed(value, path, ["kind", "groupId", "segmentId"]);
  if (linked.kind !== "linked") {
    fail(
      "CUT_OTIO_PROFILE_V5_TYPE",
      `${path}.kind`,
      "must be linked or unlinked.",
    );
  }
  return Object.freeze({
    kind: "linked",
    groupId: stableId(linked.groupId, `${path}.groupId`),
    segmentId: stableId(linked.segmentId, `${path}.segmentId`),
  });
}

function parseRetime(value: unknown, path: string): CutOtioEditorialRetime {
  const object = record(value, path);
  if (object.kind === "identity") {
    closed(value, path, ["kind"]);
    return Object.freeze({ kind: "identity" });
  }
  const constant = closed(value, path, ["kind", "direction", "rate"]);
  if (constant.kind !== "constant"
    || (constant.direction !== "forward"
      && constant.direction !== "reverse")) {
    fail(
      "CUT_OTIO_PROFILE_V5_TYPE",
      path,
      "must be identity or one forward/reverse constant retime.",
    );
  }
  return Object.freeze({
    kind: "constant",
    direction: constant.direction,
    rate: exactRational(constant.rate, `${path}.rate`, "positive"),
  });
}

function parseStringIds(value: unknown, path: string) {
  const values = array(value, path, 100_000);
  const result = values.map((entry, index) =>
    stableId(entry, `${path}[${index}]`));
  const sorted = [...result].sort((left, right) => left.localeCompare(right));
  if (new Set(result).size !== result.length
    || stableJsonStringify(result) !== stableJsonStringify(sorted)) {
    fail(
      "CUT_OTIO_PROFILE_V5_DUPLICATE",
      path,
      "must be unique and sorted canonically.",
    );
  }
  return Object.freeze(result);
}

function parseAuthority(
  value: unknown,
  path: string,
): CutOtioDirectMediaAuthority {
  const object = closed(
    value,
    path,
    [
      "authorityId", "itemId", "trackId", "mediaKind", "execution",
      "resource", "clock", "source", "availableSource", "destination",
      "declaredHandles", "consumedHandles", "retime", "link",
      "linkedCutIds", "transitionIds", "authoritySha256",
    ],
    ["role", "metadata"],
  );
  if (object.mediaKind !== "picture" && object.mediaKind !== "audio") {
    fail(
      "CUT_OTIO_PROFILE_V5_TYPE",
      `${path}.mediaKind`,
      "must be picture or audio.",
    );
  }
  if (object.execution !== "direct-media-no-processor-graph") {
    fail(
      "CUT_OTIO_PROFILE_V5_TYPE",
      `${path}.execution`,
      "must explicitly exclude processor-graph reconstruction.",
    );
  }
  const resourceObject = closed(
    object.resource,
    `${path}.resource`,
    ["id", "kind", "sha256"],
  );
  if (resourceObject.kind !== "video" && resourceObject.kind !== "audio") {
    fail(
      "CUT_OTIO_PROFILE_V5_TYPE",
      `${path}.resource.kind`,
      "must be video or audio.",
    );
  }
  const clockObject = closed(
    object.clock,
    `${path}.clock`,
    ["kind", "streamIndex", "timeBase", "rate"],
  );
  if (clockObject.kind !== "frame" && clockObject.kind !== "sample") {
    fail(
      "CUT_OTIO_PROFILE_V5_TYPE",
      `${path}.clock.kind`,
      "must be frame or sample.",
    );
  }
  if (!Number.isSafeInteger(clockObject.streamIndex)
    || Number(clockObject.streamIndex) < 0) {
    fail(
      "CUT_OTIO_PROFILE_V5_TYPE",
      `${path}.clock.streamIndex`,
      "must be one non-negative safe stream index.",
    );
  }
  const body: CutOtioDirectMediaAuthorityBody = Object.freeze({
    authorityId: authorityId(object.authorityId, `${path}.authorityId`),
    itemId: stableId(object.itemId, `${path}.itemId`),
    trackId: stableId(object.trackId, `${path}.trackId`),
    mediaKind: object.mediaKind,
    execution: "direct-media-no-processor-graph",
    resource: Object.freeze({
      id: stableId(resourceObject.id, `${path}.resource.id`),
      kind: resourceObject.kind,
      sha256: sha256(resourceObject.sha256, `${path}.resource.sha256`),
    }),
    clock: Object.freeze({
      kind: clockObject.kind,
      streamIndex: Number(clockObject.streamIndex),
      timeBase: exactRational(
        clockObject.timeBase,
        `${path}.clock.timeBase`,
        "positive",
      ),
      rate: exactRational(
        clockObject.rate,
        `${path}.clock.rate`,
        "positive",
      ),
    }),
    source: interval(object.source, `${path}.source`),
    availableSource: interval(
      object.availableSource,
      `${path}.availableSource`,
    ),
    destination: interval(object.destination, `${path}.destination`),
    declaredHandles: handles(
      object.declaredHandles,
      `${path}.declaredHandles`,
    ),
    consumedHandles: handles(
      object.consumedHandles,
      `${path}.consumedHandles`,
    ),
    retime: parseRetime(object.retime, `${path}.retime`),
    link: parseLink(object.link, `${path}.link`),
    ...(object.role === undefined
      ? {}
      : { role: boundedString(object.role, `${path}.role`) }),
    ...(object.metadata === undefined
      ? {}
      : { metadata: metadata(object.metadata, `${path}.metadata`) }),
    linkedCutIds: parseStringIds(
      object.linkedCutIds,
      `${path}.linkedCutIds`,
    ),
    transitionIds: parseStringIds(
      object.transitionIds,
      `${path}.transitionIds`,
    ),
  });
  const expectedAuthorityId = cutOtioDirectMediaAuthorityId(body);
  if (body.authorityId !== expectedAuthorityId) {
    fail(
      "CUT_OTIO_PROFILE_V5_HASH",
      `${path}.authorityId`,
      `expected ${expectedAuthorityId}.`,
    );
  }
  const observedSha = sha256(
    object.authoritySha256,
    `${path}.authoritySha256`,
  );
  const expectedSha = cutOtioDirectMediaAuthoritySha256(body);
  if (observedSha !== expectedSha) {
    fail(
      "CUT_OTIO_PROFILE_V5_HASH",
      `${path}.authoritySha256`,
      `expected ${expectedSha}.`,
    );
  }
  return Object.freeze({ ...body, authoritySha256: observedSha });
}

export function cutOtioDirectMediaAuthoritySha256(
  value: CutOtioDirectMediaAuthorityBody,
) {
  const { authorityId: _authorityId, ...content } = value;
  return createHash("sha256")
    .update(stableJsonStringify(content))
    .digest("hex");
}

export function cutOtioDirectMediaAuthorityId(
  value: CutOtioDirectMediaAuthorityBody,
) {
  return `otio_direct_media_${cutOtioDirectMediaAuthoritySha256(value).slice(0, 24)}`;
}

function sameInterval(
  left: Readonly<{ start: Rational; duration: Rational }>,
  right: Readonly<{ start: Rational; duration: Rational }>,
) {
  return compareRational(left.start, right.start) === 0
    && compareRational(left.duration, right.duration) === 0;
}

function intervalEnd(value: Readonly<{ start: Rational; duration: Rational }>) {
  return addRational(value.start, value.duration);
}

function maximum(left: Rational, right: Rational) {
  return compareRational(left, right) >= 0 ? left : right;
}

function expectedConsumedHandles(
  base: CutOtioEditorialProfile,
  itemId: string,
  source: Readonly<{ start: Rational; duration: Rational }>,
) {
  let head = zeroRational;
  let tail = zeroRational;
  const sourceEnd = intervalEnd(source);
  for (const transition of base.transitions) {
    if (transition.incomingItemId === itemId) {
      const incomingEnd = intervalEnd(transition.incomingSource);
      if (compareRational(incomingEnd, source.start) !== 0) {
        fail(
          "CUT_OTIO_PROFILE_V5_TIMING",
          "$.authorities",
          `transition ${transition.id} incoming handle is not adjacent to ${itemId}.`,
        );
      }
      head = maximum(head, transition.incomingSource.duration);
    }
    if (transition.outgoingItemId === itemId) {
      if (compareRational(transition.outgoingSource.start, sourceEnd) !== 0) {
        fail(
          "CUT_OTIO_PROFILE_V5_TIMING",
          "$.authorities",
          `transition ${transition.id} outgoing handle is not adjacent to ${itemId}.`,
        );
      }
      tail = maximum(tail, transition.outgoingSource.duration);
    }
  }
  return { head, tail };
}

function validateRelationships(
  base: CutOtioEditorialProfile,
  body: CutOtioEditorialProfileV5Body,
) {
  if (body.compositionId !== base.compositionId
    || body.baseProfileSemanticSha256 !== base.semanticSha256) {
    fail(
      "CUT_OTIO_PROFILE_V5_REFERENCE",
      "$.baseProfileSemanticSha256",
      "must bind the exact V2 profile and composition.",
    );
  }
  const tracks = new Map(base.tracks.map((track) => [track.id, track]));
  const itemOwners = new Map(base.tracks.flatMap((track) =>
    track.items.map((item) => [item.id, { track, item }] as const)));
  const authorityIds = new Set<string>();
  const itemIds = new Set<string>();
  for (const [index, authority] of body.authorities.entries()) {
    const path = `$.authorities[${index}]`;
    if (authorityIds.has(authority.authorityId)
      || itemIds.has(authority.itemId)) {
      fail(
        "CUT_OTIO_PROFILE_V5_DUPLICATE",
        path,
        "duplicates an authority or native item.",
      );
    }
    authorityIds.add(authority.authorityId);
    itemIds.add(authority.itemId);
    const owner = itemOwners.get(authority.itemId);
    if (!owner
      || owner.track.id !== authority.trackId
      || owner.item.kind !== "clip") {
      fail(
        "CUT_OTIO_PROFILE_V5_REFERENCE",
        path,
        "must name one direct native V2 clip item and its owning track.",
      );
    }
    const expectedMediaKind =
      owner.track.kind === "Video" ? "picture" : "audio";
    const expectedResourceKind =
      owner.track.kind === "Video" ? "video" : "audio";
    const expectedClockKind =
      owner.track.kind === "Video" ? "frame" : "sample";
    if (authority.mediaKind !== expectedMediaKind
      || authority.resource.kind !== expectedResourceKind
      || authority.clock.kind !== expectedClockKind
      || !sameInterval(authority.source, owner.item.source)
      || !sameInterval(authority.destination, owner.item.destination)
      || stableJsonStringify(authority.retime)
        !== stableJsonStringify(owner.item.retime)
      || stableJsonStringify(authority.link)
        !== stableJsonStringify(owner.item.link)
      || authority.role !== owner.item.role
      || stableJsonStringify(authority.metadata ?? {})
        !== stableJsonStringify(owner.item.metadata ?? {})) {
      fail(
        "CUT_OTIO_PROFILE_V5_RECONCILIATION",
        path,
        "does not exactly match native kind, timing, retime, link, role, or metadata.",
      );
    }
    const expectedAvailableStart = subtractRational(
      authority.source.start,
      authority.declaredHandles.head,
    );
    const expectedAvailableEnd = addRational(
      intervalEnd(authority.source),
      authority.declaredHandles.tail,
    );
    if (compareRational(expectedAvailableStart, zeroRational) < 0
      || compareRational(
        authority.availableSource.start,
        expectedAvailableStart,
      ) !== 0
      || compareRational(
        intervalEnd(authority.availableSource),
        expectedAvailableEnd,
      ) !== 0) {
      fail(
        "CUT_OTIO_PROFILE_V5_TIMING",
        `${path}.availableSource`,
        "must equal source expanded by the exact declared handles.",
      );
    }
    const expectedConsumed = expectedConsumedHandles(
      base,
      authority.itemId,
      authority.source,
    );
    if (compareRational(
      authority.consumedHandles.head,
      expectedConsumed.head,
    ) !== 0
      || compareRational(
        authority.consumedHandles.tail,
        expectedConsumed.tail,
      ) !== 0
      || compareRational(
        authority.consumedHandles.head,
        authority.declaredHandles.head,
      ) > 0
      || compareRational(
        authority.consumedHandles.tail,
        authority.declaredHandles.tail,
      ) > 0) {
      fail(
        "CUT_OTIO_PROFILE_V5_TIMING",
        `${path}.consumedHandles`,
        "must exactly match transition consumption and remain within declared availability.",
      );
    }
    if (compareRational(authority.declaredHandles.head, zeroRational) === 0
      && compareRational(authority.declaredHandles.tail, zeroRational) === 0
      && compareRational(authority.consumedHandles.head, zeroRational) === 0
      && compareRational(authority.consumedHandles.tail, zeroRational) === 0) {
      fail(
        "CUT_OTIO_PROFILE_V5_REFERENCE",
        path,
        "must not encode a no-handle item; omission is the compatibility form.",
      );
    }
    const expectedTransitionIds = base.transitions
      .filter((transition) =>
        transition.outgoingItemId === authority.itemId
        || transition.incomingItemId === authority.itemId)
      .map((transition) => transition.id)
      .sort((left, right) => left.localeCompare(right));
    const expectedLinkedCutIds = base.linkedCuts
      .filter((cut) =>
        cut.picture.outgoingItemId === authority.itemId
        || cut.picture.incomingItemId === authority.itemId
        || cut.audio.outgoingItemId === authority.itemId
        || cut.audio.incomingItemId === authority.itemId)
      .map((cut) => cut.id)
      .sort((left, right) => left.localeCompare(right));
    if (stableJsonStringify(authority.transitionIds)
        !== stableJsonStringify(expectedTransitionIds)
      || stableJsonStringify(authority.linkedCutIds)
        !== stableJsonStringify(expectedLinkedCutIds)) {
      fail(
        "CUT_OTIO_PROFILE_V5_REFERENCE",
        path,
        "must bind every and only native transition/J-L reference for the item.",
      );
    }
    if (!tracks.has(authority.trackId)) {
      fail(
        "CUT_OTIO_PROFILE_V5_REFERENCE",
        `${path}.trackId`,
        "names an orphan track.",
      );
    }
  }
}

function parseBody(
  baseValue: unknown,
  value: unknown,
): { base: CutOtioEditorialProfile; body: CutOtioEditorialProfileV5Body } {
  const base = validateCutOtioEditorialProfile(baseValue);
  const object = closed(value, "$", [
    "format", "version", "compositionId", "baseProfileSemanticSha256",
    "authorities",
  ]);
  if (object.format !== cutOtioEditorialProfileV5Format
    || object.version !== cutOtioEditorialProfileV5Version) {
    fail(
      "CUT_OTIO_PROFILE_V5_VERSION",
      "$",
      "must be the V5 direct-media extension.",
    );
  }
  const body: CutOtioEditorialProfileV5Body = Object.freeze({
    format: cutOtioEditorialProfileV5Format,
    version: cutOtioEditorialProfileV5Version,
    compositionId: stableId(object.compositionId, "$.compositionId"),
    baseProfileSemanticSha256: sha256(
      object.baseProfileSemanticSha256,
      "$.baseProfileSemanticSha256",
    ),
    authorities: Object.freeze(array(
      object.authorities,
      "$.authorities",
      cutOtioEditorialProfileV5Limits.maximumAuthorities,
      1,
    ).map((entry, index) =>
      parseAuthority(entry, `$.authorities[${index}]`))),
  });
  validateRelationships(base, body);
  return { base, body };
}

function semanticSha256(body: CutOtioEditorialProfileV5Body) {
  return createHash("sha256")
    .update(stableJsonStringify(body))
    .digest("hex");
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

export function createCutOtioDirectMediaAuthority(
  value: Omit<
    CutOtioDirectMediaAuthorityBody,
    "authorityId"
  > & Readonly<{ authorityId?: string }>,
): CutOtioDirectMediaAuthority {
  const provisional = {
    ...value,
    authorityId: value.authorityId
      ?? "otio_direct_media_000000000000000000000000",
  } as CutOtioDirectMediaAuthorityBody;
  const authorityIdValue = cutOtioDirectMediaAuthorityId(provisional);
  const body = { ...value, authorityId: authorityIdValue };
  return deepFreeze({
    ...clone(body),
    authoritySha256: cutOtioDirectMediaAuthoritySha256(body),
  });
}

export function createCutOtioEditorialProfileV5(
  baseValue: unknown,
  bodyValue: unknown,
): CutOtioEditorialProfileV5 {
  const { body } = parseBody(baseValue, bodyValue);
  return deepFreeze({
    ...clone(body),
    semanticSha256: semanticSha256(body),
  });
}

export function validateCutOtioEditorialProfileV5(
  baseValue: unknown,
  value: unknown,
): CutOtioEditorialProfileV5 {
  const object = closed(value, "$", [
    "format", "version", "compositionId", "baseProfileSemanticSha256",
    "authorities", "semanticSha256",
  ]);
  const { body } = parseBody(baseValue, {
    format: object.format,
    version: object.version,
    compositionId: object.compositionId,
    baseProfileSemanticSha256: object.baseProfileSemanticSha256,
    authorities: object.authorities,
  });
  const observed = sha256(object.semanticSha256, "$.semanticSha256");
  const expected = semanticSha256(body);
  if (observed !== expected) {
    fail(
      "CUT_OTIO_PROFILE_V5_HASH",
      "$.semanticSha256",
      `expected ${expected}.`,
    );
  }
  return deepFreeze({ ...clone(body), semanticSha256: observed });
}

export function cutOtioEditorialProfileV5ObservationFromProfile(
  baseValue: unknown,
  profileValue: unknown,
): CutOtioEditorialProfileV5Observation {
  const profile = validateCutOtioEditorialProfileV5(
    baseValue,
    profileValue,
  );
  return deepFreeze({
    format: cutOtioEditorialProfileV5ObservationFormat,
    version: 1,
    compositionId: profile.compositionId,
    baseProfileSemanticSha256: profile.baseProfileSemanticSha256,
    authorities: profile.authorities,
  });
}

function parseObservation(
  baseValue: unknown,
  value: unknown,
): CutOtioEditorialProfileV5Observation {
  const base = validateCutOtioEditorialProfile(baseValue);
  const object = closed(value, "$", [
    "format", "version", "compositionId", "baseProfileSemanticSha256",
    "authorities",
  ]);
  if (object.format !== cutOtioEditorialProfileV5ObservationFormat
    || object.version !== 1) {
    fail(
      "CUT_OTIO_PROFILE_V5_VERSION",
      "$",
      "must be one V5 native observation.",
    );
  }
  const observation = deepFreeze({
    format: cutOtioEditorialProfileV5ObservationFormat,
    version: 1 as const,
    compositionId: stableId(object.compositionId, "$.compositionId"),
    baseProfileSemanticSha256: sha256(
      object.baseProfileSemanticSha256,
      "$.baseProfileSemanticSha256",
    ),
    authorities: array(
      object.authorities,
      "$.authorities",
      cutOtioEditorialProfileV5Limits.maximumAuthorities,
      1,
    ).map((entry, index) =>
      parseAuthority(entry, `$.authorities[${index}]`)),
  });
  validateRelationships(base, {
    format: cutOtioEditorialProfileV5Format,
    version: cutOtioEditorialProfileV5Version,
    compositionId: observation.compositionId,
    baseProfileSemanticSha256: observation.baseProfileSemanticSha256,
    authorities: observation.authorities,
  });
  return observation;
}

export function reconcileCutOtioEditorialProfileV5(
  baseValue: unknown,
  profileValue: unknown,
  observationValue: unknown,
): CutOtioEditorialProfileV5Reconciliation {
  const profile = validateCutOtioEditorialProfileV5(
    baseValue,
    profileValue,
  );
  const observation = parseObservation(baseValue, observationValue);
  const expected = cutOtioEditorialProfileV5ObservationFromProfile(
    baseValue,
    profile,
  );
  if (stableJsonStringify(observation) !== stableJsonStringify(expected)) {
    fail(
      "CUT_OTIO_PROFILE_V5_RECONCILIATION",
      "$.authorities",
      "native direct-media authority does not match the V5 profile.",
    );
  }
  return deepFreeze({
    format: "cut-otio-editorial-direct-media-reconciliation",
    version: 1,
    status: "pass",
    semanticSha256: profile.semanticSha256,
    baseProfileSemanticSha256: profile.baseProfileSemanticSha256,
    authorities: profile.authorities.length,
  });
}
