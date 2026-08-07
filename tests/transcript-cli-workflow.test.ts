import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import sharp from "sharp";
import { rational } from "../lib/language/rational";
import { cutTranscriptExecutableLimits } from "../lib/language/transcript-contract";

const cli = resolve("dist-cli/cli/cut.js");
const digest = "a".repeat(64);

const source = `cut 0.4;
project "CLI transcript proof";
import { AudioGap, AudioTrack, PictureClip, PictureTrack, Sequence, TranscriptAudio, transcriptEdit } from "@cut/edit";
import { TranscriptCaptions } from "cut:visual";

asset words: DataAsset = data("assets/words.cut-transcript.json");
asset voice: AudioAsset = audio("assets/voice.wav", stream: 0);
asset camera: VideoAsset = video("assets/camera.mov");
asset face: FontAsset = font("assets/face.ttf");

timeline main(duration: 1s, fps: 24, width: 640px, height: 360px, sampleRate: 48khz) {
  scene answer(duration: 1s) {
    let quote: TranscriptEdit = transcriptEdit(
      transcript: words,
      source: voice,
      from: "hello",
      through: "world",
      at: 250ms,
      link: "answer"
    );
    Sequence(duration: 1s) {
      PictureTrack() {
        PictureClip(source: camera, range: 0s ..< 1s, duration: 1s, link: "answer");
      }
    }
    TranscriptCaptions(edit: quote, font: face, maxWords: 2, position: "bottom");
    AudioTrack() {
      AudioGap(destination: 0s ..< 250ms);
      TranscriptAudio(edit: quote, fadeIn: 10ms, fadeOut: 10ms);
      AudioGap(destination: 750ms ..< 1s);
    }
  }
}

export release = render(main, width: 640px, height: 360px, codec: "h264");
`;

function sidecar(text = "world") {
  return JSON.stringify({
    format: "cut-transcript",
    version: 1,
    media: {
      sha256: digest,
      audioStreamIndex: 0,
      audioSampleRate: 48_000,
      duration: { numerator: "1", denominator: "1" },
    },
    words: [
      {
        id: "hello",
        start: { numerator: "0", denominator: "1" },
        end: { numerator: "1", denominator: "4" },
        text: "Hello",
        join: "none",
      },
      {
        id: "world",
        start: { numerator: "1", denominator: "4" },
        end: { numerator: "1", denominator: "2" },
        text,
        join: "space",
      },
    ],
  });
}

