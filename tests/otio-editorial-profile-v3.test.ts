import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  createCutOtioEditorialProfile,
  cutOtioEditorialObservationFromProfile,
  type CutOtioEditorialProfile,
  type CutOtioEditorialProfileBody,
} from "../lib/interchange/otio-editorial-profile";
import {
  CutOtioEditorialProfileV3Error,
  cutOtioEditorialAudioLineageSha256,
  createCutOtioEditorialProfileV3,
  cutOtioEditorialProfileV3ObservationFromProfile,
  reconcileCutOtioEditorialProfileV3,
  validateCutOtioEditorialProfileV3,
  type CutOtioEditorialAudioLineageSegment,
  type CutOtioEditorialProfileV3Body,
} from "../lib/interchange/otio-editorial-profile-v3";
import { rational } from "../lib/language/rational";

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

const identity = Object.freeze({ kind: "identity" as const });
const unlinked = Object.freeze({ kind: "unlinked" as const });

function baseBody(): CutOtioEditorialProfileBody {
  return {
    format: "cut-otio-editorial-profile",
    version: 2,
    compositionId: "main",
    duration: rational(1, 50),
    tracks: [{
      id: "dialogue",
      kind: "Audio",
      order: 0,
      role: "dialogue",
      metadata: { "org.example.track": "dialogue" },
      items: [
        {
          id: "line_a",
          kind: "clip",
          order: 0,
          destination: { start: rational(0), duration: rational(1, 100) },
          source: { start: rational(0), duration: rational(1, 100) },
          link: unlinked,
          retime: identity,
          nesting: null,
          role: "dialogue",
          metadata: { "org.example.item": "first" },
        },
        {
          id: "line_b",
          kind: "clip",
          order: 1,
          destination: { start: rational(1, 100), duration: rational(1, 100) },
          source: { start: rational(1, 100), duration: rational(1, 100) },
          link: unlinked,
          retime: identity,
          nesting: null,
          role: "dialogue",
          metadata: { "org.example.item": "second" },
        },
      ],
    }],
    linkGroups: [],
    linkedCuts: [],
    transitions: [],
    losses: [],
  };
}

function base() {
  return createCutOtioEditorialProfile(baseBody());
}

function view(
  itemId: "line_a" | "line_b",
  index: number,
) {
  const start = rational(index, 100);
  const lineage = lineageSegment(index);
  return {
    itemId,
    segmentId: `segment_${index + 1}`,
    ...(index ? { parentSegmentId: "segment_1" } : {}),
    sliceOffset: start,
    source: { start, duration: rational(1, 100) },
    destination: { start, duration: rational(1, 100) },
    handles: { head: rational(index, 500), tail: rational(1 - index, 500) },
    link: unlinked,
    role: "dialogue",
    metadata: { "org.example.item": index ? "second" : "first" },
    lineageSha256: lineage.lineageSha256,
  };
}

function lineageSegment(index: number) {
  const start = rational(index, 100);
  const segment = {
    planId: "timeline_edit",
    trackId: "dialogue",
    originId: "origin_line",
    segmentId: `segment_${index + 1}`,
    ...(index ? { parentSegmentId: "segment_1" } : {}),
    sliceOffset: start,
    source: { start, duration: rational(1, 100) },
    destination: { start, duration: rational(1, 100) },
    handles: { head: rational(index, 500), tail: rational(1 - index, 500) },
    role: "dialogue",
    metadata: { "org.example.item": index ? "second" : "first" },
  };
  return {
    ...segment,
    lineageSha256: cutOtioEditorialAudioLineageSha256(segment),
  };
}

function rehashLineage(
  value: Mutable<CutOtioEditorialAudioLineageSegment>,
) {
  const { lineageSha256: _old, ...semantic } = value;
  value.lineageSha256 = cutOtioEditorialAudioLineageSha256(semantic);
}

