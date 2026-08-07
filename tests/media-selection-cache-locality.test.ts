import assert from "node:assert/strict";
import test from "node:test";
import type { CutAVIR, IRNode, IRResource } from "../lib/language/ir";
import { rational, type Rational } from "../lib/language/rational";
import type { CutDecodedVideoCadence } from "../lib/language/video-cadence";
import { createIncrementalRenderPlan, CutGraphError, type IncrementalRenderPlan } from "../lib/runtime/graph";

const span = { start: { offset: 0, line: 1, column: 1 }, end: { offset: 1, line: 1, column: 2 } };
const provenance = (symbol: string) => ({ module: "selection-cache.cut", span, symbol });

type TestStream = Record<string, unknown> & { index: number; type: "video" | "audio" };
type TestSelection = {
  streamIndex: number;
  duration: Rational;
  durationSource: "stream" | "decoded-video-cadence";
  timeBase: Rational;
  frameRate?: Rational;
  decodedVideoCadence?: CutDecodedVideoCadence;
};
type TestMediaMetadata = {
  lockVersion: 2;
  bytes: number;
  activeMediaVariant?: "master" | "proxy";
  probe: {
    kind: "media";
    identity: { streams: TestStream[]; container: { duration?: Rational } & Record<string, unknown> } & Record<string, unknown>;
    selected: { video?: TestSelection; audio?: TestSelection };
  };
} & Record<string, unknown>;

function video(index: number, fps: number, width: number): TestStream {
  return {
    index,
    type: "video",
    codec: "h264",
    timeBase: rational(1, fps),
    start: rational(0),
    duration: rational(4),
    frameRate: rational(fps),
    width,
    height: 720,
    pixelFormat: "yuv420p",
    colorRange: "tv",
    colorSpace: "bt709",
    colorTransfer: "bt709",
    colorPrimaries: "bt709",
    disposition: ["default"],
  };
}

function audio(index: number, sampleRate: number): TestStream {
  return {
    index,
    type: "audio",
    codec: "aac",
    timeBase: rational(1, sampleRate),
    start: rational(0),
    duration: rational(4),
    sampleRate,
    channels: 2,
    channelLayout: "stereo",
    disposition: index === 0 || index === 1 ? ["default"] : [],
  };
}

function mediaResource(
  id: string,
  kind: "video" | "audio",
  streams: TestStream[],
  selected: TestMediaMetadata["probe"]["selected"],
): IRResource {
  const locator = `media/${id}.mkv`, sha256 = (id === "primary" ? "1" : id === "soundtrack" ? "2" : "3").repeat(64);
  return {
    id,
    name: id,
    kind,
    locator,
    state: "locked",
    sha256,
    metadata: {
      lockVersion: 2,
      bytes: 4_096,
      probe: {
        kind: "media",
        identity: {
          format: "cut-media-probe",
          version: 1,
          implementation: { name: "ffprobe", version: "7.1" },
          file: { locator, basename: `${id}.mkv`, bytes: 4_096, sha256 },
          container: { names: ["matroska"], duration: rational(4) },
          streams,
          chapters: [],
        },
        selected,
      },
    },
    provenance: provenance(id),
  };
}

function node(id: string, op: string, domain: IRNode["domain"], children: string[], source?: string): IRNode {
  return {
    id,
    op,
    domain,
    ownership: id === "camera" || id === "audio" ? "root" : "child",
    sceneId: "scene",
    interval: { start: rational(0), duration: rational(4) },
    inputs: source ? { source: { kind: "resource-ref", id: source } } : {},
    children,
    properties: {},
    effects: source ? ["read"] : ["pure"],
    contentHash: `${id}-unfinalized`,
    provenance: provenance(id),
  };
}

