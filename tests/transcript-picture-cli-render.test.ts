import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import sharp from "sharp";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { validateCutAvIr } from "../lib/language/ir-loader";

const exec = promisify(execFile);
const cli = resolve("dist-cli/cli/cut.js");

type CliResult = Readonly<{ stdout: string; stderr: string }>;

function runCli(
  args: readonly string[],
  cwd: string,
  expectedCode = 0,
): Promise<CliResult> {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      if (settled) return;
      settled = true;
      reject(new Error(`cut ${args.join(" ")} timed out`));
    }, 120_000);
    const finish = (error?: Error, result?: CliResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else accept(result!);
    };
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.on("error", finish);
    child.on("exit", (code, signal) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === expectedCode) finish(undefined, result);
      else {
        finish(new Error(
          `cut ${args.join(" ")} exited ${code ?? signal}, expected ${expectedCode}\n${result.stderr}${result.stdout}`,
        ));
      }
    });
  });
}

async function invokeJson<T>(
  args: readonly string[],
  cwd: string,
  expectedCode = 0,
) {
  const result = await runCli([...args, "--json"], cwd, expectedCode);
  assert.equal(result.stderr, "");
  assert.ok(result.stdout.endsWith("\n"));
  assert.equal(result.stdout.trim().split("\n").length, 1);
  assert.equal(result.stdout.includes(cwd), false, "CLI JSON leaked its clean-room path");
  return { result, report: JSON.parse(result.stdout) as T };
}

function program(proxy = false) {
  const proxyAudio = proxy ? ', proxy: "assets/interview-proxy.mov"' : "";
  const proxyVideo = proxy ? ', proxy: "assets/interview-proxy.mov"' : "";
  return `cut 0.4;
project "TranscriptPicture real-media proof";
import { AudioGap, AudioTrack, Gap, PictureTrack, Sequence, TranscriptAudio, TranscriptPicture, transcriptEdit } from "@cut/edit";
import { TranscriptCaptions } from "cut:visual";

asset words: DataAsset = data("assets/interview.cut-transcript.json");
asset voice: AudioAsset = audio("assets/interview.mov"${proxyAudio}, stream: 1);
asset camera: VideoAsset = video("assets/interview.mov"${proxyVideo}, videoStream: 0, audioStream: 1);
asset face: FontAsset = font("assets/face.ttf");

timeline main(duration: 2s, fps: 24, width: 64px, height: 64px, sampleRate: 48khz) {
  scene answer(duration: 2s) {
    let quote: TranscriptEdit = transcriptEdit(
      transcript: words,
      source: voice,
      from: "answer",
      through: "answer",
      at: 500ms,
      link: "answer-av"
    );
    Sequence(duration: 2s) {
      PictureTrack() {
        Gap(duration: 1s / 2);
        TranscriptPicture(
          edit: quote,
          source: camera,
          opacity: 90%
        );
        Gap(duration: 23s / 24);
      }
    }
    TranscriptCaptions(
      edit: quote,
      font: face,
      maxWords: 1,
      size: 12px,
      color: #ffffff,
      background: #000000d9,
      position: "bottom",
      align: "center",
      safeX: 4%,
      safeY: 4%,
      maxWidth: 92%,
      padding: 3px,
      radius: 2px,
      lineHeight: 110%
    );
    AudioTrack() {
      AudioGap(destination: 0s ..< 500ms);
      TranscriptAudio(edit: quote, fadeIn: 10ms, fadeOut: 10ms);
      AudioGap(destination: 1s ..< 2s);
    }
  }
}

export release = render(main, width: 64px, height: 64px, codec: "h264");
`;
}

type FixtureOptions = Readonly<{
  videoFrames?: number;
  videoStart?: "zero" | "quarter-second";
  proxy?: boolean;
  unrelatedProxy?: boolean;
}>;

