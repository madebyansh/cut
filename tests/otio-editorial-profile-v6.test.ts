import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  createCutOtioEditorialProfile,
  type CutOtioEditorialProfileBody,
} from "../lib/interchange/otio-editorial-profile";
import {
  CutOtioEditorialProfileV6Error,
  createCutOtioEditorialProfileV6,
  createCutOtioPictureTimeMapAuthority,
  cutOtioEditorialProfileV6ObservationFromProfile,
  cutOtioPictureTimeMapPolicy,
  reconcileCutOtioEditorialProfileV6,
  validateCutOtioEditorialProfileV6,
  type CutOtioEditorialProfileV6Body,
  type CutOtioPictureTimeMapAuthorityBody,
} from "../lib/interchange/otio-editorial-profile-v6";
import { rational } from "../lib/language/rational";

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

function mutable<T>(value: T) {
  return structuredClone(value) as Mutable<T>;
}

function baseProfile() {
  const body: CutOtioEditorialProfileBody = {
    format: "cut-otio-editorial-profile",
    version: 2,
    compositionId: "main",
    duration: rational(1),
    tracks: [{
      id: "picture.main",
      kind: "Video",
      order: 0,
      items: [{
        id: "picture.ramp",
        kind: "clip",
        order: 0,
        destination: { start: rational(0), duration: rational(1) },
        source: { start: rational(2), duration: rational(1) },
        link: { kind: "unlinked" },
        retime: { kind: "identity" },
        nesting: null,
      }],
    }],
    linkGroups: [],
    linkedCuts: [],
    transitions: [],
    losses: [{
      code: "CUT_OTIO_VARIABLE_RETIME_UNSUPPORTED",
      category: "retime",
      disposition: "approximated",
      target: { kind: "generic-otio" },
      subject: { kind: "item", id: "picture.ramp" },
      message: "generic target retains an approximation",
    }],
  };
  return createCutOtioEditorialProfile(body);
}

function authority() {
  const body: Omit<CutOtioPictureTimeMapAuthorityBody, "authorityId"> = {
    itemId: "picture.ramp",
    trackId: "picture.main",
    execution: "direct-picture-time-map-no-lineage",
    policy: cutOtioPictureTimeMapPolicy,
    resource: { id: "picture", sha256: "a".repeat(64) },
    clock: {
      kind: "frame",
      streamIndex: 0,
      timeBase: rational(1, 24),
      rate: rational(24),
    },
    source: { start: rational(2), duration: rational(1) },
    destination: { start: rational(0), duration: rational(1) },
    nativeRetime: { kind: "identity" },
    timeMap: {
      kind: "speed-ramp",
      interpolation: "linear-rate",
      frameSelection: "nearest",
      points: [
        { at: rational(0), rate: rational(1, 2) },
        { at: rational(1, 2), rate: rational(3, 2) },
        { at: rational(1), rate: rational(1, 2) },
      ],
    },
  };
  return createCutOtioPictureTimeMapAuthority(body);
}

function profile() {
  const base = baseProfile();
  const body: CutOtioEditorialProfileV6Body = {
    format: "cut-otio-editorial-picture-time-map-extension",
    version: 6,
    compositionId: "main",
    baseProfileSemanticSha256: base.semanticSha256,
    authorities: [authority()],
  };
  return { base, value: createCutOtioEditorialProfileV6(base, body) };
}

function v6Error(code: CutOtioEditorialProfileV6Error["code"], path?: RegExp) {
  return (error: unknown) => error instanceof CutOtioEditorialProfileV6Error
    && error.code === code
    && (path === undefined || path.test(error.path));
}

test("V6 creates, validates, observes, and reconciles one exact final picture time map", () => {
  const { base, value } = profile();
  assert.equal(value.format, "cut-otio-editorial-picture-time-map-extension");
  assert.equal(value.version, 6);
  assert.match(value.semanticSha256, /^[a-f0-9]{64}$/u);
  assert.match(value.authorities[0].authorityId, /^otio_picture_time_map_[a-f0-9]{24}$/u);
  assert.equal(value.authorities[0].execution, "direct-picture-time-map-no-lineage");
  assert.deepEqual(
    Object.keys(value.authorities[0]).sort(),
    [
      "authorityId", "authoritySha256", "clock", "destination",
      "execution", "itemId", "nativeRetime", "policy", "resource",
      "source", "timeMap", "trackId",
    ].sort(),
  );
  assert.deepEqual(validateCutOtioEditorialProfileV6(base, value), value);
  const observation = cutOtioEditorialProfileV6ObservationFromProfile(base, value);
  assert.deepEqual(reconcileCutOtioEditorialProfileV6(base, value, observation), {
    format: "cut-otio-editorial-picture-time-map-reconciliation",
    version: 1,
    status: "pass",
    semanticSha256: value.semanticSha256,
    baseProfileSemanticSha256: base.semanticSha256,
    authorities: 1,
  });
  assert.ok(Object.isFrozen(value));
  assert.ok(Object.isFrozen(value.authorities[0].timeMap));
});

