import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { compileCutModule, CutCompileError, type CutCompileInputs } from "../lib/language/compiler";
import { CutAvIrValidationError, validateCutAvIr } from "../lib/language/ir-loader";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import type { LockedResource } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import {
  CutTranscriptLockError,
  verifyCutTranscriptBindingsForLock,
} from "../lib/language/transcript-lock";
import { finalizeGraphHashes } from "../lib/runtime/graph";

const mediaDigest = "a".repeat(64);

function transcript(
  text = "frames",
  end = { numerator: "3", denominator: "5" },
  videoFrameRate = { numerator: "24", denominator: "1" },
  audioVideoPresentationDelta?: {
    numerator: string;
    denominator: string;
  },
) {
  return JSON.stringify({
    format: "cut-transcript",
    version: 1,
    media: {
      sha256: mediaDigest,
      audioStreamIndex: 1,
      audioSampleRate: 48_000,
      duration: { numerator: "2", denominator: "1" },
      videoStreamIndex: 0,
      videoFrameRate,
      // Deliberately differs from audio duration. TranscriptPicture must use
      // independent decoded-video authority rather than borrowing audio bounds.
      videoDuration: { numerator: "5", denominator: "1" },
      ...(audioVideoPresentationDelta === undefined
        ? {}
        : { audioVideoPresentationDelta }),
    },
    words: [{
      id: "w1",
      start: { numerator: "1", denominator: "10" },
      end,
      text,
      join: "none",
    }],
  });
}

const source = `cut 0.4;
project "transcript picture proof";
import { AudioGap, AudioTrack, Gap, PictureTrack, Sequence, TranscriptAudio, TranscriptPicture, transcriptEdit } from "@cut/edit";

asset words: DataAsset = data("assets/answer.transcript.json");
asset voice: AudioAsset = audio("assets/answer.mov", stream: 1);
asset camera: VideoAsset = video("assets/answer.mov", videoStream: 0, audioStream: 1);

timeline main(duration: 2s, fps: 24, width: 640px, height: 360px, sampleRate: 48khz) {
  scene answer(duration: 2s) {
    let quote: TranscriptEdit = transcriptEdit(
      transcript: words,
      source: voice,
      from: "w1",
      through: "w1",
      at: 500ms,
      link: "answer-av"
    );
    Sequence(duration: 25s / 24) {
      PictureTrack() {
        Gap(duration: 1s / 2);
        TranscriptPicture(
          edit: quote,
          source: camera,
          fit: "contain",
          opacity: 90%,
          scale: 1,
          rotation: 0deg
        );
      }
    }
    AudioTrack() {
      AudioGap(destination: 0s ..< 500ms);
      TranscriptAudio(edit: quote);
      AudioGap(destination: 1s ..< 2s);
    }
  }
}

export out = render(main, width: 640px, height: 360px, codec: "h264");
`;

const transcriptPictureSourceCall = `        TranscriptPicture(
          edit: quote,
          source: camera,
          fit: "contain",
          opacity: 90%,
          scale: 1,
          rotation: 0deg
        );`;

const captionedSource = source
  .replace(
    'import { AudioGap, AudioTrack, Gap, PictureTrack, Sequence, TranscriptAudio, TranscriptPicture, transcriptEdit } from "@cut/edit";',
    'import { AudioGap, AudioTrack, Gap, PictureTrack, Sequence, TranscriptAudio, TranscriptPicture, transcriptEdit } from "@cut/edit";\nimport { TranscriptCaptions } from "cut:visual";',
  )
  .replace(
    'asset camera: VideoAsset = video("assets/answer.mov", videoStream: 0, audioStream: 1);',
    'asset camera: VideoAsset = video("assets/answer.mov", videoStream: 0, audioStream: 1);\nasset face: FontAsset = font("assets/face.ttf");',
  )
  .replace(
    "    Sequence(duration: 25s / 24) {",
    `    TranscriptCaptions(edit: quote, font: face, maxWords: 1);
    Sequence(duration: 25s / 24) {`,
  );