function oversizedSelectionSidecar() {
  const wordBytes = 4_096;
  const wordCount = Math.floor(
    cutTranscriptExecutableLimits.maximumSelectedTextBytes / wordBytes,
  ) + 1;
  const words = Array.from({ length: wordCount }, (_, index) => ({
    id: `w${index}`,
    start: rational(index, 48_000),
    end: rational(index + 1, 48_000),
    text: "x".repeat(wordBytes),
    join: index === 0 ? "none" : "space",
  }));
  return JSON.stringify({
    format: "cut-transcript",
    version: 1,
    media: {
      sha256: digest,
      audioStreamIndex: 0,
      audioSampleRate: 48_000,
      duration: rational(wordCount, 48_000),
    },
    words,
  });
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function monoPcm16Wave(sampleRate = 48_000, seconds = 1) {
  const frames = sampleRate * seconds;
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + frames * 2, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(frames * 2, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    const sample = Math.round(Math.sin(2 * Math.PI * 440 * frame / sampleRate) * 0.12 * 32_767);
    bytes.writeInt16LE(sample, 44 + frame * 2);
  }
  return bytes;
}

function monoPcm24Wave(sampleRate = 48_000, seconds = 1) {
  const frames = sampleRate * seconds;
  const bytes = Buffer.alloc(44 + frames * 3);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + frames * 3, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 3, 28);
  bytes.writeUInt16LE(3, 32);
  bytes.writeUInt16LE(24, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(frames * 3, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    const sample = Math.round(Math.sin(2 * Math.PI * 440 * frame / sampleRate) * 0.12 * 8_388_607);
    bytes.writeIntLE(sample, 44 + frame * 3, 3);
  }
  return bytes;
}

function cleanRoomSidecar(audioSha256: string) {
  return JSON.stringify({
    format: "cut-transcript",
    version: 1,
    media: {
      sha256: audioSha256,
      audioStreamIndex: 0,
      audioSampleRate: 48_000,
      duration: { numerator: "1", denominator: "1" },
    },
    words: [
      {
        id: "cut",
        start: { numerator: "0", denominator: "1" },
        end: { numerator: "1", denominator: "4" },
        text: "CUT",
        join: "none",
        speaker: "narrator",
      },
      {
        id: "speaks",
        start: { numerator: "1", denominator: "4" },
        end: { numerator: "1", denominator: "2" },
        text: "speaks.",
        join: "space",
        speaker: "narrator",
      },
    ],
  });
}

const cleanRoomSource = `cut 0.4;
project "Clean-room transcript CLI";
import { AudioGap, AudioTrack, TranscriptAudio, transcriptEdit } from "@cut/edit";
import { Rect, TranscriptCaptions } from "cut:visual";

asset words: DataAsset = data("assets/words.cut-transcript.json");
asset voice: AudioAsset = audio("assets/voice.wav", proxy: "assets/voice-proxy.wav", stream: 0);
asset face: FontAsset = font("assets/face.ttf");

timeline main(duration: 1s, fps: 4, width: 160px, height: 90px, sampleRate: 48khz) {
  scene proof(duration: 1s) {
    let quote: TranscriptEdit = transcriptEdit(
      transcript: words,
      source: voice,
      from: "cut",
      through: "speaks",
      at: 250ms
    );
    Rect(width: 160px, height: 90px, x: 80px, y: 45px, fill: #123456);
    TranscriptCaptions(
      edit: quote,
      font: face,
      maxWords: 2,
      size: 16px,
      color: #ffffff,
      background: #000000d9,
      position: "bottom",
      align: "center",
      safeX: 5%,
      safeY: 5%,
      maxWidth: 90%,
      padding: 4px,
      radius: 3px,
      lineHeight: 110%
    );
    AudioTrack() {
      AudioGap(destination: 0s ..< 250ms);
      TranscriptAudio(edit: quote, fadeIn: 10ms, fadeOut: 10ms);
      AudioGap(destination: 750ms ..< 1s);
    }
  }
}

export release = render(main, width: 160px, height: 90px, codec: "h264");
`;

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
  assert.ok(payload.subarray(startFrame * 6, endFrame * 6).every((byte) => byte === 0));
}

type CleanRoomCliReport = {
  format: string;
  version: number;
  command: string;
  status: string;
  program: string;
  output: string;
  diagnostics: unknown[];
  sourceHash: string;
  buildId: string;
  summary: {
    resources: number;
    proxies: number;
    jobs: number;
    outputs: number;
    lockedResources: number;
    transcriptBindings: number;
  };
  transcriptBindings: Array<{
    text: string;
    from: string;
    through: string;
    media: { sha256: string };
  }>;
  manifest: {
    format: string;
    output: string;
    duration: number;
    sha256: string;
    canvas: { width: number; height: number };
    frame: { index: number };
    artifact: {
      file: string;
      sha256: string;
      rgbaSha256: string;
      samples: number;
      sampleRate: number;
      channels: number;
    };
    audio: { sampleRate: number };
    media: {
      requested: string;
      selectedProxyResources: number;
      fallbackResources: number;
      resources: Array<{
        resourceId: string;
        selected: string;
        sha256: string;
      }>;
    };
    selection: { kind: string };
    range: { semantics: string };
  };
};

function run(args: string[], cwd: string, expectedCode: number) {
  return new Promise<{ stdout: string; stderr: string }>((accept, reject) => {
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
      if (!settled) {
        settled = true;
        reject(new Error(`cut ${args.join(" ")} timed out`));
      }
    }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === expectedCode) accept(result);
      else reject(new Error(
        `cut ${args.join(" ")} exited ${code ?? signal}, expected ${expectedCode}\n${result.stderr}${result.stdout}`,
      ));
    });
  });
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "cut-transcript-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "main.cut"), source);
  await writeFile(join(root, "assets", "words.cut-transcript.json"), sidecar());
  return root;
}