async function generateAv(
  path: string,
  options: Readonly<{
    videoFrames: number;
    videoStart: "zero" | "quarter-second";
    colorPhase?: number;
  }>,
) {
  const phase = options.colorPhase ?? 0;
  const video = [
    "nullsrc=s=64x64:r=24:d=3",
    `geq=r='mod(N*37+${phase},256)':g='mod(N*67+${phase},256)':b='mod(N*97+${phase},256)'`,
    `trim=end_frame=${options.videoFrames}`,
    ...(options.videoStart === "quarter-second"
      ? ["setpts=PTS+0.25/TB"]
      : []),
  ].join(",");
  await exec("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    ...(options.videoStart === "quarter-second" ? ["-copyts"] : []),
    "-f",
    "lavfi",
    "-i",
    video,
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=2",
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "0",
    "-pix_fmt",
    "yuv444p",
    "-video_track_timescale",
    "24000",
    "-c:a",
    "pcm_s24le",
    ...(options.videoStart === "quarter-second"
      ? ["-avoid_negative_ts", "disabled"]
      : []),
    path,
  ]);
}

async function generateProxyAv(input: string, output: string) {
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-i", input,
    "-map", "0:v:0", "-map", "0:a:0", "-vf", "scale=32:32:flags=lanczos",
    "-c:v", "libx264", "-preset", "fast", "-crf", "26", "-pix_fmt", "yuv420p",
    "-video_track_timescale", "24000", "-c:a", "pcm_s24le", output,
  ]);
}

async function sha256(path: string) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function sidecar(mediaSha256: string) {
  return JSON.stringify({
    format: "cut-transcript",
    version: 1,
    media: {
      sha256: mediaSha256,
      audioStreamIndex: 1,
      audioSampleRate: 48_000,
      duration: { numerator: "2", denominator: "1" },
      videoStreamIndex: 0,
      videoFrameRate: { numerator: "24", denominator: "1" },
      videoDuration: { numerator: "3", denominator: "1" },
    },
    words: [{
      id: "answer",
      start: { numerator: "1", denominator: "10" },
      end: { numerator: "3", denominator: "5" },
      text: "CUT",
      join: "none",
      speaker: "narrator",
    }],
  });
}

async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "cut-transcript-picture-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = resolve(root, "assets");
  await mkdir(assets, { recursive: true });
  const media = resolve(assets, "interview.mov");
  await generateAv(media, {
    videoFrames: options.videoFrames ?? 72,
    videoStart: options.videoStart ?? "zero",
  });
  const mediaSha256 = await sha256(media);
  const writes: Promise<unknown>[] = [
    writeFile(resolve(root, "main.cut"), program(options.proxy)),
    writeFile(
      resolve(assets, "interview.cut-transcript.json"),
      sidecar(mediaSha256),
    ),
    copyFile(resolve("examples/fixtures/Geist-Regular.ttf"), resolve(assets, "face.ttf")),
  ];
  if (options.proxy) {
    const proxy = resolve(assets, "interview-proxy.mov");
    writes.push(options.unrelatedProxy
      ? generateAv(proxy, {
          videoFrames: 72,
          videoStart: "zero",
          colorPhase: 101,
        })
      : generateProxyAv(media, proxy));
  }
  await Promise.all(writes);
  return { root, media, mediaSha256 };
}

function oneNode(ir: CutAVIR, predicate: (node: IRNode) => boolean) {
  const result = Object.values(ir.nodes).filter(predicate);
  assert.equal(result.length, 1);
  return result[0]!;
}

async function extractSourceFrame(
  media: string,
  index: number,
  output: string,
) {
  await exec("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    media,
    "-map",
    "0:v:0",
    "-vf",
    `select=eq(n\\,${index})`,
    "-frames:v",
    "1",
    output,
  ]);
}

async function rgba(path: string) {
  return sharp(await readFile(path)).ensureAlpha().raw().toBuffer({
    resolveWithObject: true,
  });
}

function pixel(
  image: Awaited<ReturnType<typeof rgba>>,
  x: number,
  y: number,
) {
  const offset = (y * image.info.width + x) * image.info.channels;
  return [...image.data.subarray(offset, offset + 4)];
}

