import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { CutAvIrValidationError, validateCutAvIr } from "../lib/language/ir-loader";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import {
  addRational,
  compareRational,
  rational,
  subtractRational,
} from "../lib/language/rational";
import { inspectCutIr } from "../lib/runtime/inspect";
import {
  referenceMasterAudioRootIds,
  renderReferenceAudioSelection,
} from "../lib/runtime/reference/audio";
import {
  createReferenceAudioCachePlan,
  createReferenceAudioToolchainIdentity,
  renderReferenceAudioArtifact,
} from "../lib/runtime/reference/audio-cache";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

const sampleRate = 48_000;

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

function boundarySlipProgram(direction: "head" | "tail", withEdit = true) {
  const by = direction === "head" ? "-4ms" : "4ms";
  const fades = direction === "head"
    ? "fadeOut: 2ms,"
    : "fadeIn: 2ms,";
  return `cut 0.4;
project "direct faded external ${direction} handle";
import { AudioTrack, TimelineEdit, editSelection, avTime, editSlip } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 20ms, fps: 50, sampleRate: 48khz) {
  scene only(duration: 20ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioClip(
        source: voice,
        range: 10ms ..< 30ms,
        destination: 0ms ..< 20ms,
        headHandle: 10ms,
        tailHandle: 10ms,
        ${fades}
        editId: "line"
      );
    }
    ${withEdit ? `TimelineEdit(id: "external-${direction}", operations: [
      editSlip(
        selection: editSelection(trackIds: ["dialogue"], originIds: ["line"]),
        range: 0ms ..< 20ms,
        by: avTime(audio: ${by})
      )
    ]);` : ""}
  }
}
export out = render(main);`;
}

function boundarySlipControlProgram(direction: "head" | "tail") {
  const start = direction === "head" ? "6ms" : "14ms";
  const end = direction === "head" ? "26ms" : "34ms";
  return `cut 0.4;
project "independent external ${direction} handle control";
import { AudioTrack } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 20ms, fps: 50, sampleRate: 48khz) {
  scene only(duration: 20ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioClip(source: voice, range: ${start} ..< ${end}, destination: 0ms ..< 20ms);
    }
  }
}
export out = render(main);`;
}

function slideProgram(direction: "left" | "right", control = false) {
  const by = direction === "right" ? "4ms" : "-4ms";
  const clips = control
    ? direction === "right"
      ? `AudioClip(source: voice, range: 10ms ..< 34ms, destination: 0ms ..< 24ms, fadeIn: 2ms);
        AudioClip(source: voice, range: 30ms ..< 50ms, destination: 24ms ..< 44ms, fadeIn: 2ms, fadeOut: 2ms);
        AudioClip(source: voice, range: 54ms ..< 70ms, destination: 44ms ..< 60ms, fadeOut: 2ms);`
      : `AudioClip(source: voice, range: 10ms ..< 26ms, destination: 0ms ..< 16ms, fadeIn: 2ms);
        AudioClip(source: voice, range: 30ms ..< 50ms, destination: 16ms ..< 36ms, fadeIn: 2ms, fadeOut: 2ms);
        AudioClip(source: voice, range: 46ms ..< 70ms, destination: 36ms ..< 60ms, fadeOut: 2ms);`
    : `AudioClip(source: voice, range: 10ms ..< 30ms, destination: 0ms ..< 20ms, headHandle: 10ms, tailHandle: 10ms, fadeIn: 2ms, editId: "left");
      AudioClip(source: voice, range: 30ms ..< 50ms, destination: 20ms ..< 40ms, headHandle: 10ms, tailHandle: 10ms, fadeIn: 2ms, fadeOut: 2ms, editId: "middle");
      AudioClip(source: voice, range: 50ms ..< 70ms, destination: 40ms ..< 60ms, headHandle: 10ms, tailHandle: 10ms, fadeOut: 2ms, editId: "right");`;
  return `cut 0.4;
project "${control ? "slide expanded control" : "direct faded external slide"} ${direction}";
import { AudioTrack${control ? "" : ", TimelineEdit, editSelection, avTime, editSlide"} } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 60ms, fps: 50, sampleRate: 48khz) {
  scene only(duration: 60ms) {
    AudioTrack(trackId: "dialogue", role: "dialogue") { ${clips} }
    ${control ? "" : `TimelineEdit(id: "slide", operations: [editSlide(
      selection: editSelection(trackIds: ["dialogue"], originIds: ["middle"], allowUnlinked: true),
      range: 20ms ..< 40ms,
      by: avTime(audio: ${by})
    )]);`}
  }
}
export out = render(main);`;
}

