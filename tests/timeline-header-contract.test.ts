import test from "node:test";
import assert from "node:assert/strict";
import { parseCutLanguage } from "../lib/language/parser";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";

function parsed(source: string) {
  const result = parseCutLanguage(source);
  assert.equal(result.diagnostics.length, 0, result.diagnostics.map((item) => item.message).join("\n"));
  assert.ok(result.module);
  return result.module;
}

function program(header: string, constants = "") {
  return `cut 0.4;
project "Timeline header contract";
${constants}
timeline main(duration: 1s, fps: 24, ${header}) {}
export out = render(main);`;
}

function integerDiagnostic(source: string, argumentName: "width" | "height" | "sampleRate") {
  const cutModule = parsed(source);
  const timeline = cutModule.declarations.find((declaration) => declaration.kind === "timeline");
  assert.ok(timeline?.kind === "timeline");
  const authored = timeline.arguments.find((argument) => argument.name === argumentName);
  assert.ok(authored);
  try {
    compileCutModule(cutModule);
  } catch (error) {
    assert.ok(error instanceof CutCompileError);
    const diagnostic = error.result.diagnostics.find((item) => item.code === "CUT_TIMELINE_INTEGER");
    assert.ok(diagnostic, error.result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
    assert.deepEqual(diagnostic.span, authored.value.span, "the diagnostic must identify the exact authored header value");
    assert.match(diagnostic.message, new RegExp(`timeline ${argumentName}`));
    assert.match(diagnostic.message, /positive safe integer/u);
    return diagnostic;
  }
  assert.fail(`expected ${argumentName} to fail closed`);
}

test("timeline width, height, and sampleRate refuse fractional values instead of silently rounding", () => {
  integerDiagnostic(program("width: 640.4px, height: 360px, sampleRate: 48khz"), "width");
  integerDiagnostic(program("width: 640px, height: 359.6px, sampleRate: 48khz"), "height");
  integerDiagnostic(program("width: 640px, height: 360px, sampleRate: 48000.4hz"), "sampleRate");
});

test("timeline integer validation applies after deterministic constant evaluation", () => {
  integerDiagnostic(
    program("width: computedWidth, height: 360px, sampleRate: 48khz", "const computedWidth = 1281px / 2;"),
    "width",
  );
});

test("timeline integer validation refuses non-positive and unsafe values with the same stable contract", () => {
  integerDiagnostic(program("width: 0px, height: 360px, sampleRate: 48khz"), "width");
  integerDiagnostic(program("width: 640px, height: 360px, sampleRate: 0hz"), "sampleRate");
  integerDiagnostic(program("width: 9007199254740992px, height: 360px, sampleRate: 48khz"), "width");
});

test("exact positive integer timeline headers preserve their authored values", () => {
  const ir = compileCutModule(parsed(program("width: 641px, height: 359px, sampleRate: 44100hz"))).ir;
  const composition = ir.compositions[0];
  assert.deepEqual(
    { width: composition.width, height: composition.height, sampleRate: composition.sampleRate },
    { width: 641, height: 359, sampleRate: 44_100 },
  );
});
