import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { parseCutLanguage } from "../lib/language/parser";
import {
  createReferenceStaticDspIslandState,
  createReferenceStaticSidechainIslandState,
  planReferenceStaticDspIsland,
  planReferenceStaticSidechainIsland,
  processReferenceStaticDspIslandBuffer,
  processReferenceStaticSidechainIslandBuffer,
  ReferenceStaticDspIslandError,
  renderReferenceStaticDspIsland,
  type ReferenceStaticDspIslandPlan,
  type ReferenceStaticSidechainIslandPlan,
} from "../lib/runtime/reference/audio-static-dsp-island";
import { renderReferenceAudioSelection } from "../lib/runtime/reference/audio";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

function source() {
  return `cut 0.4;
project "static DSP island";
import { Compressor, DeEsser, Gain, HighPass, Limiter, LowPass, Noise, Tone } from "@cut/audio";
timeline main(duration: 120ms, fps: 100, width: 16px, height: 16px, sampleRate: 48khz) {
  Limiter(ceiling: -1dbtp) {
    Gain(amount: 8db) {
      Compressor(threshold: -22db, ratio: 2.4, attack: 18ms, release: 180ms) {
        DeEsser(intensity: 0.28, amount: 0.45) {
          HighPass(frequency: 70hz, q: 0.707) {
            Tone(frequency: 440hz, duration: 90ms, amplitude: 18%);
            at 20ms { Tone(frequency: 730hz, duration: 70ms, amplitude: 11%); }
          }
        }
      }
    }
    at 40ms {
      Gain(amount: 8.2db) {
        Compressor(threshold: -22db, ratio: 2.4, attack: 18ms, release: 180ms) {
          DeEsser(intensity: 0.28, amount: 0.45) {
            LowPass(frequency: 8khz, q: 0.707) {
              Noise(duration: 60ms, color: "pink", seed: 4, amplitude: 8%);
            }
          }
        }
      }
    }
  }
}
export out = render(main, width: 16px, height: 16px, codec: "h264");`;
}

function compile() {
  const parsed = parseCutLanguage(source());
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  const ir = compileCutModule(parsed.module).ir;
  ir.determinism.semantic = "locked";
  validateReferenceSession(ir);
  return ir;
}

function sidechainSource() {
  return `cut 0.4;
project "static sidechain island";
import { Bus, Compressor, DeEsser, Gain, HighPass, Limiter, Noise, Sidechain, Submix, Tone } from "@cut/audio";
timeline main(duration: 120ms, fps: 100, width: 16px, height: 16px, sampleRate: 48khz) {
  Limiter(ceiling: -1dbtp) {
    Submix(name: "pre-master") {
      Bus(name: "dialogue", role: "dialogue") as dialogue {
        Limiter(ceiling: -2dbtp) {
          Gain(amount: 8db) {
            Compressor(threshold: -22db, ratio: 2.4, attack: 18ms, release: 180ms) {
              DeEsser(intensity: 0.28, amount: 0.45) {
                HighPass(frequency: 70hz, q: 0.707) {
                  Tone(frequency: 730hz, duration: 100ms, amplitude: 55%);
                }
              }
            }
          }
        }
      }
      Bus(name: "music", role: "music") {
        Sidechain(source: dialogue, amount: -8db, threshold: -24db, attack: 2ms, release: 40ms) {
          Tone(frequency: 220hz, duration: 120ms, amplitude: 20%);
        }
      }
      Bus(name: "ambience", role: "ambience") {
        Sidechain(source: dialogue, amount: -5db, threshold: -28db, attack: 4ms, release: 65ms) {
          Noise(duration: 120ms, color: "pink", seed: 7, amplitude: 9%);
        }
      }
    }
  }
}
export out = render(main, width: 16px, height: 16px, codec: "h264");`;
}

function compileSidechain() {
  const parsed = parseCutLanguage(sidechainSource());
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  const ir = compileCutModule(parsed.module).ir;
  ir.determinism.semantic = "locked";
  validateReferenceSession(ir);
  return ir;
}

function node(ir: CutAVIR, op: string) {
  const result = Object.values(ir.nodes).find((candidate) => candidate.op === op);
  assert.ok(result, `missing ${op}`);
  return result;
}

function limiterPlan(ir: CutAVIR) {
  const limiter = node(ir, "cut.audio.limiter");
  const plan = planReferenceStaticDspIsland(ir, ir.compositions[0], limiter.children);
  assert.ok(plan);
  return { limiter, plan };
}

function deterministicInput(frames: number, seed: number) {
  let state = seed >>> 0;
  const input = new Float32Array(frames * 2);
  for (let index = 0; index < input.length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    input[index] = Math.fround(((state / 0xffff_ffff) * 2 - 1) * 0.6);
  }
  return input;
}

function slicedPlan(plan: ReferenceStaticDspIslandPlan, frames: number): ReferenceStaticDspIslandPlan {
  return Object.freeze({ ...plan, frames });
}

