import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { exportCutTimelineToOtio } from "../lib/interchange/otio";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { CutAvIrValidationError, loadCutAvIr } from "../lib/language/ir-loader";
import { referenceKernelSchema } from "../lib/language/kernel-registry";
import { packageSymbol } from "../lib/language/packages";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { createIncrementalRenderPlan, finalizeGraphHashes } from "../lib/runtime/graph";
import { ReferencePrecompError, referencePrecompConfig, referencePrecompLimits, validateReferencePrecompGraph } from "../lib/runtime/reference/precomp-config";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

function program(range = "range: 500ms ..< 1500ms") {
  return `cut 0.4;
project "ranged nested sequence picture proof";
import { NestedSequence } from "@cut/edit";
import { Rect } from "cut:visual";
timeline main(duration: 1s, fps: 4, width: 24px, height: 16px, sampleRate: 48khz) {
  scene host(duration: 1s) {
    Rect(width: 24px, height: 16px, fill: #050b10);
    NestedSequence(source: insert${range ? `, ${range}` : ""});
  }
}
timeline insert(duration: 2s, fps: 4, width: 24px, height: 16px, sampleRate: 48khz) {
  scene red(duration: 500ms) { Rect(width: 24px, height: 16px, fill: #ef233c); }
  scene green(duration: 500ms) { Rect(width: 24px, height: 16px, fill: #24a148); }
  scene blue(duration: 500ms) { Rect(width: 24px, height: 16px, fill: #2667ff); }
  scene amber(duration: 500ms) { Rect(width: 24px, height: 16px, fill: #ffb000); }
}
export out = render(main);`;
}

function parse(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return parsed.module;
}

function compile(source = program()) {
  const parsedModule = parse(source);
  assert.deepEqual(checkCutModule(parsedModule).diagnostics.filter((item) => item.severity === "error"), []);
  const ir = compileCutModule(parsedModule).ir;
  ir.determinism.semantic = "locked";
  return ir;
}

function nested(ir: CutAVIR) {
  const result = Object.values(ir.nodes).find((node) => node.op === "cut.edit.nested_sequence");
  assert.ok(result);
  return result;
}

function pixel(surface: { data: Uint8Array; width: number }, x: number, y: number) {
  const offset = (y * surface.width + x) * 4;
  return [...surface.data.subarray(offset, offset + 4)];
}

test("NestedSequence range is one closed public half-open Timeline selection and typed IR input", () => {
  const symbol = packageSymbol("@cut/edit", "NestedSequence");
  assert.deepEqual(symbol?.parameters?.map((parameter) => ({ name: parameter.name, type: parameter.type, optional: parameter.optional })), [
    { name: "source", type: "Timeline", optional: undefined },
    { name: "range", type: "Range<Time>", optional: true },
  ]);
  const kernel = referenceKernelSchema("cut.edit.nested_sequence");
  assert.ok(kernel?.support === "supported");
  if (kernel.support === "supported") assert.deepEqual(kernel.inputs, ["source", "range"]);

  const ir = compile(), node = nested(ir), main = ir.compositions.find((item) => item.id === "main")!;
  assert.deepEqual(node.inputs.range, {
    kind: "range",
    start: { kind: "quantity", dimension: "time", magnitude: rational(1, 2), unit: "s" },
    end: { kind: "quantity", dimension: "time", magnitude: rational(3, 2), unit: "s" },
    exclusive: true,
  });
  assert.deepEqual(node.interval, { start: rational(0), duration: rational(1) });
  assert.deepEqual(referencePrecompConfig(ir, main, node), {
    kind: "av",
    nodeId: node.id,
    sourceCompositionId: "insert",
    duration: rational(1),
    frames: 4n,
    samples: 48_000n,
    sourceRange: { start: rational(1, 2), end: rational(3, 2) },
  });

  const fullSource = program("")
    .replace("timeline main(duration: 1s", "timeline main(duration: 2s")
    .replace("scene host(duration: 1s)", "scene host(duration: 2s)");
  const fullIr = compile(fullSource), fullNode = nested(fullIr), fullMain = fullIr.compositions.find((item) => item.id === "main")!;
  assert.equal(fullNode.inputs.range, undefined);
  assert.deepEqual(fullNode.interval.duration, rational(2));
  const fullConfig = referencePrecompConfig(fullIr, fullMain, fullNode);
  assert.ok(fullConfig?.kind === "av");
  assert.deepEqual(fullConfig.sourceRange, { start: rational(0), end: rational(2) });
});

