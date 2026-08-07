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
  CutOtioEditorialProfileV5Error,
  createCutOtioDirectMediaAuthority,
  createCutOtioEditorialProfileV5,
  cutOtioEditorialProfileV5ObservationFromProfile,
  reconcileCutOtioEditorialProfileV5,
  validateCutOtioEditorialProfileV5,
  type CutOtioDirectMediaAuthority,
  type CutOtioDirectMediaAuthorityBody,
  type CutOtioEditorialProfileV5Body,
} from "../lib/interchange/otio-editorial-profile-v5";
import {
  addRational,
  rational,
  subtractRational,
} from "../lib/language/rational";

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

function mutable<T>(value: T) {
  return structuredClone(value) as Mutable<T>;
}

const identity = Object.freeze({ kind: "identity" as const });

function nativeBody(): CutOtioEditorialProfileBody {
  const linked = (
    groupId: string,
    segmentId: string,
  ) => ({ kind: "linked" as const, groupId, segmentId });
  return {
    format: "cut-otio-editorial-profile",
    version: 2,
    compositionId: "main",
    duration: rational(8),
    tracks: [{
      id: "picture",
      kind: "Video",
      order: 0,
      role: "primary",
      metadata: { "org.example.track": "picture" },
      items: [{
        id: "picture_out",
        kind: "clip",
        order: 0,
        destination: { start: rational(0), duration: rational(4) },
        source: { start: rational(0), duration: rational(4) },
        link: linked("linked_av", "out"),
        retime: identity,
        nesting: null,
        role: "primary",
        metadata: { "org.example.item": "picture-out" },
      }, {
        id: "picture_in",
        kind: "clip",
        order: 1,
        destination: { start: rational(4), duration: rational(4) },
        source: { start: rational(10), duration: rational(4) },
        link: linked("linked_av", "in"),
        retime: identity,
        nesting: null,
      }],
    }, {
      id: "audio",
      kind: "Audio",
      order: 1,
      role: "dialogue",
      metadata: { "org.example.track": "dialogue" },
      items: [{
        id: "audio_out",
        kind: "clip",
        order: 0,
        destination: { start: rational(0), duration: rational(3) },
        source: { start: rational(0), duration: rational(3) },
        link: linked("linked_av", "out"),
        retime: identity,
        nesting: null,
        role: "dialogue",
        metadata: { "org.example.item": "audio-out" },
      }, {
        id: "audio_in",
        kind: "clip",
        order: 1,
        destination: { start: rational(3), duration: rational(5) },
        source: { start: rational(10), duration: rational(5) },
        link: linked("linked_av", "in"),
        retime: identity,
        nesting: null,
      }],
    }],
    linkGroups: [{
      id: "linked_av",
      kind: "linked-av",
      segments: [{
        id: "out",
        pictureItemId: "picture_out",
        audioItemId: "audio_out",
      }, {
        id: "in",
        pictureItemId: "picture_in",
        audioItemId: "audio_in",
      }],
    }],
    linkedCuts: [{
      id: "j_cut",
      kind: "j-cut",
      groupId: "linked_av",
      picture: {
        outgoingItemId: "picture_out",
        incomingItemId: "picture_in",
        at: rational(4),
      },
      audio: {
        outgoingItemId: "audio_out",
        incomingItemId: "audio_in",
        at: rational(3),
      },
    }],
    transitions: [{
      id: "picture_dissolve",
      trackId: "picture",
      outgoingItemId: "picture_out",
      incomingItemId: "picture_in",
      cut: rational(4),
      duration: rational(1),
      overlap: { start: rational(7, 2), duration: rational(1) },
      outgoingSource: { start: rational(4), duration: rational(1, 2) },
      incomingSource: { start: rational(19, 2), duration: rational(1, 2) },
      mapping: { kind: "picture", style: { kind: "cross-dissolve" } },
    }, {
      id: "audio_crossfade",
      trackId: "audio",
      outgoingItemId: "audio_out",
      incomingItemId: "audio_in",
      cut: rational(3),
      duration: rational(1, 2),
      overlap: { start: rational(11, 4), duration: rational(1, 2) },
      outgoingSource: { start: rational(3), duration: rational(1, 4) },
      incomingSource: { start: rational(39, 4), duration: rational(1, 4) },
      mapping: { kind: "audio", curve: "equal-power" },
    }],
    losses: [],
  };
}

