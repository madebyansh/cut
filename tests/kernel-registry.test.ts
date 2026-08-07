import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { stableJsonStringify } from "../lib/core/stable";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import { CutAvIrValidationError, loadCutAvIr } from "../lib/language/ir-loader";
import { parseCutLanguage } from "../lib/language/parser";
import { referenceKernelSchema } from "../lib/language/kernel-registry";
import { builtinPackages } from "../lib/language/packages";
import { rational } from "../lib/language/rational";
import { finalizeGraphHashes } from "../lib/runtime/graph";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

function parse(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module);
  assert.deepEqual(parsed.diagnostics, []);
  return parsed.module;
}

function program(imports: string, body: string) {
  return `cut 0.4;
project "kernel truth";
${imports}
timeline main(duration: 1s, fps: 24, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1s) { ${body} }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
}

test("closed registry refuses exposed kernels whose semantics do not execute", () => {
  const sources = [
    program('import { Rect, Shader } from "cut:visual";', 'Shader(module: "missing.wasm") { Rect(width: 8px, height: 8px); }'),
    program('import { Tone } from "@cut/audio"; import { CaptionTrack } from "@cut/documentary";', 'Tone(frequency: 440hz, duration: 1s) as voice; CaptionTrack(source: voice);'),
  ];
  for (const source of sources) {
    const checked = checkCutModule(parse(source));
    assert.ok(checked.diagnostics.some((item) => item.code === "CUT2058" && /unavailable/.test(item.message)), checked.diagnostics.map((item) => item.message).join("\n"));
    assert.throws(() => compileCutModule(parse(source)), CutCompileError);
  }
});

test("supported kernels accept only named inputs that the runtime executes", () => {
  const source = program('import { Text } from "cut:visual";', 'Text(content: "visible", inventedBlur: 12px);');
  const checked = checkCutModule(parse(source));
  const diagnostic = checked.diagnostics.find((item) => item.code === "CUT2059");
  assert.match(diagnostic?.message ?? "", /cut\.visual\.text.*inventedBlur/);
  assert.match(diagnostic?.hint ?? "", /Accepted inputs:/);
  assert.throws(() => compileCutModule(parse(source)), CutCompileError);
});

test("Narration transcript fails at the exact source argument while valid narration remains role-classified", () => {
  const source = `cut 0.4;
project "Narration transcript refusal";
import { Narration } from "@cut/documentary";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 1s, fps: 24, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Narration(source: voice, transcript: "ignored words", range: 0s ..< 1s);
  }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
  const diagnostic = checkCutModule(parse(source)).diagnostics.find((item) => item.code === "CUT2059");
  assert.ok(diagnostic);
  const startOffset = source.indexOf("transcript:");
  const endOffset = source.indexOf('"ignored words"', startOffset) + '"ignored words"'.length;
  const position = (offset: number) => {
    const lines = source.slice(0, offset).split("\n");
    return { offset, line: lines.length, column: lines.at(-1)!.length + 1 };
  };
  assert.deepEqual(JSON.parse(stableJsonStringify(diagnostic)), {
    code: "CUT2059",
    hint: 'Accepted inputs: source, range, fadeIn, fadeOut. Use Captions for visible timed text, or Marker/Region with role: "transcript" and comment metadata for non-rendering notes.',
    message: "Reference kernel cut.documentary.narration does not execute input “transcript”.",
    severity: "error",
    span: { start: position(startOffset), end: position(endOffset) },
  });
  assert.throws(() => compileCutModule(parse(source)), CutCompileError);

  const validSource = source.replace(', transcript: "ignored words"', "");
  const checked = checkCutModule(parse(validSource));
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  const ir = compileCutModule(parse(validSource)).ir;
  const narration = Object.values(ir.nodes).find((node) => node.op === "cut.documentary.narration");
  assert.ok(narration);
  assert.equal(narration.domain, "audio");
  assert.deepEqual(Object.keys(narration.inputs), ["source", "range"]);
});

