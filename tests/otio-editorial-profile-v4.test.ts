import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  createCutOtioEditorialProfile,
  cutOtioEditorialObservationFromProfile,
  type CutOtioEditorialProfileBody,
} from "../lib/interchange/otio-editorial-profile";
import {
  CutOtioEditorialProfileV4Error,
  createCutOtioEditorialProfileV4,
  cutOtioEditorialNestedLineageSha256,
  cutOtioEditorialProfileV4ObservationFromProfile,
  reconcileCutOtioEditorialProfileV4,
  validateCutOtioEditorialProfileV4,
  type CutOtioEditorialNestedLineageSegment,
  type CutOtioEditorialProfileV4Body,
} from "../lib/interchange/otio-editorial-profile-v4";
import { rational } from "../lib/language/rational";

const identity = Object.freeze({ kind: "identity" as const });
const unlinked = Object.freeze({ kind: "unlinked" as const });

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

function mutable<T>(value: T) {
  return structuredClone(value) as Mutable<T>;
}

function nativeBody(): CutOtioEditorialProfileBody {
  return {
    format: "cut-otio-editorial-profile",
    version: 2,
    compositionId: "main",
    duration: rational(4),
    tracks: [{
      id: "picture",
      kind: "Video",
      order: 0,
      items: ["nested_source", "inserted_nested", "nested_body", "overwritten_nested"]
        .map((id, order) => ({
          id,
          kind: "nested-sequence" as const,
          order,
          destination: { start: rational(order), duration: rational(1) },
          source: { start: rational(0), duration: rational(1) },
          link: unlinked,
          retime: identity,
          nesting: {
            instanceId: `${id}_instance`,
            compositionId: "nested",
            sourceRange: { start: rational(0), duration: rational(1) },
            semanticSha256: String(order + 1).repeat(64),
            depth: 1,
            ancestry: ["main", "nested"],
          },
        })),
    }],
    linkGroups: [],
    linkedCuts: [],
    transitions: [],
    losses: [],
  };
}

const lineageDefinitions = [
  {
    segmentId: "segment_source",
    originId: "nested_source",
    destination: { start: rational(0), duration: rational(1) },
    role: "graphics",
    metadata: { "org.example.stage": "source" },
  },
  {
    segmentId: "segment_inserted",
    parentSegmentId: "segment_source",
    originId: "nested_source",
    destination: { start: rational(1), duration: rational(1) },
    role: "graphics",
    metadata: {
      "org.example.stage": "insert",
      "org.example.source": "source",
    },
  },
  {
    segmentId: "segment_body",
    parentSegmentId: "segment_source",
    originId: "nested_source",
    destination: { start: rational(2), duration: rational(1) },
    role: "b-roll",
    metadata: { "org.example.stage": "body" },
  },
  {
    segmentId: "segment_overwritten",
    parentSegmentId: "segment_body",
    originId: "nested_source",
    destination: { start: rational(3), duration: rational(1) },
    role: "graphics",
    metadata: {
      "org.example.stage": "overwrite",
      "org.example.source": "source",
    },
  },
] as const;

function lineage(
  definition: typeof lineageDefinitions[number],
): CutOtioEditorialNestedLineageSegment {
  const semantic = {
    planId: "timeline_edit",
    trackId: "picture",
    originId: definition.originId,
    segmentId: definition.segmentId,
    ...("parentSegmentId" in definition
      ? { parentSegmentId: definition.parentSegmentId }
      : {}),
    compositionId: "nested",
    sourceAuthorityId: "a".repeat(64),
    placementPolicy: "static-same-track-copy" as const,
    source: { start: rational(0), duration: rational(1) },
    destination: definition.destination,
    role: definition.role,
    metadata: definition.metadata,
  };
  return {
    ...semantic,
    lineageSha256: cutOtioEditorialNestedLineageSha256(semantic),
  };
}

function v4Body(
  base: ReturnType<typeof createCutOtioEditorialProfile>,
): CutOtioEditorialProfileV4Body {
  const lineageSegments = lineageDefinitions.map(lineage);
  const itemIds = [
    "nested_source",
    "inserted_nested",
    "nested_body",
    "overwritten_nested",
  ];
  return {
    format: "cut-otio-editorial-nested-placement-extension",
    version: 4,
    compositionId: base.compositionId,
    baseProfileSemanticSha256: base.semanticSha256,
    lineageSegments,
    placements: lineageSegments.map((segment, index) => ({
      itemId: itemIds[index],
      trackId: "picture",
      segmentId: segment.segmentId,
      nestingInstanceId: `${itemIds[index]}_instance`,
      source: segment.source,
      destination: segment.destination,
      role: segment.role,
      metadata: segment.metadata,
      lineageSha256: segment.lineageSha256,
    })),
  };
}

function v4Error(code: CutOtioEditorialProfileV4Error["code"]) {
  return (error: unknown) =>
    error instanceof CutOtioEditorialProfileV4Error && error.code === code;
}