function withTranscriptPicture(
  call: string,
  visualImports?: string,
) {
  assert.equal(source.includes(transcriptPictureSourceCall), true);
  const replaced = source.replace(transcriptPictureSourceCall, call);
  if (!visualImports) return replaced;
  const editImport = 'import { AudioGap, AudioTrack, Gap, PictureTrack, Sequence, TranscriptAudio, TranscriptPicture, transcriptEdit } from "@cut/edit";';
  assert.equal(replaced.includes(editImport), true);
  return replaced.replace(editImport, `${editImport}\n${visualImports}`);
}

function compile(text = source, bytes = transcript()) {
  const parsed = parseCutLanguage(text);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  const inputs: CutCompileInputs = {
    transcriptSidecars: new Map([["words", bytes]]),
  };
  return compileCutModule(parsed.module, {}, undefined, undefined, inputs).ir;
}

function oneNode(ir: CutAVIR, predicate: (node: IRNode) => boolean) {
  const nodes = Object.values(ir.nodes).filter(predicate);
  assert.equal(nodes.length, 1);
  return nodes[0]!;
}

function compileDiagnostic(text: string, code: string, bytes = transcript()) {
  assert.throws(
    () => compile(text, bytes),
    (error: unknown) => {
      assert.ok(error instanceof CutCompileError, String(error));
      const diagnostic = error.result.diagnostics.find((item) => item.code === code);
      assert.ok(diagnostic, JSON.stringify(error.result.diagnostics));
      assert.ok(diagnostic.span.start.offset < diagnostic.span.end.offset);
      return true;
    },
  );
}

function strictFailure(
  ir: CutAVIR,
  mutate: (copy: CutAVIR) => void,
  code: string,
  path: RegExp,
) {
  const copy = structuredClone(ir);
  mutate(copy);
  finalizeGraphHashes(copy);
  assert.throws(
    () => validateCutAvIr(copy),
    (error: unknown) => error instanceof CutAvIrValidationError
      && error.code === code
      && path.test(error.path),
  );
}

test("TranscriptPicture lowers through ordinary PictureClip with exact cover-frame and direct-track identity", () => {
  const ir = compile();
  assert.doesNotThrow(() => validateCutAvIr(structuredClone(ir)));
  assert.equal(Object.values(ir.nodes).some((node) => node.op === "cut.edit.transcript_picture"), false);

  const binding = ir.transcriptBindings?.[0];
  assert.ok(binding);
  assert.deepEqual(binding.media.duration, rational(2));
  assert.deepEqual(binding.media.videoDuration, rational(5));
  assert.equal(binding.media.audioVideoPresentationDelta, undefined);
  const picture = oneNode(
    ir,
    (node) => node.op === "cut.edit.picture_clip"
      && node.inputs.transcriptPictureIdentity !== undefined,
  );
  assert.deepEqual(picture.inputs.source, { kind: "resource-ref", id: "camera" });
  assert.deepEqual(picture.inputs.range, {
    kind: "range",
    start: {
      kind: "quantity",
      dimension: "time",
      magnitude: { numerator: "1", denominator: "12" },
      unit: "s",
    },
    end: {
      kind: "quantity",
      dimension: "time",
      magnitude: { numerator: "5", denominator: "8" },
      unit: "s",
    },
    exclusive: true,
  });
  assert.deepEqual(picture.inputs.duration, {
    kind: "quantity",
    dimension: "time",
    magnitude: { numerator: "13", denominator: "24" },
    unit: "s",
  });
  assert.deepEqual(picture.interval, {
    start: { numerator: "1", denominator: "2" },
    duration: { numerator: "13", denominator: "24" },
  });
  assert.deepEqual(picture.inputs.link, { kind: "string", value: "answer-av" });
  assert.deepEqual(picture.inputs.transcriptBindingId, {
    kind: "string",
    value: binding.id,
  });
  assert.match(
    picture.inputs.transcriptPictureIdentity?.kind === "string"
      ? picture.inputs.transcriptPictureIdentity.value
      : "",
    /^[0-9a-f]{64}$/u,
  );
  const track = oneNode(ir, (node) => node.op === "cut.edit.picture_track");
  assert.equal(track.children.includes(picture.id), true);
  assert.deepEqual(
    track.editorial?.kind === "picture-track"
      ? track.editorial.items.find((item) => item.nodeId === picture.id)?.source
      : undefined,
    { start: { numerator: "1", denominator: "12" }, duration: { numerator: "13", denominator: "24" } },
  );
});

