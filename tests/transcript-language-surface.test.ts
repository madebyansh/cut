import assert from "node:assert/strict";
import test from "node:test";
import { checkCutModule, type CheckResult } from "../lib/language/checker";
import { builtinPackages } from "../lib/language/packages";
import { parseCutLanguage } from "../lib/language/parser";

function check(source: string): CheckResult {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return checkCutModule(parsed.module);
}

function transcriptValues(body: string) {
  return `cut 0.4;
project "transcript language surface";
import { transcriptEdit } from "@cut/edit";
asset words: DataAsset = data("assets/answer.transcript.json");
asset voice: AudioAsset = audio("assets/answer.wav");
const quote: TranscriptEdit = transcriptEdit(
  transcript: words,
  source: voice,
  from: "w0042",
  through: "w0061",
  at: 1200ms,
  link: "answer-a"
);
${body}
`;
}

function fullProgram(sceneBody: string, imports = "") {
  return `cut 0.4;
project "transcript language surface";
import { AudioTrack, PictureTrack, Sequence, TranscriptAudio, TranscriptPicture, transcriptEdit } from "@cut/edit";
import { Stack, TranscriptCaptions } from "cut:visual";
${imports}
asset words: DataAsset = data("assets/answer.transcript.json");
asset voice: AudioAsset = audio("assets/answer.mov");
asset camera: VideoAsset = video("assets/answer.mov", videoStream: 0);
asset face: FontAsset = font("assets/face.ttf");
const quote: TranscriptEdit = transcriptEdit(
  transcript: words,
  source: voice,
  from: "w0042",
  through: "w0061",
  at: 1200ms,
  link: "answer-a"
);
timeline main(duration: 4s, fps: 24, width: 640px, height: 360px, sampleRate: 48khz) {
  scene answer(duration: 4s) {
    ${sceneBody}
  }
}
export out = render(main);
`;
}

function expectLocated(source: string, code: string, needle: string) {
  const diagnostic = check(source).diagnostics.find((item) => item.code === code);
  assert.ok(diagnostic, JSON.stringify(check(source).diagnostics));
  assert.ok(
    source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset).includes(needle),
    JSON.stringify(diagnostic),
  );
  assert.ok(diagnostic.span.end.offset > diagnostic.span.start.offset);
  assert.ok(diagnostic.span.start.line > 0 && diagnostic.span.start.column > 0);
  return diagnostic;
}

test("built-in manifests expose one closed transcript edit, audio, picture, and caption surface", () => {
  const edit = builtinPackages.get("@cut/edit")?.symbols;
  const visual = builtinPackages.get("cut:visual")?.symbols;
  assert.ok(edit && visual);

  assert.deepEqual({
    kind: edit.transcriptEdit.kind,
    parameters: edit.transcriptEdit.parameters,
    returns: edit.transcriptEdit.returns,
    effect: edit.transcriptEdit.effect,
    lowering: edit.transcriptEdit.lowering,
    native: edit.transcriptEdit.native,
    domain: edit.transcriptEdit.domain,
  }, {
    kind: "function",
    parameters: [
      { name: "transcript", type: "TranscriptAsset" },
      { name: "source", type: "AudioAsset" },
      { name: "from", type: "String" },
      { name: "through", type: "String" },
      { name: "at", type: "Time" },
      { name: "link", type: "String", optional: true },
      { name: "media", type: "TranscriptMediaAuthority", optional: true },
    ],
    returns: "TranscriptEdit",
    effect: "pure",
    lowering: "transcript-edit",
    native: undefined,
    domain: undefined,
  });

  assert.deepEqual({
    kind: edit.TranscriptAudio.kind,
    parameters: edit.TranscriptAudio.parameters,
    returns: edit.TranscriptAudio.returns,
    domain: edit.TranscriptAudio.domain,
    children: edit.TranscriptAudio.children,
    native: edit.TranscriptAudio.native,
  }, {
    kind: "component",
    parameters: [
      { name: "edit", type: "TranscriptEdit" },
      { name: "fadeIn", type: "Time", optional: true, default: "0ms" },
      { name: "fadeOut", type: "Time", optional: true, default: "0ms" },
    ],
    returns: "AudioNode",
    domain: "audio",
    children: "none",
    native: "cut.edit.transcript_audio",
  });

  assert.deepEqual({
    kind: edit.TranscriptPicture.kind,
    parameters: edit.TranscriptPicture.parameters,
    returns: edit.TranscriptPicture.returns,
    domain: edit.TranscriptPicture.domain,
    children: edit.TranscriptPicture.children,
    native: edit.TranscriptPicture.native,
  }, {
    kind: "component",
    parameters: [
      { name: "edit", type: "TranscriptEdit" },
      { name: "source", type: "VideoAsset" },
      { name: "fit", type: "String", optional: true, values: ["cover", "contain", "fill"] },
      { name: "opacity", type: "Ratio", optional: true },
      { name: "scale", type: "Number", optional: true },
      { name: "rotation", type: "Angle", optional: true },
      { name: "inputColor", type: "String", optional: true, values: ["srgb", "linear-srgb", "rec709-full", "rec709-limited", "bt470bg-smpte170m-limited"] },
      { name: "inputColorInterpretation", type: "VideoColorInterpretation", optional: true },
      { name: "duration", type: "Time", optional: true },
      { name: "rate", type: "Number", optional: true },
    ],
    returns: "Visual",
    domain: "visual",
    children: "none",
    native: "cut.edit.transcript_picture",
  });

  assert.deepEqual(
    visual.TranscriptCaptions.parameters?.slice(3),
    visual.Captions.parameters?.slice(3),
    "TranscriptCaptions must reuse the complete closed Captions appearance surface",
  );
  assert.deepEqual(visual.TranscriptCaptions.parameters?.slice(0, 3), [
    { name: "edit", type: "TranscriptEdit" },
    { name: "font", type: "FontAsset" },
    { name: "maxWords", type: "Number", optional: true, default: 6 },
  ]);
  assert.deepEqual({
    returns: visual.TranscriptCaptions.returns,
    domain: visual.TranscriptCaptions.domain,
    children: visual.TranscriptCaptions.children,
    native: visual.TranscriptCaptions.native,
  }, {
    returns: "Visual",
    domain: "visual",
    children: "none",
    native: "cut.visual.transcript_captions",
  });
});