function maximumRgbDelta(left: ArrayLike<number>, right: ArrayLike<number>) {
  return Math.max(
    Math.abs(left[0]! - right[0]!),
    Math.abs(left[1]! - right[1]!),
    Math.abs(left[2]! - right[2]!),
  );
}

function nonUniformPixels(
  image: Awaited<ReturnType<typeof rgba>>,
  reference: readonly number[],
  tolerance: number,
) {
  let changed = 0;
  for (let offset = 0; offset < image.data.byteLength; offset += 4) {
    const value = image.data.subarray(offset, offset + 4);
    if (maximumRgbDelta(value, reference) > tolerance) changed += 1;
  }
  return changed;
}

function pcm24Payload(bytes: Buffer) {
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  let cursor = 12;
  while (cursor + 8 <= bytes.length) {
    const id = bytes.toString("ascii", cursor, cursor + 4);
    const size = bytes.readUInt32LE(cursor + 4);
    const body = cursor + 8;
    if (id === "data") return bytes.subarray(body, body + size);
    cursor = body + size + (size % 2);
  }
  assert.fail("audition artifact has no WAVE data chunk");
}

function assertPcm24Silence(payload: Buffer, startFrame: number, endFrame: number) {
  assert.ok(
    payload.subarray(startFrame * 6, endFrame * 6).every((byte) => byte === 0),
  );
}

type Diagnostic = Readonly<{
  code: string;
  message: string;
  source?: {
    path?: string;
    module?: string;
    line?: number;
    column?: number;
  };
}>;

