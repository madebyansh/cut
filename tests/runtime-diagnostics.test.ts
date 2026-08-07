import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileCutModule } from "../lib/language/compiler";
import { CutLockError } from "../lib/language/lock";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { parseCutLanguage } from "../lib/language/parser";
import { cutDiagnosticsFromError } from "../lib/runtime/diagnostics";
import { assertCutGraphExecutionBudget, createIncrementalRenderPlan, cutGraphLimits, CutGraphError, finalizeGraphHashes } from "../lib/runtime/graph";
import { ReferenceAudioAutomationError } from "../lib/runtime/reference/audio-automation";
import { ReferenceAudioConfigError } from "../lib/runtime/reference/audio-config";

const cli = resolve("dist-cli/cli/cut.js");

function compileFixture() {
  const parsed = parseCutLanguage(`cut 0.4;
project "runtime diagnostics";
import { Gain, Tone } from "@cut/audio";
timeline main(duration: 1s, fps: 24, width: 16px, height: 16px, sampleRate: 48khz) {
  Gain(amount: -6db) {
    Tone(frequency: 440hz, duration: 1s);
  }
}
export out = render(main);`);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

function node(ir: CutAVIR, op: string) {
  const result = Object.values(ir.nodes).find((candidate) => candidate.op === op);
  assert.ok(result, `expected ${op}`);
  return result;
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

test("node-reference cycles and missing audio edges have stable source-located graph diagnostics", () => {
  const cyclic = clone(compileFixture()), gain = node(cyclic, "cut.audio.gain"), tone = node(cyclic, "cut.audio.tone");
  tone.children = [gain.id];
  assert.throws(() => finalizeGraphHashes(cyclic), (error: unknown) => {
    assert.ok(error instanceof CutGraphError);
    assert.equal(error.code, "CUT_AUDIO_GRAPH");
    assert.ok("module" in error.source);
    assert.equal(error.source.module, "project.cut");
    assert.ok(error.source.line > 0 && error.source.column > 0);
    assert.match(error.message, new RegExp(`${gain.id}|${tone.id}`));
    return true;
  });

  const missing = clone(compileFixture()), missingGain = node(missing, "cut.audio.gain");
  missingGain.children = ["missing-audio-node"];
  assert.throws(() => finalizeGraphHashes(missing), (error: unknown) =>
    error instanceof CutGraphError
      && error.code === "CUT_AUDIO_GRAPH"
      && error.nodeId === missingGain.id
      && "module" in error.source
      && error.source.module === "project.cut");
});

test("shared graph layer budgets recursive DAG expansion before backend command construction", () => {
  const ir = clone(compileFixture()), gain = node(ir, "cut.audio.gain"), tone = node(ir, "cut.audio.tone");
  gain.children = Array.from({ length: 8 }, () => tone.id);
  assert.throws(
    () => assertCutGraphExecutionBudget(ir, [gain.id], { maxExpansionVisits: 5 }),
    (error: unknown) => error instanceof CutGraphError
      && error.code === "CUT_GRAPH_BUDGET"
      && error.nodeId === gain.id
      && "module" in error.source
      && error.source.module === "project.cut"
      && /maxExpansionVisits=5/.test(error.message),
  );
  assert.deepEqual(
    assertCutGraphExecutionBudget(ir, [gain.id], { maxExpansionVisits: 9 }),
    { reachableNodes: 2, referenceEdges: 8, expansionVisits: 9 },
  );

  const depthIr = clone(compileFixture()), depthGain = node(depthIr, "cut.audio.gain"), depthTone = node(depthIr, "cut.audio.tone");
  depthIr.nodes.wrapper = { ...clone(depthGain), id: "wrapper", children: [depthGain.id] };
  assert.throws(
    () => assertCutGraphExecutionBudget(depthIr, [depthTone.id, "wrapper"], { maxDepth: 2 }),
    (error: unknown) => error instanceof CutGraphError && error.code === "CUT_GRAPH_BUDGET" && /maxDepth=2/.test(error.message),
  );

  const integrated = clone(compileFixture()), integratedGain = node(integrated, "cut.audio.gain"), integratedTone = node(integrated, "cut.audio.tone");
  integratedGain.children = Array.from({ length: cutGraphLimits.maxExpansionVisits }, () => integratedTone.id);
  assert.throws(
    () => createIncrementalRenderPlan(integrated, "main"),
    (error: unknown) => error instanceof CutGraphError && error.code === "CUT_GRAPH_BUDGET" && /maxExpansionVisits/.test(error.message),
  );
});

test("runtime error normalization preserves stable codes and structured source evidence", () => {
  const audio = cutDiagnosticsFromError(new ReferenceAudioConfigError(
    "CUT_AUDIO_VALUE_RANGE",
    "node-gain",
    "cut.audio.gain at project.cut:7:9 requires amount between -192 and 60.",
  ));
  assert.deepEqual(audio, [{
    code: "CUT_AUDIO_VALUE_RANGE",
    severity: "error",
    message: "cut.audio.gain at project.cut:7:9 requires amount between -192 and 60.",
    source: { module: "project.cut", line: 7, column: 9, nodeId: "node-gain" },
  }]);

  const lock = cutDiagnosticsFromError(new CutLockError("CUT_LOCK_INTEGRITY", "$.resources.voice", "locked bytes changed"));
  assert.deepEqual(lock, [{ code: "CUT_LOCK_INTEGRITY", severity: "error", message: "locked bytes changed", source: { path: "$.resources.voice" } }]);

  const ir = compileFixture(), tone = node(ir, "cut.audio.tone") as IRNode;
  const graph = cutDiagnosticsFromError(new CutGraphError("CUT_AUDIO_GRAPH", tone.id, tone, "cycle"));
  assert.equal(graph[0].code, "CUT_AUDIO_GRAPH");
  assert.deepEqual(graph[0].source, { module: "project.cut", line: tone.provenance.span.start.line, column: tone.provenance.span.start.column, nodeId: tone.id });

  const automation = cutDiagnosticsFromError(new ReferenceAudioAutomationError("CUT_AUDIO_AUTOMATION_TYPE", tone.id, tone, "automation mismatch"));
  assert.deepEqual(automation, [{
    code: "CUT_AUDIO_AUTOMATION_TYPE",
    severity: "error",
    message: "automation mismatch",
    source: { module: "project.cut", line: tone.provenance.span.start.line, column: tone.provenance.span.start.column, nodeId: tone.id },
  }]);
});

async function run(args: string[], cwd: string, expectedCode: number) {
  return new Promise<{ stdout: string; stderr: string }>((accept, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (code === expectedCode) accept(result);
      else reject(new Error(`cut ${args.join(" ")} exited ${code ?? signal}, expected ${expectedCode}\n${result.stderr}${result.stdout}`));
    });
  });
}