function monoPcm16Wave(samples: readonly number[]) {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii"); buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVEfmt ", 8, "ascii"); buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii"); buffer.writeUInt32LE(dataBytes, 40);
  samples.forEach((value, index) => buffer.writeInt16LE(value, 44 + index * 2));
  return buffer;
}

function fixtureSamples() {
  return Array.from({ length: 80 * 48 }, (_, index) => {
    const millisecond = Math.floor(index / 48);
    // Authored fades multiply only these zero-valued intervals, making the
    // independent no-fade control byte-exact while external head/tail samples
    // remain non-zero and origin-identifiable.
    if ((millisecond >= 10 && millisecond < 12)
      || (millisecond >= 48 && millisecond < 50)
      || (millisecond >= 50 && millisecond < 52)
      || (millisecond >= 68 && millisecond < 70)) return 0;
    return 2_000 + millisecond * 200;
  });
}

function origins(ir: CutAVIR) {
  return Object.values(ir.nodes).filter((node) =>
    node.op === "cut.edit.timeline_audio_origin") as IRNode[];
}

function envelopeOrigin(ir: CutAVIR) {
  const result = origins(ir).find((node) => node.inputs.evaluationSource !== undefined);
  assert.ok(result);
  return result;
}

function rangeInput(node: IRNode, name: string) {
  const value = node.inputs[name];
  assert.equal(value?.kind, "range");
  if (value?.kind !== "range" || value.start.kind !== "quantity" || value.end.kind !== "quantity") {
    assert.fail(`${node.id}.${name} is not one exact range`);
  }
  return { start: value.start.magnitude, end: value.end.magnitude };
}

async function lockAndRender(ir: CutAVIR, root: string, name: string) {
  const lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  validateCutAvIr(ir);
  const output = resolve(root, name);
  await renderReferenceAudioSelection(
    ir,
    ir.compositions[0]!,
    root,
    output,
    referenceMasterAudioRootIds(ir, ir.compositions[0]!),
    { outputFormat: "raw-stereo-f32le" },
  );
  return readFile(output);
}

test("direct faded 1x origins own authenticated zero-based buffers while authored placement stays unchanged", () => {
  const authorityIds: string[] = [];
  for (const direction of ["head", "tail"] as const) {
    const ir = compile(boundarySlipProgram(direction));
    assert.doesNotThrow(() => validateCutAvIr(ir));
    const origin = envelopeOrigin(ir), child = ir.nodes[origin.children[0]!]!;
    const evaluation = rangeInput(origin, "evaluationSource");
    const presentationZero = origin.inputs.presentationZero;
    assert.equal(presentationZero?.kind, "quantity");
    if (presentationZero?.kind !== "quantity") return;
    assert.equal(origin.inputs.fadeAnchorPolicy?.kind, "string");
    assert.equal(origin.inputs.fadeAnchorPolicy?.kind === "string"
      ? origin.inputs.fadeAnchorPolicy.value : undefined, "origin-relative-at-presentation-zero");
    assert.equal(origin.inputs.evaluationPolicy?.kind === "string"
      ? origin.inputs.evaluationPolicy.value : undefined, "selected-source-union-v1");
    assert.deepEqual(origin.interval, child.interval);
    assert.ok(compareRational(
      origin.interval.duration,
      subtractRational(evaluation.end, evaluation.start),
    ) < 0);
    assert.equal(compareRational(child.interval.duration, rational(1, 50)), 0);
    const inspected = inspectCutIr(ir, "") as unknown as {
      graph: { nodes: Array<{ id: string; timelineAudioMaterialization?: {
        kind: "origin" | "view";
        originNodeId: string;
        originAuthorityId: string;
        sourceAuthorityId: string;
        evaluationEnvelope?: unknown;
      } }> };
    };
    const materializations = inspected.graph.nodes
      .filter((node) => node.timelineAudioMaterialization?.evaluationEnvelope);
    assert.equal(materializations.length, 2, "one origin and one view must expose the envelope");
    const inspectedOrigin = materializations.find((node) =>
      node.timelineAudioMaterialization?.kind === "origin")?.timelineAudioMaterialization;
    const inspectedView = materializations.find((node) =>
      node.timelineAudioMaterialization?.kind === "view")?.timelineAudioMaterialization;
    assert.ok(inspectedOrigin && inspectedView);
    assert.equal(inspectedView.originNodeId, inspectedOrigin.originNodeId);
    assert.equal(inspectedView.originAuthorityId, inspectedOrigin.originAuthorityId);
    assert.equal(inspectedView.sourceAuthorityId, inspectedOrigin.sourceAuthorityId);
    authorityIds.push(inspectedOrigin.originAuthorityId);
    const expectedInspection = {
      source: {
        start: { ...evaluation.start },
        duration: subtractRational(evaluation.end, evaluation.start),
      },
      presentationZero: { ...presentationZero.magnitude },
      fadeAnchorPolicy: "origin-relative-at-presentation-zero",
      evaluationPolicy: "selected-source-union-v1",
    };
    for (const inspectedNode of materializations) {
      assert.deepEqual(
        inspectedNode.timelineAudioMaterialization?.evaluationEnvelope,
        expectedInspection,
      );
    }
  }
  assert.equal(authorityIds.length, 2);
  assert.notEqual(authorityIds[0], authorityIds[1], "head/tail envelopes must change origin authority");
});

