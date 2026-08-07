import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv from "ajv";
import { hash } from "../lib/core/stable";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRTranscriptBindingV1 } from "../lib/language/ir";
import {
  CutAvIrValidationError,
  loadCutAvIr,
  validateCutAvIr,
} from "../lib/language/ir-loader";
import { parseCutLanguage } from "../lib/language/parser";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { rational } from "../lib/language/rational";
import { cutTranscriptExecutableLimits } from "../lib/language/transcript-contract";
import { cutIrIdentity, finalizeGraphHashes } from "../lib/runtime/graph";
import { inspectCutIr } from "../lib/runtime/inspect";

const q = (numerator: number | bigint | string, denominator: number | bigint | string = 1) =>
  rational(numerator, denominator);

const source = `cut 0.4;
project "Transcript IR ledger proof";
asset transcriptData: DataAsset = data("assets/interview.transcript.json");
asset voice: AudioAsset = audio("assets/interview.wav");
timeline main(duration: 2s, fps: 24, width: 320px, height: 180px, sampleRate: 48khz) {
  scene answer(duration: 2s) {}
}
export out = render(main);`;

type Fixture = {
  ir: CutAVIR;
  binding: IRTranscriptBindingV1;
  originalBuildId: string;
};

function fixture(): Fixture {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const compiled = compileCutModule(parsed.module);
  assert.equal(
    compiled.check.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
    0,
    JSON.stringify(compiled.check.diagnostics),
  );
  const ir = compiled.ir;
  const originalBuildId = ir.buildId;
  const composition = ir.compositions[0];
  const scene = Object.values(ir.scenes)[0];
  const transcriptResource = Object.values(ir.resources).find((resource) => resource.kind === "data");
  const audioResource = Object.values(ir.resources).find((resource) => resource.kind === "audio");
  assert.ok(composition && scene && transcriptResource && audioResource);
  const words: IRTranscriptBindingV1["words"] = [
    { id: "w1", start: q(0), end: q(1, 48_000), text: "Hello", join: "none" },
    { id: "w2", start: q(1, 48_000), end: q(2, 48_000), text: ",", join: "none" },
    { id: "w3", start: q(2, 48_000), end: q(3, 48_000), text: "world", join: "space", speaker: "Alex" },
  ];
  const binding: IRTranscriptBindingV1 = {
    id: "transcript_binding_answer",
    version: 1,
    kind: "transcript-edit",
    compositionId: composition.id,
    sceneId: scene.id,
    transcriptResourceId: transcriptResource.id,
    audioResourceId: audioResource.id,
    from: "w1",
    through: "w3",
    selectedWordCount: words.length,
    selectedIdsSha256: hash(JSON.stringify(words.map((word) => word.id))),
    text: "Hello, world",
    words,
    sourceRange: { start: q(0), duration: q(3, 48_000) },
    destinationRange: { start: q(1, 10), duration: q(3, 48_000) },
    linkId: "answer-a",
    media: {
      sha256: "a".repeat(64),
      audioStreamIndex: 0,
      audioSampleRate: 48_000,
      duration: q(2),
      videoStreamIndex: 1,
      videoFrameRate: q(30_000, 1_001),
    },
    provenance: structuredClone(scene.provenance),
  };
  ir.transcriptBindings = [binding];
  finalizeGraphHashes(ir);
  return { ir, binding, originalBuildId };
}

function expectMutation(
  name: string,
  mutate: (value: Fixture) => void,
  code: CutAvIrValidationError["code"],
  path: RegExp,
) {
  const value = fixture();
  mutate(value);
  finalizeGraphHashes(value.ir);
  assert.throws(() => loadCutAvIr(JSON.stringify(value.ir)), (error: unknown) => {
    assert.ok(error instanceof CutAvIrValidationError, `${name}: ${String(error)}`);
    assert.equal(error.code, code, name);
    assert.match(error.path, path, name);
    return true;
  });
}

