import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import Ajv from "ajv";
import type { CutAVIR, IRComposition, IRNode, IRResource, IRScene } from "../lib/language/ir";
import { rational, type Rational } from "../lib/language/rational";
import {
  prepareReferencePlanarTrack,
  referencePlanarTrackAt,
  referencePlanarTrackConfig,
  referencePlanarTrackLimits,
  ReferencePlanarTrackError,
  validateReferencePlanarTrackResourceOwnership,
  validateReferencePlanarTrackResources,
} from "../lib/runtime/reference/planar-tracking";

type JsonRational = { numerator: string; denominator: string };
type JsonPoint = { x: JsonRational; y: JsonRational };
type JsonQuad = { topLeft: JsonPoint; topRight: JsonPoint; bottomRight: JsonPoint; bottomLeft: JsonPoint };
type JsonSample = {
  at: JsonRational;
  confidence: JsonRational;
  status: "visible" | "occluded" | "out-of-frame";
  corners: JsonQuad;
};

const q = (numerator: number | string, denominator: number | string = 1): JsonRational => ({
  numerator: String(numerator),
  denominator: String(denominator),
});
const point = (x: number | string | JsonRational, y: number | string | JsonRational): JsonPoint => ({
  x: typeof x === "object" ? x : q(x),
  y: typeof y === "object" ? y : q(y),
});
const rectangle = (left: number, top: number, right: number, bottom: number): JsonQuad => ({
  topLeft: point(left, top),
  topRight: point(right, top),
  bottomRight: point(right, bottom),
  bottomLeft: point(left, bottom),
});

function sidecar(samples?: JsonSample[], width = 100, height = 80) {
  return {
    format: "cut-planar-track",
    version: 1,
    coordinateSpace: "composition-pixel-edges",
    width,
    height,
    samples: samples ?? [
      { at: q(0), confidence: q(1), status: "visible" as const, corners: rectangle(10, 10, 30, 30) },
      { at: q(1), confidence: q(1), status: "visible" as const, corners: rectangle(30, 20, 50, 40) },
    ],
  };
}

const span = { start: { offset: 10, line: 7, column: 3 }, end: { offset: 20, line: 7, column: 13 } };
const provenance = { module: "fixtures/planar.cut", span };

type ContextOptions = {
  width?: number;
  height?: number;
  duration?: Rational;
  interpolation?: "linear" | "hold";
  minConfidence?: Rational;
  lowConfidence?: "fail" | "hold" | "hide";
  occluded?: "fail" | "hold" | "hide";
  outOfFrame?: "fail" | "hold" | "hide";
  authoredOpacity?: Rational;
  locked?: boolean;
  sha256?: string;
  nodeId?: string;
  sourceId?: string;
};

function bytesOf(value: object | string | Uint8Array) {
  if (value instanceof Uint8Array) return value;
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
}

