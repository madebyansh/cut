import assert from "node:assert/strict";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRSignal } from "../lib/language/ir";
import { CutAvIrValidationError, loadCutAvIr } from "../lib/language/ir-loader";
import { parseCutLanguage } from "../lib/language/parser";
import {
  compileReferenceLimiterAutomations,
  ReferenceAudioAutomationError,
} from "../lib/runtime/reference/audio-automation";
import {
  ReferenceAudioConfigError,
  referenceAudioNodeConfig,
  referenceLimiterLimits,
} from "../lib/runtime/reference/audio-config";
import { cutSignalContentHash, finalizeGraphHashes } from "../lib/runtime/graph";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

function program(body: string, sampleRate = "48khz", duration = "100ms") {
  return `cut 0.4;
project "limiter language contract";
import { Limiter, Tone } from "@cut/audio";
import { linear, outCubic, spring } from "@cut/motion";
timeline main(duration: ${duration}, fps: 100, width: 64px, height: 64px, sampleRate: ${sampleRate}) {
  ${body}
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
}

function parse(source: string) {
  const result = parseCutLanguage(source);
  assert.ok(result.module, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.diagnostics, []);
  return result.module;
}

function compile(body: string, sampleRate = "48khz", duration = "100ms") {
  return compileCutModule(parse(program(body, sampleRate, duration))).ir;
}

function limiter(ir: CutAVIR) {
  const result = Object.values(ir.nodes).find((node) => node.op === "cut.audio.limiter");
  assert.ok(result);
  return result;
}

function signal(ir: CutAVIR, property: "ceiling" | "release") {
  const reference = limiter(ir).properties[property];
  assert.ok(reference && "signal" in reference);
  const result = ir.signals[reference.signal];
  assert.ok(result);
  return result;
}

function recompute(ir: CutAVIR) {
  for (const value of Object.values(ir.signals)) value.contentHash = cutSignalContentHash(value);
  finalizeGraphHashes(ir);
}

test("Limiter public controls lower to closed typed IR and exact static config", () => {
  const ir = compile(`
    Limiter(ceiling: -6dbtp, release: 80ms, lookahead: 5ms) as master {
      Tone(frequency: 440hz, duration: 100ms);
    }
    animate master.ceiling from -6dbtp to -1dbtp over 10ms ease linear;
    animate master.release from 50ms to 200ms over 10ms ease outCubic;
  `);
  const node = limiter(ir), config = referenceAudioNodeConfig(ir, ir.compositions[0], node);
  assert.deepEqual(config, { kind: "limiter", ceilingDbtp: -6, releaseSeconds: 0.08, lookaheadSamples: 240 });
  const defaults = compile("Limiter() { Tone(frequency: 440hz, duration: 100ms); }");
  assert.deepEqual(referenceAudioNodeConfig(defaults, defaults.compositions[0], limiter(defaults)), {
    kind: "limiter", ceilingDbtp: -1, releaseSeconds: 0.05, lookaheadSamples: 240,
  });
  assert.equal(signal(ir, "ceiling").valueType, "TruePeak");
  assert.equal(signal(ir, "release").valueType, "Time");

  const automations = compileReferenceLimiterAutomations(ir, ir.compositions[0], node);
  assert.deepEqual(Object.keys(automations), ["ceiling", "release"]);
  assert.equal(automations.ceiling?.valueAtSample(0), -6);
  assert.equal(automations.ceiling?.valueAtSample(240), -3.5);
  assert.equal(automations.ceiling?.valueAtSample(480), -1);
  assert.equal(automations.release?.valueAtSample(0), 0.05);
  assert.ok(Math.abs((automations.release?.valueAtSample(240) ?? 0) - 0.18125) < 1e-12);
  assert.equal(automations.release?.valueAtSample(480), 0.2);
  assert.deepEqual(automations.ceiling?.controlValues, [-6, -6, -1]);
  assert.deepEqual(automations.release?.controlValues, [0.08, 0.05, 0.2]);
  assert.match(automations.ceiling?.valueExpression ?? "", /n/);
  assert.match(automations.release?.valueExpression ?? "", /pow/);

  ir.determinism.semantic = "locked";
  assert.doesNotThrow(() => validateReferenceSession(ir));
});

test("Limiter lookahead is static-only and all three public types fail at source", () => {
  const source = program(`
    Limiter() as master { Tone(frequency: 440hz, duration: 100ms); }
    set master.lookahead = 3ms;
    set master.ceiling = -3db;
    set master.release = 50%;
  `);
  const diagnostics = checkCutModule(parse(source)).diagnostics;
  assert.ok(diagnostics.some((item) => item.code === "CUT2060" && /lookahead/.test(item.message)), JSON.stringify(diagnostics));
  assert.ok(diagnostics.some((item) => item.code === "CUT2035" && /TruePeak.*Gain/.test(item.message)), JSON.stringify(diagnostics));
  assert.ok(diagnostics.some((item) => item.code === "CUT2035" && /Time.*Ratio/.test(item.message)), JSON.stringify(diagnostics));

  const constructor = checkCutModule(parse(program(`Limiter(ceiling: -1db, release: 50%, lookahead: 2) { Tone(frequency: 440hz, duration: 100ms); }`))).diagnostics;
  assert.equal(constructor.filter((item) => item.code === "CUT2029").length, 3, JSON.stringify(constructor));
});

test("Limiter static bounds and exact lookahead sample grid fail with stable source locations", () => {
  const cases = [
    ["Limiter(ceiling: -23.6dbtp) { Tone(frequency: 440hz, duration: 100ms); }", "CUT_AUDIO_VALUE_RANGE", /ceiling between -23\.5 and 0/],
    ["Limiter(release: 0.5ms) { Tone(frequency: 440hz, duration: 100ms); }", "CUT_AUDIO_VALUE_RANGE", /release between 0\.001 and 2/],
    ["Limiter(release: 2001ms) { Tone(frequency: 440hz, duration: 100ms); }", "CUT_AUDIO_VALUE_RANGE", /release between 0\.001 and 2/],
    ["Limiter(lookahead: -1ms) { Tone(frequency: 440hz, duration: 100ms); }", "CUT_AUDIO_VALUE_RANGE", /lookahead between 0 and 0\.02/],
    ["Limiter(lookahead: 21ms) { Tone(frequency: 440hz, duration: 100ms); }", "CUT_AUDIO_VALUE_RANGE", /lookahead between 0 and 0\.02/],
    ["Limiter(lookahead: 0.1ms) { Tone(frequency: 440hz, duration: 100ms); }", "CUT_AUDIO_SAMPLE_GRID", /Limiter\.lookahead does not land on the 48000 Hz sample grid/],
  ] as const;
  for (const [body, code, message] of cases) {
    const ir = compile(body); ir.determinism.semantic = "locked";
    assert.throws(() => validateReferenceSession(ir), (error: unknown) => {
      assert.ok(error instanceof ReferenceAudioConfigError);
      assert.equal(error.code, code);
      assert.match(error.message, /project\.cut:\d+:\d+/);
      assert.match(error.message, message);
      assert.equal(error.source.nodeId, limiter(ir).id);
      return true;
    }, body);
  }
  assert.deepEqual(referenceLimiterLimits, {
    minimumCeilingDbtp: -23.5,
    maximumCeilingDbtp: 0,
    minimumReleaseSeconds: 0.001,
    maximumReleaseSeconds: 2,
    minimumLookaheadSeconds: 0,
    maximumLookaheadSeconds: 0.02,
    maximumAutomationEventsPerNode: 128,
    maximumAutomatedNodesPerComposition: 16,
    maximumAutomatedChannelSamplesPerComposition: 268_435_456,
    maximumAutomationExpressionCharactersPerNode: 32_768,
  });
});

test("Limiter automation bounds, clocks, easing and evaluation fail closed", () => {
  for (const [body, code, message] of [
    ["Limiter() as master { Tone(frequency: 440hz, duration: 100ms); } set master.ceiling = -24dbtp;", "CUT_AUDIO_AUTOMATION_VALUE_RANGE", /Limiter\.ceiling.*between -23\.5 dBTP and 0 dBTP/],
    ["Limiter() as master { Tone(frequency: 440hz, duration: 100ms); } set master.release = 0.5ms;", "CUT_AUDIO_AUTOMATION_VALUE_RANGE", /Limiter\.release.*between 1 ms and 2000 ms/],
    ["Limiter() as master { Tone(frequency: 440hz, duration: 100ms); } at 0.1ms { set master.ceiling = -3dbtp; }", "CUT_AUDIO_AUTOMATION_SAMPLE_GRID", /event start does not land/],
    ["Limiter() as master { Tone(frequency: 440hz, duration: 100ms); } animate master.ceiling from -6dbtp to -1dbtp over 10ms ease spring();", "CUT_AUDIO_AUTOMATION_EASING", /only linear and outCubic/],
  ] as const) {
    const ir = compile(body); ir.determinism.semantic = "locked";
    assert.throws(() => validateReferenceSession(ir), (error: unknown) => {
      assert.ok(error instanceof ReferenceAudioAutomationError);
      assert.equal(error.code, code);
      assert.match(error.message, message);
      assert.ok(error.source.line > 0 && error.source.column > 0);
      return true;
    }, body);
  }

  const ir = compile("Limiter() as master { Tone(frequency: 440hz, duration: 100ms); } set master.ceiling = -3dbtp;");
  const automation = compileReferenceLimiterAutomations(ir, ir.compositions[0], limiter(ir)).ceiling;
  assert.ok(automation);
  for (const invalid of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => automation.valueAtSample(invalid), (error: unknown) => error instanceof ReferenceAudioAutomationError
      && error.code === "CUT_AUDIO_AUTOMATION_VALUE_RANGE"
      && /safe-integer sample index/.test(error.message));
  }

  const manyBody = Array.from({ length: referenceLimiterLimits.maximumAutomatedNodesPerComposition + 1 }, (_, index) =>
    `Limiter() as master${index} { Tone(frequency: ${440 + index}hz, duration: 100ms); } set master${index}.ceiling = -3dbtp;`).join("\n");
  const many = compile(manyBody); many.determinism.semantic = "locked";
  assert.throws(() => validateReferenceSession(many), (error: unknown) => error instanceof ReferenceAudioAutomationError
    && error.code === "CUT_AUDIO_AUTOMATION_LIMIT"
    && /17 automated Limiter nodes; maximum is 16/.test(error.message));

  const tooLong = compile(
    "Limiter() as master { Tone(frequency: 440hz, duration: 1800s); } set master.ceiling = -3dbtp;",
    "192khz",
    "1800s",
  );
  tooLong.determinism.semantic = "locked";
  assert.throws(() => validateReferenceSession(tooLong), (error: unknown) => error instanceof ReferenceAudioAutomationError
    && error.code === "CUT_AUDIO_AUTOMATION_LIMIT"
    && /691200000 time-varying Limiter channel-samples; maximum is 268435456/.test(error.message));
});

test("strict IR loading preserves TruePeak and rejects forged Limiter signals", () => {
  const baseline = compile("Limiter() as master { Tone(frequency: 440hz, duration: 100ms); } set master.ceiling = -3dbtp;");
  assert.doesNotThrow(() => loadCutAvIr(JSON.stringify(baseline)));
  const id = signal(baseline, "ceiling").id;

  const wrongAttachment = structuredClone(baseline);
  const attachmentSignal = wrongAttachment.signals[id];
  attachmentSignal.valueType = "Gain";
  if (attachmentSignal.kind === "track" && attachmentSignal.events[0]?.kind === "set") {
    attachmentSignal.events[0].value = { kind: "quantity", dimension: "gain", magnitude: { numerator: "-3", denominator: "1" }, unit: "db" };
  }
  recompute(wrongAttachment);
  assert.throws(
    () => loadCutAvIr(JSON.stringify(wrongAttachment)),
    (error: unknown) => error instanceof CutAvIrValidationError
      && error.code === "CUT_IR_TYPE"
      && error.path === `$.signals.${id}.valueType`
      && /must be TruePeak/.test(error.message),
  );

  const wrongPayload = structuredClone(baseline);
  const payloadSignal = wrongPayload.signals[id];
  if (payloadSignal.kind === "track" && payloadSignal.events[0]?.kind === "set") {
    payloadSignal.events[0].value = { kind: "quantity", dimension: "gain", magnitude: { numerator: "-3", denominator: "1" }, unit: "db" };
  }
  recompute(wrongPayload);
  assert.throws(
    () => loadCutAvIr(JSON.stringify(wrongPayload)),
    (error: unknown) => error instanceof CutAvIrValidationError
      && error.code === "CUT_IR_TYPE"
      && error.path === `$.signals.${id}.events[0].value`
      && /TruePeak signal payload.*true-peak.*"dbtp"/.test(error.message),
  );

  const wrongConfig = structuredClone(baseline);
  limiter(wrongConfig).inputs.lookahead = { kind: "quantity", dimension: "scalar", magnitude: { numerator: "5", denominator: "1" }, unit: "scalar" };
  wrongConfig.determinism.semantic = "locked";
  assert.throws(() => validateReferenceSession(wrongConfig), (error: unknown) => error instanceof ReferenceAudioConfigError
    && error.code === "CUT_AUDIO_INPUT_TYPE"
    && /project\.cut:\d+:\d+.*lookahead.*dimension time/.test(error.message));

  const missingSignal = structuredClone(baseline);
  delete missingSignal.signals[id];
  missingSignal.determinism.semantic = "locked";
  assert.throws(() => validateReferenceSession(missingSignal), (error: unknown) => error instanceof ReferenceAudioAutomationError
    && error.code === "CUT_AUDIO_AUTOMATION_GRAPH"
    && error.source.nodeId === limiter(missingSignal).id);
});

test("Limiter automation remains first-class IR and affects node identity", () => {
  // Type-only guard: the signal API must remain a normal public IR signal, not
  // a private runtime side table.
  const before = compile("Limiter() as master { Tone(frequency: 440hz, duration: 100ms); } set master.ceiling = -3dbtp;");
  const after = compile("Limiter() as master { Tone(frequency: 440hz, duration: 100ms); } set master.ceiling = -6dbtp;");
  const beforeSignal: IRSignal = signal(before, "ceiling"), afterSignal: IRSignal = signal(after, "ceiling");
  assert.notEqual(beforeSignal.contentHash, afterSignal.contentHash);
  assert.notEqual(limiter(before).contentHash, limiter(after).contentHash);
});
