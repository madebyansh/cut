import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import sharp from "sharp";
import type { CutLockfile } from "../lib/language/lock";
import { createReferenceBackendIdentity } from "../lib/runtime/reference/runtime-identity";

const cli = resolve("dist-cli/cli/cut.js");

async function run(args: string[], cwd: string, expectedCode = 0) {
  return new Promise<{ stdout: string; stderr: string }>((accept, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`cut ${args.join(" ")} timed out`)); }, 120_000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (code === expectedCode) accept(result);
      else reject(new Error(`cut ${args.join(" ")} exited ${code ?? signal}, expected ${expectedCode}\n${result.stderr}${result.stdout}`));
    });
  });
}

const source = `cut 0.4;
project "CLI authoring review";
import { Rect } from "cut:visual";
import { Bus, Tone } from "@cut/audio";
timeline main(duration: 1s, fps: 4, width: 64px, height: 36px, sampleRate: 48khz) {
  Bus(name: "dialogue", role: "dialogue") { Tone(frequency: 440hz, duration: 1s, amplitude: 20%); }
  scene only(duration: 1s) { Rect(width: 64px, height: 36px, x: 32px, y: 18px, fill: #ef233c); }
}
export out = render(main, width: 64px, height: 36px, codec: "h264");
`;

const overBudgetAudioSource = `cut 0.4;
project "Picture review excludes unrelated audio work";
import { Rect } from "cut:visual";
import { Limiter, Tone } from "@cut/audio";
timeline main(duration: 301s, fps: 1, width: 64px, height: 36px, sampleRate: 48khz) {
  Limiter(ceiling: -1dbtp, lookahead: 0ms) { Tone(frequency: 440hz, duration: 301s, amplitude: 20%); }
  scene only(duration: 301s) { Rect(width: 64px, height: 36px, x: 32px, y: 18px, fill: #2463eb); }
}
export preview = render(main, width: 64px, height: 36px, codec: "h264");
`;

