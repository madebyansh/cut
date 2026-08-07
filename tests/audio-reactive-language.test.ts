import assert from "node:assert/strict";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError, recomputeBuildId } from "../lib/language/compiler";
import type { CutAVIR, IRSignal } from "../lib/language/ir";
import { CutAvIrValidationError, validateCutAvIr } from "../lib/language/ir-loader";
import { builtinPackages } from "../lib/language/packages";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { cutSignalContentHash } from "../lib/runtime/graph";

type ProgramOptions = {
  range?: string;
  at?: string;
  groupInputs?: string;
  targetNode?: "Group" | "Rect";
  mapName?: "mapNumber" | "mapRatio" | "mapLength" | "mapAngle";
  property?: "x" | "y" | "scale" | "rotation" | "opacity";
  from?: string;
  to?: string;
  beforeSet?: string;
  secondSet?: string;
  envelopeInScene?: boolean;
};

function source({
  range = "0s ..< 2s",
  at = "0s",
  groupInputs = "scale: 1",
  targetNode = "Group",
  mapName = "mapNumber",
  property = "scale",
  from = "1",
  to = "1.14",
  beforeSet = "",
  secondSet = "set pulse.opacity = mapRatio(energy, from: 40%, to: 100%);",
  envelopeInScene = true,
}: ProgramOptions = {}) {
  const envelope = `let energy: Signal<Ratio> = AmplitudeEnvelope(
      source: score,
      range: ${range},
      at: ${at},
      detector: "rms",
      window: 20ms,
      hop: 10ms,
      attack: 30ms,
      release: 140ms,
      floor: 2%,
      ceiling: 80%
    );`;
  const visual = targetNode === "Group"
    ? `Group(${groupInputs}) as pulse { Rect(width: 120px, height: 80px, fill: #55d6be); }`
    : `Rect(width: 120px, height: 80px, fill: #55d6be) as pulse;`;
  return `cut 0.4;
project "public audio-reactive signal";
import { Group, Rect } from "cut:visual";
import { AmplitudeEnvelope, mapAngle, mapLength, mapNumber, mapRatio } from "@cut/data";
asset score: AudioAsset = audio("assets/score.wav");
timeline main(duration: 2s, fps: 24, width: 640px, height: 360px, sampleRate: 48khz) {
  ${envelopeInScene ? "" : envelope}
  scene pulseScene(duration: 2s) {
    ${envelopeInScene ? envelope : ""}
    ${visual}
    ${beforeSet}
    set pulse.${property} = ${mapName}(energy, from: ${from}, to: ${to});
    ${secondSet}
  }
}
export out = render(main);`;
}

function parsed(text = source()) {
  const result = parseCutLanguage(text);
  assert.ok(result.module, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.diagnostics, []);
  return result.module;
}

function compile(text = source()) {
  return compileCutModule(parsed(text)).ir;
}

function producerSignals(ir: CutAVIR) {
  return Object.values(ir.signals).filter((signal): signal is Extract<IRSignal, { kind: "track" }> & { producer: NonNullable<Extract<IRSignal, { kind: "track" }>["producer"]> } => signal.kind === "track" && signal.producer !== undefined);
}

function refresh(ir: CutAVIR) {
  for (const signal of Object.values(ir.signals)) signal.contentHash = cutSignalContentHash(signal);
  recomputeBuildId(ir);
  return ir;
}

function expectCompileDiagnostic(text: string, code: string) {
  assert.throws(() => compile(text), (error: unknown) => {
    assert.ok(error instanceof CutCompileError);
    const diagnostic = error.result.diagnostics.find((item) => item.code === code);
    assert.ok(diagnostic, JSON.stringify(error.result.diagnostics));
    assert.ok(diagnostic.span.start.offset < diagnostic.span.end.offset);
    return true;
  });
}

function expectLoaderDiagnostic(ir: CutAVIR, code: CutAvIrValidationError["code"], path: RegExp) {
  assert.throws(() => validateCutAvIr(ir), (error: unknown) => {
    assert.ok(error instanceof CutAvIrValidationError);
    assert.equal(error.code, code);
    assert.match(error.path, path);
    return true;
  });
}