test("V4 binds multiple TimelineEdit nested placements beside unchanged V2/V3 history", () => {
  const base = createCutOtioEditorialProfile(nativeBody());
  const before = cutOtioEditorialObservationFromProfile(base);
  const profile = createCutOtioEditorialProfileV4(base, v4Body(base));

  assert.deepEqual(cutOtioEditorialObservationFromProfile(base), before);
  assert.equal(profile.placements.length, 4);
  assert.deepEqual(
    profile.placements.map(({ itemId, role, metadata }) => ({
      itemId,
      role,
      metadata,
    })),
    [
      {
        itemId: "nested_source",
        role: "graphics",
        metadata: { "org.example.stage": "source" },
      },
      {
        itemId: "inserted_nested",
        role: "graphics",
        metadata: {
          "org.example.source": "source",
          "org.example.stage": "insert",
        },
      },
      {
        itemId: "nested_body",
        role: "b-roll",
        metadata: { "org.example.stage": "body" },
      },
      {
        itemId: "overwritten_nested",
        role: "graphics",
        metadata: {
          "org.example.source": "source",
          "org.example.stage": "overwrite",
        },
      },
    ],
  );
  assert.deepEqual(validateCutOtioEditorialProfileV4(base, profile), profile);
  const observation =
    cutOtioEditorialProfileV4ObservationFromProfile(base, profile);
  assert.deepEqual(
    reconcileCutOtioEditorialProfileV4(base, profile, observation),
    {
      format: "cut-otio-editorial-nested-placement-reconciliation",
      version: 1,
      status: "pass",
      semanticSha256: profile.semanticSha256,
      baseProfileSemanticSha256: base.semanticSha256,
      lineageSegments: 4,
      placements: 4,
    },
  );
});

test("V4 refuses base, lineage, authority, timing, role, metadata, and native-observation tampering", () => {
  const base = createCutOtioEditorialProfile(nativeBody());
  const validBody = v4Body(base);
  const profile = createCutOtioEditorialProfileV4(base, validBody);

  const wrongBase = mutable(validBody);
  wrongBase.baseProfileSemanticSha256 = "f".repeat(64);
  assert.throws(
    () => createCutOtioEditorialProfileV4(base, wrongBase),
    v4Error("CUT_OTIO_PROFILE_V4_REFERENCE"),
  );

  for (const mutation of [
    (value: Mutable<CutOtioEditorialProfileV4Body>) => {
      value.lineageSegments[1].parentSegmentId = "missing";
    },
    (value: Mutable<CutOtioEditorialProfileV4Body>) => {
      value.lineageSegments[1].sourceAuthorityId = "b".repeat(64);
    },
    (value: Mutable<CutOtioEditorialProfileV4Body>) => {
      value.lineageSegments[1].placementPolicy = "structural-only";
    },
    (value: Mutable<CutOtioEditorialProfileV4Body>) => {
      value.placements[1].destination.start = rational(3, 2);
    },
    (value: Mutable<CutOtioEditorialProfileV4Body>) => {
      value.placements[1].role = "overlay";
    },
    (value: Mutable<CutOtioEditorialProfileV4Body>) => {
      value.placements[1].metadata = { "org.example.stage": "forged" };
    },
  ]) {
    const forged = mutable(validBody);
    mutation(forged);
    assert.throws(
      () => createCutOtioEditorialProfileV4(base, forged),
      (error: unknown) => error instanceof CutOtioEditorialProfileV4Error,
    );
  }

  const forgedProfile = mutable(profile);
  forgedProfile.semanticSha256 = "0".repeat(64);
  assert.throws(
    () => validateCutOtioEditorialProfileV4(base, forgedProfile),
    v4Error("CUT_OTIO_PROFILE_V4_HASH"),
  );

  const observation =
    cutOtioEditorialProfileV4ObservationFromProfile(base, profile);
  const forgedObservation = mutable(observation);
  forgedObservation.placements[1].metadata = {
    "org.example.stage": "forged-native",
  };
  assert.throws(
    () => reconcileCutOtioEditorialProfileV4(
      base,
      profile,
      forgedObservation,
    ),
    v4Error("CUT_OTIO_PROFILE_V4_RECONCILIATION"),
  );
});

test("the V4 schema is closed without changing the V2 or V3 format", () => {
  const v2 = JSON.parse(readFileSync(
    resolve(process.cwd(), "schemas/cut-otio-editorial-profile-v2.schema.json"),
    "utf8",
  ));
  const v3 = JSON.parse(readFileSync(
    resolve(process.cwd(), "schemas/cut-otio-editorial-profile-v3.schema.json"),
    "utf8",
  ));
  const v4 = JSON.parse(readFileSync(
    resolve(process.cwd(), "schemas/cut-otio-editorial-profile-v4.schema.json"),
    "utf8",
  ));
  assert.equal(v2.properties.version.const, 2);
  assert.equal(v2.properties.placements, undefined);
  assert.equal(v3.properties.version.const, 3);
  assert.equal(v3.properties.placements, undefined);
  assert.equal(
    v4.$id,
    "urn:cut:schema:otio-editorial-nested-placement-extension:4",
  );
  assert.equal(v4.properties.version.const, 4);
  assert.equal(v4.additionalProperties, false);
  assert.equal(v4.$defs.lineageSegment.additionalProperties, false);
  assert.deepEqual(
    v4.$defs.lineageSegment.properties.placementPolicy.enum,
    ["structural-only", "static-same-track-copy"],
  );
  assert.equal(v4.$defs.placement.additionalProperties, false);
});