test("render --json returns one stable diagnostic envelope for a source-located runtime refusal", { timeout: 30_000 }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cut-runtime-diagnostics-"));
  const source = `cut 0.4;
project "runtime JSON";
import { Gain, Tone } from "@cut/audio";
timeline main(duration: 1s, fps: 24, width: 16px, height: 16px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Gain(amount: 100db) { Tone(frequency: 440hz, duration: 1s); }
  }
}
export out = render(main);`;
  try {
    await writeFile(join(workspace, "main.cut"), source);
    await run(["lock", "main.cut", "--out", "cut.lock"], workspace, 0);
    const failed = await run(["render", "main.cut", "--lock", "cut.lock", "--out", "out.mp4", "--json"], workspace, 1);
    assert.equal(failed.stderr, "");
    const report = JSON.parse(failed.stdout) as {
      format: string;
      version: number;
      command: string;
      status: string;
      diagnostics: Array<{ code: string; severity: string; message: string; source?: { module?: string; line?: number; column?: number; nodeId?: string } }>;
    };
    assert.deepEqual({ format: report.format, version: report.version, command: report.command, status: report.status }, { format: "cut-cli-diagnostics", version: 1, command: "render", status: "fail" });
    assert.equal(report.diagnostics.length, 1);
    assert.equal(report.diagnostics[0].code, "CUT_AUDIO_VALUE_RANGE");
    assert.equal(report.diagnostics[0].severity, "error");
    assert.equal(report.diagnostics[0].source?.module, "project.cut");
    assert.ok((report.diagnostics[0].source?.line ?? 0) > 0 && (report.diagnostics[0].source?.column ?? 0) > 0);
    assert.ok(report.diagnostics[0].source?.nodeId);
    assert.doesNotMatch(report.diagnostics[0].message, /^CUT_AUDIO_VALUE_RANGE:/);
    await assert.rejects(readFile(join(workspace, "out.mp4")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("render --json preserves stable source evidence from audio automation preflight", { timeout: 30_000 }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cut-audio-automation-diagnostics-"));
  const source = `cut 0.4;
project "automation runtime diagnostic";
import { Gain, Tone } from "@cut/audio";
import { spring } from "@cut/motion";
timeline main(duration: 1s, fps: 24, width: 16px, height: 16px, sampleRate: 48khz) {
  Gain(amount: -12db) as fader { Tone(frequency: 440hz, duration: 1s); }
  animate fader.amount from -12db to 0db over 1s ease spring();
}
export out = render(main);`;
  try {
    await writeFile(join(workspace, "main.cut"), source);
    await run(["lock", "main.cut", "--out", "cut.lock"], workspace, 0);
    const failed = await run(["render", "main.cut", "--lock", "cut.lock", "--out", "out.mp4", "--json"], workspace, 1);
    assert.equal(failed.stderr, "");
    const report = JSON.parse(failed.stdout) as {
      diagnostics: Array<{ code: string; message: string; source?: { module?: string; line?: number; column?: number; nodeId?: string } }>;
    };
    assert.equal(report.diagnostics.length, 1);
    assert.equal(report.diagnostics[0].code, "CUT_AUDIO_AUTOMATION_EASING");
    assert.equal(report.diagnostics[0].source?.module, "project.cut");
    assert.ok((report.diagnostics[0].source?.line ?? 0) > 0 && (report.diagnostics[0].source?.column ?? 0) > 0);
    assert.ok(report.diagnostics[0].source?.nodeId);
    assert.doesNotMatch(report.diagnostics[0].message, /^CUT_AUDIO_AUTOMATION_EASING:/);
    await assert.rejects(readFile(join(workspace, "out.mp4")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("stale audiovisual locks retain CUT_LOCK_SOURCE_MISMATCH through CLI JSON", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cut-stale-lock-diagnostic-"));
  const source = `cut 0.4;
project "stale lock diagnostic";
import { Rect } from "cut:visual";
timeline main(duration: 1s, fps: 24, width: 16px, height: 16px) {
  scene only(duration: 1s) { Rect(width: 16px, height: 16px, fill: #2f5f91); }
}
export out = render(main);
`;
  try {
    await writeFile(join(workspace, "main.cut"), source);
    await run(["lock", "main.cut", "--out", "cut.lock"], workspace, 0);
    await writeFile(join(workspace, "main.cut"), `${source}// source identity changed after lock\n`);
    const failed = JSON.parse((await run(["test", "main.cut", "--lock", "cut.lock", "--json"], workspace, 1)).stdout) as {
      format: string;
      command: string;
      status: string;
      diagnostics: Array<{ code: string; message: string; source?: { path?: string } }>;
    };
    assert.deepEqual({ format: failed.format, command: failed.command, status: failed.status }, {
      format: "cut-cli-diagnostics",
      command: "test",
      status: "fail",
    });
    assert.deepEqual(failed.diagnostics.map((item) => item.code), ["CUT_LOCK_SOURCE_MISMATCH"]);
    assert.equal(failed.diagnostics[0]?.source?.path, "$.sourceHash");
    assert.doesNotMatch(failed.diagnostics[0]?.message ?? "", /^CUT_LOCK_SOURCE_MISMATCH:/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
