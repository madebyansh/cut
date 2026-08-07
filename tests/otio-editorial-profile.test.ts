import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CutOtioEditorialProfileError,
  createCutOtioEditorialProfile,
  cutOtioEditorialObservationFromProfile,
  cutOtioEditorialSemanticSha256,
  reconcileCutOtioEditorialProfile,
  validateCutOtioEditorialProfile,
  type CutOtioEditorialObservation,
  type CutOtioEditorialProfile,
  type CutOtioEditorialProfileBody,
  type CutOtioEditorialProfileErrorCode,
} from "../lib/interchange/otio-editorial-profile";
import { rational } from "../lib/language/rational";

const identity = Object.freeze({ kind: "identity" as const });
const unlinked = Object.freeze({ kind: "unlinked" as const });
type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

function body(): CutOtioEditorialProfileBody {
  return {
    format: "cut-otio-editorial-profile",
    version: 2,
    compositionId: "main",
    duration: rational(8),
    tracks: [
      {
        id: "picture_track",
        kind: "Video",
        order: 0,
        role: "primary",
        metadata: { "org.example.track": "picture-main" },
        items: [
          {
            id: "picture_out",
            kind: "clip",
            order: 0,
            destination: { start: rational(0), duration: rational(4) },
            source: { start: rational(0), duration: rational(4) },
            link: { kind: "linked", groupId: "av_group", segmentId: "segment_out" },
            retime: identity,
            nesting: null,
            role: "primary",
            metadata: { "org.example.item": "picture-out" },
          },
          {
            id: "picture_in",
            kind: "clip",
            order: 1,
            destination: { start: rational(4), duration: rational(2) },
            source: { start: rational(10), duration: rational(2) },
            link: { kind: "linked", groupId: "av_group", segmentId: "segment_in" },
            retime: identity,
            nesting: null,
          },
          {
            id: "picture_fast",
            kind: "clip",
            order: 2,
            destination: { start: rational(6), duration: rational(1) },
            source: { start: rational(20), duration: rational(2) },
            link: unlinked,
            retime: { kind: "constant", direction: "forward", rate: rational(2) },
            nesting: null,
          },
          {
            id: "picture_nested",
            kind: "nested-sequence",
            order: 3,
            destination: { start: rational(7), duration: rational(1) },
            source: { start: rational(0), duration: rational(1) },
            link: unlinked,
            retime: identity,
            nesting: {
              instanceId: "nested_instance",
              compositionId: "nested_timeline",
              sourceRange: { start: rational(0), duration: rational(1) },
              semanticSha256: "a".repeat(64),
              depth: 1,
              ancestry: ["main", "nested_timeline"],
            },
          },
        ],
      },
      {
        id: "audio_track",
        kind: "Audio",
        order: 1,
        role: "dialogue",
        metadata: { "org.example.track": "dialogue-main" },
        items: [
          {
            id: "audio_out",
            kind: "clip",
            order: 0,
            destination: { start: rational(0), duration: rational(3) },
            source: { start: rational(0), duration: rational(3) },
            link: { kind: "linked", groupId: "av_group", segmentId: "segment_out" },
            retime: identity,
            nesting: null,
            role: "dialogue",
            metadata: { "org.example.item": "audio-out" },
          },
          {
            id: "audio_in",
            kind: "clip",
            order: 1,
            destination: { start: rational(3), duration: rational(5) },
            source: { start: rational(10), duration: rational(5) },
            link: { kind: "linked", groupId: "av_group", segmentId: "segment_in" },
            retime: identity,
            nesting: null,
          },
        ],
      },
    ],
    linkGroups: [{
      id: "av_group",
      kind: "linked-av",
      segments: [
        { id: "segment_out", pictureItemId: "picture_out", audioItemId: "audio_out" },
        { id: "segment_in", pictureItemId: "picture_in", audioItemId: "audio_in" },
      ],
    }],
    linkedCuts: [{
      id: "j_cut_1",
      kind: "j-cut",
      groupId: "av_group",
      picture: { outgoingItemId: "picture_out", incomingItemId: "picture_in", at: rational(4) },
      audio: { outgoingItemId: "audio_out", incomingItemId: "audio_in", at: rational(3) },
    }],
    transitions: [
      {
        id: "picture_dissolve",
        trackId: "picture_track",
        outgoingItemId: "picture_out",
        incomingItemId: "picture_in",
        cut: rational(4),
        duration: rational(1),
        overlap: { start: rational(7, 2), duration: rational(1) },
        outgoingSource: { start: rational(4), duration: rational(1, 2) },
        incomingSource: { start: rational(19, 2), duration: rational(1, 2) },
        mapping: { kind: "picture", style: { kind: "cross-dissolve" } },
      },
      {
        id: "audio_crossfade",
        trackId: "audio_track",
        outgoingItemId: "audio_out",
        incomingItemId: "audio_in",
        cut: rational(3),
        duration: rational(1, 2),
        overlap: { start: rational(11, 4), duration: rational(1, 2) },
        outgoingSource: { start: rational(3), duration: rational(1, 4) },
        incomingSource: { start: rational(39, 4), duration: rational(1, 4) },
        mapping: { kind: "audio", curve: "equal-power" },
      },
    ],
    losses: [
      {
        code: "CUT_OTIO_LINKED_CUT_METADATA_REQUIRED",
        category: "linkage",
        disposition: "metadata-required",
        target: { kind: "generic-otio" },
        subject: { kind: "linked-cut", id: "j_cut_1" },
        message: "Generic OTIO preserves the hard boundaries but not CUT J-cut intent.",
      },
      {
        code: "CUT_OTIO_ADAPTER_NESTING_UNVERIFIED",
        category: "nesting",
        disposition: "unsupported",
        target: { kind: "adapter", id: "fixture.nle" },
        subject: { kind: "nesting", id: "nested_instance" },
        message: "The fixture adapter has not demonstrated nested Stack preservation.",
      },
    ],
  };
}