test("audio artifact cache is cold, then hit, and a valid changed envelope misses", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-direct-envelope-cache-"));
  try {
    await writeFile(resolve(root, "voice.wav"), monoPcm16Wave(fixtureSamples()));
    const head = compile(boundarySlipProgram("head"));
    let lock = await createCutLock(head, root);
    await applyCutLock(head, lock, root);
    const cold = await renderReferenceAudioArtifact(head, head.compositions[0]!, root);
    const hit = await renderReferenceAudioArtifact(head, head.compositions[0]!, root);
    assert.equal(cold.cache.status, "miss");
    assert.equal(hit.cache.status, "hit");
    assert.equal(cold.cache.key, hit.cache.key);
    assert.deepEqual(await readFile(cold.path), await readFile(hit.path));

    const tail = compile(boundarySlipProgram("tail"));
    lock = await createCutLock(tail, root);
    await applyCutLock(tail, lock, root);
    const changed = await renderReferenceAudioArtifact(tail, tail.compositions[0]!, root);
    assert.equal(changed.cache.status, "miss");
    assert.notEqual(changed.cache.key, cold.cache.key);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct faded external head and tail PCM equal independent explicit-source controls and deterministic repeats", { timeout: 45_000 }, async () => {
  for (const direction of ["head", "tail"] as const) {
    const root = await mkdtemp(resolve(tmpdir(), `cut-direct-envelope-${direction}-`));
    try {
      await writeFile(resolve(root, "voice.wav"), monoPcm16Wave(fixtureSamples()));
      const actualIr = compile(boundarySlipProgram(direction));
      const controlIr = compile(boundarySlipControlProgram(direction));
      const actual = await lockAndRender(actualIr, root, "actual.f32le");
      const repeat = await lockAndRender(compile(boundarySlipProgram(direction)), root, "repeat.f32le");
      const control = await lockAndRender(controlIr, root, "control.f32le");
      assert.deepEqual(actual, repeat, `${direction} repeat changed PCM bytes`);
      assert.deepEqual(
        actual,
        control,
        `${direction} handle differs byte-for-byte from the independently authored exact source range`,
      );
      const frameBytes = 2 * 4;
      const externalFrame = direction === "head" ? 0 : 16 * 48;
      assert.notEqual(actual.readFloatLE(externalFrame * frameBytes), 0, `${direction} did not execute declared external handle samples`);

      const toolchain = createReferenceAudioToolchainIdentity(
        "ffmpeg version 7.1.1\nconfiguration: --direct-external-envelope-test",
      );
      const cache = createReferenceAudioCachePlan(
        actualIr,
        actualIr.compositions[0]!,
        referenceMasterAudioRootIds(actualIr, actualIr.compositions[0]!),
        toolchain,
      );
      assert.equal(cache.key, createReferenceAudioCachePlan(
        actualIr,
        actualIr.compositions[0]!,
        referenceMasterAudioRootIds(actualIr, actualIr.compositions[0]!),
        toolchain,
      ).key);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("three-origin editSlide executes both external tail/head directions against exact controls", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-direct-envelope-slide-"));
  try {
    await writeFile(resolve(root, "voice.wav"), monoPcm16Wave(fixtureSamples()));
    for (const direction of ["right", "left"] as const) {
      const actualIr = compile(slideProgram(direction));
      const controlIr = compile(slideProgram(direction, true));
      assert.equal(origins(actualIr).length, 3);
      assert.equal(
        origins(actualIr).filter((node) => node.inputs.evaluationSource !== undefined).length,
        1,
      );
      const actual = await lockAndRender(actualIr, root, `slide-${direction}-actual.f32le`);
      const repeat = await lockAndRender(
        compile(slideProgram(direction)),
        root,
        `slide-${direction}-repeat.f32le`,
      );
      const control = await lockAndRender(
        controlIr,
        root,
        `slide-${direction}-control.f32le`,
      );
      assert.deepEqual(actual, repeat, `${direction} slide repeat changed PCM`);
      assert.deepEqual(actual, control, `${direction} slide differs byte-for-byte from exact control`);
      const witnessMillisecond = direction === "right" ? 21 : 37;
      assert.notEqual(
        actual.readFloatLE(witnessMillisecond * 48 * 8),
        0,
        direction === "right"
          ? "left tail handle was not executed"
          : "right head handle was not executed",
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("partial, forged, and one-source-sample-over envelopes fail before output allocation", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-direct-envelope-hostile-"));
  try {
    await writeFile(resolve(root, "voice.wav"), monoPcm16Wave(fixtureSamples()));
    const base = compile(boundarySlipProgram("head"));
    const lock = await createCutLock(base, root);
    await applyCutLock(base, lock, root);
    const cases = [
      {
        name: "partial",
        mutate(node: IRNode) { delete node.inputs.presentationZero; },
      },
      {
        name: "policy",
        mutate(node: IRNode) { node.inputs.fadeAnchorPolicy = { kind: "string", value: "envelope-relative" }; },
      },
      {
        name: "one-sample-over",
        mutate(node: IRNode) {
          const range = node.inputs.evaluationSource;
          assert.equal(range?.kind, "range");
          if (range?.kind === "range" && range.end.kind === "quantity") {
            range.end.magnitude = addRational(range.end.magnitude, rational(1, sampleRate));
          }
        },
      },
    ] as const;
    for (const hostileCase of cases) {
      const hostile = structuredClone(base), origin = envelopeOrigin(hostile);
      hostileCase.mutate(origin);
      assert.throws(
        () => validateCutAvIr(hostile),
        (error: unknown) => error instanceof CutAvIrValidationError,
        hostileCase.name,
      );
      const output = resolve(root, `${hostileCase.name}.f32le`);
      const before = (await readdir(root, { recursive: true })).sort();
      await assert.rejects(
        renderReferenceAudioSelection(
          hostile,
          hostile.compositions[0]!,
          root,
          output,
          referenceMasterAudioRootIds(hostile, hostile.compositions[0]!),
          { outputFormat: "raw-stereo-f32le" },
        ),
        hostileCase.name,
      );
      assert.deepEqual((await readdir(root, { recursive: true })).sort(), before);
      assert.throws(() => validateReferenceSession(hostile));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private origin/view graphs without their exact live TimelineEdit plan fail direct and cache entry before publication", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-direct-envelope-claim-"));
  try {
    await writeFile(resolve(root, "voice.wav"), monoPcm16Wave(fixtureSamples()));
    const base = compile(boundarySlipProgram("head"));
    const lock = await createCutLock(base, root);
    await applyCutLock(base, lock, root);
    const toolchain = createReferenceAudioToolchainIdentity(
      "ffmpeg version 7.1.1\nconfiguration: --direct-envelope-claim-test",
    );
    for (const hostileCase of [
      {
        name: "omitted-plan",
        mutate(ir: CutAVIR) { delete ir.timelineEdits; },
      },
      {
        name: "foreign-plan",
        mutate(ir: CutAVIR) {
          (ir.timelineEdits![0] as { id: string }).id = "foreign-plan";
        },
      },
    ] as const) {
      const hostile = structuredClone(base);
      hostileCase.mutate(hostile);
      assert.throws(() => validateCutAvIr(hostile), (error: unknown) => {
        assert.ok(error instanceof CutAvIrValidationError);
        return true;
      }, hostileCase.name);
      const before = (await readdir(root, { recursive: true })).sort();
      assert.throws(
        () => createReferenceAudioCachePlan(
          hostile,
          hostile.compositions[0]!,
          referenceMasterAudioRootIds(hostile, hostile.compositions[0]!),
          toolchain,
        ),
        /CUT_TIMELINE_EDIT_REFERENCE|CUT_TIMELINE_EDIT_RESULT/u,
      );
      await assert.rejects(
        renderReferenceAudioSelection(
          hostile,
          hostile.compositions[0]!,
          root,
          resolve(root, `${hostileCase.name}.f32le`),
          referenceMasterAudioRootIds(hostile, hostile.compositions[0]!),
          { outputFormat: "raw-stereo-f32le" },
        ),
        /CUT_TIMELINE_EDIT_REFERENCE|CUT_TIMELINE_EDIT_RESULT/u,
      );
      assert.deepEqual((await readdir(root, { recursive: true })).sort(), before);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a 48k edit boundary that is off the locked 44.1k source grid fails before allocation", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-direct-envelope-grid-"));
  try {
    const samples = Array.from({ length: Math.round(0.08 * 44_100) }, () => 4_000);
    const wave = monoPcm16Wave(samples);
    wave.writeUInt32LE(44_100, 24);
    wave.writeUInt32LE(88_200, 28);
    await writeFile(resolve(root, "voice.wav"), wave);
    const ir = compile(boundarySlipProgram("head"));
    const lock = await createCutLock(ir, root);
    await applyCutLock(ir, lock, root);
    const before = (await readdir(root, { recursive: true })).sort();
    const toolchain = createReferenceAudioToolchainIdentity(
      "ffmpeg version 7.1.1\nconfiguration: --direct-envelope-grid-test",
    );
    assert.throws(
      () => createReferenceAudioCachePlan(
        ir,
        ir.compositions[0]!,
        referenceMasterAudioRootIds(ir, ir.compositions[0]!),
        toolchain,
      ),
      /locked 44100 Hz source sample grid/u,
    );
    await assert.rejects(
      renderReferenceAudioArtifact(ir, ir.compositions[0]!, root),
      /locked 44100 Hz source sample grid/u,
    );
    const output = resolve(root, "off-grid.f32le");
    await assert.rejects(
      renderReferenceAudioSelection(
        ir,
        ir.compositions[0]!,
        root,
        output,
        referenceMasterAudioRootIds(ir, ir.compositions[0]!),
        { outputFormat: "raw-stereo-f32le" },
      ),
      /locked 44100 Hz source sample grid/u,
    );
    assert.deepEqual((await readdir(root, { recursive: true })).sort(), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unlocked external-envelope source fails direct and cache entry before publication", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-direct-envelope-unlocked-"));
  try {
    await writeFile(resolve(root, "voice.wav"), monoPcm16Wave(fixtureSamples()));
    const base = compile(boundarySlipProgram("head"));
    const lock = await createCutLock(base, root);
    await applyCutLock(base, lock, root);
    const hostile = structuredClone(base);
    const resource = Object.values(hostile.resources)[0];
    assert.ok(resource);
    (resource as { state: string }).state = "declared";
    const before = (await readdir(root, { recursive: true })).sort();
    const toolchain = createReferenceAudioToolchainIdentity(
      "ffmpeg version 7.1.1\nconfiguration: --direct-envelope-unlocked-test",
    );
    assert.throws(
      () => createReferenceAudioCachePlan(
        hostile,
        hostile.compositions[0]!,
        referenceMasterAudioRootIds(hostile, hostile.compositions[0]!),
        toolchain,
      ),
      /locked external audio evaluation lost its selected native sample clock/u,
    );
    await assert.rejects(
      renderReferenceAudioSelection(
        hostile,
        hostile.compositions[0]!,
        root,
        resolve(root, "unlocked.f32le"),
        referenceMasterAudioRootIds(hostile, hostile.compositions[0]!),
        { outputFormat: "raw-stereo-f32le" },
      ),
      /locked external audio evaluation lost its selected native sample clock/u,
    );
    assert.deepEqual((await readdir(root, { recursive: true })).sort(), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
