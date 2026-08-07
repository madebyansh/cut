import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { parseCutLanguage } from "../lib/language/parser";
import {
  compileReferenceLimiterAutomations,
} from "../lib/runtime/reference/audio-automation";
import { referenceAudioNodeConfig } from "../lib/runtime/reference/audio-config";
import {
  ReferenceAudioLimiterError,
  processReferenceAudioLimiter,
} from "../lib/runtime/reference/audio-limiter";
import {
  ReferenceAudioLimiterPreparationError,
  validateReferenceAudioLimiterPlans,
} from "../lib/runtime/reference/audio-limiter-preparation";
import {
  referenceMasterAudioRootIds,
  renderReferenceAudioSelection,
} from "../lib/runtime/reference/audio";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

function program(body: string, duration = "20ms", authoredSampleRate = "48khz") {
  return `cut 0.4;
project "CUT-owned limiter runtime";
import { Bus, Gain, Limiter, Sidechain, TimeStretch, Tone } from "@cut/audio";
timeline main(duration: ${duration}, fps: 100, width: 16px, height: 16px, sampleRate: ${authoredSampleRate}) {
  ${body}
}
export out = render(main, width: 16px, height: 16px, codec: "h264");`;
}

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  const ir = compileCutModule(parsed.module).ir;
  ir.determinism.semantic = "locked";
  return ir;
}

function nodes(ir: CutAVIR, op: string) {
  return Object.values(ir.nodes).filter((node) => node.op === op);
}

function decodeRawStereoF32Le(bytes: Buffer) {
  assert.equal(bytes.byteLength % 8, 0, "raw stereo f32le must contain complete frames");
  const result = new Float32Array(bytes.byteLength / 4);
  for (let index = 0; index < result.length; index += 1) result[index] = bytes.readFloatLE(index * 4);
  return result;
}

function encodeRawStereoF32Le(samples: Float32Array) {
  const result = Buffer.allocUnsafe(samples.length * 4);
  for (let index = 0; index < samples.length; index += 1) result.writeFloatLE(samples[index], index * 4);
  return result;
}

function independentlyLimit(ir: CutAVIR, node: IRNode, input: Float32Array) {
  const composition = ir.compositions[0];
  const config = referenceAudioNodeConfig(ir, composition, node);
  assert.equal(config?.kind, "limiter");
  if (config?.kind !== "limiter") throw new Error("test expected one closed Limiter config");
  const automation = compileReferenceLimiterAutomations(ir, composition, node);
  return processReferenceAudioLimiter(input, {
    sampleRate: composition.sampleRate,
    lookaheadSamples: config.lookaheadSamples,
    ceilingDbtp: automation.ceiling?.valueAtSample ?? (() => config.ceilingDbtp),
    releaseSeconds: automation.release?.valueAtSample ?? (() => config.releaseSeconds),
    source: {
      module: node.provenance.module,
      line: node.provenance.span.start.line,
      column: node.provenance.span.start.column,
      nodeId: node.id,
    },
  });
}

async function renderRaw(
  ir: CutAVIR,
  root: string,
  name: string,
  rootIds: readonly string[],
) {
  const output = resolve(root, name);
  await renderReferenceAudioSelection(ir, ir.compositions[0], root, output, rootIds, {
    outputFormat: "raw-stereo-f32le",
  });
  return readFile(output);
}