function mutableBody() {
  return structuredClone(body()) as Mutable<CutOtioEditorialProfileBody>;
}

function profileError(code: CutOtioEditorialProfileErrorCode, path?: RegExp) {
  return (error: unknown) => error instanceof CutOtioEditorialProfileError
    && error.code === code
    && (!path || path.test(error.path));
}

test("v2 creates a frozen canonical profile and reconciles its exact native observation", () => {
  const profile = createCutOtioEditorialProfile(body());
  const validated = validateCutOtioEditorialProfile(structuredClone(profile));
  assert.deepEqual(validated, profile);
  assert.match(profile.semanticSha256, /^[a-f0-9]{64}$/u);
  assert.equal(cutOtioEditorialSemanticSha256(profile), profile.semanticSha256);
  assert.equal(Object.isFrozen(profile), true);
  assert.equal(Object.isFrozen(profile.tracks[0].items[0].destination), true);

  const observation = cutOtioEditorialObservationFromProfile(profile);
  assert.equal(Object.hasOwn(observation.tracks[0].items[0], "link"), false, "native reconciliation projection excludes CUT-only linkage");
  assert.equal(observation.tracks[0].role, "primary");
  assert.deepEqual(observation.tracks[0].metadata, { "org.example.track": "picture-main" });
  assert.equal(observation.tracks[0].items[0].role, "primary");
  assert.deepEqual(observation.tracks[0].items[0].metadata, { "org.example.item": "picture-out" });
  assert.equal(observation.tracks[0].items[2].retime.kind, "constant");
  assert.equal(observation.tracks[0].items[3].nesting?.instanceId, "nested_instance");

  assert.deepEqual(reconcileCutOtioEditorialProfile(profile, observation), {
    format: "cut-otio-editorial-reconciliation",
    version: 1,
    status: "pass",
    semanticSha256: profile.semanticSha256,
    compositionId: "main",
    tracks: 2,
    items: 6,
    linkGroups: 1,
    linkedCuts: 1,
    transitions: 2,
    nestingInstances: 1,
    targetScopedLosses: 2,
  });
});

test("the checked-in schema is closed and names the same v2 contract", () => {
  const schema = JSON.parse(readFileSync(resolve(process.cwd(), "schemas/cut-otio-editorial-profile-v2.schema.json"), "utf8"));
  assert.equal(schema.$id, "urn:cut:schema:otio-editorial-profile:2");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    "format", "version", "compositionId", "duration", "tracks", "linkGroups",
    "linkedCuts", "transitions", "losses", "semanticSha256",
  ]);
  assert.equal(schema.$defs.track.additionalProperties, false);
  assert.equal(schema.$defs.track.properties.role.$ref, "#/$defs/editorialRole");
  assert.equal(schema.$defs.track.properties.metadata.$ref, "#/$defs/editorialMetadata");
  assert.equal(schema.$defs.clipItem.properties.role.$ref, "#/$defs/editorialRole");
  assert.equal(schema.$defs.clipItem.properties.metadata.$ref, "#/$defs/editorialMetadata");
  assert.equal(schema.$defs.transition.additionalProperties, false);
  assert.equal(schema.$defs.loss.additionalProperties, false);
});

