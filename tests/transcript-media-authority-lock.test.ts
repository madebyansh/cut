import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
import {
  compileCutModule,
  type CutCompileInputs,
} from "../lib/language/compiler";
import type {
  CutAVIR,
  IRTranscriptMediaAuthorityV1,
} from "../lib/language/ir";
import {
  applyCutLock,
  createCutLock,
  CutLockError,
  type LockedResource,
} from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import {
  CutTranscriptLockError,
  verifyCutTranscriptBindingsForLock,
} from "../lib/language/transcript-lock";
import { cutTranscriptMediaAuthorityIdentity } from "../lib/language/transcript-contract";

const run = promisify(execFile);

function monoPcm16Wav(durationSeconds = 1, sampleRate = 48_000) {
  const frames = durationSeconds * sampleRate;
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
  return bytes;
}

function sidecar(audioSha256: string) {
  return JSON.stringify({
    format: "cut-transcript",
    version: 1,
    media: {
      sha256: audioSha256,
      audioStreamIndex: 0,
      audioSampleRate: 48_000,
      duration: rational(1),
    },
    words: [{
      id: "w1",
      start: rational(0),
      end: rational(1, 2),
      text: "Separate.",
      join: "none",
    }],
  });
}

const source = `cut 0.4;
project "transcript media authority lock";
import { transcriptEdit, transcriptMedia } from "@cut/edit";

asset words: DataAsset = data("assets/interview.transcript.json");
asset voice: AudioAsset = audio("assets/recorder.wav", stream: 0);
asset camera: VideoAsset = video("assets/camera.mkv", videoStream: 0);

timeline main(duration: 1s, fps: 24, width: 320px, height: 180px, sampleRate: 48khz) {
  scene answer(duration: 1s) {
    let sync: TranscriptMediaAuthority = transcriptMedia(
      transcript: words,
      audio: voice,
      audioStream: 0,
      video: camera,
      videoStream: 0,
      videoFrameRate: 30000 / 1001,
      videoDuration: 1001ms,
      audioAt: 1s / 48000,
      videoAt: 1001s / 30000,
      videoRate: 1
    );
    let quote: TranscriptEdit = transcriptEdit(
      transcript: words,
      source: voice,
      from: "w1",
      through: "w1",
      at: 0s,
      media: sync
    );
  }
}

export out = render(main, width: 320px, height: 180px, codec: "h264");
`;

type ProjectFixture = {
  root: string;
  sidecarBytes: Buffer;
  ir: CutAVIR;
  lock: Awaited<ReturnType<typeof createCutLock>>;
  authority: IRTranscriptMediaAuthorityV1;
  bindingId: string;
};

function compile(bytes: Buffer) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  const inputs: CutCompileInputs = {
    transcriptSidecars: new Map([["words", bytes]]),
  };
  return compileCutModule(
    parsed.module,
    {},
    undefined,
    undefined,
    inputs,
  ).ir;
}

function transcriptAuthority(ir: CutAVIR) {
  assert.equal(ir.transcriptMediaAuthorities?.length, 1);
  return ir.transcriptMediaAuthorities[0]!;
}

function lockedMedia(
  resources: Readonly<Record<string, LockedResource>>,
  id: string,
) {
  const resource = resources[id];
  assert.ok(resource?.probe.kind === "media", `${id} must be locked media`);
  return resource as LockedResource & {
    probe: Extract<LockedResource["probe"], { kind: "media" }>;
  };
}

async function fixture(t: TestContext): Promise<ProjectFixture> {
  const root = await mkdtemp(resolve(tmpdir(), "cut-transcript-authority-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = resolve(root, "assets");
  await mkdir(assets, { recursive: true });

  const audioBytes = monoPcm16Wav();
  const audioSha256 = createHash("sha256").update(audioBytes).digest("hex");
  const sidecarBytes = Buffer.from(sidecar(audioSha256));
  await writeFile(resolve(assets, "recorder.wav"), audioBytes);
  await writeFile(resolve(assets, "interview.transcript.json"), sidecarBytes);
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x234567:s=16x16:r=30000/1001",
    "-frames:v",
    "30",
    "-an",
    "-c:v",
    "ffv1",
    "-y",
    resolve(assets, "camera.mkv"),
  ]);

  const ir = compile(sidecarBytes);
  const authority = transcriptAuthority(ir);
  const binding = ir.transcriptBindings?.[0];
  assert.ok(binding);
  const lock = await createCutLock(ir, root);
  return {
    root,
    sidecarBytes,
    ir,
    lock,
    authority,
    bindingId: binding.id,
  };
}

function expectTranscriptLockError(
  bindingId: string,
  code: CutTranscriptLockError["code"],
  path: RegExp,
) {
  return (error: unknown) => error instanceof CutTranscriptLockError
    && error.code === code
    && path.test(error.path)
    && error.source.bindingId === bindingId;
}

test("DOC10-AUTH-01/CLOCK-01: lock authenticates separate selected A/V resources, rational cadence/duration, and nonzero anchors without co-location", { timeout: 180_000 }, async (t) => {
  const project = await fixture(t);
  const audio = lockedMedia(project.lock.resources, "voice");
  const video = lockedMedia(project.lock.resources, "camera");
  assert.notEqual(audio.locator, video.locator);
  assert.notEqual(audio.sha256, video.sha256);
  assert.equal(audio.probe.selected.audio?.streamIndex, 0);
  assert.equal(video.probe.selected.video?.streamIndex, 0);
  assert.deepEqual(
    video.probe.selected.video?.frameRate,
    rational(30_000, 1_001),
  );
  assert.deepEqual(
    video.probe.selected.video?.duration,
    rational(1_001, 1_000),
  );
  assert.equal(
    video.probe.selected.video?.durationSource,
    "decoded-video-cadence",
  );
  assert.ok(video.probe.selected.video?.decodedVideoCadence);
  assert.deepEqual(project.authority.audioAt, rational(1, 48_000));
  assert.deepEqual(project.authority.videoAt, rational(1_001, 30_000));

  await assert.doesNotReject(
    verifyCutTranscriptBindingsForLock(
      project.ir,
      project.lock.resources,
      async () => project.sidecarBytes,
    ),
  );
  const replay = compile(project.sidecarBytes);
  await applyCutLock(replay, project.lock, project.root);
  assert.equal(replay.determinism.semantic, "locked");
  assert.equal(replay.resources.voice?.state, "locked");
  assert.equal(replay.resources.camera?.state, "locked");
});

