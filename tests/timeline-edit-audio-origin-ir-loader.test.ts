import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv from "ajv";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IREditorial, IRNode, IRValue } from "../lib/language/ir";
import { CutAvIrValidationError, loadCutAvIr, validateCutAvIr } from "../lib/language/ir-loader";
import { builtinPackages } from "../lib/language/packages";
import { parseCutLanguage } from "../lib/language/parser";
import { addRational, rational, type Rational } from "../lib/language/rational";
import {
  cutTimelineAudioOriginOp,
  cutTimelineAudioViewOp,
  type CutTimelineAudioOriginKind,
} from "../lib/language/timeline-edit-audio-origin-contract";
import { finalizeGraphHashes } from "../lib/runtime/graph";

const directSource = `cut 0.4;
project "timeline audio origin direct";
import { AudioTrack, TimelineEdit, editSelection, avTime, editSlip } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 4s, fps: 24, sampleRate: 48khz) {
  scene only(duration: 4s) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioClip(
        source: voice,
        range: 1s ..< 5s,
        destination: 0s ..< 4s,
        headHandle: 1s,
        tailHandle: 1s,
        fadeIn: 100ms,
        editId: "voice",
        role: "dialogue"
      );
    }
    TimelineEdit(id: "identity", operations: [
      editSlip(selection: editSelection(trackIds: ["dialogue"], originIds: ["voice"]), range: 0s ..< 4s, by: avTime(audio: 500ms)),
      editSlip(selection: editSelection(trackIds: ["dialogue"], originIds: ["voice"]), range: 0s ..< 4s, by: avTime(audio: -500ms))
    ]);
  }
}
export out = render(main);`;

const legacyDirectSource = `cut 0.4;
project "timeline audio origin legacy omission";
import { AudioTrack } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 4s, fps: 24, sampleRate: 48khz) {
  scene only(duration: 4s) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioClip(
        source: voice,
        range: 1s ..< 5s,
        destination: 0s ..< 4s,
        editId: "voice",
        role: "dialogue"
      );
    }
  }
}
export out = render(main);`;

const processedSource = `cut 0.4;
project "timeline audio origin processed";
import { AudioTrack, AudioRegion, TimelineEdit, editSelection, avTime, editSlip } from "@cut/edit";
import { AudioClip, Gain } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 4s, fps: 24, sampleRate: 48khz) {
  scene only(duration: 4s) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioRegion(
        destination: 0s ..< 4s,
        headHandle: 1s,
        tailHandle: 1s,
        editId: "voice",
        role: "dialogue"
      ) {
        Gain(amount: -3db) {
          AudioClip(source: voice, range: 1s ..< 5s);
        }
      }
    }
    TimelineEdit(id: "identity", operations: [
      editSlip(selection: editSelection(trackIds: ["dialogue"], originIds: ["voice"]), range: 0s ..< 4s, by: avTime(audio: 500ms)),
      editSlip(selection: editSelection(trackIds: ["dialogue"], originIds: ["voice"]), range: 0s ..< 4s, by: avTime(audio: -500ms))
    ]);
  }
}
export out = render(main);`;

const fastProcessedSource = `cut 0.4;
project "timeline audio origin processed fast";
import { AudioTrack, AudioRegion, TimelineEdit, editSelection, avTime, editSplit } from "@cut/edit";
import { AudioClip, Gain, TimeStretch } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 2s, fps: 24, sampleRate: 48khz) {
  scene only(duration: 2s) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioRegion(destination: 0s ..< 2s, editId: "voice", role: "dialogue") {
        Gain(amount: -3db) {
          TimeStretch(sourceDuration: 4s, duration: 2s) {
            AudioClip(source: voice, range: 1s ..< 5s);
          }
        }
      }
    }
    TimelineEdit(id: "identity", operations: [
      editSplit(selection: editSelection(trackIds: ["dialogue"], originIds: ["voice"]), at: avTime(audio: 1s))
    ]);
  }
}
export out = render(main);`;

