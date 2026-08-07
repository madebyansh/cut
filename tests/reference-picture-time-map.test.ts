import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import sharp from "sharp";
import { parseCutLanguage } from "../lib/language/parser";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR, IRPictureTimeMap } from "../lib/language/ir";
import { CutAvIrValidationError, validateCutAvIr } from "../lib/language/ir-loader";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { pictureSpeedRampSourceOffset } from "../lib/language/picture-time-map";
import { rational } from "../lib/language/rational";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { finalizeGraphHashes } from "../lib/runtime/graph";
import { createIncrementalRenderPlan } from "../lib/runtime/graph";
import { inspectCutIr } from "../lib/runtime/inspect";
import {
  ReferencePictureTimeMapError,
  referencePictureDecoderFrame,
  referencePictureDecoderSample,
  referencePictureTimeMapConfig,
  type ReferencePictureTimeMapConfig,
} from "../lib/runtime/reference/picture-time-map";
import {
  blendReferencePictureFrames,
  referencePictureFrameBlendPhaseUnits,
  referencePictureFrameBlendPolicyIdentity,
} from "../lib/runtime/reference/picture-frame-blend";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";
import { ReferencePictureEditorialError, validateReferenceSession } from "../lib/runtime/reference/validate";

const exec = promisify(execFile);

function moduleFor(source: string) {
  const parsed = parseCutLanguage(source);
  assert.deepEqual(parsed.diagnostics, []);
  assert.ok(parsed.module);
  return parsed.module;
}

function pictureProgram({
  range = "0s ..< 1s",
  duration = "1s",
  controls = "",
  project = "picture time map",
}: { range?: string; duration?: string; controls?: string; project?: string } = {}) {
  return `cut 0.4;
project "${project}";
import { Sequence, PictureTrack, PictureClip, speedPoint } from "@cut/edit";
asset source: VideoAsset = video("media/source.mkv");
timeline main(duration: ${duration}, fps: 4, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: ${duration}) {
    Sequence(duration: ${duration}) {
      PictureTrack() {
        PictureClip(source: source, range: ${range}, duration: ${duration}${controls});
      }
    }
  }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
}

function timelineEditedPictureProgram({
  controls,
  operations,
  project,
}: {
  controls: string;
  operations: string;
  project: string;
}) {
  return `cut 0.4;
project "${project}";
import {
  Sequence, PictureTrack, PictureClip, TimelineEdit,
  editSelection, avTime, editSplit, editTrim, speedPoint
} from "@cut/edit";
asset source: VideoAsset = video("media/source.mkv");
timeline main(duration: 1s, fps: 4, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Sequence(duration: 1s) {
      PictureTrack(trackId: "picture", role: "primary") {
        PictureClip(
          source: source,
          range: 0s ..< 1s,
          duration: 1s,
          editId: "mapped"${controls}
        );
      }
    }
    TimelineEdit(id: "mapped-structural-edit", operations: [${operations}]);
  }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
}

function compile(source: string) { return compileCutModule(moduleFor(source)).ir; }

function nodeByOp(ir: CutAVIR, op: string) {
  const node = Object.values(ir.nodes).find((candidate) => candidate.op === op);
  assert.ok(node, `missing ${op}`);
  return node;
}

function pictureItem(ir: CutAVIR) {
  const track = nodeByOp(ir, "cut.edit.picture_track");
  assert.equal(track.editorial?.kind, "picture-track");
  if (track.editorial?.kind !== "picture-track") throw new Error("missing picture-track editorial metadata");
  return track.editorial.items[0];
}

function fakeLocked(ir: CutAVIR, duration = rational(10)) {
  for (const resource of Object.values(ir.resources)) {
    resource.state = "locked";
    resource.sha256 = "0".repeat(64);
    resource.metadata = {
      bytes: 1,
      probe: {
        kind: "media",
        identity: { streams: [{ index: 0, type: "video", frameRate: rational(4), timeBase: rational(1, 4), start: rational(0), duration, width: 64, height: 64 }] },
        selected: { video: {
          streamIndex: 0,
          duration,
          durationSource: "decoded-video-cadence",
          timeBase: rational(1, 4),
          decodedVideoCadence: {
            format: "cut-decoded-video-cadence",
            version: 2,
            method: "ffprobe-show-frames-cfr-v2",
            quantization: "phase-floor",
            phaseNumerator: "0",
            streamIndex: 0,
            firstPts: "0",
            lastPts: String(Number(duration.numerator) * 4 / Number(duration.denominator) - 1),
            quantizedEndPts: String(Number(duration.numerator) * 4 / Number(duration.denominator)),
            frameCount: String(Number(duration.numerator) * 4 / Number(duration.denominator)),
            durationPresentCount: String(Number(duration.numerator) * 4 / Number(duration.denominator)),
            durationCoverage: "complete",
            recordsSha256: "a".repeat(64),
            timeBase: rational(1, 4),
            frameRate: rational(4),
          },
        } },
      },
    } as never;
  }
  ir.determinism.semantic = "locked";
  return ir;
}

