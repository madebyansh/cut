import assert from "node:assert/strict";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import {
  type ReferenceLocalSpacePlacement,
  validateReferenceLocalSpaceGraph,
} from "../lib/runtime/reference/local-space";
import {
  ReferenceLocalSpaceAffineError,
  referenceLocalSpaceAuthoredPointAffine,
  referenceLocalSpaceAuthoredPointAffinePlan,
  referenceLocalSpaceAuthoredPointAt,
} from "../lib/runtime/reference/local-space-affine";
import { referenceLocalSpaceResizeGeometry } from "../lib/runtime/reference/local-space-transform-work";
import { transformReferencePoint } from "../lib/runtime/reference/retained-visual";
import {
  prepareReferenceTrack2D,
  referenceTrack2DConfig,
  referenceTrack2DLocalSpacePlanAt,
} from "../lib/runtime/reference/tracking-2d";

const local = Object.freeze({
  nodeId: "local",
  owner: "component-fragment" as const,
  width: 64,
  height: 48,
  rasterOriginQ16: Object.freeze({ x: String(7 * 65_536), y: String(3 * 65_536) }),
});

const basePlacement: ReferenceLocalSpacePlacement = Object.freeze({
  owner: "component-fragment",
  contextIdentity: "non-spatial-owner-content-a",
  destinationX: 111.25,
  destinationY: 77.5,
  registrationRasterX: 9,
  registrationRasterY: 2,
  scale: 1,
  skewX: 0,
  skewY: 0,
  rotation: 0,
  opacity: 1,
});

function resizedRasterPoint(
  x: number,
  y: number,
  inputWidth: number,
  inputHeight: number,
  outputWidth: number,
  outputHeight: number,
) {
  if (inputWidth === outputWidth && inputHeight === outputHeight) return { x, y };
  const resizeScale = Math.max(outputWidth / inputWidth, outputHeight / inputHeight);
  const intermediateWidth = Math.max(1, Math.round(inputWidth * resizeScale));
  const intermediateHeight = Math.max(1, Math.round(inputHeight * resizeScale));
  const cropLeft = Math.max(0, Math.floor((intermediateWidth - outputWidth + 1) / 2));
  const cropTop = Math.max(0, Math.floor((intermediateHeight - outputHeight + 1) / 2));
  const reductionPhase = resizeScale <= 1 ? -0.5 : 0;
  return { x: x * resizeScale + reductionPhase - cropLeft, y: y * resizeScale + reductionPhase - cropTop };
}

function affineRasterOrigin(
  x: number,
  y: number,
  inputWidth: number,
  inputHeight: number,
  a: number,
  b: number,
  c: number,
  d: number,
) {
  const minimumX = Math.min(0, a * inputWidth, b * inputHeight, a * inputWidth + b * inputHeight);
  const minimumY = Math.min(0, c * inputWidth, d * inputHeight, c * inputWidth + d * inputHeight);
  return { x: a * x + b * y + Math.round(-minimumX), y: c * x + d * y + Math.round(-minimumY) };
}

function rotatedRasterOrigin(
  x: number,
  y: number,
  inputWidth: number,
  inputHeight: number,
  outputWidth: number,
  outputHeight: number,
  rotation: number,
) {
  const normalized = ((rotation % 360) + 360) % 360;
  const signed = normalized > 180 ? normalized - 360 : normalized;
  const radians = signed * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians);
  if (normalized === 0 || normalized === 90 || normalized === 180 || normalized === 270) {
    const inputCenterX = (inputWidth - 1) / 2, inputCenterY = (inputHeight - 1) / 2;
    const deltaX = x - inputCenterX, deltaY = y - inputCenterY;
    return {
      x: (outputWidth - 1) / 2 + cosine * deltaX - sine * deltaY,
      y: (outputHeight - 1) / 2 + sine * deltaX + cosine * deltaY,
    };
  }
  return affineRasterOrigin(x, y, inputWidth, inputHeight, cosine, -sine, sine, cosine);
}

/** Independent copy of the installed raster-point bookkeeping. All bbox and
 * filter-phase translations cancel between a point and its registration; the
 * test intentionally retains them to guard the actual pixel helper order. */
