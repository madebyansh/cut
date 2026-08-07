import assert from "node:assert/strict";
import test from "node:test";
import { stableJsonStringify } from "../lib/core/stable";
import { compileCutModule, type CutCompileInputs } from "../lib/language/compiler";
import {
  CutAvIrValidationError,
  loadCutAvIr,
} from "../lib/language/ir-loader";
import { referenceKernelSchema } from "../lib/language/kernel-registry";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { finalizeGraphHashes } from "../lib/runtime/graph";

const source = `cut 0.4;
project "strict transcript consumer proof";
import { AudioGap, AudioTrack, PictureClip, PictureTrack, Sequence, TranscriptAudio, transcriptEdit } from "@cut/edit";
import { TranscriptCaptions } from "cut:visual";

asset words: DataAsset = data("assets/answer.transcript.json");
asset voice: AudioAsset = audio("assets/answer.wav", stream: 0);
asset camera: VideoAsset = video("assets/answer.mov");
asset face: FontAsset = font("assets/face.ttf");

timeline main(duration: 3s, fps: 24, width: 640px, height: 360px, sampleRate: 48khz) {
  scene answer(duration: 2s) {
    let quote: TranscriptEdit = transcriptEdit(
      transcript: words,
      source: voice,
      from: "w1",
      through: "w2",
      at: 500ms,
      link: "answer-a"
    );
    Sequence(duration: 2s) {
      PictureTrack() {
        PictureClip(source: camera, range: 0s ..< 2s, duration: 2s, link: "answer-a");
      }
    }
    TranscriptCaptions(edit: quote, font: face, maxWords: 2);
    AudioTrack() {
      AudioGap(destination: 0s ..< 500ms);
      TranscriptAudio(edit: quote, fadeIn: 10ms, fadeOut: 20ms);
      AudioGap(destination: 1500ms ..< 2s);
    }
  }
  scene after(duration: 1s) {}
}

export out = render(main, width: 640px, height: 360px, codec: "h264");
`;

function sidecar() {
  return JSON.stringify({
    format: "cut-transcript",
    version: 1,
    media: {
      sha256: "a".repeat(64),
      audioStreamIndex: 0,
      audioSampleRate: 48_000,
      duration: { numerator: "2", denominator: "1" },
    },
    words: [
      {
        id: "w1",
        start: { numerator: "0", denominator: "1" },
        end: { numerator: "1", denominator: "2" },
        text: "Words",
        join: "none",
      },
      {
        id: "w2",
        start: { numerator: "1", denominator: "2" },
        end: { numerator: "1", denominator: "1" },
        text: "matter.",
        join: "space",
      },
    ],
  });
}

function fixture(program = source) {
  const parsed = parseCutLanguage(program);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  const compileInputs: CutCompileInputs = {
    transcriptSidecars: new Map([["words", sidecar()]]),
  };
  const ir = compileCutModule(parsed.module, {}, undefined, undefined, compileInputs).ir;
  const binding = ir.transcriptBindings?.[0];
  const audio = Object.values(ir.nodes).find((node) =>
    node.op === "cut.audio.clip" && node.inputs.transcriptBindingId !== undefined);
  const captions = Object.values(ir.nodes).find((node) => node.op === "cut.visual.transcript_captions");
  const track = Object.values(ir.nodes).find((node) =>
    node.editorial?.kind === "audio-track"
    && node.editorial.items.some((item) => item.nodeId === audio?.id));
  assert.ok(binding && audio && captions && track);
  return { ir, binding, audio, captions, track };
}

function expectMutation(
  name: string,
  mutate: (value: ReturnType<typeof fixture>) => void,
  code: CutAvIrValidationError["code"],
  path: RegExp,
) {
  const value = fixture();
  mutate(value);
  finalizeGraphHashes(value.ir);
  assert.throws(() => loadCutAvIr(stableJsonStringify(value.ir)), (error: unknown) => {
    assert.ok(error instanceof CutAvIrValidationError, `${name}: ${String(error)}`);
    assert.equal(error.code, code, name);
    assert.match(error.path, path, name);
    return true;
  });
}

function time(value: number, denominator = 1) {
  return {
    kind: "quantity" as const,
    dimension: "time",
    magnitude: rational(value, denominator),
    unit: "s",
  };
}