test("omitted and explicit default picture playback have one semantic identity", () => {
  const omitted = compile(pictureProgram());
  const explicit = compile(pictureProgram({ controls: ', playback: "normal", rate: 1, frameSelection: "floor"' }));
  assert.notEqual(omitted.sourceHash, explicit.sourceHash);
  assert.equal(omitted.buildId, explicit.buildId);
  const clip = nodeByOp(explicit, "cut.edit.picture_clip");
  assert.equal(clip.inputs.playback, undefined);
  assert.equal(clip.inputs.rate, undefined);
  assert.equal(clip.inputs.freezeAt, undefined);
  assert.equal(clip.inputs.frameSelection, undefined);
  assert.equal(pictureItem(explicit).timeMap, undefined);

  const reverse = compile(pictureProgram({ controls: ', playback: "reverse", rate: 1' }));
  assert.deepEqual(pictureItem(reverse).timeMap, { kind: "constant", direction: "reverse", rate: rational(1) });
  const freeze = compile(pictureProgram({ controls: ', playback: "freeze", freezeAt: 500ms' }));
  assert.deepEqual(pictureItem(freeze).timeMap, { kind: "freeze", at: rational(1, 2) });
});

test("nearest frame selection is typed, inspectable, diffable, and picture-cache identity bearing", () => {
  const floor = compile(pictureProgram({ range: "0s ..< 750ms", controls: ', rate: 0.75, frameSelection: "floor"' }));
  const nearest = compile(pictureProgram({ range: "0s ..< 750ms", controls: ', rate: 0.75, frameSelection: "nearest"' }));
  const repeat = compile(pictureProgram({ range: "0s ..< 750ms", controls: ', rate: 0.75, frameSelection: "nearest"' }));
  assert.notEqual(nearest.buildId, floor.buildId);
  assert.equal(repeat.buildId, nearest.buildId);
  assert.deepEqual(pictureItem(nearest).timeMap, {
    kind: "constant",
    direction: "forward",
    rate: rational(3, 4),
    frameSelection: "nearest",
  });
  assert.deepEqual(nodeByOp(nearest, "cut.edit.picture_clip").inputs.frameSelection, { kind: "string", value: "nearest" });

  const inspected = inspectCutIr(nearest, "nearest-frame-selection.cut");
  const track = inspected.graph.nodes.find((node) => node.pictureEditorial?.kind === "picture-track");
  assert.equal(track?.pictureEditorial?.items[0]?.timeMap?.kind, "constant");
  assert.deepEqual(track?.pictureEditorial?.items[0]?.timeMap, pictureItem(nearest).timeMap);
  const changes = diffCutAVIR(floor, nearest).changes;
  assert.ok(changes.some((change) => change.operation === "modify"
    && change.entity === "node"
    && change.fields.some((field) => field.path.includes("frameSelection"))), JSON.stringify(changes));

  const sceneKey = (ir: CutAVIR) => {
    const composition = ir.compositions[0]!;
    return createIncrementalRenderPlan(ir, composition.id).scenes[0]!.key;
  };
  assert.notEqual(sceneKey(floor), sceneKey(nearest));
  assert.equal(sceneKey(nearest), sceneKey(repeat));
});

test("frame-blend is typed, diffable, cache-bearing, and keeps optical-flow as a source refusal", () => {
  const floor = compile(pictureProgram({ range: "0s ..< 500ms", controls: ', rate: 0.5' }));
  const blend = compile(pictureProgram({ range: "0s ..< 500ms", controls: ', rate: 0.5, frameSelection: "frame-blend"' }));
  const repeat = compile(pictureProgram({ range: "0s ..< 500ms", controls: ', rate: 0.5, frameSelection: "frame-blend"' }));
  assert.deepEqual(pictureItem(blend).timeMap, {
    kind: "constant",
    direction: "forward",
    rate: rational(1, 2),
    frameSelection: "frame-blend",
  });
  assert.equal(nodeByOp(blend, "cut.edit.picture_clip").inputs.frameSelection?.kind, "string");
  assert.notEqual(blend.buildId, floor.buildId);
  assert.equal(blend.buildId, repeat.buildId);
  const sceneKey = (ir: CutAVIR) => createIncrementalRenderPlan(ir, ir.compositions[0]!.id).scenes[0]!.key;
  assert.notEqual(sceneKey(blend), sceneKey(floor));
  assert.equal(sceneKey(blend), sceneKey(repeat));
  assert.ok(diffCutAVIR(floor, blend).changes.some((change) =>
    change.operation === "modify"
    && change.fields.some((field) => field.path.includes("frameSelection"))));
  assert.throws(
    () => compile(pictureProgram({ controls: ', frameSelection: "optical-flow"' })),
    (error) => error instanceof CutCompileError
      && error.result.diagnostics.some((diagnostic) =>
        diagnostic.code === "CUT2086"
        && diagnostic.span.start.line === 9
        && /optical-flow.*not executable/u.test(diagnostic.message)),
  );
});

