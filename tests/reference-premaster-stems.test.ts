import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { compileCutModule } from "../lib/language/compiler";
import { parseCutLanguage } from "../lib/language/parser";
import { renderReferenceAudio } from "../lib/runtime/reference/audio";
import {
  planReferenceAudioStems,
  ReferenceStemError,
} from "../lib/runtime/reference/stems";
import { renderReferenceAudioStems } from "./reference-stem-test-helper";

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.equal(parsed.diagnostics.length, 0, parsed.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
  assert.ok(parsed.module);
  return compileCutModule(parsed.module).ir;
}

function program(body: string, imports = "Bus, Limiter, Meter, Submix, Tone") {
  return `cut 0.4;
project "Explicit pre-master boundary";
import { ${imports} } from "@cut/audio";
timeline main(duration: 100ms, fps: 10, sampleRate: 48khz) {
  ${body}
}
export out = render(main);`;
}

function sharedLimiter(ceiling: string, amplitude: string) {
  return program(`Meter(samplePeak: 0dbfs) {
    Limiter(ceiling: ${ceiling}, release: 20ms, lookahead: 5ms) {
      Submix(name: "pre-master") {
        Bus(name: "dialogue", role: "dialogue") {
          Tone(frequency: 1khz, duration: 100ms, amplitude: ${amplitude});
        }
        Bus(name: "music", role: "music") {
          Tone(frequency: 1khz, duration: 100ms, amplitude: ${amplitude});
        }
      }
    }
  }`);
}

function oldPerBusLimiter(ceiling: string, amplitude: string) {
  return program(`Meter(samplePeak: 0dbfs) {
    Bus(name: "dialogue", role: "dialogue") {
      Limiter(ceiling: ${ceiling}, release: 20ms, lookahead: 5ms) {
        Tone(frequency: 1khz, duration: 100ms, amplitude: ${amplitude});
      }
    }
    Bus(name: "music", role: "music") {
      Limiter(ceiling: ${ceiling}, release: 20ms, lookahead: 5ms) {
        Tone(frequency: 1khz, duration: 100ms, amplitude: ${amplitude});
      }
    }
  }`);
}

function pcm24(buffer: Buffer<ArrayBufferLike>) {
  assert.equal(buffer.toString("ascii", 0, 4), "RIFF");
  assert.equal(buffer.toString("ascii", 8, 12), "WAVE");
  let cursor = 12;
  let blockAlign = 0;
  let data: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  while (cursor + 8 <= buffer.length) {
    const id = buffer.toString("ascii", cursor, cursor + 4);
    const size = buffer.readUInt32LE(cursor + 4);
    const body = cursor + 8;
    if (id === "fmt ") {
      assert.equal(buffer.readUInt16LE(body + 2), 2);
      assert.equal(buffer.readUInt32LE(body + 4), 48_000);
      blockAlign = buffer.readUInt16LE(body + 12);
      assert.equal(buffer.readUInt16LE(body + 14), 24);
    } else if (id === "data") {
      data = buffer.subarray(body, body + size);
      break;
    }
    cursor = body + size + (size % 2);
  }
  assert.equal(blockAlign, 6);
  assert.ok(data.length > 0);
  const sample = (frame: number, channel: number) => {
    const offset = frame * blockAlign + channel * 3;
    let value = data[offset] | data[offset + 1] << 8 | data[offset + 2] << 16;
    if (value & 0x800000) value -= 0x1000000;
    return value / 0x800000;
  };
  return { frames: data.length / blockAlign, sample };
}

function maximumDifference(
  left: ReturnType<typeof pcm24>,
  right: (frame: number, channel: number) => number,
) {
  let maximum = 0;
  for (let frame = 0; frame < left.frames; frame += 1) {
    for (let channel = 0; channel < 2; channel += 1) {
      maximum = Math.max(maximum, Math.abs(left.sample(frame, channel) - right(frame, channel)));
    }
  }
  return maximum;
}

test("explicit pre-master Submix selects its Bus children while the master retains shared inserts", () => {
  const ir = compile(sharedLimiter("-6dbtp", "40%"));
  const plan = planReferenceAudioStems(ir, ir.compositions[0]);
  assert.deepEqual(plan.routes.map(({ name, role }) => ({ name, role })), [
    { name: "dialogue", role: "dialogue" },
    { name: "music", role: "music" },
  ]);
  const limiter = Object.values(ir.nodes).find((node) => node.op === "cut.audio.limiter");
  const boundary = Object.values(ir.nodes).find((node) => node.op === "cut.audio.submix");
  assert.ok(limiter && boundary);
  assert.deepEqual(limiter.children, [boundary.id]);
  assert.deepEqual(
    plan.routes.map((route) => route.nodeId),
    boundary.children,
    "stem routes are the authored Bus nodes before shared mastering",
  );
  assert.ok(plan.routes.every((route) => route.nodeId !== limiter.id && route.nodeId !== boundary.id));
});