function authority(
  input: Readonly<{
    itemId: string;
    trackId: string;
    mediaKind: "picture" | "audio";
    resourceId: string;
    resourceKind: "video" | "audio";
    sourceStart: number;
    sourceDuration: number;
    destinationStart: number;
    destinationDuration: number;
    head: ReturnType<typeof rational>;
    tail: ReturnType<typeof rational>;
    consumedHead: ReturnType<typeof rational>;
    consumedTail: ReturnType<typeof rational>;
    transitionId: string;
    role?: string;
    metadata?: Readonly<Record<string, string>>;
  }>,
): CutOtioDirectMediaAuthority {
  const source = {
    start: rational(input.sourceStart),
    duration: rational(input.sourceDuration),
  };
  const body: Omit<CutOtioDirectMediaAuthorityBody, "authorityId"> = {
    itemId: input.itemId,
    trackId: input.trackId,
    mediaKind: input.mediaKind,
    execution: "direct-media-no-processor-graph",
    resource: {
      id: input.resourceId,
      kind: input.resourceKind,
      sha256: (input.mediaKind === "picture" ? "a" : "b").repeat(64),
    },
    clock: input.mediaKind === "picture"
      ? {
          kind: "frame",
          streamIndex: 0,
          timeBase: rational(1, 24),
          rate: rational(24),
        }
      : {
          kind: "sample",
          streamIndex: 1,
          timeBase: rational(1, 48_000),
          rate: rational(48_000),
    },
    source,
    availableSource: {
      start: subtractRational(rational(input.sourceStart), input.head),
      duration: addRational(
        rational(input.sourceDuration),
        addRational(input.head, input.tail),
      ),
    },
    destination: {
      start: rational(input.destinationStart),
      duration: rational(input.destinationDuration),
    },
    declaredHandles: { head: input.head, tail: input.tail },
    consumedHandles: {
      head: input.consumedHead,
      tail: input.consumedTail,
    },
    retime: identity,
    link: {
      kind: "linked",
      groupId: "linked_av",
      segmentId: input.itemId.endsWith("_out") ? "out" : "in",
    },
    ...(input.role === undefined ? {} : { role: input.role }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    linkedCutIds: ["j_cut"],
    transitionIds: [input.transitionId],
  };
  return createCutOtioDirectMediaAuthority(body);
}

function body(
  base: ReturnType<typeof createCutOtioEditorialProfile>,
): CutOtioEditorialProfileV5Body {
  return {
    format: "cut-otio-editorial-direct-media-extension",
    version: 5,
    compositionId: base.compositionId,
    baseProfileSemanticSha256: base.semanticSha256,
    authorities: [
      authority({
        itemId: "picture_out",
        trackId: "picture",
        mediaKind: "picture",
        resourceId: "picture_asset",
        resourceKind: "video",
        sourceStart: 0,
        sourceDuration: 4,
        destinationStart: 0,
        destinationDuration: 4,
        head: rational(0),
        tail: rational(1, 2),
        consumedHead: rational(0),
        consumedTail: rational(1, 2),
        transitionId: "picture_dissolve",
        role: "primary",
        metadata: { "org.example.item": "picture-out" },
      }),
      authority({
        itemId: "picture_in",
        trackId: "picture",
        mediaKind: "picture",
        resourceId: "picture_asset",
        resourceKind: "video",
        sourceStart: 10,
        sourceDuration: 4,
        destinationStart: 4,
        destinationDuration: 4,
        head: rational(1, 2),
        tail: rational(0),
        consumedHead: rational(1, 2),
        consumedTail: rational(0),
        transitionId: "picture_dissolve",
      }),
      authority({
        itemId: "audio_out",
        trackId: "audio",
        mediaKind: "audio",
        resourceId: "audio_asset",
        resourceKind: "audio",
        sourceStart: 0,
        sourceDuration: 3,
        destinationStart: 0,
        destinationDuration: 3,
        head: rational(0),
        tail: rational(1, 4),
        consumedHead: rational(0),
        consumedTail: rational(1, 4),
        transitionId: "audio_crossfade",
        role: "dialogue",
        metadata: { "org.example.item": "audio-out" },
      }),
      authority({
        itemId: "audio_in",
        trackId: "audio",
        mediaKind: "audio",
        resourceId: "audio_asset",
        resourceKind: "audio",
        sourceStart: 10,
        sourceDuration: 5,
        destinationStart: 3,
        destinationDuration: 5,
        head: rational(1, 4),
        tail: rational(0),
        consumedHead: rational(1, 4),
        consumedTail: rational(0),
        transitionId: "audio_crossfade",
      }),
    ],
  };
}

function v5Error(code: CutOtioEditorialProfileV5Error["code"]) {
  return (error: unknown) =>
    error instanceof CutOtioEditorialProfileV5Error && error.code === code;
}

test("V5 binds exact direct-media availability beside unchanged V2/V3/V4 omission history", () => {
  const base = createCutOtioEditorialProfile(nativeBody());
  const before = cutOtioEditorialObservationFromProfile(base);
  const profile = createCutOtioEditorialProfileV5(base, body(base));
  assert.deepEqual(cutOtioEditorialObservationFromProfile(base), before);
  assert.equal(profile.authorities.length, 4);
  assert.ok(profile.authorities.every((entry) =>
    entry.execution === "direct-media-no-processor-graph"));
  assert.deepEqual(
    profile.authorities.map((entry) => entry.clock.kind),
    ["frame", "frame", "sample", "sample"],
  );
  assert.deepEqual(
    reconcileCutOtioEditorialProfileV5(
      base,
      profile,
      cutOtioEditorialProfileV5ObservationFromProfile(base, profile),
    ),
    {
      format: "cut-otio-editorial-direct-media-reconciliation",
      version: 1,
      status: "pass",
      semanticSha256: profile.semanticSha256,
      baseProfileSemanticSha256: base.semanticSha256,
      authorities: 4,
    },
  );
  assert.deepEqual(validateCutOtioEditorialProfileV5(base, profile), profile);
});

test("V5 fails closed on hash, resource, timing, declared/consumed-handle, and presentation mutation", () => {
  const base = createCutOtioEditorialProfile(nativeBody());
  const profile = createCutOtioEditorialProfileV5(base, body(base));
  const mutations: Array<readonly [
    (value: Mutable<typeof profile>) => void,
    CutOtioEditorialProfileV5Error["code"],
  ]> = [
    [(value) => { value.semanticSha256 = "f".repeat(64); }, "CUT_OTIO_PROFILE_V5_HASH"],
    [(value) => { value.authorities[0].resource.sha256 = "c".repeat(64); }, "CUT_OTIO_PROFILE_V5_HASH"],
    [(value) => { value.authorities[0].source.duration = rational(3); }, "CUT_OTIO_PROFILE_V5_HASH"],
    [(value) => { value.authorities[0].availableSource.duration = rational(5); }, "CUT_OTIO_PROFILE_V5_HASH"],
    [(value) => { value.authorities[0].declaredHandles.tail = rational(1); }, "CUT_OTIO_PROFILE_V5_HASH"],
    [(value) => { value.authorities[0].consumedHandles.tail = rational(1, 4); }, "CUT_OTIO_PROFILE_V5_HASH"],
    [(value) => { value.authorities[0].clock.streamIndex = 9; }, "CUT_OTIO_PROFILE_V5_HASH"],
  ];
  for (const [mutate, code] of mutations) {
    const candidate = mutable(profile);
    mutate(candidate);
    assert.throws(
      () => validateCutOtioEditorialProfileV5(base, candidate),
      v5Error(code),
    );
  }
});

test("V5 recomputes relationship laws after hashes are rebuilt", () => {
  const base = createCutOtioEditorialProfile(nativeBody());
  const original = body(base);
  const wrongConsumedBody = mutable(original);
  const wrong = mutable(wrongConsumedBody.authorities[0]);
  wrong.consumedHandles.tail = rational(1, 4);
  const {
    authorityId: _authorityId,
    authoritySha256: _authoritySha256,
    ...wrongBody
  } = wrong;
  wrongConsumedBody.authorities[0] =
    createCutOtioDirectMediaAuthority(
      wrongBody,
    ) as Mutable<CutOtioDirectMediaAuthority>;
  assert.throws(
    () => createCutOtioEditorialProfileV5(base, wrongConsumedBody),
    v5Error("CUT_OTIO_PROFILE_V5_TIMING"),
  );

  const wrongAvailableBody = mutable(original);
  const available = mutable(wrongAvailableBody.authorities[0]);
  available.availableSource.duration = rational(19, 4);
  const {
    authorityId: _availableId,
    authoritySha256: _availableSha,
    ...availableBody
  } = available;
  wrongAvailableBody.authorities[0] =
    createCutOtioDirectMediaAuthority(
      availableBody,
    ) as Mutable<CutOtioDirectMediaAuthority>;
  assert.throws(
    () => createCutOtioEditorialProfileV5(base, wrongAvailableBody),
    v5Error("CUT_OTIO_PROFILE_V5_TIMING"),
  );
});

test("V5 rejects unknown, duplicate, orphan, forged J/L, and processor-graph claims", () => {
  const base = createCutOtioEditorialProfile(nativeBody());
  const original = body(base);

  const unknown = mutable(original) as unknown as Record<string, unknown>;
  unknown.private = true;
  assert.throws(
    () => createCutOtioEditorialProfileV5(base, unknown),
    v5Error("CUT_OTIO_PROFILE_V5_UNKNOWN_FIELD"),
  );

  const duplicate = mutable(original);
  duplicate.authorities.push(duplicate.authorities[0]);
  assert.throws(
    () => createCutOtioEditorialProfileV5(base, duplicate),
    v5Error("CUT_OTIO_PROFILE_V5_DUPLICATE"),
  );

  const orphan = mutable(original);
  const orphanEntry = mutable(orphan.authorities[0]);
  orphanEntry.itemId = "missing_item";
  const {
    authorityId: _orphanId,
    authoritySha256: _orphanSha,
    ...orphanBody
  } = orphanEntry;
  orphan.authorities[0] = createCutOtioDirectMediaAuthority(
    orphanBody,
  ) as Mutable<CutOtioDirectMediaAuthority>;
  assert.throws(
    () => createCutOtioEditorialProfileV5(base, orphan),
    v5Error("CUT_OTIO_PROFILE_V5_REFERENCE"),
  );

  const wrongJl = mutable(original);
  const linked = mutable(wrongJl.authorities[0]);
  linked.linkedCutIds = [];
  const {
    authorityId: _linkedId,
    authoritySha256: _linkedSha,
    ...linkedBody
  } = linked;
  wrongJl.authorities[0] = createCutOtioDirectMediaAuthority(
    linkedBody,
  ) as Mutable<CutOtioDirectMediaAuthority>;
  assert.throws(
    () => createCutOtioEditorialProfileV5(base, wrongJl),
    v5Error("CUT_OTIO_PROFILE_V5_REFERENCE"),
  );

  const graphClaim = mutable(original);
  (graphClaim.authorities[0] as unknown as Record<string, unknown>).execution =
    "processed-graph";
  assert.throws(
    () => createCutOtioEditorialProfileV5(base, graphClaim),
    v5Error("CUT_OTIO_PROFILE_V5_TYPE"),
  );
});

test("V5 observation reconciliation rejects deterministic native mutations", () => {
  const base = createCutOtioEditorialProfile(nativeBody());
  const profile = createCutOtioEditorialProfileV5(base, body(base));
  const observation = mutable(
    cutOtioEditorialProfileV5ObservationFromProfile(base, profile),
  );
  observation.authorities.reverse();
  assert.throws(
    () => reconcileCutOtioEditorialProfileV5(base, profile, observation),
    v5Error("CUT_OTIO_PROFILE_V5_RECONCILIATION"),
  );
});

test("V5 rejects noncanonical rationals before relationship validation", () => {
  const base = createCutOtioEditorialProfile(nativeBody());
  const candidate = mutable(body(base)) as unknown as {
    authorities: Array<{
      source: { start: { numerator: string; denominator: string } };
    }>;
  };
  candidate.authorities[0].source.start = {
    numerator: "2",
    denominator: "2",
  };
  assert.throws(
    () => createCutOtioEditorialProfileV5(base, candidate),
    v5Error("CUT_OTIO_PROFILE_V5_RATIONAL"),
  );
});

test("V5 schema and implementation directories are part of the public package surface", () => {
  const schema = JSON.parse(readFileSync(
    resolve("schemas/cut-otio-editorial-profile-v5.schema.json"),
    "utf8",
  )) as {
    title: string;
    properties: {
      format: { const: string };
      version: { const: number };
      authorities: {
        items: { $ref: string };
      };
    };
    $defs: {
      authority: {
        properties: {
          execution: { const: string };
        };
      };
    };
  };
  const packageManifest = JSON.parse(readFileSync(
    resolve("package.json"),
    "utf8",
  )) as { files: string[] };
  assert.equal(
    schema.properties.format.const,
    "cut-otio-editorial-direct-media-extension",
  );
  assert.equal(schema.properties.version.const, 5);
  assert.equal(schema.properties.authorities.items.$ref, "#/$defs/authority");
  assert.equal(
    schema.$defs.authority.properties.execution.const,
    "direct-media-no-processor-graph",
  );
  assert.ok(packageManifest.files.includes("dist-cli/lib/interchange"));
  assert.ok(packageManifest.files.includes("schemas"));
  assert.ok(packageManifest.files.includes("docs"));
});