test("current loaded IR and runtime both refuse a hostile Narration transcript before execution", () => {
  const source = `cut 0.4;
project "hostile narration IR";
import { Narration } from "@cut/documentary";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 1s, fps: 24, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1s) { Narration(source: voice, range: 0s ..< 1s); }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
  const hostile = compileCutModule(parse(source)).ir;
  const narration = Object.values(hostile.nodes).find((node) => node.op === "cut.documentary.narration");
  assert.ok(narration);
  narration.inputs.transcript = { kind: "string", value: "hostile legacy text" };
  for (const resource of Object.values(hostile.resources)) {
    resource.state = "locked";
    resource.sha256 = "0".repeat(64);
    resource.metadata = {
      lockVersion: 2,
      bytes: 1,
      probe: {
        kind: "media",
        identity: {
          format: "cut-media-probe",
          version: 1,
          streams: [{
            index: 0,
            type: "audio",
            codec: "pcm_s16le",
            disposition: [],
            timeBase: rational(1, 48_000),
            start: rational(0),
            duration: rational(1),
            sampleRate: 48_000,
            channels: 2,
          }],
        },
        selected: { audio: { streamIndex: 0, duration: rational(1), durationSource: "stream", timeBase: rational(1, 48_000) } },
      },
    } as never;
  }
  hostile.determinism.semantic = "locked";

  assert.throws(
    () => validateReferenceSession(hostile),
    new RegExp(`Reference kernel cut\\.documentary\\.narration at project\\.cut:${narration.provenance.span.start.line}:${narration.provenance.span.start.column} does not execute input “transcript”; refusing a silent no-op\\.`),
  );

  finalizeGraphHashes(hostile);
  assert.throws(
    () => loadCutAvIr(stableJsonStringify(hostile)),
    (error) => error instanceof CutAvIrValidationError
      && error.code === "CUT_IR_UNKNOWN_FIELD"
      && error.path === `$.nodes.${narration.id}.inputs.transcript`
      && error.message === `CUT_IR_UNKNOWN_FIELD at $.nodes.${narration.id}.inputs.transcript: is not part of the closed reference kernel cut.documentary.narration input contract.`,
  );

  const forgedLegacyCompiler = structuredClone(hostile);
  forgedLegacyCompiler.compiler = "cut-ts/0.3.0";
  finalizeGraphHashes(forgedLegacyCompiler);
  assert.throws(
    () => loadCutAvIr(stableJsonStringify(forgedLegacyCompiler)),
    (error) => error instanceof CutAvIrValidationError
      && error.code === "CUT_IR_UNKNOWN_FIELD"
      && error.path === `$.nodes.${narration.id}.inputs.transcript`,
    "changing compiler text must not bypass the default current loader contract",
  );
  assert.doesNotThrow(
    () => loadCutAvIr(stableJsonStringify(forgedLegacyCompiler), { identityMode: "legacy-0.3-compatible" }),
    "the exact archived compiler remains explicitly readable as evidence",
  );
  assert.throws(
    () => validateReferenceSession(forgedLegacyCompiler),
    /does not execute input “transcript”; refusing a silent no-op/,
    "legacy readability is never runtime execution authority",
  );
});

test("ignored visual and audio automation properties fail at their source spans", () => {
  const source = program(
    'import { Rect } from "cut:visual"; import { EQ, Gain, Reverb, Tone } from "@cut/audio";',
    'Rect(width: 32px, height: 32px) as panel; animate panel.blur from 0px to 8px over 1s; animate panel.exposure from 0 to 1 over 1s; Gain(amount: -6db) as master { Tone(frequency: 220hz, duration: 1s); } animate master.gain from -12db to 0db over 1s; EQ(gain: 0db) as toneShape { Tone(frequency: 330hz, duration: 1s); } animate toneShape.gain from 0db to 3db over 1s; Reverb(wet: 0%) as room { Tone(frequency: 440hz, duration: 1s); } animate room.wet from 0% to 100% over 1s;',
  );
  const diagnostics = checkCutModule(parse(source)).diagnostics.filter((item) => item.code === "CUT2060");
  assert.deepEqual(diagnostics.map((item) => item.message), [
    'Reference kernel cut.visual.rect has no executable property “blur”.',
    'Reference kernel cut.visual.rect has no executable property “exposure”.',
    'Reference kernel cut.audio.gain has no executable property “gain”.',
  ]);
  assert.ok(diagnostics.every((item) => !item.message.includes("cut.audio.eq") && !item.message.includes("cut.audio.reverb")));
});

test("leaf child policy is shared with source validation", () => {
  const source = program('import { Marker } from "@cut/geo"; import { Rect } from "cut:visual";', 'Marker(point: { latitude: 0, longitude: 0 }) { Rect(width: 8px, height: 8px); }');
  const diagnostics = checkCutModule(parse(source)).diagnostics;
  assert.ok(diagnostics.some((item) => item.code === "CUT2034" && /does not accept child/.test(item.message)));
});

test("IR validation rejects unknown inputs, properties, children, and missing signals", () => {
  const source = program('import { Rect } from "cut:visual";', 'Rect(width: 32px, height: 32px) as label;');
  const fresh = () => { const ir = compileCutModule(parse(source)).ir; ir.determinism.semantic = "locked"; return ir; };

  const inputIr = fresh(), inputNode = Object.values(inputIr.nodes).find((node) => node.op === "cut.visual.rect")!;
  inputNode.inputs.inventedBlur = { kind: "quantity", dimension: "length", magnitude: { numerator: "1", denominator: "1" }, unit: "px" };
  assert.throws(() => validateReferenceSession(inputIr), /does not execute input.*inventedBlur.*silent no-op/);

  const propertyIr = fresh(), propertyNode = Object.values(propertyIr.nodes).find((node) => node.op === "cut.visual.rect")!;
  propertyNode.properties.blur = { signal: "missing" };
  assert.throws(() => validateReferenceSession(propertyIr), /does not execute property.*blur.*silent no-op/);

  const signalIr = fresh(), signalNode = Object.values(signalIr.nodes).find((node) => node.op === "cut.visual.rect")!;
  signalNode.properties.opacity = { signal: "missing" };
  assert.throws(() => validateReferenceSession(signalIr), /references missing signal missing/);

  const childIr = fresh(), childNode = Object.values(childIr.nodes).find((node) => node.op === "cut.visual.rect")!;
  childNode.children.push(childNode.id);
  assert.throws(() => validateReferenceSession(childIr), /does not execute child nodes/);
});

test("accepted animated grade properties execute in reference frames", async () => {
  const { ReferenceVisualRenderer } = await import("../lib/runtime/reference/visual.js");
  const source = program(
    'import { ColorGrade, Rect } from "cut:visual";',
    'ColorGrade(exposure: 0, temperature: 0, tint: 0, brightness: 1, saturation: 1, contrast: 1) as grade { Rect(width: 64px, height: 64px, x: 32px, y: 32px, fill: #406080); } animate grade.exposure from 0 to 1 over 1s; animate grade.temperature from 0 to 1 over 1s; animate grade.tint from 0 to -1 over 1s; animate grade.contrast from 1 to 2 over 1s; animate grade.saturation from 1 to 0 over 1s;',
  );
  const cutModule = parse(source), checked = checkCutModule(cutModule);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  const ir = compileCutModule(cutModule).ir; ir.determinism.semantic = "locked";
  const { composition } = validateReferenceSession(ir);
  const root = await mkdtemp(resolve(tmpdir(), "cut-kernel-grade-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  await renderer.prepare();
  const scene = ir.scenes[composition.sceneIds[0]];
  const first = await renderer.sceneFrame(scene, 0), later = await renderer.sceneFrame(scene, 23);
  renderer.close();
  assert.notDeepEqual(first.data, later.data, "grade signal must alter rendered pixels");
  const grade = Object.values(ir.nodes).find((node) => node.op === "cut.visual.color_grade")!;
  assert.deepEqual(Object.keys(grade.properties).sort(), ["contrast", "exposure", "saturation", "temperature", "tint"]);
});

test("registry exposes the exact refusal reasons used by checker and runtime", () => {
  const reason = (op: string) => { const schema = referenceKernelSchema(op); return schema?.support === "refused" ? schema.reason : ""; };
  assert.match(reason("cut.visual.shader"), /extension boundary/);
  assert.match(reason("cut.documentary.captions"), /timed-cue semantics/);
  assert.equal(referenceKernelSchema("cut.visual.stack")?.support, "supported");
  assert.equal(referenceKernelSchema("cut.visual.composite")?.support, "supported");
  assert.equal(referenceKernelSchema("cut.visual.mask")?.support, "supported");
});

test("every built-in node export has a registry entry and supported declarations exactly match executable inputs", () => {
  for (const package_ of builtinPackages.values()) {
    for (const symbol of Object.values(package_.symbols)) {
      if (!symbol.native || !symbol.domain || !["visual", "audio", "av"].includes(symbol.domain)) continue;
      const schema = referenceKernelSchema(symbol.native);
      assert.ok(schema, `${package_.specifier}#${symbol.name} lacks a kernel registry entry`);
      if (schema.support !== "supported") continue;
      const names = (symbol.parameters ?? []).map((parameter) => parameter.name);
      assert.equal(new Set(names).size, names.length, `${symbol.native} declares a parameter more than once`);
      assert.deepEqual(
        [...names].sort(),
        [...schema.inputs, ...(schema.authoringInputs ?? [])].sort(),
        `${symbol.native} package parameters and public authoring inputs drifted`,
      );
      assert.notEqual(symbol.openNamed, true, `${symbol.native} must not bypass its closed public parameter contract`);
      assert.equal(schema.domain, symbol.domain, `${symbol.native} domain drift`);
      assert.equal(schema.children, symbol.children ?? "none", `${symbol.native} child-policy drift`);
    }
  }
});