test("frame-blend byte law is bounded, endpoint-exact, hidden-RGB safe, deterministic, and non-mutating", () => {
  const before = { data: Uint8Array.from([91, 73, 55, 0, 255, 0, 0, 255]), width: 2, height: 1 };
  const after = { data: Uint8Array.from([7, 11, 13, 0, 0, 0, 255, 128]), width: 2, height: 1 };
  const beforeBytes = before.data.slice(), afterBytes = after.data.slice();
  const start = blendReferencePictureFrames(before, after, 0);
  const end = blendReferencePictureFrames(before, after, referencePictureFrameBlendPhaseUnits);
  const middle = blendReferencePictureFrames(before, after, referencePictureFrameBlendPhaseUnits / 2);
  const repeat = blendReferencePictureFrames(
    { ...before, data: before.data.slice() },
    { ...after, data: after.data.slice() },
    referencePictureFrameBlendPhaseUnits / 2,
  );
  assert.deepEqual([...start.surface.data], [...before.data]);
  assert.deepEqual([...end.surface.data], [...after.data]);
  assert.notEqual(start.surface.data, before.data);
  assert.notEqual(end.surface.data, after.data);
  assert.deepEqual([...middle.surface.data], [0, 0, 0, 0, 170, 0, 85, 192]);
  assert.deepEqual(repeat, middle);
  assert.deepEqual(before.data, beforeBytes);
  assert.deepEqual(after.data, afterBytes);
  assert.equal(middle.observedWork.policyIdentity, referencePictureFrameBlendPolicyIdentity);
  assert.deepEqual(middle.observedWork, {
    policyIdentity: referencePictureFrameBlendPolicyIdentity,
    phaseQ16: 32_768,
    sourceFramesRead: 2,
    pixelsCopied: 0,
    pixelsBlended: 2,
    associatedChannelProducts: 16,
    transparentPixelsCanonicalized: 1,
    outputRgbaBytes: 8,
  });
  assert.throws(
    () => blendReferencePictureFrames(before, after, referencePictureFrameBlendPhaseUnits + 1),
    /CUT_EDIT_PICTURE_FRAME_BLEND.*phase/u,
  );
});

const rampControls = ', speedRamp: [speedPoint(at: 0s, rate: 0.5), speedPoint(at: 500ms, rate: 1.5), speedPoint(at: 1s, rate: 0.5)]';

test("speedRamp lowers exact finite linear-rate control points and canonicalizes a constant curve", () => {
  const ramp = compile(pictureProgram({ controls: rampControls })), item = pictureItem(ramp), clip = nodeByOp(ramp, "cut.edit.picture_clip");
  assert.deepEqual(item.timeMap, {
    kind: "speed-ramp",
    interpolation: "linear-rate",
    frameSelection: "floor",
    points: [
      { at: rational(0), rate: rational(1, 2) },
      { at: rational(1, 2), rate: rational(3, 2) },
      { at: rational(1), rate: rational(1, 2) },
    ],
  });
  assert.equal(clip.inputs.speedRamp?.kind, "array");
  const explicitFloorRamp = compile(pictureProgram({ controls: `${rampControls}, frameSelection: "floor"` }));
  assert.equal(explicitFloorRamp.buildId, ramp.buildId);
  assert.equal(nodeByOp(explicitFloorRamp, "cut.edit.picture_clip").inputs.frameSelection, undefined);
  if (item.timeMap?.kind !== "speed-ramp") throw new Error("missing speed-ramp map");
  assert.deepEqual(
    [rational(0), rational(1, 4), rational(1, 2), rational(3, 4), rational(1)].map((time) => pictureSpeedRampSourceOffset(item.timeMap as Extract<IRPictureTimeMap, { kind: "speed-ramp" }>, time)),
    [rational(0), rational(3, 16), rational(1, 2), rational(13, 16), rational(1)],
  );

  const constantRamp = compile(pictureProgram({ range: "0s ..< 2s", controls: ', speedRamp: [speedPoint(at: 0s, rate: 2), speedPoint(at: 1s, rate: 2)]' }));
  const constantRate = compile(pictureProgram({ range: "0s ..< 2s", controls: ', playback: "normal", rate: 2' }));
  assert.equal(constantRamp.buildId, constantRate.buildId);
  assert.deepEqual(pictureItem(constantRamp).timeMap, { kind: "constant", direction: "forward", rate: rational(2) });
  assert.equal(nodeByOp(constantRamp, "cut.edit.picture_clip").inputs.speedRamp, undefined);

  const changed = compile(pictureProgram({ controls: ', speedRamp: [speedPoint(at: 0s, rate: 1), speedPoint(at: 500ms, rate: 0.5), speedPoint(at: 1s, rate: 2)]' }));
  assert.notEqual(ramp.buildId, changed.buildId);
});

