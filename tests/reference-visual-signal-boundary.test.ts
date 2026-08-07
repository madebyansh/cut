import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { IRSignal, IRValue } from "../lib/language/ir";
import { CutAvIrValidationError, loadCutAvIr } from "../lib/language/ir-loader";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { cutSignalContentHash, finalizeGraphHashes } from "../lib/runtime/graph";
import { ReferenceNoOpContractError } from "../lib/runtime/reference/noop-contract";
import { evaluateSignal } from "../lib/runtime/reference/signals";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

function source(control: string) {
  return `cut 0.4;
project "visual signal half-open boundary";
import { Group, Rect } from "cut:visual";
timeline main(duration: 1s, fps: 10, width: 8px, height: 8px, sampleRate: 8khz) {
  scene only(duration: 1s) {
    Group() as g { Rect(width: 8px, height: 8px, fill: #ffffff); }
    ${control}
  }
}
export out = render(main);`;
}

function compile(control: string) {
  return compileProgram(source(control));
}

function compileProgram(program: string) {
  const parsed = parseCutLanguage(program);
  assert.ok(parsed.module);
  assert.deepEqual(parsed.diagnostics, []);
  const ir = compileCutModule(parsed.module).ir;
  ir.determinism.semantic = "locked";
  return ir;
}

function opacityTrack(ir: ReturnType<typeof compile>) {
  const group = Object.values(ir.nodes).find((node) => node.op === "cut.visual.group")!;
  const property = group.properties.opacity;
  assert.ok(property && "signal" in property);
  const signal = ir.signals[property.signal];
  assert.equal(signal.kind, "track");
  return { group, signal: signal as Extract<typeof signal, { kind: "track" }> };
}

function ratioValue(numerator: number, denominator = 1): IRValue {
  return { kind: "quantity", dimension: "ratio", unit: "ratio", magnitude: rational(numerator, denominator) };
}

function replaceOpacitySignal(ir: ReturnType<typeof compile>, replacement: (base: Extract<IRSignal, { kind: "track" }>) => IRSignal) {
  const { group, signal } = opacityTrack(ir);
  const next = replacement(signal);
  next.contentHash = cutSignalContentHash(next);
  ir.signals[signal.id] = next;
  finalizeGraphHashes(ir);
  return { group, signalId: signal.id, loaded: loadCutAvIr(JSON.stringify(ir)) };
}

async function frames(control: string) {
  return renderFrames(compile(control));
}

