import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { CutAvIrValidationError, loadCutAvIr } from "../lib/language/ir-loader";
import { referenceKernelSchema } from "../lib/language/kernel-registry";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { cutSignalContentHash, finalizeGraphHashes } from "../lib/runtime/graph";
import {
  ReferenceNoOpContractError,
  referenceNoOpDiagnosticCode,
} from "../lib/runtime/reference/noop-contract";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

const cli = resolve("dist-cli/cli/cut.js");

async function runCli(args: string[], cwd: string, expectedCode: number) {
  return new Promise<{ stdout: string; stderr: string }>((accept, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout.on("data", (value: Buffer) => stdout.push(Buffer.from(value)));
    child.stderr.on("data", (value: Buffer) => stderr.push(Buffer.from(value)));
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (code === expectedCode) accept(result);
      else reject(new Error(`cut ${args.join(" ")} exited ${code ?? signal}, expected ${expectedCode}\n${result.stderr}${result.stdout}`));
    });
  });
}

const imports = `import { Blur, Camera2D, ColorGrade, Composite, Group, Mask, Rect, Stack, Trace } from "cut:visual";
import { Bus, Compressor, DeEsser, Delay, EQ, Gain, HighPass, Limiter, LowPass, Meter, Pan, Reverb, Send, Sidechain, Submix, Tone } from "@cut/audio";`;