test("inactive shared limiting preserves the decoded pre-master stem sum", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-premaster-inactive-"));
  try {
    const ir = compile(sharedLimiter("0dbtp", "4%"));
    const composition = ir.compositions[0];
    const masterPath = resolve(root, "master.wav");
    await renderReferenceAudio(ir, composition, root, masterPath);
    const rendered = await renderReferenceAudioStems(ir, composition, root, resolve(root, "stems"));
    const master = pcm24(await readFile(masterPath));
    const dialogue = pcm24(await readFile(resolve(rendered.directory, "dialogue.wav")));
    const music = pcm24(await readFile(resolve(rendered.directory, "music.wav")));
    assert.equal(master.frames, 4_800);
    assert.equal(dialogue.frames, master.frames);
    assert.equal(music.frames, master.frames);
    const error = maximumDifference(master, (frame, channel) => dialogue.sample(frame, channel) + music.sample(frame, channel));
    assert.ok(error <= 4 / 0x800000, `inactive shared limiter decoded-sum error ${error}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("active shared limiting changes the master after the pre-master stems, unlike per-Bus limiting", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-premaster-active-"));
  try {
    const shared = compile(sharedLimiter("-6dbtp", "70%"));
    const sharedMasterPath = resolve(root, "shared-master.wav");
    await renderReferenceAudio(shared, shared.compositions[0], root, sharedMasterPath);
    const stems = await renderReferenceAudioStems(shared, shared.compositions[0], root, resolve(root, "shared-stems"));
    const sharedMaster = pcm24(await readFile(sharedMasterPath));
    const dialogue = pcm24(await readFile(resolve(stems.directory, "dialogue.wav")));
    const music = pcm24(await readFile(resolve(stems.directory, "music.wav")));
    const sharedVsPreMaster = maximumDifference(sharedMaster, (frame, channel) => dialogue.sample(frame, channel) + music.sample(frame, channel));
    assert.ok(sharedVsPreMaster > 0.1, `active shared limiter must materially differ from its pre-master sum; observed ${sharedVsPreMaster}`);

    const old = compile(oldPerBusLimiter("-6dbtp", "70%"));
    const oldMasterPath = resolve(root, "old-per-bus-master.wav");
    await renderReferenceAudio(old, old.compositions[0], root, oldMasterPath);
    const oldMaster = pcm24(await readFile(oldMasterPath));
    const topologyDifference = maximumDifference(sharedMaster, (frame, channel) => oldMaster.sample(frame, channel));
    assert.ok(topologyDifference > 0.1, `per-Bus limiting is not an equivalent workaround for shared mastering; observed ${topologyDifference}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ambiguous inferred, multiple, branching, outside, direct-source, and duration-changing boundaries fail before publication", async () => {
  const cases = [
    {
      name: "old inferred limiter boundary",
      source: program(`Limiter(ceiling: -1dbtp) {
        Bus(name: "dialogue") { Tone(frequency: 1khz, duration: 100ms, amplitude: 10%); }
      }`),
      message: /Submix\(name: "pre-master"\).*will not infer|directly below a shared mastering insert/u,
    },
    {
      name: "multiple boundaries",
      source: program(`
        Submix(name: "pre-master") { Bus(name: "one") { Tone(frequency: 1khz, duration: 100ms, amplitude: 10%); } }
        Submix(name: "pre-master-2") { Bus(name: "two") { Tone(frequency: 2khz, duration: 100ms, amplitude: 10%); } }
      `),
      message: /2 Submix\(name: "pre-master"\) boundaries/u,
      mutate: true,
    },
    {
      name: "non-Bus boundary child",
      source: program(`Submix(name: "pre-master") {
        Limiter(ceiling: -1dbtp) { Bus(name: "inside") { Tone(frequency: 1khz, duration: 100ms, amplitude: 10%); } }
      }`),
      message: /non-Bus child cut\.audio\.limiter/u,
    },
    {
      name: "Bus outside boundary",
      source: program(`
        Submix(name: "pre-master") { Bus(name: "inside") { Tone(frequency: 1khz, duration: 100ms, amplitude: 10%); } }
        Bus(name: "outside") { Tone(frequency: 2khz, duration: 100ms, amplitude: 10%); }
      `),
      message: /sits outside Submix\(name: "pre-master"\)/u,
    },
    {
      name: "direct source at boundary",
      source: program(`Submix(name: "pre-master") {
        Tone(frequency: 1khz, duration: 100ms, amplitude: 10%);
      }`),
      message: /non-Bus child cut\.audio\.tone/u,
    },
    {
      name: "branching shared insert",
      source: program(`Limiter(ceiling: -1dbtp) {
        Submix(name: "pre-master") { Bus(name: "inside") { Tone(frequency: 1khz, duration: 100ms, amplitude: 10%); } }
        Bus(name: "branch") { Tone(frequency: 2khz, duration: 100ms, amplitude: 10%); }
      }`),
      message: /linear chain with exactly one child/u,
    },
    {
      name: "duration processor",
      source: program(`TimeStretch(sourceDuration: 80ms, duration: 100ms, pitch: 0, quality: "draft") {
        Submix(name: "pre-master") { Bus(name: "inside") { Tone(frequency: 1khz, duration: 80ms, amplitude: 10%); } }
      }`, "Bus, Submix, TimeStretch, Tone"),
      message: /cut\.audio\.time_stretch.*above or outside a delivered Bus/u,
    },
  ] as const;

  for (const candidate of cases) {
    const root = await mkdtemp(resolve(tmpdir(), `cut-premaster-refusal-`));
    try {
      const ir = compile(candidate.source);
      if ("mutate" in candidate) {
        const second = Object.values(ir.nodes).filter((node) => node.op === "cut.audio.submix")[1];
        assert.ok(second);
        second.inputs.name = { kind: "string", value: "pre-master" };
      }
      assert.throws(() => planReferenceAudioStems(ir, ir.compositions[0]), (error: unknown) => {
        assert.ok(error instanceof ReferenceStemError, `${candidate.name}: ${String(error)}`);
        assert.equal(error.code, "CUT_STEM_ROUTING_AMBIGUOUS");
        assert.match(error.message, candidate.message);
        return true;
      });
      await assert.rejects(renderReferenceAudioStems(ir, ir.compositions[0], root, resolve(root, "must-not-publish")), (error: unknown) => {
        assert.ok(error instanceof ReferenceStemError, `${candidate.name}: ${String(error)}`);
        assert.equal(error.code, "CUT_STEM_ROUTING_AMBIGUOUS");
        return true;
      });
      assert.deepEqual(await readdir(root), [], `${candidate.name} must fail before destination allocation`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

const cli = resolve("dist-cli/cli/cut.js");

async function runCli(args: string[], cwd: string, expectedCode = 0) {
  return new Promise<{ stdout: string; stderr: string }>((accept, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
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

test("cut render applies final Meter peak to the master and an independent 0 dBFS ceiling to pre-master stems", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-premaster-meter-separation-"));
  try {
    const source = `cut 0.4;
project "Final versus pre-master peak";
import { Bus, Gain, Meter, Submix, Tone } from "@cut/audio";
import { Rect } from "cut:visual";
timeline main(duration: 250ms, fps: 4, width: 64px, height: 64px, sampleRate: 48khz) {
  Meter(target: -14lufs, truePeak: -1dbtp, samplePeak: -6dbfs) {
    Gain(amount: -12db) {
      Submix(name: "pre-master") {
        Bus(name: "dialogue") { Tone(frequency: 1khz, duration: 250ms, amplitude: 80%); }
      }
    }
  }
  scene picture(duration: 250ms) { Rect(width: 64px, height: 64px, fill: #102030); }
}
export out = render(main, width: 64px, height: 64px);`;
    await writeFile(resolve(root, "main.cut"), source);
    await runCli(["lock", "main.cut", "--out", "cut.lock"], root);
    await runCli(["render", "main.cut", "--lock", "cut.lock", "--out", "release.mp4", "--stems", "stems"], root);
    const stemManifest = JSON.parse(await readFile(resolve(root, "stems", "cut-stems.json"), "utf8")) as {
      version: number;
      stems: Array<{ peak: { thresholdDbfs: number; peakDbfs: number | null } }>;
    };
    const renderManifest = JSON.parse(await readFile(resolve(root, "release.mp4.manifest.json"), "utf8")) as {
      audio: { samplePeak: { thresholdDbfs: number } };
    };
    assert.equal(stemManifest.version, 5, "the existing v5 manifest shape remains sufficient");
    assert.equal(stemManifest.stems[0].peak.thresholdDbfs, 0);
    assert.ok((stemManifest.stems[0].peak.peakDbfs ?? -Infinity) > -6, "isolated stem is intentionally hotter than the final Meter ceiling");
    assert.equal(renderManifest.audio.samplePeak.thresholdDbfs, -6);
    await access(resolve(root, "release.mp4"));
    await access(resolve(root, "stems", "dialogue.wav"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