const slowProcessedSource = `cut 0.4;
project "timeline audio origin processed slow";
import { AudioTrack, AudioRegion, TimelineEdit, editSelection, avTime, editSplit } from "@cut/edit";
import { AudioClip, Gain, TimeStretch } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 4s, fps: 24, sampleRate: 48khz) {
  scene only(duration: 4s) {
    AudioTrack(trackId: "dialogue", role: "dialogue") {
      AudioRegion(destination: 0s ..< 4s, editId: "voice", role: "dialogue") {
        Gain(amount: -3db) {
          TimeStretch(sourceDuration: 2s, duration: 4s) {
            AudioClip(source: voice, range: 1s ..< 3s);
          }
        }
      }
    }
    TimelineEdit(id: "identity", operations: [
      editSplit(selection: editSelection(trackIds: ["dialogue"], originIds: ["voice"]), at: avTime(audio: 2s))
    ]);
  }
}
export out = render(main);`;

type AudioTrack = IRNode & {
  editorial: Extract<IREditorial, { kind: "audio-track" }>;
};

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

function time(value: Rational): IRValue {
  return {
    kind: "quantity",
    dimension: "time",
    magnitude: value,
    unit: "s",
  };
}

function rate(value: Rational): IRValue {
  return {
    kind: "quantity",
    dimension: "scalar",
    magnitude: value,
    unit: "scalar",
  };
}

function sourceRange(value: { start: Rational; duration: Rational }): IRValue {
  return {
    kind: "range",
    start: time(value.start),
    end: time(addRational(value.start, value.duration)),
    exclusive: true,
  };
}

function audioTrack(ir: CutAVIR): AudioTrack {
  const track = Object.values(ir.nodes).find(
    (node): node is AudioTrack => node.editorial?.kind === "audio-track",
  );
  assert.ok(track);
  return track;
}

function originViewFixture(
  kind: CutTimelineAudioOriginKind,
  source = kind === "direct-audio" ? directSource : processedSource,
) {
  const ir = compile(source);
  const track = audioTrack(ir), item = track.editorial.items.find((candidate) =>
    candidate.kind === "audio");
  assert.ok(item);
  assert.equal(item.kind, "audio");
  assert.ok(item.source);
  const view = ir.nodes[item.nodeId]!;
  assert.equal(view.op, cutTimelineAudioViewOp);
  const originRef = view.inputs.origin;
  assert.equal(originRef?.kind, "node-ref");
  if (originRef?.kind !== "node-ref") assert.fail("compiled view lost its origin reference");
  const origin = ir.nodes[originRef.id]!;
  assert.equal(origin.op, cutTimelineAudioOriginOp);
  assert.equal(origin.inputs.originKind?.kind, "string");
  assert.equal(origin.inputs.originKind?.kind === "string"
    ? origin.inputs.originKind.value : undefined, kind);
  const original = ir.nodes[origin.children[0]!]!;
  assert.equal(
    original.op,
    kind === "direct-audio" ? "cut.audio.clip" : "cut.edit.audio_region",
  );
  return { ir, track, original, origin, view };
}

function interiorSource(kind: CutTimelineAudioOriginKind) {
  const editNode = kind === "direct-audio"
    ? `AudioClip(
          source: voice,
          range: 1s ..< 5s,
          destination: 0s ..< 4s,
          headHandle: 1s,
          tailHandle: 1s,
          fadeIn: 100ms,
          editId: "voice"
        );`
    : `AudioRegion(
          destination: 0s ..< 4s,
          headHandle: 1s,
          tailHandle: 1s,
          editId: "voice"
        ) {
          Gain(amount: -3db) {
            AudioClip(source: voice, range: 1s ..< 5s);
          }
        }`;
  return `cut 0.4;
project "timeline audio interior ${kind}";
import { AudioTrack, AudioRegion, TimelineEdit, editSelection, editTrim } from "@cut/edit";
import { AudioClip, Gain } from "@cut/audio";
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 4s, fps: 24, sampleRate: 48khz) {
  scene only(duration: 4s) {
    AudioTrack(trackId: "dialogue", role: "dialogue") { ${editNode} }
    TimelineEdit(id: "interior", operations: [
      editTrim(
        selection: editSelection(trackIds: ["dialogue"], originIds: ["voice"]),
        keep: 1s ..< 3s
      )
    ]);
  }
}
export out = render(main);`;
}