function source(body: string) {
  return `cut 0.4;
project "no silent controls";
${imports}
timeline main(duration: 1s, fps: 24, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1s) { ${body} }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
}

function parse(body: string) {
  const parsed = parseCutLanguage(source(body));
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return parsed.module;
}

function compile(body: string) {
  const ir = compileCutModule(parse(body)).ir;
  ir.determinism.semantic = "locked";
  return ir;
}

function expectNoOpSourceFailure(body: string, expected: RegExp) {
  assert.throws(() => compileCutModule(parse(body)), (error: unknown) => {
    assert.ok(error instanceof CutCompileError, body);
    const diagnostic = error.result.diagnostics.find((item) => item.code === "CUT2085");
    assert.ok(diagnostic, body);
    assert.match(diagnostic.message, expected, body);
    assert.ok(diagnostic.span.start.line > 0 && diagnostic.span.start.column > 0, body);
    return true;
  });
}

const audioCardinality = [
  "cut.audio.bus",
  "cut.audio.submix",
  "cut.audio.gain",
  "cut.audio.pan",
  "cut.audio.eq",
  "cut.audio.highpass",
  "cut.audio.lowpass",
  "cut.audio.compressor",
  "cut.audio.deesser",
  "cut.audio.limiter",
  "cut.audio.reverb",
  "cut.audio.delay",
  "cut.audio.sidechain",
  "cut.audio.meter",
] as const;

test("kernel registry closes professional processor and compositor arity", () => {
  for (const op of audioCardinality) {
    const schema = referenceKernelSchema(op);
    assert.equal(schema?.support, "supported", op);
    if (schema?.support === "supported") {
      assert.equal(schema.minimumChildren, 1, op);
      assert.equal(schema.maximumChildren, undefined, op);
    }
  }
  const send = referenceKernelSchema("cut.audio.send");
  assert.equal(send?.support, "supported");
  if (send?.support === "supported") {
    assert.equal(send.minimumChildren, 0, "Send has a validated zero-child source: reference form and a one-or-more-child structural form");
    assert.equal(send.maximumChildren, undefined);
  }
  for (const op of ["cut.visual.blur", "cut.visual.shadow", "cut.visual.glow", "cut.visual.vignette", "cut.visual.color_grade"] as const) {
    const schema = referenceKernelSchema(op);
    assert.equal(schema?.support, "supported", op);
    if (schema?.support === "supported") assert.deepEqual([schema.minimumChildren, schema.maximumChildren], [1, 1], op);
  }
  const mask = referenceKernelSchema("cut.visual.mask");
  assert.equal(mask?.support, "supported");
  if (mask?.support === "supported") assert.deepEqual([mask.minimumChildren, mask.maximumChildren], [2, 2]);
});

test("typed source refuses every confirmed graph-dependent no-op with CUT2085", () => {
  const cases: Array<[string, RegExp]> = [
    ["Group(x: 12px);", /has no visual children.*x/],
    ["Camera2D(scale: 2);", /has no visual children.*scale/],
    ["Composite(blend: \"multiply\") { Rect(width: 8px, height: 8px); }", /blend requires at least two visual children/],
    ["Stack(gap: 8px) { Rect(width: 8px, height: 8px); }", /gap requires at least two visual children/],
    ["Stack(direction: \"horizontal\") { Rect(width: 8px, height: 8px); }", /direction with one child/],
    ["Blur(radius: 2px);", /requires exactly one visual child; found 0/],
    ["Mask() { Rect(width: 8px, height: 8px); }", /requires exactly two visual children: target, then matte/],
    ["ColorGrade() { Rect(width: 8px, height: 8px); Rect(width: 8px, height: 8px); }", /requires exactly one visual child; found 2/],
    ["Trace(points: [{ x: 0px, y: 0px }, { x: 8px, y: 0px }], stroke: #ffffff, width: 1px, duration: 1s, headColor: #ff0000);", /headColor\/headFade requires.*positive headRadius/],
    ["Trace(points: [{ x: 0px, y: 0px }, { x: 8px, y: 0px }], stroke: #ffffff, width: 1px, duration: 1s, headFade: 100ms);", /headColor\/headFade requires.*positive headRadius/],
    ["Trace(points: [{ x: 0px, y: 0px }, { x: 8px, y: 0px }], stroke: #ffffff, width: 1px, duration: 1s, headRadius: 0px);", /headRadius must be positive when authored/],
    ["Trace(points: [{ x: 4px, y: 4px }, { x: 4px, y: 4px }], stroke: #ffffff, width: 1px, duration: 1s);", /positive-length path/],
    ["Gain(amount: -6db);", /cut\.audio\.gain requires at least one audio child/],
    ["Bus(name: \"dialogue\");", /cut\.audio\.bus requires at least one audio child/],
  ];
  for (const [body, expected] of cases) expectNoOpSourceFailure(body, expected);
});

test("authored Text shadows must have positive effective opacity while zero blur remains a hard shadow", () => {
  const text = (color: string, opacity: string, blur: string, content = "A") => `cut 0.4;
project "text shadow no-op proof";
import { Text } from "cut:visual";
asset face: FontAsset = font("face.ttf");
timeline main(duration: 1s, fps: 24, width: 64px, height: 64px) {
  scene only(duration: 1s) {
    Text(content: "${content}", font: face, shadowColor: ${color}, shadowOpacity: ${opacity}, shadowBlur: ${blur});
  }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
  const rejects = (program: string, expected: RegExp) => {
    const parsed = parseCutLanguage(program); assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
    assert.throws(() => compileCutModule(parsed.module!), (error: unknown) => {
      assert.ok(error instanceof CutCompileError);
      const diagnostic = error.result.diagnostics.find((item) => item.code === "CUT2085");
      assert.ok(diagnostic); assert.match(diagnostic.message, expected);
      assert.ok(diagnostic.span.start.line > 0 && diagnostic.span.start.column > 0);
      return true;
    });
  };
  rejects(text("#000000", "0%", "3px"), /shadowOpacity must be positive/);
  rejects(text("#00000000", "100%", "3px"), /shadowColor cannot be fully transparent/);
  rejects(text("#000000", "100%", "0px", "   "), /content must contain a visible non-whitespace character/);
  const hard = parseCutLanguage(text("#000000", "100%", "0px")); assert.ok(hard.module);
  assert.doesNotThrow(() => compileCutModule(hard.module!), "zero blur is an executable hard shadow, not a no-op");
});