test("closed visual input types reject invalid transforms and normalized crops before IR", () => {
  const sources = [
    {
      parameter: "x",
      source: program('import { Rect } from "cut:visual";', 'Rect(width: 32px, height: 32px, x: "left");'),
    },
    {
      parameter: "crop",
      source: `cut 0.4;
project "closed image crop";
import { Image } from "cut:visual";
asset still: ImageAsset = image("fixture.png");
timeline main(duration: 1s, fps: 24, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1s) { Image(source: still, crop: { x: 0%, y: 0%, width: 64px, height: 100% }); }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`,
    },
  ];
  for (const fixture of sources) {
    const cutModule = parse(fixture.source), checked = checkCutModule(cutModule);
    const wrongType = checked.diagnostics.filter((item) => item.code === "CUT2029");
    assert.equal(wrongType.length, 1, checked.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
    assert.match(wrongType[0].message, new RegExp(`Argument .${fixture.parameter}. expects`));
    assert.throws(() => compileCutModule(cutModule), CutCompileError);
  }
});

test("a closed normalized-ratio Image crop lowers to an ordinary IR object", () => {
  const source = `cut 0.4;
project "valid image crop";
import { Image } from "cut:visual";
asset still: ImageAsset = image("fixture.png");
timeline main(duration: 1s, fps: 24, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1s) { Image(source: still, crop: { x: 10%, y: 20%, width: 80%, height: 70% }); }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
  const cutModule = parse(source), checked = checkCutModule(cutModule);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  const ir = compileCutModule(cutModule).ir;
  const image = Object.values(ir.nodes).find((node) => node.op === "cut.visual.image");
  assert.equal(image?.inputs.crop?.kind, "object");
  if (image?.inputs.crop?.kind !== "object") assert.fail("Image crop did not lower to an IR object.");
  assert.deepEqual(Object.keys(image.inputs.crop.entries).sort(), ["height", "width", "x", "y"]);
});
