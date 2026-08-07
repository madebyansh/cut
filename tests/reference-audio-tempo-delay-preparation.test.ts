import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { IRValue } from "../lib/language/ir";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import {
  referenceTempoDelayConfig,
  ReferenceTempoDelayConfigError,
  validateReferenceTempoDelayPlans,
} from "../lib/runtime/reference/audio-tempo-delay-config";
import {
  createReferenceAudioTempoDelayBuildEvidence,
  prepareReferenceAudioTempoDelaySources,
} from "../lib/runtime/reference/audio-tempo-delay-preparation";

function quantity(dimension: string, numerator: number, denominator = 1, unit = dimension): IRValue {
  return { kind: "quantity", dimension, magnitude: rational(numerator, denominator), unit };
}

function forgedTempoDelay() {
  const source = `cut 0.4;
project "tempo preparation";
import { Delay, Tone } from "@cut/audio";
timeline main(duration: 50ms, fps: 24, sampleRate: 48khz) {
  Delay(time: 10ms) { Tone(frequency: 440hz, duration: 1ms); }
}
export out = render(main);`;
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(checked.diagnostics, []);
  const ir = compileCutModule(parsed.module).ir;
  ir.determinism.semantic = "locked";
  const node = Object.values(ir.nodes).find((candidate) => candidate.op === "cut.audio.delay");
  assert.ok(node);
  node.op = "cut.audio.tempo_delay";
  node.inputs = {
    tempo: {
      kind: "object",
      entries: {
        points: {
          kind: "array",
          items: [{
            kind: "object",
            entries: {
              at: quantity("time", 0, 1, "s"),
              bpm: quantity("scalar", 120, 1, "scalar"),
            },
          }],
        },
      },
    },
    delay: quantity("beat", 1, 50, "beat"),
    feedback: quantity("ratio", 1, 2, "ratio"),
    mix: quantity("ratio", 1, 1, "ratio"),
  };
  return { ir, node, composition: ir.compositions[0]! };
}

function rawStereo(samples: Float32Array) {
  const bytes = Buffer.alloc(samples.length * 4);
  for (let index = 0; index < samples.length; index += 1) bytes.writeFloatLE(samples[index]!, index * 4);
  return bytes;
}

test("TempoDelay IR adapter preserves source provenance, exact plan, inspectable identity, and aggregate work", () => {
  const { ir, node, composition } = forgedTempoDelay();
  const plan = referenceTempoDelayConfig(ir, composition, node);
  assert.ok(plan);
  assert.equal(plan.firstEchoFrame, 480);
  assert.equal(plan.feedback, 0.5);
  assert.equal(plan.mix, 1);
  assert.equal(plan.tempo.totalFrames, 2_400);
  assert.equal(validateReferenceTempoDelayPlans(ir, composition, [node.id]).length, 1);
  const oldIdentity = plan.integrity;
  node.inputs.delay = quantity("beat", 1, 25, "beat");
  assert.notEqual(referenceTempoDelayConfig(ir, composition, node)?.integrity, oldIdentity);

  node.inputs.delay = quantity("beat", 1, 50, "beat");
  node.inputs.mix = quantity("ratio", 0, 1, "ratio");
  assert.throws(() => referenceTempoDelayConfig(ir, composition, node), (error: unknown) => {
    assert.ok(error instanceof ReferenceTempoDelayConfigError);
    assert.equal(error.code, "CUT_AUDIO_TEMPO_DELAY_VALUE");
    assert.equal(error.source.module, "project.cut");
    assert.ok(error.source.line > 0 && error.source.column > 0);
    assert.equal(error.source.nodeId, node.id);
    return true;
  });
});

test("private TempoDelay preparation executes exact f32, emits path-free evidence, and cleans its boundary", async () => {
  const { ir, node, composition } = forgedTempoDelay();
  const input = new Float32Array(4_800);
  input[0] = 0.8; input[1] = -0.4;
  const preparation = await prepareReferenceAudioTempoDelaySources(ir, composition, [node.id], async (childIds, output) => {
    assert.deepEqual(childIds, node.children);
    await writeFile(output, rawStereo(input), { flag: "wx", mode: 0o600 });
  });
  const source = preparation.sources.get(node.id);
  assert.ok(source);
  assert.equal(source.renderedSamples, 2_400);
  assert.equal(source.evidence.frames, 2_400);
  assert.equal(source.evidence.delayedFrames, 1_920);
  assert.doesNotMatch(JSON.stringify(source.evidence), /(?:\/private\/|\/Users\/|tempo-delay-\d)/);
  const output = await readFile(source.path);
  assert.equal(output.byteLength, 19_200);
  assert.equal(output.readFloatLE(0), 0);
  assert.equal(output.readFloatLE(4), 0);
  assert.equal(output.readFloatLE(480 * 8), Math.fround(0.8));
  assert.equal(output.readFloatLE(480 * 8 + 4), Math.fround(-0.4));
  assert.equal(output.readFloatLE(960 * 8), Math.fround(0.4));
  const build = createReferenceAudioTempoDelayBuildEvidence([source.evidence]);
  assert.equal(build.preparedExecutions, 1);
  assert.equal(build.executions[0]?.integrity, source.evidence.integrity);
  assert.doesNotMatch(JSON.stringify(build), /(?:\/private\/|\/Users\/|tempo-delay-\d)/);
  const path = source.path;
  await preparation.cleanup();
  await preparation.cleanup();
  await assert.rejects(access(path), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("private TempoDelay preparation rejects an inexact child before DSP output is exposed", async () => {
  const { ir, node, composition } = forgedTempoDelay();
  await assert.rejects(
    prepareReferenceAudioTempoDelaySources(ir, composition, [node.id], async (_childIds, output) => {
      await writeFile(output, Buffer.alloc(7), { flag: "wx", mode: 0o600 });
    }),
    (error: unknown) => error instanceof ReferenceTempoDelayConfigError
      && error.code === "CUT_AUDIO_TEMPO_DELAY_PCM"
      && error.source.nodeId === node.id
      && /direct 19200-byte stereo f32le/.test(error.message),
  );
});