function rasterOracle(
  placement: ReferenceLocalSpacePlacement,
  point: Readonly<{ x: number; y: number }>,
) {
  const inputWidth = 64, inputHeight = 48;
  const resizedWidth = Math.round(inputWidth * placement.scale), resizedHeight = Math.round(inputHeight * placement.scale);
  const pass = (raster: Readonly<{ x: number; y: number }>) => {
    let current = resizedRasterPoint(raster.x, raster.y, inputWidth, inputHeight, resizedWidth, resizedHeight);
    const radians = Math.PI / 180, tangentX = Math.tan(placement.skewX * radians), tangentY = Math.tan(placement.skewY * radians);
    current = affineRasterOrigin(current.x, current.y, resizedWidth, resizedHeight, 1, tangentX, tangentY, 1);
    // Exact dimensions affect only a common output translation, so use one
    // deterministic conservative pair for both registered points.
    const shearedWidth = resizedWidth + 23, shearedHeight = resizedHeight + 17;
    return rotatedRasterOrigin(current.x, current.y, shearedWidth, shearedHeight, shearedHeight + 31, shearedWidth + 29, placement.rotation);
  };
  const transformed = pass({ x: point.x + 7, y: point.y + 3 });
  const registration = pass({ x: placement.registrationRasterX, y: placement.registrationRasterY });
  return {
    x: placement.destinationX + transformed.x - registration.x,
    y: placement.destinationY + transformed.y - registration.y,
  };
}

function near(actual: Readonly<{ x: number; y: number }>, expected: Readonly<{ x: number; y: number }>) {
  assert.ok(Math.abs(actual.x - expected.x) < 1e-10, `x ${actual.x} != ${expected.x}`);
  assert.ok(Math.abs(actual.y - expected.y) < 1e-10, `y ${actual.y} != ${expected.y}`);
}

test("authored affine matches installed raster-point order for fractional resize, skew, quarter turns, and arbitrary rotation", () => {
  const point = Object.freeze({ x: 13.25, y: -2.5 });
  assert.notEqual(referenceLocalSpaceResizeGeometry(64, 48, 1.3).effectiveScale, 1.3, "fixture must exercise integer resize quantization rather than an exact-ratio scale");
  for (const transform of [
    {},
    { scale: 2 },
    { scale: 1.3 },
    { skewX: 17, skewY: -9 },
    { rotation: 90 },
    { rotation: 180 },
    { rotation: 270 },
    { rotation: -90 },
    { rotation: 37 },
    { scale: 1.3, skewX: 13, skewY: -6, rotation: 37 },
    { scale: 1.5, skewX: 11, skewY: -7, rotation: -127 },
  ]) {
    const placement = Object.freeze({ ...basePlacement, ...transform });
    near(referenceLocalSpaceAuthoredPointAt(local, placement, point), rasterOracle(placement, point));
  }
});

test("spatial affine identity excludes owner content and opacity but binds every spatial basis", () => {
  const baseline = referenceLocalSpaceAuthoredPointAffinePlan(local, basePlacement);
  const nonSpatial = referenceLocalSpaceAuthoredPointAffinePlan(local, {
    ...basePlacement,
    contextIdentity: "changed-media-grade-and-owner-content",
    opacity: 0,
  });
  assert.equal(nonSpatial.affineIdentity, baseline.affineIdentity);
  assert.deepEqual(nonSpatial.affine, baseline.affine);
  for (const placement of [
    { ...basePlacement, destinationX: basePlacement.destinationX + 1 },
    { ...basePlacement, registrationRasterY: basePlacement.registrationRasterY + 1 },
    { ...basePlacement, scale: 1.25 },
    { ...basePlacement, skewX: 5 },
    { ...basePlacement, rotation: 12 },
  ]) assert.notEqual(referenceLocalSpaceAuthoredPointAffinePlan(local, placement).affineIdentity, baseline.affineIdentity);
  assert.notEqual(referenceLocalSpaceAuthoredPointAffinePlan({
    ...local,
    rasterOriginQ16: { x: local.rasterOriginQ16.x, y: String(4 * 65_536) },
  }, basePlacement).affineIdentity, baseline.affineIdentity);
  assert.notEqual(referenceLocalSpaceAuthoredPointAffinePlan({ ...local, width: local.width + 1 }, basePlacement).affineIdentity, baseline.affineIdentity);
});

