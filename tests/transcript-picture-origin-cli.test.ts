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

type RationalJson = Readonly<{ numerator: string; denominator: string }>;
type CliResult = Readonly<{ stdout: string; stderr: string }>;
type Origin = "audio-quarter" | "video-quarter";

type OriginCase = Readonly<{
  label: string;
  origin: Origin;
  delta: RationalJson;
  mappedStart: RationalJson;
  mappedEnd: RationalJson;
  firstSourceFrame: number;
  lastSourceFrame: number;
}>;

const originCases: readonly OriginCase[] = [
  {
    label: "positive one-quarter-second delta",
    origin: "audio-quarter",
    delta: { numerator: "1", denominator: "4" },
    mappedStart: { numerator: "3", denominator: "4" },
    mappedEnd: { numerator: "5", denominator: "4" },
    firstSourceFrame: 18,
    lastSourceFrame: 29,
  },
  {
    label: "negative one-quarter-second delta",
    origin: "video-quarter",
    delta: { numerator: "-1", denominator: "4" },
    mappedStart: { numerator: "1", denominator: "4" },
    mappedEnd: { numerator: "3", denominator: "4" },
    firstSourceFrame: 6,
    lastSourceFrame: 17,
  },
];

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
  assert.equal(
    result.stdout.includes(cwd),
    false,
    "CLI JSON leaked its clean-room path",
  );
  return { result, report: JSON.parse(result.stdout) as T };
}

function program(proxy = false) {
  const proxyVideo = proxy ? ', proxy: "assets/interview-proxy.mov"' : "";
  return `cut 0.4;
project "TranscriptPicture presentation-origin proof";
import { AudioGap, AudioTrack, Gap, PictureTrack, Sequence, TranscriptAudio, TranscriptPicture, transcriptEdit } from "@cut/edit";
import { TranscriptCaptions } from "cut:visual";

asset words: DataAsset = data("assets/interview.cut-transcript.json");
asset voice: AudioAsset = audio("assets/interview.mov", stream: 1);
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
        TranscriptPicture(edit: quote, source: camera);
        Gap(duration: 1s);
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

async function generateAv(
  path: string,
  origin: Origin,
  colorPhase = 0,
  videoFrames = 72,
) {
  const videoOffset = origin === "video-quarter" ? ",setpts=PTS+0.25/TB" : "";
  const audioOffset = origin === "audio-quarter" ? ",asetpts=PTS+0.25/TB" : "";
  await exec("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-copyts",
    "-f",
    "lavfi",
    "-i",
    [
      "nullsrc=s=64x64:r=24:d=3",
      `geq=r='mod(N*37+${colorPhase},256)':g='mod(N*67+${colorPhase},256)':b='mod(N*97+${colorPhase},256)'`,
      `trim=end_frame=${videoFrames}`,
    ].join(",") + videoOffset,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:sample_rate=48000:duration=2${audioOffset}`,
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
    "-avoid_negative_ts",
    "disabled",
    path,
  ]);
}

async function sha256(path: string) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function sidecar(
  mediaSha256: string,
  options: Readonly<{
    delta?: RationalJson;
    videoDuration?: RationalJson;
    wordStart?: RationalJson;
    wordEnd?: RationalJson;
  }>,
) {
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
      videoDuration: options.videoDuration
        ?? { numerator: "3", denominator: "1" },
      ...(options.delta === undefined
        ? {}
        : { audioVideoPresentationDelta: options.delta }),
    },
    words: [{
      id: "answer",
      start: options.wordStart
        ?? { numerator: "1", denominator: "2" },
      end: options.wordEnd
        ?? { numerator: "1", denominator: "1" },
      text: "CUT",
      join: "none",
      speaker: "narrator",
    }],
  });
}

