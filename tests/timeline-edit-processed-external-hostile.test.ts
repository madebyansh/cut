import assert from "node:assert/strict";
import {
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import {
  CutAvIrValidationError,
  loadCutAvIr,
} from "../lib/language/ir-loader";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { finalizeGraphHashes } from "../lib/runtime/graph";
import { renderReferenceAudioArtifact } from "../lib/runtime/reference/audio-cache";
import {
  ReferenceTimelineEditMaterializationError,
  validateReferenceTimelineEditMaterializations,
} from "../lib/runtime/reference/timeline-edit";

const sampleRate = 48_000;

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(
    parsed.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
    JSON.stringify(parsed.diagnostics),
  );
  try {
    return compileCutModule(parsed.module).ir;
  } catch (error) {
    if (error instanceof CutCompileError) {
      assert.fail(JSON.stringify(error.result.diagnostics));
    }
    throw error;
  }
}

function processedExternalProgram(options: Readonly<{
  body?: string;
  headHandleMilliseconds?: number;
  sourceStartMilliseconds?: number;
  sourceEndMilliseconds?: number;
  title?: string;
}> = {}) {
  const headHandle = options.headHandleMilliseconds ?? 10;
  const sourceStart = options.sourceStartMilliseconds ?? 10;
  const sourceEnd = options.sourceEndMilliseconds ?? 30;
  const body = options.body
    ?? `Gain(amount: -3db) {
          AudioClip(source: voice, range: ${sourceStart}ms ..< ${sourceEnd}ms);
        }`;
  return `cut 0.4;
project "${options.title ?? "processed external hostile fixture"}";
import {
  AudioTrack, AudioRegion, TimelineEdit, editSelection, avTime, editSlip
} from "@cut/edit";
import { AudioClip, Gain, Reverb, TimeStretch } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 20ms, fps: 50, sampleRate: 48khz) {
  scene only(duration: 20ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioRegion(
        destination: 0ms ..< 20ms,
        headHandle: ${headHandle}ms,
        tailHandle: 10ms,
        editId: "line",
        role: "dialogue"
      ) {
        ${body}
      }
    }
    TimelineEdit(id: "processed-external", operations: [
      editSlip(
        selection: editSelection(trackIds: ["dialogue"], originIds: ["line"]),
        range: 0ms ..< 20ms,
        by: avTime(audio: -4ms)
      )
    ]);
  }
}
export out = render(main);`;
}

function directFadedTransitionProgram() {
  return `cut 0.4;
project "direct faded transition hostile fixture";
import {
  AudioTrack, TimelineEdit, editSelection, avTime, editTransition
} from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 20ms, fps: 50, sampleRate: 48khz) {
  scene only(duration: 20ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioClip(
        source: voice,
        range: 2ms ..< 12ms,
        destination: 0ms ..< 10ms,
        tailHandle: 2ms,
        fadeIn: 4ms,
        editId: "outgoing"
      );
      AudioClip(
        source: voice,
        range: 12ms ..< 22ms,
        destination: 10ms ..< 20ms,
        headHandle: 2ms,
        fadeOut: 4ms,
        editId: "incoming"
      );
    }
    TimelineEdit(id: "direct-faded-transition", operations: [
      editTransition(
        left: editSelection(
          trackIds: ["dialogue"],
          originIds: ["outgoing"]
        ),
        right: editSelection(
          trackIds: ["dialogue"],
          originIds: ["incoming"]
        ),
        at: avTime(audio: 10ms),
        duration: avTime(audio: 4ms),
        audioCurve: "equal-power"
      )
    ]);
  }
}
export out = render(main);`;
}