test("typed transcript ledger is schema-valid, identity-bearing, and canonically absent when unused", async () => {
  const { ir, binding, originalBuildId } = fixture();
  assert.equal(validateCutAvIr(ir).transcriptBindings?.[0]?.id, binding.id);
  assert.notEqual(ir.buildId, originalBuildId);

  const schema = JSON.parse(
    await readFile("schemas/cut-av-ir-v3.schema.json", "utf8"),
  ) as {
    $defs: {
      transcriptBinding: {
        properties: {
          selectedWordCount: { maximum: number };
          text: { maxLength: number };
          words: { maxItems: number };
        };
      };
    };
  };
  assert.equal(
    schema.$defs.transcriptBinding.properties.selectedWordCount.maximum,
    cutTranscriptExecutableLimits.maximumSelectedWords,
  );
  assert.equal(
    schema.$defs.transcriptBinding.properties.words.maxItems,
    cutTranscriptExecutableLimits.maximumSelectedWords,
  );
  assert.equal(
    schema.$defs.transcriptBinding.properties.text.maxLength,
    cutTranscriptExecutableLimits.maximumSelectedTextBytes,
  );
  const validate = new Ajv({
    schemaId: "auto",
    meta: false,
    validateSchema: false,
    allErrors: true,
    jsonPointers: true,
  }).compile(schema);
  assert.equal(validate(ir), true, JSON.stringify(validate.errors));

  const positiveDelta = structuredClone(ir);
  positiveDelta.transcriptBindings![0]!.media.videoDuration = q(2);
  positiveDelta.transcriptBindings![0]!.media.audioVideoPresentationDelta = q(1, 4);
  assert.equal(validate(positiveDelta), true, JSON.stringify(validate.errors));

  const negativeDelta = structuredClone(positiveDelta);
  negativeDelta.transcriptBindings![0]!.media.audioVideoPresentationDelta = q(-1, 4);
  assert.equal(validate(negativeDelta), true, JSON.stringify(validate.errors));

  const explicitZeroDelta = structuredClone(positiveDelta);
  explicitZeroDelta.transcriptBindings![0]!.media.audioVideoPresentationDelta = q(0);
  assert.equal(
    validate(explicitZeroDelta),
    false,
    "the public IR schema must reject explicit zero; omission is canonical zero",
  );
  assert.ok(
    validate.errors?.some((error) =>
      error.dataPath.startsWith(
        "/transcriptBindings/0/media/audioVideoPresentationDelta",
      )
      && error.schemaPath.includes("/nonZeroRational/")
    ),
    JSON.stringify(validate.errors),
  );

  const without = structuredClone(ir);
  delete without.transcriptBindings;
  finalizeGraphHashes(without);
  assert.equal(without.buildId, originalBuildId, "absence must preserve the compiler's pre-extension identity");
  assert.equal(cutIrIdentity(without), originalBuildId);

  const empty = structuredClone(ir);
  empty.transcriptBindings = [];
  finalizeGraphHashes(empty);
  assert.throws(
    () => validateCutAvIr(empty),
    (error: unknown) => error instanceof CutAvIrValidationError
      && error.code === "CUT_IR_IDENTITY"
      && error.path === "$.transcriptBindings",
  );

  const unknown = structuredClone(ir) as CutAVIR & { transcriptBindings: Array<IRTranscriptBindingV1 & { privateGraph?: boolean }> };
  unknown.transcriptBindings[0]!.privateGraph = true;
  assert.equal(validate(unknown), false, "the public schema must close transcript-binding fields");

  const schemaEmpty = structuredClone(ir);
  schemaEmpty.transcriptBindings = [];
  assert.equal(validate(schemaEmpty), false, "the public schema must require canonical absence instead of an empty ledger");

  const uppercaseHash = structuredClone(ir);
  uppercaseHash.transcriptBindings![0]!.media.sha256 = "A".repeat(64);
  assert.equal(validate(uppercaseHash), false, "the public schema must require lowercase digests");

  const negativeZero = structuredClone(ir);
  negativeZero.transcriptBindings![0]!.words[0]!.start.numerator = "-0";
  assert.equal(validate(negativeZero), false, "the public schema must reject non-canonical negative zero");

  const incompleteVideo = structuredClone(ir);
  delete incompleteVideo.transcriptBindings![0]!.media.videoFrameRate;
  assert.equal(validate(incompleteVideo), false, "the public schema must require complete optional video provenance");
});