test("PictureClip time-map combinations fail closed with stable source diagnostics", () => {
  const hasTimeMapCode = (error: unknown) => error instanceof CutCompileError
    && error.result.diagnostics.some((item) => item.code === "CUT2086" && item.span.start.line === 9);
  assert.throws(() => compile(pictureProgram({ controls: ', playback: "freeze", freezeAt: 500ms, rate: 1' })), hasTimeMapCode);
  assert.throws(() => compile(pictureProgram({ controls: ', freezeAt: 500ms' })), hasTimeMapCode);
  assert.throws(() => compile(pictureProgram({ controls: ', rate: 0' })), hasTimeMapCode);
  assert.throws(() => compile(pictureProgram({ range: "0s ..< 2s", controls: ', playback: "reverse"' })), hasTimeMapCode);
  assert.ok(checkCutModule(moduleFor(pictureProgram({ controls: ', playback: "sideways"' }))).diagnostics.some((item) => item.code === "CUT2068"));
  assert.throws(() => compile(pictureProgram({ controls: ', frameSelection: "optical-flow"' })), hasTimeMapCode);
  assert.throws(() => compile(pictureProgram({ controls: ', playback: "freeze", freezeAt: 500ms, frameSelection: "nearest"' })), hasTimeMapCode);
  assert.ok(checkCutModule(moduleFor(pictureProgram({ controls: ', frameSelection: "random"' }))).diagnostics.some((item) => item.code === "CUT2068"));

  assert.throws(() => compile(pictureProgram({ controls: `${rampControls}, rate: 1` })), hasTimeMapCode);
  assert.throws(() => compile(pictureProgram({ controls: `${rampControls}, link: "take"` })), hasTimeMapCode);
  assert.throws(() => compile(pictureProgram({ controls: ', speedRamp: [speedPoint(at: 0s, rate: 1)]' })), hasTimeMapCode);
  assert.throws(() => compile(pictureProgram({ controls: ', speedRamp: [speedPoint(at: 250ms, rate: 1), speedPoint(at: 1s, rate: 1)]' })), hasTimeMapCode);
  assert.throws(() => compile(pictureProgram({ controls: ', speedRamp: [speedPoint(at: 0s, rate: 1), speedPoint(at: 750ms, rate: 1)]' })), hasTimeMapCode);
  assert.throws(() => compile(pictureProgram({ controls: ', speedRamp: [speedPoint(at: 0s, rate: 1), speedPoint(at: 500ms, rate: 2), speedPoint(at: 500ms, rate: 1), speedPoint(at: 1s, rate: 1)]' })), hasTimeMapCode);
  assert.throws(() => compile(pictureProgram({ controls: ', speedRamp: [speedPoint(at: 0s, rate: 0), speedPoint(at: 1s, rate: 2)]' })), hasTimeMapCode);
  assert.throws(() => compile(pictureProgram({ controls: ', speedRamp: [speedPoint(at: 0s, rate: 1), speedPoint(at: 1s, rate: 65)]' })), hasTimeMapCode);
  assert.throws(() => compile(pictureProgram({ controls: ', speedRamp: [speedPoint(at: 0s, rate: 1), speedPoint(at: 1s, rate: 2)]' })), hasTimeMapCode);
  assert.throws(() => compile(pictureProgram({ controls: ', speedRamp: [speedPoint(at: 0s, rate: 0.75), speedPoint(at: 125ms, rate: 1), speedPoint(at: 1s, rate: 1.25)]', range: "0s ..< 1125ms" })), hasTimeMapCode);
  const tooMany = Array.from({ length: 33 }, (_, index) => `speedPoint(at: ${index * 250}ms, rate: 1)`).join(", ");
  assert.throws(() => compile(pictureProgram({ duration: "8s", range: "0s ..< 8s", controls: `, speedRamp: [${tooMany}]` })), hasTimeMapCode);
  assert.ok(checkCutModule(moduleFor(pictureProgram({ controls: ', speedRamp: [speedPoint(at: 0s, rate: 1, easing: "linear"), speedPoint(at: 1s, rate: 1)]' }))).diagnostics.some((item) => item.code === "CUT2027" && /easing/.test(item.message)));
});

test("loaded IR closes typed time maps and runtime rejects metadata/input disagreement", () => {
  const reverse = compile(pictureProgram({ controls: ', playback: "reverse", rate: 1' }));
  const unknown = structuredClone(reverse), unknownMap = pictureItem(unknown).timeMap as IRPictureTimeMap & { ignored?: boolean };
  unknownMap.ignored = true;
  finalizeGraphHashes(unknown);
  assert.throws(
    () => validateCutAvIr(unknown),
    (error) => error instanceof CutAvIrValidationError && error.code === "CUT_IR_UNKNOWN_FIELD" && error.path.endsWith(".timeMap.ignored"),
  );

  const missing = fakeLocked(structuredClone(reverse));
  delete pictureItem(missing).timeMap;
  assert.throws(
    () => validateReferenceSession(missing),
    (error) => error instanceof ReferencePictureEditorialError
      && error.code === "CUT_EDIT_PICTURE_TIME_MAP"
      && /requires typed timeMap metadata/.test(error.message),
  );

  const redundant = fakeLocked(compile(pictureProgram()));
  pictureItem(redundant).timeMap = { kind: "constant", direction: "forward", rate: rational(1) };
  assert.throws(
    () => validateReferenceSession(redundant),
    (error) => error instanceof ReferencePictureEditorialError
      && error.code === "CUT_EDIT_PICTURE_TIME_MAP"
      && /must not emit redundant/.test(error.message),
  );

  const hostileRamp = compile(pictureProgram({ controls: rampControls })), hostileMap = pictureItem(hostileRamp).timeMap;
  assert.ok(hostileMap?.kind === "speed-ramp");
  (hostileMap as unknown as { interpolation: string }).interpolation = "cubic";
  finalizeGraphHashes(hostileRamp);
  assert.throws(
    () => validateCutAvIr(hostileRamp),
    (error) => error instanceof CutAvIrValidationError && error.code === "CUT_IR_ENUM" && error.path.endsWith(".timeMap.interpolation"),
  );

  const hostileNearest = compile(pictureProgram({ range: "0s ..< 750ms", controls: ', rate: 0.75, frameSelection: "nearest"' }));
  const hostileNearestMap = pictureItem(hostileNearest).timeMap;
  assert.ok(hostileNearestMap?.kind === "constant");
  (hostileNearestMap as unknown as { frameSelection: string }).frameSelection = "random";
  finalizeGraphHashes(hostileNearest);
  assert.throws(
    () => validateCutAvIr(hostileNearest),
    (error) => error instanceof CutAvIrValidationError
      && error.code === "CUT_IR_ENUM"
      && error.path.endsWith(".timeMap.frameSelection"),
  );

  const mismatchedRamp = fakeLocked(compile(pictureProgram({ controls: rampControls }))), mismatchedMap = pictureItem(mismatchedRamp).timeMap;
  assert.ok(mismatchedMap?.kind === "speed-ramp");
  mismatchedMap.points[1].rate = rational(1);
  assert.throws(
    () => validateReferenceSession(mismatchedRamp),
    (error) => error instanceof ReferencePictureEditorialError
      && error.code === "CUT_EDIT_PICTURE_TIME_MAP"
      && /must exactly equal canonical/.test(error.message),
  );

  const offGridRamp = fakeLocked(compile(pictureProgram({ controls: rampControls }))), offGridMap = pictureItem(offGridRamp).timeMap;
  const offGridClip = nodeByOp(offGridRamp, "cut.edit.picture_clip"), speedRamp = offGridClip.inputs.speedRamp;
  assert.ok(offGridMap?.kind === "speed-ramp" && speedRamp?.kind === "array" && speedRamp.items[1]?.kind === "object");
  offGridMap.points[1].at = rational(1, 8);
  if (speedRamp.items[1].kind === "object" && speedRamp.items[1].entries.at?.kind === "quantity") speedRamp.items[1].entries.at.magnitude = rational(1, 8);
  assert.throws(
    () => validateReferenceSession(offGridRamp),
    (error) => (error instanceof ReferencePictureTimeMapError || error instanceof ReferencePictureEditorialError)
      && error.code === "CUT_EDIT_PICTURE_TIME_MAP"
      && error.source.line === 9
      && /destination frame grid/.test(error.message),
  );
});