test("unknown, duplicate, dangling, and contradictory linkage metadata fails closed", () => {
  const unknown = mutableBody();
  (unknown.tracks[0].items[0] as unknown as Record<string, unknown>).privatePayload = true;
  assert.throws(
    () => createCutOtioEditorialProfile(unknown),
    profileError("CUT_OTIO_PROFILE_UNKNOWN_FIELD", /\$\.tracks\[0\]\.items\[0\]\.privatePayload/u),
  );

  const duplicate = mutableBody();
  duplicate.tracks[0].items[1].id = "picture_out";
  assert.throws(
    () => createCutOtioEditorialProfile(duplicate),
    profileError("CUT_OTIO_PROFILE_DUPLICATE", /\$\.tracks\[0\]\.items\[1\]\.id/u),
  );

  const dangling = mutableBody();
  dangling.linkGroups[0].segments[0].pictureItemId = "missing_picture";
  assert.throws(
    () => createCutOtioEditorialProfile(dangling),
    profileError("CUT_OTIO_PROFILE_REFERENCE", /\$\.linkGroups\[0\]\.segments\[0\]\.pictureItemId/u),
  );

  const contradictory = mutableBody();
  contradictory.tracks[1].items[0].link = { kind: "unlinked" };
  assert.throws(
    () => createCutOtioEditorialProfile(contradictory),
    profileError("CUT_OTIO_PROFILE_REFERENCE", /\$\.linkGroups\[0\]\.segments\[0\]\.audioItemId/u),
  );
});

test("exact rationals, constant retimes, J/L boundaries, transition handles, and nesting ancestry reconcile structurally", () => {
  const nonCanonical = mutableBody();
  nonCanonical.tracks[0].items[0].destination.duration = { numerator: "8", denominator: "2" };
  assert.throws(
    () => createCutOtioEditorialProfile(nonCanonical),
    profileError("CUT_OTIO_PROFILE_RATIONAL", /\$\.tracks\[0\]\.items\[0\]\.destination\.duration/u),
  );

  const retimeMismatch = mutableBody();
  assert.ok(retimeMismatch.tracks[0].items[2].source);
  retimeMismatch.tracks[0].items[2].source.duration = rational(3);
  assert.throws(
    () => createCutOtioEditorialProfile(retimeMismatch),
    profileError("CUT_OTIO_PROFILE_TIMING", /\$\.tracks\[0\]\.items\[2\]\.source\.duration/u),
  );

  const wrongLinkedCut = mutableBody();
  wrongLinkedCut.linkedCuts[0].kind = "l-cut";
  assert.throws(
    () => createCutOtioEditorialProfile(wrongLinkedCut),
    profileError("CUT_OTIO_PROFILE_TIMING", /\$\.linkedCuts\[0\]/u),
  );

  const badHandle = mutableBody();
  badHandle.transitions[0].incomingSource.start = rational(9);
  assert.throws(
    () => createCutOtioEditorialProfile(badHandle),
    profileError("CUT_OTIO_PROFILE_TIMING", /\$\.transitions\[0\]\.incomingSource/u),
  );

  const nestingCycle = mutableBody();
  assert.ok(nestingCycle.tracks[0].items[3].nesting);
  nestingCycle.tracks[0].items[3].nesting.ancestry = ["main", "main"];
  nestingCycle.tracks[0].items[3].nesting.compositionId = "main";
  assert.throws(
    () => createCutOtioEditorialProfile(nestingCycle),
    profileError("CUT_OTIO_PROFILE_REFERENCE", /\$\.tracks\[0\]\.items\[3\]\.nesting\.ancestry/u),
  );
});

