import assert from "node:assert/strict";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { CutAvIrValidationError, loadCutAvIr } from "../lib/language/ir-loader";
import { referenceKernelSchema } from "../lib/language/kernel-registry";
import { packageSymbol } from "../lib/language/packages";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { finalizeGraphHashes } from "../lib/runtime/graph";
import { inspectCutIr } from "../lib/runtime/inspect";
import { validateReferenceStaticVisualGraphs } from "../lib/runtime/reference/static-visual-validation";
import {
  referenceRetainedPathChain,
  referenceRetainedPathChainsFromRoots,
} from "../lib/runtime/reference/retained-path-chain";
import {
  ReferenceLocalSpaceError,
  validateReferenceLocalSpaceGraph,
} from "../lib/runtime/reference/local-space";

const retainedPath = `Path(
  geometry: vectorPath(
    start: { x: 0px, y: 4px },
    segments: [lineTo(to: { x: 16px, y: 4px })],
    closed: false
  ),
  stroke: #ffffff,
  width: 2px
);`;

function source(
  body = `LocalSpace(width: 16px, height: 8px, origin: { x: 0px, y: 0px }) { ${retainedPath} }`,
  extraArguments = "",
  ownerSuffix = "",
  sceneTail = "",
) {
  return `cut 0.4;
project "planar shared integration";
import { LocalSpace, Path, PlanarTrack, Rect, lineTo, vectorPath } from "cut:visual";
asset tracking: DataAsset = data("assets/plane.planar-track.json");
timeline main(duration: 1s, fps: 4, width: 64px, height: 48px, sampleRate: 8khz) {
  scene only(duration: 1s) {
    PlanarTrack(
      source: tracking,
      minConfidence: 75%,
      lowConfidence: "hold",
      occluded: "hold",
      outOfFrame: "hide",
      interpolation: "hold",
      opacity: 80%${extraArguments}
    )${ownerSuffix} { ${body} }
    ${sceneTail}
  }
}
export out = render(main, width: 64px, height: 48px, codec: "h264");`;
}

function parsed(value: string) {
  const result = parseCutLanguage(value);
  assert.ok(result.module, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.diagnostics, []);
  return result.module;
}

function compile(value = source()) {
  const parsedModule = parsed(value), checked = checkCutModule(parsedModule);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  return compileCutModule(parsedModule).ir;
}

function node(ir: CutAVIR, op: string) {
  const result = Object.values(ir.nodes).find((candidate) => candidate.op === op);
  assert.ok(result, `expected ${op}`);
  return result;
}

test("PlanarTrack is one closed public projective owner with no affine geometry surface", () => {
  const symbol = packageSymbol("cut:visual", "PlanarTrack"), kernel = referenceKernelSchema("cut.visual.planar_track");
  assert.deepEqual(symbol?.parameters?.map((parameter) => parameter.name), [
    "source", "minConfidence", "lowConfidence", "occluded", "outOfFrame", "interpolation", "opacity",
  ]);
  assert.equal(symbol?.parameters?.find((parameter) => parameter.name === "interpolation")?.default, "linear");
  assert.equal(symbol?.parameters?.find((parameter) => parameter.name === "opacity")?.default, "100%");
  assert.equal(symbol?.children, "visual");
  assert.ok(kernel?.support === "supported");
  if (kernel?.support !== "supported") return;
  assert.deepEqual(kernel.inputs, ["source", "minConfidence", "lowConfidence", "occluded", "outOfFrame", "interpolation", "opacity"]);
  assert.deepEqual(kernel.properties, ["opacity"]);
  assert.deepEqual([kernel.minimumChildren, kernel.maximumChildren], [1, 1]);

  const ir = compile(), owner = node(ir, "cut.visual.planar_track"), local = node(ir, "cut.visual.local_space");
  assert.deepEqual(Object.keys(owner.inputs).sort(), ["interpolation", "lowConfidence", "minConfidence", "occluded", "opacity", "outOfFrame", "source"]);
  assert.equal(owner.inputs.source?.kind, "resource-ref");
  assert.deepEqual(owner.children, [local.id]);
  assert.equal(local.interval.start.numerator, owner.interval.start.numerator);
  assert.equal(local.interval.start.denominator, owner.interval.start.denominator);
  assert.equal(local.interval.duration.numerator, owner.interval.duration.numerator);
  assert.equal(local.interval.duration.denominator, owner.interval.duration.denominator);

  const configurations = validateReferenceLocalSpaceGraph(ir, ir.compositions[0]);
  assert.equal(configurations.get(local.id)?.owner, "planar-track");
  assert.equal(configurations.get(local.id)?.ownerNodeId, owner.id);
  const inspected = inspectCutIr(ir, "main.cut").graph.nodes.find((candidate) => candidate.id === owner.id);
  assert.deepEqual(inspected?.planarTrack, {
    sourceId: "tracking",
    interpolation: "hold",
    minConfidence: rational(3, 4),
    policies: { lowConfidence: "hold", occluded: "hold", outOfFrame: "hide" },
    opacity: { authoredInput: rational(4, 5), execution: { kind: "static-input" } },
    coordinateSpace: "composition-pixel-edges",
    projectiveMaterialization: "isolated-reference-projective-warp",
    directLocalSpace: {
      nodeId: local.id,
      dimensions: { width: 16, height: 8 },
      rasterOriginQ16: { x: "0", y: "0" },
      semanticIdentity: configurations.get(local.id)?.semanticIdentity,
      rendererHandoff: "connected-reference-projective-renderer",
      sampledQuad: "requires-locked-runtime-data",
    },
  });

  const animatedIr = compile(source(undefined, "", " as tracked", "animate tracked.opacity from 20% to 80% over 1s;"));
  const animatedOwner = node(animatedIr, "cut.visual.planar_track");
  const animatedInspect = inspectCutIr(animatedIr, "animated.cut").graph.nodes.find((candidate) => candidate.id === animatedOwner.id);
  const opacityProperty = animatedOwner.properties.opacity;
  assert.ok(opacityProperty && "signal" in opacityProperty);
  assert.deepEqual(animatedInspect?.planarTrack?.opacity, {
    authoredInput: rational(4, 5),
    execution: { kind: "signal", signalId: opacityProperty.signal },
  });
});