test("every public audio wrapper rejects an empty graph instead of synthesizing disguised silence", () => {
  const cases = [
    "Bus(name: \"dialogue\");",
    "Submix(name: \"effects\");",
    "Send(amount: -6db);",
    "Gain(amount: -6db);",
    "Pan(position: 0%);",
    "EQ();",
    "HighPass(frequency: 80hz);",
    "LowPass(frequency: 8khz);",
    "Compressor();",
    "DeEsser();",
    "Limiter();",
    "Reverb();",
    "Delay(time: 10ms);",
    "Meter();",
    "Tone(frequency: 440hz, duration: 1s) as key; Sidechain(source: key, amount: -8db);",
  ];
  for (const body of cases) expectNoOpSourceFailure(body, /requires at least one audio child/);
});

test("deliberate empty identity and meaningful one-child combinations remain legal", () => {
  const ir = compile(`
    Group();
    Composite(x: 4px) { Rect(width: 8px, height: 8px, fill: #ffffff); }
    Stack(direction: "horizontal", align: "start") { Rect(width: 8px, height: 8px, fill: #ff0000); }
    Stack(direction: "vertical", gap: 80px, distribution: "space-around") { Rect(width: 8px, height: 8px, fill: #00ff00); }
    Trace(points: [{ x: 0px, y: 0px }, { x: 8px, y: 0px }], stroke: #ffffff, width: 1px, duration: 1s);
    Gain(amount: -6db) { Tone(frequency: 440hz, duration: 1s); }
    Bus(name: "music") { Tone(frequency: 220hz, duration: 1s); Tone(frequency: 330hz, duration: 1s); }
  `);
  assert.doesNotThrow(() => validateReferenceSession(ir));
});

function hostile(body: string, mutate: (node: IRNode, ir: CutAVIR) => void, op: string) {
  const ir = compile(body), node = Object.values(ir.nodes).find((item) => item.op === op);
  assert.ok(node, op);
  mutate(node, ir);
  for (const signal of Object.values(ir.signals)) signal.contentHash = cutSignalContentHash(signal);
  finalizeGraphHashes(ir);
  return loadCutAvIr(JSON.stringify(ir));
}

function removeChildren(node: IRNode, ir: CutAVIR, keep = 0) {
  const removed = node.children.splice(keep);
  for (const id of removed) delete ir.nodes[id];
}

test("loaded typed IR cannot bypass cardinality or conditional controls", () => {
  const cases = [
    () => hostile("Gain(amount: -6db) { Tone(frequency: 440hz, duration: 1s); }", (node, ir) => removeChildren(node, ir), "cut.audio.gain"),
    () => hostile("Delay(time: 10ms, repeats: 2, decay: 50%) { Tone(frequency: 440hz, duration: 1s); }", (node, ir) => removeChildren(node, ir), "cut.audio.delay"),
    () => hostile("Delay(time: 10ms, repeats: 2, decay: 50%) { Tone(frequency: 440hz, duration: 1s); }", (node) => { node.inputs.repeats = { kind: "quantity", dimension: "scalar", magnitude: { numerator: "1", denominator: "1" }, unit: "scalar" }; }, "cut.audio.delay"),
    () => hostile("Composite(blend: \"multiply\") { Rect(width: 8px, height: 8px); Rect(width: 8px, height: 8px); }", (node, ir) => removeChildren(node, ir, 1), "cut.visual.composite"),
    () => hostile("Trace(points: [{ x: 0px, y: 0px }, { x: 8px, y: 0px }], stroke: #ffffff, width: 1px, duration: 1s, headRadius: 2px, headColor: #ff0000);", (node) => { delete node.inputs.headRadius; }, "cut.visual.trace"),
  ];
  for (const makeHostile of cases) {
    let ir: CutAVIR;
    try {
      ir = makeHostile();
    } catch (error) {
      assert.ok(error instanceof CutAvIrValidationError);
      assert.equal(error.code, "CUT_IR_TYPE");
      assert.match(error.path, /^\$\.nodes\./);
      continue;
    }
    assert.throws(() => validateReferenceSession(ir), (error: unknown) => {
      assert.ok(error instanceof ReferenceNoOpContractError);
      assert.equal(error.code, referenceNoOpDiagnosticCode);
      assert.match(error.message, /project\.cut:\d+:\d+/);
      assert.ok(error.source.line > 0 && error.source.column > 0);
      return true;
    });
  }
});

