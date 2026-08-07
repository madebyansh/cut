import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { compileCutModule } from "../lib/language/compiler";
import type { IRNode } from "../lib/language/ir";
import { parseCutLanguage } from "../lib/language/parser";
import { renderReferenceAudio } from "../lib/runtime/reference/audio";
import { ReferenceAudioConfigError } from "../lib/runtime/reference/audio-config";
import {
  measureReferenceAudioBackendPlan,
  referenceAudioBackendLimits,
  validateReferenceAudioBackendPlan,
  withReferenceAudioFilterScript,
} from "../lib/runtime/reference/audio-resource";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { planReferenceAudioStems, ReferenceStemError } from "../lib/runtime/reference/stems";
import { CutGraphError } from "../lib/runtime/graph";
import { ReferenceAudioGraphAuthorizationError } from "../lib/runtime/reference/audio-region";

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

function tones(count: number, duration = "1ms") {
  return Array.from({ length: count }, (_, index) =>
    `Tone(frequency: ${220 + index % 3_000}hz, duration: ${duration}, amplitude: 0.000001%);`).join("\n");
}

function program(body: string, duration = "1ms", sampleRate = "8khz") {
  return `cut 0.4;
project "audio resource boundary";
import { Tone } from "@cut/audio";
timeline main(duration: ${duration}, fps: 100, width: 64px, height: 64px, sampleRate: ${sampleRate}) {
${body}
}
export out = render(main);`;
}

function busProgram(duration = "1ms", sampleRate = "8khz") {
  return `cut 0.4;
project "audio expanded resource boundary";
import { Bus, Gain, Tone } from "@cut/audio";
timeline main(duration: ${duration}, fps: 100, width: 64px, height: 64px, sampleRate: ${sampleRate}) {
  Bus(name: "dialogue") {
    Gain(amount: 0db) {
      Tone(frequency: 440hz, duration: ${duration}, amplitude: 0.000001%);
    }
  }
}
export out = render(main);`;
}

function operation(ir: ReturnType<typeof compile>, op: string) {
  const result = Object.values(ir.nodes).find((node): node is IRNode => node.op === op);
  assert.ok(result, op);
  return result;
}

function duplicatedToneBus(duration = "7200s", sampleRate = "48khz") {
  const ir = compile(busProgram(duration, sampleRate)), bus = operation(ir, "cut.audio.bus"), gain = operation(ir, "cut.audio.gain"), tone = operation(ir, "cut.audio.tone");
  // This is hostile loaded IR: one unique Tone object is referenced 2,046
  // times. The recursive reference backend emits every occurrence even though
  // ordinary reachability contains only three IDs.
  bus.children = Array.from({ length: 2_046 }, () => tone.id);
  delete ir.nodes[gain.id];
  return ir;
}

function deepGainBus(depth = 600) {
  const ir = compile(busProgram()), bus = operation(ir, "cut.audio.bus"), template = operation(ir, "cut.audio.gain"), tone = operation(ir, "cut.audio.tone");
  let child = tone.id;
  delete ir.nodes[template.id];
  for (let index = 0; index < depth; index += 1) {
    const id = `hostile_gain_${String(index).padStart(4, "0")}`;
    ir.nodes[id] = { ...structuredClone(template), id, ownership: "child", children: [child] };
    child = id;
  }
  bus.children = [child];
  return ir;
}

function graphFailure(code: "CUT_AUDIO_GRAPH" | "CUT_GRAPH_BUDGET", message: RegExp) {
  return (error: unknown) => error instanceof CutGraphError
    && error.code === code
    && "module" in error.source
    && error.source.line > 0
    && error.source.column > 0
    && message.test(error.message);
}

function authorizationFailure(message: RegExp) {
  return (error: unknown) => error instanceof ReferenceAudioGraphAuthorizationError
    && error.code === "CUT_AUDIO_GRAPH"
    && error.source.line > 0
    && error.source.column > 0
    && message.test(error.message);
}

function stemFailure(code: "CUT_STEM_ROUTING_AMBIGUOUS" | "CUT_STEM_GRAPH_INVALID", message: RegExp) {
  return (error: unknown) => error instanceof ReferenceStemError
    && error.code === code
    && error.source !== undefined
    && error.source.line > 0
    && error.source.column > 0
    && message.test(error.message);
}

