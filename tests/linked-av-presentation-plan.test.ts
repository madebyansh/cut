import assert from "node:assert/strict";
import test from "node:test";
import type { CutDecodedAudioSamplesV2 } from "../lib/language/audio-sample-witness";
import type { IRNode } from "../lib/language/ir";
import {
  CutMediaPresentationPlanError,
  linkedAvPresentationPlan,
} from "../lib/language/media-presentation";
import { rational } from "../lib/language/rational";

const digest = "0".repeat(64);

function node(): IRNode {
  return {
    id: "clip",
    op: "cut.edit.clip",
    domain: "av",
    ownership: "root",
    interval: { start: rational(0), duration: rational(1) },
    inputs: { source: { kind: "resource-ref", id: "take" } },
    children: [],
    properties: {},
    effects: ["pure"],
    contentHash: digest,
    provenance: { module: "project.cut", span: { start: { line: 7, column: 5, offset: 100 }, end: { line: 7, column: 40, offset: 135 } }, symbol: "Clip" },
  };
}

function witness(firstPts: number, samples = 48_000, sampleRate = 48_000): CutDecodedAudioSamplesV2 {
  return {
    format: "cut-decoded-audio-samples",
    version: 2,
    method: "ffprobe-show-frames-audio-v2",
    quantization: "phase-floor-start-or-exact-end",
    trimSemantics: "decoder-output-sequence-plus-terminal-duration",
    phaseNumerator: "0",
    streamIndex: 1,
    firstPts: String(firstPts),
    lastPts: String(firstPts + Math.max(1, samples - 1)),
    frameCount: "2",
    decoderOutputSampleCount: String(samples),
    decoderPcmSha256: digest,
    decodedSampleCount: String(samples),
    terminalTrimSamples: "0",
    durationPresentCount: "2",
    durationCoverage: "complete",
    recordsSha256: digest,
    timeBase: rational(1, sampleRate),
    sampleRate,
    leadingDiscontinuityFrameCount: "0",
    leadingDiscontinuitySampleCount: "0",
  };
}

function plan(options: { firstPts: number; samples?: number; sampleRate?: number; sourceStart?: number; duration?: number; destinationSampleRate?: number }) {
  const sampleRate = options.sampleRate ?? 48_000, samples = options.samples ?? sampleRate;
  return linkedAvPresentationPlan({
    node: node(),
    variant: "master",
    videoAnchor: rational(0),
    audioWitness: witness(options.firstPts, samples, sampleRate),
    audioDuration: rational(samples, sampleRate),
    pictureSourceStart: rational(options.sourceStart ?? 0, sampleRate),
    pictureDuration: rational(options.duration ?? sampleRate, sampleRate),
    destinationSampleRate: options.destinationSampleRate ?? 48_000,
  });
}

test("linked A/V plan materializes exact positive and negative presentation offsets", () => {
  const positive = plan({ firstPts: 12_000 });
  assert.deepEqual(positive.samples, {
    sourceSampleRate: 48_000,
    destinationSampleRate: 48_000,
    deltaSourceSamples: "12000",
    deltaDestinationSamples: "12000",
    pictureDurationDestinationSamples: "48000",
    leadingSilenceDestinationSamples: "12000",
    mediaDestinationSamples: "36000",
    trailingSilenceDestinationSamples: "0",
    decoderSourceStartSamples: "0",
    decoderSourceEndSamples: "36000",
  });
  assert.deepEqual(positive.media, {
    decoderSourceStart: rational(0), decoderSourceDuration: rational(3, 4), decoderSourceEnd: rational(3, 4),
    destinationStart: rational(1, 4), destinationDuration: rational(3, 4), destinationEnd: rational(1),
  });

  const negative = plan({ firstPts: -12_000 });
  assert.deepEqual(negative.samples, {
    sourceSampleRate: 48_000,
    destinationSampleRate: 48_000,
    deltaSourceSamples: "-12000",
    deltaDestinationSamples: "-12000",
    pictureDurationDestinationSamples: "48000",
    leadingSilenceDestinationSamples: "0",
    mediaDestinationSamples: "36000",
    trailingSilenceDestinationSamples: "12000",
    decoderSourceStartSamples: "12000",
    decoderSourceEndSamples: "48000",
  });
});

test("linked A/V plan intersects trims and distinguishes leading/trailing no-overlap silence", () => {
  const partial = plan({ firstPts: 36_000, samples: 24_000, sourceStart: 24_000, duration: 24_000 });
  assert.deepEqual(partial.samples, {
    sourceSampleRate: 48_000,
    destinationSampleRate: 48_000,
    deltaSourceSamples: "36000",
    deltaDestinationSamples: "36000",
    pictureDurationDestinationSamples: "24000",
    leadingSilenceDestinationSamples: "12000",
    mediaDestinationSamples: "12000",
    trailingSilenceDestinationSamples: "0",
    decoderSourceStartSamples: "0",
    decoderSourceEndSamples: "12000",
  });
  assert.equal(partial.intersection.hasMedia, true);

  const future = plan({ firstPts: 96_000 });
  assert.equal(future.media, null);
  assert.deepEqual(future.samples, {
    sourceSampleRate: 48_000, destinationSampleRate: 48_000,
    deltaSourceSamples: "96000", deltaDestinationSamples: "96000",
    pictureDurationDestinationSamples: "48000",
    leadingSilenceDestinationSamples: "48000", mediaDestinationSamples: "0", trailingSilenceDestinationSamples: "0",
    decoderSourceStartSamples: null, decoderSourceEndSamples: null,
  });

  const past = plan({ firstPts: -96_000 });
  assert.equal(past.media, null);
  assert.equal(past.samples.leadingSilenceDestinationSamples, "0");
  assert.equal(past.samples.trailingSilenceDestinationSamples, "48000");
});

test("linked A/V plan fails source-located when an offset misses either sample grid", () => {
  const linked = node(), audio = witness(0);
  assert.throws(
    () => linkedAvPresentationPlan({
      node: linked,
      variant: "proxy",
      videoAnchor: rational(1, 44_100),
      audioWitness: audio,
      audioDuration: rational(1),
      pictureSourceStart: rational(0),
      pictureDuration: rational(1),
      destinationSampleRate: 48_000,
    }),
    (error) => error instanceof CutMediaPresentationPlanError
      && error.code === "CUT_MEDIA_PRESENTATION_OFFSET_GRID"
      && error.variant === "proxy"
      && error.source.resourceId === "take"
      && error.source.line === 7
      && /delta\(audio-video\).*48000 Hz/u.test(error.message),
  );

  assert.throws(
    () => plan({ firstPts: 1, samples: 44_100, sampleRate: 44_100, destinationSampleRate: 48_000 }),
    (error) => error instanceof CutMediaPresentationPlanError
      && error.code === "CUT_MEDIA_PRESENTATION_OFFSET_GRID"
      && /48000 Hz/u.test(error.message),
  );
});