test("ranged picture execution selects the middle source grammar on its original clock", async () => {
  const ir = compile(), main = ir.compositions.find((item) => item.id === "main")!;
  validateReferenceSession(ir);
  const directory = await mkdtemp(resolve(tmpdir(), "cut-nested-range-picture-"));
  const renderer = new ReferenceVisualRenderer(ir, main, directory, resolve(directory, "cache"));
  try {
    await renderer.prepare();
    const scene = ir.scenes[main.sceneIds[0]];
    assert.deepEqual(pixel(await renderer.sceneFrame(scene, 0), 12, 8), [36, 161, 72, 255]);
    assert.deepEqual(pixel(await renderer.sceneFrame(scene, 2), 12, 8), [38, 103, 255, 255]);
  } finally {
    renderer.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("ranged animated picture retains source-time phase instead of restarting at local zero", async () => {
  const source = `cut 0.4; project "nested source phase";
import { NestedSequence } from "@cut/edit"; import { Rect } from "cut:visual";
timeline main(duration: 500ms, fps: 4, width: 24px, height: 16px, sampleRate: 48khz) {
  scene host(duration: 500ms) { NestedSequence(source: insert, range: 1s ..< 1500ms); }
}
timeline insert(duration: 2s, fps: 4, width: 24px, height: 16px, sampleRate: 48khz) {
  scene moving(duration: 2s) {
    Rect(width: 4px, height: 4px, x: 4px, y: 8px, fill: #ef233c) as mover;
    animate mover.x from 0px to 16px over 2s;
  }
}
export out = render(main);`;
  const ir = compile(source), main = ir.compositions.find((item) => item.id === "main")!, insert = ir.compositions.find((item) => item.id === "insert")!;
  validateReferenceSession(ir);
  const directory = await mkdtemp(resolve(tmpdir(), "cut-nested-range-phase-"));
  const parent = new ReferenceVisualRenderer(ir, main, directory, resolve(directory, "parent-cache"));
  const sourceRenderer = new ReferenceVisualRenderer(ir, insert, directory, resolve(directory, "source-cache"));
  try {
    await parent.prepare(); await sourceRenderer.prepare();
    const actual = await parent.sceneFrame(ir.scenes[main.sceneIds[0]], 0);
    const atSourceStart = await sourceRenderer.sceneFrame(ir.scenes[insert.sceneIds[0]], 4);
    const atLocalZero = await sourceRenderer.sceneFrame(ir.scenes[insert.sceneIds[0]], 0);
    assert.deepEqual(actual.data, atSourceStart.data);
    assert.notDeepEqual(actual.data, atLocalZero.data);
  } finally {
    parent.close(); sourceRenderer.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function expectCompile(source: string, code: string, message: RegExp) {
  assert.throws(() => compileCutModule(parse(source)), (error: unknown) => {
    assert.ok(error instanceof CutCompileError);
    const diagnostic = error.result.diagnostics.find((item) => item.code === code);
    assert.ok(diagnostic, JSON.stringify(error.result.diagnostics));
    assert.match(diagnostic.message, message);
    assert.ok(diagnostic.span.start.line > 0 && diagnostic.span.start.column > 0);
    return true;
  });
}

test("ranged source syntax fails closed on inclusion, bounds, and both exact clocks", () => {
  for (const [range, code, message] of [
    ["range: 500ms .. 1500ms", "CUT_NESTED_INPUT", /half-open/],
    ["range: -250ms ..< 500ms", "CUT_NESTED_TIMING", /positive.*inside/],
    ["range: 500ms ..< 500ms", "CUT_NESTED_TIMING", /positive.*inside/],
    ["range: 1s ..< 2500ms", "CUT_NESTED_TIMING", /inside source/],
    ["range: 100ms ..< 600ms", "CUT_NESTED_TIMING", /source 4\/1 fps frame grid/],
  ] as const) expectCompile(program(range), code, message);

  const offSample = `cut 0.4; project "nested sample-grid refusal";
import { NestedSequence } from "@cut/edit"; import { Rect } from "cut:visual";
timeline main(duration: 1s, fps: 7, width: 8px, height: 8px, sampleRate: 8khz) {
  scene host(duration: 1s) { NestedSequence(source: insert, range: seconds(1 / 7) ..< seconds(2 / 7)); }
}
timeline insert(duration: 1s, fps: 7, width: 8px, height: 8px, sampleRate: 8khz) {
  scene source(duration: 1s) { Rect(width: 8px, height: 8px); }
}
export out = render(main);`;
  expectCompile(offSample, "CUT_NESTED_TIMING", /source 8000 Hz sample grid/);
});

function nestedPreparationBudgetProgram(options: {
  sourceDuration: number;
  selectedDuration: number;
  instances: number;
  distinct: boolean;
  rangeStart?: number;
}) {
  const rangeStart = options.rangeStart ?? 0, rangeEnd = rangeStart + options.selectedDuration;
  const sourceNames = Array.from({ length: options.distinct ? options.instances : 1 }, (_, index) => `insert${index}`);
  const calls = Array.from({ length: options.instances }, (_, index) =>
    `NestedSequence(source: ${sourceNames[options.distinct ? index : 0]}, range: ${rangeStart}s ..< ${rangeEnd}s);`).join("\n    ");
  const sources = sourceNames.map((name, index) => `
timeline ${name}(duration: ${options.sourceDuration}s, fps: 1, width: 8px, height: 8px, sampleRate: 48khz) {
  Tone(frequency: ${220 + index}hz, duration: 1s, amplitude: 5%);
  scene picture(duration: ${options.sourceDuration}s) { Rect(width: 8px, height: 8px, fill: #${index % 2 ? "2667ff" : "ef233c"}); }
}`).join("\n");
  return `cut 0.4; project "nested preparation budget";
import { NestedSequence } from "@cut/edit";
import { Tone } from "@cut/audio";
import { Rect } from "cut:visual";
timeline main(duration: ${options.selectedDuration}s, fps: 1, width: 8px, height: 8px, sampleRate: 48khz) {
  scene host(duration: ${options.selectedDuration}s) {
    ${calls}
  }
}
${sources}
export out = render(main);`;
}

test("ranged NestedSequence bounds complete causal history and retained raw audio using exact source+range deduplication", () => {
  assert.equal(referencePrecompLimits.maxRetainedRawF32Bytes, 4_294_967_192);
  assert.equal(referencePrecompLimits.maxRetainedRawF32Bytes % 8, 0);
  expectCompile(
    nestedPreparationBudgetProgram({ sourceDuration: 10_000, selectedDuration: 1, instances: 1, distinct: true }),
    "CUT_NESTED_BUDGET",
    /7200-second composition limit/,
  );

  expectCompile(
    nestedPreparationBudgetProgram({ sourceDuration: 7_200, selectedDuration: 1, instances: 6, distinct: true, rangeStart: 7_199 }),
    "CUT_NESTED_BUDGET",
    /maxExpandedSamples=2000000000.*source-history samples/,
  );
  const deduplicated = compile(nestedPreparationBudgetProgram({ sourceDuration: 7_200, selectedDuration: 1, instances: 6, distinct: false, rangeStart: 7_199 }));
  assert.equal(Object.values(deduplicated.nodes).filter((node) => node.op === "cut.edit.nested_sequence").length, 6);
  assert.deepEqual(validateReferencePrecompGraph(deduplicated, deduplicated.compositions.find((composition) => composition.id === "main")!).audioPreparation, {
    historySamples: 345_600_000n,
    retainedRawF32Bytes: 384_000n,
    selections: 1n,
  });

  // Direct in-memory callers do not necessarily pass through the strict
  // loader's root-array/item reconciliation. Budgeting follows the runtime's
  // ordered items too, so a hostile stale convenience array cannot erase work.
  const itemsOnly = compile(nestedPreparationBudgetProgram({ sourceDuration: 7_200, selectedDuration: 1, instances: 1, distinct: true, rangeStart: 7_199 }));
  const itemsOnlySource = itemsOnly.compositions.find((composition) => composition.id === "insert0")!;
  itemsOnlySource.rootAudioIds = [];
  assert.deepEqual(validateReferencePrecompGraph(itemsOnly, itemsOnly.compositions.find((composition) => composition.id === "main")!).audioPreparation, {
    historySamples: 345_600_000n,
    retainedRawF32Bytes: 384_000n,
    selections: 1n,
  });

  const distinct = compile(nestedPreparationBudgetProgram({ sourceDuration: 7_200, selectedDuration: 1, instances: 5, distinct: true, rangeStart: 7_199 }));
  assert.deepEqual(validateReferencePrecompGraph(distinct, distinct.compositions.find((composition) => composition.id === "main")!).audioPreparation, {
    historySamples: 1_728_000_000n,
    retainedRawF32Bytes: 1_920_000n,
    selections: 5n,
  });

  expectCompile(
    nestedPreparationBudgetProgram({ sourceDuration: 5_000, selectedDuration: 5_000, instances: 3, distinct: true }),
    "CUT_NESTED_BUDGET",
    /maxRetainedRawF32Bytes=4294967192.*selected raw stereo f32le bytes/,
  );
});

function hostile(mutate: (node: IRNode) => void) {
  const ir = compileCutModule(parse(program())).ir, node = nested(ir);
  mutate(node); finalizeGraphHashes(ir);
  const loaded = loadCutAvIr(JSON.stringify(ir)); loaded.determinism.semantic = "locked";
  return loaded;
}

test("loaded typed IR cannot forge ranged selection or destination duration", () => {
  const cases: Array<[CutAVIR, ReferencePrecompError["code"], RegExp]> = [
    [hostile((node) => { const range = node.inputs.range; assert.equal(range.kind, "range"); if (range.kind === "range") range.exclusive = false; }), "CUT_NESTED_INPUT", /half-open/],
    [hostile((node) => { const range = node.inputs.range; assert.equal(range.kind, "range"); if (range.kind === "range" && range.end.kind === "quantity") range.end.magnitude = rational(3); }), "CUT_NESTED_TIMING", /inside source/],
    [hostile((node) => { node.interval.duration = rational(1, 2); }), "CUT_NESTED_TIMING", /equal its selected source duration/],
  ];
  for (const [ir, code, message] of cases) {
    assert.throws(() => validateReferenceSession(ir), (error: unknown) => error instanceof ReferencePrecompError
      && error.code === code && message.test(error.message) && error.source.line > 0 && error.source.column > 0);
  }
});

test("loaded IR cannot bleed a foreign timeline-level audio root into a nested source graph", () => {
  const source = `cut 0.4; project "nested ownership closure";
import { NestedSequence } from "@cut/edit";
import { Tone, Sidechain } from "@cut/audio";
import { Rect } from "cut:visual";
timeline main(duration: 1s, fps: 4, width: 8px, height: 8px, sampleRate: 8khz) {
  Tone(frequency: 110hz, duration: 1s, amplitude: 5%) as foreign;
  scene host(duration: 1s) { NestedSequence(source: insert, range: 0s ..< 1s); }
}
timeline insert(duration: 1s, fps: 4, width: 8px, height: 8px, sampleRate: 8khz) {
  Tone(frequency: 220hz, duration: 1s, amplitude: 5%) as local;
  Sidechain(source: local, amount: -6db) { Tone(frequency: 440hz, duration: 1s, amplitude: 5%); }
  scene picture(duration: 1s) { Rect(width: 8px, height: 8px); }
}
export out = render(main);`;
  const ir = compileCutModule(parse(source)).ir;
  const main = ir.compositions.find((composition) => composition.id === "main")!;
  const foreignRootId = main.items.find((item) => item.kind === "node" && item.domain === "audio")?.id;
  const sidechain = Object.values(ir.nodes).find((node) => node.op === "cut.audio.sidechain");
  assert.ok(foreignRootId && sidechain);
  sidechain.inputs.source = { kind: "node-ref", id: foreignRootId };
  finalizeGraphHashes(ir);
  const loaded = loadCutAvIr(JSON.stringify(ir)); loaded.determinism.semantic = "locked";
  assert.throws(() => validateReferenceSession(loaded), (error: unknown) => error instanceof ReferencePrecompError
    && error.code === "CUT_NESTED_REFERENCE"
    && /timeline-level cut\.audio\.tone owned by another composition/.test(error.message)
    && error.source.line > 0 && error.source.column > 0);

  const multiplyOwned = compileCutModule(parse(source)).ir;
  const duplicateMain = multiplyOwned.compositions.find((composition) => composition.id === "main")!;
  const duplicateInsert = multiplyOwned.compositions.find((composition) => composition.id === "insert")!;
  const duplicateId = duplicateMain.items.find((item) => item.kind === "node" && item.domain === "audio")?.id;
  assert.ok(duplicateId);
  duplicateInsert.rootAudioIds.push(duplicateId);
  duplicateInsert.items.push({ kind: "node", id: duplicateId, domain: "audio" });
  assert.throws(() => validateReferencePrecompGraph(multiplyOwned, duplicateMain), (error: unknown) => error instanceof ReferencePrecompError
    && error.code === "CUT_NESTED_REFERENCE"
    && /timeline-level cut\.audio\.tone owned by another composition/.test(error.message));
  finalizeGraphHashes(multiplyOwned);
  assert.throws(() => loadCutAvIr(JSON.stringify(multiplyOwned)), (error: unknown) => error instanceof CutAvIrValidationError
    && error.code === "CUT_IR_IDENTITY"
    && /belongs to multiple owners/.test(error.message));
});

test("equal-duration shifted ranges invalidate the nested picture wrapper but not an unrelated host node", () => {
  const before = compile(program("range: 0s ..< 1s"));
  const after = compile(program("range: 1s ..< 2s"));
  const previous = createIncrementalRenderPlan(before, "main").manifest;
  const plan = createIncrementalRenderPlan(after, "main", previous), wrapper = nested(after);
  assert.equal(plan.nodes.find((item) => item.id === wrapper.id)?.status, "miss");
  const hostSceneIds = new Set(after.compositions.find((composition) => composition.id === "main")!.sceneIds);
  const background = Object.values(after.nodes).find((node) => node.op === "cut.visual.rect" && node.sceneId && hostSceneIds.has(node.sceneId));
  assert.ok(background);
  assert.equal(plan.nodes.find((item) => item.id === background.id)?.status, "hit");
  assert.notEqual(before.buildId, after.buildId);
});

test("omitted and explicit complete NestedSequence ranges share executable, build, diff, and picture-cache identity", () => {
  const source = (range: string) => `cut 0.4;
project "nested complete-range identity";
import { NestedSequence } from "@cut/edit";
import { Rect } from "cut:visual";
timeline main(duration: 2s, fps: 4, width: 24px, height: 16px, sampleRate: 48khz) {
  scene host(duration: 2s) {
    NestedSequence(source: insert${range});
  }
}
timeline insert(duration: 2s, fps: 4, width: 24px, height: 16px, sampleRate: 48khz) {
  scene first(duration: 1s) { Rect(width: 24px, height: 16px, fill: #ef233c); }
  scene second(duration: 1s) { Rect(width: 24px, height: 16px, fill: #2667ff); }
}
export out = render(main);`;
  const omitted = compile(source(""));
  const explicit = compile(source(", range: 0s ..< 2s"));
  assert.equal(omitted.buildId, explicit.buildId);
  assert.equal(diffCutAVIR(omitted, explicit).summary.total, 0);

  const previous = createIncrementalRenderPlan(omitted, "main").manifest;
  const plan = createIncrementalRenderPlan(explicit, "main", previous);
  const wrapper = nested(explicit);
  assert.equal(plan.nodes.find((item) => item.id === wrapper.id)?.status, "hit");
  assert.equal(plan.scenes.every((scene) => scene.status === "hit"), true);
});

test("OTIO preserves a ranged NestedSequence as exact profile metadata with scoped import loss", () => {
  const { timeline, report } = exportCutTimelineToOtio(compile(), { compositionId: "main" });
  const issue = report.unsupportedSemantics.find((item) => item.code === "CUT_OTIO_NESTING_EXECUTABLE_IMPORT_UNSUPPORTED");
  assert.equal(report.status, "lossy-editorial");
  assert.equal(issue?.disposition, "metadata-only");
  assert.ok(report.editorialProfile);
  assert.ok(timeline.tracks.children.some((track) => track.children.some((item) => item.OTIO_SCHEMA === "Stack.1")));
});
