import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { compileCutModule } from "../lib/language/compiler";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { renderReferenceAudio, renderReferenceAudioSelection } from "../lib/runtime/reference/audio";
import { ReferenceAudioPeakError } from "../lib/runtime/reference/audio-peak";
import {
  planReferenceAudioStems,
  ReferenceStemError,
  renderReferenceAudioStems as renderReferenceAudioStemsWithoutTestLock,
  type ReferenceAudioStemRenderOptions,
} from "../lib/runtime/reference/stems";
import { renderReferenceAudioStems, testStemLockSha256 } from "./reference-stem-test-helper";

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.equal(parsed.diagnostics.length, 0, parsed.diagnostics.map((item) => item.message).join("\n"));
  assert.ok(parsed.module);
  return compileCutModule(parsed.module).ir;
}

function pcm24Data(buffer: Buffer<ArrayBufferLike>) {
  assert.equal(buffer.toString("ascii", 0, 4), "RIFF");
  assert.equal(buffer.toString("ascii", 8, 12), "WAVE");
  let offset = 12, channels = 0, sampleRate = 0, blockAlign = 0, bits = 0, data: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4), size = buffer.readUInt32LE(offset + 4), body = offset + 8;
    if (id === "fmt ") { channels = buffer.readUInt16LE(body + 2); sampleRate = buffer.readUInt32LE(body + 4); blockAlign = buffer.readUInt16LE(body + 12); bits = buffer.readUInt16LE(body + 14); }
    if (id === "data") { data = buffer.subarray(body, body + size); break; }
    offset = body + size + (size % 2);
  }
  assert.equal(channels, 2); assert.equal(sampleRate, 48_000); assert.equal(blockAlign, 6); assert.equal(bits, 24); assert.ok(data.length > 0);
  const sample = (frame: number, channel: number) => {
    const position = frame * blockAlign + channel * 3; let value = data[position] | data[position + 1] << 8 | data[position + 2] << 16;
    if (value & 0x800000) value -= 0x1000000; return value / 0x800000;
  };
  return { frames: data.length / blockAlign, sample };
}

function monoSineWave(
  sampleRate: number,
  durationSeconds: number,
  frequency = 440,
  amplitude = 12_000,
) {
  const samples = Math.round(sampleRate * durationSeconds);
  const dataBytes = samples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples; index += 1) {
    buffer.writeInt16LE(
      Math.round(
        Math.sin(2 * Math.PI * frequency * index / sampleRate) * amplitude,
      ),
      44 + index * 2,
    );
  }
  return buffer;
}

const stemProgram = `cut 0.4;
project "Stem isolation";
import { Bus, Tone } from "@cut/audio";
timeline main(duration: 1s, fps: 24, sampleRate: 48khz) {
  Bus(name: "dialogue") {
    Tone(frequency: 1000hz, duration: 1s, amplitude: 10%);
  }
  Bus(name: "music") {
    at 250ms { Tone(frequency: 500hz, duration: 500ms, amplitude: 5%); }
  }
}
export out = render(main);`;