test("@cut/data publishes one typed amplitude producer and four exact generic property maps", () => {
  const symbols = builtinPackages.get("@cut/data")?.symbols;
  assert.ok(symbols);
  assert.deepEqual({ returns: symbols.AmplitudeEnvelope.returns, effect: symbols.AmplitudeEnvelope.effect, native: symbols.AmplitudeEnvelope.native }, {
    returns: "Signal<Ratio>", effect: "analyze", native: "cut.data.amplitude_envelope",
  });
  assert.deepEqual(["mapNumber", "mapRatio", "mapLength", "mapAngle"].map((name) => ({
    name,
    returns: symbols[name]!.returns,
    signal: symbols[name]!.parameters?.[0]?.type,
  })), [
    { name: "mapNumber", returns: "Signal<Number>", signal: "Signal<Ratio>" },
    { name: "mapRatio", returns: "Signal<Ratio>", signal: "Signal<Ratio>" },
    { name: "mapLength", returns: "Signal<Length>", signal: "Signal<Ratio>" },
    { name: "mapAngle", returns: "Signal<Angle>", signal: "Signal<Ratio>" },
  ]);
});

test("public let/set source lowers reusable analysis into ordinary typed Group property tracks", () => {
  const parsedModule = parsed(), check = checkCutModule(parsedModule);
  assert.deepEqual(check.diagnostics, []);
  const ir = compileCutModule(parsedModule).ir;
  const signals = producerSignals(ir);
  assert.equal(signals.length, 2, "one envelope fans out through independent typed mappings without a visual-specific analyzer node");
  const scale = signals.find((signal) => signal.valueType === "Number");
  const opacity = signals.find((signal) => signal.valueType === "Ratio");
  assert.ok(scale?.producer && opacity?.producer);
  assert.deepEqual(scale.initial, { kind: "quantity", dimension: "scalar", magnitude: rational(1), unit: "scalar" });
  assert.deepEqual(scale.events, []);
  assert.deepEqual(scale.producer, {
    format: "cut-audio-amplitude-producer",
    version: 1,
    source: { kind: "resource-ref", id: "score" },
    scope: { compositionId: "main", sceneId: ir.compositions[0]!.sceneIds[0]! },
    range: { start: rational(0), end: rational(2) },
    at: rational(0),
    detector: "rms",
    window: rational(1, 50),
    hop: rational(1, 100),
    attack: rational(3, 100),
    release: rational(7, 50),
    floor: rational(1, 50),
    ceiling: rational(4, 5),
    mapping: {
      kind: "linear",
      from: { kind: "quantity", dimension: "scalar", magnitude: rational(1), unit: "scalar" },
      to: { kind: "quantity", dimension: "scalar", magnitude: rational(57, 50), unit: "scalar" },
    },
  });
  assert.deepEqual({ ...opacity.producer, mapping: undefined }, { ...scale.producer, mapping: undefined });
  validateCutAvIr(ir);
});

test("producer content participates in stable semantic identity and semantic diff", () => {
  const before = compile(source({ secondSet: "" }));
  const after = compile(source({ to: "1.2", secondSet: "" }));
  const beforeSignal = producerSignals(before)[0]!, afterSignal = producerSignals(after)[0]!;
  assert.equal(beforeSignal.id, afterSignal.id, "mapping edits retain the semantic property-track identity");
  assert.notEqual(beforeSignal.contentHash, afterSignal.contentHash);
  const change = diffCutAVIR(before, after).changes.find((item) => item.entity === "signal" && item.id === beforeSignal.id);
  assert.ok(change && change.operation === "modify");
  if (change.operation === "modify") assert.ok(change.fields.some((field) => field.path === "/producer/mapping/to/magnitude/numerator"));
});

test("all four map types attach to their exact ordinary Group property types", () => {
  const programs = [
    source({ groupInputs: "x: 0px", property: "x", mapName: "mapLength", from: "0px", to: "48px", secondSet: "" }),
    source({ groupInputs: "y: 0px", property: "y", mapName: "mapLength", from: "0px", to: "-24px", secondSet: "" }),
    source({ groupInputs: "rotation: 0deg", property: "rotation", mapName: "mapAngle", from: "0deg", to: "12deg", secondSet: "" }),
    source({ groupInputs: "opacity: 40%", property: "opacity", mapName: "mapRatio", from: "40%", to: "100%", secondSet: "" }),
  ];
  assert.deepEqual(programs.map((program) => producerSignals(compile(program))[0]!.valueType), ["Length", "Length", "Angle", "Ratio"]);
});