test("TranscriptPicture translates nonzero presentation delta before cover and localizes identity changes", () => {
  const aligned = compile(captionedSource);
  const shifted = compile(
    captionedSource,
    transcript(
      "frames",
      { numerator: "3", denominator: "5" },
      { numerator: "24", denominator: "1" },
      { numerator: "1", denominator: "4" },
    ),
  );
  assert.doesNotThrow(() => validateCutAvIr(structuredClone(shifted)));
  assert.deepEqual(
    shifted.transcriptBindings?.[0]?.media.audioVideoPresentationDelta,
    rational(1, 4),
  );
  const alignedPicture = oneNode(
    aligned,
    (node) => node.inputs.transcriptPictureIdentity !== undefined,
  );
  const shiftedPicture = oneNode(
    shifted,
    (node) => node.inputs.transcriptPictureIdentity !== undefined,
  );
  assert.deepEqual(shiftedPicture.inputs.range, {
    kind: "range",
    start: {
      kind: "quantity",
      dimension: "time",
      magnitude: { numerator: "1", denominator: "3" },
      unit: "s",
    },
    end: {
      kind: "quantity",
      dimension: "time",
      magnitude: { numerator: "7", denominator: "8" },
      unit: "s",
    },
    exclusive: true,
  });
  assert.notDeepEqual(
    shiftedPicture.inputs.transcriptPictureIdentity,
    alignedPicture.inputs.transcriptPictureIdentity,
  );
  assert.notEqual(shiftedPicture.contentHash, alignedPicture.contentHash);
  assert.notEqual(shifted.buildId, aligned.buildId);

  const transcriptAudio = (ir: CutAVIR) => oneNode(
    ir,
    (node) => node.op === "cut.audio.clip"
      && node.inputs.transcriptBindingId !== undefined,
  );
  assert.equal(
    transcriptAudio(shifted).contentHash,
    transcriptAudio(aligned).contentHash,
    "picture-origin authority must not invalidate unchanged decoder-audio work",
  );
  const transcriptCaptions = (ir: CutAVIR) => oneNode(
    ir,
    (node) => node.op === "cut.visual.transcript_captions",
  );
  assert.equal(
    transcriptCaptions(shifted).contentHash,
    transcriptCaptions(aligned).contentHash,
    "picture-origin authority must not invalidate unchanged caption work",
  );
  const diff = diffCutAVIR(aligned, shifted);
  const bindingChange = diff.changes.find(
    (change) => change.entity === "transcript-binding"
      && change.operation === "modify",
  );
  assert.ok(bindingChange && bindingChange.operation === "modify");
  assert.ok(
    bindingChange.fields.some(
      (field) => field.path === "/media/audioVideoPresentationDelta",
    ),
    JSON.stringify(diff.changes),
  );
});