test("V6 fails closed on authority, policy, resource, map, observation, and unknown-field mutations", () => {
  const { base, value } = profile();
  const mutations: Array<[
    (copy: Mutable<typeof value>) => void,
    CutOtioEditorialProfileV6Error["code"],
    RegExp,
  ]> = [
    [(copy) => { copy.semanticSha256 = "f".repeat(64); }, "CUT_OTIO_PROFILE_V6_HASH", /semanticSha256/u],
    [(copy) => { copy.authorities[0].authoritySha256 = "f".repeat(64); }, "CUT_OTIO_PROFILE_V6_HASH", /authoritySha256/u],
    [(copy) => { copy.authorities[0].policy = "future" as typeof cutOtioPictureTimeMapPolicy; }, "CUT_OTIO_PROFILE_V6_TYPE", /policy/u],
    [(copy) => { copy.authorities[0].resource.sha256 = "b".repeat(64); }, "CUT_OTIO_PROFILE_V6_HASH", /authorityId/u],
    [(copy) => {
      const map = copy.authorities[0].timeMap;
      if (map.kind === "speed-ramp") map.points[1].rate = rational(2);
    }, "CUT_OTIO_PROFILE_V6_HASH", /authorityId/u],
    [(copy) => { (copy.authorities[0] as unknown as Record<string, unknown>).private = true; }, "CUT_OTIO_PROFILE_V6_UNKNOWN_FIELD", /private/u],
  ];
  for (const [change, code, path] of mutations) {
    const copy = mutable(value);
    change(copy);
    assert.throws(
      () => validateCutOtioEditorialProfileV6(base, copy),
      v6Error(code, path),
    );
  }
  const observation = mutable(
    cutOtioEditorialProfileV6ObservationFromProfile(base, value),
  );
  observation.authorities[0].itemId = "picture.other";
  assert.throws(
    () => reconcileCutOtioEditorialProfileV6(base, value, observation),
    v6Error("CUT_OTIO_PROFILE_V6_HASH", /authorityId/u),
  );
});

test("V6 rejects redundant constant floor authority and inconsistent freeze/ramp timing", () => {
  const base = baseProfile();
  const redundant = mutable(authority());
  redundant.timeMap = {
    kind: "constant",
    direction: "forward",
    rate: rational(1),
  } as Mutable<typeof redundant.timeMap>;
  const {
    authorityId: _redundantAuthorityId,
    authoritySha256: _redundantAuthoritySha256,
    ...redundantBody
  } = redundant;
  const rebuiltRedundant = createCutOtioPictureTimeMapAuthority(
    redundantBody,
  );
  assert.throws(
    () => createCutOtioEditorialProfileV6(base, {
      format: "cut-otio-editorial-picture-time-map-extension",
      version: 6,
      compositionId: "main",
      baseProfileSemanticSha256: base.semanticSha256,
      authorities: [rebuiltRedundant],
    }),
    v6Error("CUT_OTIO_PROFILE_V6_REFERENCE", /frameSelection/u),
  );

  const badRamp = mutable(authority());
  if (badRamp.timeMap.kind === "speed-ramp") {
    badRamp.timeMap.points[2].at = rational(3, 4);
  }
  const {
    authorityId: _badRampAuthorityId,
    authoritySha256: _badRampAuthoritySha256,
    ...badRampBody
  } = badRamp;
  const rebuiltRamp = createCutOtioPictureTimeMapAuthority({
    ...badRampBody,
  });
  assert.throws(
    () => createCutOtioEditorialProfileV6(base, {
      format: "cut-otio-editorial-picture-time-map-extension",
      version: 6,
      compositionId: "main",
      baseProfileSemanticSha256: base.semanticSha256,
      authorities: [rebuiltRamp],
    }),
    v6Error("CUT_OTIO_PROFILE_V6_TIMING", /points/u),
  );

  const badFreeze = createCutOtioPictureTimeMapAuthority({
    itemId: "picture.ramp",
    trackId: "picture.main",
    execution: "direct-picture-time-map-no-lineage",
    policy: cutOtioPictureTimeMapPolicy,
    resource: { id: "picture", sha256: "a".repeat(64) },
    clock: { kind: "frame", streamIndex: 0, timeBase: rational(1, 24), rate: rational(24) },
    source: { start: rational(2), duration: rational(1) },
    destination: { start: rational(0), duration: rational(1) },
    nativeRetime: { kind: "identity" },
    timeMap: { kind: "freeze", at: rational(3) },
  });
  assert.throws(
    () => createCutOtioEditorialProfileV6(base, {
      format: "cut-otio-editorial-picture-time-map-extension",
      version: 6,
      compositionId: "main",
      baseProfileSemanticSha256: base.semanticSha256,
      authorities: [badFreeze],
    }),
    v6Error("CUT_OTIO_PROFILE_V6_TIMING", /timeMap\.at/u),
  );
});

test("the checked-in V6 schema is closed and preserves V2-V5 version identity", () => {
  const v2 = JSON.parse(readFileSync(resolve("schemas/cut-otio-editorial-profile-v2.schema.json"), "utf8"));
  const v3 = JSON.parse(readFileSync(resolve("schemas/cut-otio-editorial-profile-v3.schema.json"), "utf8"));
  const v4 = JSON.parse(readFileSync(resolve("schemas/cut-otio-editorial-profile-v4.schema.json"), "utf8"));
  const v5 = JSON.parse(readFileSync(resolve("schemas/cut-otio-editorial-profile-v5.schema.json"), "utf8"));
  const v6 = JSON.parse(readFileSync(resolve("schemas/cut-otio-editorial-profile-v6.schema.json"), "utf8"));
  assert.deepEqual(
    [v2.properties.version.const, v3.properties.version.const, v4.properties.version.const, v5.properties.version.const],
    [2, 3, 4, 5],
  );
  assert.equal(v6.properties.version.const, 6);
  assert.equal(v6.additionalProperties, false);
  assert.equal(v6.$defs.authority.additionalProperties, false);
  assert.equal(v6.$defs.authority.properties.execution.const, "direct-picture-time-map-no-lineage");
  assert.equal(v6.$defs.authority.properties.policy.const, "cut-picture-time-map-v1");
  assert.deepEqual(v6.$defs.timeMap.oneOf[0].properties.frameSelection.enum, ["nearest", "frame-blend"]);
  assert.equal(v2.properties.pictureTimeMapExtension, undefined);
  assert.equal(v5.properties.pictureTimeMapExtension, undefined);
});