test("checker/compiler reject mismatched maps, non-Group targets, wrong scope, inclusive ranges, conflicts, no-ops, and invalid baselines", () => {
  expectCompileDiagnostic(source({ mapName: "mapLength", from: "1px", to: "2px", secondSet: "" }), "CUT_AUDIO_REACTIVE_TYPE");
  expectCompileDiagnostic(source({ targetNode: "Rect", property: "opacity", mapName: "mapRatio", from: "40%", to: "100%", secondSet: "" }), "CUT_AUDIO_REACTIVE_TARGET");
  expectCompileDiagnostic(source({ envelopeInScene: false, secondSet: "" }), "CUT_AUDIO_REACTIVE_SCOPE");
  expectCompileDiagnostic(source({ range: "0s .. 2s", secondSet: "" }), "CUT_AUDIO_REACTIVE_RANGE");
  expectCompileDiagnostic(source().replace("window: 20ms", "window: 1.1ms"), "CUT_AUDIO_REACTIVE_TIME");
  expectCompileDiagnostic(source({ to: "1", secondSet: "" }), "CUT_AUDIO_REACTIVE_NOOP");
  expectCompileDiagnostic(source({ groupInputs: "scale: 1.1", secondSet: "" }), "CUT_AUDIO_REACTIVE_BASELINE");
  expectCompileDiagnostic(source({ beforeSet: "set pulse.scale = 1.05;", secondSet: "" }), "CUT_AUDIO_REACTIVE_CONFLICT");
});

test("strict loader refuses producer/event combinations, bad baselines/types/resources/scopes, and silent unused producers", () => {
  const valid = compile(source({ secondSet: "" }));
  const signalId = producerSignals(valid)[0]!.id;

  const withEvent = structuredClone(valid), eventSignal = withEvent.signals[signalId] as Extract<IRSignal, { kind: "track" }>;
  eventSignal.events.push({ kind: "set", time: rational(1), value: eventSignal.initial });
  expectLoaderDiagnostic(refresh(withEvent), "CUT_AUDIO_REACTIVE_CONFLICT", /events/u);

  const badBaseline = structuredClone(valid), baselineSignal = badBaseline.signals[signalId] as Extract<IRSignal, { kind: "track" }>;
  baselineSignal.initial = { kind: "quantity", dimension: "scalar", magnitude: rational(11, 10), unit: "scalar" };
  expectLoaderDiagnostic(refresh(badBaseline), "CUT_AUDIO_REACTIVE_BASELINE", /initial/u);

  const badType = structuredClone(valid), typedSignal = badType.signals[signalId] as Extract<IRSignal, { kind: "track" }>;
  assert.ok(typedSignal.producer);
  typedSignal.producer.mapping.from = { kind: "quantity", dimension: "length", magnitude: rational(1), unit: "px" };
  typedSignal.producer.mapping.to = { kind: "quantity", dimension: "length", magnitude: rational(2), unit: "px" };
  typedSignal.initial = typedSignal.producer.mapping.from;
  expectLoaderDiagnostic(refresh(badType), "CUT_AUDIO_REACTIVE_TYPE", /initial/u);

  const badResource = structuredClone(valid), resourceSignal = badResource.signals[signalId] as Extract<IRSignal, { kind: "track" }>;
  assert.ok(resourceSignal.producer);
  resourceSignal.producer.source.id = "missing_audio";
  expectLoaderDiagnostic(refresh(badResource), "CUT_AUDIO_REACTIVE_RESOURCE", /producer\.source\.id/u);

  const badScope = structuredClone(valid), scopeSignal = badScope.signals[signalId] as Extract<IRSignal, { kind: "track" }>;
  assert.ok(scopeSignal.producer);
  scopeSignal.producer.scope.sceneId = "missing_scene";
  expectLoaderDiagnostic(refresh(badScope), "CUT_AUDIO_REACTIVE_SCOPE", /scope\.sceneId/u);

  const unused = structuredClone(valid);
  const group = Object.values(unused.nodes).find((node) => node.op === "cut.visual.group")!;
  delete group.properties.scale;
  expectLoaderDiagnostic(refresh(unused), "CUT_AUDIO_REACTIVE_TARGET", new RegExp(`signals\\.${signalId}`));
});
