import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import { kernelStringInputValues, referenceKernelSchema } from "../lib/language/kernel-registry";
import { builtinPackages } from "../lib/language/packages";
import { parseCutLanguage } from "../lib/language/parser";

function parsed(source: string) {
  const result = parseCutLanguage(source);
  assert.ok(result.module, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.diagnostics, []);
  return result.module;
}

function busProgram(valueDeclaration: string, roleExpression = "chosen") {
  return `cut 0.4;
project "Closed enum proof";
import { Bus, Tone } from "@cut/audio";
${valueDeclaration}
timeline main(duration: 20ms, fps: 50, width: 16px, height: 16px, sampleRate: 48khz) {
  Bus(name: "mix", role: ${roleExpression}) {
    Tone(frequency: 1khz, duration: 20ms, amplitude: 2%);
  }
}
export out = render(main);`;
}

function compileEnumFailure(source: string) {
  const parsedModule = parsed(source);
  assert.deepEqual(checkCutModule(parsedModule).diagnostics, [], "the regression requires an enum value known only after lowering");
  let captured: CutCompileError | undefined;
  try {
    compileCutModule(parsedModule);
  } catch (error) {
    assert.ok(error instanceof CutCompileError, String(error));
    captured = error;
  }
  assert.ok(captured, "lowered closed enum must fail compilation");
  const failures = captured.result.diagnostics.filter((item) => item.code === "CUT2068");
  assert.equal(failures.length, 1, JSON.stringify(captured.result.diagnostics));
  return failures[0];
}

test("closed package enums validate lowered top-level constants at the authored argument span", () => {
  const source = busProgram('const chosen: String = "voice";');
  const diagnostic = compileEnumFailure(source);
  const argumentOffset = source.lastIndexOf("chosen");
  assert.equal(diagnostic.span.start.offset, argumentOffset);
  assert.equal(diagnostic.span.end.offset, argumentOffset + "chosen".length);
  assert.equal(diagnostic.module, undefined);
  assert.equal(diagnostic.message, "Argument “role” for Bus must reduce to one of: dialogue, music, ambience, sfx.");

  const valid = compileCutModule(parsed(busProgram('const chosen: String = "dialogue";'))).ir;
  const bus = Object.values(valid.nodes).find((node) => node.op === "cut.audio.bus");
  assert.deepEqual(bus?.inputs.role, { kind: "string", value: "dialogue" });
});

test("closed package enums validate pure-function and component forwarding after expansion", () => {
  const functionSource = busProgram('function chosen() -> String = "voice";', "chosen()");
  const functionDiagnostic = compileEnumFailure(functionSource);
  assert.equal(functionDiagnostic.span.start.offset, functionSource.lastIndexOf("chosen()"));

  const componentSource = `cut 0.4;
project "Component enum proof";
import { Bus, Tone } from "@cut/audio";
component Routed(role: String) -> AudioNode {
  Bus(name: "mix", role: role) { Tone(frequency: 1khz, duration: 20ms); }
}
const chosen: String = "voice";
timeline main(duration: 20ms, fps: 50, sampleRate: 48khz) {
  Routed(role: chosen);
}
export out = render(main);`;
  const componentDiagnostic = compileEnumFailure(componentSource);
  const innerArgument = componentSource.indexOf("role: role") + "role: ".length;
  assert.equal(componentDiagnostic.span.start.offset, innerArgument);
  assert.equal(componentDiagnostic.span.end.offset, innerArgument + "role".length);
});

test("closed enum lowering is generalized beyond audio kernels and bounds hostile diagnostic output", () => {
  const outputSource = `cut 0.4;
project "Output enum proof";
const profile: String = "display-p3";
timeline main(duration: 1s, fps: 24) { scene only(duration: 1s) {} }
export out = render(main, color: profile);`;
  const outputDiagnostic = compileEnumFailure(outputSource);
  assert.equal(outputDiagnostic.span.start.offset, outputSource.lastIndexOf("profile"));
  assert.equal(outputDiagnostic.message, "Argument “color” for render must reduce to one of: srgb, linear-srgb, rec709-full, rec709-limited.");

  const kernelOnlySource = `cut 0.4;
project "Kernel enum proof";
import { Composite, Rect } from "cut:visual";
const mode: String = "burn";
timeline main(duration: 1s, fps: 24) {
  scene only(duration: 1s) {
    Composite(blend: mode) { Rect(width: 16px, height: 16px, fill: #123456); }
  }
}
export out = render(main);`;
  const kernelDiagnostic = compileEnumFailure(kernelOnlySource);
  assert.equal(kernelDiagnostic.span.start.offset, kernelOnlySource.lastIndexOf("mode"));
  assert.equal(kernelDiagnostic.message, "Argument “blend” for Composite must reduce to one of: normal, source-over, multiply, screen, overlay, darken, lighten, add, plus, difference.");

  for (const hostile of ["music\\n", "x".repeat(20_000)]) {
    const diagnostic = compileEnumFailure(busProgram(`const chosen: String = "${hostile}";`));
    assert.ok(diagnostic.message.length < 128, "diagnostic must not echo a hostile enum payload");
  }
});

test("public built-in package enum metadata exactly mirrors every supported kernel enum", () => {
  let compared = 0;
  for (const [specifier, package_] of builtinPackages) {
    for (const symbol of Object.values(package_.symbols)) {
      if (!symbol.native) continue;
      const schema = referenceKernelSchema(symbol.native);
      if (!schema || schema.support !== "supported") continue;
      for (const [input, kernelValues] of Object.entries(schema.stringInputs)) {
        const parameter = symbol.parameters?.find((candidate) => candidate.name === input);
        assert.ok(parameter, `${specifier}#${symbol.name} must publicly declare kernel input ${input}`);
        assert.deepEqual(parameter.values, kernelValues, `${specifier}#${symbol.name}.${input} enum drifted from ${symbol.native}`);
        assert.deepEqual(kernelStringInputValues(schema, input), kernelValues);
        compared += 1;
      }
    }
  }
  assert.ok(compared >= 30, `expected broad enum parity coverage, compared ${compared}`);
});

test("literal closed-enum diagnostics are not duplicated", () => {
  const source = busProgram("", '"voice"');
  const diagnostics = checkCutModule(parsed(source)).diagnostics.filter((item) => item.code === "CUT2068");
  assert.equal(diagnostics.length, 1, JSON.stringify(diagnostics));
  assert.equal(diagnostics[0].span.start.offset, source.lastIndexOf('"voice"'));
});

test("cut check JSON fails a lowered invalid enum with a stable source location", () => {
  const cli = resolve(__dirname, "../cli/cut.js");
  const source = busProgram('const chosen: String = "voice";');
  const result = spawnSync(process.execPath, [cli, "check", "virtual.cut", "--stdin", "--json"], {
    encoding: "utf8",
    input: source,
    timeout: 10_000,
  });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout) as { status: string; diagnostics: Array<{ code: string; source: { path: string; line: number; column: number } }> };
  assert.equal(report.status, "fail");
  assert.equal(report.diagnostics.length, 1);
  assert.equal(report.diagnostics[0].code, "CUT2068");
  assert.deepEqual(report.diagnostics[0].source, { path: "virtual.cut", line: 6, column: 26 });
});