test("TranscriptPicture preserves every accepted appearance and color argument in ordinary PictureClip IR", () => {
  const managed = compile(withTranscriptPicture(`        TranscriptPicture(
          edit: quote,
          source: camera,
          fit: "fill",
          opacity: 75%,
          scale: 5 / 4,
          rotation: 15deg,
          inputColor: "rec709-limited"
        );`));
  assert.doesNotThrow(() => validateCutAvIr(structuredClone(managed)));
  const managedPicture = oneNode(
    managed,
    (node) => node.op === "cut.edit.picture_clip"
      && node.inputs.transcriptPictureIdentity !== undefined,
  );
  assert.deepEqual(managedPicture.inputs.fit, { kind: "string", value: "fill" });
  assert.deepEqual(managedPicture.inputs.opacity, {
    kind: "quantity",
    dimension: "ratio",
    magnitude: { numerator: "3", denominator: "4" },
    unit: "ratio",
  });
  assert.deepEqual(managedPicture.inputs.scale, {
    kind: "quantity",
    dimension: "scalar",
    magnitude: { numerator: "5", denominator: "4" },
    unit: "scalar",
  });
  assert.deepEqual(managedPicture.inputs.rotation, {
    kind: "quantity",
    dimension: "angle",
    magnitude: { numerator: "15", denominator: "1" },
    unit: "deg",
  });
  assert.deepEqual(managedPicture.inputs.inputColor, {
    kind: "string",
    value: "rec709-limited",
  });
  assert.equal(Object.hasOwn(managedPicture.inputs, "inputColorInterpretation"), false);

  const interpreted = compile(withTranscriptPicture(`        TranscriptPicture(
          edit: quote,
          source: camera,
          fit: "cover",
          opacity: 80%,
          scale: 6 / 5,
          rotation: 7deg,
          inputColorInterpretation: interpretVideoColor(
            profile: "rec709-limited",
            master: observedVideoColor(
              pixelFormat: "yuv444p",
              fieldOrder: "progressive"
            )
          )
        );`, 'import { interpretVideoColor, observedVideoColor } from "cut:visual";'));
  assert.doesNotThrow(() => validateCutAvIr(structuredClone(interpreted)));
  const interpretedPicture = oneNode(
    interpreted,
    (node) => node.op === "cut.edit.picture_clip"
      && node.inputs.transcriptPictureIdentity !== undefined,
  );
  assert.deepEqual(interpretedPicture.inputs.fit, { kind: "string", value: "cover" });
  assert.deepEqual(interpretedPicture.inputs.opacity, {
    kind: "quantity",
    dimension: "ratio",
    magnitude: { numerator: "4", denominator: "5" },
    unit: "ratio",
  });
  assert.deepEqual(interpretedPicture.inputs.scale, {
    kind: "quantity",
    dimension: "scalar",
    magnitude: { numerator: "6", denominator: "5" },
    unit: "scalar",
  });
  assert.deepEqual(interpretedPicture.inputs.rotation, {
    kind: "quantity",
    dimension: "angle",
    magnitude: { numerator: "7", denominator: "1" },
    unit: "deg",
  });
  assert.equal(Object.hasOwn(interpretedPicture.inputs, "inputColor"), false);
  assert.deepEqual(interpretedPicture.inputs.inputColorInterpretation, {
    kind: "object",
    entries: {
      profile: { kind: "string", value: "rec709-limited" },
      master: {
        kind: "object",
        entries: {
          pixelFormat: { kind: "string", value: "yuv444p" },
          fieldOrder: { kind: "string", value: "progressive" },
        },
      },
    },
  });
});

test("TranscriptPicture appearance and color arguments causally invalidate ordinary PictureClip content identity", () => {
  const base = oneNode(
    compile(),
    (node) => node.op === "cut.edit.picture_clip"
      && node.inputs.transcriptPictureIdentity !== undefined,
  );
  const variants = [
    source.replace('fit: "contain"', 'fit: "fill"'),
    source.replace("opacity: 90%", "opacity: 75%"),
    source.replace("scale: 1,", "scale: 5 / 4,"),
    source.replace("rotation: 0deg", "rotation: 15deg"),
    source.replace("rotation: 0deg", 'rotation: 0deg,\n          inputColor: "rec709-limited"'),
    withTranscriptPicture(`        TranscriptPicture(
          edit: quote,
          source: camera,
          fit: "contain",
          opacity: 90%,
          scale: 1,
          rotation: 0deg,
          inputColorInterpretation: interpretVideoColor(
            profile: "rec709-limited",
            master: observedVideoColor(
              pixelFormat: "yuv444p",
              fieldOrder: "progressive"
            )
          )
        );`, 'import { interpretVideoColor, observedVideoColor } from "cut:visual";'),
  ];
  const seen = new Set([base.contentHash]);
  for (const variant of variants) {
    const picture = oneNode(
      compile(variant),
      (node) => node.op === "cut.edit.picture_clip"
        && node.inputs.transcriptPictureIdentity !== undefined,
    );
    assert.deepEqual(
      picture.inputs.transcriptPictureIdentity,
      base.inputs.transcriptPictureIdentity,
      "appearance must not forge a different transcript frame-selection identity",
    );
    assert.notEqual(
      picture.contentHash,
      base.contentHash,
      "every accepted appearance/color argument must enter ordinary PictureClip content identity",
    );
    assert.equal(seen.has(picture.contentHash), false);
    seen.add(picture.contentHash);
  }
});