test("destination-to-source frame mapping is exact, monotonic, and picture-only", () => {
  const base: Omit<ReferencePictureTimeMapConfig, "map" | "sourceFrameCount" | "reverseDecode"> = {
    kind: "picture-time-map",
    resourceId: "source",
    streamIndex: 0,
    sourceStart: rational(0),
    sourceEnd: rational(1),
    sourceDuration: rational(1),
    selectedDuration: rational(1),
    selectedDurationSource: "stream",
    selectedStart: rational(0),
    selectedTimeBase: rational(1, 4),
    selectedFrameRate: rational(4),
    destinationFrameRate: rational(4),
    decodeStart: rational(0),
    decodeDuration: rational(1),
  };
  const plan = (map: IRPictureTimeMap, sourceFrameCount: number, reverseDecode = false): ReferencePictureTimeMapConfig => ({
    ...base,
    map,
    sourceFrameCount,
    sourceDuration: rational(sourceFrameCount, 4),
    sourceEnd: rational(sourceFrameCount, 4),
    decodeDuration: rational(sourceFrameCount, 4),
    reverseDecode,
  });
  const fast = plan({ kind: "constant", direction: "forward", rate: rational(2) }, 4);
  assert.deepEqual([0, 1].map((frame) => referencePictureDecoderFrame(fast, frame)), [0, 2]);
  const slow = plan({ kind: "constant", direction: "forward", rate: rational(1, 2) }, 2);
  assert.deepEqual([0, 1, 2, 3].map((frame) => referencePictureDecoderFrame(slow, frame)), [0, 0, 1, 1]);
  const nearest = plan({ kind: "constant", direction: "forward", rate: rational(3, 4), frameSelection: "nearest" }, 3);
  assert.deepEqual(
    [0, 1, 2, 3].map((frame) => referencePictureDecoderFrame(nearest, frame)),
    [0, 1, 1, 2],
    "strictly-above-half rounds forward while an exact half tie stays on the preceding frame",
  );
  const reverse = plan({ kind: "constant", direction: "reverse", rate: rational(1) }, 4, true);
  assert.deepEqual([0, 1, 2, 3].map((frame) => referencePictureDecoderFrame(reverse, frame)), [0, 1, 2, 3]);
  const freeze = plan({ kind: "freeze", at: rational(1, 2) }, 1);
  assert.deepEqual([0, 1, 2, 3].map((frame) => referencePictureDecoderFrame(freeze, frame)), [0, 0, 0, 0]);
  const ramp = plan({
    kind: "speed-ramp",
    interpolation: "linear-rate",
    frameSelection: "floor",
    points: [
      { at: rational(0), rate: rational(1, 2) },
      { at: rational(1, 2), rate: rational(3, 2) },
      { at: rational(1), rate: rational(1, 2) },
    ],
  }, 4);
  assert.deepEqual([0, 1, 2, 3].map((frame) => referencePictureDecoderFrame(ramp, frame)), [0, 0, 2, 3]);
  const nearestRamp = plan({
    kind: "speed-ramp",
    interpolation: "linear-rate",
    frameSelection: "nearest",
    points: [
      { at: rational(0), rate: rational(1, 2) },
      { at: rational(1, 2), rate: rational(3, 2) },
      { at: rational(1), rate: rational(1, 2) },
    ],
  }, 4);
  assert.deepEqual([0, 1, 2, 3].map((frame) => referencePictureDecoderFrame(nearestRamp, frame)), [0, 1, 2, 3]);

  const endClamp = {
    ...nearest,
    map: { kind: "constant", direction: "forward", rate: rational(1), frameSelection: "nearest" } as const,
    sourceFrameCount: 4,
    sourceDuration: rational(1),
    destinationFrameRate: rational(12),
  };
  assert.equal(referencePictureDecoderFrame(endClamp, 11), 3, "nearest remains inside the half-open source authority");

  const blended = plan({
    kind: "constant",
    direction: "forward",
    rate: rational(1, 2),
    frameSelection: "frame-blend",
  }, 2);
  blended.frameBlendPolicyIdentity = referencePictureFrameBlendPolicyIdentity;
  assert.deepEqual(
    [0, 1, 2, 3].map((frame) => referencePictureDecoderSample(blended, frame)),
    [
      { firstFrame: 0, secondFrame: 1, phaseQ16: 0, exactFrame: rational(0), frameSelection: "frame-blend", frameBlendPolicyIdentity: referencePictureFrameBlendPolicyIdentity },
      { firstFrame: 0, secondFrame: 1, phaseQ16: 32_768, exactFrame: rational(1, 2), frameSelection: "frame-blend", frameBlendPolicyIdentity: referencePictureFrameBlendPolicyIdentity },
      { firstFrame: 1, secondFrame: 1, phaseQ16: 0, exactFrame: rational(1), frameSelection: "frame-blend", frameBlendPolicyIdentity: referencePictureFrameBlendPolicyIdentity },
      { firstFrame: 1, secondFrame: 1, phaseQ16: 0, exactFrame: rational(3, 2), frameSelection: "frame-blend", frameBlendPolicyIdentity: referencePictureFrameBlendPolicyIdentity },
    ],
  );
  const reverseBlend = plan({
    kind: "constant",
    direction: "reverse",
    rate: rational(1, 2),
    frameSelection: "frame-blend",
  }, 2, true);
  reverseBlend.frameBlendPolicyIdentity = referencePictureFrameBlendPolicyIdentity;
  assert.deepEqual(
    [0, 1, 2, 3].map((frame) => referencePictureDecoderSample(reverseBlend, frame).phaseQ16),
    [0, 32_768, 0, 0],
    "the already-reversed decoder retains the same monotonic exact phase",
  );
  const rampBlend = plan({
    kind: "speed-ramp",
    interpolation: "linear-rate",
    frameSelection: "frame-blend",
    points: ramp.map.kind === "speed-ramp" ? ramp.map.points : [],
  }, 4);
  rampBlend.frameBlendPolicyIdentity = referencePictureFrameBlendPolicyIdentity;
  assert.deepEqual(
    [0, 1, 2, 3].map((frame) => {
      const sample = referencePictureDecoderSample(rampBlend, frame);
      return [sample.firstFrame, sample.secondFrame, sample.phaseQ16];
    }),
    [[0, 1, 0], [0, 1, 49_152], [2, 3, 0], [3, 3, 0]],
  );
  const freezeBlend = plan({ kind: "freeze", at: rational(1, 2), frameSelection: "frame-blend" }, 1);
  freezeBlend.frameBlendPolicyIdentity = referencePictureFrameBlendPolicyIdentity;
  assert.deepEqual(referencePictureDecoderSample(freezeBlend, 3), {
    firstFrame: 0,
    secondFrame: 0,
    phaseQ16: 0,
    exactFrame: rational(0),
    frameSelection: "frame-blend",
    frameBlendPolicyIdentity: referencePictureFrameBlendPolicyIdentity,
  });
});