function fixture(): CutAVIR {
  const linked = node("linked", "cut.edit.clip", "av", [], "primary");
  linked.ownership = "detached";
  delete linked.sceneId;
  const nodes: Record<string, IRNode> = {
    video: node("video", "cut.visual.video", "visual", [], "primary"),
    group: node("group", "cut.visual.group", "visual", ["video"]),
    depth: node("depth", "cut.visual.depth_layer", "visual", ["group"]),
    camera: node("camera", "cut.visual.parallax_camera", "visual", ["depth"]),
    audio: node("audio", "cut.audio.clip", "audio", [], "soundtrack"),
    linked,
  };
  return {
    format: "cut-av-ir",
    version: 3,
    language: "0.4",
    compiler: "cut-ts/cache-selection-test",
    project: "selected media cache locality",
    sourceHash: "source",
    buildId: "unfinalized",
    determinism: { semantic: "locked", decodedMedia: "verified", bitstream: "unverified" },
    timebase: { defaultFps: rational(24), audioSampleRate: 48_000 },
    modules: [],
    resources: {
      primary: mediaResource(
        "primary",
        "video",
        [video(0, 24, 1_280), audio(1, 48_000), video(2, 30, 1_920), audio(3, 44_100)],
        {
          video: { streamIndex: 0, duration: rational(4), durationSource: "stream", timeBase: rational(1, 24), frameRate: rational(24) },
          audio: { streamIndex: 1, duration: rational(4), durationSource: "stream", timeBase: rational(1, 48_000) },
        },
      ),
      soundtrack: mediaResource(
        "soundtrack",
        "audio",
        [audio(0, 48_000), audio(1, 44_100)],
        { audio: { streamIndex: 0, duration: rational(4), durationSource: "stream", timeBase: rational(1, 48_000) } },
      ),
      unused: mediaResource(
        "unused",
        "video",
        [video(0, 24, 640), video(2, 30, 960)],
        { video: { streamIndex: 0, duration: rational(4), durationSource: "stream", timeBase: rational(1, 24), frameRate: rational(24) } },
      ),
    },
    compositions: [{
      id: "main",
      name: "main",
      width: 1_280,
      height: 720,
      fps: rational(24),
      sampleRate: 48_000,
      duration: rational(4),
      sceneIds: ["scene"],
      rootVisualIds: ["camera"],
      rootAudioIds: ["audio"],
      rootAVIds: [],
      items: [{ kind: "scene", id: "scene" }],
      provenance: provenance("main"),
    }],
    scenes: {
      scene: {
        id: "scene",
        name: "only",
        start: rational(0),
        duration: rational(4),
        rootVisualIds: ["camera"],
        rootAudioIds: ["audio"],
        rootAVIds: [],
        items: [{ id: "camera", domain: "visual" }, { id: "audio", domain: "audio" }],
        provenance: provenance("scene"),
      },
    },
    nodes,
    signals: {},
    jobs: [],
    outputs: [],
    assertions: [],
  };
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function cadence(streamIndex = 0, seconds = 4, fps = 24): CutDecodedVideoCadence {
  const frameCount = seconds * fps;
  return {
    format: "cut-decoded-video-cadence",
    version: 2,
    method: "ffprobe-show-frames-cfr-v2",
    quantization: "phase-floor",
    phaseNumerator: "0",
    streamIndex,
    firstPts: "0",
    lastPts: String(frameCount - 1),
    quantizedEndPts: String(frameCount),
    frameCount: String(frameCount),
    durationPresentCount: String(frameCount),
    durationCoverage: "complete",
    recordsSha256: "a".repeat(64),
    timeBase: rational(1, fps),
    frameRate: rational(fps),
  };
}

function metadata(ir: CutAVIR, id: string): TestMediaMetadata {
  return ir.resources[id].metadata as TestMediaMetadata;
}

function planAfter(change: (ir: CutAVIR) => void) {
  const before = fixture(), previous = createIncrementalRenderPlan(before, "main").manifest, after = clone(before);
  change(after);
  return createIncrementalRenderPlan(after, "main", previous);
}

function planBetween(prepare: (ir: CutAVIR) => void, change: (ir: CutAVIR) => void) {
  const before = fixture();
  prepare(before);
  const previous = createIncrementalRenderPlan(before, "main").manifest, after = clone(before);
  change(after);
  return createIncrementalRenderPlan(after, "main", previous);
}

function status(plan: IncrementalRenderPlan, id: string) {
  return plan.nodes.find((entry) => entry.id === id)?.status;
}

function assertPictureStatus(plan: IncrementalRenderPlan, expected: "hit" | "miss") {
  for (const id of ["video", "group", "depth", "camera"]) assert.equal(status(plan, id), expected, id);
  assert.ok(plan.scenes.every((scene) => scene.status === expected));
}

test("audio-only selection changes on referenced video media stay local to audio consumers", () => {
  const unconsumed = planAfter((ir) => {
    metadata(ir, "primary").probe.selected.audio = {
      streamIndex: 3,
      duration: rational(4),
      durationSource: "stream",
      timeBase: rational(1, 44_100),
    };
  });
  assertPictureStatus(unconsumed, "hit");
  assert.equal(status(unconsumed, "audio"), "hit");
  assert.equal(status(unconsumed, "linked"), "miss", "an AV consumer binds source audio even while the pure Video path stays warm");

  const unconsumedTiming = planAfter((ir) => {
    const locked = metadata(ir, "primary"), stream = locked.probe.identity.streams.find((candidate) => candidate.index === 1 && candidate.type === "audio");
    assert.ok(stream);
    locked.probe.selected.audio = {
      streamIndex: 1,
      duration: rational(3),
      durationSource: "stream",
      timeBase: rational(1, 96_000),
    };
    stream.duration = rational(3);
    stream.timeBase = rational(1, 96_000);
  });
  assertPictureStatus(unconsumedTiming, "hit");
  assert.equal(status(unconsumedTiming, "audio"), "hit");
  assert.equal(status(unconsumedTiming, "linked"), "miss");

  const consumed = planAfter((ir) => {
    metadata(ir, "soundtrack").probe.selected.audio = {
      streamIndex: 1,
      duration: rational(4),
      durationSource: "stream",
      timeBase: rational(1, 44_100),
    };
  });
  assertPictureStatus(consumed, "hit");
  assert.equal(status(consumed, "audio"), "miss");
  assert.equal(status(consumed, "linked"), "hit");

  const consumedTiming = planAfter((ir) => {
    const locked = metadata(ir, "soundtrack"), stream = locked.probe.identity.streams.find((candidate) => candidate.index === 0 && candidate.type === "audio");
    assert.ok(stream);
    locked.probe.selected.audio = {
      streamIndex: 0,
      duration: rational(3),
      durationSource: "stream",
      timeBase: rational(1, 96_000),
    };
    stream.duration = rational(3);
    stream.timeBase = rational(1, 96_000);
  });
  assertPictureStatus(consumedTiming, "hit");
  assert.equal(status(consumedTiming, "audio"), "miss");
  assert.equal(status(consumedTiming, "linked"), "hit");
});

test("selected video changes invalidate the Video leaf, ordinary and Parallax ancestors, and scene", () => {
  const plan = planAfter((ir) => {
    const resource = ir.resources.primary, sha256 = resource.sha256, locator = resource.locator;
    metadata(ir, "primary").probe.selected.video = {
      streamIndex: 2,
      duration: rational(4),
      durationSource: "stream",
      timeBase: rational(1, 30),
      frameRate: rational(30),
    };
    assert.equal(resource.sha256, sha256, "selection changed without changing locked bytes");
    assert.equal(resource.locator, locator, "selection changed without changing the active locator");
  });
  assertPictureStatus(plan, "miss");
  assert.equal(status(plan, "audio"), "hit");
  assert.equal(status(plan, "linked"), "miss");

  const timing = planAfter((ir) => {
    const locked = metadata(ir, "primary"), stream = locked.probe.identity.streams.find((candidate) => candidate.index === 0 && candidate.type === "video");
    assert.ok(stream);
    locked.probe.selected.video = {
      streamIndex: 0,
      duration: rational(3),
      durationSource: "stream",
      timeBase: rational(1, 48),
      frameRate: rational(24),
    };
    stream.duration = rational(3);
    stream.timeBase = rational(1, 48);
  });
  assertPictureStatus(timing, "miss");
  assert.equal(status(timing, "audio"), "hit");
  assert.equal(status(timing, "linked"), "miss");
});

test("decoded-video-cadence authority executes, is cache-bound, and never widens to audio", () => {
  const prepared = (ir: CutAVIR) => {
    const locked = metadata(ir, "primary"), selection = locked.probe.selected.video!;
    const stream = locked.probe.identity.streams.find((candidate) => candidate.index === selection.streamIndex && candidate.type === "video")!;
    delete stream.duration;
    locked.probe.selected.video = {
      ...selection,
      durationSource: "decoded-video-cadence",
      decodedVideoCadence: cadence(),
    };
  };
  const unchanged = planBetween(prepared, () => {});
  assertPictureStatus(unchanged, "hit");
  assert.equal(status(unchanged, "linked"), "hit");

  const changedCadence = planBetween(prepared, (ir) => {
    const selection = metadata(ir, "primary").probe.selected.video!;
    selection.duration = rational(3);
    selection.decodedVideoCadence = cadence(0, 3, 24);
  });
  assertPictureStatus(changedCadence, "miss");
  assert.equal(status(changedCadence, "audio"), "hit");
  assert.equal(status(changedCadence, "linked"), "miss", "an AV consumer binds the selected picture cadence while its audio remains stream-authorized");

  assert.throws(
    () => planAfter((ir) => {
      const locked = metadata(ir, "primary"), selection = locked.probe.selected.video!;
      delete locked.probe.identity.streams[0].duration;
      (selection as unknown as { durationSource: string }).durationSource = "container";
    }),
    (error: unknown) => error instanceof CutGraphError && error.code === "CUT_GRAPH_RESOURCE" && /canonical selected video tuple/.test(error.message),
    "container duration is never executable selected-stream authority",
  );

  assert.throws(
    () => planAfter((ir) => {
      const locked = metadata(ir, "soundtrack"), selection = locked.probe.selected.audio!;
      delete locked.probe.identity.streams[0].duration;
      (selection as unknown as { durationSource: string }).durationSource = "container";
    }),
    (error: unknown) => error instanceof CutGraphError && error.code === "CUT_GRAPH_RESOURCE" && /canonical selected audio tuple/.test(error.message),
    "missing selected audio duration remains an explicit refusal",
  );
});

test("Waveform and Spectrogram cache identity binds audio, not incidental picture metadata", () => {
  const addAnalysisConsumers = (ir: CutAVIR) => {
    for (const [id, op] of [["waveform", "cut.data.waveform"], ["spectrogram", "cut.data.spectrogram"]] as const) {
      const analysis = node(id, op, "visual", [], "primary");
      analysis.ownership = "root";
      ir.nodes[id] = analysis;
      ir.compositions[0].rootVisualIds.push(id);
      ir.scenes.scene.rootVisualIds.push(id);
      ir.scenes.scene.items.push({ id, domain: "visual" });
    }
  };
  const audioChanged = planBetween(addAnalysisConsumers, (ir) => {
    metadata(ir, "primary").probe.selected.audio = {
      streamIndex: 3,
      duration: rational(4),
      durationSource: "stream",
      timeBase: rational(1, 44_100),
    };
  });
  for (const id of ["video", "group", "depth", "camera"]) assert.equal(status(audioChanged, id), "hit", id);
  assert.ok(audioChanged.scenes.every((scene) => scene.status === "miss"), "analysis-root invalidation must invalidate the containing scene");
  assert.equal(status(audioChanged, "waveform"), "miss");
  assert.equal(status(audioChanged, "spectrogram"), "miss");

  const pictureChanged = planBetween(addAnalysisConsumers, (ir) => {
    metadata(ir, "primary").probe.selected.video = {
      streamIndex: 2,
      duration: rational(4),
      durationSource: "stream",
      timeBase: rational(1, 30),
      frameRate: rational(30),
    };
  });
  assert.equal(status(pictureChanged, "waveform"), "hit");
  assert.equal(status(pictureChanged, "spectrogram"), "hit");
  assertPictureStatus(pictureChanged, "miss");
});

test("matching selected-stream metadata participates in executable cache identity", () => {
  const pictureMetadata = planAfter((ir) => {
    const stream = metadata(ir, "primary").probe.identity.streams.find((candidate) => candidate.index === 0 && candidate.type === "video");
    assert.ok(stream);
    stream.width = 1_024;
  });
  assertPictureStatus(pictureMetadata, "miss");
  assert.equal(status(pictureMetadata, "linked"), "miss");

  const audioMetadata = planAfter((ir) => {
    const stream = metadata(ir, "soundtrack").probe.identity.streams.find((candidate) => candidate.index === 0 && candidate.type === "audio");
    assert.ok(stream);
    stream.sampleRate = 96_000;
  });
  assertPictureStatus(audioMetadata, "hit");
  assert.equal(status(audioMetadata, "audio"), "miss");
  assert.equal(status(audioMetadata, "linked"), "hit");
});

test("unselected streams, unknown metadata, and unreferenced resources do not poison localized cache reuse", () => {
  const unselected = planAfter((ir) => {
    const stream = metadata(ir, "primary").probe.identity.streams.find((candidate) => candidate.index === 2 && candidate.type === "video");
    assert.ok(stream);
    stream.width = 2_048;
  });
  assertPictureStatus(unselected, "hit");
  assert.equal(status(unselected, "audio"), "hit");
  assert.equal(status(unselected, "linked"), "hit");

  const unusedContainerAuthority = planAfter((ir) => {
    metadata(ir, "primary").probe.identity.container.duration = rational(5);
  });
  assertPictureStatus(unusedContainerAuthority, "hit");
  assert.equal(status(unusedContainerAuthority, "audio"), "hit");
  assert.equal(status(unusedContainerAuthority, "linked"), "hit", "container duration is excluded while every selection is stream-authorized");

  const unknown = planAfter((ir) => {
    const locked = metadata(ir, "primary"), stream = locked.probe.identity.streams[0];
    locked.privateNote = { arbitrary: true };
    locked.probe.identity.privateProbeField = "ignored";
    stream.privateStreamField = ["ignored"];
  });
  assertPictureStatus(unknown, "hit");
  assert.equal(status(unknown, "audio"), "hit");
  assert.equal(status(unknown, "linked"), "hit");

  const unrelated = planAfter((ir) => {
    const resource = ir.resources.unused, locked = metadata(ir, "unused");
    resource.locator = "media/unused-proxy.mkv";
    resource.sha256 = "9".repeat(64);
    locked.probe.selected.video = {
      streamIndex: 2,
      duration: rational(4),
      durationSource: "stream",
      timeBase: rational(1, 30),
    };
  });
  assertPictureStatus(unrelated, "hit");
  assert.equal(status(unrelated, "audio"), "hit");
  assert.equal(status(unrelated, "linked"), "hit");
});

test("incomplete or malformed selected-media metadata cannot reuse a prior canonical picture key", () => {
  const cases: Array<{ name: string; change: (locked: TestMediaMetadata) => void }> = [
    {
      name: "missing selected stream",
      change: (locked) => { locked.probe.selected.video = undefined; },
    },
    {
      name: "selection without a matching stream",
      change: (locked) => {
        locked.probe.selected.video = {
          streamIndex: 99,
          duration: rational(4),
          durationSource: "stream",
          timeBase: rational(1, 24),
        };
      },
    },
    {
      name: "selected duration disagrees with matching stream",
      change: (locked) => { locked.probe.selected.video!.duration = rational(3); },
    },
    {
      name: "selected time base disagrees with matching stream",
      change: (locked) => { locked.probe.selected.video!.timeBase = rational(1, 48); },
    },
    {
      name: "container-authorized selection is never executable",
      change: (locked) => {
        (locked.probe.selected.video as unknown as { durationSource: string }).durationSource = "container";
        locked.probe.selected.video!.duration = rational(3);
        delete locked.probe.identity.streams[0].duration;
      },
    },
    {
      name: "unreduced rational is not canonical locked metadata",
      change: (locked) => {
        const unreduced = { numerator: "8", denominator: "2" } as Rational;
        locked.probe.selected.video!.duration = unreduced;
        locked.probe.identity.streams[0].duration = unreduced;
      },
    },
    {
      name: "negative zero is not canonical locked metadata",
      change: (locked) => {
        const negativeZero = { numerator: "-0", denominator: "1" } as Rational;
        locked.probe.selected.video!.timeBase = negativeZero;
        locked.probe.identity.streams[0].timeBase = negativeZero;
      },
    },
    {
      name: "oversized rational is refused before unbounded integer parsing",
      change: (locked) => {
        const oversized = { numerator: "1".repeat(257), denominator: "1" } as Rational;
        locked.probe.selected.video!.duration = oversized;
        locked.probe.identity.streams[0].duration = oversized;
      },
    },
    {
      name: "malformed matching stream field",
      change: (locked) => { locked.probe.identity.streams[0].width = "host-width"; },
    },
  ];
  for (const item of cases) {
    assert.throws(
      () => planAfter((ir) => item.change(metadata(ir, "primary"))),
      (error: unknown) => error instanceof CutGraphError
        && error.code === "CUT_GRAPH_RESOURCE"
        && error.nodeId === "video"
        && error.source.nodeId === "video",
      item.name,
    );
  }
});