test("loaded typed IR rejects static-null and empty property signals instead of applying defaults", () => {
  const body = `Rect(width: 8px, height: 8px, fill: #ffffff) as box;
    animate box.opacity from 0% to 100% over 1s;`;
  const signalFor = (node: IRNode, ir: CutAVIR) => {
    const property = node.properties.opacity;
    assert.ok(property && "signal" in property);
    const signal = ir.signals[property.signal];
    assert.ok(signal);
    return signal;
  };
  const staticNull = hostile(body, (node, ir) => {
    const previous = node.properties.opacity;
    if (previous && "signal" in previous) delete ir.signals[previous.signal];
    node.properties.opacity = { kind: "null" };
  }, "cut.visual.rect");
  assert.throws(() => validateReferenceSession(staticNull), (error: unknown) => {
    assert.ok(error instanceof ReferenceNoOpContractError);
    assert.equal(error.code, referenceNoOpDiagnosticCode);
    assert.match(error.message, /property “opacity”.*null/);
    return true;
  });

  const malformedSignals: Array<(node: IRNode, ir: CutAVIR) => void> = [
    (node, ir) => {
      const signal = signalFor(node, ir);
      ir.signals[signal.id] = { id: signal.id, kind: "constant", valueType: "Ratio", value: { kind: "null" }, contentHash: signal.contentHash, provenance: signal.provenance };
    },
    (node, ir) => {
      const signal = signalFor(node, ir);
      ir.signals[signal.id] = { id: signal.id, kind: "step", valueType: "Ratio", points: [], contentHash: signal.contentHash, provenance: signal.provenance };
    },
    (node, ir) => {
      const signal = signalFor(node, ir);
      ir.signals[signal.id] = { id: signal.id, kind: "keyframes", valueType: "Ratio", keyframes: [], contentHash: signal.contentHash, provenance: signal.provenance };
    },
    (node, ir) => {
      const signal = signalFor(node, ir);
      assert.equal(signal.kind, "track");
      if (signal.kind === "track") signal.events = [];
    },
    (node, ir) => {
      const signal = signalFor(node, ir);
      assert.equal(signal.kind, "track");
      if (signal.kind === "track") signal.events = [{ kind: "set", time: rational(0), value: { kind: "null" } }];
    },
    (node, ir) => {
      const signal = signalFor(node, ir);
      assert.equal(signal.kind, "track");
      if (signal.kind === "track" && signal.events[0]?.kind === "animate") signal.events[0].from = { kind: "null" };
    },
  ];
  for (const mutate of malformedSignals) {
    assert.throws(() => hostile(body, mutate, "cut.visual.rect"), (error: unknown) => {
      assert.ok(error instanceof CutAvIrValidationError);
      assert.ok(error.path.includes(".signals.") || error.path.startsWith("$.signals"));
      return true;
    });
  }
});

test("cut check and render expose stable JSON and refuse output before backend work", async () => {
  const root = await mkdtemp(join(tmpdir(), "cut-noop-cli-"));
  const program = join(root, "main.cut"), lock = join(root, "cut.lock"), output = join(root, "should-not-exist.mp4");
  await writeFile(program, source("Gain(amount: -6db);"));
  await writeFile(lock, "{}\n");

  const checked = JSON.parse((await runCli(["check", "main.cut", "--json"], root, 1)).stdout) as {
    format: string;
    status: string;
    diagnostics: Array<{ code: string; source?: { path?: string; line?: number; column?: number } }>;
  };
  assert.equal(checked.format, "cut-diagnostics");
  assert.equal(checked.status, "fail");
  const diagnostic = checked.diagnostics.find((item) => item.code === "CUT2085");
  assert.equal(diagnostic?.source?.path, "main.cut");
  assert.ok((diagnostic?.source?.line ?? 0) > 0 && (diagnostic?.source?.column ?? 0) > 0);

  const rendered = await runCli(["render", "main.cut", "--lock", "cut.lock", "--out", output, "--json"], root, 1);
  assert.match(rendered.stdout, /CUT2085/);
  await assert.rejects(access(output), "compile-time no-op rejection must happen before FFmpeg or output creation");
});