async function makeFourFrameSource(root: string, alphas?: readonly number[]) {
  const frames = resolve(root, "frames"), media = resolve(root, "media");
  await mkdir(frames); await mkdir(media);
  const colors = [
    { r: 255, g: 0, b: 0 },
    { r: 0, g: 255, b: 0 },
    { r: 0, g: 0, b: 255 },
    { r: 255, g: 255, b: 0 },
  ];
  const channels: 3 | 4 = alphas ? 4 : 3;
  await Promise.all(colors.map((color, index) => {
    const background = alphas ? { ...color, alpha: alphas[index] } : color;
    return sharp({ create: { width: 64, height: 64, channels, background } }).png().toFile(resolve(frames, `${index}.png`));
  }));
  await exec("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-framerate", "4", "-i", resolve(frames, "%d.png"), "-c:v", "ffv1", "-pix_fmt", alphas ? "yuva444p" : "yuv444p", resolve(media, "source.mkv")]);
}

async function renderMappedFrames(root: string, options: Parameters<typeof pictureProgram>[0], frames: readonly number[], cache: string) {
  return renderSourceFrames(root, pictureProgram(options), frames, cache);
}

async function renderSourceFrames(root: string, source: string, frames: readonly number[], cache: string) {
  const ir = compile(source);
  const lock = await createCutLock(ir, root); await applyCutLock(ir, lock, root);
  const { composition } = validateReferenceSession(ir);
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, cache));
  await renderer.prepare();
  try {
    const scene = ir.scenes[composition.sceneIds[0]];
    const pixels: number[][] = [];
    for (const frame of frames) {
      const surface = await renderer.sceneFrame(scene, frame, false);
      const offset = (32 * surface.width + 32) * 4;
      pixels.push([...surface.data.subarray(offset, offset + 4)]);
    }
    return pixels;
  } finally { renderer.close(); }
}

const red = (pixel: number[]) => pixel[0] > 180 && pixel[1] < 80 && pixel[2] < 80;
const green = (pixel: number[]) => pixel[1] > 180 && pixel[0] < 80 && pixel[2] < 80;
const blue = (pixel: number[]) => pixel[2] > 180 && pixel[0] < 80 && pixel[1] < 80;
const yellow = (pixel: number[]) => pixel[0] > 180 && pixel[1] > 180 && pixel[2] < 80;