async function fixture(
  t: TestContext,
  options: Readonly<{
    origin: Origin;
    delta?: RationalJson;
    wordStart?: RationalJson;
    wordEnd?: RationalJson;
    videoFrames?: number;
    videoDuration?: RationalJson;
    proxy?: boolean;
  }>,
) {
  const root = await mkdtemp(resolve(tmpdir(), "cut-transcript-origin-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = resolve(root, "assets");
  await mkdir(assets, { recursive: true });
  const media = resolve(assets, "interview.mov");
  await generateAv(media, options.origin, 0, options.videoFrames ?? 72);
  const mediaSha256 = await sha256(media);
  await Promise.all([
    writeFile(resolve(root, "main.cut"), program(options.proxy)),
    writeFile(
      resolve(assets, "interview.cut-transcript.json"),
      sidecar(mediaSha256, options),
    ),
    copyFile(
      resolve("examples/fixtures/Geist-Regular.ttf"),
      resolve(assets, "face.ttf"),
    ),
  ]);
  if (options.proxy) {
    await copyFile(media, resolve(assets, "interview-proxy.mov"));
  }
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

function assertPcm24Silence(
  payload: Buffer,
  startFrame: number,
  endFrame: number,
) {
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
  span?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
}>;

async function assertMissing(root: string, names: readonly string[]) {
  for (const name of names) {
    await assert.rejects(access(resolve(root, name)));
  }
}

test("public TranscriptPicture executes positive and negative presentation-origin deltas through decoded picture and audio", { timeout: 480_000 }, async (t) => {
  for (const originCase of originCases) {
    await t.test(originCase.label, { timeout: 240_000 }, async (child) => {
      const { root, media, mediaSha256 } = await fixture(child, {
        origin: originCase.origin,
        delta: originCase.delta,
      });

      const checked = await invokeJson<{
        status: string;
        diagnostics: unknown[];
      }>(["check", "main.cut"], root);
      assert.equal(checked.report.status, "pass");
      assert.deepEqual(checked.report.diagnostics, []);

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

      const ir = JSON.parse(
        await readFile(resolve(root, "graph.cutir.json"), "utf8"),
      ) as CutAVIR;
      assert.doesNotThrow(() => validateCutAvIr(structuredClone(ir)));
      const binding = ir.transcriptBindings?.[0];
      assert.deepEqual(binding?.media.audioVideoPresentationDelta, originCase.delta);
      assert.deepEqual(binding?.sourceRange, {
        start: { numerator: "1", denominator: "2" },
        duration: { numerator: "1", denominator: "2" },
      });
      assert.deepEqual(binding?.destinationRange, {
        start: { numerator: "1", denominator: "2" },
        duration: { numerator: "1", denominator: "2" },
      });
      assert.equal(
        Object.values(ir.nodes).some(
          (node) => node.op === "cut.edit.transcript_picture",
        ),
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
          magnitude: originCase.mappedStart,
          unit: "s",
        },
        end: {
          kind: "quantity",
          dimension: "time",
          magnitude: originCase.mappedEnd,
          unit: "s",
        },
        exclusive: true,
      });
      assert.deepEqual(picture.interval, {
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
        audioVideoPresentationDelta: originCase.delta,
      });

      const inspected = await invokeJson<{
        format: string;
        status: string;
        buildId: string;
        summary: { transcriptBindings: number };
        counts: { nodeOperations: Record<string, number> };
        transcriptBindings: Array<{
          media: { audioVideoPresentationDelta?: RationalJson };
        }>;
      }>(["inspect", "main.cut", "--lock", "cut.lock"], root);
      assert.equal(inspected.report.format, "cut-inspect-report");
      assert.equal(inspected.report.status, "pass");
      assert.equal(inspected.report.buildId, built.report.buildId);
      assert.equal(inspected.report.summary.transcriptBindings, 1);
      assert.equal(
        inspected.report.counts.nodeOperations["cut.edit.transcript_picture"]
          ?? 0,
        0,
      );
      assert.equal(
        inspected.report.counts.nodeOperations["cut.edit.picture_clip"],
        1,
      );
      assert.deepEqual(
        inspected.report.transcriptBindings[0]?.media
          .audioVideoPresentationDelta,
        originCase.delta,
      );

      await Promise.all([
        extractSourceFrame(
          media,
          originCase.firstSourceFrame,
          resolve(root, "source-first.png"),
        ),
        extractSourceFrame(
          media,
          originCase.lastSourceFrame,
          resolve(root, "source-last.png"),
        ),
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
        frame(23),
        frame(24),
      ]);
      for (const [report, index] of [
        [before.report, 11],
        [first.report, 12],
        [last.report, 23],
        [after.report, 24],
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
      );
      assert.notEqual(
        first.report.manifest.artifact.rgbaSha256,
        before.report.manifest.artifact.rgbaSha256,
      );
      assert.notEqual(
        last.report.manifest.artifact.rgbaSha256,
        after.report.manifest.artifact.rgbaSha256,
      );

      const [sourceFirst, sourceLast, destinationFirst, destinationLast] =
        await Promise.all([
          rgba(resolve(root, "source-first.png")),
          rgba(resolve(root, "source-last.png")),
          rgba(resolve(root, "frame-12.png")),
          rgba(resolve(root, "frame-23.png")),
        ]);
      const sourceFirstPixel = pixel(sourceFirst, 2, 2);
      const sourceLastPixel = pixel(sourceLast, 2, 2);
      assert.ok(
        maximumRgbDelta(sourceFirstPixel, sourceLastPixel) > 40,
        `${sourceFirstPixel} and ${sourceLastPixel} must identify different decoded frames`,
      );
      assert.ok(
        maximumRgbDelta(pixel(destinationFirst, 2, 2), sourceFirstPixel) <= 3,
        `destination frame 12 did not begin at decoded source frame ${originCase.firstSourceFrame}: ${pixel(destinationFirst, 2, 2)} versus ${sourceFirstPixel}`,
      );
      assert.ok(
        maximumRgbDelta(pixel(destinationLast, 2, 2), sourceLastPixel) <= 3,
        `destination frame 23 did not end at decoded source frame ${originCase.lastSourceFrame}: ${pixel(destinationLast, 2, 2)} versus ${sourceLastPixel}`,
      );
      assert.ok(
        nonUniformPixels(
          destinationFirst,
          pixel(destinationFirst, 2, 2),
          8,
        ) > 80,
        "the unchanged TranscriptEdit destination must caption its first picture frame",
      );
      assert.ok(
        nonUniformPixels(
          destinationLast,
          pixel(destinationLast, 2, 2),
          8,
        ) > 80,
        "the presentation delta must not shift captions away from the final exact destination frame",
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
        "the exact TranscriptEdit destination interval must contain selected audio",
      );
      assertPcm24Silence(pcm, 48_000, 96_000);

      const previewed = await invokeJson<{
        format: string;
        status: string;
        manifest: {
          media: {
            requested: string;
            selectedProxyResources: number;
            fallbackResources: number;
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
      assert.deepEqual({
        requested: previewed.report.manifest.media.requested,
        proxies: previewed.report.manifest.media.selectedProxyResources,
      }, {
        requested: "proxy",
        proxies: 0,
      });
      assert.ok(previewed.report.manifest.media.fallbackResources >= 2);
      assert.equal(
        (await readFile(resolve(root, "preview.mp4"))).toString("ascii", 4, 8),
        "ftyp",
      );

      const rendered = await invokeJson<{
        format: string;
        status: string;
        manifest: {
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
        duration: 2,
        canvas: { width: 64, height: 64 },
        requested: "master",
        proxies: 0,
      });
      assert.equal(
        (await readFile(resolve(root, "release.mp4"))).toString("ascii", 4, 8),
        "ftyp",
      );
    });
  }
});

async function assertLockDeltaRefusal(
  t: TestContext,
  delta: RationalJson | undefined,
  expectedMessage: RegExp,
) {
  const { root } = await fixture(t, {
    origin: "audio-quarter",
    ...(delta === undefined ? {} : { delta }),
  });
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
  assert.equal(
    diagnostic.source?.path,
    "$.transcriptBindings[0].media.audioVideoPresentationDelta",
  );
  assert.equal(diagnostic.source?.module, "project.cut");
  assert.ok((diagnostic.source?.line ?? 0) > 0);
  assert.ok((diagnostic.source?.column ?? 0) > 0);
  assert.match(diagnostic.message, expectedMessage);
  await assertMissing(root, [
    "cut.lock",
    "graph.cutir.json",
    "preview.mp4",
    "release.mp4",
  ]);
}

test("omitted and wrong presentation deltas refuse lock stably before any executable output", { timeout: 240_000 }, async (t) => {
  await t.test("omitted delta means exact zero, not an inferred offset", async (child) => {
    await assertLockDeltaRefusal(
      child,
      undefined,
      /omitted audioVideoPresentationDelta canonically asserts exact 0\/1s but independently observed audio-anchor minus video-anchor delta is 1\/4s/u,
    );
  });
  await t.test("wrong authored delta is not trusted", async (child) => {
    await assertLockDeltaRefusal(
      child,
      { numerator: "-1", denominator: "4" },
      /declared audioVideoPresentationDelta -1\/4s but independently observed audio-anchor minus video-anchor delta is 1\/4s/u,
    );
  });
});

test("a presentation delta that maps speech before decoded frame zero fails check before output", { timeout: 240_000 }, async (t) => {
  const { root } = await fixture(t, {
    origin: "video-quarter",
    delta: { numerator: "-1", denominator: "4" },
    wordStart: { numerator: "1", denominator: "10" },
    wordEnd: { numerator: "3", denominator: "5" },
  });
  const attempt = async () => invokeJson<{
    status: string;
    diagnostics: Diagnostic[];
  }>(["check", "main.cut"], root, 1);
  const first = await attempt();
  const second = await attempt();
  assert.equal(first.result.stdout, second.result.stdout);
  assert.equal(first.report.status, "fail");
  const diagnostic = first.report.diagnostics.find(
    (candidate) => candidate.code === "CUT_TRANSCRIPT_PICTURE_TIME",
  );
  assert.ok(diagnostic, JSON.stringify(first.report));
  assert.equal(diagnostic.source?.path, "main.cut");
  assert.ok((diagnostic.source?.line ?? 0) > 0);
  assert.ok((diagnostic.source?.column ?? 0) > 0);
  assert.match(
    diagnostic.message,
    /maps to video-local start -3\/20s before decoded frame zero through audioVideoPresentationDelta -1\/4s/u,
  );
  await assertMissing(root, [
    "cut.lock",
    "graph.cutir.json",
    "preview.mp4",
    "release.mp4",
  ]);
});

test("a presentation delta that maps speech beyond decoded video duration fails check before output", { timeout: 240_000 }, async (t) => {
  const { root } = await fixture(t, {
    origin: "audio-quarter",
    delta: { numerator: "1", denominator: "4" },
    videoFrames: 48,
    videoDuration: { numerator: "2", denominator: "1" },
    wordStart: { numerator: "3", denominator: "2" },
    wordEnd: { numerator: "2", denominator: "1" },
  });
  const attempt = async () => invokeJson<{
    status: string;
    diagnostics: Diagnostic[];
  }>(["check", "main.cut"], root, 1);
  const first = await attempt();
  const second = await attempt();
  assert.equal(first.result.stdout, second.result.stdout);
  assert.equal(first.report.status, "fail");
  const diagnostic = first.report.diagnostics.find(
    (candidate) => candidate.code === "CUT_TRANSCRIPT_PICTURE_TIME",
  );
  assert.ok(diagnostic, JSON.stringify(first.report));
  assert.equal(diagnostic.source?.path, "main.cut");
  assert.ok((diagnostic.source?.line ?? 0) > 0);
  assert.ok((diagnostic.source?.column ?? 0) > 0);
  assert.match(
    diagnostic.message,
    /maps to video-local end 9\/4s beyond decoded-video duration 2\/1s through audioVideoPresentationDelta 1\/4s/u,
  );
  await assertMissing(root, [
    "cut.lock",
    "graph.cutir.json",
    "preview.mp4",
    "release.mp4",
  ]);
});

test("nonzero-origin TranscriptPicture authenticates an identical picture proxy through lock and preview", { timeout: 240_000 }, async (t) => {
  const { root } = await fixture(t, {
    origin: "audio-quarter",
    delta: { numerator: "1", denominator: "4" },
    proxy: true,
  });
  const checked = await invokeJson<{
    status: string;
    diagnostics: Diagnostic[];
  }>(["check", "main.cut"], root);
  assert.equal(checked.report.status, "pass");
  assert.deepEqual(checked.report.diagnostics, []);
  const locked = await invokeJson<{ status: string; summary: { proxies: number } }>(
    ["lock", "main.cut", "--out", "cut.lock"],
    root,
  );
  assert.equal(locked.report.status, "pass");
  assert.equal(locked.report.summary.proxies, 1);
  const lock = JSON.parse(await readFile(resolve(root, "cut.lock"), "utf8")) as {
    resources: { camera: { proxy?: { videoAlignment?: { decision?: string } } } };
  };
  assert.equal(lock.resources.camera.proxy?.videoAlignment?.decision, "equivalent");
  const preview = await invokeJson<{
    status: string;
    manifest: {
      media: {
        selectedProxyResources: number;
        fallbackResources: number;
        resources: Array<{ resourceId: string; selected: string; locator: string }>;
      };
    };
  }>(["preview", "main.cut", "--lock", "cut.lock", "--output", "release", "--out", "preview.mp4"], root);
  assert.equal(preview.report.status, "pass");
  assert.equal(preview.report.manifest.media.selectedProxyResources, 1);
  assert.equal(preview.report.manifest.media.fallbackResources, 1);
  const camera = preview.report.manifest.media.resources.find((resource) => resource.resourceId === "camera");
  assert.deepEqual(
    camera && { selected: camera.selected, locator: camera.locator },
    { selected: "proxy", locator: "assets/interview-proxy.mov" },
  );
  const movie = await readFile(resolve(root, "preview.mp4"));
  assert.equal(movie.toString("ascii", 4, 8), "ftyp");
});