function scalar(value: number, denominator = 1) {
  return {
    kind: "quantity" as const,
    dimension: "scalar",
    magnitude: rational(value, denominator),
    unit: "scalar",
  };
}

test("compiled transcript consumers are strict-loader valid and source edit is not an executable input", () => {
  const { ir, binding, audio, captions } = fixture();
  assert.equal(loadCutAvIr(stableJsonStringify(ir)).transcriptBindings?.[0]?.id, binding.id);
  assert.ok(Object.values(ir.nodes).every((node) => node.op !== "cut.edit.transcript_audio"));
  assert.equal(Object.hasOwn(audio.inputs, "edit"), false);
  assert.equal(Object.hasOwn(captions.inputs, "edit"), false);

  const schema = referenceKernelSchema("cut.visual.transcript_captions");
  assert.ok(schema?.support === "supported");
  assert.ok(!schema.inputs.includes("edit"), "edit must not be accepted in persisted/runtime IR");
  assert.deepEqual(schema.authoringInputs, ["edit"]);
  assert.deepEqual(schema.compilerInputs, ["transcriptBindingId", "transcriptCaptionIdentity"]);
});

test("accepted public TranscriptCaptions source variants immediately satisfy the strict loader", () => {
  const captionCall =
    "    TranscriptCaptions(edit: quote, font: face, maxWords: 2);";
  const programs = [
    source,
    source.replace(", maxWords: 2", ""),
    source.replace("maxWords: 2", "maxWords: 1 + 1"),
    source.replace(
      captionCall,
      `    at 250ms {\n  ${captionCall}\n    }`,
    ),
  ];
  for (const program of programs) {
    const { ir } = fixture(program);
    assert.doesNotThrow(
      () => loadCutAvIr(stableJsonStringify(ir)),
      program,
    );
  }
});

test("loader refuses compiler-only and cross-kernel transcript consumer shapes", () => {
  expectMutation("compiler-only audio op", ({ audio }) => {
    audio.op = "cut.edit.transcript_audio";
  }, "CUT_IR_ENUM", /\.op$/u);

  expectMutation("binding tag on unrelated op", ({ ir, binding }) => {
    const gap = Object.values(ir.nodes).find((node) => node.op === "cut.edit.audio_gap");
    assert.ok(gap);
    gap.inputs.transcriptBindingId = { kind: "string", value: binding.id };
  }, "CUT_IR_UNKNOWN_FIELD", /\.inputs\.transcriptBindingId$/u);

  expectMutation("source edit persisted on captions", ({ captions, binding }) => {
    captions.inputs.edit = {
      kind: "object",
      entries: {
        __transcriptBindingId: { kind: "string", value: binding.id },
      },
    };
  }, "CUT_IR_UNKNOWN_FIELD", /\.inputs\.edit$/u);
});

test("loader requires exact binding references, scene ownership, and caption identity", () => {
  expectMutation("missing caption binding", ({ captions }) => {
    delete captions.inputs.transcriptBindingId;
  }, "CUT_IR_MISSING_FIELD", /\.inputs\.transcriptBindingId$/u);

  expectMutation("unknown caption binding", ({ captions }) => {
    captions.inputs.transcriptBindingId = { kind: "string", value: "transcript_binding_missing" };
  }, "CUT_IR_REFERENCE", /\.inputs\.transcriptBindingId\.value$/u);

  expectMutation("wrong caption identity", ({ captions }) => {
    captions.inputs.transcriptCaptionIdentity = { kind: "string", value: "b".repeat(64) };
  }, "CUT_IR_HASH", /\.inputs\.transcriptCaptionIdentity\.value$/u);

  expectMutation("caption moved to another scene", ({ ir, binding, captions }) => {
    const from = ir.scenes[binding.sceneId]!;
    const to = Object.values(ir.scenes).find((scene) => scene.id !== from.id);
    assert.ok(to);
    from.rootVisualIds = from.rootVisualIds.filter((id) => id !== captions.id);
    from.items = from.items.filter((item) => item.id !== captions.id);
    to.rootVisualIds.push(captions.id);
    to.items.push({ id: captions.id, domain: "visual" });
    captions.sceneId = to.id;
    captions.interval = { start: rational(0), duration: rational(1) };
  }, "CUT_IR_IDENTITY", /\.sceneId$/u);
});