test("cut.lock rejects a compiled picture map whose exact source range exceeds locked media", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-picture-map-bounds-")); await makeFourFrameSource(root);
  const ir = compile(pictureProgram({ range: "0s ..< 2s", controls: ', playback: "normal", rate: 2' }));
  await assert.rejects(createCutLock(ir, root), /PictureClip source range.*beyond the selected source bound/);

  const ramp = compile(pictureProgram({ range: "0s ..< 2s", controls: ', speedRamp: [speedPoint(at: 0s, rate: 1), speedPoint(at: 500ms, rate: 2), speedPoint(at: 1s, rate: 3)]' }));
  await assert.rejects(createCutLock(ramp, root), /PictureClip source range.*beyond the selected source bound/);
});

test("reverse playback renders locked source frames in exact reverse order", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-picture-map-reverse-")); await makeFourFrameSource(root);
  const pixels = await renderMappedFrames(root, { controls: ', playback: "reverse", rate: 1' }, [0, 1, 2, 3], "cache-reverse");
  assert.ok(yellow(pixels[0]), JSON.stringify(pixels));
  assert.ok(blue(pixels[1]), JSON.stringify(pixels));
  assert.ok(green(pixels[2]), JSON.stringify(pixels));
  assert.ok(red(pixels[3]), JSON.stringify(pixels));
});

test("constant fast and slow rates skip and repeat locked source frames deterministically", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-picture-map-rate-")); await makeFourFrameSource(root);
  const fast = await renderMappedFrames(root, { duration: "500ms", controls: ', playback: "normal", rate: 2' }, [0, 1], "cache-fast");
  assert.ok(red(fast[0]) && blue(fast[1]), JSON.stringify(fast));
  const slow = await renderMappedFrames(root, { range: "0s ..< 500ms", controls: ', playback: "normal", rate: 0.5' }, [0, 1, 2, 3], "cache-slow");
  assert.ok(red(slow[0]) && red(slow[1]) && green(slow[2]) && green(slow[3]), JSON.stringify(slow));
});

test("nearest selection renders exact forward and reverse source frames with deterministic ties", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-picture-map-nearest-")); await makeFourFrameSource(root);
  const floor = await renderMappedFrames(
    root,
    { range: "0s ..< 750ms", controls: ', playback: "normal", rate: 0.75, frameSelection: "floor"' },
    [0, 1, 2, 3],
    "cache-nearest-floor",
  );
  const nearest = await renderMappedFrames(
    root,
    { range: "0s ..< 750ms", controls: ', playback: "normal", rate: 0.75, frameSelection: "nearest"' },
    [0, 1, 2, 3],
    "cache-nearest-forward",
  );
  const repeat = await renderMappedFrames(
    root,
    { range: "0s ..< 750ms", controls: ', playback: "normal", rate: 0.75, frameSelection: "nearest"' },
    [0, 1, 2, 3],
    "cache-nearest-forward-repeat",
  );
  assert.ok(red(floor[0]) && red(floor[1]) && green(floor[2]) && blue(floor[3]), JSON.stringify(floor));
  assert.ok(red(nearest[0]) && green(nearest[1]) && green(nearest[2]) && blue(nearest[3]), JSON.stringify(nearest));
  assert.deepEqual(repeat, nearest);

  const reverse = await renderMappedFrames(
    root,
    { range: "0s ..< 750ms", controls: ', playback: "reverse", rate: 0.75, frameSelection: "nearest"' },
    [0, 1, 2, 3],
    "cache-nearest-reverse",
  );
  assert.ok(blue(reverse[0]) && green(reverse[1]) && green(reverse[2]) && red(reverse[3]), JSON.stringify(reverse));
});

test("frame-blend executes forward, reverse, freeze, and variable maps with a monotonic two-frame decoder cache", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-picture-map-frame-blend-"));
  await makeFourFrameSource(root);
  const forward = await renderMappedFrames(
    root,
    { range: "0s ..< 500ms", controls: ', rate: 0.5, frameSelection: "frame-blend"' },
    [0, 1, 2, 3],
    "cache-blend-forward",
  );
  const repeat = await renderMappedFrames(
    root,
    { range: "0s ..< 500ms", controls: ', rate: 0.5, frameSelection: "frame-blend"' },
    [0, 1, 2, 3],
    "cache-blend-forward-repeat",
  );
  assert.deepEqual(repeat, forward);
  assert.ok(red(forward[0]) && forward[1][0] > 80 && forward[1][1] > 80 && green(forward[2]), JSON.stringify(forward));

  const reverse = await renderMappedFrames(
    root,
    { range: "0s ..< 500ms", controls: ', playback: "reverse", rate: 0.5, frameSelection: "frame-blend"' },
    [0, 1, 2, 3],
    "cache-blend-reverse",
  );
  assert.ok(green(reverse[0]) && reverse[1][0] > 80 && reverse[1][1] > 80 && red(reverse[2]), JSON.stringify(reverse));

  const ramp = await renderMappedFrames(
    root,
    { controls: `${rampControls}, frameSelection: "frame-blend"` },
    [0, 1, 2, 3],
    "cache-blend-ramp",
  );
  assert.ok(red(ramp[0]) && ramp[1][0] > 20 && ramp[1][1] > 100 && blue(ramp[2]) && yellow(ramp[3]), JSON.stringify(ramp));

  const freeze = await renderMappedFrames(
    root,
    { controls: ', playback: "freeze", freezeAt: 500ms, frameSelection: "frame-blend"' },
    [0, 1, 2, 3],
    "cache-blend-freeze",
  );
  assert.ok(freeze.every(blue), JSON.stringify(freeze));
});

