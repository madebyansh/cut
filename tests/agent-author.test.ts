import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cutAgentCodexArgs, cutAgentDisabledCodexFeatures, runCutAgent, validateCutAgentCandidate, type CutAgentModelRunner } from "../lib/agent/author";
import { compileCutModule } from "../lib/language/compiler";
import { parseCutLanguage } from "../lib/language/parser";
import { validateReferenceStaticVisualGraphs } from "../lib/runtime/reference/static-visual-validation";

const invalidNarration = `cut 0.4;
project "Held Out Repair";
import { Narration } from "@cut/documentary";
asset voice: AudioAsset = audio("media/voice.wav");
timeline main(duration: 1s, fps: 24, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Narration(source: voice, transcript: "spoken words", range: 0s ..< 1s);
  }
}
export release = render(main);
`;

const validNarration = invalidNarration.replace(', transcript: "spoken words"', "");

const invalidComponentLocalSpace = `cut 0.4;
project "Invalid agent surface";
import { LocalSpace, Rect } from "cut:visual";
component InvalidSurface() -> Visual {
  LocalSpace(width: 64px, height: 36px, origin: { x: 32px, y: 18px }) {
    Rect(width: 64px, height: 36px, x: 32px, y: 18px, fill: #071019);
  }
  Rect(width: 1px, height: 1px, fill: #ffffff);
}
timeline main(duration: 1s, fps: 24, width: 64px, height: 36px, sampleRate: 48khz) {
  scene only(duration: 1s) { InvalidSurface(); }
}
export release = render(main, width: 64px, height: 36px, codec: "h264");
`;

const unformattedValidComponentLocalSpace = 'cut 0.4;project "Formatted component surface";import{LocalSpace,Rect}from"cut:visual";component Tile()->Visual{LocalSpace(width:6px,height:4px,origin:{x:1.25px,y:0.75px}){Rect(width:2px,height:2px,x:0px,y:0px,fill:#ef233c);}}timeline main(duration:1s,fps:4,width:20px,height:16px,sampleRate:8khz){scene only(duration:1s){Tile() as plate;set plate.x=2px;set plate.y=-1px;set plate.scale=1.5;set plate.rotation=90deg;set plate.opacity=50%;}}export release=render(main,width:20px,height:16px,codec:"h264");';

test("Codex authoring argv disables tool surfaces before a read-only ephemeral exec", () => {
  const args = cutAgentCodexArgs("gpt-5.6-luna", "/tmp/candidate.cut");
  for (const feature of cutAgentDisabledCodexFeatures) {
    const index = args.findIndex((value, candidate) => value === "--disable" && args[candidate + 1] === feature);
    assert.ok(index >= 0, feature);
    assert.ok(index < args.indexOf("exec"), `${feature} must be a global pre-exec feature override`);
  }
  assert.deepEqual(args.slice(args.indexOf("--strict-config"), args.indexOf("exec") + 1), ["--strict-config", "--ask-for-approval", "never", "exec"]);
  assert.ok(args.includes("--ephemeral"));
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(args.includes("--ignore-rules"));
  assert.deepEqual(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2), ["--sandbox", "read-only"]);
  assert.equal(args.at(-1), "-");
});

async function publicFixture(root: string) {
  await mkdir(join(root, "docs"), { recursive: true });
  await Promise.all([
    writeFile(join(root, "docs", "AGENT_GUIDE.md"), "# Public agent guide\nNarration has source and range; author spoken words in captions.\n"),
    writeFile(join(root, "docs", "CLI.md"), "# Public CLI\nUse cut check, fmt, lock, test, preview, and render.\n"),
  ]);
}