test("standalone stem export refuses missing, malformed, and unknown lock options before touching the project", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-stem-lock-contract-"));
  try {
    const ir = compile(stemProgram), composition = ir.compositions[0], output = resolve(root, "stems");
    await assert.rejects(
      renderReferenceAudioStemsWithoutTestLock(ir, composition, root, output, undefined as unknown as ReferenceAudioStemRenderOptions),
      (error) => error instanceof ReferenceStemError && error.code === "CUT_STEM_OPTION_CONTRACT",
    );
    await assert.rejects(
      renderReferenceAudioStemsWithoutTestLock(ir, composition, root, output, { lockSha256: "A".repeat(64) }),
      (error) => error instanceof ReferenceStemError && error.code === "CUT_STEM_LOCK_SHA256",
    );
    await assert.rejects(
      renderReferenceAudioStemsWithoutTestLock(ir, composition, root, output, { lockSha256: testStemLockSha256, hiddenRenderer: true } as unknown as ReferenceAudioStemRenderOptions),
      (error) => error instanceof ReferenceStemError && error.code === "CUT_STEM_OPTION_CONTRACT" && /hiddenRenderer/u.test(error.message),
    );
    assert.deepEqual(await readdir(root), [], "stem option refusal must precede destination, cache, resource, or media work");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("named Bus stems are isolated, exact, deterministic, and sum to the decoded pre-master", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-reference-stems-"));
  try {
    const ir = compile(stemProgram), composition = ir.compositions[0], plan = planReferenceAudioStems(ir, composition);
    assert.deepEqual(plan.routes.map(({ name, file }) => ({ name, file })), [
      { name: "dialogue", file: "dialogue.wav" },
      { name: "music", file: "music.wav" },
    ]);
    const rawMasterPath = resolve(root, "raw-master.wav");
    await renderReferenceAudio(ir, composition, root, rawMasterPath);
    const first = await renderReferenceAudioStems(ir, composition, root, resolve(root, "first"));
    const second = await renderReferenceAudioStems(ir, composition, root, resolve(root, "second"));

    assert.deepEqual(first.manifest, second.manifest);
    assert.equal(first.manifest.version, 5);
    assert.deepEqual(first.manifest.lock, { sha256: testStemLockSha256 });
    assert.equal(await readFile(first.manifestPath, "utf8"), await readFile(second.manifestPath, "utf8"));
    assert.equal(createHash("sha256").update(await readFile(first.manifestPath)).digest("hex"), first.manifestSha256);
    assert.equal(first.manifestSha256, second.manifestSha256);
    assert.deepEqual(first.manifest.relationship, { stage: "pre-master", mix: "decoded-sum-with-s24-rounding", normalization: "none", peakValidation: "exact-f32le-before-quantization", quantization: "nearest-ties-to-even" });

    const master = pcm24Data(await readFile(rawMasterPath));
    const dialogue = pcm24Data(await readFile(resolve(first.directory, "dialogue.wav")));
    const music = pcm24Data(await readFile(resolve(first.directory, "music.wav")));
    assert.equal(master.frames, 48_000); assert.equal(dialogue.frames, 48_000); assert.equal(music.frames, 48_000);
    assert.equal(music.sample(6_001, 0), 0, "music must be isolated before its exact placement");
    assert.ok(Math.abs(dialogue.sample(6_001, 0)) > .001, "dialogue must remain present before music starts");
    assert.equal(music.sample(40_001, 0), 0, "music must be isolated after its exact end");

    let maximumDecodedSumError = 0;
    for (let frame = 0; frame < master.frames; frame += 1) {
      for (let channel = 0; channel < 2; channel += 1) {
        maximumDecodedSumError = Math.max(maximumDecodedSumError, Math.abs(master.sample(frame, channel) - dialogue.sample(frame, channel) - music.sample(frame, channel)));
      }
    }
    assert.ok(maximumDecodedSumError <= 3 / 0x800000, `decoded stem sum error ${maximumDecodedSumError}`);

    for (const entry of first.manifest.stems) {
      const bytes = await readFile(resolve(first.directory, entry.file));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256);
      assert.equal(entry.samples, 48_000); assert.equal(entry.sampleRate, 48_000); assert.equal(entry.channels, 2); assert.equal(entry.sampleFormat, "s24le");
      assert.equal(entry.peak.expectedFrames, 48_000); assert.equal(entry.peak.observedFrames, 48_000); assert.equal(entry.peak.thresholdDbfs, 0);
      assert.match(entry.graphHash, /^[a-f0-9]{64}$/u);
      assert.equal(entry.sha256, second.manifest.stems.find((candidate) => candidate.name === entry.name)?.sha256);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a named Bus owns and renders processed TimelineEdit audio views without flattening their private origin", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-reference-timeline-edit-stem-"));
  try {
    await writeFile(resolve(root, "voice.wav"), monoSineWave(48_000, 0.2));
    const ir = compile(`cut 0.4;
project "TimelineEdit processed stem";
import {
  AudioRegion, AudioTrack, TimelineEdit,
  editSelection, editSplit, editTrim, avTime
} from "@cut/edit";
import { AudioClip, Bus, Gain, TimeStretch } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 100ms, fps: 20, sampleRate: 48khz) {
  scene only(duration: 100ms) {
    Bus(name: "processed-dialogue", role: "dialogue") {
      AudioTrack(trackId: "dialogue", role: "dialogue") {
        AudioRegion(
          destination: 0ms ..< 100ms,
          editId: "line",
          role: "dialogue"
        ) {
          Gain(amount: -3db) {
            TimeStretch(
              sourceDuration: 50ms,
              duration: 100ms,
              pitch: 0,
              quality: "draft"
            ) {
              AudioClip(source: voice, range: 0ms ..< 50ms);
            }
          }
        }
      }
    }
    TimelineEdit(
      id: "split-trim",
      operations: [
        editSplit(
          selection: editSelection(trackIds: ["dialogue"], originIds: ["line"]),
          at: avTime(audio: 50ms)
        ),
        editTrim(
          selection: editSelection(trackIds: ["dialogue"], originIds: ["line"]),
          keep: 25ms ..< 75ms
        )
      ]
    );
  }
}
export out = render(main);`);
    const lock = await createCutLock(ir, root);
    await applyCutLock(ir, lock, root);
    const plan = planReferenceAudioStems(ir, ir.compositions[0]);
    assert.deepEqual(plan.routes.map((route) => route.name), [
      "processed-dialogue",
    ]);
    const views = Object.values(ir.nodes).filter((node) =>
      node.op === "cut.edit.timeline_audio_view");
    assert.equal(views.length, 2);
    assert.ok(views.every((view) => view.ownership === "child"));
    const rendered = await renderReferenceAudioStems(
      ir,
      ir.compositions[0],
      root,
      resolve(root, "stems"),
    );
    const pcm = pcm24Data(
      await readFile(resolve(rendered.directory, "processed-dialogue.wav")),
    );
    assert.equal(pcm.frames, 4_800);
    assert.equal(pcm.sample(100, 0), 0, "trimmed prefix remains exact silence");
    assert.ok(
      Math.abs(pcm.sample(1_800, 0)) > 0.0001,
      "materialized origin view remains audible in the selected stem",
    );
    assert.equal(pcm.sample(4_700, 0), 0, "trimmed suffix remains exact silence");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Meter is a transparent top-level stem boundary without authorizing arbitrary descendants", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-reference-meter-stems-"));
  try {
    const ir = compile(`cut 0.4;
project "Meter-owned stems";
import { Bus, Meter, Tone } from "@cut/audio";
timeline main(duration: 20ms, fps: 50, sampleRate: 48khz) {
  Meter(target: -16lufs, truePeak: -1dbtp, samplePeak: -1dbfs) {
    Bus(name: "dialogue") { Tone(frequency: 1khz, duration: 20ms, amplitude: 10%); }
    Bus(name: "music") { Tone(frequency: 2khz, duration: 20ms, amplitude: 5%); }
  }
}
export out = render(main);`);
    const composition = ir.compositions[0], plan = planReferenceAudioStems(ir, composition);
    assert.deepEqual(plan.routes.map(({ name, file }) => ({ name, file })), [
      { name: "dialogue", file: "dialogue.wav" },
      { name: "music", file: "music.wav" },
    ]);

    const rendered = await renderReferenceAudioStems(ir, composition, root, resolve(root, "stems"));
    assert.deepEqual(rendered.manifest.stems.map((stem) => stem.file), ["dialogue.wav", "music.wav"]);
    for (const stem of rendered.manifest.stems) assert.ok((await readFile(resolve(rendered.directory, stem.file))).length > 44);

    const tone = Object.values(ir.nodes).find((node) => node.op === "cut.audio.tone");
    assert.ok(tone);
    await assert.rejects(
      renderReferenceAudioSelection(ir, composition, root, resolve(root, "forged.wav"), [tone!.id]),
      (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "CUT_AUDIO_GRAPH"),
    );
    await assert.rejects(access(resolve(root, "forged.wav")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function routeCountProgram(includeMusic: boolean) {
  return `cut 0.4;
project "Stem ownership cleanup";
import { Bus, Tone } from "@cut/audio";
timeline main(duration: 20ms, fps: 50, sampleRate: 48khz) {
  Bus(name: "dialogue") { Tone(frequency: 1khz, duration: 20ms, amplitude: 10%); }
  ${includeMusic ? 'Bus(name: "music") { Tone(frequency: 2khz, duration: 20ms, amplitude: 5%); }' : ""}
}
export out = render(main);`;
}

test("standalone stem publication removes only old-minus-new files owned by a valid prior v5 manifest", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-reference-stems-stale-"));
  try {
    const destination = resolve(root, "stems");
    const first = compile(routeCountProgram(true));
    await renderReferenceAudioStems(first, first.compositions[0], root, destination);
    await writeFile(resolve(destination, "producer-notes.wav"), "untracked sentinel");

    const second = compile(routeCountProgram(false));
    const rendered = await renderReferenceAudioStems(second, second.compositions[0], root, destination);
    assert.deepEqual(rendered.manifest.stems.map((stem) => stem.file), ["dialogue.wav"]);
    await assert.rejects(access(resolve(destination, "music.wav")));
    assert.equal(await readFile(resolve(destination, "producer-notes.wav"), "utf8"), "untracked sentinel");
    assert.equal((await readdir(destination)).some((entry) => entry.startsWith(".cut-stems-") || entry.endsWith(".bak")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed or hostile prior stem manifests grant no stale-file deletion authority", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-reference-stems-hostile-"));
  try {
    for (const kind of ["malformed", "hostile"] as const) {
      const destination = resolve(root, kind);
      const first = compile(routeCountProgram(true));
      const rendered = await renderReferenceAudioStems(first, first.compositions[0], root, destination);
      await writeFile(resolve(destination, "producer-notes.wav"), "untracked sentinel");
      const outside = resolve(root, `${kind}-outside.wav`); await writeFile(outside, "outside sentinel");
      if (kind === "malformed") await writeFile(rendered.manifestPath, "{not-json");
      else {
        const hostile = structuredClone(rendered.manifest) as typeof rendered.manifest;
        hostile.stems[1].file = `../${kind}-outside.wav`;
        await writeFile(rendered.manifestPath, JSON.stringify(hostile));
      }

      const second = compile(routeCountProgram(false));
      await renderReferenceAudioStems(second, second.compositions[0], root, destination);
      assert.ok((await readdir(destination)).includes("music.wav"), `${kind} manifest must not own the stale music leaf`);
      assert.equal(await readFile(resolve(destination, "producer-notes.wav"), "utf8"), "untracked sentinel");
      assert.equal(await readFile(outside, "utf8"), "outside sentinel");
      assert.equal((await readdir(destination)).some((entry) => entry.startsWith(".cut-stems-") || entry.endsWith(".bak")), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one clipped raw stem publishes none and preserves the previous complete stem set", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-reference-stems-clipping-"));
  try {
    const ir = compile(`cut 0.4;
project "Atomic stem peak refusal";
import { Bus, Tone } from "@cut/audio";
timeline main(duration: 20ms, fps: 50, sampleRate: 48khz) {
  Bus(name: "safe") { Tone(frequency: 1khz, duration: 20ms, amplitude: 10%); }
  Bus(name: "clipped") {
    Tone(frequency: 1khz, duration: 20ms, amplitude: 80%);
    Tone(frequency: 1khz, duration: 20ms, amplitude: 70%);
  }
}
export out = render(main);`);
    const composition = ir.compositions[0], destination = resolve(root, "stems");
    await mkdir(destination);
    const sentinels = new Map([
      ["safe.wav", Buffer.from("existing-safe")],
      ["clipped.wav", Buffer.from("existing-clipped")],
      ["cut-stems.json", Buffer.from("existing-manifest")],
    ]);
    for (const [file, contents] of sentinels) await writeFile(resolve(destination, file), contents);

    await assert.rejects(renderReferenceAudioStems(ir, composition, root, destination), (error) => {
      assert.ok(error instanceof ReferenceAudioPeakError, String(error));
      assert.equal(error.code, "CUT_AUDIO_CLIPPING");
      assert.equal(error.source.module, composition.provenance.module);
      assert.equal(error.source.line, composition.provenance.span.start.line);
      assert.equal(error.source.column, composition.provenance.span.start.column);
      assert.equal(error.source.nodeId, composition.id);
      assert.equal(error.detail.thresholdDbfs, 0);
      return true;
    });

    assert.deepEqual((await readdir(destination)).sort(), [...sentinels.keys()].sort(), "private staging must be removed without leaking a partial public set");
    for (const [file, contents] of sentinels) assert.deepEqual(await readFile(resolve(destination, file)), contents, `${file} sentinel must remain byte-identical`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a lowered hot stem passes a caller-provided Meter samplePeak ceiling and publishes canonical PCM24", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-reference-stems-lowered-"));
  try {
    const ir = compile(`cut 0.4;
project "Lowered stem peak";
import { Bus, Gain, Tone } from "@cut/audio";
timeline main(duration: 20ms, fps: 50, sampleRate: 48khz) {
  Bus(name: "controlled") {
    Gain(amount: -6db) {
      Tone(frequency: 1khz, duration: 20ms, amplitude: 80%);
      Tone(frequency: 1khz, duration: 20ms, amplitude: 70%);
    }
    }
}
export out = render(main);`);
    const source = { module: "meter-contract.cut", line: 12, column: 7, nodeId: "meter-contract" } as const;
    await assert.rejects(
      renderReferenceAudioStems(ir, ir.compositions[0], root, resolve(root, "strict-stems"), { samplePeakDbfs: -6, source }),
      (error) => {
        assert.ok(error instanceof ReferenceAudioPeakError, String(error));
        assert.equal(error.code, "CUT_AUDIO_CLIPPING");
        assert.deepEqual(error.source, source);
        assert.equal(error.detail.thresholdDbfs, -6);
        return true;
      },
    );
    const rendered = await renderReferenceAudioStems(ir, ir.compositions[0], root, resolve(root, "stems"), { samplePeakDbfs: -1, source });
    const wave = await readFile(resolve(rendered.directory, "controlled.wav")), decoded = pcm24Data(wave);
    let peak = 0;
    for (let frame = 0; frame < decoded.frames; frame += 1) {
      peak = Math.max(peak, Math.abs(decoded.sample(frame, 0)), Math.abs(decoded.sample(frame, 1)));
    }
    assert.ok(peak > .5 && peak <= 10 ** (-1 / 20), `lowered decoded peak ${peak} must retain signal below -1 dBFS`);
    assert.equal(rendered.manifest.stems[0].bytes, wave.length);
    assert.equal(rendered.manifest.stems[0].peak.thresholdDbfs, -1);
    assert.ok(rendered.manifest.stems[0].peak.peakLinear <= 10 ** (-1 / 20));
    assert.equal(wave.readUInt16LE(34), 24);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("transparent component and Meter wrappers plan and render the same top-level stem without authorizing its nested Bus", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-reference-component-stems-"));
  try {
    for (const [name, wrapper] of [["component", "Dialogue();"], ["meter-component", "Meter() { Dialogue(); }"]] as const) {
      const ir = compile(`cut 0.4;
project "${name} stem";
import { Bus, Meter, Tone } from "@cut/audio";
component Dialogue() -> AudioNode {
  Bus(name: "dialogue") { Bus(name: "nested") { Tone(frequency: 440hz, duration: 20ms); } }
}
timeline main(duration: 20ms, fps: 50, sampleRate: 48khz) { ${wrapper} }
export out = render(main);`);
      const composition = ir.compositions[0], plan = planReferenceAudioStems(ir, composition);
      assert.deepEqual(plan.routes.map((route) => route.name), ["dialogue"]);
      assert.equal(ir.nodes[plan.routes[0].nodeId].inputs.name.kind, "string");
      const nested = Object.values(ir.nodes).find((node) => node.op === "cut.audio.bus" && node.inputs.name.kind === "string" && node.inputs.name.value === "nested");
      assert.ok(nested, "nested bus remains authored IR rather than becoming a stem");
      const rendered = await renderReferenceAudioStems(ir, composition, root, resolve(root, name));
      assert.deepEqual(rendered.manifest.stems.map((stem) => stem.file), ["dialogue.wav"]);
      await assert.rejects(
        renderReferenceAudioSelection(ir, composition, root, resolve(root, `${name}-nested.wav`), [nested!.id]),
        (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "CUT_AUDIO_GRAPH"),
      );
      await assert.rejects(access(resolve(root, `${name}-nested.wav`)));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stem preflight rejects missing, empty, duplicate, unsafe, empty-graph, and ambiguous routes", () => {
  const program = (body: string) => `cut 0.4; project "stem refusal"; import { Bus, Gain, Tone } from "@cut/audio"; timeline main(duration: 1s, fps: 24) { ${body} } export out = render(main);`;
  const rejected = (body: string, code: ReferenceStemError["code"]) => {
    const ir = compile(program(body));
    assert.throws(() => planReferenceAudioStems(ir, ir.compositions[0]), (error) => error instanceof ReferenceStemError && error.code === code);
  };
  rejected('Bus() { Tone(frequency: 440hz, duration: 1s); }', "CUT_STEM_NAME_MISSING");
  rejected('Bus(name: "") { Tone(frequency: 440hz, duration: 1s); }', "CUT_STEM_NAME_EMPTY");
  rejected('Bus(name: "../dialogue") { Tone(frequency: 440hz, duration: 1s); }', "CUT_STEM_NAME_UNSAFE");
  rejected('Bus(name: "CON") { Tone(frequency: 440hz, duration: 1s); }', "CUT_STEM_NAME_UNSAFE");
  rejected('Bus(name: "Music") { Tone(frequency: 440hz, duration: 1s); } Bus(name: "music") { Tone(frequency: 880hz, duration: 1s); }', "CUT_STEM_NAME_DUPLICATE");
  const empty = compile(program('Bus(name: "empty") { Tone(frequency: 440hz, duration: 1s); }'));
  const emptyBus = Object.values(empty.nodes).find((node) => node.op === "cut.audio.bus");
  assert.ok(emptyBus); emptyBus.children = [];
  assert.throws(() => planReferenceAudioStems(empty, empty.compositions[0]), (error) => error instanceof ReferenceStemError && error.code === "CUT_STEM_EMPTY");
  rejected('Tone(frequency: 440hz, duration: 1s);', "CUT_STEM_ROUTING_AMBIGUOUS");
  rejected('Gain(amount: -3db) { Bus(name: "processed") { Tone(frequency: 440hz, duration: 1s); } }', "CUT_STEM_ROUTING_AMBIGUOUS");

  const shared = compile(program('Bus(name: "one") { Tone(frequency: 440hz, duration: 1s); } Bus(name: "two") { Tone(frequency: 880hz, duration: 1s); }'));
  const buses = Object.values(shared.nodes).filter((node) => node.op === "cut.audio.bus");
  buses[1].children = [buses[0].children[0]];
  assert.throws(() => planReferenceAudioStems(shared, shared.compositions[0]), (error) => error instanceof ReferenceStemError && error.code === "CUT_STEM_ROUTING_AMBIGUOUS");
});

test("stem diagnostics bound hostile Unicode names while preserving readable short names", () => {
  const program = (name: string) => `cut 0.4; project "stem diagnostic bounds"; import { Bus, Tone } from "@cut/audio"; timeline main(duration: 20ms, fps: 50) { Bus(name: ${JSON.stringify(name)}) { Tone(frequency: 1khz, duration: 20ms); } } export out = render(main);`;
  const hostileName = `a${"🧨".repeat(20_000)}`;
  const hostile = compile(program(hostileName));
  let captured: ReferenceStemError | undefined;
  try {
    planReferenceAudioStems(hostile, hostile.compositions[0]);
  } catch (error) {
    assert.ok(error instanceof ReferenceStemError, String(error));
    captured = error;
  }
  assert.ok(captured);
  assert.equal(captured.code, "CUT_STEM_NAME_UNSAFE");
  assert.ok(captured.message.length < 1_024, "hostile stem name must not amplify the diagnostic");
  assert.match(captured.message, /20001 Unicode code points; 80001 UTF-8 bytes/u);
  assert.match(captured.message, new RegExp(`sha256:${createHash("sha256").update(hostileName).digest("hex").slice(0, 12)}`));
  assert.doesNotMatch(captured.message, /\uFFFD/u, "the preview must not split a Unicode scalar");

  const duplicate = compile(`cut 0.4; project "short duplicate"; import { Bus, Tone } from "@cut/audio"; timeline main(duration: 20ms, fps: 50) { Bus(name: "Music") { Tone(frequency: 1khz, duration: 20ms); } Bus(name: "music") { Tone(frequency: 2khz, duration: 20ms); } } export out = render(main);`);
  assert.throws(() => planReferenceAudioStems(duplicate, duplicate.compositions[0]), (error) => {
    assert.ok(error instanceof ReferenceStemError);
    assert.equal(error.code, "CUT_STEM_NAME_DUPLICATE");
    assert.match(error.message, /duplicate name "music"\./u);
    assert.doesNotMatch(error.message, /Unicode code points/u);
    return true;
  });
});

const cli = resolve("dist-cli/cli/cut.js");

async function runCli(args: string[], cwd: string, expectedCode = 0) {
  return new Promise<{ stdout: string; stderr: string }>((accept, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (code === expectedCode) accept(result);
      else reject(new Error(`cut ${args.join(" ")} exited ${code ?? signal}, expected ${expectedCode}\n${result.stderr}${result.stdout}`));
    });
  });
}

test("canonical cut render publishes named stems and preflights bad routing before video output", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-cli-stems-"));
  try {
    const valid = `cut 0.4; project "CLI stems"; import { Bus, Tone } from "@cut/audio"; timeline main(duration: 250ms, fps: 4, width: 64px, height: 64px, sampleRate: 48khz) { Bus(name: "dialogue") { Tone(frequency: 1000hz, duration: 250ms, amplitude: 5%); } scene canvas(duration: 250ms) {} } export out = render(main, width: 64px, height: 64px);`;
    await writeFile(resolve(root, "main.cut"), valid);
    await runCli(["lock", "main.cut", "--out", "cut.lock"], root);
    const rendered = await runCli(["render", "main.cut", "--lock", "cut.lock", "--out", "out.mp4", "--stems", "stems"], root);
    assert.match(rendered.stdout, /1 pre-master stem/);
    const stemBytes = await readFile(resolve(root, "stems", "cut-stems.json"));
    const manifest = JSON.parse(stemBytes.toString("utf8")) as { format: string; version: number; lock: { sha256: string }; stems: Array<{ file: string }> };
    const renderManifest = JSON.parse(await readFile(resolve(root, "out.mp4.manifest.json"), "utf8")) as { version: number; lock: { sha256: string }; stems: { directory: string; manifest: string; manifestSha256: string; count: number } };
    const lockSha256 = createHash("sha256").update(await readFile(resolve(root, "cut.lock"))).digest("hex");
    assert.equal(manifest.format, "cut-reference-stems"); assert.equal(manifest.version, 5); assert.deepEqual(manifest.stems.map((stem) => stem.file), ["dialogue.wav"]);
    assert.deepEqual(manifest.lock, { sha256: lockSha256 });
    assert.equal(renderManifest.version, 10); assert.deepEqual(renderManifest.lock, manifest.lock);
    assert.deepEqual(renderManifest.stems, { directory: "stems", manifest: "stems/cut-stems.json", manifestSha256: createHash("sha256").update(stemBytes).digest("hex"), count: 1 });
    await access(resolve(root, "out.mp4")); await access(resolve(root, "stems", "dialogue.wav"));

    const invalid = `cut 0.4; project "CLI bad stems"; import { Tone } from "@cut/audio"; timeline main(duration: 250ms, fps: 4, width: 64px, height: 64px) { Tone(frequency: 440hz, duration: 250ms); scene canvas(duration: 250ms) {} } export out = render(main, width: 64px, height: 64px);`;
    await writeFile(resolve(root, "bad.cut"), invalid);
    await runCli(["lock", "bad.cut", "--out", "bad.lock"], root);
    const refused = await runCli(["render", "bad.cut", "--lock", "bad.lock", "--out", "must-not-exist.mp4", "--stems", "bad-stems"], root, 1);
    assert.match(refused.stderr, /CUT_STEM_ROUTING_AMBIGUOUS/);
    await assert.rejects(access(resolve(root, "must-not-exist.mp4")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
