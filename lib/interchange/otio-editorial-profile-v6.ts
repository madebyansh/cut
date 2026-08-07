import { createHash } from "node:crypto";
import { stableJsonStringify } from "../core/stable";
import type { IRPictureTimeMap } from "../language/ir";
import {
  addRational,
  compareRational,
  divideRational,
  multiplyRational,
  rational,
  subtractRational,
  type Rational,
  zeroRational,
} from "../language/rational";
import {
  validateCutOtioEditorialProfile,
  type CutOtioEditorialProfile,
  type CutOtioEditorialRetime,
} from "./otio-editorial-profile";

/**
 * V6 is an optional authority beside the frozen V2-V5 formats. It binds the
 * exact final direct-PictureClip time law that native OTIO can only
 * approximate. It intentionally carries no TimelineEdit plan or operation
 * lineage.
 */
export const cutOtioEditorialProfileV6Format =
  "cut-otio-editorial-picture-time-map-extension" as const;
export const cutOtioEditorialProfileV6Version = 6 as const;
export const cutOtioEditorialProfileV6ObservationFormat =
  "cut-otio-editorial-picture-time-map-observation" as const;
export const cutOtioPictureTimeMapPolicy = "cut-picture-time-map-v1" as const;

export const cutOtioEditorialProfileV6Limits = Object.freeze({
  maximumAuthorities: 100_000,
  maximumRampPoints: 32,
  maximumRationalDigits: 128,
  maximumStringBytes: 4_096,
});

export type CutOtioPictureTimeMapAuthorityBody = Readonly<{
  authorityId: string;
  itemId: string;
  trackId: string;
  execution: "direct-picture-time-map-no-lineage";
  policy: typeof cutOtioPictureTimeMapPolicy;
  resource: Readonly<{
    id: string;
    sha256: string;
  }>;
  clock: Readonly<{
    kind: "frame";
    streamIndex: number;
    timeBase: Rational;
    rate: Rational;
  }>;
  source: Readonly<{ start: Rational; duration: Rational }>;
  destination: Readonly<{ start: Rational; duration: Rational }>;
  nativeRetime: CutOtioEditorialRetime;
  timeMap: IRPictureTimeMap;
}>;

export type CutOtioPictureTimeMapAuthority =
  CutOtioPictureTimeMapAuthorityBody & Readonly<{ authoritySha256: string }>;

export type CutOtioEditorialProfileV6Body = Readonly<{
  format: typeof cutOtioEditorialProfileV6Format;
  version: typeof cutOtioEditorialProfileV6Version;
  compositionId: string;
  baseProfileSemanticSha256: string;
  authorities: readonly CutOtioPictureTimeMapAuthority[];
}>;

export type CutOtioEditorialProfileV6 =
  CutOtioEditorialProfileV6Body & Readonly<{ semanticSha256: string }>;

export type CutOtioEditorialProfileV6Observation = Readonly<{
  format: typeof cutOtioEditorialProfileV6ObservationFormat;
  version: 1;
  compositionId: string;
  baseProfileSemanticSha256: string;
  authorities: readonly CutOtioPictureTimeMapAuthority[];
}>;

export type CutOtioEditorialProfileV6Reconciliation = Readonly<{
  format: "cut-otio-editorial-picture-time-map-reconciliation";
  version: 1;
  status: "pass";
  semanticSha256: string;
  baseProfileSemanticSha256: string;
  authorities: number;
}>;

export type CutOtioEditorialProfileV6ErrorCode =
  | "CUT_OTIO_PROFILE_V6_BUDGET"
  | "CUT_OTIO_PROFILE_V6_DUPLICATE"
  | "CUT_OTIO_PROFILE_V6_HASH"
  | "CUT_OTIO_PROFILE_V6_ID"
  | "CUT_OTIO_PROFILE_V6_RATIONAL"
  | "CUT_OTIO_PROFILE_V6_RECONCILIATION"
  | "CUT_OTIO_PROFILE_V6_REFERENCE"
  | "CUT_OTIO_PROFILE_V6_TIMING"
  | "CUT_OTIO_PROFILE_V6_TYPE"
  | "CUT_OTIO_PROFILE_V6_UNKNOWN_FIELD"
  | "CUT_OTIO_PROFILE_V6_VERSION";