test("source checking rejects empty, ordinary, mixed, controlled, and affine PlanarTrack forms", () => {
  const cases = [
    source(""),
    source("Rect(width: 16px, height: 8px);"),
    source(`LocalSpace(width: 16px, height: 8px, origin: { x: 0px, y: 0px }) { Rect(width: 16px, height: 8px); } Rect(width: 1px, height: 1px);`),
    source(`at 0s { LocalSpace(width: 16px, height: 8px, origin: { x: 0px, y: 0px }) { Rect(width: 16px, height: 8px); } }`),
  ];
  for (const value of cases) {
    const errors = checkCutModule(parsed(value)).diagnostics.filter((item) => item.severity === "error");
    assert.ok(errors.some((item) => item.code === "CUT_PLANAR_TRACK_GRAPH" && item.span.start.line > 0 && item.span.start.column > 0));
  }
  const affine = checkCutModule(parsed(source(undefined, ",\n      x: 2px"))).diagnostics.filter((item) => item.severity === "error");
  assert.ok(affine.some((item) => item.code === "CUT2059" && /does not execute input “x”/u.test(item.message)));
});

test("cut check static preflight rejects out-of-range PlanarTrack configuration before lock/render", () => {
  const invalid = parsed(source().replace("minConfidence: 75%", "minConfidence: 101%"));
  assert.deepEqual(checkCutModule(invalid).diagnostics.filter((item) => item.severity === "error"), []);
  const ir = compileCutModule(invalid).ir;
  const diagnostics = validateReferenceStaticVisualGraphs(ir);
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "CUT_PLANAR_TRACK_RANGE"
    && diagnostic.span.start.line > 0
    && /minConfidence.*between 0% and 100%/u.test(diagnostic.message)));
});

test("loaded IR and runtime ownership reject non-LocalSpace and shortened PlanarTrack tiles", () => {
  const baseline = compile(), owner = node(baseline, "cut.visual.planar_track"), local = node(baseline, "cut.visual.local_space");

  const wrongChild = structuredClone(baseline), wrongLocal = wrongChild.nodes[local.id];
  wrongLocal.op = "cut.visual.group";
  wrongLocal.inputs = {};
  finalizeGraphHashes(wrongChild);
  assert.throws(
    () => loadCutAvIr(JSON.stringify(wrongChild)),
    (error: unknown) => error instanceof CutAvIrValidationError
      && error.code === "CUT_PLANAR_TRACK_GRAPH"
      && error.path === `$.nodes.${owner.id}.children`,
  );

  const shortened = structuredClone(baseline), shortenedLocal = shortened.nodes[local.id];
  shortenedLocal.interval.duration = rational(1, 2);
  finalizeGraphHashes(shortened);
  assert.throws(
    () => loadCutAvIr(JSON.stringify(shortened)),
    (error: unknown) => error instanceof CutAvIrValidationError
      && error.code === "CUT_IR_TIMING"
      && /exact start and duration/u.test(error.message),
  );
  assert.throws(
    () => validateReferenceLocalSpaceGraph(shortened, shortened.compositions[0]),
    (error: unknown) => error instanceof ReferenceLocalSpaceError
      && error.code === "CUT_LOCAL_SPACE_GRAPH"
      && error.source.nodeId === local.id
      && /exact start and duration/u.test(error.message),
  );
});

test("PlanarTrack remains a projective materialization boundary outside retained affine Path chains", () => {
  const ir = compile(), owner = node(ir, "cut.visual.planar_track"), path = node(ir, "cut.visual.path");
  assert.equal(referenceRetainedPathChain(ir, owner.id), undefined);
  const descendants = referenceRetainedPathChainsFromRoots(ir, [owner.id]);
  assert.ok(descendants.some((chain) => chain.pathId === path.id));
  assert.ok(descendants.every((chain) => !chain.wrapperOps.includes("cut.visual.planar_track")));
});