test("agent repair retains exact compiler diagnostics and publishes only the valid formatted source", async () => {
  const root = await mkdtemp(join(tmpdir(), "cut-agent-test-"));
  try {
    await publicFixture(root);
    const brief = join(root, "brief.txt"), input = join(root, "broken.cut"), output = join(root, "repaired.cut"), trace = join(root, "trace");
    await Promise.all([
      writeFile(brief, "Repair the source without losing authored spoken-word semantics."),
      writeFile(input, invalidNarration),
    ]);
    const prompts: string[] = [], candidates = [invalidNarration, validNarration];
    const runner: CutAgentModelRunner = async ({ prompt }) => {
      prompts.push(prompt);
      return {
        source: candidates[prompts.length - 1]!,
        events: `${JSON.stringify({ type: "thread.started" })}\n${JSON.stringify({ type: "item.completed", item: { type: "agent_message" } })}\n`,
      };
    };
    const report = await runCutAgent({
      mode: "repair",
      briefPath: brief,
      sourcePath: input,
      outputPath: output,
      provider: "chatgpt",
      model: "gpt-5.6-luna",
      maximumAttempts: 2,
      publicRoot: root,
      machineReference: '{"format":"cut-cli-reference"}',
      traceDirectory: trace,
    }, runner);
    assert.equal(report.status, "pass");
    assert.equal(report.provider.transport, "injected-test-runner");
    assert.deepEqual(report.attempts.map((attempt) => attempt.status), ["invalid", "valid"]);
    const refusal = report.attempts[0].diagnostics.find((item) => item.code === "CUT2059");
    assert.ok(refusal);
    assert.equal(refusal.source?.line, 7);
    assert.match(refusal.hint ?? "", /Captions|Marker|Region/);
    assert.match(prompts[0], /CURRENT SOURCE COMPILER DIAGNOSTICS/);
    assert.match(prompts[0], /CUT2059/);
    assert.match(prompts[1], /CUT2059/);
    assert.match(prompts[1], /"line":7/);
    assert.equal(validateCutAgentCandidate(await readFile(output, "utf8")).status, "valid");
    assert.doesNotMatch(await readFile(output, "utf8"), /transcript:/);
    assert.equal(JSON.parse(await readFile(join(trace, "report.json"), "utf8")).status, "pass");
    if (process.platform !== "win32") {
      assert.equal((await stat(trace)).mode & 0o777, 0o700);
      assert.equal((await stat(join(trace, "context"))).mode & 0o777, 0o700);
      assert.equal((await stat(join(trace, "attempt-01"))).mode & 0o777, 0o700);
      assert.equal((await stat(join(trace, "attempt-01", "response.cut"))).mode & 0o777, 0o600);
    }
    assert.equal(await readFile(join(trace, "attempt-01", "response.cut"), "utf8"), invalidNarration);
    assert.match(await readFile(join(trace, "attempt-02", "prompt.txt"), "utf8"), /EXACT CUT COMPILER DIAGNOSTICS/);
    await assert.rejects(() => runCutAgent({
      mode: "repair", briefPath: brief, sourcePath: input, outputPath: output, provider: "chatgpt", model: "gpt-5.6-luna",
      publicRoot: root, machineReference: "{}",
    }, runner), (error: unknown) => (error as { code?: string }).code === "CUT_AGENT_NO_CLOBBER");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent author rejects an audited Codex tool event and creates no source", async () => {
  const root = await mkdtemp(join(tmpdir(), "cut-agent-tool-test-"));
  try {
    await publicFixture(root);
    const brief = join(root, "brief.txt"), output = join(root, "main.cut"), trace = join(root, "trace");
    await writeFile(brief, "Create a one-second geometric signal card.");
    const runner: CutAgentModelRunner = async () => ({
      source: validNarration,
      events: `${JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "find /" } })}\n`,
    });
    const report = await runCutAgent({
      mode: "author", briefPath: brief, outputPath: output, provider: "chatgpt", model: "gpt-5.6-luna",
      publicRoot: root, machineReference: "{}", traceDirectory: trace,
    }, runner);
    assert.equal(report.status, "fail");
    assert.equal(report.attempts[0].status, "provider-failed");
    assert.equal(report.attempts[0].diagnostics[0].code, "CUT_AGENT_TOOL_USE");
    assert.match(await readFile(join(trace, "attempt-01", "events.jsonl"), "utf8"), /command_execution/);
    await assert.rejects(() => readFile(output), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent candidate and publisher reject lowered static visual errors without writing an invalid source", async () => {
  const direct = validateCutAgentCandidate(invalidComponentLocalSpace);
  assert.equal(direct.status, "invalid");
  const directFailure = direct.diagnostics.find((item) => item.code === "CUT_LOCAL_SPACE_UNSUPPORTED");
  assert.ok((directFailure?.source?.line ?? 0) > 0 && (directFailure?.source?.column ?? 0) > 0, JSON.stringify(directFailure));

  const root = await mkdtemp(join(tmpdir(), "cut-agent-static-visual-"));
  try {
    await publicFixture(root);
    const brief = join(root, "brief.txt"), output = join(root, "main.cut");
    await writeFile(brief, "Create a reusable retained visual surface.");
    const runner: CutAgentModelRunner = async () => ({ source: invalidComponentLocalSpace });
    const report = await runCutAgent({
      mode: "author",
      briefPath: brief,
      outputPath: output,
      provider: "chatgpt",
      model: "gpt-5.6-luna",
      maximumAttempts: 1,
      publicRoot: root,
      machineReference: "{}",
    }, runner);
    assert.equal(report.status, "fail");
    assert.equal(report.attempts[0]?.status, "invalid");
    assert.deepEqual(
      report.attempts[0]?.diagnostics.find((item) => item.code === "CUT_LOCAL_SPACE_UNSUPPORTED")?.source,
      directFailure?.source,
    );
    await assert.rejects(() => readFile(output), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent validation returns formatted unary component source that independently lowers through static visual validation", () => {
  const validation = validateCutAgentCandidate(unformattedValidComponentLocalSpace);
  assert.equal(validation.status, "valid", JSON.stringify(validation.diagnostics));
  assert.notEqual(validation.source, unformattedValidComponentLocalSpace);
  assert.match(validation.source, /component Tile\(\) -> Visual \{\n  LocalSpace/);

  const reparsed = parseCutLanguage(validation.source);
  assert.ok(reparsed.module, JSON.stringify(reparsed.diagnostics));
  assert.deepEqual(reparsed.diagnostics.filter((item) => item.severity === "error"), []);
  const recompiled = compileCutModule(reparsed.module);
  assert.deepEqual(recompiled.check.diagnostics.filter((item) => item.severity === "error"), []);
  assert.deepEqual(validateReferenceStaticVisualGraphs(recompiled.ir), []);
  const fragment = Object.values(recompiled.ir.nodes).find((node) => node.op === "cut.kernel.fragment");
  const local = Object.values(recompiled.ir.nodes).find((node) => node.op === "cut.visual.local_space");
  assert.ok(fragment && local);
  assert.deepEqual(fragment.children, [local.id]);
  assert.notEqual(recompiled.ir.compositions[0]?.width, 6, "the delivery canvas must remain distinct from the retained tile width");
  assert.deepEqual({ width: recompiled.ir.compositions[0]?.width, height: recompiled.ir.compositions[0]?.height }, { width: 20, height: 16 });
});