test("TranscriptPicture spelling corrections preserve picture cache identity while timing changes invalidate it", () => {
  const before = compile();
  const spelling = compile(source, transcript("images"));
  const beforePicture = oneNode(before, (node) => node.inputs.transcriptPictureIdentity !== undefined);
  const spellingPicture = oneNode(spelling, (node) => node.inputs.transcriptPictureIdentity !== undefined);
  assert.equal(beforePicture.id, spellingPicture.id);
  assert.equal(beforePicture.contentHash, spellingPicture.contentHash);
  assert.notEqual(before.buildId, spelling.buildId);

  const timing = compile(
    source.replace("Sequence(duration: 25s / 24)", "Sequence(duration: 9s / 8)")
      .replace("AudioGap(destination: 1s ..< 2s);", "AudioGap(destination: 11s / 10 ..< 2s);"),
    transcript("frames", { numerator: "7", denominator: "10" }),
  );
  const timingPicture = oneNode(timing, (node) => node.inputs.transcriptPictureIdentity !== undefined);
  assert.equal(beforePicture.id, timingPicture.id);
  assert.notEqual(beforePicture.contentHash, timingPicture.contentHash);
});

test("TranscriptPicture checker and compiler reject detached use, locator, stream, rate, and cursor drift while admitting a proxy for lock proof", () => {
  compileDiagnostic(
    source.replace(
      "Sequence(duration: 25s / 24) {",
      "TranscriptPicture(edit: quote, source: camera);\n    Sequence(duration: 25s / 24) {",
    ),
    "CUT_TRANSCRIPT_SCOPE",
  );
  compileDiagnostic(
    source.replace('video("assets/answer.mov"', 'video("assets/other.mov"'),
    "CUT_TRANSCRIPT_MEDIA",
  );
  compileDiagnostic(
    source.replace("videoStream: 0", "videoStream: 2"),
    "CUT_TRANSCRIPT_MEDIA",
  );
  const proxied = compile(source.replace(
    'video("assets/answer.mov", videoStream: 0',
    'video("assets/answer.mov", proxy: "assets/answer-proxy.mov", videoStream: 0',
  ));
  assert.deepEqual(proxied.resources.camera.proxy, { locator: "assets/answer-proxy.mov" });
  compileDiagnostic(
    source,
    "CUT_TRANSCRIPT_PICTURE_TIME",
    transcript("frames", { numerator: "3", denominator: "5" }, { numerator: "25", denominator: "1" }),
  );
  compileDiagnostic(
    source.replace("Gap(duration: 1s / 2);", "Gap(duration: 13s / 24);"),
    "CUT_TRANSCRIPT_PICTURE_TIME",
  );
  compileDiagnostic(
    source,
    "CUT_TRANSCRIPT_PICTURE_TIME",
    transcript(
      "frames",
      { numerator: "3", denominator: "5" },
      { numerator: "24", denominator: "1" },
      { numerator: "-1", denominator: "4" },
    ),
  );
  compileDiagnostic(
    source,
    "CUT_TRANSCRIPT_PICTURE_TIME",
    transcript(
      "frames",
      { numerator: "3", denominator: "5" },
      { numerator: "24", denominator: "1" },
      { numerator: "5", denominator: "1" },
    ),
  );
});