test("DOC10-AUTH-02/CLOCK-02: lock replay rejects digest, selector, decoded-probe, cadence, duration, anchor, and authority-identity drift", { timeout: 180_000 }, async (t) => {
  const project = await fixture(t);
  const cases: Array<{
    name: string;
    code: CutTranscriptLockError["code"];
    path: RegExp;
    mutate(
      ir: CutAVIR,
      resources: Record<string, LockedResource>,
    ): void;
  }> = [
    {
      name: "audio digest",
      code: "CUT_TRANSCRIPT_LOCK_MEDIA",
      path: /\.media\.sha256$/u,
      mutate(_ir, resources) {
        resources.voice!.sha256 = "f".repeat(64);
      },
    },
    {
      name: "audio selected stream",
      code: "CUT_TRANSCRIPT_LOCK_MEDIA",
      path: /\.media\.audioStreamIndex$/u,
      mutate(_ir, resources) {
        const selected = lockedMedia(resources, "voice").probe.selected.audio;
        assert.ok(selected);
        selected.streamIndex = 1;
      },
    },
    {
      name: "video selected stream",
      code: "CUT_TRANSCRIPT_LOCK_MEDIA",
      path: /\.videoStreamIndex$/u,
      mutate(_ir, resources) {
        const selected = lockedMedia(resources, "camera").probe.selected.video;
        assert.ok(selected);
        selected.streamIndex = 1;
      },
    },
    {
      name: "decoded cadence witness",
      code: "CUT_TRANSCRIPT_LOCK_MEDIA",
      path: /\.videoStreamIndex$/u,
      mutate(_ir, resources) {
        const selected = lockedMedia(resources, "camera").probe.selected.video;
        assert.ok(selected);
        delete selected.decodedVideoCadence;
      },
    },
    {
      name: "rational frame rate",
      code: "CUT_TRANSCRIPT_LOCK_MEDIA",
      path: /\.videoFrameRate$/u,
      mutate(_ir, resources) {
        const selected = lockedMedia(resources, "camera").probe.selected.video;
        assert.ok(selected);
        selected.frameRate = rational(30);
      },
    },
    {
      name: "decoded duration",
      code: "CUT_TRANSCRIPT_LOCK_MEDIA",
      path: /\.videoDuration$/u,
      mutate(_ir, resources) {
        const selected = lockedMedia(resources, "camera").probe.selected.video;
        assert.ok(selected);
        selected.duration = rational(1);
      },
    },
    {
      name: "audio anchor grid",
      code: "CUT_TRANSCRIPT_LOCK_MEDIA",
      path: /\.audioAt$/u,
      mutate(ir) {
        const authority = transcriptAuthority(ir);
        authority.audioAt = rational(1, 44_100);
        authority.identity = cutTranscriptMediaAuthorityIdentity(authority);
      },
    },
    {
      name: "video anchor grid",
      code: "CUT_TRANSCRIPT_LOCK_MEDIA",
      path: /\.videoAt$/u,
      mutate(ir) {
        const authority = transcriptAuthority(ir);
        authority.videoAt = rational(1, 30);
        authority.identity = cutTranscriptMediaAuthorityIdentity(authority);
      },
    },
    {
      name: "authority identity",
      code: "CUT_TRANSCRIPT_LOCK_INTEGRITY",
      path: /\.identity$/u,
      mutate(ir) {
        transcriptAuthority(ir).identity = "e".repeat(64);
      },
    },
    {
      name: "independent video locator",
      code: "CUT_TRANSCRIPT_LOCK_RESOURCE",
      path: /\.videoResourceId$/u,
      mutate(_ir, resources) {
        resources.camera!.locator = "assets/another-camera.mkv";
      },
    },
  ];

  for (const item of cases) {
    const ir = structuredClone(project.ir);
    const resources = structuredClone(
      project.lock.resources,
    ) as Record<string, LockedResource>;
    item.mutate(ir, resources);
    await assert.rejects(
      verifyCutTranscriptBindingsForLock(
        ir,
        resources,
        async () => project.sidecarBytes,
      ),
      (error: unknown) => {
        assert.ok(
          expectTranscriptLockError(
            project.bindingId,
            item.code,
            item.path,
          )(error),
          `${item.name}: ${String(error)}`,
        );
        return true;
      },
    );
  }
});

test("DOC10-AUTH-02: apply lock refuses changed independent video bytes before transcript execution", { timeout: 180_000 }, async (t) => {
  const project = await fixture(t);
  const videoPath = resolve(project.root, "assets/camera.mkv");
  const changed = Buffer.from(await readFile(videoPath));
  assert.ok(changed.length > 64);
  changed[Math.floor(changed.length / 2)] ^= 0x01;
  await writeFile(videoPath, changed);

  await assert.rejects(
    applyCutLock(
      compile(project.sidecarBytes),
      project.lock,
      project.root,
    ),
    (error: unknown) => error instanceof CutLockError
      && error.code === "CUT_LOCK_INTEGRITY"
      && /camera|resources/u.test(error.path),
  );
});