function body(profile: CutOtioEditorialProfile): CutOtioEditorialProfileV3Body {
  return {
    format: "cut-otio-editorial-profile-extension",
    version: 3,
    compositionId: profile.compositionId,
    baseProfileSemanticSha256: profile.semanticSha256,
    audioOrigins: [{
      id: "origin_line",
      trackId: "dialogue",
      timelineEditPlanId: "timeline_edit",
      timelineEditOriginId: "origin_line",
      kind: "processed-audio",
      originAuthorityId: "a".repeat(64),
      sourceAuthorityId: "b".repeat(64),
      graphAuthorityId: "graph_authority",
      sourceNodeId: "voice_clip",
      processorNodeIds: ["gain_cleanup", "highpass_cleanup"],
      processorGraphSemanticSha256: "c".repeat(64),
      statePolicy: "single-authorized-evaluation",
      source: { start: rational(0), duration: rational(1, 50) },
      originDuration: rational(1, 50),
      rate: rational(1),
      fadeIn: rational(1, 250),
      fadeOut: rational(1, 250),
      lineageSegments: [lineageSegment(0), lineageSegment(1)],
      views: [view("line_a", 0), view("line_b", 1)],
    }],
    losses: [
      {
        code: "CUT_OTIO_AUDIO_ORIGIN_GRAPH_RECONSTRUCTION_UNSUPPORTED",
        category: "effect",
        disposition: "unsupported",
        target: { kind: "cut-roundtrip" },
        subject: { kind: "item", id: "line_a" },
        message: "The V3 receipt binds the processor authority but does not serialize executable CUT source.",
      },
      {
        code: "CUT_OTIO_AUDIO_ORIGIN_GRAPH_METADATA_REQUIRED",
        category: "effect",
        disposition: "metadata-required",
        target: { kind: "generic-otio" },
        subject: { kind: "item", id: "line_a" },
        message: "Generic OTIO retains only the visible PCM media slice without the CUT processor graph.",
      },
      {
        code: "CUT_OTIO_AUDIO_ORIGIN_GRAPH_RECONSTRUCTION_UNSUPPORTED",
        category: "effect",
        disposition: "unsupported",
        target: { kind: "cut-roundtrip" },
        subject: { kind: "item", id: "line_b" },
        message: "The V3 receipt binds the second processor authority view but does not serialize executable CUT source.",
      },
      {
        code: "CUT_OTIO_AUDIO_ORIGIN_GRAPH_METADATA_REQUIRED",
        category: "effect",
        disposition: "metadata-required",
        target: { kind: "generic-otio" },
        subject: { kind: "item", id: "line_b" },
        message: "Generic OTIO retains only the second visible PCM media slice without the CUT processor graph.",
      },
    ],
  };
}

function mutable<T>(value: T) {
  return structuredClone(value) as Mutable<T>;
}

function v3Error(code: CutOtioEditorialProfileV3Error["code"], path?: RegExp) {
  return (error: unknown) =>
    error instanceof CutOtioEditorialProfileV3Error
    && error.code === code
    && (!path || path.test(error.path));
}