function pathEnvironmentKey() {
  return Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

async function withCapturedFfmpegGraphs<T>(root: string, action: () => Promise<T>) {
  if (process.platform === "win32") return { value: await action(), graph: "" };
  const realFfmpeg = execFileSync("which", ["ffmpeg"], { encoding: "utf8" }).trim();
  assert.ok(realFfmpeg.startsWith("/"));
  const bin = resolve(root, "bin"), wrapper = resolve(bin, "ffmpeg"), log = resolve(root, "ffmpeg-graphs.txt");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(bin, { recursive: true }));
  await writeFile(wrapper, `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const graphIndex = args.indexOf("-filter_complex_script");
if (graphIndex >= 0) appendFileSync(process.env.CUT_LIMITER_TEST_GRAPH_LOG, readFileSync(args[graphIndex + 1], "utf8") + "\\n---CUT-GRAPH---\\n");
const child = spawnSync(process.env.CUT_LIMITER_TEST_REAL_FFMPEG, args, { stdio: "inherit" });
if (child.error) throw child.error;
process.exit(child.status === null ? 1 : child.status);
`, { mode: 0o700 });

  const pathKey = pathEnvironmentKey();
  const previous = {
    path: process.env[pathKey],
    real: process.env.CUT_LIMITER_TEST_REAL_FFMPEG,
    log: process.env.CUT_LIMITER_TEST_GRAPH_LOG,
  };
  process.env[pathKey] = `${bin}${delimiter}${previous.path ?? ""}`;
  process.env.CUT_LIMITER_TEST_REAL_FFMPEG = realFfmpeg;
  process.env.CUT_LIMITER_TEST_GRAPH_LOG = log;
  try {
    const value = await action();
    return { value, graph: await readFile(log, "utf8") };
  } finally {
    if (previous.path === undefined) delete process.env[pathKey];
    else process.env[pathKey] = previous.path;
    if (previous.real === undefined) delete process.env.CUT_LIMITER_TEST_REAL_FFMPEG;
    else process.env.CUT_LIMITER_TEST_REAL_FFMPEG = previous.real;
    if (previous.log === undefined) delete process.env.CUT_LIMITER_TEST_GRAPH_LOG;
    else process.env.CUT_LIMITER_TEST_GRAPH_LOG = previous.log;
  }
}

