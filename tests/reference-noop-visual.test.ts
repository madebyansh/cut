import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR, IRNode, IRValue } from "../lib/language/ir";
import { loadCutAvIr } from "../lib/language/ir-loader";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { cutSignalContentHash, finalizeGraphHashes } from "../lib/runtime/graph";
import {
  ReferenceNoOpContractError,
  referenceNoOpDiagnosticCode,
} from "../lib/runtime/reference/noop-contract";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

const imports = `import { Camera2D, Circle, ColorConvert, Composite, Group, Mask, MotionPath, Path, Rect, Stack, Text, Trace } from "cut:visual";
import { Gain, Tone } from "@cut/audio";`;

function program(body: string, font = false) {
  return `cut 0.4;
project "visual no-op closure";
${imports}
${font ? 'asset face: FontAsset = font("face.ttf");' : ""}
timeline main(duration: 1s, fps: 24, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    ${body}
  }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
}

function parse(body: string, font = false) {
  const result = parseCutLanguage(program(body, font));
  assert.ok(result.module, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.diagnostics, []);
  return result.module;
}

function compile(body: string) {
  return compileCutModule(parse(body)).ir;
}

function expectSourceDiagnostic(body: string, code: string, expected: RegExp, font = false) {
  assert.throws(() => compileCutModule(parse(body, font)), (error: unknown) => {
    assert.ok(error instanceof CutCompileError, body);
    const diagnostic = error.result.diagnostics.find((candidate) => candidate.code === code);
    assert.ok(diagnostic, `${body}: ${JSON.stringify(error.result.diagnostics)}`);
    assert.match(diagnostic.message, expected, body);
    assert.ok(diagnostic.span.start.line > 0 && diagnostic.span.start.column > 0, body);
    const json = JSON.parse(JSON.stringify(diagnostic)) as typeof diagnostic;
    assert.equal(json.code, code);
    assert.ok(json.span.start.line > 0 && json.span.start.column > 0);
    return true;
  });
}

function expectSourceNoOp(body: string, expected: RegExp, font = false) {
  expectSourceDiagnostic(body, "CUT2085", expected, font);
}

function expectMotionPathSourceNoOp(body: string, expected: RegExp) {
  expectSourceDiagnostic(body, "CUT_MOTION_PATH_NOOP", expected);
}

function expectAccepted(body: string, font = false) {
  assert.doesNotThrow(() => compileCutModule(parse(body, font)), body);
}

function node(ir: CutAVIR, op: string, occurrence = 0) {
  const result = Object.values(ir.nodes).filter((candidate) => candidate.op === op)[occurrence];
  assert.ok(result, `missing ${op} occurrence ${occurrence}`);
  return result;
}

function propertySignal(ir: CutAVIR, target: IRNode, property: string) {
  const reference = target.properties[property];
  assert.ok(reference && "signal" in reference, `missing ${target.op}.${property}`);
  const signal = ir.signals[reference.signal];
  assert.ok(signal, `missing ${reference.signal}`);
  return signal;
}

function hostile(body: string, mutate: (ir: CutAVIR) => void) {
  const ir = compile(body);
  ir.determinism.semantic = "locked";
  mutate(ir);
  for (const signal of Object.values(ir.signals)) signal.contentHash = cutSignalContentHash(signal);
  finalizeGraphHashes(ir);
  return loadCutAvIr(JSON.stringify(ir));
}

function expectRuntimeNoOp(ir: CutAVIR, expected: RegExp) {
  assert.throws(() => validateReferenceSession(ir), (error: unknown) => {
    assert.ok(error instanceof ReferenceNoOpContractError, String(error));
    assert.equal(error.code, referenceNoOpDiagnosticCode);
    assert.match(error.message, expected);
    assert.match(error.message, /project\.cut:\d+:\d+/);
    assert.ok(error.source.line > 0 && error.source.column > 0);
    return true;
  });
}

async function renderFrames(ir: CutAVIR, frames: readonly number[], validate = false) {
  ir.determinism.semantic = "locked";
  const composition = validate ? validateReferenceSession(ir).composition : ir.compositions[0];
  const scene = ir.scenes[composition.sceneIds[0]];
  const root = await mkdtemp(resolve(tmpdir(), "cut-visual-noop-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  try {
    await renderer.prepare();
    const result: Buffer[] = [];
    for (const frame of frames) result.push(Buffer.from((await renderer.sceneFrame(scene, frame, false)).data));
    return result;
  } finally {
    renderer.close();
    await rm(root, { recursive: true, force: true });
  }
}

const redRect = "Rect(width: 8px, height: 8px, x: 32px, y: 32px, fill: #ff0000)";

test("typed source rejects equal and output-frame-inert visual animations while nearby motion remains executable", () => {
  expectSourceNoOp(
    `Group() as layer { ${redRect}; } animate layer.opacity from 50% to 50% over 10f;`,
    /canonically equal animation endpoints/,
  );
  expectSourceNoOp(
    `Group() as layer { ${redRect}; } animate layer.x from 0px to 24px over 1f delay 23f;`,
    /events\[0\] animate never changes an exact output-frame sample/,
  );

  expectAccepted(`Group() as layer { ${redRect}; } animate layer.x from 0px to 24px over 2f delay 22f;`);
  expectAccepted(`Group() as layer { ${redRect}; } animate layer.opacity from 50% to 75% over 10f;`);
});

test("canonical equal-endpoint refusal also closes validated audio property automation", () => {
  const inert = "Gain(amount: -6db) as voice { Tone(frequency: 440hz, duration: 1s); } animate voice.amount from -6db to -6db over 100ms;";
  expectSourceNoOp(inert, /audio property “amount”.*canonically equal animation endpoints/);
  expectAccepted("Gain(amount: -6db) as voice { Tone(frequency: 440hz, duration: 1s); } animate voice.amount from -6db to -3db over 100ms;");

  const loaded = hostile("Gain(amount: -6db) as voice { Tone(frequency: 440hz, duration: 1s); } animate voice.amount from -6db to -3db over 100ms;", (ir) => {
    const signal = propertySignal(ir, node(ir, "cut.audio.gain"), "amount");
    assert.equal(signal.kind, "track");
    if (signal.kind === "track" && signal.events[0]?.kind === "animate") signal.events[0].to = signal.events[0].from;
  });
  expectRuntimeNoOp(loaded, /audio property “amount”.*canonically equal animation endpoints/);
});

test("retained wrappers accept fractional pixel positions, anchors, and signal endpoints", () => {
  const accepted = [
    `Group(x: 0.49px) { ${redRect}; }`,
    `Stack(x: -0.5px) { ${redRect}; ${redRect}; }`,
    `Composite(y: 0.5px) { ${redRect}; ${redRect}; }`,
    `Mask(x: -0.5px) { ${redRect}; Rect(width: 64px, height: 64px, x: 32px, y: 32px, fill: #ffffff); }`,
    `Camera2D(x: -0.51px) { ${redRect}; }`,
    `Group(anchorX: 0.5px, anchorY: -0.5px) { ${redRect}; }`,
    `Group() as layer { ${redRect}; } animate layer.x from -0.5px to 0.5px over 2f;`,
  ];
  for (const body of accepted) expectAccepted(body);

  expectAccepted(`Group(x: -1px, scale: 1.25, rotation: 0.5deg, skewX: 0.5deg) { ${redRect}; }`);
  expectAccepted("Circle(radius: 4px, x: 31.5px, y: 32.5px, fill: #ff0000);");
  expectAccepted("Path(points: [{ x: 0.25px, y: 1.5px }, { x: 20.75px, y: 8.25px }], stroke: #ffffff, width: 1px);");
});