test("checker types all and only the four public TranscriptEdit members", () => {
  const valid = transcriptValues(`
const selectedSource: Range<Time> = quote.sourceRange;
const placedDestination: Range<Time> = quote.destinationRange;
const selectedDuration: Time = quote.duration;
const selectedText: String = quote.text;`);
  assert.deepEqual(check(valid).diagnostics, []);

  const unknown = transcriptValues("const tokens = quote.tokens;");
  const diagnostic = expectLocated(unknown, "CUT2013", "quote.tokens");
  assert.match(diagnostic.message, /TranscriptEdit.*tokens/);
});

test("transcriptEdit arguments are closed, required, and exactly typed", () => {
  const unknown = transcriptValues("").replace('link: "answer-a"', 'link: "answer-a", ignored: true');
  expectLocated(unknown, "CUT2027", "ignored: true");

  const missing = transcriptValues("").replace('  through: "w0061",\n', "");
  expectLocated(missing, "CUT2028", "transcriptEdit(");

  const duplicate = transcriptValues("").replace("  transcript: words,", "  words,\n  transcript: words,");
  expectLocated(duplicate, "CUT2026", "transcript: words");

  const cases = [
    { from: "transcript: words", to: "transcript: voice", needle: "voice" },
    { from: "source: voice", to: "source: words", needle: "words" },
    { from: 'from: "w0042"', to: "from: 42", needle: "42" },
    { from: 'through: "w0061"', to: "through: 61", needle: "61" },
    { from: "at: 1200ms", to: 'at: "1200ms"', needle: '"1200ms"' },
    { from: 'link: "answer-a"', to: "link: 7", needle: "7" },
  ] as const;
  for (const fixture of cases) {
    const source = transcriptValues("").replace(fixture.from, fixture.to);
    expectLocated(source, "CUT2029", fixture.needle);
  }
});

test("TranscriptAudio is legal only as the direct AudioTrack item expression", () => {
  const direct = fullProgram(`TranscriptCaptions(edit: quote, font: face);
    AudioTrack() {
      TranscriptAudio(edit: quote, fadeIn: 10ms, fadeOut: 20ms);
    }`);
  const directDiagnostics = check(direct).diagnostics;
  assert.ok(!directDiagnostics.some((item) => item.code === "CUT_TRANSCRIPT_SCOPE"), JSON.stringify(directDiagnostics));
  assert.deepEqual(directDiagnostics, []);

  const detached = fullProgram("let detached = TranscriptAudio(edit: quote);");
  expectLocated(detached, "CUT_TRANSCRIPT_SCOPE", "TranscriptAudio(edit: quote)");

  const sceneRoot = fullProgram("TranscriptAudio(edit: quote);");
  expectLocated(sceneRoot, "CUT_TRANSCRIPT_SCOPE", "TranscriptAudio(edit: quote)");

  const nested = fullProgram(
    `Gain(amount: -1db) {
      TranscriptAudio(edit: quote);
    }`,
    'import { Gain } from "@cut/audio";',
  );
  expectLocated(nested, "CUT_TRANSCRIPT_SCOPE", "TranscriptAudio(edit: quote)");
});