function interiorOriginViewFixture(kind: CutTimelineAudioOriginKind) {
  return originViewFixture(kind, interiorSource(kind));
}

async function publicSchema() {
  const source = await readFile("schemas/cut-av-ir-v3.schema.json", "utf8");
  return new Ajv({
    schemaId: "auto",
    meta: false,
    validateSchema: false,
    allErrors: true,
    jsonPointers: true,
  }).compile(JSON.parse(source));
}

function expected(code: CutAvIrValidationError["code"], path: RegExp) {
  return (error: unknown) => error instanceof CutAvIrValidationError
    && error.code === code
    && path.test(error.path);
}

function hostile(
  kind: CutTimelineAudioOriginKind,
  mutate: (fixture: ReturnType<typeof originViewFixture>) => void,
) {
  const fixture = originViewFixture(kind);
  mutate(fixture);
  finalizeGraphHashes(fixture.ir);
  return fixture.ir;
}

test("compiler-internal TimelineEdit audio origin/view kernels are closed, typed, schema-valid, and omitted from public package symbols", async () => {
  const schema = await publicSchema();
  for (const kind of ["direct-audio", "processed-audio"] as const) {
    const { ir, track, original, origin, view } = originViewFixture(kind);
    assert.equal(loadCutAvIr(JSON.stringify(ir)).buildId, ir.buildId);
    assert.equal(schema(ir), true, JSON.stringify(schema.errors));
    assert.equal(track.children[0], view.id);
    assert.equal(origin.children[0], original.id);
    assert.equal(view.inputs.origin?.kind, "node-ref");
    assert.equal(view.inputs.origin?.kind === "node-ref" ? view.inputs.origin.id : "", origin.id);
  }

  const publicNativeOps = [...builtinPackages.values()].flatMap((manifest) =>
    Object.values(manifest.symbols).flatMap((symbol) =>
      symbol.native === undefined ? [] : [symbol.native]));
  assert.equal(publicNativeOps.includes(cutTimelineAudioOriginOp), false);
  assert.equal(publicNativeOps.includes(cutTimelineAudioViewOp), false);

  const omitted = compile(legacyDirectSource);
  assert.equal(
    Object.values(omitted.nodes).some((node) =>
      node.op === cutTimelineAudioOriginOp || node.op === cutTimelineAudioViewOp),
    false,
  );
  assert.doesNotThrow(() => validateCutAvIr(omitted));
  assert.equal(schema(omitted), true, JSON.stringify(schema.errors));
});

test("processed TimelineEdit audio origin/view rate authority admits exact 1/2x and 2x source clocks", async () => {
  const schema = await publicSchema();
  for (const [source, expectedRate] of [
    [slowProcessedSource, rational(1, 2)],
    [fastProcessedSource, rational(2)],
  ] as const) {
    const { ir, origin, view } = originViewFixture("processed-audio", source);
    assert.doesNotThrow(() => validateCutAvIr(ir));
    assert.equal(schema(ir), true, JSON.stringify(schema.errors));
    assert.deepEqual(
      origin.inputs.rate?.kind === "quantity" ? origin.inputs.rate.magnitude : undefined,
      expectedRate,
    );
    assert.deepEqual(
      view.inputs.rate?.kind === "quantity" ? view.inputs.rate.magnitude : undefined,
      expectedRate,
    );
  }
});