test("public frame, contact, and audition commands emit closed machine reports and retained manifests", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-cli-review-"));
  try {
    await writeFile(resolve(root, "main.cut"), source);
    await run(["lock", "main.cut", "--out", "cut.lock"], root);
    const frame = JSON.parse((await run(["frame", "main.cut", "--lock", "cut.lock", "--frame", "0", "--out", "review/frame.png", "--profile", "master", "--json"], root)).stdout);
    assert.deepEqual({ format: frame.format, status: frame.status, artifact: frame.manifest.format, index: frame.manifest.frame.index }, { format: "cut-frame-report", status: "pass", artifact: "cut-reference-frame", index: 0 });
    assert.equal(frame.manifest.lock.sha256.length, 64);
    assert.equal(JSON.parse(await readFile(resolve(root, "review/frame.png.manifest.json"), "utf8")).artifact.sha256, frame.manifest.artifact.sha256);

    const contact = JSON.parse((await run(["contact", "main.cut", "--lock", "cut.lock", "--frames", "0,2,3", "--columns", "2", "--thumbnail-width", "64", "--out", "review/contact.png", "--profile", "proxy", "--json"], root)).stdout);
    assert.deepEqual({ format: contact.format, status: contact.status, artifact: contact.manifest.format, frames: contact.manifest.frames.map((item: { index: number }) => item.index) }, { format: "cut-contact-report", status: "pass", artifact: "cut-reference-contact-sheet", frames: [0, 2, 3] });
    assert.equal(contact.manifest.media.requested, "proxy");

    const audition = JSON.parse((await run(["audition", "main.cut", "--lock", "cut.lock", "--samples", "4800:9600", "--stem", "dialogue", "--out", "review/dialogue.wav", "--json"], root)).stdout);
    assert.deepEqual({ format: audition.format, status: audition.status, artifact: audition.manifest.format, samples: audition.manifest.artifact.samples, selection: audition.manifest.selection.kind }, { format: "cut-audition-report", status: "pass", artifact: "cut-reference-audio-audition", samples: 4_800, selection: "stem" });
    assert.equal(JSON.parse(await readFile(resolve(root, "review/dialogue.wav.manifest.json"), "utf8")).range.semantics, "half-open");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("picture-only frame and contact skip unrelated limiter work while audiovisual commands remain fail-closed", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-cli-review-picture-only-"));
  try {
    await writeFile(resolve(root, "main.cut"), overBudgetAudioSource);
    await run(["lock", "main.cut", "--out", "cut.lock"], root);

    const frame = JSON.parse((await run([
      "frame", "main.cut", "--lock", "cut.lock", "--frame", "300", "--out", "review/frame.png", "--json",
    ], root)).stdout);
    assert.deepEqual(
      { status: frame.status, format: frame.manifest.format, index: frame.manifest.frame.index },
      { status: "pass", format: "cut-reference-frame", index: 300 },
    );

    const contact = JSON.parse((await run([
      "contact", "main.cut", "--lock", "cut.lock", "--frames", "0,300", "--columns", "2", "--thumbnail-width", "64", "--out", "review/contact.png", "--json",
    ], root)).stdout);
    assert.deepEqual(
      { status: contact.status, format: contact.manifest.format, frames: contact.manifest.frames.map((item: { index: number }) => item.index) },
      { status: "pass", format: "cut-reference-contact-sheet", frames: [0, 300] },
    );

    const audiovisualCommands = [
      { command: "preview", output: "review/preview.mp4", args: ["preview", "main.cut", "--lock", "cut.lock", "--range", "0s:1s", "--width", "64", "--out", "review/preview.mp4", "--json"] },
      { command: "render", output: "review/render.mp4", args: ["render", "main.cut", "--lock", "cut.lock", "--output", "preview", "--out", "review/render.mp4", "--json"] },
      { command: "audition", output: "review/audition.wav", args: ["audition", "main.cut", "--lock", "cut.lock", "--samples", "0:48000", "--out", "review/audition.wav", "--json"] },
    ] as const;
    for (const expectation of audiovisualCommands) {
      const report = JSON.parse((await run([...expectation.args], root, 1)).stdout);
      const diagnostic = report.diagnostics[0];
      assert.deepEqual(
        { command: report.command, status: report.status, code: diagnostic?.code },
        { command: expectation.command, status: "fail", code: "CUT_AUDIO_LIMITER_WORK_LIMIT" },
      );
      assert.equal(diagnostic?.source?.module, "project.cut");
      assert.ok(diagnostic?.source?.line > 0 && diagnostic?.source?.column > 0 && diagnostic?.source?.nodeId);
      await assert.rejects(readFile(resolve(root, expectation.output)), (error: unknown) =>
        Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("authoring-review CLI rejects unknown flags, ambiguous time, and project escapes with stable JSON diagnostics", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-cli-review-hostile-"));
  try {
    const unknown = JSON.parse((await run(["frame", "missing.cut", "--lock", "missing.lock", "--frame", "0", "--out", "frame.png", "--unknown", "x", "--json"], root, 1)).stdout);
    assert.deepEqual({ command: unknown.command, code: unknown.diagnostics[0].code }, { command: "frame", code: "CUTC1001" });
    await writeFile(resolve(root, "main.cut"), source);
    await run(["lock", "main.cut", "--out", "cut.lock"], root);
    const ambiguous = JSON.parse((await run(["frame", "main.cut", "--lock", "cut.lock", "--frame", "0", "--at", "0s", "--out", "frame.png", "--json"], root, 1)).stdout);
    assert.equal(ambiguous.diagnostics[0].code, "CUT_REVIEW_TOOL_CONTRACT");
    const offGrid = JSON.parse((await run(["frame", "main.cut", "--lock", "cut.lock", "--at", "1/3s", "--out", "frame.png", "--json"], root, 1)).stdout);
    assert.equal(offGrid.diagnostics[0].code, "CUT_REVIEW_TOOL_TIME_GRID");
    const escaped = JSON.parse((await run(["frame", "main.cut", "--lock", "cut.lock", "--frame", "0", "--out", "../escaped.png", "--json"], root, 1)).stdout);
    assert.equal(escaped.diagnostics[0].code, "CUT_REVIEW_TOOL_OUTPUT");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("public review CLI carries the validated lock backend to the post-snapshot execution boundary", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-cli-review-backend-"));
  try {
    await writeFile(resolve(root, "main.cut"), source);
    await run(["lock", "main.cut", "--out", "cut.lock"], root);
    const lock = JSON.parse(await readFile(resolve(root, "cut.lock"), "utf8")) as CutLockfile;
    lock.toolchain.referenceBackend = createReferenceBackendIdentity(
      lock.toolchain.referenceBackend.dependencies,
      { ...lock.toolchain.referenceBackend.native, architecture: `${lock.toolchain.referenceBackend.native.architecture}-other` },
    );
    await writeFile(resolve(root, "foreign.lock"), JSON.stringify(lock));

    const report = JSON.parse((await run([
      "frame", "main.cut", "--lock", "foreign.lock", "--frame", "0", "--out", "review/must-not-exist.png", "--json",
    ], root, 1)).stdout);
    assert.equal(report.diagnostics[0]?.code, "CUT_LOCK_IDENTITY");
    assert.match(report.diagnostics[0]?.message ?? "", /reference backend identity/u);
    await assert.rejects(readFile(resolve(root, "review/must-not-exist.png")), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("public review CLI reports same-size locked image drift before native decode and publishes nothing", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-cli-review-drift-"));
  const imageSource = `cut 0.4;
project "CLI review drift";
import { Image } from "cut:visual";
asset still: ImageAsset = image("media/still.png");
timeline main(duration: 1s, fps: 4, width: 32px, height: 32px) {
  scene only(duration: 1s) { Image(source: still); }
}
export out = render(main, width: 32px, height: 32px, codec: "h264");
`;
  try {
    await mkdir(resolve(root, "media"));
    await sharp({ create: { width: 32, height: 32, channels: 4, background: "#35a853" } }).png().toFile(resolve(root, "media/still.png"));
    await writeFile(resolve(root, "main.cut"), imageSource);
    await run(["lock", "main.cut", "--out", "cut.lock"], root);
    const bytes = Buffer.from(await readFile(resolve(root, "media/still.png")));
    bytes[Math.floor(bytes.byteLength / 2)] ^= 1;
    await writeFile(resolve(root, "media/still.png"), bytes);
    await mkdir(resolve(root, "review"));
    const priorArtifact = Buffer.from("prior-frame-artifact"), priorManifest = Buffer.from("prior-frame-manifest");
    await writeFile(resolve(root, "review/drift.png"), priorArtifact);
    await writeFile(resolve(root, "review/drift.png.manifest.json"), priorManifest);

    const report = JSON.parse((await run([
      "frame", "main.cut", "--lock", "cut.lock", "--frame", "0", "--out", "review/drift.png", "--json",
    ], root, 1)).stdout);
    assert.equal(report.diagnostics[0]?.code, "CUT_LOCK_INTEGRITY");
    assert.deepEqual(await readFile(resolve(root, "review/drift.png")), priorArtifact);
    assert.deepEqual(await readFile(resolve(root, "review/drift.png.manifest.json")), priorManifest);
  } finally { await rm(root, { recursive: true, force: true }); }
});