test("strict loader rejects hostile transcript selections even after the artifact is re-signed", () => {
  expectMutation("count mismatch", ({ binding }) => {
    binding.selectedWordCount = 2;
  }, "CUT_IR_IDENTITY", /\.selectedWordCount$/u);

  expectMutation("duplicate selected ID", ({ binding }) => {
    binding.words[1]!.id = binding.words[0]!.id;
  }, "CUT_IR_IDENTITY", /\.words\[1\]\.id$/u);

  expectMutation("wrong first ID", ({ binding }) => {
    binding.from = "not-first";
  }, "CUT_IR_IDENTITY", /\.from$/u);

  expectMutation("overlapping words", ({ binding }) => {
    binding.words[1]!.start = q(0);
  }, "CUT_IR_TIMING", /\.words\[1\]\.start$/u);

  expectMutation("off sample grid", ({ binding }) => {
    binding.words[1]!.end = q(7, 100_000);
  }, "CUT_IR_TIMING", /\.words\[1\]\.end$/u);

  expectMutation("selected ID digest tamper", ({ binding }) => {
    binding.selectedIdsSha256 = "b".repeat(64);
  }, "CUT_IR_HASH", /\.selectedIdsSha256$/u);

  expectMutation("reconstructed text tamper", ({ binding }) => {
    binding.text = "Hello,world";
  }, "CUT_IR_IDENTITY", /\.text$/u);

  expectMutation("unsafe word Unicode scalar", ({ binding }) => {
    binding.words[0]!.text = "Hello\u202e";
    binding.text = "Hello\u202e, world";
  }, "CUT_IR_STRING", /\.words\[0\]\.text$/u);

  expectMutation("Unicode noncharacter word", ({ binding }) => {
    binding.words[0]!.text = "Hello\ufdd0";
    binding.text = "Hello\ufdd0, world";
  }, "CUT_IR_STRING", /\.words\[0\]\.text$/u);

  expectMutation("left-to-right mark in word", ({ binding }) => {
    binding.words[0]!.text = "Hello\u200e";
    binding.text = "Hello\u200e, world";
  }, "CUT_IR_STRING", /\.words\[0\]\.text$/u);

  expectMutation("unpaired surrogate speaker", ({ binding }) => {
    binding.words[2]!.speaker = "\ud800";
  }, "CUT_IR_STRING", /\.words\[2\]\.speaker$/u);

  expectMutation("source range tamper", ({ binding }) => {
    binding.sourceRange.start = q(1, 48_000);
  }, "CUT_IR_IDENTITY", /\.sourceRange$/u);

  expectMutation("unequal destination duration", ({ binding }) => {
    binding.destinationRange.duration = q(4, 48_000);
  }, "CUT_IR_TIMING", /\.destinationRange\.duration$/u);

  expectMutation("scene-local overflow", ({ binding }) => {
    binding.destinationRange.start = q(2);
  }, "CUT_IR_TIMING", /\.destinationRange$/u);

  expectMutation("wrong transcript resource kind", ({ ir, binding }) => {
    ir.resources[binding.transcriptResourceId]!.kind = "image";
  }, "CUT_IR_REFERENCE", /\.transcriptResourceId$/u);

  expectMutation("wrong audio resource kind", ({ ir, binding }) => {
    ir.resources[binding.audioResourceId]!.kind = "video";
  }, "CUT_IR_REFERENCE", /\.audioResourceId$/u);

  expectMutation("locked audio digest mismatch", ({ ir, binding }) => {
    const audio = ir.resources[binding.audioResourceId]!;
    audio.state = "locked";
    audio.sha256 = "c".repeat(64);
  }, "CUT_IR_HASH", /\.media\.sha256$/u);

  expectMutation("incomplete video provenance", ({ binding }) => {
    delete binding.media.videoFrameRate;
  }, "CUT_IR_MISSING_FIELD", /\.media\.videoFrameRate$/u);

  expectMutation("word outside media", ({ binding }) => {
    binding.media.duration = q(2, 48_000);
  }, "CUT_IR_TIMING", /\.words\[2\]\.end$/u);
});

test("provenance is non-semantic while text, IDs, timing, and ordering remain semantic", () => {
  const { ir } = fixture();
  const provenanceOnly = structuredClone(ir);
  provenanceOnly.transcriptBindings![0]!.provenance.symbol = "reformatted";
  finalizeGraphHashes(provenanceOnly);
  assert.equal(provenanceOnly.buildId, ir.buildId);
  assert.deepEqual(diffCutAVIR(ir, provenanceOnly).changes, []);

  const changed = structuredClone(ir);
  changed.transcriptBindings![0]!.words[0]!.text = "Hi";
  changed.transcriptBindings![0]!.text = "Hi, world";
  finalizeGraphHashes(changed);
  assert.notEqual(changed.buildId, ir.buildId);
  const diff = diffCutAVIR(ir, changed);
  const bindingChange = diff.changes.find((change) => change.entity === "transcript-binding");
  assert.ok(bindingChange && bindingChange.operation === "modify");
  assert.deepEqual(bindingChange.fields.map((field) => field.path), ["/text", "/words/0/text"]);
  assert.deepEqual(diff.summary.byEntity["transcript-binding"], { add: 0, remove: 0, modify: 1 });

  const reordered = structuredClone(ir);
  reordered.transcriptBindings![0]!.words.reverse();
  reordered.transcriptBindings![0]!.from = "w3";
  reordered.transcriptBindings![0]!.through = "w1";
  reordered.transcriptBindings![0]!.selectedIdsSha256 = hash(JSON.stringify(["w3", "w2", "w1"]));
  finalizeGraphHashes(reordered);
  assert.throws(
    () => validateCutAvIr(reordered),
    (error: unknown) => error instanceof CutAvIrValidationError
      && error.code === "CUT_IR_TIMING"
      && /\.words\[1\]\.start$/u.test(error.path),
  );
});

test("inspect exposes transcript-binding summary, composition ownership, and full deterministic details", () => {
  const { ir, binding } = fixture();
  const report = inspectCutIr(ir, "transcript-proof.cut");
  assert.equal(report.summary.transcriptBindings, 1);
  assert.deepEqual(report.compositions[0]?.transcriptBindings, [binding.id]);
  assert.deepEqual(report.transcriptBindings, [{
    id: binding.id,
    version: 1,
    kind: "transcript-edit",
    compositionId: binding.compositionId,
    sceneId: binding.sceneId,
    transcriptResourceId: binding.transcriptResourceId,
    audioResourceId: binding.audioResourceId,
    from: "w1",
    through: "w3",
    selectedWordCount: 3,
    selectedIdsSha256: binding.selectedIdsSha256,
    text: "Hello, world",
    words: binding.words,
    sourceRange: binding.sourceRange,
    destinationRange: binding.destinationRange,
    linkId: "answer-a",
    media: binding.media,
    source: {
      module: binding.provenance.module,
      line: binding.provenance.span.start.line,
      column: binding.provenance.span.start.column,
    },
  }]);
});