function monoPcm16Wave(frames: number) {
  const dataBytes = frames * 2;
  const result = Buffer.alloc(44 + dataBytes);
  result.write("RIFF", 0, "ascii");
  result.writeUInt32LE(36 + dataBytes, 4);
  result.write("WAVEfmt ", 8, "ascii");
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(sampleRate, 24);
  result.writeUInt32LE(sampleRate * 2, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write("data", 36, "ascii");
  result.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < frames; index += 1) {
    result.writeInt16LE(
      Math.round(Math.sin(index / 19) * 1_200 + Math.cos(index / 47) * 300),
      44 + index * 2,
    );
  }
  return result;
}

function monoPcm16Header(frames: number) {
  const dataBytes = frames * 2;
  const result = Buffer.alloc(44);
  result.write("RIFF", 0, "ascii");
  result.writeUInt32LE(36 + dataBytes, 4);
  result.write("WAVEfmt ", 8, "ascii");
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(sampleRate, 24);
  result.writeUInt32LE(sampleRate * 2, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write("data", 36, "ascii");
  result.writeUInt32LE(dataBytes, 40);
  return result;
}

async function writeSparseMonoPcm16Wave(path: string, seconds: number) {
  const frames = seconds * sampleRate;
  assert.ok(Number.isSafeInteger(frames));
  const header = monoPcm16Header(frames);
  const handle = await open(path, "w");
  try {
    await handle.write(header, 0, header.length, 0);
    await handle.truncate(header.length + frames * 2);
  } finally {
    await handle.close();
  }
}

async function lock(ir: CutAVIR, root: string) {
  const cutLock = await createCutLock(ir, root);
  await applyCutLock(ir, cutLock, root);
  return ir;
}

function evaluationNodes(ir: CutAVIR) {
  const result = Object.values(ir.nodes).filter((node) =>
    (node.op === "cut.edit.timeline_audio_origin"
      || node.op === "cut.edit.timeline_audio_view")
    && node.inputs.evaluationSource !== undefined);
  assert.equal(result.length, 2, "fixture must contain one origin and one view envelope");
  return result;
}

function setEvaluationPolicy(node: IRNode, value: string) {
  node.inputs.evaluationPolicy = { kind: "string", value };
}

function narrowFullDomain(node: IRNode) {
  const range = node.inputs.evaluationSource;
  const presentationZero = node.inputs.presentationZero;
  assert.equal(range?.kind, "range");
  assert.equal(presentationZero?.kind, "quantity");
  if (range?.kind !== "range" || range.start.kind !== "quantity"
    || presentationZero?.kind !== "quantity") {
    assert.fail("fixture lost its exact evaluation envelope");
  }
  range.start.magnitude = rational(1, 1_000);
  presentationZero.magnitude = rational(9, 1_000);
}

function expectSourceRefusal(
  label: string,
  source: string,
  code: string,
  message: RegExp,
) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, `${label}: ${JSON.stringify(parsed.diagnostics)}`);
  assert.throws(
    () => compileCutModule(parsed.module!),
    (error: unknown) => {
      if (!(error instanceof CutCompileError)) return false;
      const diagnostic = error.result.diagnostics.find((candidate) =>
        candidate.code === code && message.test(candidate.message));
      assert.ok(diagnostic, `${label}: ${JSON.stringify(error.result.diagnostics)}`);
      assert.ok(diagnostic.span.start.line > 0, `${label}: missing source line`);
      assert.ok(diagnostic.span.start.column > 0, `${label}: missing source column`);
      return true;
    },
    label,
  );
}

function nestedGains(depth: number, sourceEndSeconds: number) {
  let result = `AudioClip(source: voice, range: 10s ..< ${sourceEndSeconds}s);`;
  for (let index = 0; index < depth; index += 1) {
    result = `Gain(amount: -1db) { ${result} }`;
  }
  return result;
}