test("TranscriptPicture is legal only as one direct PictureTrack item expression", () => {
  const direct = fullProgram(`Sequence(duration: 4s) {
      PictureTrack() {
        TranscriptPicture(edit: quote, source: camera, fit: "contain", opacity: 90%, scale: 1, rotation: 0deg);
      }
    }
    AudioTrack() {
      TranscriptAudio(edit: quote);
    }`);
  assert.deepEqual(check(direct).diagnostics, []);

  const detached = fullProgram("let detached = TranscriptPicture(edit: quote, source: camera);");
  expectLocated(detached, "CUT_TRANSCRIPT_SCOPE", "TranscriptPicture(edit: quote, source: camera)");

  const sceneRoot = fullProgram("TranscriptPicture(edit: quote, source: camera);");
  expectLocated(sceneRoot, "CUT_TRANSCRIPT_SCOPE", "TranscriptPicture(edit: quote, source: camera)");

  const nested = fullProgram(`Sequence(duration: 4s) {
      PictureTrack() {
        Stack() {
          TranscriptPicture(edit: quote, source: camera);
        }
      }
    }`);
  expectLocated(nested, "CUT_TRANSCRIPT_SCOPE", "TranscriptPicture(edit: quote, source: camera)");
});

test("TranscriptAudio, TranscriptPicture, and TranscriptCaptions reject unknown and mistyped arguments", () => {
  const audioUnknown = fullProgram(`AudioTrack() {
      TranscriptAudio(edit: quote, ignored: true);
    }`);
  const audioUnknownDiagnostic = expectLocated(audioUnknown, "CUT2059", "ignored: true");
  assert.match(audioUnknownDiagnostic.hint ?? "", /edit, fadeIn, fadeOut/);

  const audioType = fullProgram(`AudioTrack() {
      TranscriptAudio(edit: "quote");
    }`);
  expectLocated(audioType, "CUT2029", '"quote"');

  const pictureUnknown = fullProgram(`Sequence(duration: 4s) {
      PictureTrack() {
        TranscriptPicture(edit: quote, source: camera, ignored: true);
      }
    }`);
  const pictureUnknownDiagnostic = expectLocated(pictureUnknown, "CUT2059", "ignored: true");
  assert.match(
    pictureUnknownDiagnostic.hint ?? "",
    /edit, source, fit, opacity, scale, rotation, inputColor, inputColorInterpretation/,
  );

  const pictureEditType = fullProgram(`Sequence(duration: 4s) {
      PictureTrack() {
        TranscriptPicture(edit: "quote", source: camera);
      }
    }`);
  expectLocated(pictureEditType, "CUT2029", '"quote"');

  const pictureSourceType = fullProgram(`Sequence(duration: 4s) {
      PictureTrack() {
        TranscriptPicture(edit: quote, source: voice);
      }
    }`);
  expectLocated(pictureSourceType, "CUT2029", "voice");

  const captionsUnknown = fullProgram("TranscriptCaptions(edit: quote, font: face, ignored: true);");
  const captionsUnknownDiagnostic = expectLocated(captionsUnknown, "CUT2059", "ignored: true");
  assert.match(captionsUnknownDiagnostic.hint ?? "", /edit, font, maxWords/);

  const captionsType = fullProgram('TranscriptCaptions(edit: quote, font: face, maxWords: "six");');
  expectLocated(captionsType, "CUT2029", '"six"');

  for (const maxWords of ["0", "1.5", "65"]) {
    const captionsLimit = fullProgram(
      `TranscriptCaptions(edit: quote, font: face, maxWords: ${maxWords});`,
    );
    const diagnostic = expectLocated(
      captionsLimit,
      "CUT_TRANSCRIPT_LIMIT",
      maxWords,
    );
    assert.match(diagnostic.message, /whole Number from 1 through 64/u);
  }

  for (const size of ["11px", "257px"] as const) {
    const captionsLimit = fullProgram(
      `TranscriptCaptions(edit: quote, font: face, size: ${size});`,
    );
    const diagnostic = expectLocated(
      captionsLimit,
      "CUT_CAPTION_VALUE_RANGE",
      size,
    );
    assert.match(diagnostic.message, /pixel Length from 12px through 256px/u);
  }
  for (const size of ["12px", "256px"] as const) {
    assert.equal(
      check(fullProgram(`TranscriptCaptions(edit: quote, font: face, size: ${size});`))
        .diagnostics.filter((item) => item.code === "CUT_CAPTION_VALUE_RANGE").length,
      0,
      size,
    );
  }
});

test("Narration still refuses a transcript argument with an executable-alternative hint", () => {
  const source = `cut 0.4;
project "narration remains closed";
import { Narration } from "@cut/documentary";
asset voice: AudioAsset = audio("assets/answer.wav");
timeline main(duration: 2s, fps: 24, sampleRate: 48khz) {
  scene answer(duration: 2s) {
    Narration(source: voice, transcript: "never silently ignored");
  }
}
export out = render(main);
`;
  const diagnostic = expectLocated(source, "CUT2059", 'transcript: "never silently ignored"');
  assert.match(diagnostic.message, /does not execute input “transcript”/);
  assert.match(diagnostic.hint ?? "", /Captions.*Marker\/Region/);
});