function missingFile(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function owner(ir: ReturnType<typeof compile>) {
  const result = Object.values(ir.nodes).find((node): node is IRNode => node.op === "cut.audio.tone");
  assert.ok(result);
  return result;
}

function resourceFailure(message: RegExp) {
  return (error: unknown) => error instanceof ReferenceAudioConfigError
    && error.code === "CUT_AUDIO_RESOURCE_LIMIT"
    && "line" in error.source
    && error.source.line > 0
    && error.source.column > 0
    && message.test(error.message);
}

test("backend filter and argv cost accepts each exact public boundary and refuses boundary plus one", () => {
  const ir = compile(program(tones(1))), composition = ir.compositions[0], node = owner(ir);

  const exactFilterCount = Array.from({ length: referenceAudioBackendLimits.maximumFilterEntries }, () => "anull");
  const exactFilterCost = validateReferenceAudioBackendPlan(node, composition, exactFilterCount, ["-y"]);
  assert.equal(exactFilterCost.filterEntries, referenceAudioBackendLimits.maximumFilterEntries);
  assert.equal(exactFilterCost.emittedFilterChannelSamples, 32_768n);
  assert.throws(
    () => validateReferenceAudioBackendPlan(node, composition, [...exactFilterCount, "anull"], ["-y"]),
    resourceFailure(/emits 2049 backend filter entries; maximum is 2048/),
  );

  const exactGraph = ["a".repeat(referenceAudioBackendLimits.maximumFilterGraphUtf8Bytes)];
  assert.equal(validateReferenceAudioBackendPlan(node, composition, exactGraph, ["-y"]).filterGraphUtf8Bytes, referenceAudioBackendLimits.maximumFilterGraphUtf8Bytes);
  assert.throws(
    () => validateReferenceAudioBackendPlan(node, composition, [`${exactGraph[0]}a`], ["-y"]),
    resourceFailure(/emits 1048577 UTF-8 bytes of backend filter graph; maximum is 1048576/),
  );

  const exactArgv = ["a".repeat(8_191), "b".repeat(8_191), "c".repeat(8_184)];
  const exactCost = measureReferenceAudioBackendPlan([], exactArgv);
  assert.equal(exactCost.argumentUtf8Bytes, referenceAudioBackendLimits.maximumArgumentUtf8Bytes);
  assert.equal(validateReferenceAudioBackendPlan(node, composition, [], exactArgv).argumentUtf8Bytes, referenceAudioBackendLimits.maximumArgumentUtf8Bytes);
  assert.throws(
    () => validateReferenceAudioBackendPlan(node, composition, [], [exactArgv[0], exactArgv[1], `${exactArgv[2]}c`]),
    resourceFailure(/emits 24577 UTF-8 argv bytes including NUL terminators; maximum is 24576/),
  );

  const exactArgumentCount = Array.from({ length: referenceAudioBackendLimits.maximumArgumentCount - 1 }, () => "");
  assert.equal(validateReferenceAudioBackendPlan(node, composition, [], exactArgumentCount).argumentCount, referenceAudioBackendLimits.maximumArgumentCount);
  assert.throws(
    () => validateReferenceAudioBackendPlan(node, composition, [], [...exactArgumentCount, ""]),
    resourceFailure(/emits 4097 backend arguments; maximum is 4096/),
  );

  const exactSingleArgument = ["x".repeat(referenceAudioBackendLimits.maximumSingleArgumentUtf8Bytes - 1)];
  assert.equal(validateReferenceAudioBackendPlan(node, composition, [], exactSingleArgument).maximumSingleArgumentUtf8Bytes, referenceAudioBackendLimits.maximumSingleArgumentUtf8Bytes);
  assert.throws(
    () => validateReferenceAudioBackendPlan(node, composition, [], [`${exactSingleArgument[0]}x`]),
    resourceFailure(/emits a 8193-byte backend argument including its NUL terminator; maximum is 8192/),
  );
});

test("emitted filter work uses the expanded backend plan rather than unique IR IDs", () => {
  const ir = compile(program(tones(1, "7200s"), "7200s", "48khz")), composition = ir.compositions[0], node = owner(ir);
  const exactFilterCount = Array.from({ length: referenceAudioBackendLimits.maximumFilterEntries }, () => "anull");
  assert.throws(
    () => validateReferenceAudioBackendPlan(node, composition, exactFilterCount, ["-y"]),
    resourceFailure(/emits 2048 backend filter entries across 345600000 samples, requiring 1415577600000 conservative filter-channel-samples; maximum is 137438953472/),
  );
});

test("private filter scripts are removed when backend work fails", async () => {
  let graphPath = "";
  await assert.rejects(
    () => withReferenceAudioFilterScript(["anullsrc=r=8000:cl=stereo[out]"], async (path) => {
      graphPath = path;
      assert.match(await readFile(path, "utf8"), /anullsrc/);
      throw new Error("synthetic backend failure");
    }),
    /synthetic backend failure/,
  );
  assert.ok(graphPath);
  await assert.rejects(() => readFile(graphPath), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("2,046 independent Tone roots render at the exact 2,048-filter boundary", { timeout: 30_000 }, async () => {
  const ir = compile(program(tones(2_046)));
  validateReferenceSession(ir);
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-resource-boundary-"));
  const output = resolve(root, "boundary.wav");
  const report = await renderReferenceAudio(ir, ir.compositions[0], root, output);
  assert.deepEqual({ roots: report.roots, filters: report.filters }, { roots: 2_046, filters: 2_048 });
  assert.equal(report.limiter.format, "cut-reference-audio-limiter-build-evidence");
  assert.equal(report.limiter.preparedExecutions, 0);
  assert.deepEqual(report.limiter.executions, []);
  assert.match(report.limiter.integrity, /^[0-9a-f]{64}$/u);
  assert.ok((await readFile(output)).length > 44);
});

test("duplicated-child expansion is refused by session and direct render before temp, output, or backend work", async () => {
  const ir = duplicatedToneBus();
  assert.throws(
    () => validateReferenceSession(ir),
    resourceFailure(/requires 1414886400000 expanded audio node-channel-samples across 2047 recursive graph visits; maximum is 137438953472/),
  );
  assert.throws(
    () => planReferenceAudioStems(ir, ir.compositions[0]),
    stemFailure("CUT_STEM_ROUTING_AMBIGUOUS", /reachable more than once within stem "dialogue"/),
  );

  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-expanded-refusal-")), output = resolve(root, "must-not-exist.wav");
  try {
    await assert.rejects(
      () => renderReferenceAudio(ir, ir.compositions[0], root, output),
      authorizationFailure(/child audio node must have exactly one structural parent, no root owner, and one parent edge/),
    );
    await assert.rejects(() => access(output), missingFile);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session, direct audio, and stem entry points refuse recursive depth before construction", async () => {
  const ir = deepGainBus();
  assert.throws(() => validateReferenceSession(ir), graphFailure("CUT_GRAPH_BUDGET", /maxDepth=512/));
  assert.throws(() => planReferenceAudioStems(ir, ir.compositions[0]), graphFailure("CUT_GRAPH_BUDGET", /maxDepth=512/));

  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-depth-refusal-")), output = resolve(root, "must-not-exist.wav");
  try {
    await assert.rejects(() => renderReferenceAudio(ir, ir.compositions[0], root, output), graphFailure("CUT_GRAPH_BUDGET", /maxDepth=512/));
    await assert.rejects(() => access(output), missingFile);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session and stem preflight refuse a self-referential audio child with stable graph evidence", () => {
  const ir = compile(busProgram()), gain = operation(ir, "cut.audio.gain");
  gain.children = [gain.id];
  assert.throws(() => validateReferenceSession(ir), graphFailure("CUT_AUDIO_GRAPH", /requires an explicit supported feedback\/delay primitive/));
  assert.throws(() => planReferenceAudioStems(ir, ir.compositions[0]), stemFailure("CUT_STEM_GRAPH_INVALID", /Audio graph cycle reaches .* from stem "dialogue"/));
});

test("5,000 static Tone roots fail with a source-located CUT diagnostic before backend spawn", { timeout: 30_000 }, async () => {
  const ir = compile(program(tones(5_000)));
  validateReferenceSession(ir);
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-resource-refusal-"));
  await assert.rejects(
    () => renderReferenceAudio(ir, ir.compositions[0], root, resolve(root, "must-not-render.wav")),
    resourceFailure(/emits 5002 backend filter entries; maximum is 2048/),
  );
});

test("composition preflight bounds static offline work and canonical PCM24 output bytes", () => {
  const hostileWork = compile(program(tones(2_000, "7200s"), "7200s", "8khz"));
  assert.throws(
    () => validateReferenceSession(hostileWork),
    resourceFailure(/requires 230400000000 expanded audio node-channel-samples across 2000 recursive graph visits; maximum is 137438953472/),
  );

  const hostileOutput = compile(program(tones(1, "7200s"), "7200s", "192khz"));
  assert.throws(
    () => validateReferenceSession(hostileOutput),
    resourceFailure(/requires 8294400000 bytes of stereo PCM24 output; maximum is 4294967196/),
  );
});
