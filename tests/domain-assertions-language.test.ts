import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import { CutAvIrValidationError, loadCutAvIr } from "../lib/language/ir-loader";
import { parseCutLanguage } from "../lib/language/parser";
import { cutDiagnosticsFromError } from "../lib/runtime/diagnostics";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

function source(sceneBody: string, assertions = `
  assert timelineDurationIs(main, 2s), "exact duration";
  assert timelineHasNoSceneGaps(main), "scene coverage";
  assert timelineHasNoSceneOverlaps(main), "scene isolation";
  assert timeIsOnFrameGrid(main, 1s) && timeIsOnSampleGrid(main, 1s), "shared grid";
`) {
  return `cut 0.4;
project "domain assertions";
timeline main(duration: 2s, fps: 24, width: 64px, height: 64px, sampleRate: 48khz) {
${assertions}
${sceneBody}
}
export out = render(main, width: 64px, height: 64px, codec: "h264");
`;
}

function moduleFor(program: string) {
  const parsed = parseCutLanguage(program);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return parsed.module;
}

function compile(program: string) {
  return compileCutModule(moduleFor(program)).ir;
}

const touchingScenes = `  scene first(duration: 1s) {}
  scene second(duration: 1s) {}`;

test("public core predicates resolve from the completed graph independent of assertion source order", () => {
  const ir = compile(source(touchingScenes));
  assert.deepEqual(ir.assertions.map((item) => [item.status, item.message]), [
    ["pass", "exact duration"],
    ["pass", "scene coverage"],
    ["pass", "scene isolation"],
    ["pass", "shared grid"],
  ]);
  assert.deepEqual(ir.assertions.map((item) => item.expression.kind), ["call", "call", "call", "binary"]);
  assert.deepEqual(loadCutAvIr(JSON.stringify(ir)).assertions, ir.assertions);

  const afterScenes = compile(`cut 0.4;
project "domain assertions after scenes";
timeline main(duration: 2s, fps: 24, width: 64px, height: 64px, sampleRate: 48khz) {
${touchingScenes}
  assert timelineDurationIs(main, 2s), "exact duration";
  assert timelineHasNoSceneGaps(main), "scene coverage";
  assert timelineHasNoSceneOverlaps(main), "scene isolation";
  assert timeIsOnFrameGrid(main, 1s) && timeIsOnSampleGrid(main, 1s), "shared grid";
}
export out = render(main, width: 64px, height: 64px, codec: "h264");
`);
  assert.deepEqual(afterScenes.assertions.map((item) => item.status), ["pass", "pass", "pass", "pass"]);
  assert.deepEqual(afterScenes.assertions.map((item) => item.expression), ir.assertions.map((item) => item.expression));
});

test("domain assertion meaning participates in semantic and build identity", () => {
  const passing = compile(source(touchingScenes, '  assert timelineDurationIs(main, 2s), "duration";'));
  const failing = compile(source(touchingScenes, '  assert timelineDurationIs(main, 1s), "duration";'));
  assert.notEqual(passing.assertions[0]?.id, failing.assertions[0]?.id);
  assert.notEqual(passing.buildId, failing.buildId);
  assert.deepEqual(passing.assertions.map((item) => item.status), ["pass"]);
  assert.deepEqual(failing.assertions.map((item) => item.status), ["fail"]);
});

test("the strict public IR boundary enforces the aggregate assertion cap before evaluation", () => {
  const ir = compile(source(touchingScenes, '  assert timelineDurationIs(main, 2s), "duration";'));
  ir.assertions = Array.from({ length: 1_025 }, (_, index) => ({
    ...ir.assertions[0]!,
    id: index.toString(16).padStart(64, "0"),
  }));
  assert.throws(() => loadCutAvIr(JSON.stringify(ir)), (error: unknown) =>
    error instanceof CutAvIrValidationError
      && error.code === "CUT_IR_LIMIT"
      && error.path === "$.assertions");
});

test("source compilation reports the aggregate assertion cap at the first excess assertion", () => {
  const assertions = Array.from({ length: 1_025 }, (_, index) =>
    `  assert timelineDurationIs(main, 1s), "assertion ${index}";`).join("\n");
  const program = `cut 0.4;
project "assertion source cap";
timeline main(duration: 1s, fps: 24, width: 64px, height: 64px, sampleRate: 48khz) {
${assertions}
  scene only(duration: 1s) {}
}
export out = render(main);
`;
  assert.throws(() => compile(program), (error: unknown) => {
    assert.ok(error instanceof CutCompileError);
    const diagnostic = error.result.diagnostics.find((item) => item.code === "CUT_ASSERT_BUDGET");
    assert.ok(diagnostic);
    assert.match(diagnostic.message, /maxAssertions=1024/);
    assert.equal(diagnostic.span.start.line, 1_028);
    assert.ok(diagnostic.span.start.column > 0);
    return true;
  });
});