export class CutOtioEditorialProfileV6Error extends Error {
  constructor(
    readonly code: CutOtioEditorialProfileV6ErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(`${code} at ${path}: ${message}`);
    this.name = "CutOtioEditorialProfileV6Error";
  }
}

type JsonRecord = Record<string, unknown>;

function fail(
  code: CutOtioEditorialProfileV6ErrorCode,
  path: string,
  message: string,
): never {
  throw new CutOtioEditorialProfileV6Error(code, path, message);
}

function record(value: unknown, path: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("CUT_OTIO_PROFILE_V6_TYPE", path, "must be a plain object.");
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
        "CUT_OTIO_PROFILE_V6_UNKNOWN_FIELD",
        `${path}.${key}`,
        "is outside the closed V6 picture-time-map authority.",
      );
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(object, key)) {
      fail("CUT_OTIO_PROFILE_V6_TYPE", `${path}.${key}`, "is required.");
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
    fail("CUT_OTIO_PROFILE_V6_TYPE", path, "must be an array.");
  }
  if (value.length < minimum || value.length > maximum) {
    fail(
      "CUT_OTIO_PROFILE_V6_BUDGET",
      path,
      `must contain ${minimum}..${maximum} entries.`,
    );
  }
  return value;
}

const stableIdPattern = /^[A-Za-z_][A-Za-z0-9._:-]{0,127}$/u;
const authorityIdPattern = /^otio_picture_time_map_[a-f0-9]{24}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;

function boundedString(value: unknown, path: string) {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > cutOtioEditorialProfileV6Limits.maximumStringBytes
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(
      "CUT_OTIO_PROFILE_V6_TYPE",
      path,
      "must be one bounded non-control string.",
    );
  }
  return value;
}

function stableId(value: unknown, path: string) {
  const result = boundedString(value, path);
  if (!stableIdPattern.test(result)) {
    fail("CUT_OTIO_PROFILE_V6_ID", path, "must be one stable CUT identity.");
  }
  return result;
}

function authorityId(value: unknown, path: string) {
  const result = boundedString(value, path);
  if (!authorityIdPattern.test(result)) {
    fail(
      "CUT_OTIO_PROFILE_V6_ID",
      path,
      "must be one derived V6 picture-time-map authority identity.",
    );
  }
  return result;
}

function sha256(value: unknown, path: string) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail(
      "CUT_OTIO_PROFILE_V6_TYPE",
      path,
      "must be one lowercase SHA-256.",
    );
  }
  return value;
}