async function renderFrames(ir: ReturnType<typeof compile>) {
  const { composition } = validateReferenceSession(ir), root = await mkdtemp(resolve(tmpdir(), "cut-visual-signal-boundary-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  await renderer.prepare();
  try {
    const result = [];
    for (let frame = 0; frame < 10; frame += 1) result.push(await renderer.sceneFrame(ir.scenes[composition.sceneIds[0]], frame, false));
    return result;
  } finally {
    renderer.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("a visual set at the half-open interval end is a stable source error", () => {
  const parsed = parseCutLanguage(source("at 1s { set g.opacity = 0%; }"));
  assert.ok(parsed.module);
  assert.throws(
    () => compileCutModule(parsed.module!),
    (error: unknown) => error instanceof CutCompileError
      && error.result.diagnostics.some((item) => item.code === "CUT2085"
        && /CUT_NODE_NOOP: visual property “opacity”.*set start lies outside its half-open owning node interval/.test(item.message)),
  );
});

test("the exact last-frame visual set executes while animate may end at the interval boundary", async () => {
  const baseline = await frames("");
  const lastFrame = await frames("at 900ms { set g.opacity = 0%; }");
  for (let frame = 0; frame < 9; frame += 1) assert.deepEqual(lastFrame[frame].data, baseline[frame].data, `frame ${frame}`);
  assert.notDeepEqual(lastFrame[9].data, baseline[9].data, "the last representable frame write executes");
  assert.ok([...lastFrame[9].data].every((value) => value === 0), "the final frame is transparent");

  const animated = compile("animate g.opacity from 100% to 0% over 1s;");
  assert.doesNotThrow(() => validateReferenceSession(animated), "an animation end may equal the owning interval end because its endpoint shapes preceding samples/frames");
  const rendered = await frames("animate g.opacity from 100% to 0% over 1s;");
  assert.ok(rendered[0].data.some((value) => value !== 0));
  assert.notDeepEqual(rendered[9].data, rendered[0].data, "boundary-ending animation changes visible frames");
});

test("a sub-frame set after the last output sample is rejected instead of silently changing identity", () => {
  for (const control of [
    "at 950ms { set g.opacity = 0%; }",
    "at 999ms { set g.opacity = 50%; }",
    "at 900ms { set g.opacity = 100%; }",
    "at 900ms { set g.opacity = 50%; set g.opacity = 0%; }",
  ]) {
    const parsed = parseCutLanguage(source(control));
    assert.ok(parsed.module);
    assert.throws(
      () => compileCutModule(parsed.module!),
      (error: unknown) => error instanceof CutCompileError
        && error.result.diagnostics.some((item) => item.code === "CUT2085"
          && /events\[0\] set never changes an exact output-frame sample/.test(item.message)),
      control,
    );
  }
  assert.doesNotThrow(() => compile("at 850ms { set g.opacity = 0%; }"), "a sub-frame set before frame 9 persists and changes the 900ms sample");
});

test("the exact no-op proof covers a five-minute 30fps professional-duration node", () => {
  const program = `cut 0.4;
project "professional duration no-op boundary";
import { Group, Rect } from "cut:visual";
timeline main(duration: 300s, fps: 30, width: 8px, height: 8px, sampleRate: 48khz) {
  scene only(duration: 300s) {
    Group() as longShot { Rect(width: 8px, height: 8px, fill: #ffffff); }
    at 299999ms { set longShot.opacity = 0%; }
  }
}
export out = render(main);`;
  assert.throws(
    () => compileProgram(program),
    (error: unknown) => error instanceof CutCompileError
      && error.result.diagnostics.some((item) => item.code === "CUT2085"
        && /events\[0\] set never changes an exact output-frame sample/.test(item.message)),
  );
});

test("long-form multi-event counterfactual validation is deterministic and does not mutate canonical IR", () => {
  const program = `cut 0.4;
project "immutable long-form counterfactual proof";
import { Group, Rect } from "cut:visual";
timeline main(duration: 20s, fps: 24, width: 8px, height: 8px, sampleRate: 48khz) {
  scene only(duration: 20s) {
    Group() as moving { Rect(width: 8px, height: 8px, fill: #ffffff); }
    animate moving.x from 0px to 20px over 2s;
    at 4s { set moving.x = 40px; }
    animate moving.x from 40px to 10px over 2s delay 6s;
    animate moving.opacity from 100% to 50% over 3s delay 10s;
  }
}
export out = render(main);`;
  const ir = compileProgram(program);
  const canonical = JSON.stringify(ir);
  const buildId = ir.buildId;
  assert.doesNotThrow(() => validateReferenceSession(ir));
  assert.doesNotThrow(() => validateReferenceSession(ir));
  assert.equal(JSON.stringify(ir), canonical, "remove-one-item proofs must not mutate caller-owned signals or graph state");
  assert.equal(ir.buildId, buildId);
  const reloaded = loadCutAvIr(canonical);
  assert.equal(reloaded.buildId, buildId);
  assert.doesNotThrow(() => validateReferenceSession(reloaded));
});

test("legal graph depth and maximum temporal amplification fail closed when exact proof exceeds budget", () => {
  let body = `Rect(width: 8px, height: 8px, fill: #ffffff, opacity: 90%) as target;
at 299992ms { set target.opacity = 0%; }`;
  for (let depth = 0; depth < 8; depth += 1) body = `Group() { ${body} }`;
  const program = `cut 0.4;
project "bounded visual no-op proof";
import { Group, MotionBlur, Rect } from "cut:visual";
timeline main(duration: 300s, fps: 30, width: 8px, height: 8px, sampleRate: 48khz) {
  scene only(duration: 300s) {
    MotionBlur(shutterAngle: 360deg, samples: 32) {
      MotionBlur(shutterAngle: 360deg, samples: 2) { ${body} }
    }
  }
}
export out = render(main);`;
  assert.throws(
    () => compileProgram(program),
    (error: unknown) => error instanceof CutCompileError
      && error.result.diagnostics.some((item) => item.code === "CUT2085"
        && /exact execution\/no-op proof requires more than 4000000 bounded graph visits/.test(item.message)),
  );
});

test("strict loaded IR cannot move an otherwise visible set past the final output sample", () => {
  const ir = compile("at 900ms { set g.opacity = 0%; }");
  const { group, signal } = opacityTrack(ir);
  assert.equal(signal.events[0]?.kind, "set");
  if (signal.events[0]?.kind === "set") signal.events[0].time = rational(19, 20);
  signal.contentHash = cutSignalContentHash(signal);
  finalizeGraphHashes(ir);
  const loaded = loadCutAvIr(JSON.stringify(ir));
  assert.throws(
    () => validateReferenceSession(loaded),
    (error: unknown) => error instanceof ReferenceNoOpContractError
      && error.source.nodeId === group.id
      && /events\[0\] set never changes an exact output-frame sample/.test(error.message),
  );
});

test("strict IR must capture a same-named constructor input as the visual track baseline", () => {
  for (const fixture of [
    {
      op: "cut.visual.group",
      property: "opacity",
      program: `cut 0.4;
project "group baseline ownership";
import { Group, Rect } from "cut:visual";
timeline main(duration: 1s, fps: 10, width: 8px, height: 8px, sampleRate: 8khz) {
  scene only(duration: 1s) {
    Group(opacity: 50%) as target { Rect(width: 8px, height: 8px, fill: #ffffff); }
    at 900ms { set target.opacity = 0%; }
  }
}
export out = render(main);`,
    },
    {
      op: "cut.visual.color_grade",
      property: "saturation",
      program: `cut 0.4;
project "grade baseline ownership";
import { ColorGrade, Rect } from "cut:visual";
timeline main(duration: 1s, fps: 10, width: 8px, height: 8px, sampleRate: 8khz) {
  scene only(duration: 1s) {
    ColorGrade(saturation: 0.5) as target { Rect(width: 8px, height: 8px, fill: #ffffff); }
    at 900ms { set target.saturation = 1; }
  }
}
export out = render(main);`,
    },
  ]) {
    const ir = compileProgram(fixture.program);
    const node = Object.values(ir.nodes).find((candidate) => candidate.op === fixture.op)!;
    const property = node.properties[fixture.property];
    assert.ok(property && "signal" in property);
    const signal = ir.signals[property.signal];
    assert.equal(signal.kind, "track");
    if (signal.kind !== "track") continue;
    assert.notEqual(signal.initial.kind, "null", "public lowering captures the constructor baseline");
    signal.initial = { kind: "null" };
    signal.contentHash = cutSignalContentHash(signal);
    finalizeGraphHashes(ir);
    assert.throws(
      () => loadCutAvIr(JSON.stringify(ir)),
      (error: unknown) => error instanceof CutAvIrValidationError
        && error.code === "CUT_VISUAL_BASELINE"
        && error.path === `$.signals.${signal.id}.initial`
        && /initial is null.*canonical constructor input/.test(error.message),
      fixture.op,
    );
  }
});

test("MotionBlur shutter samples keep a sub-frame visual set observable", async () => {
  const program = (control: string) => `cut 0.4;
project "temporal signal reachability";
import { Group, MotionBlur, Rect } from "cut:visual";
timeline main(duration: 1s, fps: 10, width: 8px, height: 8px, sampleRate: 8khz) {
  scene only(duration: 1s) {
    MotionBlur(shutterAngle: 360deg, samples: 4) {
      Group() as moving { Rect(width: 8px, height: 8px, fill: #ffffff); }
      ${control}
    }
  }
}
export out = render(main);`;
  const baseline = await renderFrames(compileProgram(program("")));
  const shutterVisible = await renderFrames(compileProgram(program("at 925ms { set moving.opacity = 0%; }")));
  for (let frame = 0; frame < 9; frame += 1) assert.deepEqual(shutterVisible[frame].data, baseline[frame].data, `frame ${frame}`);
  assert.notDeepEqual(
    shutterVisible[9].data,
    baseline[9].data,
    "the 937.5ms shutter sample executes the 925ms set even though the final ordinary output time is 900ms",
  );
});

test("constant, step, and keyframe payloads are compared against exact frame-grid counterfactuals", () => {
  const base = () => compile("animate g.opacity from 100% to 0% over 1s;");
  const linearCurve = (() => {
    const { signal } = opacityTrack(base());
    const event = signal.events.find((candidate) => candidate.kind === "animate");
    assert.ok(event && event.kind === "animate");
    return event.curve;
  })();
  const signalShape = (original: Extract<IRSignal, { kind: "track" }>, payload: Readonly<Record<string, unknown> & { kind: IRSignal["kind"] }>): IRSignal => ({
    id: original.id,
    valueType: original.valueType,
    contentHash: original.contentHash,
    provenance: original.provenance,
    ...payload,
  } as IRSignal);

  const defaultConstant = replaceOpacitySignal(base(), (original) => signalShape(original, { kind: "constant", value: ratioValue(1) }));
  assert.throws(() => validateReferenceSession(defaultConstant.loaded), (error: unknown) => error instanceof ReferenceNoOpContractError
    && error.source.nodeId === defaultConstant.group.id
    && /never differs from its signal-free input\/default/.test(error.message));
  const visibleConstant = replaceOpacitySignal(base(), (original) => signalShape(original, { kind: "constant", value: ratioValue(1, 2) }));
  assert.doesNotThrow(() => validateReferenceSession(visibleConstant.loaded));

  const lateStep = replaceOpacitySignal(base(), (original) => signalShape(original, {
    kind: "step",
    points: [
      { time: rational(0), value: ratioValue(1) },
      { time: rational(19, 20), value: ratioValue(0) },
    ],
  }));
  assert.throws(() => validateReferenceSession(lateStep.loaded), (error: unknown) => error instanceof ReferenceNoOpContractError
    && /points\[1\] point never changes an exact output-frame sample/.test(error.message));
  const lastFrameStep = replaceOpacitySignal(base(), (original) => signalShape(original, {
    kind: "step",
    points: [
      { time: rational(0), value: ratioValue(1) },
      { time: rational(9, 10), value: ratioValue(0) },
    ],
  }));
  assert.deepEqual(evaluateSignal(lastFrameStep.loaded, lastFrameStep.signalId, rational(0)), ratioValue(1));
  assert.deepEqual(evaluateSignal(lastFrameStep.loaded, lastFrameStep.signalId, rational(9, 10)), ratioValue(0));
  assert.doesNotThrow(() => validateReferenceSession(lastFrameStep.loaded), "the first point prevents the later point from applying before 900ms, and the second changes frame 9");
  const redundantStep = replaceOpacitySignal(base(), (original) => signalShape(original, {
    kind: "step",
    points: [
      { time: rational(0), value: ratioValue(1) },
      { time: rational(1, 2), value: ratioValue(1) },
      { time: rational(9, 10), value: ratioValue(0) },
    ],
  }));
  assert.throws(() => validateReferenceSession(redundantStep.loaded), (error: unknown) => error instanceof ReferenceNoOpContractError
    && /points\[[01]\] point never changes an exact output-frame sample/.test(error.message));

  const collinear = replaceOpacitySignal(base(), (original) => signalShape(original, {
    kind: "keyframes",
    keyframes: [
      { time: rational(0), value: ratioValue(1), curve: linearCurve },
      { time: rational(1, 2), value: ratioValue(1, 2), curve: linearCurve },
      { time: rational(1), value: ratioValue(0), curve: linearCurve },
    ],
  }));
  assert.throws(() => validateReferenceSession(collinear.loaded), (error: unknown) => error instanceof ReferenceNoOpContractError
    && /keyframes\[1\] keyframe never changes an exact output-frame sample/.test(error.message));
  const shaped = replaceOpacitySignal(base(), (original) => signalShape(original, {
    kind: "keyframes",
    keyframes: [
      { time: rational(0), value: ratioValue(1), curve: linearCurve },
      { time: rational(1, 2), value: ratioValue(4, 5), curve: linearCurve },
      { time: rational(1), value: ratioValue(0), curve: linearCurve },
    ],
  }));
  assert.doesNotThrow(() => validateReferenceSession(shaped.loaded));
});

test("strict loaded IR cannot move visual track starts outside the half-open interval", () => {
  const setIr = compile("at 500ms { set g.opacity = 0%; }");
  const set = opacityTrack(setIr);
  assert.equal(set.signal.events[0].kind, "set");
  if (set.signal.events[0].kind === "set") set.signal.events[0].time = rational(1);
  set.signal.contentHash = cutSignalContentHash(set.signal); finalizeGraphHashes(setIr);
  const loadedSet = loadCutAvIr(JSON.stringify(setIr));
  assert.throws(
    () => validateReferenceSession(loadedSet),
    (error: unknown) => error instanceof ReferenceNoOpContractError
      && error.code === "CUT_NODE_NOOP"
      && error.source.nodeId === set.group.id
      && /set start lies outside its half-open owning node interval/.test(error.message),
  );

  const animateIr = compile("animate g.opacity from 100% to 0% over 500ms;");
  const animated = opacityTrack(animateIr);
  assert.equal(animated.signal.events[0].kind, "animate");
  if (animated.signal.events[0].kind === "animate") {
    animated.signal.events[0].start = rational(1);
    animated.signal.events[0].end = rational(11, 10);
  }
  animated.signal.contentHash = cutSignalContentHash(animated.signal); finalizeGraphHashes(animateIr);
  const loadedAnimate = loadCutAvIr(JSON.stringify(animateIr));
  assert.throws(
    () => validateReferenceSession(loadedAnimate),
    (error: unknown) => error instanceof ReferenceNoOpContractError
      && /animate start lies outside its half-open owning node interval/.test(error.message),
  );

  const overrunIr = compile("animate g.opacity from 100% to 0% over 500ms;");
  const overrun = opacityTrack(overrunIr);
  if (overrun.signal.events[0].kind === "animate") overrun.signal.events[0].end = rational(11, 10);
  overrun.signal.contentHash = cutSignalContentHash(overrun.signal); finalizeGraphHashes(overrunIr);
  const loadedOverrun = loadCutAvIr(JSON.stringify(overrunIr));
  assert.throws(
    () => validateReferenceSession(loadedOverrun),
    (error: unknown) => error instanceof ReferenceNoOpContractError
      && /animate end lies outside its owning node interval/.test(error.message),
  );
});