function context(value: object | string | Uint8Array = sidecar(), options: ContextOptions = {}) {
  const bytes = bytesOf(value), width = options.width ?? 100, height = options.height ?? 80;
  const nodeId = options.nodeId ?? "planar", sourceId = options.sourceId ?? "tracking";
  const duration = options.duration ?? rational(1);
  const ratio = (magnitude: Rational) => ({ kind: "quantity" as const, dimension: "ratio", magnitude, unit: "ratio" });
  const node: IRNode = {
    id: nodeId,
    op: "cut.visual.planar_track",
    domain: "visual",
    ownership: "root",
    sceneId: "scene",
    interval: { start: rational(0), duration },
    inputs: {
      source: { kind: "resource-ref", id: sourceId },
      minConfidence: ratio(options.minConfidence ?? rational(1, 2)),
      lowConfidence: { kind: "string", value: options.lowConfidence ?? "hold" },
      occluded: { kind: "string", value: options.occluded ?? "hold" },
      outOfFrame: { kind: "string", value: options.outOfFrame ?? "hide" },
      interpolation: { kind: "string", value: options.interpolation ?? "linear" },
      opacity: ratio(options.authoredOpacity ?? rational(1)),
    },
    children: ["local"],
    properties: {},
    effects: [],
    contentHash: "planar-content",
    provenance,
  };
  const composition: IRComposition = {
    id: "main",
    name: "main",
    width,
    height,
    fps: rational(24),
    sampleRate: 48_000,
    duration,
    sceneIds: ["scene"],
    rootVisualIds: [nodeId],
    rootAudioIds: [],
    rootAVIds: [],
    items: [{ kind: "scene", id: "scene" }],
    provenance,
  };
  const scene: IRScene = {
    id: "scene",
    name: "scene",
    start: rational(0),
    duration,
    rootVisualIds: [nodeId],
    rootAudioIds: [],
    rootAVIds: [],
    items: [{ id: nodeId, domain: "visual" }],
    provenance,
  };
  const resource: IRResource = {
    id: sourceId,
    name: sourceId,
    kind: "data",
    locator: `assets/${sourceId}.planar-track.json`,
    state: options.locked === false ? "unlocked" : "locked",
    ...(options.locked === false ? {} : { sha256: options.sha256 ?? createHash("sha256").update(bytes).digest("hex") }),
    metadata: { bytes: bytes.byteLength },
    provenance,
  };
  const ir: CutAVIR = {
    format: "cut-av-ir",
    version: 3,
    language: "0.4",
    compiler: "test",
    project: "unrelated product insert",
    sourceHash: "source",
    buildId: "build",
    determinism: { semantic: resource.state, decodedMedia: "unverified", bitstream: "unverified" },
    timebase: { defaultFps: rational(24), audioSampleRate: 48_000 },
    modules: [],
    resources: { [sourceId]: resource },
    compositions: [composition],
    scenes: { scene },
    nodes: { [nodeId]: node },
    signals: {},
    jobs: [],
    outputs: [],
    assertions: [],
  };
  const config = referencePlanarTrackConfig(ir, node);
  assert.ok(config);
  return { bytes, ir, node, composition, config };
}

function prepare(value: object | string | Uint8Array = sidecar(), options: ContextOptions = {}) {
  const fixture = context(value, options);
  return { ...fixture, prepared: prepareReferencePlanarTrack(fixture.ir, fixture.node, fixture.config, fixture.composition, fixture.bytes) };
}

function expectPrepareError(
  value: object | string | Uint8Array,
  code: ReferencePlanarTrackError["code"],
  message?: RegExp,
  options: ContextOptions = {},
) {
  const fixture = context(value, options);
  assert.throws(
    () => prepareReferencePlanarTrack(fixture.ir, fixture.node, fixture.config, fixture.composition, fixture.bytes),
    (error: unknown) => error instanceof ReferencePlanarTrackError
      && error.code === code
      && error.source.module === "fixtures/planar.cut"
      && error.source.line === 7
      && error.source.column === 3
      && (!message || message.test(error.message)),
  );
}

test("closed schema, locked preparation, and deterministic identities are exact", async () => {
  const schema = JSON.parse(await (await import("node:fs/promises")).readFile("schemas/cut-planar-track-v1.schema.json", "utf8")) as object;
  const validate = new Ajv({ schemaId: "auto", meta: false, validateSchema: false, allErrors: true, jsonPointers: true }).compile(schema);
  assert.equal(validate(sidecar()), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...sidecar(), privateSolver: "hidden" }), false);
  assert.equal(validate({ ...sidecar(), samples: sidecar().samples.map((sample, index) => index ? sample : {
    ...sample,
    corners: { ...sample.corners, topLeft: { ...sample.corners.topLeft, privateWarp: true } },
  }) }), false);
  assert.equal(validate({ ...sidecar(), samples: sidecar().samples.map((sample, index) => index ? sample : {
    ...sample,
    at: q("-0"),
  }) }), false);

  const first = prepare(), second = prepare();
  assert.equal(first.prepared.coordinateSpace, "composition-pixel-edges");
  assert.equal(first.prepared.sourceResource.sha256, createHash("sha256").update(first.bytes).digest("hex"));
  assert.equal(first.prepared.preparationIdentity, second.prepared.preparationIdentity);
  assert.equal(first.prepared.samples[0]!.sidecarSampleIdentity, second.prepared.samples[0]!.sidecarSampleIdentity);

  const changed = sidecar();
  changed.samples[1] = { ...changed.samples[1]!, corners: rectangle(31, 20, 51, 40) };
  assert.notEqual(first.prepared.preparationIdentity, prepare(changed).prepared.preparationIdentity);
});