function sidechainPlan(ir: CutAVIR) {
  const limiter = Object.values(ir.nodes).find((candidate) => candidate.op === "cut.audio.limiter"
    && candidate.children.length === 1
    && ir.nodes[candidate.children[0]]?.op === "cut.audio.submix");
  assert.ok(limiter);
  const plan = planReferenceStaticSidechainIsland(ir, ir.compositions[0], limiter.children);
  assert.ok(plan);
  return { limiter, plan };
}

function slicedSidechainPlan(
  plan: ReferenceStaticSidechainIslandPlan,
  frames: number,
): ReferenceStaticSidechainIslandPlan {
  return Object.freeze({ ...plan, frames });
}

test("static dialogue islands are exact against the unchanged FFmpeg graph, including partial branch intervals", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-static-dsp-island-parity-"));
  try {
    const ir = compile();
    const roots = ir.compositions[0].rootAudioIds;
    const optimized = resolve(root, "optimized.f32le");
    const baseline = resolve(root, "baseline.f32le");
    await renderReferenceAudioSelection(ir, ir.compositions[0], root, optimized, roots, {
      outputFormat: "raw-stereo-f32le",
    });
    await renderReferenceAudioSelection(ir, ir.compositions[0], root, baseline, roots, {
      outputFormat: "raw-stereo-f32le",
      __disableStaticDspIsland: true,
    });
    assert.deepEqual(await readFile(optimized), await readFile(baseline));
    const { plan } = limiterPlan(ir);
    assert.deepEqual(plan.branches.map((branch) => branch.processors.map((processor) => processor.kind)), [
      ["state-variable-filter", "deesser", "compressor", "gain"],
      ["state-variable-filter", "deesser", "compressor", "gain"],
    ]);
    assert.notDeepEqual(ir.nodes[plan.branches[0].rootId].interval, ir.nodes[plan.branches[1].rootId].interval);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("static sidechain submix islands are exact against the unchanged nested limiter and FFmpeg graph", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-static-sidechain-island-parity-"));
  try {
    const ir = compileSidechain();
    const roots = ir.compositions[0].rootAudioIds;
    const optimized = resolve(root, "optimized.f32le");
    const baseline = resolve(root, "baseline.f32le");
    await renderReferenceAudioSelection(ir, ir.compositions[0], root, optimized, roots, {
      outputFormat: "raw-stereo-f32le",
    });
    await renderReferenceAudioSelection(ir, ir.compositions[0], root, baseline, roots, {
      outputFormat: "raw-stereo-f32le",
      __disableStaticDspIsland: true,
    });
    assert.deepEqual(await readFile(optimized), await readFile(baseline));
    const { plan } = sidechainPlan(ir);
    assert.equal(plan.branches.length, 2);
    assert.deepEqual(plan.mixOrder.map((item) => item.kind), ["key", "sidechain", "sidechain"]);
    assert.equal(plan.keyRootIds.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pure static DSP buffer execution preserves chunk state, inputs, nonaliasing and exact output", () => {
  const ir = compile();
  const full = slicedPlan(limiterPlan(ir).plan, 257);
  const inputs = [deterministicInput(257, 1), deterministicInput(257, 2)];
  const before = inputs.map((input) => Buffer.from(input.buffer.slice(0)));
  const oneState = createReferenceStaticDspIslandState(full);
  const one = processReferenceStaticDspIslandBuffer(full, oneState, inputs);
  assert.equal(oneState.framesProcessed, 257);
  assert.notEqual(one.buffer, inputs[0].buffer);
  assert.notEqual(one.buffer, inputs[1].buffer);
  assert.deepEqual(inputs.map((input) => Buffer.from(input.buffer)), before);

  const splitState = createReferenceStaticDspIslandState(full);
  const parts: Float32Array[] = [];
  for (const [start, end] of [[0, 1], [1, 64], [64, 193], [193, 257]]) {
    parts.push(processReferenceStaticDspIslandBuffer(
      full,
      splitState,
      inputs.map((input) => input.slice(start * 2, end * 2)),
    ));
  }
  const joined = new Float32Array(one.length);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  assert.deepEqual(Buffer.from(joined.buffer), Buffer.from(one.buffer));
  assert.equal(splitState.framesProcessed, 257);
});

test("pure static sidechain execution preserves chunk state, inputs, nonaliasing and exact output", () => {
  const ir = compileSidechain();
  const full = slicedSidechainPlan(sidechainPlan(ir).plan, 257);
  const key = deterministicInput(257, 11);
  const programs = [deterministicInput(257, 12), deterministicInput(257, 13)];
  const before = [key, ...programs].map((input) => Buffer.from(input.buffer.slice(0)));
  const oneState = createReferenceStaticSidechainIslandState(full);
  const one = processReferenceStaticSidechainIslandBuffer(full, oneState, key, programs);
  assert.equal(oneState.framesProcessed, 257);
  assert.ok([key, ...programs].every((input) => one.buffer !== input.buffer));
  assert.deepEqual([key, ...programs].map((input) => Buffer.from(input.buffer)), before);

  const splitState = createReferenceStaticSidechainIslandState(full);
  const parts: Float32Array[] = [];
  for (const [start, end] of [[0, 1], [1, 64], [64, 193], [193, 257]]) {
    parts.push(processReferenceStaticSidechainIslandBuffer(
      full,
      splitState,
      key.slice(start * 2, end * 2),
      programs.map((program) => program.slice(start * 2, end * 2)),
    ));
  }
  const joined = new Float32Array(one.length);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  assert.deepEqual(Buffer.from(joined.buffer), Buffer.from(one.buffer));
  assert.equal(splitState.framesProcessed, 257);
});

test("planner fails open only to the unchanged path for automation, unsupported roots and excessive branch fanout", () => {
  const ir = compile();
  const composition = ir.compositions[0];
  const { limiter } = limiterPlan(ir);
  const automated = structuredClone(ir);
  const gain = automated.nodes[limiter.children[0]];
  gain.properties.amount = { signal: "hostile_signal" };
  assert.equal(planReferenceStaticDspIsland(automated, composition, limiter.children), undefined);

  const unsupported = structuredClone(ir);
  unsupported.nodes[limiter.children[0]].op = "cut.audio.pan";
  assert.equal(planReferenceStaticDspIsland(unsupported, composition, limiter.children), undefined);
  assert.equal(planReferenceStaticDspIsland(ir, composition, Array(9).fill(limiter.children[0])), undefined);
});

test("sidechain planner refuses automation, different control keys and ambiguous submix children", () => {
  const ir = compileSidechain();
  const composition = ir.compositions[0];
  const { limiter } = sidechainPlan(ir);
  const sidechains = Object.values(ir.nodes).filter((candidate) => candidate.op === "cut.audio.sidechain");
  assert.equal(sidechains.length, 2);

  const automated = structuredClone(ir);
  automated.nodes[sidechains[0].id].properties.amount = { signal: "hostile_signal" };
  assert.equal(planReferenceStaticSidechainIsland(automated, composition, limiter.children), undefined);

  const differentKey = structuredClone(ir);
  const foreignBus = Object.values(differentKey.nodes).find((candidate) => candidate.op === "cut.audio.bus"
    && candidate.id !== sidechainPlan(differentKey).plan.keyRootIds[0]);
  assert.ok(foreignBus);
  const secondConfig = differentKey.nodes[sidechains[1].id].inputs.source;
  assert.ok(secondConfig && secondConfig.kind === "node-ref");
  differentKey.nodes[sidechains[1].id].inputs.source = { ...secondConfig, id: foreignBus.id };
  assert.equal(planReferenceStaticSidechainIsland(differentKey, composition, limiter.children), undefined);

  const ambiguous = structuredClone(ir);
  const submix = node(ambiguous, "cut.audio.submix");
  submix.children.push(submix.children[0]);
  assert.equal(planReferenceStaticSidechainIsland(ambiguous, composition, limiter.children), undefined);
});

test("pure buffer work and sample boundaries fail closed", () => {
  const ir = compile();
  const plan = slicedPlan(limiterPlan(ir).plan, 4);
  const state = createReferenceStaticDspIslandState(plan);
  const valid = [deterministicInput(4, 3), deterministicInput(4, 4)];
  assert.throws(
    () => processReferenceStaticDspIslandBuffer(plan, state, [valid[0]]),
    (error) => error instanceof ReferenceStaticDspIslandError && error.code === "CUT_AUDIO_STATIC_DSP_SOURCE",
  );
  assert.throws(
    () => processReferenceStaticDspIslandBuffer(plan, state, [new Float32Array([1]), new Float32Array([1])]),
    (error) => error instanceof ReferenceStaticDspIslandError && error.code === "CUT_AUDIO_STATIC_DSP_WORK_LIMIT",
  );
  const nonfinite = valid.map((input) => input.slice());
  nonfinite[1][3] = Number.NaN;
  assert.throws(
    () => processReferenceStaticDspIslandBuffer(plan, createReferenceStaticDspIslandState(plan), nonfinite),
    (error) => error instanceof ReferenceStaticDspIslandError && error.code === "CUT_AUDIO_STATIC_DSP_SOURCE",
  );
});

test("file execution rejects malformed boundaries and removes unpublished output", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-static-dsp-island-source-"));
  try {
    const ir = compile();
    const { limiter } = limiterPlan(ir);
    const output = resolve(root, "island.f32le");
    await assert.rejects(
      renderReferenceStaticDspIsland(
        ir,
        ir.compositions[0],
        limiter.children,
        output,
        async (_roots, boundary) => writeFile(boundary, Buffer.alloc(8), { flag: "wx" }),
      ),
      (error) => error instanceof ReferenceStaticDspIslandError
        && error.code === "CUT_AUDIO_STATIC_DSP_SOURCE"
        && /exact|direct/.test(error.message),
    );
    await assert.rejects(readFile(output), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