test("public TranscriptPicture executes exact picture, audio, and captions through the real CLI", { timeout: 240_000 }, async (t) => {
  const { root, media, mediaSha256 } = await fixture(t);
  const checked = await invokeJson<{
    status: string;
    diagnostics: unknown[];
  }>(["check", "main.cut"], root);
  assert.deepEqual(checked.report, {
    format: "cut-diagnostics",
    version: 1,
    command: "check",
    program: "main.cut",
    status: "pass",
    diagnostics: [],
  });

  const locked = await invokeJson<{
    format: string;
    status: string;
    summary: { resources: number; proxies: number };
  }>(["lock", "main.cut", "--out", "cut.lock"], root);
  assert.deepEqual({
    format: locked.report.format,
    status: locked.report.status,
    resources: locked.report.summary.resources,
    proxies: locked.report.summary.proxies,
  }, {
    format: "cut-lock-report",
    status: "pass",
    resources: 4,
    proxies: 0,
  });

  const built = await invokeJson<{
    format: string;
    status: string;
    buildId: string;
  }>([
    "build",
    "main.cut",
    "--lock",
    "cut.lock",
    "--out",
    "graph.cutir.json",
  ], root);
  assert.equal(built.report.format, "cut-build-report");
  assert.equal(built.report.status, "pass");
  assert.match(built.report.buildId, /^[a-f0-9]{64}$/u);

  const ir = JSON.parse(await readFile(resolve(root, "graph.cutir.json"), "utf8")) as CutAVIR;
  assert.doesNotThrow(() => validateCutAvIr(structuredClone(ir)));
  assert.equal(
    Object.values(ir.nodes).some((node) => node.op === "cut.edit.transcript_picture"),
    false,
  );
  const picture = oneNode(
    ir,
    (node) => node.op === "cut.edit.picture_clip"
      && node.inputs.transcriptPictureIdentity !== undefined,
  );
  assert.deepEqual(picture.inputs.range, {
    kind: "range",
    start: {
      kind: "quantity",
      dimension: "time",
      magnitude: { numerator: "1", denominator: "12" },
      unit: "s",
    },
    end: {
      kind: "quantity",
      dimension: "time",
      magnitude: { numerator: "5", denominator: "8" },
      unit: "s",
    },
    exclusive: true,
  });
  assert.deepEqual(picture.interval, {
    start: { numerator: "1", denominator: "2" },
    duration: { numerator: "13", denominator: "24" },
  });
  assert.deepEqual(ir.transcriptBindings?.[0]?.destinationRange, {
    start: { numerator: "1", denominator: "2" },
    duration: { numerator: "1", denominator: "2" },
  });
  assert.deepEqual(ir.transcriptBindings?.[0]?.media, {
    sha256: mediaSha256,
    audioStreamIndex: 1,
    audioSampleRate: 48_000,
    duration: { numerator: "2", denominator: "1" },
    videoStreamIndex: 0,
    videoFrameRate: { numerator: "24", denominator: "1" },
    videoDuration: { numerator: "3", denominator: "1" },
  });

  const inspected = await invokeJson<{
    format: string;
    status: string;
    buildId: string;
    summary: { transcriptBindings: number };
    counts: { nodeOperations: Record<string, number> };
    transcriptBindings: Array<{
      text: string;
      source: { module: string; line: number; column: number };
      media: { videoDuration: { numerator: string; denominator: string } };
    }>;
  }>(["inspect", "main.cut", "--lock", "cut.lock"], root);
  assert.equal(inspected.report.format, "cut-inspect-report");
  assert.equal(inspected.report.status, "pass");
  assert.equal(inspected.report.buildId, built.report.buildId);
  assert.equal(inspected.report.summary.transcriptBindings, 1);
  assert.equal(inspected.report.counts.nodeOperations["cut.edit.transcript_picture"] ?? 0, 0);
  assert.equal(inspected.report.counts.nodeOperations["cut.edit.picture_clip"], 1);
  assert.deepEqual({
    text: inspected.report.transcriptBindings[0]?.text,
    source: inspected.report.transcriptBindings[0]?.source,
    videoDuration: inspected.report.transcriptBindings[0]?.media.videoDuration,
  }, {
    text: "CUT",
    source: { module: "project.cut", line: 13, column: 33 },
    videoDuration: { numerator: "3", denominator: "1" },
  });

  await Promise.all([
    extractSourceFrame(media, 2, resolve(root, "source-2.png")),
    extractSourceFrame(media, 14, resolve(root, "source-14.png")),
  ]);
  type FrameReport = {
    format: string;
    status: string;
    manifest: {
      frame: { index: number };
      artifact: { rgbaSha256: string };
      media: { requested: string; selectedProxyResources: number };
    };
  };
  const frame = async (index: number) => invokeJson<FrameReport>([
    "frame",
    "main.cut",
    "--lock",
    "cut.lock",
    "--frame",
    String(index),
    "--out",
    `frame-${index}.png`,
  ], root);
  const [before, first, last, after] = await Promise.all([
    frame(11),
    frame(12),
    frame(24),
    frame(25),
  ]);
  for (const [report, index] of [
    [before.report, 11],
    [first.report, 12],
    [last.report, 24],
    [after.report, 25],
  ] as const) {
    assert.equal(report.format, "cut-frame-report");
    assert.equal(report.status, "pass");
    assert.equal(report.manifest.frame.index, index);
    assert.deepEqual({
      requested: report.manifest.media.requested,
      proxies: report.manifest.media.selectedProxyResources,
    }, {
      requested: "master",
      proxies: 0,
    });
  }
  assert.equal(
    before.report.manifest.artifact.rgbaSha256,
    after.report.manifest.artifact.rgbaSha256,
    "the frames immediately outside the exact TranscriptPicture interval must be empty",
  );
  assert.notEqual(
    first.report.manifest.artifact.rgbaSha256,
    before.report.manifest.artifact.rgbaSha256,
  );
  assert.notEqual(
    last.report.manifest.artifact.rgbaSha256,
    after.report.manifest.artifact.rgbaSha256,
  );

  const [source2, source14, firstFrame, lastFrame] = await Promise.all([
    rgba(resolve(root, "source-2.png")),
    rgba(resolve(root, "source-14.png")),
    rgba(resolve(root, "frame-12.png")),
    rgba(resolve(root, "frame-24.png")),
  ]);
  for (const image of [source2, source14, firstFrame, lastFrame]) {
    assert.deepEqual({
      width: image.info.width,
      height: image.info.height,
      channels: image.info.channels,
    }, {
      width: 64,
      height: 64,
      channels: 4,
    });
  }
  const source2Pixel = pixel(source2, 2, 2);
  const source14Pixel = pixel(source14, 2, 2);
  const opacityOverBlack = (value: readonly number[]) => [
    Math.round(value[0]! * 0.9),
    Math.round(value[1]! * 0.9),
    Math.round(value[2]! * 0.9),
    255,
  ];
  const expected2 = opacityOverBlack(source2Pixel);
  const expected14 = opacityOverBlack(source14Pixel);
  assert.ok(
    maximumRgbDelta(source2Pixel, source14Pixel) > 40,
    `${source2Pixel} and ${source14Pixel} must visibly identify different source frames`,
  );
  assert.ok(
    maximumRgbDelta(pixel(firstFrame, 2, 2), expected2) <= 4,
    `destination frame 12 did not begin at 90%-opaque covered source frame 2: ${pixel(firstFrame, 2, 2)} versus ${expected2}`,
  );
  assert.ok(
    maximumRgbDelta(pixel(lastFrame, 2, 2), expected14) <= 4,
    `destination frame 24 did not end on 90%-opaque covered source frame 14: ${pixel(lastFrame, 2, 2)} versus ${expected14}`,
  );
  assert.equal(pixel(lastFrame, 2, 2)[3], 255);
  assert.ok(
    maximumRgbDelta(pixel(lastFrame, 2, 2), source14Pixel) > 5,
    `TranscriptPicture opacity: 90% did not causally darken the source over the opaque black composition: ${pixel(lastFrame, 2, 2)} versus ${source14Pixel}`,
  );
  assert.ok(
    nonUniformPixels(firstFrame, pixel(firstFrame, 2, 2), 8) > 80,
    "the same TranscriptEdit interval must materially render its caption over the first picture frame",
  );
  assert.ok(
    nonUniformPixels(lastFrame, pixel(lastFrame, 2, 2), 8) < 8,
    "the picture-only cover tail must remain after the exact caption/audio interval ends",
  );

  const audition = await invokeJson<{
    format: string;
    status: string;
    manifest: {
      artifact: {
        samples: number;
        sampleRate: number;
        channels: number;
      };
    };
  }>([
    "audition",
    "main.cut",
    "--lock",
    "cut.lock",
    "--samples",
    "0:96000",
    "--out",
    "full.wav",
  ], root);
  assert.deepEqual({
    format: audition.report.format,
    status: audition.report.status,
    samples: audition.report.manifest.artifact.samples,
    sampleRate: audition.report.manifest.artifact.sampleRate,
    channels: audition.report.manifest.artifact.channels,
  }, {
    format: "cut-audition-report",
    status: "pass",
    samples: 96_000,
    sampleRate: 48_000,
    channels: 2,
  });
  const pcm = pcm24Payload(await readFile(resolve(root, "full.wav")));
  assert.equal(pcm.byteLength, 96_000 * 6);
  assertPcm24Silence(pcm, 0, 24_000);
  assert.ok(
    pcm.subarray(28_000 * 6, 44_000 * 6).some((byte) => byte !== 0),
    "the TranscriptEdit destination interval must contain selected source audio",
  );
  assertPcm24Silence(pcm, 48_000, 96_000);

  const previewed = await invokeJson<{
    format: string;
    status: string;
    manifest: {
      format: string;
      media: {
        requested: string;
        selectedProxyResources: number;
        fallbackResources: number;
        resources: Array<{
          resourceId: string;
          selected: string;
          sha256: string;
          requested: string;
          fallback: boolean;
          kind: string;
        }>;
      };
    };
  }>([
    "preview",
    "main.cut",
    "--lock",
    "cut.lock",
    "--output",
    "release",
    "--out",
    "preview.mp4",
  ], root);
  assert.equal(previewed.report.format, "cut-preview-report");
  assert.equal(previewed.report.status, "pass");
  assert.equal(previewed.report.manifest.format, "cut-reference-render");
  assert.deepEqual({
    requested: previewed.report.manifest.media.requested,
    selectedProxyResources:
      previewed.report.manifest.media.selectedProxyResources,
  }, {
    requested: "proxy",
    selectedProxyResources: 0,
  });
  assert.ok(previewed.report.manifest.media.fallbackResources >= 2);
  for (const resourceId of ["voice", "camera"]) {
    const selected = previewed.report.manifest.media.resources.find(
      (resource) => resource.resourceId === resourceId,
    );
    assert.deepEqual(
      selected && {
        resourceId: selected.resourceId,
        kind: selected.kind,
        requested: selected.requested,
        selected: selected.selected,
        fallback: selected.fallback,
        sha256: selected.sha256,
      },
      {
        resourceId,
        kind: resourceId === "voice" ? "audio" : "video",
        requested: "proxy",
        selected: "master",
        fallback: true,
        sha256: mediaSha256,
      },
      `${resourceId} must fall back explicitly to its locked master`,
    );
  }
  const previewMovie = await readFile(resolve(root, "preview.mp4"));
  assert.equal(previewMovie.toString("ascii", 4, 8), "ftyp");

  const rendered = await invokeJson<{
    format: string;
    status: string;
    manifest: {
      format: string;
      duration: number;
      canvas: { width: number; height: number };
      media: { requested: string; selectedProxyResources: number };
    };
  }>([
    "render",
    "main.cut",
    "--lock",
    "cut.lock",
    "--output",
    "release",
    "--out",
    "release.mp4",
  ], root);
  assert.deepEqual({
    format: rendered.report.format,
    status: rendered.report.status,
    artifact: rendered.report.manifest.format,
    duration: rendered.report.manifest.duration,
    canvas: {
      width: rendered.report.manifest.canvas.width,
      height: rendered.report.manifest.canvas.height,
    },
    requested: rendered.report.manifest.media.requested,
    proxies: rendered.report.manifest.media.selectedProxyResources,
  }, {
    format: "cut-render-report",
    status: "pass",
    artifact: "cut-reference-render",
    duration: 2,
    canvas: { width: 64, height: 64 },
    requested: "master",
    proxies: 0,
  });
  const movie = await readFile(resolve(root, "release.mp4"));
  assert.equal(movie.toString("ascii", 4, 8), "ftyp");
});

