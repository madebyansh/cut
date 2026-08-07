import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { parseCutLanguage } from "../lib/language/parser";
import { loadCutTranscriptCompileInputs } from "../lib/language/transcript-compile-inputs";
import { defaultTranscriptLimits } from "../lib/interchange/transcript";

function transcript() {
  return JSON.stringify({
    format: "cut-transcript",
    version: 1,
    media: {
      sha256: "a".repeat(64),
      audioStreamIndex: 0,
      audioSampleRate: 48_000,
      duration: { numerator: "1", denominator: "1" },
    },
    words: [{
      id: "w1",
      start: { numerator: "0", denominator: "1" },
      end: { numerator: "1", denominator: "1" },
      text: "Proof.",
      join: "none",
    }],
  });
}

function program(transcriptExpression = "words", duplicate = false) {
  return `cut 0.4;
project "transcript input loader";
import { transcriptEdit } from "@cut/edit";
asset words: DataAsset = data("assets/words.json");
asset unused: DataAsset = data("assets/does-not-exist.json");
asset voice: AudioAsset = audio("assets/voice.wav", stream: 0);
${transcriptExpression === "alias" ? "const alias: DataAsset = words;" : ""}
timeline main(duration: 2s, fps: 24, sampleRate: 48khz) {
  scene answer(duration: 2s) {
    let first: TranscriptEdit = transcriptEdit(transcript: ${transcriptExpression}, source: voice, from: "w1", through: "w1", at: 0s);
    ${duplicate ? 'let second: TranscriptEdit = transcriptEdit(transcript: words, source: voice, from: "w1", through: "w1", at: 1s);' : ""}
  }
}
export out = render(main);
`;
}

function parsed(source: string) {
  const result = parseCutLanguage(source);
  assert.ok(result.module, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.diagnostics, []);
  const check = checkCutModule(result.module);
  assert.deepEqual(check.diagnostics.filter((item) => item.severity === "error"), []);
  return { module: result.module, check };
}

async function fixture(t: TestContext, source = program()) {
  const root = await mkdtemp(resolve(tmpdir(), "cut-transcript-inputs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, "assets"), { recursive: true });
  await writeFile(resolve(root, "main.cut"), source);
  return { root, entry: resolve(root, "main.cut"), ...parsed(source) };
}

test("loader reads only directly referenced transcript DataAssets and caches repeated use", async (t) => {
  const project = await fixture(t, program("words", true));
  await writeFile(resolve(project.root, "assets/words.json"), transcript());
  const result = await loadCutTranscriptCompileInputs(project.entry, project.module, project.check);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.inputs.transcriptSidecars?.size, 1);
  const bytes = result.inputs.transcriptSidecars?.get("words");
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(bytes), transcript());
  assert.equal(result.inputs.transcriptSidecars?.has("unused"), false);

  const compiled = compileCutModule(project.module, {}, undefined, undefined, result.inputs).ir as CutAVIR & { transcriptBindings?: unknown[] };
  assert.equal(compiled.transcriptBindings?.length, 2);
});

test("a bounded top-level DataAsset alias resolves to the same securely read transcript resource", async (t) => {
  const project = await fixture(t, program("alias"));
  await writeFile(resolve(project.root, "assets/words.json"), transcript());
  const result = await loadCutTranscriptCompileInputs(project.entry, project.module, project.check);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.inputs.transcriptSidecars?.size, 1);
  const aliasedBytes = result.inputs.transcriptSidecars?.get("words");
  assert.ok(aliasedBytes instanceof Uint8Array);
  assert.equal(
    new TextDecoder().decode(aliasedBytes),
    transcript(),
  );
  const compiled = compileCutModule(
    project.module,
    {},
    undefined,
    undefined,
    result.inputs,
  ).ir as CutAVIR & { transcriptBindings?: unknown[] };
  assert.equal(compiled.transcriptBindings?.length, 1);
});