test("exact interpolation returns canonical Q16 geometry, pixel-center-tight bounds, and a bound kernel plan", () => {
  const fixture = prepare();
  const sampled = referencePlanarTrackAt(fixture.node, fixture.prepared, fixture.config, rational(1, 2), {
    sourceWidth: 20,
    sourceHeight: 20,
    opacity: rational(3, 4),
  });
  assert.equal(sampled.hidden, false);
  if (sampled.hidden) return;
  assert.equal(sampled.resolution.classification, "linear-visible");
  assert.deepEqual(sampled.resolution.progress, rational(1, 2));
  assert.deepEqual(sampled.quad.topLeft, { x: rational(20), y: rational(15) });
  assert.deepEqual(sampled.quadQ16, [
    { x: String(20 * 65_536), y: String(15 * 65_536) },
    { x: String(40 * 65_536), y: String(15 * 65_536) },
    { x: String(40 * 65_536), y: String(35 * 65_536) },
    { x: String(20 * 65_536), y: String(35 * 65_536) },
  ]);
  assert.deepEqual(sampled.destinationBounds, { left: 20, top: 15, right: 40, bottom: 35 });
  assert.deepEqual(sampled.projectivePlan.source, { width: 20, height: 20, pixels: 400, rgbaBytes: 1_600 });
  assert.equal(sampled.projectivePlan.planIdentity.length, 64);
  assert.deepEqual(sampled.opacity, rational(3, 4));
  const repeated = referencePlanarTrackAt(fixture.node, fixture.prepared, fixture.config, rational(1, 2), {
    sourceWidth: 20,
    sourceHeight: 20,
    opacity: rational(3, 4),
  });
  assert.equal(repeated.sampleIdentity, sampled.sampleIdentity);
});

test("signed exact-Q16 ties match Math.round and clipping never allocates impossible edge columns", () => {
  const tied: JsonQuad = {
    topLeft: point(q(-1, 131_072), q(-3, 131_072)),
    topRight: point(10, 0),
    bottomRight: point(10, 10),
    bottomLeft: point(0, 10),
  };
  const fixture = prepare(sidecar([
    { at: q(0), confidence: q(1), status: "visible", corners: tied },
    { at: q(1), confidence: q(1), status: "visible", corners: tied },
  ]));
  assert.deepEqual(fixture.prepared.samples[0]!.quadQ16[0], { x: "0", y: "-1" }, "-0.5 phase rounds to 0 and -1.5 phases rounds to -1");
  const sampled = referencePlanarTrackAt(fixture.node, fixture.prepared, fixture.config, rational(0), {
    sourceWidth: 10,
    sourceHeight: 10,
    opacity: rational(1),
  });
  assert.equal(sampled.hidden, false);
  if (!sampled.hidden) assert.deepEqual(sampled.destinationBounds, { left: 0, top: 0, right: 10, bottom: 10 });
});