async function assertLockRefusal(
  t: TestContext,
  options: FixtureOptions,
  expectedPath: string,
  expectedMessage: RegExp,
) {
  const { root } = await fixture(t, options);
  const checked = await invokeJson<{ status: string; diagnostics: unknown[] }>(
    ["check", "main.cut"],
    root,
  );
  assert.equal(checked.report.status, "pass");
  assert.deepEqual(checked.report.diagnostics, []);

  const attempt = async () => invokeJson<{
    status: string;
    diagnostics: Diagnostic[];
  }>(["lock", "main.cut", "--out", "cut.lock"], root, 1);
  const first = await attempt();
  const second = await attempt();
  assert.equal(first.result.stdout, second.result.stdout);
  assert.equal(first.report.status, "fail");
  assert.equal(first.report.diagnostics.length, 1);
  const diagnostic = first.report.diagnostics[0]!;
  assert.equal(diagnostic.code, "CUT_TRANSCRIPT_LOCK_MEDIA");
  assert.equal(diagnostic.source?.path, expectedPath);
  assert.equal(diagnostic.source?.module, "project.cut");
  assert.ok((diagnostic.source?.line ?? 0) > 0);
  assert.ok((diagnostic.source?.column ?? 0) > 0);
  assert.match(diagnostic.message, expectedMessage);
  await assert.rejects(access(resolve(root, "cut.lock")));
  await assert.rejects(access(resolve(root, "must-not-render.mp4")));
}