test("strict IR admission re-derives TranscriptPicture media, range, destination, identity, and direct owner", () => {
  const ir = compile();
  const picture = oneNode(ir, (node) => node.inputs.transcriptPictureIdentity !== undefined);
  const track = oneNode(ir, (node) => node.op === "cut.edit.picture_track");

  strictFailure(ir, (copy) => {
    copy.nodes[picture.id]!.inputs.transcriptPictureIdentity = {
      kind: "string",
      value: "0".repeat(64),
    };
  }, "CUT_IR_HASH", /transcriptPictureIdentity\.value$/u);
  strictFailure(ir, (copy) => {
    const range = copy.nodes[picture.id]!.inputs.range;
    assert.equal(range?.kind, "range");
    if (range?.kind === "range" && range.end.kind === "quantity") {
      range.end.magnitude = { numerator: "2", denominator: "3" };
    }
  }, "CUT_IR_IDENTITY", /\.inputs\.range$/u);
  strictFailure(ir, (copy) => {
    copy.nodes[picture.id]!.interval.start = { numerator: "13", denominator: "24" };
  }, "CUT_IR_IDENTITY", /\.interval$/u);
  strictFailure(ir, (copy) => {
    copy.resources.camera.locator = "assets/forged.mov";
  }, "CUT_IR_IDENTITY", /\.inputs\.source\.id$/u);
  strictFailure(ir, (copy) => {
    copy.resources.camera.streamSelection = { video: 2, audio: 1 };
  }, "CUT_IR_REFERENCE", /\.inputs\.source\.id$/u);
  strictFailure(ir, (copy) => {
    const editorial = copy.nodes[track.id]!.editorial;
    assert.equal(editorial?.kind, "picture-track");
    if (editorial?.kind === "picture-track") {
      editorial.items = editorial.items.filter((item) => item.nodeId !== picture.id);
    }
  }, "CUT_IR_IDENTITY", /\.nodes\.[A-Za-z0-9_]+$/u);
  strictFailure(ir, (copy) => {
    copy.nodes[picture.id]!.op = "cut.edit.transcript_picture";
  }, "CUT_IR_ENUM", /\.op$/u);
  strictFailure(ir, (copy) => {
    copy.transcriptBindings![0]!.media.audioVideoPresentationDelta =
      rational(0);
  }, "CUT_IR_IDENTITY", /\.media\.audioVideoPresentationDelta$/u);
  strictFailure(ir, (copy) => {
    copy.transcriptBindings![0]!.media.audioVideoPresentationDelta =
      rational(1, 4);
  }, "CUT_IR_IDENTITY", /\.inputs\.range$/u);
  strictFailure(ir, (copy) => {
    copy.transcriptBindings![0]!.media.audioVideoPresentationDelta =
      rational(-1, 4);
  }, "CUT_IR_TIMING", /\.inputs\.transcriptBindingId$/u);
  strictFailure(ir, (copy) => {
    copy.transcriptBindings![0]!.media.audioVideoPresentationDelta =
      rational(5);
  }, "CUT_IR_TIMING", /\.inputs\.transcriptBindingId$/u);

  const shifted = compile(
    source,
    transcript(
      "frames",
      { numerator: "3", denominator: "5" },
      { numerator: "24", denominator: "1" },
      { numerator: "1", denominator: "4" },
    ),
  );
  const shiftedPicture = oneNode(
    shifted,
    (node) => node.inputs.transcriptPictureIdentity !== undefined,
  );
  strictFailure(shifted, (copy) => {
    delete copy.transcriptBindings![0]!.media.audioVideoPresentationDelta;
  }, "CUT_IR_IDENTITY", new RegExp(
    `\\.nodes\\.${shiftedPicture.id}\\.inputs\\.range$`,
    "u",
  ));
});