test("policies hold, hide, fail, and refuse interpolation toward an unusable right endpoint", () => {
  const observations: JsonSample[] = [
    { at: q(0), confidence: q(1), status: "visible", corners: rectangle(10, 10, 30, 30) },
    { at: q(1, 2), confidence: q(1), status: "occluded", corners: rectangle(40, 10, 60, 30) },
    { at: q(3, 4), confidence: q(1), status: "out-of-frame", corners: rectangle(-40, 10, -20, 30) },
    { at: q(1), confidence: q(1, 4), status: "visible", corners: rectangle(70, 10, 90, 30) },
  ];
  const fixture = prepare(sidecar(observations));
  const beforeOcclusion = referencePlanarTrackAt(fixture.node, fixture.prepared, fixture.config, rational(1, 4), {
    sourceWidth: 20,
    sourceHeight: 20,
    opacity: rational(1),
  });
  assert.equal(beforeOcclusion.hidden, false);
  assert.equal(beforeOcclusion.resolution.classification, "held-before-unusable-right");
  if (!beforeOcclusion.hidden) assert.deepEqual(beforeOcclusion.quad.topLeft, { x: rational(10), y: rational(10) });

  const held = referencePlanarTrackAt(fixture.node, fixture.prepared, fixture.config, rational(1, 2), {
    sourceWidth: 20,
    sourceHeight: 20,
    opacity: rational(1),
  });
  assert.equal(held.hidden, false);
  assert.equal(held.resolution.classification, "policy-held");
  assert.equal(held.resolution.selectedSampleIndex, 0);

  const hidden = referencePlanarTrackAt(fixture.node, fixture.prepared, fixture.config, rational(3, 4), {
    sourceWidth: 20,
    sourceHeight: 20,
    opacity: rational(1),
  });
  assert.equal(hidden.hidden, true);
  if (hidden.hidden) {
    assert.deepEqual(hidden.skip, { classification: "tracking-policy-hidden", reason: "out-of-frame" });
    assert.deepEqual(hidden.work, { projectivePlans: 0, destinationPixels: 0, destinationRgbaBytes: 0 });
  }

  const failing = prepare(sidecar(observations), { occluded: "fail" });
  assert.throws(
    () => referencePlanarTrackAt(failing.node, failing.prepared, failing.config, rational(1, 2), {
      sourceWidth: 20,
      sourceHeight: 20,
      opacity: rational(1),
    }),
    (error: unknown) => error instanceof ReferencePlanarTrackError
      && error.code === "CUT_PLANAR_TRACK_SAMPLE"
      && error.source.line === 7
      && /occluded/u.test(error.message),
  );
});

test("the complete low-confidence, occluded, and out-of-frame policy matrix is exact", () => {
  const issues = [
    {
      reason: "low-confidence" as const,
      sample: { at: q(1), confidence: q(1, 4), status: "visible" as const, corners: rectangle(40, 10, 60, 30) },
      option: "lowConfidence" as const,
    },
    {
      reason: "occluded" as const,
      sample: { at: q(1), confidence: q(1), status: "occluded" as const, corners: rectangle(40, 10, 60, 30) },
      option: "occluded" as const,
    },
    {
      reason: "out-of-frame" as const,
      sample: { at: q(1), confidence: q(1), status: "out-of-frame" as const, corners: rectangle(-40, 10, -20, 30) },
      option: "outOfFrame" as const,
    },
  ];
  for (const issue of issues) {
    for (const action of ["hold", "hide", "fail"] as const) {
      const options: ContextOptions = { [issue.option]: action };
      const fixture = prepare(sidecar([
        { at: q(0), confidence: q(1), status: "visible", corners: rectangle(10, 10, 30, 30) },
        issue.sample,
      ]), options);
      const execute = () => referencePlanarTrackAt(fixture.node, fixture.prepared, fixture.config, rational(1), {
        sourceWidth: 20,
        sourceHeight: 20,
        opacity: rational(1),
      });
      if (action === "fail") {
        assert.throws(execute, (error: unknown) => error instanceof ReferencePlanarTrackError
          && error.code === "CUT_PLANAR_TRACK_SAMPLE"
          && error.message.includes(issue.reason));
      } else {
        const result = execute();
        assert.equal(result.hidden, action === "hide", `${issue.reason}:${action}`);
        assert.equal(result.resolution.policy?.reason, issue.reason);
        assert.equal(result.resolution.policy?.action, action);
        if (action === "hold") assert.equal(result.resolution.selectedSampleIndex, 0);
        if (action === "hide" && result.hidden) assert.equal(result.skip.reason, issue.reason);
      }
    }
  }
});