test("gap, overlap, exact duration, frame grid, and sample grid failures remain authored assertion results", () => {
  const gap = compile(source(`  scene first(duration: 1s) {}
  scene second(at: 1500ms, duration: 500ms) {}`));
  assert.deepEqual(gap.assertions.map((item) => item.status), ["pass", "fail", "pass", "pass"]);

  const overlap = compile(source(`  scene first(duration: 1500ms) {}
  scene second(at: 1s, duration: 1s) {}`));
  assert.deepEqual(overlap.assertions.map((item) => item.status), ["pass", "pass", "fail", "pass"]);

  const exact = compile(source(touchingScenes, `
  assert timelineDurationIs(main, 1999ms), "wrong duration";
  assert timeIsOnFrameGrid(main, 1ms), "off frame";
  assert timeIsOnSampleGrid(main, 0.1ms), "off sample";
`));
  assert.deepEqual(exact.assertions.map((item) => item.status), ["fail", "fail", "fail"]);
});

test("checker closes predicate argument names, counts, and semantic types", () => {
  const program = source(touchingScenes, `
  assert timelineDurationIs(main, 1), "wrong type";
  assert timelineHasNoSceneGaps(timeline: main, invented: true), "unknown";
  assert timeIsOnFrameGrid(main), "missing";
`);
  const checked = checkCutModule(moduleFor(program));
  assert.ok(checked.diagnostics.some((item) => item.code === "CUT2029" && /expects Time/.test(item.message)), JSON.stringify(checked.diagnostics));
  assert.ok(checked.diagnostics.some((item) => /invented/.test(item.message)), JSON.stringify(checked.diagnostics));
  assert.ok(checked.diagnostics.some((item) => /Missing required argument.*time/i.test(item.message)), JSON.stringify(checked.diagnostics));
});

test("final-IR predicates are source-located assertion-only operations", () => {
  const program = source(touchingScenes, `
  let durationOkay: Boolean = timelineDurationIs(main, 2s);
  if timelineHasNoSceneGaps(main) { }
  assert timeIsOnFrameGrid(main, 1s), "legal assertion use";
`);
  const checked = checkCutModule(moduleFor(program));
  const diagnostics = checked.diagnostics.filter((item) => item.code === "CUT_ASSERT_CONTEXT");
  assert.equal(diagnostics.length, 2, JSON.stringify(checked.diagnostics));
  assert.deepEqual(diagnostics.map((item) => item.span.start.line), [5, 6]);
  assert.ok(diagnostics.every((item) => item.span.start.column > 0));
  assert.throws(() => compile(program), CutCompileError);
});

test("reference release validation recomputes assertions and refuses stored-status tampering", () => {
  const passing = compile(source(touchingScenes));
  passing.determinism.semantic = "locked";
  assert.doesNotThrow(() => validateReferenceSession(passing));
  passing.assertions[0]!.status = "fail";
  assert.throws(() => validateReferenceSession(passing), (error: unknown) => {
    const diagnostic = cutDiagnosticsFromError(error)[0]!;
    assert.equal(diagnostic.code, "CUT_ASSERT_STATUS_MISMATCH");
    assert.deepEqual(diagnostic.source, { module: "project.cut", line: 5, column: 3 });
    return true;
  });

  const failing = compile(source(touchingScenes, '  assert timelineDurationIs(main, 1s), "must be two seconds";'));
  failing.determinism.semantic = "locked";
  assert.throws(() => validateReferenceSession(failing), (error: unknown) => {
    const diagnostic = cutDiagnosticsFromError(error)[0]!;
    assert.equal(diagnostic.code, "CUT_ASSERT_FAILED");
    assert.match(diagnostic.message, /must be two seconds/);
    assert.equal(diagnostic.source?.module, "project.cut");
    return true;
  });
  failing.assertions[0]!.status = "pass";
  assert.throws(() => validateReferenceSession(failing), (error: unknown) => cutDiagnosticsFromError(error)[0]?.code === "CUT_ASSERT_STATUS_MISMATCH");
});

test("canonical cut test reports recomputed domain results and exits two for a failed predicate", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "cut-domain-assert-cli-"));
  const passing = resolve(directory, "passing.cut"), failing = resolve(directory, "failing.cut");
  await Promise.all([
    writeFile(passing, source(touchingScenes)),
    writeFile(failing, source(touchingScenes, '  assert timelineDurationIs(main, 1s), "wrong duration";')),
  ]);
  const run = (path: string) => spawnSync(process.execPath, [resolve("dist-cli/cli/cut.js"), "test", path, "--json"], { encoding: "utf8" });
  const pass = run(passing);
  assert.equal(pass.status, 0, pass.stderr);
  assert.deepEqual(JSON.parse(pass.stdout).summary, { deferred: 0, fail: 0, pass: 4, total: 4 });
  const fail = run(failing);
  assert.equal(fail.status, 2, fail.stderr);
  assert.deepEqual(JSON.parse(fail.stdout).summary, { deferred: 0, fail: 1, pass: 0, total: 1 });
});