test("transcript-bound AudioClip must exactly project ledger source, destination, link, and direct track item", () => {
  expectMutation("wrong audio resource", ({ audio }) => {
    audio.inputs.source = { kind: "resource-ref", id: "words" };
  }, "CUT_IR_REFERENCE", /\.inputs\.source\.id$/u);

  expectMutation("wrong source range", ({ audio }) => {
    const range = audio.inputs.range;
    assert.ok(range?.kind === "range");
    range.end = time(3, 4);
  }, "CUT_IR_IDENTITY", /\.inputs\.range$/u);

  expectMutation("wrong destination range", ({ audio }) => {
    const destination = audio.inputs.destination;
    assert.ok(destination?.kind === "range");
    destination.start = time(1, 4);
  }, "CUT_IR_IDENTITY", /\.inputs\.destination$/u);

  expectMutation("wrong node interval", ({ audio }) => {
    audio.interval.start = rational(1, 4);
  }, "CUT_IR_IDENTITY", /\.interval$/u);

  expectMutation("wrong link", ({ audio }) => {
    audio.inputs.link = { kind: "string", value: "another-answer" };
  }, "CUT_IR_IDENTITY", /\.inputs\.link\.value$/u);

  expectMutation("ordinary AudioClip-only handle", ({ audio }) => {
    audio.inputs.headHandle = time(0);
  }, "CUT_IR_UNKNOWN_FIELD", /\.inputs\.headHandle$/u);

  expectMutation("segmented editorial item", ({ track, audio }) => {
    assert.ok(track.editorial?.kind === "audio-track");
    const item = track.editorial.items.find((candidate) => candidate.nodeId === audio.id);
    assert.ok(item);
    item.linkSegmentId = "segment_forbidden";
  }, "CUT_IR_IDENTITY", /\.editorial\.items\[\d+\]\.linkSegmentId$/u);
});

test("caption interval must cover the complete scene-local transcript destination", () => {
  expectMutation("caption begins after quote", ({ captions }) => {
    captions.interval = { start: rational(3, 4), duration: rational(5, 4) };
  }, "CUT_IR_TIMING", /\.interval$/u);

  expectMutation("caption ends before quote", ({ captions }) => {
    captions.interval = { start: rational(0), duration: rational(1) };
  }, "CUT_IR_TIMING", /\.interval$/u);
});

test("loader bounds transcript caption maxWords before renderer preparation", () => {
  expectMutation("wrong maxWords value kind", ({ captions }) => {
    captions.inputs.maxWords = { kind: "string", value: "2" };
  }, "CUT_IR_TYPE", /\.inputs\.maxWords$/u);

  expectMutation("wrong maxWords scalar unit", ({ captions }) => {
    captions.inputs.maxWords = { ...scalar(2), unit: "ratio" };
  }, "CUT_IR_TYPE", /\.inputs\.maxWords\.unit$/u);

  expectMutation("fractional maxWords", ({ captions }) => {
    captions.inputs.maxWords = scalar(3, 2);
  }, "CUT_IR_TYPE", /\.inputs\.maxWords$/u);

  expectMutation("zero maxWords", ({ captions }) => {
    captions.inputs.maxWords = scalar(0);
  }, "CUT_IR_LIMIT", /\.inputs\.maxWords$/u);

  expectMutation("excessive maxWords", ({ captions }) => {
    captions.inputs.maxWords = scalar(65);
  }, "CUT_IR_LIMIT", /\.inputs\.maxWords$/u);
});

test("assertion-only transcript bindings remain valid without forced audio or caption consumers", () => {
  const { ir, captions, track } = fixture();
  const answer = ir.scenes[ir.transcriptBindings![0]!.sceneId]!;
  delete ir.nodes[captions.id];
  answer.rootVisualIds = answer.rootVisualIds.filter((id) => id !== captions.id);
  answer.items = answer.items.filter((item) => item.id !== captions.id);
  for (const childId of track.children) delete ir.nodes[childId];
  delete ir.nodes[track.id];
  answer.rootAudioIds = answer.rootAudioIds.filter((id) => id !== track.id);
  answer.items = answer.items.filter((item) => item.id !== track.id);
  finalizeGraphHashes(ir);
  assert.ok(ir.transcriptBindings?.length);
  assert.doesNotThrow(() => loadCutAvIr(stableJsonStringify(ir)));
});