test("hold without prior usable evidence and invalid interpolation geometry fail closed", () => {
  const noPrior = prepare(sidecar([
    { at: q(0), confidence: q(1, 4), status: "visible", corners: rectangle(10, 10, 30, 30) },
    { at: q(1), confidence: q(1), status: "visible", corners: rectangle(30, 10, 50, 30) },
  ]));
  assert.throws(
    () => referencePlanarTrackAt(noPrior.node, noPrior.prepared, noPrior.config, rational(0), {
      sourceWidth: 20,
      sourceHeight: 20,
      opacity: rational(1),
    }),
    (error: unknown) => error instanceof ReferencePlanarTrackError && error.code === "CUT_PLANAR_TRACK_HOLD_EMPTY",
  );

  const normal: JsonQuad = {
    topLeft: point(q(21, 2), q(21, 2)),
    topRight: point(q(61, 2), q(21, 2)),
    bottomRight: point(q(61, 2), q(61, 2)),
    bottomLeft: point(q(21, 2), q(61, 2)),
  };
  const anisotropicHalfTurn: JsonQuad = {
    topLeft: point(q(81, 2), q(51, 2)),
    topRight: point(q(1, 2), q(51, 2)),
    bottomRight: point(q(1, 2), q(31, 2)),
    bottomLeft: point(q(81, 2), q(31, 2)),
  };
  const collapsing = prepare(sidecar([
    { at: q(0), confidence: q(1), status: "visible", corners: normal },
    { at: q(1), confidence: q(1), status: "visible", corners: anisotropicHalfTurn },
  ]));
  assert.throws(
    () => referencePlanarTrackAt(collapsing.node, collapsing.prepared, collapsing.config, rational(1, 3), {
      sourceWidth: 20,
      sourceHeight: 20,
      opacity: rational(1),
    }),
    (error: unknown) => error instanceof ReferencePlanarTrackError
      && error.code === "CUT_PLANAR_TRACK_GEOMETRY"
      && /Q16 planar quad/u.test(error.message),
  );

  const retainedDuringOcclusion = prepare(sidecar([
    { at: q(0), confidence: q(1), status: "visible", corners: rectangle(10, 10, 30, 30) },
    {
      at: q(1),
      confidence: q(1),
      status: "occluded",
      corners: { topLeft: point(0, 0), topRight: point(0, 0), bottomRight: point(0, 0), bottomLeft: point(0, 0) },
    },
  ]));
  const retained = referencePlanarTrackAt(
    retainedDuringOcclusion.node,
    retainedDuringOcclusion.prepared,
    retainedDuringOcclusion.config,
    rational(1),
    { sourceWidth: 20, sourceHeight: 20, opacity: rational(1) },
  );
  assert.equal(retained.hidden, false, "occluded samples may retain bounded non-usable corners because hold resolves an earlier valid plane");
  assert.equal(retained.resolution.classification, "policy-held");
});

test("dynamic evaluated opacity is validated, changes identity, and produces an honest zero-work skip", () => {
  const fixture = prepare();
  const opaque = referencePlanarTrackAt(fixture.node, fixture.prepared, fixture.config, rational(0), {
    sourceWidth: 20,
    sourceHeight: 20,
    opacity: rational(1),
  });
  const half = referencePlanarTrackAt(fixture.node, fixture.prepared, fixture.config, rational(0), {
    sourceWidth: 20,
    sourceHeight: 20,
    opacity: rational(1, 2),
  });
  const zero = referencePlanarTrackAt(fixture.node, fixture.prepared, fixture.config, rational(0), {
    sourceWidth: 20,
    sourceHeight: 20,
    opacity: rational(0),
  });
  assert.notEqual(opaque.sampleIdentity, half.sampleIdentity);
  assert.notEqual(half.sampleIdentity, zero.sampleIdentity);
  assert.equal(zero.hidden, true);
  if (zero.hidden) {
    assert.deepEqual(zero.skip, { classification: "owner-opacity", reason: "opacity-zero" });
    assert.equal(zero.work.projectivePlans, 0);
  }
  for (const opacity of [{ numerator: "2", denominator: "1" }, { numerator: "2", denominator: "4" }, { numerator: "-0", denominator: "1" }]) {
    assert.throws(
      () => referencePlanarTrackAt(fixture.node, fixture.prepared, fixture.config, rational(0), {
        sourceWidth: 20,
        sourceHeight: 20,
        opacity,
      }),
      (error: unknown) => error instanceof ReferencePlanarTrackError
        && (error.code === "CUT_PLANAR_TRACK_RANGE" || error.code === "CUT_PLANAR_TRACK_INPUT_TYPE"),
    );
  }
});