function transcriptPictureLockEvidence(
  ir: CutAVIR,
  sidecarBytes: Buffer,
  options: {
    videoDuration?: { numerator: string; denominator: string };
    audioFirstPts?: string;
    videoStart?: { numerator: string; denominator: string };
  } = {},
) {
  const binding = ir.transcriptBindings![0]!;
  const videoDuration = options.videoDuration ?? rational(5);
  const videoStart = options.videoStart ?? rational(0);
  const audioFirstPts = options.audioFirstPts ?? "0";
  const frameCountNumerator = BigInt(videoDuration.numerator) * 24n;
  const frameCountDenominator = BigInt(videoDuration.denominator);
  assert.equal(frameCountNumerator % frameCountDenominator, 0n);
  const frameCount = frameCountNumerator / frameCountDenominator;
  const startTickNumerator = BigInt(videoStart.numerator) * 24n;
  const startTickDenominator = BigInt(videoStart.denominator);
  assert.equal(startTickNumerator % startTickDenominator, 0n);
  const firstVideoTick = startTickNumerator / startTickDenominator;
  const file = (locator: string, sha256: string) => ({
    locator,
    basename: "answer.mov",
    bytes: 1,
    sha256,
  });
  const implementation = { name: "ffprobe", version: "test" };
  const streams = [
    {
      index: 0,
      type: "video",
      codec: "rawvideo",
      disposition: [],
      timeBase: rational(1, 24),
      start: videoStart,
      duration: videoDuration,
      frameRate: rational(24),
      width: 64,
      height: 64,
    },
    {
      index: 1,
      type: "audio",
      codec: "pcm_s16le",
      disposition: [],
      timeBase: rational(1, 48_000),
      start: rational(0),
      duration: rational(2),
      sampleRate: 48_000,
      channels: 1,
    },
  ];
  const audioWitness = {
    format: "cut-decoded-audio-samples",
    version: 2,
    method: "ffprobe-show-frames-audio-v2",
    quantization: "phase-floor-start-or-exact-end",
    trimSemantics: "decoder-output-sequence-plus-terminal-duration",
    phaseNumerator: "0",
    streamIndex: 1,
    firstPts: audioFirstPts,
    lastPts: (BigInt(audioFirstPts) + 48_000n).toString(),
    frameCount: "2",
    decoderOutputSampleCount: "96000",
    decoderPcmSha256: "b".repeat(64),
    decodedSampleCount: "96000",
    terminalTrimSamples: "0",
    durationPresentCount: "2",
    durationCoverage: "complete",
    recordsSha256: "c".repeat(64),
    timeBase: rational(1, 48_000),
    sampleRate: 48_000,
    leadingDiscontinuityFrameCount: "0",
    leadingDiscontinuitySampleCount: "0",
  } as const;
  const cadence = {
    format: "cut-decoded-video-cadence",
    version: 2,
    method: "ffprobe-show-frames-cfr-v2",
    quantization: "phase-floor",
    phaseNumerator: "0",
    streamIndex: 0,
    firstPts: firstVideoTick.toString(),
    lastPts: (firstVideoTick + frameCount - 1n).toString(),
    quantizedEndPts: (firstVideoTick + frameCount).toString(),
    frameCount: frameCount.toString(),
    durationPresentCount: frameCount.toString(),
    durationCoverage: "complete",
    recordsSha256: "d".repeat(64),
    timeBase: rational(1, 24),
    frameRate: rational(24),
  } as const;
  const transcriptResource = ir.resources[binding.transcriptResourceId]!;
  const audioResource = ir.resources[binding.audioResourceId]!;
  const videoResource = ir.resources.camera!;
  const sidecarSha256 = createHash("sha256").update(sidecarBytes).digest("hex");
  return {
    [transcriptResource.id]: {
      id: transcriptResource.id,
      kind: "data",
      locator: transcriptResource.locator,
      sha256: sidecarSha256,
      bytes: sidecarBytes.byteLength,
      probe: {
        kind: "bytes",
        identity: {
          format: "cut-byte-probe",
          version: 1,
          file: file(transcriptResource.locator, sidecarSha256),
        },
        coverage: { level: "bytes-only", excludes: [] },
      },
    },
    [audioResource.id]: {
      id: audioResource.id,
      kind: "audio",
      locator: audioResource.locator,
      sha256: mediaDigest,
      bytes: 1,
      probe: {
        kind: "media",
        identity: {
          format: "cut-media-probe",
          version: 1,
          implementation,
          file: file(audioResource.locator, mediaDigest),
          container: { names: ["mov"], duration: rational(2) },
          streams,
          chapters: [],
        },
        selected: {
          audio: {
            streamIndex: 1,
            duration: rational(2),
            durationSource: "decoded-audio-samples",
            timeBase: rational(1, 48_000),
            decodedAudioSamples: audioWitness,
          },
        },
      },
    },
    [videoResource.id]: {
      id: videoResource.id,
      kind: "video",
      locator: videoResource.locator,
      sha256: mediaDigest,
      bytes: 1,
      probe: {
        kind: "media",
        identity: {
          format: "cut-media-probe",
          version: 1,
          implementation,
          file: file(videoResource.locator, mediaDigest),
          container: { names: ["mov"], duration: videoDuration },
          streams,
          chapters: [],
        },
        selected: {
          video: {
            streamIndex: 0,
            duration: videoDuration,
            durationSource: "decoded-video-cadence",
            timeBase: rational(1, 24),
            frameRate: rational(24),
            decodedVideoCadence: cadence,
          },
        },
      },
    },
  } as unknown as Record<string, LockedResource>;
}