test("V3 binds rich origin-clock views beside an unchanged V2 native profile and reconciles exact metadata", () => {
  const native = base();
  const nativeObservation = cutOtioEditorialObservationFromProfile(native);
  const profile = createCutOtioEditorialProfileV3(native, body(native));
  assert.deepEqual(
    cutOtioEditorialObservationFromProfile(native),
    nativeObservation,
    "creating the V3 extension changed the frozen V2 native observation",
  );
  assert.equal(profile.baseProfileSemanticSha256, native.semanticSha256);
  assert.match(profile.semanticSha256, /^[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(profile.audioOrigins[0].views[0]), true);
  assert.deepEqual(validateCutOtioEditorialProfileV3(native, profile), profile);

  const observation = cutOtioEditorialProfileV3ObservationFromProfile(
    native,
    profile,
  );
  assert.deepEqual(
    reconcileCutOtioEditorialProfileV3(native, profile, observation),
    {
      format: "cut-otio-editorial-profile-extension-reconciliation",
      version: 1,
      status: "pass",
      semanticSha256: profile.semanticSha256,
      baseProfileSemanticSha256: native.semanticSha256,
      origins: 1,
      views: 2,
      lineageSegments: 2,
      targetScopedLosses: 4,
    },
  );
});

test("V3 refuses forged profile identity, origin clocks, native role/metadata/link, and lineage receipts", () => {
  const native = base(), profile = createCutOtioEditorialProfileV3(native, body(native));

  const staleBase = mutable(profile);
  staleBase.baseProfileSemanticSha256 = "0".repeat(64);
  assert.throws(
    () => validateCutOtioEditorialProfileV3(native, staleBase),
    v3Error("CUT_OTIO_PROFILE_V3_REFERENCE", /\.baseProfileSemanticSha256/u),
  );

  const staleHash = mutable(profile);
  staleHash.semanticSha256 = "0".repeat(64);
  assert.throws(
    () => validateCutOtioEditorialProfileV3(native, staleHash),
    v3Error("CUT_OTIO_PROFILE_V3_HASH", /\.semanticSha256/u),
  );

  const wrongSlice = mutable(body(native));
  wrongSlice.audioOrigins[0].views[1].sliceOffset = rational(9, 1000);
  assert.throws(
    () => createCutOtioEditorialProfileV3(native, wrongSlice),
    v3Error("CUT_OTIO_PROFILE_V3_RECONCILIATION", /views\[1\]/u),
  );

  const wrongRole = mutable(body(native));
  wrongRole.audioOrigins[0].views[1].role = "music";
  assert.throws(
    () => createCutOtioEditorialProfileV3(native, wrongRole),
    v3Error("CUT_OTIO_PROFILE_V3_RECONCILIATION", /views\[1\]/u),
  );

  const wrongMetadata = mutable(body(native));
  wrongMetadata.audioOrigins[0].views[0].metadata = {
    "org.example.item": "forged",
  };
  assert.throws(
    () => createCutOtioEditorialProfileV3(native, wrongMetadata),
    v3Error("CUT_OTIO_PROFILE_V3_RECONCILIATION", /views\[0\]/u),
  );

  const observation = mutable(
    cutOtioEditorialProfileV3ObservationFromProfile(native, profile),
  );
  observation.audioOrigins[0].views[0].lineageSha256 = "f".repeat(64);
  assert.throws(
    () => reconcileCutOtioEditorialProfileV3(native, profile, observation),
    v3Error(
      "CUT_OTIO_PROFILE_V3_RECONCILIATION",
      /lineageSha256/u,
    ),
  );

  const reordered = mutable(body(native));
  reordered.audioOrigins[0].lineageSegments.reverse();
  assert.throws(
    () => createCutOtioEditorialProfileV3(native, reordered),
    v3Error(
      "CUT_OTIO_PROFILE_V3_REFERENCE",
      /lineageSegments\[0\]\.parentSegmentId/u,
    ),
  );

  const missingAncestor = mutable(body(native));
  missingAncestor.audioOrigins[0].lineageSegments.shift();
  assert.throws(
    () => createCutOtioEditorialProfileV3(native, missingAncestor),
    v3Error("CUT_OTIO_PROFILE_V3_REFERENCE", /parentSegmentId/u),
  );

  const foreignPlan = mutable(body(native));
  foreignPlan.audioOrigins[0].lineageSegments[1].planId = "foreign_plan";
  rehashLineage(foreignPlan.audioOrigins[0].lineageSegments[1]);
  assert.throws(
    () => createCutOtioEditorialProfileV3(native, foreignPlan),
    v3Error("CUT_OTIO_PROFILE_V3_REFERENCE", /lineageSegments\[1\]/u),
  );

  const unusedLineage = mutable(body(native));
  const extra = mutable(lineageSegment(0));
  extra.segmentId = "unused_segment";
  rehashLineage(extra);
  unusedLineage.audioOrigins[0].lineageSegments.push(extra);
  assert.throws(
    () => createCutOtioEditorialProfileV3(native, unusedLineage),
    v3Error("CUT_OTIO_PROFILE_V3_REFERENCE", /lineageSegments/u),
  );
});

test("V3 origin clocks preserve exact constant-rate source mapping and end ties", () => {
  const nativeBody = mutable(baseBody());
  nativeBody.tracks[0].items[0].source = {
    start: rational(0),
    duration: rational(1, 50),
  };
  nativeBody.tracks[0].items[0].retime = {
    kind: "constant",
    direction: "forward",
    rate: rational(2),
  };
  nativeBody.tracks[0].items[1].source = {
    start: rational(1, 50),
    duration: rational(1, 50),
  };
  nativeBody.tracks[0].items[1].retime = {
    kind: "constant",
    direction: "forward",
    rate: rational(2),
  };
  const native = createCutOtioEditorialProfile(nativeBody);
  const extension = mutable(body(native));
  extension.baseProfileSemanticSha256 = native.semanticSha256;
  extension.audioOrigins[0].source.duration = rational(1, 25);
  extension.audioOrigins[0].originDuration = rational(1, 50);
  extension.audioOrigins[0].rate = rational(2);
  extension.audioOrigins[0].views[0].source = {
    start: rational(0),
    duration: rational(1, 50),
  };
  extension.audioOrigins[0].views[1].source = {
    start: rational(1, 50),
    duration: rational(1, 50),
  };
  extension.audioOrigins[0].lineageSegments[0].source =
    extension.audioOrigins[0].views[0].source;
  extension.audioOrigins[0].lineageSegments[1].source =
    extension.audioOrigins[0].views[1].source;
  for (const lineage of extension.audioOrigins[0].lineageSegments) {
    rehashLineage(lineage);
  }
  extension.audioOrigins[0].views[0].lineageSha256 =
    extension.audioOrigins[0].lineageSegments[0].lineageSha256;
  extension.audioOrigins[0].views[1].lineageSha256 =
    extension.audioOrigins[0].lineageSegments[1].lineageSha256;
  assert.doesNotThrow(() =>
    createCutOtioEditorialProfileV3(native, extension));

  const pastEnd = mutable(extension);
  pastEnd.audioOrigins[0].lineageSegments[1].sliceOffset = rational(3, 100);
  pastEnd.audioOrigins[0].lineageSegments[1].source.start = rational(3, 50);
  rehashLineage(pastEnd.audioOrigins[0].lineageSegments[1]);
  assert.throws(
    () => createCutOtioEditorialProfileV3(native, pastEnd),
    v3Error("CUT_OTIO_PROFILE_V3_TIMING", /lineageSegments\[1\]/u),
  );
});

test("V3 keeps processor, retime, transition, and nesting boundaries target-scoped and fail closed", () => {
  const native = base();

  const missingProcessorLoss = mutable(body(native));
  missingProcessorLoss.losses = [];
  assert.throws(
    () => createCutOtioEditorialProfileV3(native, missingProcessorLoss),
    v3Error("CUT_OTIO_PROFILE_V3_LOSS", /\.losses/u),
  );

  const missingSecondViewLoss = mutable(body(native));
  missingSecondViewLoss.losses = missingSecondViewLoss.losses.filter((loss) =>
    loss.subject.id !== "line_b"
    || loss.target.kind !== "generic-otio");
  assert.throws(
    () => createCutOtioEditorialProfileV3(native, missingSecondViewLoss),
    v3Error("CUT_OTIO_PROFILE_V3_LOSS", /\.losses/u),
  );

  const retimedBody = mutable(baseBody());
  retimedBody.tracks[0].items[0].retime = {
    kind: "constant",
    direction: "forward",
    rate: rational(2),
  };
  retimedBody.tracks[0].items[0].source!.duration = rational(1, 50);
  retimedBody.tracks[0].items[1].retime = {
    kind: "constant",
    direction: "forward",
    rate: rational(2),
  };
  retimedBody.tracks[0].items[1].source = {
    start: rational(1, 50),
    duration: rational(1, 50),
  };
  const retimedNative = createCutOtioEditorialProfile(retimedBody);
  const retimedExtension = mutable(body(retimedNative));
  retimedExtension.baseProfileSemanticSha256 = retimedNative.semanticSha256;
  retimedExtension.audioOrigins[0].source.duration = rational(1, 25);
  retimedExtension.audioOrigins[0].originDuration = rational(1, 50);
  retimedExtension.audioOrigins[0].rate = rational(2);
  retimedExtension.audioOrigins[0].views[0].source.duration = rational(1, 50);
  retimedExtension.audioOrigins[0].views[1].source = {
    start: rational(1, 50),
    duration: rational(1, 50),
  };
  retimedExtension.audioOrigins[0].lineageSegments[0].source.duration =
    rational(1, 50);
  retimedExtension.audioOrigins[0].lineageSegments[1].source = {
    start: rational(1, 50),
    duration: rational(1, 50),
  };
  for (const lineage of retimedExtension.audioOrigins[0].lineageSegments) {
    rehashLineage(lineage);
  }
  retimedExtension.audioOrigins[0].views[0].lineageSha256 =
    retimedExtension.audioOrigins[0].lineageSegments[0].lineageSha256;
  retimedExtension.audioOrigins[0].views[1].lineageSha256 =
    retimedExtension.audioOrigins[0].lineageSegments[1].lineageSha256;
  assert.doesNotThrow(() => createCutOtioEditorialProfileV3(
    retimedNative,
    retimedExtension,
  ));

  const transitionBody = mutable(baseBody());
  transitionBody.transitions.push({
    id: "audio_transition",
    trackId: "dialogue",
    outgoingItemId: "line_a",
    incomingItemId: "line_b",
    cut: rational(1, 100),
    duration: rational(1, 250),
    overlap: { start: rational(1, 125), duration: rational(1, 250) },
    outgoingSource: { start: rational(1, 100), duration: rational(1, 500) },
    incomingSource: { start: rational(1, 125), duration: rational(1, 500) },
    mapping: { kind: "audio", curve: "equal-power" },
  });
  const transitionedNative = createCutOtioEditorialProfile(transitionBody);
  const transitionedExtension = mutable(body(transitionedNative));
  transitionedExtension.baseProfileSemanticSha256 =
    transitionedNative.semanticSha256;
  assert.throws(
    () => createCutOtioEditorialProfileV3(
      transitionedNative,
      transitionedExtension,
    ),
    v3Error("CUT_OTIO_PROFILE_V3_LOSS", /\.losses/u),
  );

  const nestedBody = mutable(baseBody());
  nestedBody.tracks.push({
    id: "picture",
    kind: "Video",
    order: 1,
    items: [{
      id: "nested_item",
      kind: "nested-sequence",
      order: 0,
      destination: { start: rational(0), duration: rational(1, 50) },
      source: { start: rational(0), duration: rational(1, 50) },
      link: unlinked,
      retime: identity,
      nesting: {
        instanceId: "nested_picture",
        compositionId: "nested",
        sourceRange: { start: rational(0), duration: rational(1, 50) },
        semanticSha256: "d".repeat(64),
        depth: 1,
        ancestry: ["main", "nested"],
      },
    }],
  } as never);
  const nestedNative = createCutOtioEditorialProfile(nestedBody);
  const nestedExtension = mutable(body(nestedNative));
  nestedExtension.baseProfileSemanticSha256 = nestedNative.semanticSha256;
  nestedExtension.audioOrigins[0].views[0].itemId = "nested_item";
  assert.throws(
    () => createCutOtioEditorialProfileV3(nestedNative, nestedExtension),
    v3Error("CUT_OTIO_PROFILE_V3_REFERENCE", /itemId/u),
  );
});

test("the V3 schema is closed and leaves the frozen V2 schema unchanged", () => {
  const v2 = JSON.parse(readFileSync(
    resolve(process.cwd(), "schemas/cut-otio-editorial-profile-v2.schema.json"),
    "utf8",
  ));
  const v3 = JSON.parse(readFileSync(
    resolve(process.cwd(), "schemas/cut-otio-editorial-profile-v3.schema.json"),
    "utf8",
  ));
  assert.equal(v2.$id, "urn:cut:schema:otio-editorial-profile:2");
  assert.equal(v2.properties.version.const, 2);
  assert.equal(v2.properties.audioOrigins, undefined);
  assert.equal(
    v3.$id,
    "urn:cut:schema:otio-editorial-profile-extension:3",
  );
  assert.equal(v3.additionalProperties, false);
  assert.equal(v3.properties.version.const, 3);
  assert.equal(v3.$defs.audioOrigin.additionalProperties, false);
  assert.equal(v3.$defs.audioView.additionalProperties, false);
  assert.equal(v3.$defs.audioLineageSegment.additionalProperties, false);
  assert.ok(v3.$defs.audioOrigin.required.includes("timelineEditPlanId"));
  assert.ok(v3.$defs.audioOrigin.required.includes("timelineEditOriginId"));
  assert.ok(v3.$defs.audioOrigin.required.includes("lineageSegments"));
  assert.deepEqual(v3.$defs.audioOrigin.properties.kind.enum, [
    "direct-audio",
    "processed-audio",
  ]);
});