test("hostile bytes, closed keys, exact times, dimensions, and Q16 geometry are source-located", () => {
  expectPrepareError(new Uint8Array(referencePlanarTrackLimits.maxBytes + 1), "CUT_PLANAR_TRACK_LIMIT", /1 through/u);
  expectPrepareError(new Uint8Array([0xc3, 0x28]), "CUT_PLANAR_TRACK_JSON", /UTF-8/u);
  expectPrepareError(
    '{"format":"cut-planar-track","format":"cut-planar-track","version":1,"coordinateSpace":"composition-pixel-edges","width":100,"height":80,"samples":[]}',
    "CUT_PLANAR_TRACK_JSON",
    /duplicate decoded/u,
  );
  expectPrepareError({ ...sidecar(), unknown: true }, "CUT_PLANAR_TRACK_SCHEMA", /unknown/u);
  expectPrepareError({ ...sidecar(), samples: sidecar().samples.map((sample, index) => index ? sample : {
    ...sample,
    corners: { ...sample.corners, topLeft: { ...sample.corners.topLeft, shader: "private" } },
  }) }, "CUT_PLANAR_TRACK_SCHEMA", /shader/u);
  expectPrepareError({ ...sidecar(), samples: sidecar().samples.map((sample, index) => index ? sample : { ...sample, at: q("-0") }) }, "CUT_PLANAR_TRACK_SCHEMA", /canonical/u);
  expectPrepareError({ ...sidecar(), samples: sidecar().samples.map((sample, index) => index ? sample : { ...sample, confidence: q(2, 4) }) }, "CUT_PLANAR_TRACK_SCHEMA", /lowest terms/u);
  expectPrepareError({ ...sidecar(), width: 101 }, "CUT_PLANAR_TRACK_DIMENSIONS", /101×80/u);
  expectPrepareError({ ...sidecar(), samples: sidecar().samples.map((sample, index) => index ? { ...sample, at: q(0) } : sample) }, "CUT_PLANAR_TRACK_TIME", /strictly later/u);
  expectPrepareError({ ...sidecar(), samples: [sidecar().samples[0]!, { ...sidecar().samples[1]!, at: q(3, 4) }] }, "CUT_PLANAR_TRACK_TIME", /complete node-local/u);
  expectPrepareError(sidecar(), "CUT_PLANAR_TRACK_RESOURCE", /bytes changed/u, { sha256: "0".repeat(64) });

  const reversed: JsonQuad = {
    topLeft: point(10, 10),
    topRight: point(10, 30),
    bottomRight: point(30, 30),
    bottomLeft: point(30, 10),
  };
  expectPrepareError(sidecar([
    { at: q(0), confidence: q(1), status: "visible", corners: reversed },
    { at: q(1), confidence: q(1), status: "visible", corners: reversed },
  ]), "CUT_PLANAR_TRACK_GEOMETRY", /winding/u);
  expectPrepareError(sidecar([
    { at: q(0), confidence: q(1), status: "visible", corners: rectangle(-40, 10, -20, 30) },
    { at: q(1), confidence: q(1), status: "visible", corners: rectangle(-40, 10, -20, 30) },
  ]), "CUT_PLANAR_TRACK_GEOMETRY", /intersection/u);
  expectPrepareError(sidecar([
    { at: q(0), confidence: q(1), status: "visible", corners: rectangle(10, 10, 30, 30) },
    { at: q(1), confidence: q(1), status: "visible", corners: rectangle(131_073, 10, 131_093, 30) },
  ]), "CUT_PLANAR_TRACK_RANGE", /finite bound/u);

  const deep = JSON.stringify({ ...sidecar(), nested: Array.from({ length: referencePlanarTrackLimits.maxJsonDepth + 2 }).reduce((value) => [value], 0) });
  expectPrepareError(deep, "CUT_PLANAR_TRACK_LIMIT", /depth/u);

  const giantKey = "x".repeat(100_000);
  for (const [hostile, code] of [
    [`{"${giantKey}":0,"${giantKey}":1}`, "CUT_PLANAR_TRACK_JSON"],
    [{ ...sidecar(), [giantKey]: true }, "CUT_PLANAR_TRACK_SCHEMA"],
  ] as const) {
    const fixture = context(hostile);
    assert.throws(
      () => prepareReferencePlanarTrack(fixture.ir, fixture.node, fixture.config, fixture.composition, fixture.bytes),
      (error: unknown) => error instanceof ReferencePlanarTrackError
        && error.code === code
        && error.message.length < 512
        && error.message.includes("100000 UTF-8 bytes; sha256="),
      "hostile object keys must never expand a source-located diagnostic without bound",
    );
  }
});

