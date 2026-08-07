import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { hash } from "../lib/core/stable";
import { checkCutModule } from "../lib/language/checker";
import {
  compileCutModule,
  CutCompileError,
  type CutCompileInputs,
} from "../lib/language/compiler";
import type { CutAVIR, IRNode, IRTranscriptBindingV1 } from "../lib/language/ir";
import { parseCutLanguage } from "../lib/language/parser";
import {
  addRational,
  compareRational,
  rational,
  subtractRational,
} from "../lib/language/rational";
import { finalizeGraphHashes } from "../lib/runtime/graph";
import {
  prepareReferenceCaptionTrack,
  referenceCaptionCueAt,
  ReferenceCaptionLegibilityError,
  referenceCaptionSvg,
  referenceTranscriptCaptionMinimumHorizontalScale,
  referenceTranscriptCaptionConfig,
} from "../lib/runtime/reference/caption-render";
import { ReferenceMediaProfileStateError } from "../lib/runtime/reference/media-profile-state";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

const fontFixture = resolve(
  "examples/fixtures/Geist-Regular.ttf",
);
const audioBytes = Buffer.from("CUT transcript caption audio authority v1");

function sha256(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function sidecar(secondWord = "story.") {
  return JSON.stringify({
    format: "cut-transcript",
    version: 1,
    media: {
      sha256: sha256(audioBytes),
      audioStreamIndex: 0,
      audioSampleRate: 48_000,
      duration: { numerator: "2", denominator: "1" },
    },
    words: [
      {
        id: "w1",
        start: { numerator: "1001", denominator: "48000" },
        end: { numerator: "2167", denominator: "8000" },
        text: "A",
        join: "none",
        speaker: "narrator",
      },
      {
        id: "w2",
        start: { numerator: "2167", denominator: "8000" },
        end: { numerator: "25003", denominator: "48000" },
        text: secondWord,
        join: "space",
        speaker: "narrator",
      },
      {
        id: "w3",
        start: { numerator: "37003", denominator: "48000" },
        end: { numerator: "12251", denominator: "12000" },
        text: "Then",
        join: "space",
        speaker: "narrator",
      },
      {
        id: "w4",
        start: { numerator: "12251", denominator: "12000" },
        end: { numerator: "4067", denominator: "3200" },
        text: "another",
        join: "space",
        speaker: "guest",
      },
      {
        id: "w5",
        start: { numerator: "4067", denominator: "3200" },
        end: { numerator: "36503", denominator: "24000" },
        text: "voice.",
        join: "space",
        speaker: "guest",
      },
    ],
  });
}

const source = `cut 0.4;
project "transcript caption runtime";
import { transcriptEdit } from "@cut/edit";
import { TranscriptCaptions } from "cut:visual";
asset words: DataAsset = data("assets/answer.transcript.json");
asset voice: AudioAsset = audio("assets/answer.wav", stream: 0);
asset face: FontAsset = font("assets/Geist-Regular.ttf");
timeline main(duration: 2500ms, fps: 4, width: 320px, height: 180px, sampleRate: 48khz) {
  scene answer(duration: 2500ms) {
    let quote: TranscriptEdit = transcriptEdit(
      transcript: words,
      source: voice,
      from: "w1",
      through: "w5",
      at: 500ms
    );
    at 250ms {
      TranscriptCaptions(
        edit: quote,
        font: face,
        maxWords: 2,
        size: 22px,
        color: #ffffff,
        background: #000000d9,
        position: "bottom",
        align: "center",
        safeX: 5%,
        safeY: 5%,
        maxWidth: 90%,
        padding: 8px,
        radius: 6px,
        lineHeight: 110%
      );
    }
  }
}
export out = render(main, width: 320px, height: 180px, codec: "h264");`;

function compile(transcript = sidecar(), program = source) {
  const parsed = parseCutLanguage(program);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(
    checked.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
    JSON.stringify(checked.diagnostics),
  );
  const inputs: CutCompileInputs = {
    transcriptSidecars: new Map([["words", transcript]]),
  };
  try {
    return compileCutModule(
      parsed.module,
      {},
      undefined,
      undefined,
      inputs,
    ).ir;
  } catch (error) {
    if (error instanceof CutCompileError) {
      throw new Error(JSON.stringify(error.result.diagnostics));
    }
    throw error;
  }
}

function transcriptNode(ir: CutAVIR) {
  const matches = Object.values(ir.nodes).filter(
    (node) => node.op === "cut.visual.transcript_captions",
  );
  assert.equal(matches.length, 1);
  return matches[0]!;
}

function transcriptBinding(ir: CutAVIR) {
  assert.equal(ir.transcriptBindings?.length, 1);
  return ir.transcriptBindings![0]!;
}

async function lockedProject(secondWord = "story.") {
  return lockedProjectFrom(sidecar(secondWord), source);
}

async function lockedProjectFrom(transcript: string, program: string) {
  const root = await mkdtemp(resolve(tmpdir(), "cut-transcript-captions-"));
  const assets = resolve(root, "assets");
  await mkdir(assets);
  await Promise.all([
    writeFile(resolve(assets, "answer.transcript.json"), transcript),
    writeFile(resolve(assets, "answer.wav"), audioBytes),
    copyFile(fontFixture, resolve(assets, "Geist-Regular.ttf")),
  ]);
  const ir = compile(transcript, program);
  for (const resource of Object.values(ir.resources)) {
    const bytes = await readFile(resolve(root, resource.locator));
    resource.state = "locked";
    resource.sha256 = sha256(bytes);
    resource.metadata = {
      ...resource.metadata,
      bytes: bytes.byteLength,
      lockVersion: 2,
    };
  }
  ir.determinism.semantic = "locked";
  finalizeGraphHashes(ir);
  return { root, ir };
}

function mappedSceneTime(
  binding: IRTranscriptBindingV1,
  sourceTime: IRTranscriptBindingV1["words"][number]["start"],
) {
  return addRational(
    binding.destinationRange.start,
    subtractRational(sourceTime, binding.sourceRange.start),
  );
}

function isMillisecondExact(value: { numerator: string; denominator: string }) {
  return (BigInt(value.numerator) * 1_000n) % BigInt(value.denominator) === 0n;
}

function selectedTranscriptText(binding: IRTranscriptBindingV1) {
  return binding.words.map((word, index) =>
    `${index > 0 && word.join === "space" ? " " : ""}${word.text}`).join("");
}

async function renderedFrames(project: Awaited<ReturnType<typeof lockedProject>>) {
  const session = validateReferenceSession(project.ir, "out");
  const scene = project.ir.scenes[session.composition.sceneIds[0]!]!;
  const renderer = new ReferenceVisualRenderer(
    project.ir,
    session.composition,
    project.root,
    resolve(project.root, ".cut", "transcript-caption-cache"),
  );
  try {
    await renderer.prepare();
    const frames = [];
    for (let frame = 0; frame < 10; frame += 1) {
      frames.push(await renderer.sceneFrame(scene, frame, false));
    }
    return frames;
  } finally {
    await renderer.closeAndWait();
  }
}

test("TranscriptCaptions derives exact professional groups on the node-local clock", async () => {
  const project = await lockedProject();
  try {
    const session = validateReferenceSession(project.ir, "out");
    const node = transcriptNode(project.ir);
    const binding = transcriptBinding(project.ir);
    const config = referenceTranscriptCaptionConfig(
      node,
      project.ir,
      session.composition,
    );
    assert.ok(config);
    assert.deepEqual(node.interval.start, rational(1, 4));
    assert.equal(config.groupingAlgorithm, "cut-transcript-caption-groups-v2");
    assert.deepEqual(config.meaningfulGap, rational(1, 4));
    assert.equal(config.maxWords, 2);
    assert.equal(config.softLineCodePointBudget, 24);
    assert.equal(
      config.minimumHorizontalScale,
      referenceTranscriptCaptionMinimumHorizontalScale,
    );
    assert.deepEqual(
      config.track.cues.map((cue) => cue.lines),
      [["A story."], ["Then"], ["another voice."]],
      "maxWords, sentence-final punctuation, the 250ms gap, and speaker change all close groups",
    );

    const [first, second, third] = config.track.cues;
    assert.ok(first && second && third);
    assert.deepEqual(
      addRational(node.interval.start, first.start),
      mappedSceneTime(binding, binding.words[0]!.start),
    );
    assert.deepEqual(
      addRational(node.interval.start, first.end),
      mappedSceneTime(binding, binding.words[1]!.end),
    );
    assert.deepEqual(
      subtractRational(second.start, first.end),
      rational(1, 4),
      "the meaningful source silence remains an exact transparent destination gap",
    );
    assert.equal(
      compareRational(second.end, third.start),
      0,
      "the speaker boundary changes text at one exact contiguous time",
    );
    assert.equal(
      isMillisecondExact(first.end),
      false,
      "audio-sample-exact transcript time is not rounded to milliseconds",
    );
    assert.equal(
      referenceCaptionCueAt(
        config.track,
        subtractRational(first.end, rational(1, 48_000)),
      )?.id,
      first.id,
    );
    assert.equal(referenceCaptionCueAt(config.track, first.end), undefined);
    assert.equal(referenceCaptionCueAt(config.track, third.start)?.id, third.id);
    assert.match(config.trackIdentity, /^[a-f0-9]{64}$/u);
  } finally {
    await rm(project.root, { recursive: true, force: true });
  }
});

test("TranscriptCaptions omits the authored separator before a mid-transcript selection", () => {
  const ir = compile(
    sidecar(),
    source.replace('from: "w1"', 'from: "w2"'),
  );
  const node = transcriptNode(ir);
  const binding = transcriptBinding(ir);
  assert.equal(binding.words[0]?.join, "space");
  const config = referenceTranscriptCaptionConfig(
    node,
    ir,
    ir.compositions[0]!,
  );
  assert.ok(config);
  assert.ok(
    config.track.cues.every((cue) => cue.lines.every((line) => !line.startsWith(" "))),
    "a range selection never renders the separator that preceded its first word",
  );
});

test("TranscriptCaptions executes each grouping boundary independently at the exact silence threshold", async () => {
  const project = await lockedProject();
  try {
    const groups = (options: {
      gapSamples: number;
      maxWords: number;
      secondWord: string;
      oneSpeaker: boolean;
      finalPunctuation: boolean;
    }) => {
      const ir = structuredClone(project.ir);
      const node = transcriptNode(ir);
      const binding = transcriptBinding(ir);
      const [first, second, third, fourth, fifth] = binding.words;
      assert.ok(first && second && third && fourth && fifth);
      second.text = options.secondWord;
      third.start = addRational(
        second.end,
        rational(options.gapSamples, 48_000),
      );
      fifth.text = options.finalPunctuation ? "voice." : "voice";
      if (options.oneSpeaker) {
        for (const word of binding.words) word.speaker = "narrator";
      }
      binding.text = selectedTranscriptText(binding);
      node.inputs.maxWords = {
        kind: "quantity",
        dimension: "scalar",
        magnitude: rational(options.maxWords),
        unit: "scalar",
      };
      rewriteCaptionIdentity(ir);
      const config = referenceTranscriptCaptionConfig(
        node,
        ir,
        ir.compositions[0]!,
      );
      assert.ok(config);
      return config.track.cues.map((cue) => cue.lines);
    };

    assert.deepEqual(
      groups({
        gapSamples: 12_000,
        maxWords: 64,
        secondWord: "story",
        oneSpeaker: true,
        finalPunctuation: false,
      }),
      [["A story"], ["Then another voice"]],
      "exactly 250ms closes a cue without another active boundary",
    );
    assert.deepEqual(
      groups({
        gapSamples: 11_999,
        maxWords: 64,
        secondWord: "story",
        oneSpeaker: true,
        finalPunctuation: false,
      }),
      [["A story Then", "another voice"]],
      "one audio sample below 250ms remains in one deterministically balanced two-line cue",
    );
    assert.deepEqual(
      groups({
        gapSamples: 0,
        maxWords: 2,
        secondWord: "story",
        oneSpeaker: true,
        finalPunctuation: false,
      }),
      [["A story"], ["Then another"], ["voice"]],
      "maxWords is a hard ceiling without punctuation, silence, or speaker changes",
    );
    assert.deepEqual(
      groups({
        gapSamples: 0,
        maxWords: 64,
        secondWord: "story.",
        oneSpeaker: true,
        finalPunctuation: false,
      }),
      [["A story."], ["Then another voice"]],
      "sentence-final punctuation independently closes a cue",
    );
    assert.deepEqual(
      groups({
        gapSamples: 0,
        maxWords: 64,
        secondWord: "story",
        oneSpeaker: false,
        finalPunctuation: false,
      }),
      [["A story Then"], ["another voice"]],
      "speaker changes independently close a cue",
    );
  } finally {
    await rm(project.root, { recursive: true, force: true });
  }
});

test("TranscriptCaptions renders deterministic pixels with pre-start, gap, and post-end transparency", { timeout: 30_000 }, async () => {
  const original = await lockedProject();
  const corrected = await lockedProject("system.");
  try {
    const originalFrames = await renderedFrames(original);
    const correctedFrames = await renderedFrames(corrected);
    const originalHashes = originalFrames.map((frame) => sha256(frame.data));
    const correctedHashes = correctedFrames.map((frame) => sha256(frame.data));
    const transparentHash = sha256(Buffer.alloc(320 * 180 * 4));

    assert.deepEqual(
      [originalHashes[0], originalHashes[1], originalHashes[5], originalHashes[9]],
      [transparentHash, transparentHash, transparentHash, transparentHash],
      "scene pre-start, node-local pre-start, exact meaningful gap, and post-end frames stay transparent",
    );
    assert.equal(originalHashes[2], originalHashes[3]);
    assert.equal(originalHashes[3], originalHashes[4]);
    assert.notEqual(originalHashes[2], transparentHash);
    assert.notEqual(originalHashes[6], transparentHash);
    assert.equal(originalHashes[7], originalHashes[8]);
    assert.notEqual(originalHashes[6], originalHashes[7]);

    assert.notEqual(
      originalHashes[2],
      correctedHashes[2],
      "a legitimate transcript text correction changes caption pixels",
    );
    assert.equal(
      originalHashes[5],
      correctedHashes[5],
      "text correction does not manufacture pixels in an intentional gap",
    );
    const originalNode = transcriptNode(original.ir);
    const correctedNode = transcriptNode(corrected.ir);
    assert.equal(originalNode.id, correctedNode.id);
    assert.notEqual(originalNode.contentHash, correctedNode.contentHash);
  } finally {
    await Promise.all([
      rm(original.root, { recursive: true, force: true }),
      rm(corrected.root, { recursive: true, force: true }),
    ]);
  }
});

function balancedSidecar() {
  const transcript = JSON.parse(sidecar("story")) as {
    words: Array<{
      start: { numerator: string; denominator: string };
      text: string;
      speaker: string;
    }>;
  };
  transcript.words[2]!.start = {
    numerator: "6167",
    denominator: "8000",
  };
  transcript.words[3]!.speaker = "narrator";
  transcript.words[4]!.speaker = "narrator";
  transcript.words[4]!.text = "voice";
  return JSON.stringify(transcript);
}

test("TranscriptCaptions wraps one long group into at most two balanced lines without changing exact timing or deterministic pixels", { timeout: 30_000 }, async () => {
  const project = await lockedProjectFrom(
    balancedSidecar(),
    source.replace("maxWords: 2", "maxWords: 64"),
  );
  try {
    const session = validateReferenceSession(project.ir, "out");
    const node = transcriptNode(project.ir);
    const binding = transcriptBinding(project.ir);
    const config = referenceTranscriptCaptionConfig(
      node,
      project.ir,
      session.composition,
    );
    assert.ok(config);
    assert.equal(config.track.cues.length, 1);
    const cue = config.track.cues[0]!;
    assert.deepEqual(
      cue.lines,
      ["A story Then", "another voice"],
      "the word boundary minimizing the widest code-point line is stable",
    );
    assert.deepEqual(
      addRational(node.interval.start, cue.start),
      mappedSceneTime(binding, binding.words[0]!.start),
    );
    assert.deepEqual(
      addRational(node.interval.start, cue.end),
      mappedSceneTime(binding, binding.words.at(-1)!.end),
    );
    assert.equal(
      referenceCaptionCueAt(
        config.track,
        subtractRational(cue.end, rational(1, 48_000)),
      )?.id,
      cue.id,
    );
    assert.equal(referenceCaptionCueAt(config.track, cue.end), undefined);

    const prepared = prepareReferenceCaptionTrack(
      node,
      config,
      config.track,
      "assets/Geist-Regular.ttf",
      await readFile(resolve(project.root, "assets/Geist-Regular.ttf")),
    );
    const svg = referenceCaptionSvg(prepared, cue, 320, 180);
    assert.match(
      svg,
      /<title[^>]*>A story Then\nanother voice<\/title>/u,
    );
    assert.equal((svg.match(/<path d=/gu) ?? []).length, 2);
    assert.equal(
      sha256(Buffer.from(svg)),
      sha256(Buffer.from(referenceCaptionSvg(prepared, cue, 320, 180))),
      "the same locked track, font, and canvas produce byte-identical geometry",
    );
    assert.throws(
      () => referenceCaptionSvg(prepared, cue, 100, 180),
      (error: unknown) => error instanceof ReferenceCaptionLegibilityError
        && error.code === "CUT_CAPTION_LEGIBILITY"
        && error.path === `$.nodes[${JSON.stringify(node.id)}]`
        && error.requiredScale < error.minimumScale,
      "a caller cannot bypass preflight by silently rasterizing the prepared cue onto a narrower canvas",
    );

    const frames = await renderedFrames(project);
    const transparentHash = sha256(Buffer.alloc(320 * 180 * 4));
    const activeHashes = frames.slice(2, 8).map((frame) => sha256(frame.data));
    assert.ok(activeHashes.every((frameHash) => frameHash !== transparentHash));
    assert.equal(
      new Set(activeHashes).size,
      1,
      "wrapping changes layout only; one exact cue remains one stable pixel surface",
    );
  } finally {
    await rm(project.root, { recursive: true, force: true });
  }
});

test("TranscriptCaptions refuses an unbreakable line below the explicit horizontal-scale floor", async () => {
  const project = await lockedProject("W".repeat(80));
  try {
    const session = validateReferenceSession(project.ir, "out");
    const node = transcriptNode(project.ir);
    const config = referenceTranscriptCaptionConfig(
      node,
      project.ir,
      session.composition,
    );
    assert.ok(config);
    const fontBytes = await readFile(
      resolve(project.root, "assets/Geist-Regular.ttf"),
    );
    assert.throws(
      () => prepareReferenceCaptionTrack(
        node,
        config,
        config.track,
        "assets/Geist-Regular.ttf",
        fontBytes,
      ),
      (error: unknown) => {
        assert.ok(error instanceof ReferenceCaptionLegibilityError);
        assert.equal(error.code, "CUT_CAPTION_LEGIBILITY");
        assert.equal(error.minimumScale, 0.85);
        assert.ok(error.requiredScale < error.minimumScale);
        assert.equal(error.lineNumber, 2);
        assert.equal(error.source.nodeId, node.id);
        assert.equal(error.path, `$.nodes[${JSON.stringify(node.id)}]`);
        assert.match(
          error.message,
          /CUT_CAPTION_LEGIBILITY:.*cut\.visual\.transcript_captions at .*:\d+:\d+.*below 0\.85/u,
        );
        return true;
      },
    );
  } finally {
    await rm(project.root, { recursive: true, force: true });
  }
});

function rewriteCaptionIdentity(ir: CutAVIR) {
  const binding = transcriptBinding(ir);
  transcriptNode(ir).inputs.transcriptCaptionIdentity = {
    kind: "string",
    value: hash({
      selectedIdsSha256: binding.selectedIdsSha256,
      text: binding.text,
      words: binding.words,
      sourceRange: binding.sourceRange,
      destinationRange: binding.destinationRange,
    }),
  };
}

test("TranscriptCaptions rejects forged binding, timing, grouping, and media authority before rendering", async () => {
  const project = await lockedProject();
  try {
    const composition = project.ir.compositions[0]!;
    const reject = (
      mutate: (ir: CutAVIR, node: IRNode, binding: IRTranscriptBindingV1) => void,
      expected: RegExp,
    ) => {
      const ir = structuredClone(project.ir);
      const node = transcriptNode(ir);
      const binding = transcriptBinding(ir);
      mutate(ir, node, binding);
      finalizeGraphHashes(ir);
      assert.throws(
        () => referenceTranscriptCaptionConfig(node, ir, ir.compositions[0]!),
        expected,
      );
    };

    reject((_ir, node) => {
      node.inputs.transcriptBindingId = { kind: "string", value: "missing" };
    }, /exactly one transcript binding/);
    reject((_ir, node) => {
      node.inputs.transcriptCaptionIdentity = {
        kind: "string",
        value: "f".repeat(64),
      };
    }, /identity does not authenticate/);
    reject((_ir, _node, binding) => {
      binding.text = "forged";
    }, /text contradicts/);
    reject((ir, _node, binding) => {
      binding.words[1]!.start = subtractRational(
        binding.words[0]!.end,
        rational(1, 48_000),
      );
      rewriteCaptionIdentity(ir);
    }, /malformed, overlapping, or out-of-range/);
    reject((ir, _node, binding) => {
      binding.selectedIdsSha256 = "e".repeat(64);
      rewriteCaptionIdentity(ir);
    }, /selected-word identity is stale/);
    reject((ir, _node, binding) => {
      binding.words[1]!.id = binding.words[0]!.id;
      binding.selectedIdsSha256 = hash(
        JSON.stringify(binding.words.map((word) => word.id)),
      );
      rewriteCaptionIdentity(ir);
    }, /malformed, overlapping, or out-of-range/);
    reject((ir, _node, binding) => {
      binding.words[0]!.text = "hello\u202e";
      binding.text = selectedTranscriptText(binding);
      rewriteCaptionIdentity(ir);
    }, /malformed, overlapping, or out-of-range/);
    reject((ir, _node, binding) => {
      binding.words[0]!.text = "hello\ufdd0";
      binding.text = selectedTranscriptText(binding);
      rewriteCaptionIdentity(ir);
    }, /malformed, overlapping, or out-of-range/);
    reject((ir, _node, binding) => {
      binding.words[0]!.text = "hello\u200f";
      binding.text = selectedTranscriptText(binding);
      rewriteCaptionIdentity(ir);
    }, /malformed, overlapping, or out-of-range/);
    reject((ir, _node, binding) => {
      binding.words[0]!.speaker = "\ud800";
      rewriteCaptionIdentity(ir);
    }, /malformed, overlapping, or out-of-range/);
    reject((_ir, node) => {
      node.inputs.maxWords = {
        kind: "quantity",
        dimension: "scalar",
        magnitude: rational(65),
        unit: "scalar",
      };
    }, /maxWords.*1 through 64/);
    reject((ir, _node, binding) => {
      binding.destinationRange.start = rational(5, 4);
      rewriteCaptionIdentity(ir);
    }, /destination must fit completely/);
    reject((_ir, _node, binding) => {
      binding.media.sha256 = "b".repeat(64);
    }, /media authority contradicts/);

    const unverifiedProxy = structuredClone(project.ir);
    const unverifiedAudio = unverifiedProxy.resources[transcriptBinding(unverifiedProxy).audioResourceId]!;
    unverifiedAudio.sha256 = "c".repeat(64);
    unverifiedAudio.metadata = {
      ...unverifiedAudio.metadata,
      activeMediaVariant: "proxy",
      authoredProxy: true,
    };
    assert.throws(
      () => referenceTranscriptCaptionConfig(
        transcriptNode(unverifiedProxy),
        unverifiedProxy,
        unverifiedProxy.compositions[0]!,
      ),
      (error: unknown) => error instanceof ReferenceMediaProfileStateError
        && error.code === "CUT_PROXY_PROFILE_STATE",
      "serialized or hand-forged proxy markers cannot authorize transcript media substitution",
    );

    assert.ok(
      referenceTranscriptCaptionConfig(
        transcriptNode(project.ir),
        project.ir,
        composition,
      ),
      "the untouched locked ledger remains admissible",
    );
  } finally {
    await rm(project.root, { recursive: true, force: true });
  }
});