test("TranscriptPicture lock authenticates declared presentation delta and refuses omission or drift", async () => {
  const bytes = Buffer.from(transcript());
  const ir = compile(source, bytes.toString("utf8"));
  const matching = transcriptPictureLockEvidence(ir, bytes);
  await assert.doesNotReject(
    verifyCutTranscriptBindingsForLock(ir, matching, async () => bytes),
  );

  const expect = (path: RegExp) => (error: unknown) =>
    error instanceof CutTranscriptLockError
    && error.code === "CUT_TRANSCRIPT_LOCK_MEDIA"
    && path.test(error.path);
  await assert.rejects(
    verifyCutTranscriptBindingsForLock(
      ir,
      transcriptPictureLockEvidence(ir, bytes, {
        videoDuration: rational(47, 24),
      }),
      async () => bytes,
    ),
    expect(/\.media\.videoDuration$/u),
  );
  await assert.rejects(
    verifyCutTranscriptBindingsForLock(
      ir,
      transcriptPictureLockEvidence(ir, bytes, {
        audioFirstPts: "12000",
      }),
      async () => bytes,
    ),
    (error: unknown) => error instanceof CutTranscriptLockError
      && error.code === "CUT_TRANSCRIPT_LOCK_MEDIA"
      && /\.media\.audioVideoPresentationDelta$/u.test(error.path)
      && /omitted audioVideoPresentationDelta canonically asserts exact 0\/1s/u
        .test(error.message)
      && /observed audio-anchor minus video-anchor delta is 1\/4s/u
        .test(error.message),
  );
  await assert.rejects(
    verifyCutTranscriptBindingsForLock(
      ir,
      transcriptPictureLockEvidence(ir, bytes, {
        videoStart: rational(1, 24),
      }),
      async () => bytes,
    ),
    expect(/\.media\.audioVideoPresentationDelta$/u),
  );

  const positiveBytes = Buffer.from(transcript(
    "frames",
    { numerator: "3", denominator: "5" },
    { numerator: "24", denominator: "1" },
    { numerator: "1", denominator: "4" },
  ));
  const positive = compile(source, positiveBytes.toString("utf8"));
  await assert.doesNotReject(
    verifyCutTranscriptBindingsForLock(
      positive,
      transcriptPictureLockEvidence(positive, positiveBytes, {
        audioFirstPts: "12000",
      }),
      async () => positiveBytes,
    ),
  );
  await assert.rejects(
    verifyCutTranscriptBindingsForLock(
      positive,
      transcriptPictureLockEvidence(positive, positiveBytes),
      async () => positiveBytes,
    ),
    (error: unknown) => error instanceof CutTranscriptLockError
      && error.code === "CUT_TRANSCRIPT_LOCK_MEDIA"
      && /\.media\.audioVideoPresentationDelta$/u.test(error.path)
      && /declared audioVideoPresentationDelta 1\/4s/u.test(error.message)
      && /observed audio-anchor minus video-anchor delta is 0\/1s/u
        .test(error.message),
  );
  await assert.rejects(
    verifyCutTranscriptBindingsForLock(
      positive,
      transcriptPictureLockEvidence(positive, bytes, {
        audioFirstPts: "12000",
      }),
      async () => bytes,
    ),
    (error: unknown) => error instanceof CutTranscriptLockError
      && error.code === "CUT_TRANSCRIPT_LOCK_MEDIA"
      && /\.media$/u.test(error.path)
      && /ledger media authority does not exactly match/u.test(error.message),
  );

  const negativeBytes = Buffer.from(transcript(
    "frames",
    { numerator: "3", denominator: "5" },
    { numerator: "24", denominator: "1" },
    { numerator: "-1", denominator: "24" },
  ));
  const negative = compile(source, negativeBytes.toString("utf8"));
  await assert.doesNotReject(
    verifyCutTranscriptBindingsForLock(
      negative,
      transcriptPictureLockEvidence(negative, negativeBytes, {
        videoStart: rational(1, 24),
      }),
      async () => negativeBytes,
    ),
  );
});