function exactRational(
  value: unknown,
  path: string,
  requirement: "any" | "non-negative" | "positive" = "non-negative",
) {
  const object = closed(value, path, ["numerator", "denominator"]);
  if (typeof object.numerator !== "string"
    || typeof object.denominator !== "string"
    || object.numerator.length
      > cutOtioEditorialProfileV6Limits.maximumRationalDigits
    || object.denominator.length
      > cutOtioEditorialProfileV6Limits.maximumRationalDigits
    || !/^-?(?:0|[1-9][0-9]*)$/u.test(object.numerator)
    || !/^[1-9][0-9]*$/u.test(object.denominator)) {
    fail(
      "CUT_OTIO_PROFILE_V6_RATIONAL",
      path,
      "must be one bounded exact rational.",
    );
  }
  const result = rational(object.numerator, object.denominator);
  if (result.numerator !== object.numerator
    || result.denominator !== object.denominator) {
    fail(
      "CUT_OTIO_PROFILE_V6_RATIONAL",
      path,
      "must be reduced canonically.",
    );
  }
  const sign = compareRational(result, zeroRational);
  if ((requirement === "positive" && sign <= 0)
    || (requirement === "non-negative" && sign < 0)) {
    fail(
      "CUT_OTIO_PROFILE_V6_RATIONAL",
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
      "CUT_OTIO_PROFILE_V6_TYPE",
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

function pictureRate(value: unknown, path: string) {
  const result = exactRational(value, path, "positive");
  if (compareRational(result, rational(1, 64)) < 0
    || compareRational(result, rational(64)) > 0) {
    fail(
      "CUT_OTIO_PROFILE_V6_TIMING",
      path,
      "must be between 1/64 and 64 inclusive.",
    );
  }
  return result;
}

function parseTimeMap(value: unknown, path: string): IRPictureTimeMap {
  const object = record(value, path);
  if (object.kind === "constant") {
    const constant = closed(
      value,
      path,
      ["kind", "direction", "rate"],
      ["frameSelection"],
    );
    if (constant.direction !== "forward" && constant.direction !== "reverse") {
      fail("CUT_OTIO_PROFILE_V6_TYPE", `${path}.direction`, "must be forward or reverse.");
    }
    if (constant.frameSelection !== "nearest"
      && constant.frameSelection !== "frame-blend") {
      fail(
        "CUT_OTIO_PROFILE_V6_REFERENCE",
        `${path}.frameSelection`,
        "must be a non-default nearest or frame-blend law; default floor uses V2 omission.",
      );
    }
    return Object.freeze({
      kind: "constant",
      direction: constant.direction,
      rate: pictureRate(constant.rate, `${path}.rate`),
      frameSelection: constant.frameSelection,
    });
  }
  if (object.kind === "freeze") {
    const freeze = closed(value, path, ["kind", "at"], ["frameSelection"]);
    if (freeze.frameSelection !== undefined
      && freeze.frameSelection !== "frame-blend") {
      fail(
        "CUT_OTIO_PROFILE_V6_TYPE",
        `${path}.frameSelection`,
        "must be frame-blend when present.",
      );
    }
    return Object.freeze({
      kind: "freeze",
      at: exactRational(freeze.at, `${path}.at`),
      ...(freeze.frameSelection === "frame-blend"
        ? { frameSelection: "frame-blend" as const }
        : {}),
    });
  }
  if (object.kind === "speed-ramp") {
    const ramp = closed(
      value,
      path,
      ["kind", "interpolation", "frameSelection", "points"],
    );
    if (ramp.interpolation !== "linear-rate") {
      fail(
        "CUT_OTIO_PROFILE_V6_TYPE",
        `${path}.interpolation`,
        "must be linear-rate.",
      );
    }
    if (ramp.frameSelection !== "floor"
      && ramp.frameSelection !== "nearest"
      && ramp.frameSelection !== "frame-blend") {
      fail(
        "CUT_OTIO_PROFILE_V6_TYPE",
        `${path}.frameSelection`,
        "must be floor, nearest, or frame-blend.",
      );
    }
    const points = array(
      ramp.points,
      `${path}.points`,
      cutOtioEditorialProfileV6Limits.maximumRampPoints,
      2,
    ).map((point, index) => {
      const pointPath = `${path}.points[${index}]`;
      const parsed = closed(point, pointPath, ["at", "rate"]);
      return Object.freeze({
        at: exactRational(parsed.at, `${pointPath}.at`),
        rate: pictureRate(parsed.rate, `${pointPath}.rate`),
      });
    });
    for (let index = 1; index < points.length; index += 1) {
      if (compareRational(points[index].at, points[index - 1].at) <= 0) {
        fail(
          "CUT_OTIO_PROFILE_V6_TIMING",
          `${path}.points[${index}].at`,
          "must be strictly later than the previous point.",
        );
      }
    }
    return Object.freeze({
      kind: "speed-ramp",
      interpolation: "linear-rate",
      frameSelection: ramp.frameSelection,
      points,
    });
  }
  fail(
    "CUT_OTIO_PROFILE_V6_TYPE",
    `${path}.kind`,
    "must be constant, freeze, or speed-ramp.",
  );
}

function parseAuthority(
  value: unknown,
  path: string,
): CutOtioPictureTimeMapAuthority {
  const object = closed(value, path, [
    "authorityId", "itemId", "trackId", "execution", "policy",
    "resource", "clock", "source", "destination", "nativeRetime",
    "timeMap", "authoritySha256",
  ]);
  if (object.execution !== "direct-picture-time-map-no-lineage") {
    fail(
      "CUT_OTIO_PROFILE_V6_TYPE",
      `${path}.execution`,
      "must explicitly exclude TimelineEdit lineage.",
    );
  }
  if (object.policy !== cutOtioPictureTimeMapPolicy) {
    fail(
      "CUT_OTIO_PROFILE_V6_TYPE",
      `${path}.policy`,
      `must be ${cutOtioPictureTimeMapPolicy}.`,
    );
  }
  const resource = closed(object.resource, `${path}.resource`, ["id", "sha256"]);
  const clock = closed(
    object.clock,
    `${path}.clock`,
    ["kind", "streamIndex", "timeBase", "rate"],
  );
  if (clock.kind !== "frame") {
    fail("CUT_OTIO_PROFILE_V6_TYPE", `${path}.clock.kind`, "must be frame.");
  }
  if (!Number.isSafeInteger(clock.streamIndex) || Number(clock.streamIndex) < 0) {
    fail(
      "CUT_OTIO_PROFILE_V6_TYPE",
      `${path}.clock.streamIndex`,
      "must be one non-negative safe stream index.",
    );
  }
  const body: CutOtioPictureTimeMapAuthorityBody = Object.freeze({
    authorityId: authorityId(object.authorityId, `${path}.authorityId`),
    itemId: stableId(object.itemId, `${path}.itemId`),
    trackId: stableId(object.trackId, `${path}.trackId`),
    execution: "direct-picture-time-map-no-lineage",
    policy: cutOtioPictureTimeMapPolicy,
    resource: Object.freeze({
      id: stableId(resource.id, `${path}.resource.id`),
      sha256: sha256(resource.sha256, `${path}.resource.sha256`),
    }),
    clock: Object.freeze({
      kind: "frame",
      streamIndex: Number(clock.streamIndex),
      timeBase: exactRational(clock.timeBase, `${path}.clock.timeBase`, "positive"),
      rate: exactRational(clock.rate, `${path}.clock.rate`, "positive"),
    }),
    source: interval(object.source, `${path}.source`),
    destination: interval(object.destination, `${path}.destination`),
    nativeRetime: parseRetime(object.nativeRetime, `${path}.nativeRetime`),
    timeMap: parseTimeMap(object.timeMap, `${path}.timeMap`),
  });
  const expectedId = cutOtioPictureTimeMapAuthorityId(body);
  if (body.authorityId !== expectedId) {
    fail(
      "CUT_OTIO_PROFILE_V6_HASH",
      `${path}.authorityId`,
      `expected ${expectedId}.`,
    );
  }
  const observedSha = sha256(object.authoritySha256, `${path}.authoritySha256`);
  const expectedSha = cutOtioPictureTimeMapAuthoritySha256(body);
  if (observedSha !== expectedSha) {
    fail(
      "CUT_OTIO_PROFILE_V6_HASH",
      `${path}.authoritySha256`,
      `expected ${expectedSha}.`,
    );
  }
  return Object.freeze({ ...body, authoritySha256: observedSha });
}

export function cutOtioPictureTimeMapAuthoritySha256(
  value: CutOtioPictureTimeMapAuthorityBody,
) {
  const { authorityId: _authorityId, ...content } = value;
  return createHash("sha256")
    .update(stableJsonStringify(content))
    .digest("hex");
}

export function cutOtioPictureTimeMapAuthorityId(
  value: CutOtioPictureTimeMapAuthorityBody,
) {
  return `otio_picture_time_map_${cutOtioPictureTimeMapAuthoritySha256(value).slice(0, 24)}`;
}

function sameInterval(
  left: Readonly<{ start: Rational; duration: Rational }>,
  right: Readonly<{ start: Rational; duration: Rational }>,
) {
  return compareRational(left.start, right.start) === 0
    && compareRational(left.duration, right.duration) === 0;
}

function expectedNativeRetime(
  source: Readonly<{ start: Rational; duration: Rational }>,
  destination: Readonly<{ start: Rational; duration: Rational }>,
  map: IRPictureTimeMap,
): CutOtioEditorialRetime {
  if (map.kind === "constant") {
    if (map.direction === "forward"
      && compareRational(map.rate, rational(1)) === 0) {
      return { kind: "identity" };
    }
    return { kind: "constant", direction: map.direction, rate: map.rate };
  }
  const endpointRate = divideRational(source.duration, destination.duration);
  return compareRational(endpointRate, rational(1)) === 0
    ? { kind: "identity" }
    : { kind: "constant", direction: "forward", rate: endpointRate };
}

function speedRampSourceDuration(
  map: Extract<IRPictureTimeMap, { kind: "speed-ramp" }>,
) {
  let result = zeroRational;
  for (let index = 0; index < map.points.length - 1; index += 1) {
    const start = map.points[index];
    const end = map.points[index + 1];
    result = addRational(result, divideRational(
      multiplyRational(
        addRational(start.rate, end.rate),
        subtractRational(end.at, start.at),
      ),
      rational(2),
    ));
  }
  return result;
}

function validateTimeMapTiming(
  authority: CutOtioPictureTimeMapAuthority,
  path: string,
) {
  const map = authority.timeMap;
  if (stableJsonStringify(authority.nativeRetime)
      !== stableJsonStringify(expectedNativeRetime(
        authority.source,
        authority.destination,
        map,
      ))) {
    fail(
      "CUT_OTIO_PROFILE_V6_RECONCILIATION",
      `${path}.nativeRetime`,
      "must equal the exact V2/native approximation for this final time map.",
    );
  }
  if (map.kind === "constant") {
    if (compareRational(
      authority.source.duration,
      multiplyRational(authority.destination.duration, map.rate),
    ) !== 0) {
      fail(
        "CUT_OTIO_PROFILE_V6_TIMING",
        `${path}.timeMap.rate`,
        "must map the exact destination duration to the exact source duration.",
      );
    }
    return;
  }
  if (map.kind === "freeze") {
    const sourceEnd = addRational(authority.source.start, authority.source.duration);
    if (compareRational(map.at, authority.source.start) < 0
      || compareRational(map.at, sourceEnd) >= 0) {
      fail(
        "CUT_OTIO_PROFILE_V6_TIMING",
        `${path}.timeMap.at`,
        "must select one instant inside the exact half-open source interval.",
      );
    }
    return;
  }
  if (compareRational(map.points[0].at, zeroRational) !== 0
    || compareRational(
      map.points.at(-1)!.at,
      authority.destination.duration,
    ) !== 0
    || compareRational(
      speedRampSourceDuration(map),
      authority.source.duration,
    ) !== 0) {
    fail(
      "CUT_OTIO_PROFILE_V6_TIMING",
      `${path}.timeMap.points`,
      "must span the destination and integrate to the exact source duration.",
    );
  }
}

function validateRelationships(
  base: CutOtioEditorialProfile,
  body: CutOtioEditorialProfileV6Body,
) {
  if (body.compositionId !== base.compositionId
    || body.baseProfileSemanticSha256 !== base.semanticSha256) {
    fail(
      "CUT_OTIO_PROFILE_V6_REFERENCE",
      "$.baseProfileSemanticSha256",
      "must bind the exact V2 profile and composition.",
    );
  }
  const itemOwners = new Map(base.tracks.flatMap((track) =>
    track.items.map((item) => [item.id, { track, item }] as const)));
  const authorityIds = new Set<string>();
  const itemIds = new Set<string>();
  for (const [index, authority] of body.authorities.entries()) {
    const path = `$.authorities[${index}]`;
    if (authorityIds.has(authority.authorityId)
      || itemIds.has(authority.itemId)) {
      fail(
        "CUT_OTIO_PROFILE_V6_DUPLICATE",
        path,
        "duplicates an authority or native item.",
      );
    }
    authorityIds.add(authority.authorityId);
    itemIds.add(authority.itemId);
    const owner = itemOwners.get(authority.itemId);
    if (!owner
      || owner.track.kind !== "Video"
      || owner.track.id !== authority.trackId
      || owner.item.kind !== "clip"
      || !sameInterval(authority.source, owner.item.source)
      || !sameInterval(authority.destination, owner.item.destination)
      || stableJsonStringify(authority.nativeRetime)
        !== stableJsonStringify(owner.item.retime)) {
      fail(
        "CUT_OTIO_PROFILE_V6_RECONCILIATION",
        path,
        "must match one exact V2 Video clip, owner, timing, and native retime.",
      );
    }
    validateTimeMapTiming(authority, path);
  }
  const mapLossCodes = new Set([
    "CUT_OTIO_VARIABLE_RETIME_UNSUPPORTED",
    "CUT_OTIO_FREEZE_RETIME_UNSUPPORTED",
    "CUT_OTIO_FRAME_SELECTION_UNSUPPORTED",
  ]);
  const genericItems = new Set(base.losses
    .filter((loss) => loss.target.kind === "generic-otio"
      && loss.subject.kind === "item"
      && mapLossCodes.has(loss.code))
    .map((loss) => loss.subject.id));
  const cutLossItems = new Set(base.losses
    .filter((loss) => loss.target.kind === "cut-roundtrip"
      && loss.subject.kind === "item"
      && mapLossCodes.has(loss.code))
    .map((loss) => loss.subject.id));
  const expectedItems = [...genericItems]
    .filter((itemId) => !cutLossItems.has(itemId))
    .sort((left, right) => left.localeCompare(right));
  const observedItems = [...itemIds]
    .sort((left, right) => left.localeCompare(right));
  if (stableJsonStringify(observedItems)
      !== stableJsonStringify(expectedItems)) {
    fail(
      "CUT_OTIO_PROFILE_V6_REFERENCE",
      "$.authorities",
      "must cover every and only final item whose exact time-map law is V6-authenticated for CUT round-trip.",
    );
  }
}

function parseBody(
  baseValue: unknown,
  value: unknown,
): { base: CutOtioEditorialProfile; body: CutOtioEditorialProfileV6Body } {
  const base = validateCutOtioEditorialProfile(baseValue);
  const object = closed(value, "$", [
    "format", "version", "compositionId", "baseProfileSemanticSha256",
    "authorities",
  ]);
  if (object.format !== cutOtioEditorialProfileV6Format
    || object.version !== cutOtioEditorialProfileV6Version) {
    fail(
      "CUT_OTIO_PROFILE_V6_VERSION",
      "$",
      "must be the V6 picture-time-map extension.",
    );
  }
  const body: CutOtioEditorialProfileV6Body = Object.freeze({
    format: cutOtioEditorialProfileV6Format,
    version: cutOtioEditorialProfileV6Version,
    compositionId: stableId(object.compositionId, "$.compositionId"),
    baseProfileSemanticSha256: sha256(
      object.baseProfileSemanticSha256,
      "$.baseProfileSemanticSha256",
    ),
    authorities: Object.freeze(array(
      object.authorities,
      "$.authorities",
      cutOtioEditorialProfileV6Limits.maximumAuthorities,
      1,
    ).map((entry, index) =>
      parseAuthority(entry, `$.authorities[${index}]`))),
  });
  validateRelationships(base, body);
  return { base, body };
}

function semanticSha256(body: CutOtioEditorialProfileV6Body) {
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

export function createCutOtioPictureTimeMapAuthority(
  value: Omit<CutOtioPictureTimeMapAuthorityBody, "authorityId">
    & Readonly<{ authorityId?: string }>,
): CutOtioPictureTimeMapAuthority {
  const provisional = {
    ...value,
    authorityId: value.authorityId
      ?? "otio_picture_time_map_000000000000000000000000",
  } as CutOtioPictureTimeMapAuthorityBody;
  const authorityIdValue = cutOtioPictureTimeMapAuthorityId(provisional);
  const body = { ...value, authorityId: authorityIdValue };
  return deepFreeze({
    ...clone(body),
    authoritySha256: cutOtioPictureTimeMapAuthoritySha256(body),
  });
}

export function createCutOtioEditorialProfileV6(
  baseValue: unknown,
  bodyValue: unknown,
): CutOtioEditorialProfileV6 {
  const { body } = parseBody(baseValue, bodyValue);
  return deepFreeze({
    ...clone(body),
    semanticSha256: semanticSha256(body),
  });
}

export function validateCutOtioEditorialProfileV6(
  baseValue: unknown,
  value: unknown,
): CutOtioEditorialProfileV6 {
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
      "CUT_OTIO_PROFILE_V6_HASH",
      "$.semanticSha256",
      `expected ${expected}.`,
    );
  }
  return deepFreeze({ ...clone(body), semanticSha256: observed });
}

export function cutOtioEditorialProfileV6ObservationFromProfile(
  baseValue: unknown,
  profileValue: unknown,
): CutOtioEditorialProfileV6Observation {
  const profile = validateCutOtioEditorialProfileV6(baseValue, profileValue);
  return deepFreeze({
    format: cutOtioEditorialProfileV6ObservationFormat,
    version: 1,
    compositionId: profile.compositionId,
    baseProfileSemanticSha256: profile.baseProfileSemanticSha256,
    authorities: profile.authorities,
  });
}

function parseObservation(
  baseValue: unknown,
  value: unknown,
): CutOtioEditorialProfileV6Observation {
  const base = validateCutOtioEditorialProfile(baseValue);
  const object = closed(value, "$", [
    "format", "version", "compositionId", "baseProfileSemanticSha256",
    "authorities",
  ]);
  if (object.format !== cutOtioEditorialProfileV6ObservationFormat
    || object.version !== 1) {
    fail(
      "CUT_OTIO_PROFILE_V6_VERSION",
      "$",
      "must be one V6 native observation.",
    );
  }
  const observation = deepFreeze({
    format: cutOtioEditorialProfileV6ObservationFormat,
    version: 1 as const,
    compositionId: stableId(object.compositionId, "$.compositionId"),
    baseProfileSemanticSha256: sha256(
      object.baseProfileSemanticSha256,
      "$.baseProfileSemanticSha256",
    ),
    authorities: array(
      object.authorities,
      "$.authorities",
      cutOtioEditorialProfileV6Limits.maximumAuthorities,
      1,
    ).map((entry, index) =>
      parseAuthority(entry, `$.authorities[${index}]`)),
  });
  validateRelationships(base, {
    format: cutOtioEditorialProfileV6Format,
    version: cutOtioEditorialProfileV6Version,
    compositionId: observation.compositionId,
    baseProfileSemanticSha256: observation.baseProfileSemanticSha256,
    authorities: observation.authorities,
  });
  return observation;
}

export function reconcileCutOtioEditorialProfileV6(
  baseValue: unknown,
  profileValue: unknown,
  observationValue: unknown,
): CutOtioEditorialProfileV6Reconciliation {
  const profile = validateCutOtioEditorialProfileV6(baseValue, profileValue);
  const observation = parseObservation(baseValue, observationValue);
  const expected = cutOtioEditorialProfileV6ObservationFromProfile(
    baseValue,
    profile,
  );
  if (stableJsonStringify(observation) !== stableJsonStringify(expected)) {
    fail(
      "CUT_OTIO_PROFILE_V6_RECONCILIATION",
      "$.authorities",
      "native picture-time-map authority does not match the V6 profile.",
    );
  }
  return deepFreeze({
    format: "cut-otio-editorial-picture-time-map-reconciliation",
    version: 1,
    status: "pass",
    semanticSha256: profile.semanticSha256,
    baseProfileSemanticSha256: profile.baseProfileSemanticSha256,
    authorities: profile.authorities.length,
  });
}
