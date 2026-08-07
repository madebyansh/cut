import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { CutAvIrValidationError, validateCutAvIr } from "../lib/language/ir-loader";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { cutDiagnosticsFromError } from "../lib/runtime/diagnostics";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";
import { validateReferencePictureTrackOperationPlan } from "../lib/runtime/reference/picture-edit-operations";

const exec = promisify(execFile);

function moduleFor(source: string) {
  const parsed = parseCutLanguage(source);
  assert.deepEqual(parsed.diagnostics, []);
  assert.ok(parsed.module);
  return parsed.module;
}

function compile(source: string) { return compileCutModule(moduleFor(source)).ir; }

const imports = "Sequence, PictureTrack, PictureClip, Gap, speedPoint, editClip, editGap, split, trim, rippleInsert, rippleDelete, overwrite, replace, lift, extract, slip, slide";

function operationProgram(edit: string, finalDuration = "3s", base = `
          PictureClip(source: red, range: 0s ..< 1s, duration: 1s);
          PictureClip(source: green, range: 0s ..< 1s, duration: 1s);
          Gap(duration: 1s);`, sourceDuration = "3s") {
  return `cut 0.4;
project "picture operation";
import { ${imports} } from "@cut/edit";
asset red: VideoAsset = video("media/red.mkv");
asset green: VideoAsset = video("media/green.mkv");
asset blue: VideoAsset = video("media/blue.mkv");
timeline main(duration: ${finalDuration}, fps: 4, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: ${finalDuration}) {
    Sequence(duration: ${finalDuration}) {
      PictureTrack(sourceDuration: ${sourceDuration}, edits: [
        ${edit}
      ]) {${base}
      }
    }
  }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
}

function track(ir: CutAVIR) {
  const result = Object.values(ir.nodes).find((node) => node.op === "cut.edit.picture_track");
  assert.ok(result?.editorial?.kind === "picture-track");
  return result as IRNode & { editorial: Extract<NonNullable<IRNode["editorial"]>, { kind: "picture-track" }> };
}

function number(value: { numerator: string; denominator: string }) { return Number(value.numerator) / Number(value.denominator); }

function summary(ir: CutAVIR) {
  return track(ir).editorial.items.map((item) => ({
    kind: item.kind,
    destination: [number(item.destination.start), number(item.destination.duration)],
    source: item.source ? [number(item.source.start), number(item.source.duration)] : undefined,
  }));
}

test("the public picture edit algebra materializes split, trim, ripple, overwrite, replace, lift, extract, and explicit gap operands", () => {
  const cases: Array<{ edit: string; final: string; expected: ReturnType<typeof summary> }> = [
    {
      edit: "split(at: 500ms)", final: "3s",
      expected: [
        { kind: "picture", destination: [0, .5], source: [0, .5] },
        { kind: "picture", destination: [.5, .5], source: [.5, .5] },
        { kind: "picture", destination: [1, 1], source: [0, 1] },
        { kind: "gap", destination: [2, 1], source: undefined },
      ],
    },
    {
      edit: "trim(keep: 250ms ..< 750ms)", final: "3s",
      expected: [
        { kind: "gap", destination: [0, .25], source: undefined },
        { kind: "picture", destination: [.25, .5], source: [.25, .5] },
        { kind: "gap", destination: [.75, .25], source: undefined },
        { kind: "picture", destination: [1, 1], source: [0, 1] },
        { kind: "gap", destination: [2, 1], source: undefined },
      ],
    },
    {
      edit: "rippleInsert(at: 1s, item: editClip(source: blue, range: 0s ..< 500ms, duration: 500ms))", final: "3500ms",
      expected: [
        { kind: "picture", destination: [0, 1], source: [0, 1] },
        { kind: "picture", destination: [1, .5], source: [0, .5] },
        { kind: "picture", destination: [1.5, 1], source: [0, 1] },
        { kind: "gap", destination: [2.5, 1], source: undefined },
      ],
    },
    {
      edit: "rippleDelete(range: 500ms ..< 1500ms)", final: "2s",
      expected: [
        { kind: "picture", destination: [0, .5], source: [0, .5] },
        { kind: "picture", destination: [.5, .5], source: [.5, .5] },
        { kind: "gap", destination: [1, 1], source: undefined },
      ],
    },
    {
      edit: "overwrite(range: 500ms ..< 1500ms, item: editClip(source: blue, range: 0s ..< 1s, duration: 1s))", final: "3s",
      expected: [
        { kind: "picture", destination: [0, .5], source: [0, .5] },
        { kind: "picture", destination: [.5, 1], source: [0, 1] },
        { kind: "picture", destination: [1.5, .5], source: [.5, .5] },
        { kind: "gap", destination: [2, 1], source: undefined },
      ],
    },
    {
      edit: "replace(range: 1s ..< 2s, item: editClip(source: blue, range: 0s ..< 500ms, duration: 500ms))", final: "2500ms",
      expected: [
        { kind: "picture", destination: [0, 1], source: [0, 1] },
        { kind: "picture", destination: [1, .5], source: [0, .5] },
        { kind: "gap", destination: [1.5, 1], source: undefined },
      ],
    },
    {
      edit: "lift(range: 500ms ..< 1500ms)", final: "3s",
      expected: [
        { kind: "picture", destination: [0, .5], source: [0, .5] },
        { kind: "gap", destination: [.5, 1], source: undefined },
        { kind: "picture", destination: [1.5, .5], source: [.5, .5] },
        { kind: "gap", destination: [2, 1], source: undefined },
      ],
    },
    {
      edit: "extract(range: 500ms ..< 1500ms)", final: "2s",
      expected: [
        { kind: "picture", destination: [0, .5], source: [0, .5] },
        { kind: "picture", destination: [.5, .5], source: [.5, .5] },
        { kind: "gap", destination: [1, 1], source: undefined },
      ],
    },
    {
      edit: "rippleInsert(at: 1s, item: editGap(duration: 500ms))", final: "3500ms",
      expected: [
        { kind: "picture", destination: [0, 1], source: [0, 1] },
        { kind: "gap", destination: [1, .5], source: undefined },
        { kind: "picture", destination: [1.5, 1], source: [0, 1] },
        { kind: "gap", destination: [2.5, 1], source: undefined },
      ],
    },
    {
      edit: "slip(range: 0s ..< 1s, by: 500ms)", final: "3s",
      expected: [
        { kind: "picture", destination: [0, 1], source: [.5, 1] },
        { kind: "picture", destination: [1, 1], source: [0, 1] },
        { kind: "gap", destination: [2, 1], source: undefined },
      ],
    },
    {
      edit: "slide(range: 1s ..< 2s, by: 500ms)", final: "3s",
      expected: [
        { kind: "picture", destination: [0, 1.5], source: [0, 1.5] },
        { kind: "picture", destination: [1.5, 1], source: [0, 1] },
        { kind: "gap", destination: [2.5, .5], source: undefined },
      ],
    },
  ];
  for (const item of cases) {
    const ir = compile(operationProgram(item.edit, item.final));
    assert.deepEqual(summary(ir), item.expected, item.edit);
    const pictureTrack = track(ir);
    assert.equal(pictureTrack.inputs.sourceDuration, undefined, "compile-time operands must not leak into runtime inputs");
    assert.equal(pictureTrack.inputs.edits, undefined, "unresolved edit calls must not leak into runtime inputs");
    assert.equal(pictureTrack.editorial.operationPlan?.version, 1);
    assert.deepEqual(pictureTrack.children, pictureTrack.editorial.items.map((entry) => entry.nodeId));
    assert.ok(pictureTrack.editorial.items.every((entry) => ir.nodes[entry.nodeId]?.op === (entry.kind === "picture" ? "cut.edit.picture_clip" : "cut.edit.gap")));
    assert.doesNotThrow(() => validateCutAvIr(JSON.parse(JSON.stringify(ir))));
  }
});

test("split preserves exact forward, reverse, and freeze source-time semantics", () => {
  const base = (controls: string) => `PictureClip(source: red, range: 0s ..< 2s, duration: 1s${controls});`;
  const reverse = compile(operationProgram("split(at: 250ms)", "1s", base(', playback: "reverse", rate: 2'), "1s"));
  assert.deepEqual(summary(reverse), [
    { kind: "picture", destination: [0, .25], source: [1.5, .5] },
    { kind: "picture", destination: [.25, .75], source: [0, 1.5] },
  ]);
  const reverseItems = track(reverse).editorial.items;
  assert.ok(reverseItems.every((item) => item.timeMap?.kind === "constant" && item.timeMap.direction === "reverse" && number(item.timeMap.rate) === 2));
  const nearestReverse = compile(operationProgram(
    "split(at: 250ms)",
    "1s",
    base(', playback: "reverse", rate: 2, frameSelection: "nearest"'),
    "1s",
  ));
  assert.ok(track(nearestReverse).editorial.items.every((item) =>
    item.timeMap?.kind === "constant"
    && item.timeMap.direction === "reverse"
    && item.timeMap.frameSelection === "nearest"));

  const freeze = compile(operationProgram("split(at: 500ms)", "1s", base(', playback: "freeze", freezeAt: 500ms'), "1s"));
  assert.deepEqual(summary(freeze), [
    { kind: "picture", destination: [0, .5], source: [0, 2] },
    { kind: "picture", destination: [.5, .5], source: [0, 2] },
  ]);
  assert.ok(track(freeze).editorial.items.every((item) => item.timeMap?.kind === "freeze" && number(item.timeMap.at) === .5));
});

test("slip and slide preserve exact forward, reverse, freeze, gap, and total-duration semantics", () => {
  const slipBase = (controls: string) => `PictureClip(source: red, range: 1s ..< 3s, duration: 1s${controls});`;
  const reverseSlip = compile(operationProgram("slip(range: 0s ..< 1s, by: 500ms)", "1s", slipBase(', playback: "reverse", rate: 2'), "1s"));
  assert.deepEqual(summary(reverseSlip), [{ kind: "picture", destination: [0, 1], source: [1.5, 2] }]);
  const reverseSlipItem = track(reverseSlip).editorial.items[0];
  assert.ok(reverseSlipItem.timeMap?.kind === "constant" && reverseSlipItem.timeMap.direction === "reverse" && number(reverseSlipItem.timeMap.rate) === 2);

  const freezeSlip = compile(operationProgram("slip(range: 0s ..< 1s, by: 500ms)", "1s", slipBase(', playback: "freeze", freezeAt: 1500ms'), "1s"));
  assert.deepEqual(summary(freezeSlip), [{ kind: "picture", destination: [0, 1], source: [1.5, 2] }]);
  const freezePlanItem = track(freezeSlip).editorial.operationPlan?.operations[0];
  assert.ok(freezePlanItem?.kind === "slip");
  const freezeItem = track(freezeSlip).editorial.items[0], freezeNode = freezeSlip.nodes[freezeItem.nodeId];
  assert.ok(freezeItem.timeMap?.kind === "freeze" && number(freezeItem.timeMap.at) === 2);
  assert.equal(freezeNode.inputs.freezeAt?.kind, "quantity");
  if (freezeNode.inputs.freezeAt?.kind === "quantity") assert.equal(number(freezeNode.inputs.freezeAt.magnitude), 2);

  const gapSlideBase = `Gap(duration: 500ms); PictureClip(source: red, range: 0s ..< 1s, duration: 1s); Gap(duration: 1500ms);`;
  const gapSlide = compile(operationProgram("slide(range: 500ms ..< 1500ms, by: 500ms)", "3s", gapSlideBase));
  assert.deepEqual(summary(gapSlide), [
    { kind: "gap", destination: [0, 1], source: undefined },
    { kind: "picture", destination: [1, 1], source: [0, 1] },
    { kind: "gap", destination: [2, 1], source: undefined },
  ]);

  const clipSlideBase = `
    PictureClip(source: red, range: 2s ..< 4s, duration: 1s, playback: "reverse", rate: 2);
    PictureClip(source: green, range: 0s ..< 1s, duration: 1s);
    PictureClip(source: blue, range: 0s ..< 2s, duration: 1s, playback: "freeze", freezeAt: 500ms);`;
  const clipSlide = compile(operationProgram("slide(range: 1s ..< 2s, by: 500ms)", "3s", clipSlideBase));
  assert.deepEqual(summary(clipSlide), [
    { kind: "picture", destination: [0, 1.5], source: [1, 3] },
    { kind: "picture", destination: [1.5, 1], source: [0, 1] },
    { kind: "picture", destination: [2.5, .5], source: [0, 2] },
  ]);
  const slideItems = track(clipSlide).editorial.items;
  assert.ok(slideItems[0].timeMap?.kind === "constant" && slideItems[0].timeMap.direction === "reverse" && number(slideItems[0].timeMap.rate) === 2);
  assert.ok(slideItems[2].timeMap?.kind === "freeze" && number(slideItems[2].timeMap.at) === .5);
  assert.equal(number(slideItems.at(-1)!.destination.start) + number(slideItems.at(-1)!.destination.duration), 3);

  const negativeSlideBase = `
    PictureClip(source: red, range: 0s ..< 1s, duration: 1s);
    PictureClip(source: green, range: 0s ..< 1s, duration: 1s);
    PictureClip(source: blue, range: 1s ..< 2s, duration: 1s);`;
  const negativeSlide = compile(operationProgram("slide(range: 1s ..< 2s, by: -500ms)", "3s", negativeSlideBase));
  assert.deepEqual(summary(negativeSlide), [
    { kind: "picture", destination: [0, .5], source: [0, .5] },
    { kind: "picture", destination: [.5, 1], source: [0, 1] },
    { kind: "picture", destination: [1.5, 1.5], source: [.5, 1.5] },
  ]);
});

test("picture operation algebra slices, slips, and slides bounded speed ramps without flattening their map", () => {
  const ramp = 'speedRamp: [speedPoint(at: 0s, rate: 0.5), speedPoint(at: 500ms, rate: 1.5), speedPoint(at: 1s, rate: 0.5)]';
  const splitRamp = compile(operationProgram("split(at: 500ms)", "1s", `PictureClip(source: red, range: 0s ..< 1s, duration: 1s, ${ramp});`, "1s"));
  assert.deepEqual(summary(splitRamp), [
    { kind: "picture", destination: [0, .5], source: [0, .5] },
    { kind: "picture", destination: [.5, .5], source: [.5, .5] },
  ]);
  const splitItems = track(splitRamp).editorial.items;
  assert.ok(splitItems.every((item) => item.timeMap?.kind === "speed-ramp"));
  if (splitItems[0].timeMap?.kind === "speed-ramp" && splitItems[1].timeMap?.kind === "speed-ramp") {
    assert.deepEqual(splitItems[0].timeMap.points.map((point) => number(point.rate)), [.5, 1.5]);
    assert.deepEqual(splitItems[1].timeMap.points.map((point) => number(point.rate)), [1.5, .5]);
  }
  assert.doesNotThrow(() => validateReferenceSession(fakeLock(structuredClone(splitRamp))));
  const nearestSplitRamp = compile(operationProgram(
    "split(at: 500ms)",
    "1s",
    `PictureClip(source: red, range: 0s ..< 1s, duration: 1s, ${ramp}, frameSelection: "nearest");`,
    "1s",
  ));
  assert.ok(track(nearestSplitRamp).editorial.items.every((item) =>
    item.timeMap?.kind === "speed-ramp" && item.timeMap.frameSelection === "nearest"));

  const slippedRamp = compile(operationProgram("slip(range: 0s ..< 1s, by: 500ms)", "1s", `PictureClip(source: red, range: 500ms ..< 1500ms, duration: 1s, ${ramp});`, "1s"));
  assert.deepEqual(summary(slippedRamp), [{ kind: "picture", destination: [0, 1], source: [1, 1] }]);
  assert.equal(track(slippedRamp).editorial.items[0].timeMap?.kind, "speed-ramp");
  assert.doesNotThrow(() => validateReferenceSession(fakeLock(structuredClone(slippedRamp))));

  const slideRamp = compile(operationProgram(
    "slide(range: 500ms ..< 1500ms, by: 250ms)",
    "2s",
    `Gap(duration: 500ms); PictureClip(source: red, range: 0s ..< 1s, duration: 1s, ${ramp}); Gap(duration: 500ms);`,
    "2s",
  ));
  assert.deepEqual(summary(slideRamp), [
    { kind: "gap", destination: [0, .75], source: undefined },
    { kind: "picture", destination: [.75, 1], source: [0, 1] },
    { kind: "gap", destination: [1.75, .25], source: undefined },
  ]);
  assert.equal(track(slideRamp).editorial.items[1].timeMap?.kind, "speed-ramp");
  assert.doesNotThrow(() => validateReferenceSession(fakeLock(structuredClone(slideRamp))));
});

test("operation diagnostics are stable, source-located, and reject no-op or unsupported plans", () => {
  const code = (source: string, expected: string, line?: number) => (error: unknown) => {
    assert.ok(error instanceof CutCompileError);
    const diagnostic = error.result.diagnostics.find((item) => item.code === expected);
    assert.ok(diagnostic, JSON.stringify(error.result.diagnostics));
    if (line !== undefined) assert.equal(diagnostic.span.start.line, line);
    return true;
  };
  assert.throws(() => compile(operationProgram("split(at: 1s)")), code(operationProgram("split(at: 1s)"), "CUT2090", 11));
  assert.throws(() => compile(operationProgram("split(at: 125ms)")), code(operationProgram("split(at: 125ms)"), "CUT2091", 11));
  assert.throws(() => compile(operationProgram("rippleDelete(range: 0s ..< 1s)", "3s")), code(operationProgram("rippleDelete(range: 0s ..< 1s)", "3s"), "CUT2092"));
  assert.throws(() => compile(operationProgram("overwrite(range: 0s ..< 1s, item: editGap(duration: 500ms))")), code(operationProgram("overwrite(range: 0s ..< 1s, item: editGap(duration: 500ms))"), "CUT2091"));
  assert.throws(() => compile(operationProgram("trim(keep: 750ms ..< 1250ms)")), code(operationProgram("trim(keep: 750ms ..< 1250ms)"), "CUT2091"));
  assert.throws(() => compile(operationProgram("slip(range: 0s ..< 1s, by: 0s)")), code(operationProgram("slip(range: 0s ..< 1s, by: 0s)"), "CUT2090", 11));
  assert.throws(() => compile(operationProgram("slip(range: 0s ..< 500ms, by: 250ms)")), code(operationProgram("slip(range: 0s ..< 500ms, by: 250ms)"), "CUT2093", 11));
  assert.throws(() => compile(operationProgram("slip(range: 0s ..< 1s, by: -250ms)")), code(operationProgram("slip(range: 0s ..< 1s, by: -250ms)"), "CUT2091", 11));
  assert.throws(() => compile(operationProgram("slip(range: 0s ..< 1s, by: 125ms)")), code(operationProgram("slip(range: 0s ..< 1s, by: 125ms)"), "CUT2091", 11));
  assert.throws(() => compile(operationProgram("slide(range: 0s ..< 1s, by: 250ms)")), code(operationProgram("slide(range: 0s ..< 1s, by: 250ms)"), "CUT2093", 11));
  assert.throws(() => compile(operationProgram("slide(range: 1s ..< 2s, by: 1s)")), code(operationProgram("slide(range: 1s ..< 2s, by: 1s)"), "CUT2091", 11));
  assert.throws(() => compile(operationProgram("slide(range: 1s ..< 1500ms, by: 250ms)")), code(operationProgram("slide(range: 1s ..< 1500ms, by: 250ms)"), "CUT2093", 11));

  const linkedBase = `PictureClip(source: red, range: 0s ..< 1s, duration: 1s, link: "take"); Gap(duration: 2s);`;
  assert.throws(() => compile(operationProgram("split(at: 500ms)", "3s", linkedBase)), code(operationProgram("split(at: 500ms)", "3s", linkedBase), "CUT2093"));

  const missingPair = operationProgram("split(at: 500ms)").replace("sourceDuration: 3s, ", "");
  assert.throws(() => compile(missingPair), code(missingPair, "CUT2090"));
  const empty = operationProgram("split(at: 500ms)").replace("[\n        split(at: 500ms)\n      ]", "[]");
  assert.throws(() => compile(empty), code(empty, "CUT2090"));

  const badType = operationProgram("rippleInsert(at: 1s, item: 1s)");
  assert.ok(checkCutModule(moduleFor(badType)).diagnostics.some((item) => item.code === "CUT2029" && /PictureEditItem/.test(item.message)));
  const unknownSlipArgument = operationProgram("slip(range: 0s ..< 1s, by: 250ms, handles: 1s)");
  assert.ok(checkCutModule(moduleFor(unknownSlipArgument)).diagnostics.some((item) => item.code === "CUT2027" && /handles/.test(item.message)));
});

function fakeLock(ir: CutAVIR) {
  const decodedVideoCadence = {
    format: "cut-decoded-video-cadence",
    version: 2,
    method: "ffprobe-show-frames-cfr-v2",
    quantization: "phase-floor",
    phaseNumerator: "0",
    streamIndex: 0,
    firstPts: "0",
    lastPts: "39",
    quantizedEndPts: "40",
    frameCount: "40",
    durationPresentCount: "40",
    durationCoverage: "complete",
    recordsSha256: "0".repeat(64),
    timeBase: rational(1, 4),
    frameRate: rational(4),
  } as const;
  for (const resource of Object.values(ir.resources)) {
    resource.state = "locked";
    resource.sha256 = "0".repeat(64);
    resource.metadata = {
      bytes: 1,
      probe: {
        kind: "media",
        identity: { streams: [{ index: 0, type: "video", frameRate: rational(4), timeBase: rational(1, 4), start: rational(0), duration: rational(10), width: 64, height: 64 }] },
        selected: { video: {
          streamIndex: 0,
          duration: rational(10),
          durationSource: "decoded-video-cadence",
          timeBase: rational(1, 4),
          frameRate: rational(4),
          decodedVideoCadence,
        } },
      },
    } as never;
  }
  ir.determinism.semantic = "locked";
  return ir;
}

test("closed typed operation plans reject loader and runtime tampering with stable diagnostics", () => {
  const source = operationProgram("rippleDelete(range: 500ms ..< 1500ms)", "2s");
  const unknown = JSON.parse(JSON.stringify(compile(source))) as CutAVIR;
  const unknownTrack = track(unknown);
  assert.ok(unknownTrack.editorial.operationPlan);
  (unknownTrack.editorial.operationPlan.operations[0] as unknown as Record<string, unknown>).ignored = true;
  assert.throws(() => validateCutAvIr(unknown), (error) => error instanceof CutAvIrValidationError && error.code === "CUT_IR_UNKNOWN_FIELD" && error.path.endsWith(".ignored"));

  const timing = fakeLock(compile(source));
  const timingTrack = track(timing), plan = timingTrack.editorial.operationPlan;
  assert.ok(plan);
  plan.operations[0] = { ...plan.operations[0], range: { start: rational(1, 8), duration: rational(1) } } as typeof plan.operations[0];
  assert.throws(() => validateReferenceSession(timing), (error) => {
    const diagnostic = cutDiagnosticsFromError(error)[0];
    assert.equal(diagnostic.code, "CUT_EDIT_OPERATION");
    assert.equal(diagnostic.source?.line, 11);
    assert.match(diagnostic.message, /picture grid|materialize|range/);
    return true;
  });

  const materialized = fakeLock(compile(source)), materializedTrack = track(materialized);
  materializedTrack.editorial.items[0].destination.duration = rational(1, 4);
  assert.throws(() => validateReferencePictureTrackOperationPlan(materialized, materialized.compositions[0], materializedTrack), /CUT_EDIT_OPERATION: materialized item 0 timing metadata/);

  const offGridSlip = fakeLock(compile(operationProgram("slip(range: 0s ..< 1s, by: 500ms)"))), offGridSlipTrack = track(offGridSlip);
  assert.ok(offGridSlipTrack.editorial.operationPlan?.operations[0]?.kind === "slip");
  offGridSlipTrack.editorial.operationPlan.operations[0].by = rational(1, 8);
  assert.throws(() => validateReferencePictureTrackOperationPlan(offGridSlip, offGridSlip.compositions[0], offGridSlipTrack), (error) => {
    const diagnostic = cutDiagnosticsFromError(error)[0];
    assert.equal(diagnostic.code, "CUT_EDIT_OPERATION");
    assert.equal(diagnostic.source?.line, 11);
    assert.match(diagnostic.message, /picture grid/);
    return true;
  });

  for (const leakedInput of ["sourceDuration", "edits"] as const) {
    const leaked = fakeLock(compile(source)), leakedTrack = track(leaked);
    delete leakedTrack.editorial.operationPlan;
    leakedTrack.inputs[leakedInput] = leakedInput === "sourceDuration"
      ? { kind: "quantity", dimension: "time", unit: "s", magnitude: rational(2) }
      : { kind: "array", items: [] };
    assert.throws(
      () => validateReferencePictureTrackOperationPlan(leaked, leaked.compositions[0], leakedTrack),
      /CUT_EDIT_OPERATION: compile-time edit operands must not leak into runtime PictureTrack inputs/,
    );
  }
});

test("formatting and comments do not change operation semantic identity while slip/slide deltas invalidate it", () => {
  const source = operationProgram("rippleInsert(at: 1s, item: editGap(duration: 500ms))", "3500ms");
  const first = compile(source), second = compile(source.replace("rippleInsert", "// exact edit\n        rippleInsert").replaceAll(";", ";\n"));
  assert.notEqual(first.sourceHash, second.sourceHash);
  assert.equal(first.buildId, second.buildId);
  assert.deepEqual(summary(first), summary(second));

  const slipSource = operationProgram("slip(range: 0s ..< 1s, by: 500ms)");
  const slipFormatted = compile(slipSource.replace("slip", "// source-window edit\n        slip").replaceAll(";", ";\n"));
  const slippedEarlier = compile(slipSource.replace("500ms", "250ms"));
  assert.equal(compile(slipSource).buildId, slipFormatted.buildId);
  assert.notEqual(compile(slipSource).buildId, slippedEarlier.buildId);
  assert.notDeepEqual(track(compile(slipSource)).children, track(slippedEarlier).children);

  const slideSource = operationProgram("slide(range: 1s ..< 2s, by: 500ms)");
  assert.notEqual(compile(slideSource).buildId, compile(slideSource.replace("500ms", "250ms")).buildId);
});

test("materialized operation plans render exact red, blue, and explicit-gap frame regions", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-picture-operations-")), media = resolve(root, "media");
  await mkdir(media);
  const generate = (name: string) => exec("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${name}:s=64x64:r=4:d=2`, "-c:v", "ffv1", "-pix_fmt", "yuv420p", resolve(media, `${name}.mkv`)]);
  await Promise.all([generate("red"), generate("green"), generate("blue")]);
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=red:s=64x64:r=4:d=1",
    "-f", "lavfi", "-i", "color=c=green:s=64x64:r=4:d=1",
    "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=4:d=1",
    "-f", "lavfi", "-i", "color=c=yellow:s=64x64:r=4:d=1",
    "-filter_complex", "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0,setpts=PTS/4,fps=4,format=yuv420p[v]",
    "-map", "[v]", "-t", "1", "-c:v", "ffv1", resolve(media, "quarters.mkv"),
  ]);

  const removedOutOfBounds = compile(operationProgram(
    "extract(range: 0s ..< 1s)",
    "1s",
    "PictureClip(source: red, range: 2s ..< 3s, duration: 1s); Gap(duration: 1s);",
    "2s",
  ));
  await assert.rejects(createCutLock(removedOutOfBounds, root), /PictureClip source range.*beyond the selected source bound/);

  const removedOffGrid = compile(operationProgram(
    "extract(range: 0s ..< 1s)",
    "1s",
    "PictureClip(source: red, range: 125ms ..< 1125ms, duration: 1s); Gap(duration: 1s);",
    "2s",
  ));
  const removedOffGridLock = await createCutLock(removedOffGrid, root);
  await applyCutLock(removedOffGrid, removedOffGridLock, root);
  assert.throws(() => validateReferenceSession(removedOffGrid), /CUT_EDIT_OPERATION: base:0 source start does not land on the locked 4\/1 fps grid/);

  const slippedOutOfBounds = compile(operationProgram(
    "slip(range: 0s ..< 1s, by: 1500ms)",
    "1s",
    "PictureClip(source: red, range: 0s ..< 1s, duration: 1s);",
    "1s",
  ));
  await assert.rejects(createCutLock(slippedOutOfBounds, root), /PictureClip source range.*beyond the selected source bound/);

  const source = operationProgram(`
          rippleInsert(at: 1s, item: editClip(source: blue, range: 0s ..< 500ms, duration: 500ms)),
          overwrite(range: 1500ms ..< 2s, item: editClip(source: blue, range: 500ms ..< 1s, duration: 500ms)),
          lift(range: 2s ..< 2500ms),
          extract(range: 2500ms ..< 3500ms)`, "2500ms");
  const ir = compile(source), lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  const { composition } = validateReferenceSession(ir), renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  await renderer.prepare();
  const center = (surface: { data: Buffer; width: number; height: number }) => {
    const offset = (Math.floor(surface.height / 2) * surface.width + Math.floor(surface.width / 2)) * 4;
    return [...surface.data.subarray(offset, offset + 4)];
  };
  try {
    const scene = ir.scenes[composition.sceneIds[0]], pixels: number[][] = [];
    for (let frame = 0; frame < 10; frame += 1) pixels.push(center(await renderer.sceneFrame(scene, frame)));
    for (const red of pixels.slice(0, 4)) assert.ok(red[0] > 180 && red[2] < 60, JSON.stringify(red));
    for (const blue of pixels.slice(4, 8)) assert.ok(blue[2] > 180 && blue[0] < 60, JSON.stringify(blue));
    for (const empty of pixels.slice(8, 10)) assert.deepEqual(empty, [5, 11, 16, 255]);
  } finally { renderer.close(); }

  const slipSlideSource = operationProgram(`
          slip(range: 250ms ..< 750ms, by: 500ms),
          slide(range: 250ms ..< 750ms, by: 250ms)`, "1500ms", `
          Gap(duration: 250ms);
          PictureClip(source: red, range: 0s ..< 500ms, duration: 500ms);
          Gap(duration: 750ms);`, "1500ms").replace("media/red.mkv", "media/quarters.mkv");
  const slipSlide = compile(slipSlideSource), slipSlideLock = await createCutLock(slipSlide, root);
  await applyCutLock(slipSlide, slipSlideLock, root);
  const { composition: slipSlideComposition } = validateReferenceSession(slipSlide);
  const slipSlideRenderer = new ReferenceVisualRenderer(slipSlide, slipSlideComposition, root, resolve(root, "cache-slip-slide"));
  await slipSlideRenderer.prepare();
  try {
    const scene = slipSlide.scenes[slipSlideComposition.sceneIds[0]], pixels: number[][] = [];
    for (let frame = 0; frame < 6; frame += 1) pixels.push(center(await slipSlideRenderer.sceneFrame(scene, frame)));
    assert.deepEqual(pixels[0], [5, 11, 16, 255]);
    assert.deepEqual(pixels[1], [5, 11, 16, 255]);
    assert.ok(pixels[2][2] > 180 && pixels[2][0] < 60 && pixels[2][1] < 80, JSON.stringify(pixels[2]));
    assert.ok(pixels[3][0] > 180 && pixels[3][1] > 180 && pixels[3][2] < 80, JSON.stringify(pixels[3]));
    assert.deepEqual(pixels[4], [5, 11, 16, 255]);
    assert.deepEqual(pixels[5], [5, 11, 16, 255]);
  } finally { slipSlideRenderer.close(); }
});