test("one-child centered Stack refuses only frame controls proven inert by its symmetric layout algebra", () => {
  expectSourceNoOp(
    `Stack(width: 40px, height: 44px, padding: 2px, safeArea: 1px) { ${redRect}; }`,
    /centered one-child Stack.*inert explicitly authored control\(s\): height, padding, safeArea, width/,
  );

  expectAccepted(`Stack(align: "start", width: 40px) { ${redRect}; }`);
  expectAccepted(`Stack(distribution: "start", height: 44px, padding: 2px, safeArea: 1px) { ${redRect}; }`);
  expectAccepted(`Stack(width: 40px, height: 44px, padding: 2px, safeArea: 1px) { ${redRect}; Circle(radius: 3px, fill: #00ff00); }`);
});

test("ColorConvert identity and permanently transparent main paints fail closed with explicit visible alternatives", () => {
  expectSourceNoOp(`ColorConvert(from: "srgb", to: "srgb") { ${redRect}; }`, /ColorConvert from and to are both “srgb”/);
  expectAccepted(`ColorConvert(from: "srgb", to: "linear-srgb") { ${redRect}; }`);
  expectSourceNoOp("Rect(width: 8px, height: 8px, gradientFrom: #ff0000, gradientTo: #ff0000);", /gradientFrom and gradientTo are both #ff0000.*use fill/);
  expectAccepted("Rect(width: 8px, height: 8px, fill: #ff0000);");
  expectSourceNoOp(`MotionPath(points: [{ x: 8px, y: 32px }, { x: 56px, y: 32px }, { x: 8px, y: 32px }], closed: true) { ${redRect}; }`, /closed MotionPath.*omit a terminal point equal to its first/);
  expectMotionPathSourceNoOp(
    `MotionPath(points: [{ x: 8px, y: 32px }, { x: 56px, y: 32px }], closed: true) { ${redRect}; }`,
    /closed: true.*never changes position or executed tangent orientation.*exact reachable output-frame sample/,
  );
  expectMotionPathSourceNoOp(
    `MotionPath(points: [{ x: 8px, y: 32px }, { x: 56px, y: 32px }], orientToPath: true) { ${redRect}; }`,
    /orientToPath: true.*never changes position or executed tangent orientation.*exact reachable output-frame sample/,
  );
  expectAccepted(`MotionPath(points: [{ x: 8px, y: 32px }, { x: 56px, y: 32px }], closed: true) as loop { ${redRect}; } animate loop.progress from 0% to 100% over 1s;`);
  expectAccepted(`MotionPath(points: [{ x: 32px, y: 8px }, { x: 32px, y: 56px }], orientToPath: true) { ${redRect}; }`);

  const transparent: ReadonlyArray<readonly [string, RegExp, boolean?]> = [
    ["Rect(width: 8px, height: 8px, fill: #ff000000);", /Rect fill cannot be fully transparent/],
    ["Circle(radius: 4px, fill: #00ff0000);", /Circle fill cannot be fully transparent/],
    ["Path(points: [{ x: 1px, y: 1px }, { x: 8px, y: 8px }], stroke: #ffffff00, width: 1px);", /Path stroke cannot be fully transparent/],
    ["Trace(points: [{ x: 1px, y: 1px }, { x: 8px, y: 8px }], stroke: #ffffff00, width: 1px, duration: 1s);", /Trace stroke cannot be fully transparent/],
    ["Text(content: \"A\", font: face, x: 4px, y: 32px, size: 20px, maxWidth: 56px, color: #ffffff00, shadowColor: #000000, shadowOpacity: 100%, shadowBlur: 3px);", /Text color cannot be fully transparent/, true],
  ];
  for (const [body, expected, font] of transparent) expectSourceNoOp(body, expected, font);

  expectAccepted("Rect(width: 8px, height: 8px, gradientFrom: #ff000000, gradientTo: #ff0000ff);");
  expectAccepted("Trace(points: [{ x: 1px, y: 1px }, { x: 8px, y: 8px }], stroke: #ffffff00, width: 1px, duration: 800ms, headRadius: 2px, headColor: #ff0000, headFade: 100ms);");
  expectAccepted(`Rect(width: 8px, height: 8px, fill: #ff0000, opacity: 0%) as reveal; animate reveal.opacity from 0% to 100% over 12f;`);
  expectAccepted(`Mask() { ${redRect}; Group(); }`, false);
});

test("hostile loaded IR cannot bypass animation, Stack, color, or paint no-op checks", () => {
  const equal = hostile(`Group() as layer { ${redRect}; } animate layer.opacity from 25% to 50% over 10f;`, (ir) => {
    const signal = propertySignal(ir, node(ir, "cut.visual.group"), "opacity");
    assert.equal(signal.kind, "track");
    if (signal.kind === "track" && signal.events[0]?.kind === "animate") signal.events[0].to = signal.events[0].from;
  });
  expectRuntimeNoOp(equal, /canonically equal animation endpoints/);

  const lastFrame = hostile(`Group() as layer { ${redRect}; } animate layer.x from 0px to 24px over 2f delay 22f;`, (ir) => {
    const signal = propertySignal(ir, node(ir, "cut.visual.group"), "x");
    assert.equal(signal.kind, "track");
    if (signal.kind === "track" && signal.events[0]?.kind === "animate") {
      signal.events[0].start = rational(23, 24);
      signal.events[0].end = rational(1);
    }
  });
  expectRuntimeNoOp(lastFrame, /events\[0\] animate never changes an exact output-frame sample/);

  const fractional = hostile(`Group(x: 1px) { ${redRect}; }`, (ir) => {
    node(ir, "cut.visual.group").inputs.x = { kind: "quantity", dimension: "length", unit: "px", magnitude: rational(-1, 2) };
  });
  assert.doesNotThrow(() => validateReferenceSession(fractional), "valid hostile-loaded fractional placement must execute through the same typed runtime contract");

  const stack = hostile(`Stack(align: "start", width: 40px) { ${redRect}; }`, (ir) => {
    const target = node(ir, "cut.visual.stack");
    delete target.inputs.align;
    target.inputs.height = { kind: "quantity", dimension: "length", unit: "px", magnitude: rational(44) };
  });
  expectRuntimeNoOp(stack, /centered one-child Stack/);

  const color = hostile(`ColorConvert(from: "srgb", to: "linear-srgb") { ${redRect}; }`, (ir) => {
    node(ir, "cut.visual.color_convert").inputs.to = { kind: "string", value: "srgb" };
  });
  expectRuntimeNoOp(color, /identity color conversion/);

  const paint = hostile("Circle(radius: 4px, fill: #00ff00);", (ir) => {
    node(ir, "cut.visual.circle").inputs.fill = { kind: "color", value: "#00ff0000" };
  });
  expectRuntimeNoOp(paint, /Circle fill cannot be fully transparent/);

  const gradient = hostile("Rect(width: 8px, height: 8px, gradientFrom: #ff0000, gradientTo: #0000ff);", (ir) => {
    node(ir, "cut.visual.rect").inputs.gradientTo = { kind: "color", value: "#ff0000" };
  });
  expectRuntimeNoOp(gradient, /gradientFrom and gradientTo are both #ff0000/);

  const closedPath = hostile(`MotionPath(points: [{ x: 8px, y: 32px }, { x: 56px, y: 32px }], closed: true) as loop { ${redRect}; } animate loop.progress from 0% to 100% over 1s;`, (ir) => {
    const points = node(ir, "cut.visual.motion_path").inputs.points;
    assert.equal(points?.kind, "array");
    if (points?.kind === "array") points.items.push(structuredClone(points.items[0]));
  });
  expectRuntimeNoOp(closedPath, /closed MotionPath.*terminal point equal to its first/);

  const inertOrientation = hostile(`MotionPath(points: [{ x: 32px, y: 8px }, { x: 32px, y: 56px }], orientToPath: true) { ${redRect}; }`, (ir) => {
    const points = node(ir, "cut.visual.motion_path").inputs.points;
    assert.equal(points?.kind, "array");
    if (points?.kind === "array") points.items = [
      { kind: "object", entries: { x: { kind: "quantity", dimension: "length", unit: "px", magnitude: rational(8) }, y: { kind: "quantity", dimension: "length", unit: "px", magnitude: rational(32) } } },
      { kind: "object", entries: { x: { kind: "quantity", dimension: "length", unit: "px", magnitude: rational(56) }, y: { kind: "quantity", dimension: "length", unit: "px", magnitude: rational(32) } } },
    ];
  });
  assert.throws(
    () => validateReferenceSession(inertOrientation),
    (error: unknown) => error instanceof Error
      && /CUT_MOTION_PATH_NOOP.*orientToPath: true.*never changes position or executed tangent orientation/u.test(error.message),
  );
});

test("the last-frame animation counterexample is byte-identical on all frames but a two-frame variant changes pixels", async () => {
  const baseline = compile(`Group() { ${redRect}; }`);
  const inert = compile(`Group() as layer { ${redRect}; } animate layer.x from 0px to 24px over 2f delay 22f;`);
  const inertSignal = propertySignal(inert, node(inert, "cut.visual.group"), "x");
  assert.equal(inertSignal.kind, "track");
  if (inertSignal.kind === "track" && inertSignal.events[0]?.kind === "animate") {
    inertSignal.events[0].start = rational(23, 24);
    inertSignal.events[0].end = rational(1);
  }
  const frames = Array.from({ length: 24 }, (_, index) => index);
  assert.deepEqual(await renderFrames(inert, frames), await renderFrames(baseline, frames));

  for (const signal of Object.values(inert.signals)) signal.contentHash = cutSignalContentHash(signal);
  finalizeGraphHashes(inert);
  expectRuntimeNoOp(loadCutAvIr(JSON.stringify(inert)), /events\[0\] animate never changes an exact output-frame sample/);

  const moving = compile(`Group() as layer { ${redRect}; } animate layer.x from 0px to 24px over 2f delay 22f;`);
  const movingFrames = await renderFrames(moving, [22, 23], true);
  assert.notDeepEqual(movingFrames[0], movingFrames[1], "the representable to sample at frame 23 must move retained pixels");
});

test("retained positive and negative half-pixel translation are distinct from integer placement", async () => {
  const baseline = compile(`Group() { ${redRect}; }`), baselineFrame = (await renderFrames(baseline, [0], true))[0];
  const positiveHalf = (await renderFrames(compile(`Group(x: 0.5px) { ${redRect}; }`), [0], true))[0];
  const negativeHalf = (await renderFrames(compile(`Group(x: -0.5px) { ${redRect}; }`), [0], true))[0];
  assert.notDeepEqual(positiveHalf, baselineFrame, "+0.5px must execute rather than round to an integer placement");
  assert.notDeepEqual(negativeHalf, baselineFrame, "-0.5px must execute rather than round to an integer placement");
  assert.notDeepEqual(positiveHalf, negativeHalf, "signed half-pixel placement must retain direction");

  const plusOne = (await renderFrames(compile(`Group(x: 1px) { ${redRect}; }`), [0], true))[0];
  const minusOne = (await renderFrames(compile(`Group(x: -1px) { ${redRect}; }`), [0], true))[0];
  assert.notDeepEqual(plusOne, baselineFrame);
  assert.notDeepEqual(minusOne, baselineFrame);
  assert.notDeepEqual(plusOne, minusOne);

  const transformed = (await renderFrames(compile(`Group(scale: 1.25, rotation: 12.5deg, skewX: 4.5deg) { ${redRect}; }`), [0], true))[0];
  assert.notDeepEqual(transformed, baselineFrame, "fractional scale/rotation/skew use executable resampling instead of the integer placement path");
  const intrinsic = (await renderFrames(compile("Circle(radius: 4px, x: 31.5px, y: 32.5px, fill: #ff0000);"), [0], true))[0];
  const integralIntrinsic = (await renderFrames(compile("Circle(radius: 4px, x: 31px, y: 32px, fill: #ff0000);"), [0], true))[0];
  assert.notDeepEqual(intrinsic, integralIntrinsic, "intrinsic SVG coordinates retain subpixel execution");
});

test("identity color, centered Stack controls, and transparent matte leaves have byte-identical explicit replacements", async () => {
  const direct = compile(`${redRect};`);
  const identity = compile(`ColorConvert(from: "srgb", to: "linear-srgb") { ${redRect}; }`);
  node(identity, "cut.visual.color_convert").inputs.to = { kind: "string", value: "srgb" };
  assert.deepEqual((await renderFrames(identity, [0]))[0], (await renderFrames(direct, [0], true))[0]);

  const plainStack = compile(`Stack() { ${redRect}; }`);
  const framedStack = structuredClone(plainStack);
  Object.assign(node(framedStack, "cut.visual.stack").inputs, {
    width: { kind: "quantity", dimension: "length", unit: "px", magnitude: rational(40) } satisfies IRValue,
    height: { kind: "quantity", dimension: "length", unit: "px", magnitude: rational(44) } satisfies IRValue,
    padding: { kind: "quantity", dimension: "length", unit: "px", magnitude: rational(2) } satisfies IRValue,
    safeArea: { kind: "quantity", dimension: "length", unit: "px", magnitude: rational(1) } satisfies IRValue,
  });
  assert.deepEqual((await renderFrames(framedStack, [0]))[0], (await renderFrames(plainStack, [0], true))[0]);

  const explicitEmptyMatte = compile(`Mask() { ${redRect}; Group(); }`);
  const transparentLeafMatte = compile(`Mask() { ${redRect}; Rect(width: 8px, height: 8px, fill: #ffffff); }`);
  node(transparentLeafMatte, "cut.visual.rect", 1).inputs.fill = { kind: "color", value: "#ffffff00" };
  assert.deepEqual((await renderFrames(transparentLeafMatte, [0]))[0], (await renderFrames(explicitEmptyMatte, [0], true))[0]);
  assert.ok((await renderFrames(explicitEmptyMatte, [0], true))[0].every((byte) => byte === 0), "childless Group matte must be explicitly all-zero");
});

test("transparent Text has no independent shadow alpha, while gradient, Trace head, and opacity reveal alternatives produce pixels", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-transparent-text-"));
  try {
    await copyFile(resolve("examples/fixtures/Geist-Regular.ttf"), resolve(root, "face.ttf"));
    const locked = compileCutModule(parse('Text(content: "A", font: face, x: 4px, y: 32px, size: 20px, maxWidth: 56px, color: #ffffff, shadowColor: #ff0000, shadowOpacity: 100%, shadowBlur: 3px);', true)).ir;
    await applyCutLock(locked, await createCutLock(locked, root), root);
    const transparent = structuredClone(locked);
    node(transparent, "cut.visual.text").inputs.color = { kind: "color", value: "#ffffff00" };
    finalizeGraphHashes(transparent);

    const renderAtRoot = async (ir: CutAVIR, cache: string) => {
      const composition = ir.compositions[0], scene = ir.scenes[composition.sceneIds[0]];
      const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, cache));
      try {
        await renderer.prepare();
        return Buffer.from((await renderer.sceneFrame(scene, 0, false)).data);
      } finally {
        renderer.close();
      }
    };

    const visible = await renderAtRoot(locked, "visible-cache"), hidden = await renderAtRoot(transparent, "hidden-cache");
    assert.ok(visible.some((byte) => byte !== 0), "opaque glyph plus shadow must render pixels");
    assert.ok(hidden.every((byte) => byte === 0), "feDropShadow consumes glyph SourceAlpha, so transparent glyph paint cannot leave an independent shadow");
    expectRuntimeNoOp(loadCutAvIr(JSON.stringify(transparent)), /Text color cannot be fully transparent/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const gradient = await renderFrames(compile("Rect(width: 8px, height: 8px, gradientFrom: #ff000000, gradientTo: #ff0000ff);"), [0], true);
  assert.ok(gradient[0].some((byte) => byte !== 0), "one opaque gradient endpoint is an independently visible paint contribution");

  const trace = await renderFrames(compile("Trace(points: [{ x: 8px, y: 8px }, { x: 56px, y: 8px }], stroke: #ffffff00, width: 1px, duration: 800ms, headRadius: 3px, headColor: #ff0000, headFade: 100ms);"), [0], true);
  assert.ok(trace[0].some((byte) => byte !== 0), "a nontransparent positive-radius Trace head is independently visible");

  const reveal = await renderFrames(compile("Rect(width: 8px, height: 8px, fill: #ff0000, opacity: 0%) as box; animate box.opacity from 0% to 100% over 12f;"), [0, 12], true);
  assert.ok(reveal[0].every((byte) => byte === 0));
  assert.ok(reveal[1].some((byte) => byte !== 0), "hidden-to-visible opacity animation remains executable");
});

test("equal gradient endpoints and redundant closed-path terminals are pixel-identical to their explicit replacements", async () => {
  const gradient = compile("Rect(width: 28px, height: 20px, gradientFrom: #ff0000, gradientTo: #0000ff);");
  node(gradient, "cut.visual.rect").inputs.gradientTo = { kind: "color", value: "#ff0000" };
  const solid = compile("Rect(width: 28px, height: 20px, fill: #ff0000);");
  assert.deepEqual((await renderFrames(gradient, [0]))[0], (await renderFrames(solid, [0], true))[0]);

  const canonical = compile(`MotionPath(points: [{ x: 8px, y: 32px }, { x: 56px, y: 32px }], closed: true) as path { ${redRect}; } animate path.progress from 0% to 100% over 1s;`);
  const redundant = structuredClone(canonical);
  const points = node(redundant, "cut.visual.motion_path").inputs.points;
  assert.equal(points?.kind, "array");
  if (points?.kind === "array") points.items.push(structuredClone(points.items[0]));
  const frames = Array.from({ length: 24 }, (_, index) => index);
  assert.deepEqual(await renderFrames(redundant, frames), await renderFrames(canonical, frames, true));
});
