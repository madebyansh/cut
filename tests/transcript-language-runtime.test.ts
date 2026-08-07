import assert from "node:assert/strict";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import {
  compileCutModule,
  CutCompileError,
  type CutCompileInputs,
} from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { parseCutLanguage } from "../lib/language/parser";

const digest = "a".repeat(64);

function sidecar(word = "change") {
  return JSON.stringify({
    format: "cut-transcript",
    version: 1,
    media: {
      sha256: digest,
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
        end: { numerator: "3", denominator: "4" },
        text: word,
        join: "space",
      },
      {
        id: "w3",
        start: { numerator: "3", denominator: "4" },
        end: { numerator: "1", denominator: "1" },
        text: "pictures.",
        join: "space",
      },
    ],
  });
}

const source = `cut 0.4;
project "transcript edit proof";
import { AudioGap, AudioTrack, PictureClip, PictureTrack, Sequence, TranscriptAudio, transcriptEdit } from "@cut/edit";
import { TranscriptCaptions } from "cut:visual";

asset words: DataAsset = data("assets/answer.transcript.json");
asset voice: AudioAsset = audio("assets/answer.wav", stream: 0);
asset camera: VideoAsset = video("assets/answer.mov");
asset face: FontAsset = font("assets/face.ttf");

timeline main(duration: 2s, fps: 24, width: 640px, height: 360px, sampleRate: 48khz) {
  scene answer(duration: 2s) {
    let quote: TranscriptEdit = transcriptEdit(
      transcript: words,
      source: voice,
      from: "w1",
      through: "w3",
      at: 500ms,
      link: "answer-a"
    );
    assert quote.duration == 1s, "selected duration";
    assert quote.text == "Words change pictures.", "selected text";
    Sequence(duration: 2s) {
      PictureTrack() {
        PictureClip(source: camera, range: 0s ..< 2s, duration: 2s, link: "answer-a");
      }
    }
    TranscriptCaptions(edit: quote, font: face, maxWords: 2, position: "bottom");
    AudioTrack() {
      AudioGap(destination: 0s ..< 500ms);
      TranscriptAudio(edit: quote, fadeIn: 10ms, fadeOut: 20ms);
      AudioGap(destination: 1500ms ..< 2s);
    }
  }
}

export out = render(main, width: 640px, height: 360px, codec: "h264");
`;

function parsed(text = source) {
  const result = parseCutLanguage(text);
  assert.ok(result.module, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.diagnostics, []);
  return result.module;
}

function inputs(bytes = sidecar()): CutCompileInputs {
  return { transcriptSidecars: new Map([["words", bytes]]) };
}

function compile(bytes = sidecar(), text = source) {
  return compileCutModule(parsed(text), {}, undefined, undefined, inputs(bytes)).ir;
}

type TranscriptIr = CutAVIR & {
  transcriptBindings: Array<{
    id: string;
    text: string;
    selectedIdsSha256: string;
    sourceRange: { start: { numerator: string; denominator: string }; duration: { numerator: string; denominator: string } };
    destinationRange: { start: { numerator: string; denominator: string }; duration: { numerator: string; denominator: string } };
  }>;
};

function node(ir: CutAVIR, op: string) {
  const matches = Object.values(ir.nodes).filter((candidate) => candidate.op === op);
  assert.equal(matches.length, 1, `expected one ${op}`);
  return matches[0]!;
}

function diagnostic(text: string, bytes: string | undefined, code: string) {
  assert.throws(() => compileCutModule(
    parsed(text),
    {},
    undefined,
    undefined,
    bytes === undefined ? {} : inputs(bytes),
  ), (error: unknown) => {
    assert.ok(error instanceof CutCompileError, String(error));
    const item = error.result.diagnostics.find((candidate) => candidate.code === code);
    assert.ok(item, JSON.stringify(error.result.diagnostics));
    assert.ok(item.span.start.offset < item.span.end.offset);
    return true;
  });
}