test("size is rejected before parsing and secure project resolution refuses a symlink escape", async (t) => {
  const oversized = await fixture(t);
  const oversizedPath = resolve(oversized.root, "assets/words.json");
  await writeFile(oversizedPath, "");
  await truncate(oversizedPath, defaultTranscriptLimits.maxBytes + 1);
  const sizeResult = await loadCutTranscriptCompileInputs(oversized.entry, oversized.module, oversized.check);
  assert.equal(sizeResult.inputs.transcriptSidecars, undefined);
  assert.equal(sizeResult.diagnostics[0]?.code, "CUT_TRANSCRIPT_LIMIT");
  assert.ok(sizeResult.diagnostics[0]!.span.start.offset < sizeResult.diagnostics[0]!.span.end.offset);

  const escaped = await fixture(t);
  const outside = resolve(tmpdir(), `cut-transcript-outside-${process.pid}-${Date.now()}.json`);
  await writeFile(outside, transcript());
  t.after(() => rm(outside, { force: true }));
  await symlink(outside, resolve(escaped.root, "assets/words.json"));
  const boundaryResult = await loadCutTranscriptCompileInputs(escaped.entry, escaped.module, escaped.check);
  assert.equal(boundaryResult.inputs.transcriptSidecars, undefined);
  assert.equal(boundaryResult.diagnostics[0]?.code, "CUT_TRANSCRIPT_RESOURCE");
  assert.match(boundaryResult.diagnostics[0]?.message ?? "", /securely load|outside|symbolic/i);
});

test("descriptor-bound reader rejects a same-size locator swap after path inspection", async (t) => {
  const project = await fixture(t);
  const path = resolve(project.root, "assets/words.json");
  const original = transcript();
  const replacement = original.replace("Proof.", "Forge.");
  assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(original));
  await writeFile(path, original);

  let swapped = false;
  const result = await loadCutTranscriptCompileInputs(
    project.entry,
    project.module,
    project.check,
    {
      __testAfterPathSnapshot: async () => {
        swapped = true;
        await rename(path, `${path}.before-swap`);
        await writeFile(path, replacement);
      },
    },
  );
  assert.equal(swapped, true);
  assert.equal(result.inputs.transcriptSidecars, undefined);
  assert.equal(result.diagnostics[0]?.code, "CUT_TRANSCRIPT_RESOURCE");
  assert.match(result.diagnostics[0]?.message ?? "", /changed identity or size before its bounded read/i);
  assert.ok(result.diagnostics[0]!.span.start.offset < result.diagnostics[0]!.span.end.offset);
});

test("descriptor-bound reader refuses a symlink introduced after secure resolution", async (t) => {
  const project = await fixture(t);
  const path = resolve(project.root, "assets/words.json");
  const outside = resolve(tmpdir(), `cut-transcript-raced-symlink-${process.pid}-${Date.now()}.json`);
  await writeFile(path, transcript());
  await writeFile(outside, transcript());
  t.after(() => rm(outside, { force: true }));

  const result = await loadCutTranscriptCompileInputs(
    project.entry,
    project.module,
    project.check,
    {
      __testAfterPathSnapshot: async () => {
        await rename(path, `${path}.before-symlink`);
        await symlink(outside, path);
      },
    },
  );
  assert.equal(result.inputs.transcriptSidecars, undefined);
  assert.equal(result.diagnostics[0]?.code, "CUT_TRANSCRIPT_RESOURCE");
  assert.match(result.diagnostics[0]?.message ?? "", /no-follow file descriptor/i);
});

test("descriptor-bound reader detects post-open growth with a one-byte overflow probe", async (t) => {
  const project = await fixture(t);
  const path = resolve(project.root, "assets/words.json");
  await writeFile(path, transcript());

  const result = await loadCutTranscriptCompileInputs(
    project.entry,
    project.module,
    project.check,
    {
      __testAfterDescriptorSnapshot: async () => {
        await truncate(path, defaultTranscriptLimits.maxBytes + 1);
      },
    },
  );
  assert.equal(result.inputs.transcriptSidecars, undefined);
  assert.equal(result.diagnostics[0]?.code, "CUT_TRANSCRIPT_RESOURCE");
  assert.match(result.diagnostics[0]?.message ?? "", /grew during its bounded read/i);
});

test("descriptor-bound reader rejects a same-size locator replacement after reading", async (t) => {
  const project = await fixture(t);
  const path = resolve(project.root, "assets/words.json");
  const original = transcript();
  const replacement = original.replace("Proof.", "Forge.");
  await writeFile(path, original);

  const result = await loadCutTranscriptCompileInputs(
    project.entry,
    project.module,
    project.check,
    {
      __testAfterBoundedRead: async () => {
        await rename(path, `${path}.after-read`);
        await writeFile(path, replacement);
      },
    },
  );
  assert.equal(result.inputs.transcriptSidecars, undefined);
  assert.equal(result.diagnostics[0]?.code, "CUT_TRANSCRIPT_RESOURCE");
  assert.match(result.diagnostics[0]?.message ?? "", /changed identity during its bounded read/i);
});