test("the exact sidecar sample ceiling is jointly executable under byte and JSON-node limits", { timeout: 120_000 }, async () => {
  const maximum = referencePlanarTrackLimits.maxSamples;
  assert.equal(maximum, 16_384);
  const fixedCorners = rectangle(0, 0, 1, 1);
  const samples = Array.from({ length: maximum }, (_, index): JsonSample => {
    const at = rational(index, maximum - 1);
    return { at: q(at.numerator, at.denominator), confidence: q(1), status: "occluded", corners: fixedCorners };
  });
  const acceptedSidecar = sidecar(samples, 2, 2), acceptedBytes = bytesOf(acceptedSidecar);
  assert.ok(acceptedBytes.byteLength <= referencePlanarTrackLimits.maxBytes,
    `${maximum} compact valid samples must fit the declared sidecar byte ceiling`);
  const accepted = prepare(acceptedBytes, { width: 2, height: 2 });
  assert.equal(accepted.prepared.samples.length, maximum);

  const rejectedSidecar = sidecar([...samples, samples.at(-1)!], 2, 2), rejectedBytes = bytesOf(rejectedSidecar);
  assert.ok(rejectedBytes.byteLength <= referencePlanarTrackLimits.maxBytes,
    "the first rejected sample count must reach the semantic sample ceiling rather than the byte ceiling");
  expectPrepareError(rejectedBytes, "CUT_PLANAR_TRACK_LIMIT", /2 through 16384 observations/u, { width: 2, height: 2 });

  const schema = JSON.parse(await (await import("node:fs/promises")).readFile("schemas/cut-planar-track-v1.schema.json", "utf8")) as {
    properties: { samples: { maxItems: number } };
  };
  assert.equal(schema.properties.samples.maxItems, maximum, "public JSON Schema and executable runtime must expose the same exact ceiling");
});

test("unlocked lock-time validation does not mutate IR and aggregate node limits fail before loading", async () => {
  const unlocked = context(sidecar(), { locked: false });
  const before = structuredClone(unlocked.ir.resources.tracking);
  let loads = 0;
  const prepared = await validateReferencePlanarTrackResources(unlocked.ir, unlocked.composition, async (sourceId, node) => {
    loads += 1;
    assert.equal(sourceId, "tracking");
    assert.equal(node.id, "planar");
    return unlocked.bytes;
  });
  assert.equal(loads, 1);
  assert.equal(prepared.size, 1);
  assert.deepEqual(unlocked.ir.resources.tracking, before, "lock-time semantic validation must not mutate the public IR");

  const excessive = context(sidecar(), { locked: false });
  for (let index = 1; index <= referencePlanarTrackLimits.maxNodesPerComposition; index += 1) {
    const id = `planar-${String(index).padStart(3, "0")}`;
    excessive.ir.nodes[id] = { ...structuredClone(excessive.node), id, contentHash: id };
    excessive.ir.scenes.scene!.items.push({ id, domain: "visual" });
  }
  let opened = false;
  await assert.rejects(
    () => validateReferencePlanarTrackResources(excessive.ir, excessive.composition, async () => {
      opened = true;
      return excessive.bytes;
    }),
    (error: unknown) => error instanceof ReferencePlanarTrackError
      && error.code === "CUT_PLANAR_TRACK_LIMIT"
      && /composition references more than 128/u.test(error.message),
  );
  assert.equal(opened, false, "aggregate node refusal must happen before sidecar loading");
});