test("invalid and singular affine requests fail with stable LocalSpace codes", () => {
  assert.throws(
    () => referenceLocalSpaceAuthoredPointAffinePlan(local, { ...basePlacement, scale: 0 }),
    (error: unknown) => error instanceof ReferenceLocalSpaceAffineError && error.code === "CUT_LOCAL_SPACE_AFFINE_RANGE",
  );
  assert.throws(
    () => referenceLocalSpaceAuthoredPointAffinePlan(local, { ...basePlacement, skewX: 45, skewY: 45 }),
    (error: unknown) => error instanceof ReferenceLocalSpaceAffineError && error.code === "CUT_LOCAL_SPACE_AFFINE_SINGULAR",
  );
  assert.throws(
    () => referenceLocalSpaceAuthoredPointAffinePlan(local, { ...basePlacement, destinationX: Number.NaN }),
    (error: unknown) => error instanceof ReferenceLocalSpaceAffineError && error.code === "CUT_LOCAL_SPACE_AFFINE_TYPE",
  );
  assert.throws(
    () => referenceLocalSpaceAuthoredPointAffinePlan(local, { ...basePlacement, opacity: 1.1 }),
    (error: unknown) => error instanceof ReferenceLocalSpaceAffineError && error.code === "CUT_LOCAL_SPACE_AFFINE_RANGE",
  );
  assert.throws(
    () => referenceLocalSpaceAuthoredPointAffinePlan(local, { ...basePlacement, scale: 1_000_000_001 }),
    (error: unknown) => error instanceof ReferenceLocalSpaceAffineError && error.code === "CUT_LOCAL_SPACE_AFFINE_RANGE",
  );
});

function compile(program: string) {
  const parsed = parseCutLanguage(program);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  return compileCutModule(parsed.module).ir;
}

function visualNode(ir: CutAVIR, op: string) {
  const node = Object.values(ir.nodes).find((candidate) => candidate.op === op);
  assert.ok(node);
  return node;
}

test("zero-origin authored affine is byte-equal to the real Track2D localToComposition plan", () => {
  const ir = compile(`cut 0.4;
project "anchored Track2D affine parity";
import { LocalSpace, Rect, Track2D } from "cut:visual";
asset tracking: DataAsset = data("assets/subject.track.json");
timeline main(duration: 1s, fps: 4, width: 100px, height: 80px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Track2D(source: tracking, minConfidence: 60%, lowConfidence: "hold", occluded: "hold", outOfFrame: "hide", interpolation: "linear", bindScale: true, bindRotation: true, x: 2px, y: -3px, scale: 0.65, rotation: 10deg, opacity: 80%) {
      LocalSpace(width: 7px, height: 3px, origin: { x: 0px, y: 0px }) {
        Rect(width: 4px, height: 2px, fill: #ef233c);
      }
    }
  }
}
export out = render(main, codec: "h264");`);
  const composition = ir.compositions[0]!, owner = visualNode(ir, "cut.visual.track_2d"), localNode = visualNode(ir, "cut.visual.local_space");
  const config = referenceTrack2DConfig(ir, owner), localConfig = validateReferenceLocalSpaceGraph(ir, composition).get(localNode.id);
  assert.ok(config && localConfig);
  const data = Buffer.from(JSON.stringify({
    format: "cut-track-2d",
    version: 1,
    coordinateSpace: "composition-pixels",
    width: 100,
    height: 80,
    samples: [
      { at: { numerator: "0", denominator: "1" }, x: { numerator: "10", denominator: "1" }, y: { numerator: "20", denominator: "1" }, scale: { numerator: "2", denominator: "1" }, rotation: { numerator: "90", denominator: "1" }, confidence: { numerator: "1", denominator: "1" }, status: "visible" },
      { at: { numerator: "1", denominator: "1" }, x: { numerator: "90", denominator: "1" }, y: { numerator: "70", denominator: "1" }, scale: { numerator: "2", denominator: "1" }, rotation: { numerator: "90", denominator: "1" }, confidence: { numerator: "1", denominator: "1" }, status: "visible" },
    ],
  }));
  const prepared = prepareReferenceTrack2D(owner, config, composition, data);
  const trackPlan = referenceTrack2DLocalSpacePlanAt(ir, composition, owner, prepared, config, localConfig, rational(0));
  assert.ok(trackPlan.localToComposition && trackPlan.destinationRegistration && trackPlan.scale !== undefined && trackPlan.rotation !== undefined && trackPlan.opacity !== undefined);
  const placement: ReferenceLocalSpacePlacement = {
    owner: "track-2d",
    contextIdentity: trackPlan.cacheIdentity,
    destinationX: trackPlan.destinationRegistration.x,
    destinationY: trackPlan.destinationRegistration.y,
    registrationRasterX: trackPlan.sourceSpace.rasterRegistration.x,
    registrationRasterY: trackPlan.sourceSpace.rasterRegistration.y,
    scale: trackPlan.scale,
    skewX: 0,
    skewY: 0,
    rotation: trackPlan.rotation,
    opacity: trackPlan.opacity,
  };
  assert.deepEqual(referenceLocalSpaceAuthoredPointAffine(localConfig, placement), trackPlan.localToComposition);
  near(
    referenceLocalSpaceAuthoredPointAt(localConfig, placement, { x: 3, y: -4 }),
    transformReferencePoint(trackPlan.localToComposition, 3, -4),
  );
});