test("wrong selected-video duration refuses lock with one stable source-located diagnostic before render", { timeout: 240_000 }, async (t) => {
  await assertLockRefusal(
    t,
    { videoFrames: 71 },
    "$.transcriptBindings[0].media.videoDuration",
    /decoded TranscriptPicture duration 71\/24s does not match sidecar videoDuration 3\/1s/u,
  );
});

test("omitted presentation delta refuses nonzero-origin media with one stable source-located diagnostic before render", { timeout: 240_000 }, async (t) => {
  await assertLockRefusal(
    t,
    { videoStart: "quarter-second" },
    "$.transcriptBindings[0].media.audioVideoPresentationDelta",
    /omitted audioVideoPresentationDelta canonically asserts exact 0\/1s but independently observed audio-anchor minus video-anchor delta is -1\/4s/u,
  );
});

test("TranscriptPicture authenticates a same-source picture proxy through public lock and preview execution", { timeout: 240_000 }, async (t) => {
  const { root } = await fixture(t, { proxy: true });
  const checked = await invokeJson<{
    status: string;
    diagnostics: Diagnostic[];
  }>(["check", "main.cut"], root);
  assert.equal(checked.report.status, "pass");
  assert.deepEqual(checked.report.diagnostics, []);
  const locked = await invokeJson<{
    status: string;
    summary: { proxies: number };
  }>(["lock", "main.cut", "--out", "cut.lock"], root);
  assert.equal(locked.report.status, "pass");
  assert.equal(locked.report.summary.proxies, 2);
  const lock = JSON.parse(await readFile(resolve(root, "cut.lock"), "utf8")) as {
    resources: { camera: { proxy?: { videoAlignment?: { format?: string; decision?: string } } } };
  };
  assert.deepEqual({
    format: lock.resources.camera.proxy?.videoAlignment?.format,
    decision: lock.resources.camera.proxy?.videoAlignment?.decision,
  }, {
    format: "cut-video-proxy-alignment",
    decision: "equivalent",
  });
  const preview = await invokeJson<{
    status: string;
    manifest: {
      media: {
        selectedProxyResources: number;
        fallbackResources: number;
        resources: Array<{ resourceId: string; selected: string; locator: string }>;
      };
    };
  }>(["preview", "main.cut", "--lock", "cut.lock", "--output", "release", "--out", "proxy-preview.mp4"], root);
  assert.equal(preview.report.status, "pass");
  assert.equal(preview.report.manifest.media.selectedProxyResources, 2);
  assert.equal(preview.report.manifest.media.fallbackResources, 0);
  for (const resourceId of ["voice", "camera"]) {
    const selected = preview.report.manifest.media.resources.find((resource) => resource.resourceId === resourceId);
    assert.deepEqual(
      selected && { selected: selected.selected, locator: selected.locator },
      { selected: "proxy", locator: "assets/interview-proxy.mov" },
    );
  }
  const movie = await readFile(resolve(root, "proxy-preview.mp4"));
  assert.equal(movie.toString("ascii", 4, 8), "ftyp");
});