test("config/resource ownership and runtime binding reject hidden or forged semantics", () => {
  const fixture = context();
  assert.equal(referencePlanarTrackConfig(fixture.ir, { ...fixture.node, op: "cut.visual.rect" }), undefined);
  const unknown = structuredClone(fixture.node);
  unknown.inputs.privateSolver = { kind: "string", value: "hidden" };
  assert.throws(
    () => referencePlanarTrackConfig(fixture.ir, unknown),
    (error: unknown) => error instanceof ReferencePlanarTrackError
      && error.code === "CUT_PLANAR_TRACK_INPUT_TYPE"
      && /privateSolver/u.test(error.message),
  );
  const noncanonical = structuredClone(fixture.node);
  noncanonical.inputs.minConfidence = {
    kind: "quantity",
    dimension: "ratio",
    magnitude: { numerator: "2", denominator: "4" },
    unit: "ratio",
  };
  assert.throws(
    () => referencePlanarTrackConfig(fixture.ir, noncanonical),
    (error: unknown) => error instanceof ReferencePlanarTrackError
      && error.code === "CUT_PLANAR_TRACK_INPUT_TYPE"
      && /lowest terms/u.test(error.message),
  );
  const unlocked = context(sidecar(), { locked: false });
  assert.throws(
    () => prepareReferencePlanarTrack(unlocked.ir, unlocked.node, unlocked.config, unlocked.composition, unlocked.bytes),
    (error: unknown) => error instanceof ReferencePlanarTrackError && error.code === "CUT_PLANAR_TRACK_RESOURCE",
  );

  const conflict = structuredClone(fixture.ir);
  conflict.nodes.nestedFirst = {
    ...structuredClone(fixture.node),
    id: "nestedFirst",
    op: "cut.visual.nested_first_consumer",
    inputs: {
      buried: {
        kind: "object",
        entries: {
          one: { kind: "array", items: [{ kind: "resource-ref", id: "tracking" }] },
        },
      },
    },
  };
  conflict.nodes.directSecond = {
    ...structuredClone(fixture.node),
    id: "directSecond",
    op: "cut.visual.direct_second_consumer",
    inputs: { source: { kind: "resource-ref", id: "tracking" } },
  };
  assert.throws(
    () => validateReferencePlanarTrackResourceOwnership(conflict),
    (error: unknown) => error instanceof ReferencePlanarTrackError
      && error.code === "CUT_PLANAR_TRACK_RESOURCE_CONFLICT"
      && error.source.line === 7
      && /cut\.visual\.nested_first_consumer/u.test(error.message)
      && !/direct_second_consumer/u.test(error.message),
    "one-pass ownership indexing must preserve recursive IR-value discovery and deterministic first-conflict diagnostics",
  );

  const locked = prepare();
  const forged = { ...locked.config, minConfidence: rational(0) };
  assert.throws(
    () => referencePlanarTrackAt(locked.node, locked.prepared, forged, rational(0), {
      sourceWidth: 20,
      sourceHeight: 20,
      opacity: rational(1),
    }),
    (error: unknown) => error instanceof ReferencePlanarTrackError && error.code === "CUT_PLANAR_TRACK_CONFIG",
  );
  assert.throws(
    () => referencePlanarTrackAt(locked.node, locked.prepared, locked.config, rational(2), {
      sourceWidth: 20,
      sourceHeight: 20,
      opacity: rational(1),
    }),
    (error: unknown) => error instanceof ReferencePlanarTrackError && error.code === "CUT_PLANAR_TRACK_TIME",
  );
  assert.throws(
    () => referencePlanarTrackAt(locked.node, locked.prepared, locked.config, rational(0), {
      sourceWidth: 0,
      sourceHeight: 20,
      opacity: rational(1),
    }),
    (error: unknown) => error instanceof ReferencePlanarTrackError && error.code === "CUT_PLANAR_TRACK_INPUT_TYPE",
  );
});