test("semantic hash, target-scoped subjects, and native reconciliation cannot be forged", () => {
  const profile = createCutOtioEditorialProfile(body());
  const staleHash = structuredClone(profile) as Mutable<CutOtioEditorialProfile>;
  staleHash.losses[0].message = "tampered but structurally valid message";
  assert.throws(
    () => validateCutOtioEditorialProfile(staleHash),
    profileError("CUT_OTIO_PROFILE_HASH", /\$\.semanticSha256/u),
  );

  const danglingLoss = mutableBody();
  danglingLoss.losses[0].subject.id = "missing_cut";
  assert.throws(
    () => createCutOtioEditorialProfile(danglingLoss),
    profileError("CUT_OTIO_PROFILE_REFERENCE", /\$\.losses\[0\]\.subject\.id/u),
  );

  const unknownTargetField = mutableBody();
  (unknownTargetField.losses[1].target as unknown as Record<string, unknown>).private = true;
  assert.throws(
    () => createCutOtioEditorialProfile(unknownTargetField),
    profileError("CUT_OTIO_PROFILE_UNKNOWN_FIELD", /\$\.losses\[1\]\.target\.private/u),
  );

  const mismatchedObservation = structuredClone(cutOtioEditorialObservationFromProfile(profile)) as Mutable<CutOtioEditorialObservation>;
  assert.ok(mismatchedObservation.tracks[0].items[2].source);
  mismatchedObservation.tracks[0].items[2].source.duration = rational(3);
  assert.throws(
    () => reconcileCutOtioEditorialProfile(profile, mismatchedObservation),
    profileError("CUT_OTIO_PROFILE_RECONCILIATION", /\$\.tracks\[0\]\.items\[2\]\.source\.duration/u),
  );

  const mismatchedRole = structuredClone(cutOtioEditorialObservationFromProfile(profile)) as Mutable<CutOtioEditorialObservation>;
  mismatchedRole.tracks[0].role = "overlay";
  assert.throws(
    () => reconcileCutOtioEditorialProfile(profile, mismatchedRole),
    profileError("CUT_OTIO_PROFILE_RECONCILIATION", /\$\.tracks\[0\]\.role/u),
  );

  const mismatchedMetadata = structuredClone(cutOtioEditorialObservationFromProfile(profile)) as Mutable<CutOtioEditorialObservation>;
  assert.ok(mismatchedMetadata.tracks[0].items[0].metadata);
  mismatchedMetadata.tracks[0].items[0].metadata!["org.example.item"] = "forged";
  assert.throws(
    () => reconcileCutOtioEditorialProfile(profile, mismatchedMetadata),
    profileError("CUT_OTIO_PROFILE_RECONCILIATION", /\$\.tracks\[0\]\.items\[0\]\.metadata\.org\.example\.item/u),
  );
});

test("track and item roles plus metadata are closed, namespaced, bounded, and semantic-hash bound", () => {
  const wrongTrackRole = mutableBody();
  wrongTrackRole.tracks[0].role = "dialogue";
  assert.throws(
    () => createCutOtioEditorialProfile(wrongTrackRole),
    profileError("CUT_OTIO_PROFILE_TYPE", /\$\.tracks\[0\]\.role/u),
  );

  const wrongItemRole = mutableBody();
  const audioItem = wrongItemRole.tracks[1].items[0];
  if (audioItem.kind !== "clip") throw new Error("fixture audio item must remain a clip");
  audioItem.role = "graphics";
  assert.throws(
    () => createCutOtioEditorialProfile(wrongItemRole),
    profileError("CUT_OTIO_PROFILE_TYPE", /\$\.tracks\[1\]\.items\[0\]\.role/u),
  );

  const reservedMetadata = mutableBody();
  reservedMetadata.tracks[0].metadata = { "cut.private": "forged" };
  assert.throws(
    () => createCutOtioEditorialProfile(reservedMetadata),
    profileError("CUT_OTIO_PROFILE_TYPE", /\$\.tracks\[0\]\.metadata\.cut\.private/u),
  );

  const staleMetadataHash = structuredClone(createCutOtioEditorialProfile(body())) as Mutable<CutOtioEditorialProfile>;
  assert.ok(staleMetadataHash.tracks[0].metadata);
  staleMetadataHash.tracks[0].metadata!["org.example.track"] = "changed";
  assert.throws(
    () => validateCutOtioEditorialProfile(staleMetadataHash),
    profileError("CUT_OTIO_PROFILE_HASH", /\$\.semanticSha256/u),
  );
});