async function cleanRoomFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "cut-transcript-cli-clean-room-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = join(root, "assets");
  await mkdir(assets, { recursive: true });
  const audio = monoPcm16Wave();
  const proxyAudio = monoPcm24Wave();
  const audioSha256 = sha256(audio);
  const proxyAudioSha256 = sha256(proxyAudio);
  assert.notEqual(audioSha256, proxyAudioSha256);
  await Promise.all([
    writeFile(join(root, "main.cut"), cleanRoomSource),
    writeFile(join(assets, "voice.wav"), audio),
    writeFile(join(assets, "voice-proxy.wav"), proxyAudio),
    writeFile(join(assets, "words.cut-transcript.json"), cleanRoomSidecar(audioSha256)),
    copyFile(resolve("examples/fixtures/Geist-Regular.ttf"), join(assets, "face.ttf")),
  ]);
  return { root, audioSha256, proxyAudioSha256 };
}

test("real CLI check securely loads a public transcript sidecar without hidden state", async (t) => {
  const root = await fixture(t);
  const report = JSON.parse((await run(["check", "main.cut", "--json"], root, 0)).stdout) as {
    format: string;
    status: string;
    diagnostics: unknown[];
  };
  assert.deepEqual(report, {
    format: "cut-diagnostics",
    version: 1,
    command: "check",
    program: "main.cut",
    status: "pass",
    diagnostics: [],
  });

  await writeFile(join(root, "assets", "words.cut-transcript.json"), sidecar("CUT"));
  const corrected = JSON.parse((await run(["check", "main.cut", "--json"], root, 0)).stdout) as {
    status: string;
    diagnostics: unknown[];
  };
  assert.deepEqual({ status: corrected.status, diagnostics: corrected.diagnostics }, {
    status: "pass",
    diagnostics: [],
  });
});

test("real CLI check reports a source-located transcript resource failure", async (t) => {
  const root = await fixture(t);
  await rm(join(root, "assets", "words.cut-transcript.json"));
  const report = JSON.parse((await run(["check", "main.cut", "--json"], root, 1)).stdout) as {
    status: string;
    diagnostics: Array<{
      code: string;
      source: { path: string; line: number; column: number };
      span: { start: { offset: number }; end: { offset: number } };
    }>;
  };
  assert.equal(report.status, "fail");
  const diagnostic = report.diagnostics.find((item) => item.code === "CUT_TRANSCRIPT_RESOURCE");
  assert.ok(diagnostic, JSON.stringify(report));
  assert.equal(diagnostic.source.path, "main.cut");
  assert.ok(diagnostic.source.line > 0 && diagnostic.source.column > 0);
  assert.ok(diagnostic.span.start.offset < diagnostic.span.end.offset);
});