function boundedWorkProgram(seconds: number, processorCount: number) {
  const duration = seconds - 20;
  return `cut 0.4;
project "processed external bounded work ${seconds} ${processorCount}";
import {
  AudioTrack, AudioRegion, TimelineEdit, editSelection, avTime, editSlip
} from "@cut/edit";
import { AudioClip, Gain } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: ${duration}s, fps: 1, sampleRate: 48khz) {
  scene only(duration: ${duration}s) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioRegion(
        destination: 0s ..< ${duration}s,
        headHandle: 10s,
        tailHandle: 10s,
        editId: "line",
        role: "dialogue"
      ) {
        ${nestedGains(processorCount, seconds - 10)}
      }
    }
    TimelineEdit(id: "bounded-work", operations: [
      editSlip(
        selection: editSelection(trackIds: ["dialogue"], originIds: ["line"]),
        range: 0s ..< ${duration}s,
        by: avTime(audio: -1s)
      )
    ]);
  }
}
export out = render(main);`;
}

test("processed external policy and full-domain mutations fail closed before cache publication", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-processed-external-hostile-"));
  try {
    await writeFile(resolve(root, "voice.wav"), monoPcm16Wave(100 * 48));
    const valid = await lock(compile(processedExternalProgram()), root);
    const cases = [
      {
        label: "coherently mirrored direct-only policy",
        code: "CUT_IR_IDENTITY",
        runtimeCode: "CUT_TIMELINE_EDIT_RESULT",
        path: /timeline_audio_origin_.*evaluationPolicy\.value/u,
        mutate(ir: CutAVIR) {
          evaluationNodes(ir).forEach((node) =>
            setEvaluationPolicy(node, "selected-source-union-v1"));
        },
      },
      {
        label: "coherently mirrored but incomplete full domain",
        code: "CUT_IR_TIMING",
        runtimeCode: "CUT_TIMELINE_EDIT_RESULT",
        path: /timeline_audio_origin_.*evaluationSource/u,
        mutate(ir: CutAVIR) {
          evaluationNodes(ir).forEach(narrowFullDomain);
        },
      },
    ] as const;

    const before = (await readdir(root, { recursive: true })).sort();
    for (const hostileCase of cases) {
      const hostile = structuredClone(valid);
      hostileCase.mutate(hostile);
      finalizeGraphHashes(hostile);
      let loadFailure: unknown;
      try {
        loadCutAvIr(JSON.stringify(hostile));
      } catch (error) {
        loadFailure = error;
      }
      assert.ok(
        loadFailure instanceof CutAvIrValidationError,
        `${hostileCase.label}: ${String(loadFailure)}`,
      );
      assert.equal(loadFailure.code, hostileCase.code, hostileCase.label);
      assert.match(loadFailure.path, hostileCase.path, hostileCase.label);
      let renderFailure: unknown;
      try {
        await renderReferenceAudioArtifact(
          hostile,
          hostile.compositions[0]!,
          root,
        );
      } catch (error) {
        renderFailure = error;
      }
      assert.ok(
        renderFailure instanceof Error,
        `${hostileCase.label}: runtime unexpectedly accepted the hostile graph`,
      );
      assert.equal(
        "code" in renderFailure ? renderFailure.code : undefined,
        hostileCase.runtimeCode,
        `${hostileCase.label}: ${String(renderFailure)}`,
      );
      assert.deepEqual(
        (await readdir(root, { recursive: true })).sort(),
        before,
        `${hostileCase.label} allocated or published cache/output state`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct faded transition authority tampering fails before cache publication", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-direct-transition-hostile-"));
  try {
    await writeFile(resolve(root, "voice.wav"), monoPcm16Wave(48 * 40));
    const valid = await lock(compile(directFadedTransitionProgram()), root);
    const directEnvelopeNodes = Object.values(valid.nodes).filter((node) =>
      (node.op === "cut.edit.timeline_audio_origin"
        || node.op === "cut.edit.timeline_audio_view")
      && node.inputs.originKind?.kind === "string"
      && node.inputs.originKind.value === "direct-audio"
      && node.inputs.evaluationSource !== undefined);
    assert.equal(directEnvelopeNodes.length, 4);
    const track = Object.values(valid.nodes).find((node) =>
      node.op === "cut.edit.audio_track");
    assert.ok(track?.editorial?.kind === "audio-track");
    assert.equal(track.editorial.transitions?.length, 1);

    const cases = [
      {
        label: "direct policy changed to processed full-domain policy",
        mutate(ir: CutAVIR) {
          Object.values(ir.nodes).filter((node) =>
            (node.op === "cut.edit.timeline_audio_origin"
              || node.op === "cut.edit.timeline_audio_view")
            && node.inputs.originKind?.kind === "string"
            && node.inputs.originKind.value === "direct-audio"
            && node.inputs.evaluationSource !== undefined)
            .forEach((node) => setEvaluationPolicy(node, "full-declared-handle-domain-v1"));
        },
      },
      {
        label: "outgoing direct evaluation omits its transition tail",
        mutate(ir: CutAVIR) {
          const nodes = Object.values(ir.nodes).filter((node) =>
            (node.op === "cut.edit.timeline_audio_origin"
              || node.op === "cut.edit.timeline_audio_view")
            && node.inputs.originKind?.kind === "string"
            && node.inputs.originKind.value === "direct-audio"
            && node.inputs.evaluationSource?.kind === "range"
            && node.inputs.evaluationSource.start.kind === "quantity"
            && node.inputs.evaluationSource.start.magnitude.numerator === "1"
            && node.inputs.evaluationSource.start.magnitude.denominator === "500");
          assert.equal(nodes.length, 2);
          for (const node of nodes) {
            const range = node.inputs.evaluationSource;
            assert.equal(range?.kind, "range");
            if (range?.kind !== "range" || range.end.kind !== "quantity") {
              assert.fail("direct transition evaluation envelope disappeared");
            }
            range.end.magnitude = rational(3, 250);
          }
        },
      },
      {
        label: "transition consumes a forged outgoing source handle",
        mutate(ir: CutAVIR) {
          const audioTrack = Object.values(ir.nodes).find((node) =>
            node.op === "cut.edit.audio_track");
          assert.ok(audioTrack?.editorial?.kind === "audio-track");
          assert.equal(audioTrack.editorial.transitions?.length, 1);
          audioTrack.editorial.transitions[0]!.outgoingSource.start = rational(11, 1_000);
        },
      },
    ] as const;

    const before = (await readdir(root, { recursive: true })).sort();
    for (const hostileCase of cases) {
      const hostile = structuredClone(valid);
      hostileCase.mutate(hostile);
      finalizeGraphHashes(hostile);
      assert.throws(
        () => loadCutAvIr(JSON.stringify(hostile)),
        (error: unknown) => error instanceof CutAvIrValidationError
          && /^CUT_IR_(?:IDENTITY|TIMING)/u.test(error.code),
        `${hostileCase.label}: strict loader accepted forged direct-transition authority`,
      );
      await assert.rejects(
        renderReferenceAudioArtifact(hostile, hostile.compositions[0]!, root),
        (error: unknown) => error instanceof Error
          && "code" in error
          && /^CUT_(?:IR|TIMELINE_EDIT|AUDIO_EDIT)/u.test(String(error.code)),
        hostileCase.label,
      );
      assert.deepEqual(
        (await readdir(root, { recursive: true })).sort(),
        before,
        `${hostileCase.label} allocated or published cache/output state`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("processed external automation, non-innermost TimeStretch, branching, and tail topology are source-located refusals", () => {
  expectSourceRefusal(
    "automated processor",
    processedExternalProgram({
      body: `Gain(amount: -3db) as level {
        AudioClip(source: voice, range: 10ms ..< 30ms);
      }
      at 5ms { set level.amount = -2db; }`,
    }),
    "CUT_TIMELINE_EDIT_UNSUPPORTED",
    /only static Gain.*automation.*remain fail-closed/u,
  );
  expectSourceRefusal(
    "non-innermost retimed processor",
    processedExternalProgram({
      body: `TimeStretch(sourceDuration: 20ms, duration: 20ms) {
        Gain(amount: -3db) {
          AudioClip(source: voice, range: 10ms ..< 30ms);
        }
      }`,
    }),
    "CUT_AUDIO_REGION_RETIME_TOPOLOGY",
    /must be the innermost processor directly above its AudioClip/u,
  );
  expectSourceRefusal(
    "branching processor",
    processedExternalProgram({
      body: `Gain(amount: -3db) {
        AudioClip(source: voice, range: 10ms ..< 30ms);
        AudioClip(source: voice, range: 10ms ..< 30ms);
      }`,
    }),
    "CUT_AUDIO_REGION_SHAPE",
    /exactly one direct audio child/u,
  );
  expectSourceRefusal(
    "tail-producing processor",
    processedExternalProgram({
      body: `Reverb(wet: 20%) {
        AudioClip(source: voice, range: 10ms ..< 30ms);
      }`,
    }),
    "CUT_AUDIO_REGION_UNSUPPORTED",
    /only a boundary-contained unary Gain.*ending in one AudioClip/u,
  );
});

test("processed external source and processor-work ceilings fail before cache allocation", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-processed-external-work-"));
  try {
    await writeSparseMonoPcm16Wave(resolve(root, "voice.wav"), 350);
    const cases = [
      {
        label: "per-origin source sample ceiling",
        source: boundedWorkProgram(350, 1),
        message: /maximumSourceSamplesPerOrigin=16777216/u,
      },
      {
        label: "aggregate processor sample-work ceiling",
        source: boundedWorkProgram(300, 18),
        message: /processor-work=268435456/u,
      },
    ] as const;

    for (const workCase of cases) {
      const ir = await lock(compile(workCase.source), root);
      assert.throws(
        () => validateReferenceTimelineEditMaterializations(ir),
        (error: unknown) => error instanceof ReferenceTimelineEditMaterializationError
          && error.code === "CUT_TIMELINE_EDIT_LIMIT"
          && workCase.message.test(error.message),
        workCase.label,
      );
      const before = (await readdir(root, { recursive: true })).sort();
      await assert.rejects(
        renderReferenceAudioArtifact(ir, ir.compositions[0]!, root),
        (error: unknown) => error instanceof ReferenceTimelineEditMaterializationError
          && error.code === "CUT_TIMELINE_EDIT_LIMIT"
          && workCase.message.test(error.message),
        workCase.label,
      );
      assert.deepEqual(
        (await readdir(root, { recursive: true })).sort(),
        before,
        `${workCase.label} allocated or published cache/output state`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("processed external envelope and graph identities are deterministic cache inputs", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-processed-external-cache-"));
  try {
    await writeFile(resolve(root, "voice.wav"), monoPcm16Wave(100 * 48));
    const first = await lock(compile(processedExternalProgram()), root);
    const cold = await renderReferenceAudioArtifact(first, first.compositions[0]!, root);
    const hit = await renderReferenceAudioArtifact(first, first.compositions[0]!, root);
    assert.equal(cold.cache.status, "miss");
    assert.equal(hit.cache.status, "hit");
    assert.equal(cold.cache.key, hit.cache.key);
    assert.deepEqual(await readFile(cold.path), await readFile(hit.path));

    const changedEnvelope = await lock(compile(processedExternalProgram({
      headHandleMilliseconds: 12,
      sourceStartMilliseconds: 12,
      sourceEndMilliseconds: 32,
      title: "processed external changed full domain",
    })), root);
    const changed = await renderReferenceAudioArtifact(
      changedEnvelope,
      changedEnvelope.compositions[0]!,
      root,
    );
    assert.equal(changed.cache.status, "miss");
    assert.notEqual(changed.cache.key, cold.cache.key);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