test("piecewise-linear speedRamp renders the documented floor-selected source frames", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-picture-map-ramp-")); await makeFourFrameSource(root);
  const pixels = await renderMappedFrames(root, { controls: rampControls }, [0, 1, 2, 3], "cache-ramp");
  assert.ok(red(pixels[0]) && red(pixels[1]) && blue(pixels[2]) && yellow(pixels[3]), JSON.stringify(pixels));
  const nearest = await renderMappedFrames(
    root,
    { controls: `${rampControls}, frameSelection: "nearest"` },
    [0, 1, 2, 3],
    "cache-ramp-nearest",
  );
  assert.ok(red(nearest[0]) && green(nearest[1]) && blue(nearest[2]) && yellow(nearest[3]), JSON.stringify(nearest));
});

test("TimelineEdit split and trim preserve exact variable-map pixels instead of flattening the source clock", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-picture-map-timeline-edit-"));
  await makeFourFrameSource(root);
  const edited = timelineEditedPictureProgram({
    project: "TimelineEdit variable map pixels",
    controls: rampControls,
    operations: `
      editSplit(
        selection: editSelection(trackIds: ["picture"], originIds: ["mapped"]),
        at: avTime(picture: 500ms)
      ),
      editTrim(
        selection: editSelection(trackIds: ["picture"], originIds: ["mapped"]),
        keep: 0ms ..< 500ms
      )
    `,
  });
  const first = await renderSourceFrames(root, edited, [0, 1, 2, 3], "cache-timeline-edit-first");
  const repeat = await renderSourceFrames(root, edited, [0, 1, 2, 3], "cache-timeline-edit-repeat");
  assert.deepEqual(repeat, first);
  assert.ok(red(first[0]) && red(first[1]), JSON.stringify(first));
  assert.deepEqual(first[2], [0, 0, 0, 0]);
  assert.deepEqual(first[3], [0, 0, 0, 0]);

  const nearestEdited = timelineEditedPictureProgram({
    project: "TimelineEdit nearest variable map pixels",
    controls: `${rampControls}, frameSelection: "nearest"`,
    operations: `
      editSplit(
        selection: editSelection(trackIds: ["picture"], originIds: ["mapped"]),
        at: avTime(picture: 500ms)
      ),
      editTrim(
        selection: editSelection(trackIds: ["picture"], originIds: ["mapped"]),
        keep: 0ms ..< 500ms
      )
    `,
  });
  const nearest = await renderSourceFrames(root, nearestEdited, [0, 1, 2, 3], "cache-timeline-edit-nearest");
  assert.ok(red(nearest[0]) && green(nearest[1]), JSON.stringify(nearest));
  assert.deepEqual(nearest[2], [0, 0, 0, 0]);
  assert.deepEqual(nearest[3], [0, 0, 0, 0]);
});

test("TimelineEdit structural slices preserve reverse and freeze source clocks at exact pixels", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-picture-map-timeline-edit-constant-"));
  await makeFourFrameSource(root);
  const split = `
    editSplit(
      selection: editSelection(trackIds: ["picture"], originIds: ["mapped"]),
      at: avTime(picture: 500ms)
    )
  `;
  const reverse = await renderSourceFrames(
    root,
    timelineEditedPictureProgram({
      project: "TimelineEdit reverse map pixels",
      controls: ', playback: "reverse", rate: 1',
      operations: split,
    }),
    [0, 1, 2, 3],
    "cache-timeline-edit-reverse",
  );
  assert.ok(yellow(reverse[0]) && blue(reverse[1]) && green(reverse[2]) && red(reverse[3]), JSON.stringify(reverse));

  const freeze = await renderSourceFrames(
    root,
    timelineEditedPictureProgram({
      project: "TimelineEdit freeze map pixels",
      controls: ', playback: "freeze", freezeAt: 500ms',
      operations: `${split},
        editTrim(
          selection: editSelection(trackIds: ["picture"], originIds: ["mapped"]),
          keep: 250ms ..< 750ms
        )`,
    }),
    [0, 1, 2, 3],
    "cache-timeline-edit-freeze",
  );
  assert.deepEqual(freeze[0], [0, 0, 0, 0]);
  assert.ok(blue(freeze[1]) && blue(freeze[2]), JSON.stringify(freeze));
  assert.deepEqual(freeze[3], [0, 0, 0, 0]);
});

test("speedRamp frame selection preserves decoded straight alpha", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-picture-map-ramp-alpha-"));
  await makeFourFrameSource(root, [0.25, 0.5, 0.75, 1]);
  const pixels = await renderMappedFrames(root, { controls: rampControls }, [0, 1, 2, 3], "cache-ramp-alpha");
  assert.deepEqual(pixels.map((pixel) => pixel[3]), [64, 64, 192, 255]);
});

test("freeze playback renders one explicit locked source frame for the full destination", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-picture-map-freeze-")); await makeFourFrameSource(root);
  const pixels = await renderMappedFrames(root, { controls: ', playback: "freeze", freezeAt: 500ms, frameSelection: "floor"' }, [0, 1, 2, 3], "cache-freeze");
  assert.ok(pixels.every(blue), JSON.stringify(pixels));
});