test("real CLI check rejects transcript programs that could not enter strict CutAVIR", { timeout: 60_000 }, async (t) => {
  const root = await fixture(t);
  type Diagnostic = {
    code: string;
    message: string;
    source: { path: string; line: number; column: number };
    span: { start: { offset: number }; end: { offset: number } };
  };
  const rejected = async (
    program: string,
    expectedCode: string,
    expectedSource: RegExp,
  ) => {
    await writeFile(join(root, "main.cut"), program);
    const report = JSON.parse(
      (await run(["check", "main.cut", "--json"], root, 1)).stdout,
    ) as { status: string; diagnostics: Diagnostic[] };
    assert.equal(report.status, "fail");
    const diagnostic = report.diagnostics.find(
      (item) => item.code === expectedCode,
    );
    assert.ok(diagnostic, JSON.stringify(report));
    assert.equal(diagnostic.source.path, "main.cut");
    assert.ok(diagnostic.source.line > 0 && diagnostic.source.column > 0);
    assert.ok(diagnostic.span.start.offset < diagnostic.span.end.offset);
    assert.match(
      program.slice(
        diagnostic.span.start.offset,
        diagnostic.span.end.offset,
      ),
      expectedSource,
    );
    return diagnostic;
  };

  for (const maxWords of ["0", "1.5", "65"]) {
    const program = source.replace("maxWords: 2", `maxWords: ${maxWords}`);
    const diagnostic = await rejected(
      program,
      "CUT_TRANSCRIPT_LIMIT",
      new RegExp(`^${maxWords.replace(".", "\\.")}$`, "u"),
    );
    assert.match(diagnostic.message, /whole Number from 1 through 64/u);
  }

  const captionCall =
    '    TranscriptCaptions(edit: quote, font: face, maxWords: 2, position: "bottom");';
  const clippedProgram = source.replace(
    captionCall,
    `    at 500ms {\n  ${captionCall}\n    }`,
  );
  const clipped = await rejected(
    clippedProgram,
    "CUT_TRANSCRIPT_TIME",
    /^TranscriptCaptions\(/u,
  );
  assert.match(clipped.message, /must contain the complete scene-local/u);

  const oversizedProgram = source
    .replace('from: "hello"', 'from: "w0"')
    .replace('through: "world"', 'through: "w256"');
  await writeFile(
    join(root, "assets", "words.cut-transcript.json"),
    oversizedSelectionSidecar(),
  );
  const oversized = await rejected(
    oversizedProgram,
    "CUT_TRANSCRIPT_LIMIT",
    /"w256"/u,
  );
  assert.match(
    oversized.message,
    new RegExp(
      `${cutTranscriptExecutableLimits.maximumSelectedTextBytes} bytes`,
      "u",
    ),
  );
});

test("clean-room CLI executes transcript captions and audio through check, lock, build, inspect, frame, audition, and render", { timeout: 180_000 }, async (t) => {
  const { root, audioSha256, proxyAudioSha256 } = await cleanRoomFixture(t);
  const reports: string[] = [];
  const invoke = async (args: string[]) => {
    const result = await run([...args, "--json"], root, 0);
    assert.equal(result.stderr, "", args[0]);
    assert.ok(result.stdout.endsWith("\n"), `${args[0]} must terminate its JSON record`);
    assert.equal(result.stdout.trim().split("\n").length, 1, `${args[0]} must emit one JSON record`);
    assert.equal(result.stdout.includes(root), false, `${args[0]} report leaked its clean-room root`);
    reports.push(result.stdout);
    return JSON.parse(result.stdout) as CleanRoomCliReport;
  };

  const checked = await invoke(["check", "main.cut"]);
  assert.deepEqual(checked, {
    format: "cut-diagnostics",
    version: 1,
    command: "check",
    program: "main.cut",
    status: "pass",
    diagnostics: [],
  });

  const locked = await invoke(["lock", "main.cut", "--out", "cut.lock"]);
  assert.deepEqual({
    format: locked.format,
    version: locked.version,
    command: locked.command,
    status: locked.status,
    program: locked.program,
    output: locked.output,
    resources: locked.summary.resources,
    proxies: locked.summary.proxies,
    jobs: locked.summary.jobs,
  }, {
    format: "cut-lock-report",
    version: 1,
    command: "lock",
    status: "pass",
    program: "main.cut",
    output: "cut.lock",
    resources: 3,
    proxies: 1,
    jobs: 0,
  });
  assert.match(locked.sourceHash, /^[a-f0-9]{64}$/u);

  const built = await invoke(["build", "main.cut", "--lock", "cut.lock", "--out", "graph.cutir.json"]);
  assert.deepEqual({
    format: built.format,
    version: built.version,
    command: built.command,
    status: built.status,
    program: built.program,
    output: built.output,
    resources: built.summary.resources,
    outputs: built.summary.outputs,
  }, {
    format: "cut-build-report",
    version: 1,
    command: "build",
    status: "pass",
    program: "main.cut",
    output: "graph.cutir.json",
    resources: 3,
    outputs: 1,
  });
  assert.match(built.buildId, /^[a-f0-9]{64}$/u);

  const inspectedResult = await run(["inspect", "main.cut", "--lock", "cut.lock", "--json"], root, 0);
  const inspectedRepeat = await run(["inspect", "main.cut", "--lock", "cut.lock", "--json"], root, 0);
  assert.equal(inspectedResult.stderr, "");
  assert.equal(inspectedResult.stdout, inspectedRepeat.stdout, "inspect JSON must be byte-stable across clean invocations");
  assert.equal(inspectedResult.stdout.includes(root), false);
  reports.push(inspectedResult.stdout, inspectedRepeat.stdout);
  const inspected = JSON.parse(inspectedResult.stdout) as CleanRoomCliReport;
  assert.deepEqual({
    format: inspected.format,
    version: inspected.version,
    status: inspected.status,
    program: inspected.program,
    buildId: inspected.buildId,
    resources: inspected.summary.resources,
    lockedResources: inspected.summary.lockedResources,
    transcriptBindings: inspected.summary.transcriptBindings,
  }, {
    format: "cut-inspect-report",
    version: 1,
    status: "pass",
    program: "main.cut",
    buildId: built.buildId,
    resources: 3,
    lockedResources: 3,
    transcriptBindings: 1,
  });
  assert.deepEqual({
    text: inspected.transcriptBindings[0]?.text,
    from: inspected.transcriptBindings[0]?.from,
    through: inspected.transcriptBindings[0]?.through,
    audioSha256: inspected.transcriptBindings[0]?.media.sha256,
  }, {
    text: "CUT speaks.",
    from: "cut",
    through: "speaks",
    audioSha256,
  });

  const silenceFrame = await invoke([
    "frame", "main.cut", "--lock", "cut.lock", "--frame", "0", "--out", "review/silence.png",
  ]);
  const captionFrame = await invoke([
    "frame", "main.cut", "--lock", "cut.lock", "--frame", "2", "--out", "review/caption.png",
  ]);
  const proxyCaptionFrame = await invoke([
    "frame", "main.cut", "--lock", "cut.lock", "--frame", "2", "--profile", "proxy", "--out", "review/caption-proxy.png",
  ]);
  for (const [report, index, file] of [
    [silenceFrame, 0, "silence.png"],
    [captionFrame, 2, "caption.png"],
    [proxyCaptionFrame, 2, "caption-proxy.png"],
  ] as const) {
    assert.deepEqual({
      format: report.format,
      version: report.version,
      command: report.command,
      status: report.status,
      artifact: report.manifest.format,
      frame: report.manifest.frame.index,
      width: report.manifest.canvas.width,
      height: report.manifest.canvas.height,
      file: report.manifest.artifact.file,
    }, {
      format: "cut-frame-report",
      version: 1,
      command: "frame",
      status: "pass",
      artifact: "cut-reference-frame",
      frame: index,
      width: 160,
      height: 90,
      file,
    });
  }
  assert.notEqual(
    silenceFrame.manifest.artifact.rgbaSha256,
    captionFrame.manifest.artifact.rgbaSha256,
    "caption interval must change actual rendered pixels",
  );
  assert.equal(
    captionFrame.manifest.artifact.rgbaSha256,
    proxyCaptionFrame.manifest.artifact.rgbaSha256,
    "verified byte-different audio proxy selection must preserve transcript caption pixels",
  );
  assert.deepEqual({
    requested: captionFrame.manifest.media.requested,
    selectedProxyResources: captionFrame.manifest.media.selectedProxyResources,
    voiceSha256: captionFrame.manifest.media.resources.find((resource) => resource.resourceId === "voice")?.sha256,
  }, {
    requested: "master",
    selectedProxyResources: 0,
    voiceSha256: audioSha256,
  });
  assert.deepEqual({
    requested: proxyCaptionFrame.manifest.media.requested,
    selectedProxyResources: proxyCaptionFrame.manifest.media.selectedProxyResources,
    voiceSha256: proxyCaptionFrame.manifest.media.resources.find((resource) => resource.resourceId === "voice")?.sha256,
  }, {
    requested: "proxy",
    selectedProxyResources: 1,
    voiceSha256: proxyAudioSha256,
  });
  const silencePng = await readFile(join(root, "review", "silence.png"));
  const captionPng = await readFile(join(root, "review", "caption.png"));
  const proxyCaptionPng = await readFile(join(root, "review", "caption-proxy.png"));
  assert.equal(sha256(silencePng), silenceFrame.manifest.artifact.sha256);
  assert.equal(sha256(captionPng), captionFrame.manifest.artifact.sha256);
  assert.equal(sha256(proxyCaptionPng), proxyCaptionFrame.manifest.artifact.sha256);
  const silenceRaw = await sharp(silencePng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const captionRaw = await sharp(captionPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual(
    { width: silenceRaw.info.width, height: silenceRaw.info.height, channels: silenceRaw.info.channels },
    { width: 160, height: 90, channels: 4 },
  );
  assert.deepEqual(
    { width: captionRaw.info.width, height: captionRaw.info.height, channels: captionRaw.info.channels },
    { width: 160, height: 90, channels: 4 },
  );
  const background = silenceRaw.data.subarray(0, 4);
  for (let offset = 0; offset < silenceRaw.data.byteLength; offset += 4) {
    assert.deepEqual(silenceRaw.data.subarray(offset, offset + 4), background, "silence frame must remain the authored flat background");
  }
  let changedPixels = 0;
  for (let offset = 0; offset < captionRaw.data.byteLength; offset += 4) {
    if (!captionRaw.data.subarray(offset, offset + 4).equals(background)) changedPixels += 1;
  }
  assert.ok(changedPixels > 100, `caption interval changed only ${changedPixels} pixels`);

  const audition = await invoke([
    "audition", "main.cut", "--lock", "cut.lock", "--samples", "0:48000", "--out", "review/full.wav",
  ]);
  assert.deepEqual({
    format: audition.format,
    version: audition.version,
    command: audition.command,
    status: audition.status,
    artifact: audition.manifest.format,
    samples: audition.manifest.artifact.samples,
    sampleRate: audition.manifest.artifact.sampleRate,
    channels: audition.manifest.artifact.channels,
    selection: audition.manifest.selection.kind,
    range: audition.manifest.range.semantics,
  }, {
    format: "cut-audition-report",
    version: 1,
    command: "audition",
    status: "pass",
    artifact: "cut-reference-audio-audition",
    samples: 48_000,
    sampleRate: 48_000,
    channels: 2,
    selection: "master",
    range: "half-open",
  });
  const auditionBytes = await readFile(join(root, "review", "full.wav"));
  assert.equal(sha256(auditionBytes), audition.manifest.artifact.sha256);
  const pcm = pcm24Payload(auditionBytes);
  assert.equal(pcm.byteLength, 48_000 * 6);
  assertPcm24Silence(pcm, 0, 12_000);
  assertPcm24Silence(pcm, 36_000, 48_000);
  assert.ok(pcm.subarray(16_000 * 6, 32_000 * 6).some((byte) => byte !== 0), "active transcript interval must contain nonzero PCM");

  const previewed = await invoke([
    "preview", "main.cut", "--lock", "cut.lock", "--output", "release", "--out", "output/preview.mp4",
  ]);
  assert.deepEqual({
    format: previewed.format,
    version: previewed.version,
    command: previewed.command,
    status: previewed.status,
    output: previewed.output,
    artifact: previewed.manifest.format,
    requested: previewed.manifest.media.requested,
    selectedProxyResources: previewed.manifest.media.selectedProxyResources,
    voiceSha256: previewed.manifest.media.resources.find((resource) => resource.resourceId === "voice")?.sha256,
  }, {
    format: "cut-preview-report",
    version: 1,
    command: "preview",
    status: "pass",
    output: "release",
    artifact: "cut-reference-render",
    requested: "proxy",
    selectedProxyResources: 1,
    voiceSha256: proxyAudioSha256,
  });
  const previewMovie = await readFile(join(root, "output", "preview.mp4"));
  assert.equal(previewMovie.toString("ascii", 4, 8), "ftyp");
  assert.equal(sha256(previewMovie), previewed.manifest.sha256);

  const rendered = await invoke([
    "render", "main.cut", "--lock", "cut.lock", "--output", "release", "--out", "output/release.mp4",
  ]);
  assert.deepEqual({
    format: rendered.format,
    version: rendered.version,
    command: rendered.command,
    status: rendered.status,
    output: rendered.output,
    artifact: rendered.manifest.format,
    file: rendered.manifest.output,
    duration: rendered.manifest.duration,
    width: rendered.manifest.canvas.width,
    height: rendered.manifest.canvas.height,
    sampleRate: rendered.manifest.audio.sampleRate,
    requested: rendered.manifest.media.requested,
    selectedProxyResources: rendered.manifest.media.selectedProxyResources,
    voiceSha256: rendered.manifest.media.resources.find((resource) => resource.resourceId === "voice")?.sha256,
  }, {
    format: "cut-render-report",
    version: 1,
    command: "render",
    status: "pass",
    output: "release",
    artifact: "cut-reference-render",
    file: "release.mp4",
    duration: 1,
    width: 160,
    height: 90,
    sampleRate: 48_000,
    requested: "master",
    selectedProxyResources: 0,
    voiceSha256: audioSha256,
  });
  const movie = await readFile(join(root, "output", "release.mp4"));
  assert.ok(movie.byteLength > 1_000);
  assert.equal(movie.toString("ascii", 4, 8), "ftyp");
  assert.equal(sha256(movie), rendered.manifest.sha256);

  const sourceBytes = await readFile(join(root, "main.cut"), "utf8");
  const lockBytes = await readFile(join(root, "cut.lock"), "utf8");
  const graphBytes = await readFile(join(root, "graph.cutir.json"), "utf8");
  const renderManifestBytes = await readFile(join(root, "output", "release.mp4.manifest.json"), "utf8");
  for (const [name, contents] of [
    ["source", sourceBytes],
    ["lock", lockBytes],
    ["typed IR", graphBytes],
    ["render manifest", renderManifestBytes],
    ...reports.map((report, index) => [`report ${index}`, report] as const),
  ]) {
    assert.equal(contents.includes(root), false, `${name} leaked the absolute clean-room root`);
  }
  const lockDocument = JSON.parse(lockBytes) as {
    resources: Record<string, {
      locator: string;
      sha256: string;
      proxy?: {
        locator: string;
        sha256: string;
        audioAlignment?: {
          master: { fileSha256: string };
          proxy: { fileSha256: string };
        };
      };
    }>;
  };
  assert.deepEqual(
    Object.values(lockDocument.resources).map((resource) => resource.locator).sort(),
    ["assets/face.ttf", "assets/voice.wav", "assets/words.cut-transcript.json"],
  );
  const lockedVoice = lockDocument.resources.voice;
  assert.deepEqual({
    masterSha256: lockedVoice?.sha256,
    proxyLocator: lockedVoice?.proxy?.locator,
    proxySha256: lockedVoice?.proxy?.sha256,
    alignedMasterSha256: lockedVoice?.proxy?.audioAlignment?.master.fileSha256,
    alignedProxySha256: lockedVoice?.proxy?.audioAlignment?.proxy.fileSha256,
  }, {
    masterSha256: audioSha256,
    proxyLocator: "assets/voice-proxy.wav",
    proxySha256: proxyAudioSha256,
    alignedMasterSha256: audioSha256,
    alignedProxySha256: proxyAudioSha256,
  });

  const forged = structuredClone(lockDocument);
  assert.ok(forged.resources.voice?.proxy?.audioAlignment);
  forged.resources.voice!.proxy!.audioAlignment!.master.fileSha256 = proxyAudioSha256;
  await writeFile(join(root, "forged.lock"), JSON.stringify(forged));
  const forgedResult = await run([
    "frame", "main.cut", "--lock", "forged.lock", "--frame", "2", "--profile", "proxy",
    "--out", "review/forged-must-not-exist.png", "--json",
  ], root, 1);
  const forgedReport = JSON.parse(forgedResult.stdout) as {
    status: string;
    diagnostics: Array<{ code: string }>;
  };
  assert.equal(forgedReport.status, "fail");
  assert.ok(
    forgedReport.diagnostics.some((diagnostic) =>
      diagnostic.code === "CUT_LOCK_METADATA"
      || diagnostic.code === "CUT_LOCK_IDENTITY"
      || diagnostic.code === "CUT_PROXY_AUDIO_ALIGNMENT"),
    JSON.stringify(forgedReport),
  );
  await assert.rejects(readFile(join(root, "review", "forged-must-not-exist.png")), /ENOENT/u);
});