test("strict loader rejects one-source-sample residual-handle inflation on an interior origin view", () => {
  for (const kind of ["direct-audio", "processed-audio"] as const) {
    const fixture = interiorOriginViewFixture(kind);
    assert.doesNotThrow(() => loadCutAvIr(JSON.stringify(fixture.ir)), kind);
    const hostile = structuredClone(fixture);
    const head = hostile.view.inputs.headHandle;
    assert.ok(head?.kind === "quantity");
    head.magnitude = addRational(head.magnitude, rational(1, 48_000));
    finalizeGraphHashes(hostile.ir);
    assert.throws(
      () => loadCutAvIr(JSON.stringify(hostile.ir)),
      expected("CUT_IR_TIMING", /timeline_audio_view.*headHandle/u),
      kind,
    );
  }
});

test("strict loader and public schema fail closed on hostile TimelineEdit audio origin/view fields and graph ownership", async () => {
  const schema = await publicSchema();
  const cases: Array<{
    name: string;
    kind: CutTimelineAudioOriginKind;
    mutate: (fixture: ReturnType<typeof originViewFixture>) => void;
    code: CutAvIrValidationError["code"];
    path: RegExp;
    schemaReject?: boolean;
  }> = [
    {
      name: "missing view head handle",
      kind: "direct-audio",
      mutate: ({ view }) => delete view.inputs.headHandle,
      code: "CUT_IR_MISSING_FIELD",
      path: /timeline_audio_view.*headHandle/u,
      schemaReject: true,
    },
    {
      name: "negative view tail handle",
      kind: "processed-audio",
      mutate: ({ view }) => {
        view.inputs.tailHandle = time(rational(-1));
      },
      code: "CUT_IR_TIMING",
      path: /timeline_audio_view.*tailHandle/u,
    },
    {
      name: "view handle exceeds original available range",
      kind: "direct-audio",
      mutate: ({ view }) => {
        view.inputs.headHandle = time(rational(2));
      },
      code: "CUT_IR_TIMING",
      path: /timeline_audio_view.*headHandle/u,
    },
    {
      name: "missing origin duration",
      kind: "direct-audio",
      mutate: ({ origin }) => delete origin.inputs.originDuration,
      code: "CUT_IR_MISSING_FIELD",
      path: /timeline_audio_origin.*originDuration/u,
      schemaReject: true,
    },
    {
      name: "missing origin rate",
      kind: "direct-audio",
      mutate: ({ origin }) => delete origin.inputs.rate,
      code: "CUT_IR_MISSING_FIELD",
      path: /timeline_audio_origin.*rate/u,
      schemaReject: true,
    },
    {
      name: "zero origin rate",
      kind: "processed-audio",
      mutate: ({ origin }) => {
        origin.inputs.rate = rate(rational(0));
      },
      code: "CUT_IR_TIMING",
      path: /timeline_audio_origin.*rate/u,
    },
    {
      name: "negative view rate",
      kind: "processed-audio",
      mutate: ({ view }) => {
        view.inputs.rate = rate(rational(-1, 2));
      },
      code: "CUT_IR_TIMING",
      path: /timeline_audio_view.*rate/u,
    },
    {
      name: "rate uses the wrong quantity dimension",
      kind: "direct-audio",
      mutate: ({ view }) => {
        view.inputs.rate = {
          kind: "quantity",
          dimension: "ratio",
          magnitude: rational(1),
          unit: "ratio",
        };
      },
      code: "CUT_IR_TYPE",
      path: /timeline_audio_view.*rate/u,
      schemaReject: true,
    },
    {
      name: "view rate does not mirror origin",
      kind: "processed-audio",
      mutate: ({ view }) => {
        view.inputs.rate = rate(rational(1, 2));
      },
      code: "CUT_IR_IDENTITY",
      path: /timeline_audio_view.*origin/u,
    },
    {
      name: "origin rate exceeds exact source bounds",
      kind: "processed-audio",
      mutate: ({ origin, view }) => {
        origin.inputs.rate = rate(rational(2));
        view.inputs.rate = rate(rational(2));
      },
      code: "CUT_IR_TIMING",
      path: /timeline_audio_origin.*rate/u,
    },
    {
      name: "processed origin missing graph authority",
      kind: "processed-audio",
      mutate: ({ origin }) => delete origin.inputs.graphAuthorityId,
      code: "CUT_IR_MISSING_FIELD",
      path: /timeline_audio_origin.*graphAuthorityId/u,
      schemaReject: true,
    },
    {
      name: "direct view forges graph authority",
      kind: "direct-audio",
      mutate: ({ view }) => {
        view.inputs.graphAuthorityId = { kind: "string", value: "forged_graph" };
      },
      code: "CUT_IR_UNKNOWN_FIELD",
      path: /timeline_audio_view.*graphAuthorityId/u,
      schemaReject: true,
    },
    {
      name: "forged state policy",
      kind: "processed-audio",
      mutate: ({ view }) => {
        view.inputs.statePolicy = { kind: "string", value: "per-slice" };
      },
      code: "CUT_IR_ENUM",
      path: /timeline_audio_view.*statePolicy/u,
      schemaReject: true,
    },
    {
      name: "view authority does not mirror origin",
      kind: "direct-audio",
      mutate: ({ view }) => {
        view.inputs.sourceAuthorityId = { kind: "string", value: "other_source" };
      },
      code: "CUT_IR_IDENTITY",
      path: /timeline_audio_view.*origin/u,
    },
    {
      name: "source slice does not advance with slice offset",
      kind: "direct-audio",
      mutate: ({ view }) => {
        view.inputs.source = sourceRange({ start: rational(2), duration: rational(4) });
      },
      code: "CUT_IR_IDENTITY",
      path: /timeline_audio_view.*source/u,
    },
    {
      name: "view exceeds origin clock",
      kind: "processed-audio",
      mutate: ({ view }) => {
        view.inputs.sliceOffset = time(rational(1));
        view.inputs.source = sourceRange({ start: rational(2), duration: rational(4) });
      },
      code: "CUT_IR_TIMING",
      path: /timeline_audio_view/u,
    },
    {
      name: "origin kind disagrees with child graph",
      kind: "direct-audio",
      mutate: ({ origin }) => {
        origin.inputs.originKind = { kind: "string", value: "processed-audio" };
        origin.inputs.graphAuthorityId = { kind: "string", value: "graph_authority" };
      },
      code: "CUT_IR_IDENTITY",
      path: /timeline_audio_origin.*children/u,
    },
    {
      name: "view is not reference-bound to origin",
      kind: "direct-audio",
      mutate: ({ view }) => {
        view.inputs.origin = { kind: "string", value: "timeline_audio_origin_direct_audio" };
      },
      code: "CUT_IR_IDENTITY",
      path: /timeline_audio_view.*inputs\.origin/u,
      schemaReject: true,
    },
    {
      name: "view destination drifts from editorial item",
      kind: "direct-audio",
      mutate: ({ view }) => {
        view.interval.start = rational(1);
      },
      code: "CUT_IR_IDENTITY",
      path: /timeline_audio_view.*interval/u,
    },
    {
      name: "origin becomes structurally owned",
      kind: "direct-audio",
      mutate: ({ origin }) => {
        origin.ownership = "child";
      },
      code: "CUT_IR_IDENTITY",
      path: /timeline_audio_origin/u,
      schemaReject: true,
    },
    {
      name: "unknown compiler field",
      kind: "processed-audio",
      mutate: ({ view }) => {
        view.inputs.hiddenRestart = { kind: "boolean", value: true };
      },
      code: "CUT_IR_UNKNOWN_FIELD",
      path: /timeline_audio_view.*hiddenRestart/u,
      schemaReject: true,
    },
  ];
  for (const entry of cases) {
    const ir = hostile(entry.kind, entry.mutate);
    assert.throws(() => validateCutAvIr(ir), expected(entry.code, entry.path), entry.name);
    if (entry.schemaReject) {
      assert.equal(schema(ir), false, `${entry.name} must also fail the public structural schema`);
    }
  }
});