test("TranscriptPicture refuses same-cadence unrelated imagery at public lock with a source-located diagnostic", { timeout: 240_000 }, async (t) => {
  const { root } = await fixture(t, { proxy: true, unrelatedProxy: true });
  const checked = await invokeJson<{ status: string; diagnostics: Diagnostic[] }>(["check", "main.cut"], root);
  assert.equal(checked.report.status, "pass", "source syntax remains authorable so cut lock can create correspondence evidence");
  const first = await invokeJson<{ status: string; diagnostics: Diagnostic[] }>(["lock", "main.cut", "--out", "cut.lock"], root, 1);
  const second = await invokeJson<{ status: string; diagnostics: Diagnostic[] }>(["lock", "main.cut", "--out", "cut.lock"], root, 1);
  assert.equal(first.result.stdout, second.result.stdout);
  const diagnostic = first.report.diagnostics.find((candidate) => candidate.code === "CUT_PROXY_VIDEO_ALIGNMENT");
  assert.ok(diagnostic, JSON.stringify(first.report));
  assert.match(diagnostic.source?.module ?? diagnostic.source?.path ?? "", /(?:main|project)\.cut$/u);
  assert.ok((diagnostic.source?.line ?? 0) > 0);
  assert.match(diagnostic.message, /not frame-correspondent/u);
  await assert.rejects(access(resolve(root, "cut.lock")));
  await assert.rejects(access(resolve(root, "must-not-render.mp4")));
});