test("public Limiter syntax renders the exact independent CUT-core f32 result without FFmpeg alimiter", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-limiter-runtime-"));
  try {
    const ir = compile(program(`
      Limiter(ceiling: -1dbtp, release: 50ms, lookahead: 3ms) as master {
        Tone(frequency: 440hz, duration: 20ms, amplitude: 40%);
      }
      at 10ms { set master.ceiling = -12dbtp; }
    `));
    assert.doesNotThrow(() => validateReferenceSession(ir));
    const limiter = nodes(ir, "cut.audio.limiter")[0];
    assert.ok(limiter);
    assert.equal(limiter.children.length, 1);

    const captured = await withCapturedFfmpegGraphs(root, async () => {
      const child = await renderRaw(ir, root, "child.f32le", limiter.children);
      const actual = await renderRaw(ir, root, "limited.f32le", [limiter.id]);
      return { child, actual };
    });
    const oracle = independentlyLimit(ir, limiter, decodeRawStereoF32Le(captured.value.child));
    assert.deepEqual(captured.value.actual, encodeRawStereoF32Le(oracle.output));
    assert.equal(captured.value.actual.byteLength, 960 * 8);

    const eventFrame = 480;
    assert.deepEqual(
      captured.value.actual.subarray(0, eventFrame * 8),
      captured.value.child.subarray(0, eventFrame * 8),
      "a future ceiling event must not alter any pre-event output sample",
    );
    assert.notDeepEqual(
      captured.value.actual.subarray(eventFrame * 8),
      captured.value.child.subarray(eventFrame * 8),
      "the authored ceiling event must execute from its exact sample",
    );
    if (process.platform !== "win32") {
      assert.match(captured.graph, /aformat=sample_fmts=fltp/u);
      assert.doesNotMatch(captured.graph, /\balimiter\s*=/u);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nested Limiters equal sequential application of the independent CUT core", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-limiter-nested-"));
  try {
    const ir = compile(program(`
      Limiter(ceiling: -3dbtp, release: 30ms, lookahead: 2ms) {
        Limiter(ceiling: -9dbtp, release: 20ms, lookahead: 1ms) {
          Gain(amount: 6db) { Tone(frequency: 730hz, duration: 20ms, amplitude: 80%); }
        }
      }
    `));
    assert.doesNotThrow(() => validateReferenceSession(ir));
    const limiters = nodes(ir, "cut.audio.limiter");
    assert.equal(limiters.length, 2);
    const outer = limiters.find((candidate) => ir.nodes[candidate.children[0]]?.op === "cut.audio.limiter");
    assert.ok(outer);
    const inner = ir.nodes[outer.children[0]];
    assert.ok(inner && inner.op === "cut.audio.limiter");
    assert.equal(inner.children.length, 1);

    const child = await renderRaw(ir, root, "nested-child.f32le", inner.children);
    const actual = await renderRaw(ir, root, "nested-limited.f32le", [outer.id]);
    const innerResult = independentlyLimit(ir, inner, decodeRawStereoF32Le(child));
    const outerResult = independentlyLimit(ir, outer, innerResult.output);
    assert.deepEqual(actual, encodeRawStereoF32Le(outerResult.output));
    assert.equal(actual.byteLength, 960 * 8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shared limited dialogue referenced by three sidechains is charged once per materialization context", () => {
  const ir = compile(program(`
    Limiter(ceiling: -1dbtp, release: 80ms, lookahead: 5ms) as master {
      Bus(name: "dialogue", role: "dialogue") as dialogue {
        Limiter(ceiling: -2dbtp, release: 60ms, lookahead: 3ms) {
          Tone(frequency: 730hz, duration: 20ms, amplitude: 60%);
        }
        Limiter(ceiling: -2dbtp, release: 60ms, lookahead: 3ms) {
          Tone(frequency: 910hz, duration: 20ms, amplitude: 50%);
        }
      }
      Sidechain(source: dialogue, amount: -6db, threshold: -30db, attack: 1ms, release: 10ms) {
        Tone(frequency: 220hz, duration: 20ms, amplitude: 20%);
      }
      Sidechain(source: dialogue, amount: -6db, threshold: -30db, attack: 1ms, release: 10ms) {
        Tone(frequency: 330hz, duration: 20ms, amplitude: 20%);
      }
      Sidechain(source: dialogue, amount: -6db, threshold: -30db, attack: 1ms, release: 10ms) {
        Tone(frequency: 440hz, duration: 20ms, amplitude: 20%);
      }
    }
  `, "220s"));
  const master = nodes(ir, "cut.audio.limiter").find((node) => node.children.some((id) => ir.nodes[id]?.op === "cut.audio.bus"));
  assert.ok(master);
  const plans = validateReferenceAudioLimiterPlans(ir, ir.compositions[0], [master.id]);
  assert.equal(plans.length, 3, "one master and two dialogue processors are the three physical limiter plans");
});

test("shared-sidechain limiter reuse is PCM-identical to separately materialized equivalent keys", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-limiter-shared-sidechain-"));
  const limiter = (frequency: number) => `Limiter(ceiling: -2dbtp, release: 30ms, lookahead: 1ms) {
    Tone(frequency: ${frequency}hz, duration: 20ms, amplitude: 60%);
  }`;
  const sidechain = (source: string, frequency: number) => `Sidechain(source: ${source}, amount: -6db, threshold: -30db, attack: 1ms, release: 10ms) {
    Tone(frequency: ${frequency}hz, duration: 20ms, amplitude: 20%);
  }`;
  try {
    const shared = compile(program(`
      Limiter(ceiling: -1dbtp, release: 40ms, lookahead: 2ms) as master {
        Bus(name: "dialogue", role: "dialogue") as dialogue { ${limiter(730)} }
        ${sidechain("dialogue", 220)}
        ${sidechain("dialogue", 330)}
        ${sidechain("dialogue", 440)}
      }
    `));
    const separate = compile(program(`
      Bus(name: "key-one") as keyOne { ${limiter(730)} }
      Bus(name: "key-two") as keyTwo { ${limiter(730)} }
      Bus(name: "key-three") as keyThree { ${limiter(730)} }
      Limiter(ceiling: -1dbtp, release: 40ms, lookahead: 2ms) as master {
        Bus(name: "dialogue", role: "dialogue") { ${limiter(730)} }
        ${sidechain("keyOne", 220)}
        ${sidechain("keyTwo", 330)}
        ${sidechain("keyThree", 440)}
      }
    `));
    const sharedMaster = nodes(shared, "cut.audio.limiter").find((node) => node.children.some((id) => shared.nodes[id]?.op === "cut.audio.bus"));
    const separateMaster = nodes(separate, "cut.audio.limiter").find((node) => node.children.some((id) => separate.nodes[id]?.op === "cut.audio.bus"));
    assert.ok(sharedMaster && separateMaster);
    const sharedOutput = resolve(root, "shared.f32le");
    const separateOutput = resolve(root, "separate.f32le");
    const sharedBuild = await renderReferenceAudioSelection(
      shared,
      shared.compositions[0],
      root,
      sharedOutput,
      [sharedMaster.id],
      { outputFormat: "raw-stereo-f32le" },
    );
    const separateBuild = await renderReferenceAudioSelection(
      separate,
      separate.compositions[0],
      root,
      separateOutput,
      [separateMaster.id],
      { outputFormat: "raw-stereo-f32le" },
    );
    assert.equal(sharedBuild.limiter.preparedExecutions, 2, "master plus one shared dialogue limiter execute once each");
    assert.equal(separateBuild.limiter.preparedExecutions, 5, "the equivalent independently materialized graph executes all five physical limiters");
    assert.deepEqual(await readFile(sharedOutput), await readFile(separateOutput));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("distinct limiter nodes in transform-owned contexts remain aggregate-work bounded", () => {
  const body = Array.from({ length: 6 }, (_, index) => `
    TimeStretch(sourceDuration: 200ms, duration: 300ms, pitch: ${index + 1}, quality: "draft") {
      Limiter(ceiling: -2dbtp, release: 60ms, lookahead: 3ms) {
        Tone(frequency: ${600 + index * 40}hz, duration: 200ms, amplitude: 40%);
      }
    }
  `).join("\n");
  const distinct = compile(program(body, "220s"));
  const transformed = compile(program(`
    Bus(name: "dialogue", role: "dialogue") as dialogue {
      Limiter(ceiling: -2dbtp, release: 60ms, lookahead: 3ms) {
        Tone(frequency: 3khz, duration: 100ms, amplitude: 5%);
      }
    }
    ${Array.from({ length: 5 }, (_, index) => `
      TimeStretch(sourceDuration: 100ms, duration: 150ms, pitch: ${index + 1}, quality: "draft") {
        Sidechain(source: dialogue, amount: -1db, threshold: -3db, attack: 1ms, release: 10ms) {
          Tone(frequency: ${400 + index * 40}hz, duration: 100ms, amplitude: 1%);
        }
      }
    `).join("\n")}
  `, "220s"));
  const cases = [
    {
      ir: distinct,
      roots: nodes(distinct, "cut.audio.time_stretch").map((node) => node.id),
      uniqueLimiters: 6,
    },
    {
      ir: transformed,
      roots: referenceMasterAudioRootIds(transformed, transformed.compositions[0]),
      uniqueLimiters: 1,
    },
  ];
  for (const current of cases) {
    assert.equal(nodes(current.ir, "cut.audio.limiter").length, current.uniqueLimiters);
    assert.throws(
      () => validateReferenceAudioLimiterPlans(current.ir, current.ir.compositions[0], current.roots),
      (error: unknown) => {
        assert.ok(error instanceof ReferenceAudioLimiterPreparationError);
        assert.equal(error.code, "CUT_AUDIO_LIMITER_WORK_LIMIT");
        assert.match(error.message, /across 6 materialized executions/u);
        assert.equal(error.source.module, "project.cut");
        assert.ok(error.source.line > 0 && error.source.column > 0);
        return true;
      },
    );
  }
});

test("cyclic and compact amplifying processor graphs fail the materialization audit before DSP allocation", () => {
  const cycle = compile(program(`
    Limiter(ceiling: -1dbtp) {
      Limiter(ceiling: -2dbtp) {
        Tone(frequency: 440hz, duration: 20ms);
      }
    }
  `));
  const cycleLimiters = nodes(cycle, "cut.audio.limiter");
  const outer = cycleLimiters.find((node) => cycleLimiters.some((candidate) => node.children.includes(candidate.id)));
  assert.ok(outer);
  const inner = cycle.nodes[outer.children[0]];
  assert.ok(inner?.op === "cut.audio.limiter");
  inner.children = [outer.id];
  assert.throws(
    () => validateReferenceAudioLimiterPlans(cycle, cycle.compositions[0], [outer.id]),
    (error: unknown) => {
      assert.ok(error instanceof ReferenceAudioLimiterPreparationError);
      assert.equal(error.code, "CUT_AUDIO_LIMITER_GRAPH");
      assert.match(error.message, /materialization contains a cycle/u);
      return true;
    },
  );

  const amplifying = compile(program(Array.from({ length: 36 }, (_, index) => `
    Limiter(ceiling: -${1 + index % 8}dbtp) {
      Tone(frequency: ${300 + index * 10}hz, duration: 20ms);
    }
  `).join("\n")));
  const layers = nodes(amplifying, "cut.audio.limiter");
  assert.equal(layers.length, 36);
  for (let layer = 0; layer < 17; layer += 1) {
    const next = [layers[(layer + 1) * 2]!.id, layers[(layer + 1) * 2 + 1]!.id];
    layers[layer * 2]!.children = next;
    layers[layer * 2 + 1]!.children = next;
  }
  assert.throws(
    () => validateReferenceAudioLimiterPlans(amplifying, amplifying.compositions[0], [layers[0]!.id, layers[1]!.id]),
    (error: unknown) => {
      assert.ok(error instanceof ReferenceAudioLimiterPreparationError);
      assert.equal(error.code, "CUT_AUDIO_LIMITER_WORK_LIMIT");
      assert.match(error.message, /(?:exceeded \d+ (?:bounded node visits|recursive processor contexts)|more than \d+ prepared executions)/u);
      return true;
    },
  );

  const deep = compile(program(`
    Limiter(ceiling: -1dbtp) {
      Tone(frequency: 440hz, duration: 20ms);
    }
  `));
  const template = nodes(deep, "cut.audio.limiter")[0]!;
  const leafId = template.children[0]!;
  const depth = 514;
  for (let index = 0; index < depth; index += 1) {
    const clone = structuredClone(template);
    clone.id = `deep-limiter-${index}`;
    clone.children = [index + 1 < depth ? `deep-limiter-${index + 1}` : leafId];
    deep.nodes[clone.id] = clone;
  }
  assert.throws(
    () => validateReferenceAudioLimiterPlans(deep, deep.compositions[0], ["deep-limiter-0"]),
    (error: unknown) => {
      assert.ok(error instanceof ReferenceAudioLimiterPreparationError);
      assert.equal(error.code, "CUT_AUDIO_LIMITER_WORK_LIMIT");
      assert.match(error.message, /bounded processor-context depth 512/u);
      return true;
    },
  );

  const missing = compile(program(`
    Limiter(ceiling: -1dbtp) {
      Tone(frequency: 440hz, duration: 20ms);
    }
  `));
  const missingOwner = nodes(missing, "cut.audio.limiter")[0]!;
  missingOwner.children = ["missing-private-child"];
  assert.throws(
    () => validateReferenceAudioLimiterPlans(missing, missing.compositions[0], [missingOwner.id]),
    (error: unknown) => {
      assert.ok(error instanceof ReferenceAudioLimiterPreparationError);
      assert.equal(error.code, "CUT_AUDIO_LIMITER_GRAPH");
      assert.equal(error.source.nodeId, missingOwner.id);
      assert.match(error.message, /references missing node missing-private-child/u);
      return true;
    },
  );
});

test("Limiter preserves exact silence, onset, tail boundary, and programme duration", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-limiter-boundary-"));
  try {
    const ir = compile(program(`
      at 5ms {
        Limiter(ceiling: -6dbtp, release: 10ms, lookahead: 2ms) {
          Tone(frequency: 1000hz, duration: 5ms, amplitude: 90%);
        }
      }
    `));
    assert.doesNotThrow(() => validateReferenceSession(ir));
    const limiter = nodes(ir, "cut.audio.limiter")[0];
    assert.ok(limiter);
    const output = decodeRawStereoF32Le(await renderRaw(ir, root, "boundary.f32le", [limiter.id]));
    assert.equal(output.length, 960 * 2);
    assert.ok([...output.subarray(0, 240 * 2)].every((sample) => sample === 0));
    assert.ok([...output.subarray(240 * 2, 480 * 2)].some((sample) => sample !== 0));
    assert.ok([...output.subarray(480 * 2)].every((sample) => sample === 0));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsupported limiter rate and work beyond the bounded five-minute file domain fail source-located before output allocation", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-limiter-refusal-"));
  try {
    const rateIr = compile(program(
      "Limiter(ceiling: -1dbtp, lookahead: 0ms) { Tone(frequency: 440hz, duration: 20ms); }",
      "20ms",
      "44.1khz",
    ));
    const rateOutput = resolve(root, "unsupported-rate.f32le");
    await assert.rejects(
      renderReferenceAudioSelection(rateIr, rateIr.compositions[0], root, rateOutput, [nodes(rateIr, "cut.audio.limiter")[0].id], { outputFormat: "raw-stereo-f32le" }),
      (error: unknown) => {
        assert.ok(error instanceof ReferenceAudioLimiterError);
        assert.equal(error.code, "CUT_AUDIO_LIMITER_SAMPLE_RATE_UNSUPPORTED");
        assert.equal(error.source.module, "project.cut");
        assert.ok(error.source.line > 0 && error.source.column > 0);
        assert.equal(error.source.nodeId, nodes(rateIr, "cut.audio.limiter")[0].id);
        return true;
      },
    );
    await assert.rejects(access(rateOutput));

    const workIr = compile(program(
      "Limiter(ceiling: -1dbtp, lookahead: 0ms) { Tone(frequency: 440hz, duration: 301s); }",
      "301s",
    ));
    const workOutput = resolve(root, "unsupported-work.f32le");
    const workLimiters = nodes(workIr, "cut.audio.limiter");
    assert.equal(workLimiters.length, 1);
    await assert.rejects(
      renderReferenceAudioSelection(workIr, workIr.compositions[0], root, workOutput, workLimiters.map((node) => node.id), { outputFormat: "raw-stereo-f32le" }),
      (error: unknown) => {
        assert.ok(error instanceof ReferenceAudioLimiterError);
        assert.equal(error.code, "CUT_AUDIO_LIMITER_WORK_LIMIT");
        assert.equal(error.source.module, "project.cut");
        assert.ok(error.source.line > 0 && error.source.column > 0);
        assert.ok(workLimiters.some((node) => node.id === error.source.nodeId));
        return true;
      },
    );
    await assert.rejects(access(workOutput));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public Limiter renders a 240-second programme through the bounded file path", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-limiter-long-runtime-"));
  try {
    const ir = compile(program(
      "Limiter(ceiling: -1dbtp, release: 80ms, lookahead: 5ms) { Tone(frequency: 440hz, duration: 20ms, amplitude: 40%); }",
      "240s",
    ));
    const limiter = nodes(ir, "cut.audio.limiter")[0];
    assert.ok(limiter);
    const output = resolve(root, "long.f32le");
    const captured = await withCapturedFfmpegGraphs(root, () => renderReferenceAudioSelection(
        ir,
        ir.compositions[0],
        root,
        output,
        [limiter.id],
        { outputFormat: "raw-stereo-f32le" },
      ));
    const rendered = captured.value;
    assert.equal((await stat(output)).size, 240 * 48_000 * 8);
    assert.equal(rendered.limiter.preparedExecutions, 1);
    assert.equal(rendered.limiter.executions[0].core.frames, 240 * 48_000);
    assert.deepEqual(rendered.limiter.executions[0].core.execution, {
      mode: "chunked-file",
      chunkFrames: 65_536,
    });
    assert.ok(rendered.limiter.executions[0].core.outputTruePeak.linear > 0);
    assert.equal(rendered.limiter.executions[0].compatibility.status, "verified-static");
    if (rendered.limiter.executions[0].compatibility.status === "verified-static") {
      assert.equal(
        rendered.limiter.executions[0].compatibility.passes[0].boundary.expectedFrames,
        240 * 48_000,
      );
    }
    if (process.platform !== "win32") assert.doesNotMatch(captured.graph, /\balimiter\s*=/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