test("one public TranscriptEdit drives exact ordinary AudioClip placement and transcript captions", () => {
  const ir = compile() as TranscriptIr;
  assert.equal(ir.transcriptBindings.length, 1);
  const binding = ir.transcriptBindings[0]!;
  assert.equal(binding.text, "Words change pictures.");
  assert.match(binding.selectedIdsSha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(binding.sourceRange, {
    start: { numerator: "0", denominator: "1" },
    duration: { numerator: "1", denominator: "1" },
  });
  assert.deepEqual(binding.destinationRange, {
    start: { numerator: "1", denominator: "2" },
    duration: { numerator: "1", denominator: "1" },
  });

  const audio = node(ir, "cut.audio.clip");
  assert.deepEqual(audio.inputs.source, { kind: "resource-ref", id: "voice" });
  assert.deepEqual(audio.inputs.range, {
    kind: "range",
    start: { kind: "quantity", dimension: "time", magnitude: { numerator: "0", denominator: "1" }, unit: "s" },
    end: { kind: "quantity", dimension: "time", magnitude: { numerator: "1", denominator: "1" }, unit: "s" },
    exclusive: true,
  });
  assert.deepEqual(audio.inputs.destination, {
    kind: "range",
    start: { kind: "quantity", dimension: "time", magnitude: { numerator: "1", denominator: "2" }, unit: "s" },
    end: { kind: "quantity", dimension: "time", magnitude: { numerator: "3", denominator: "2" }, unit: "s" },
    exclusive: true,
  });
  assert.deepEqual(audio.inputs.link, { kind: "string", value: "answer-a" });
  assert.deepEqual(audio.inputs.transcriptBindingId, { kind: "string", value: binding.id });
  assert.equal(Object.hasOwn(audio.inputs, "edit"), false);

  const captions = node(ir, "cut.visual.transcript_captions");
  assert.deepEqual(captions.inputs.transcriptBindingId, { kind: "string", value: binding.id });
  assert.match(captions.inputs.transcriptCaptionIdentity.kind === "string"
    ? captions.inputs.transcriptCaptionIdentity.value
    : "", /^[0-9a-f]{64}$/u);
  assert.equal(Object.hasOwn(captions.inputs, "edit"), false);
  assert.ok(ir.assertions.every((assertion) => assertion.status === "pass"));
});

test("text-only transcript correction preserves audio-node cache identity but invalidates caption identity", () => {
  const before = compile();
  const after = compile(sidecar("reshapes"));
  const beforeAudio = node(before, "cut.audio.clip"), afterAudio = node(after, "cut.audio.clip");
  const beforeCaptions = node(before, "cut.visual.transcript_captions"), afterCaptions = node(after, "cut.visual.transcript_captions");
  assert.equal(beforeAudio.id, afterAudio.id);
  assert.equal(beforeAudio.contentHash, afterAudio.contentHash);
  assert.equal(beforeCaptions.id, afterCaptions.id);
  assert.notEqual(beforeCaptions.contentHash, afterCaptions.contentHash);
  assert.notEqual(before.buildId, after.buildId);
});

test("compiler refuses absent/invalid sidecars, source selector drift, and ambiguous declaration scope", () => {
  diagnostic(source, undefined, "CUT_TRANSCRIPT_RESOURCE");
  diagnostic(source, "{", "CUT_TRANSCRIPT_FORMAT");
  diagnostic(source, sidecar().replace('"audioStreamIndex":0', '"audioStreamIndex":1'), "CUT_TRANSCRIPT_MEDIA");
  const topLevel = source.replace(
    "timeline main",
    `const bad: TranscriptEdit = transcriptEdit(transcript: words, source: voice, from: "w1", through: "w3", at: 0s);\n\ntimeline main`,
  );
  diagnostic(topLevel, sidecar(), "CUT_TRANSCRIPT_SCOPE");
});

test("compiler rechecks resolved caption grouping and statement coverage before emitting IR", () => {
  diagnostic(
    source.replace("maxWords: 2", "maxWords: 64 + 1"),
    sidecar(),
    "CUT_TRANSCRIPT_LIMIT",
  );
  const captionCall =
    '    TranscriptCaptions(edit: quote, font: face, maxWords: 2, position: "bottom");';
  diagnostic(
    source.replace(
      captionCall,
      `    at 1s {\n  ${captionCall}\n    }`,
    ),
    sidecar(),
    "CUT_TRANSCRIPT_TIME",
  );
});

test("checker accepts the executable public surface without reopening Narration transcript metadata", () => {
  const checked = checkCutModule(parsed());
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  const narration = source
    .replace(
      'import { AudioGap, AudioTrack, PictureClip, PictureTrack, Sequence, TranscriptAudio, transcriptEdit } from "@cut/edit";',
      'import { AudioGap, AudioTrack, PictureClip, PictureTrack, Sequence, TranscriptAudio, transcriptEdit } from "@cut/edit";\nimport { Narration } from "@cut/documentary";',
    )
    .replace("TranscriptCaptions(edit: quote", 'Narration(source: voice, transcript: "ignored");\n    TranscriptCaptions(edit: quote');
  assert.ok(checkCutModule(parsed(narration)).diagnostics.some((item) => item.code === "CUT2059"));
});
