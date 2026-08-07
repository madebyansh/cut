import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv from "ajv";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IREditorial, IRNode, IRProvenance } from "../lib/language/ir";
import { CutAvIrValidationError, loadCutAvIr, validateCutAvIr } from "../lib/language/ir-loader";
import { parseCutLanguage } from "../lib/language/parser";
import { rational, type Rational } from "../lib/language/rational";
import type {
  TimelineEditItemV1,
  TimelineEditPlanV1,
  TimelineEditSourceView,
  TimelineEditTrackV1,
} from "../lib/language/timeline-edit-operations";
import { finalizeGraphHashes } from "../lib/runtime/graph";

type PictureTrackNode = IRNode & { editorial: Extract<IREditorial, { kind: "picture-track" }> };
type AudioTrackNode = IRNode & { editorial: Extract<IREditorial, { kind: "audio-track" }> };

const source = `cut 0.4;
project "timeline edit ir loader";
import { Sequence, PictureTrack, PictureClip, AudioTrack } from "@cut/edit";
import { AudioClip } from "@cut/audio";
asset picture: VideoAsset = video("picture.mkv");
asset voice: AudioAsset = audio("voice.wav");
timeline main(duration: 4s, fps: 24, sampleRate: 48khz) {
  scene only(duration: 4s) {
    Sequence(duration: 4s) {
      PictureTrack() {
        PictureClip(source: picture, range: 1s ..< 3s, duration: 2s, link: "take_left");
        PictureClip(source: picture, range: 3s ..< 5s, duration: 2s, link: "take_right");
      }
    }
    AudioTrack() {
      AudioClip(source: voice, range: 1s ..< 3s, destination: 0s ..< 2s, link: "take_left");
      AudioClip(source: voice, range: 3s ..< 5s, destination: 2s ..< 4s, link: "take_right");
    }
  }
}
export out = render(main);`;

function provenance(): IRProvenance {
  return {
    module: "timeline-edit-ir-loader.test.cut",
    span: {
      start: { offset: 0, line: 1, column: 1 },
      end: { offset: 1, line: 1, column: 2 },
    },
  };
}

function interval(start: number | Rational, duration: number | Rational) {
  return {
    start: typeof start === "number" ? rational(start) : start,
    duration: typeof duration === "number" ? rational(duration) : duration,
  };
}

function compile(): CutAVIR {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  return compileCutModule(parsed.module).ir;
}

function nodes(ir: CutAVIR) {
  const pictureTrack = Object.values(ir.nodes).find((node): node is PictureTrackNode => node.editorial?.kind === "picture-track");
  const audioTrack = Object.values(ir.nodes).find((node): node is AudioTrackNode => node.editorial?.kind === "audio-track");
  assert.ok(pictureTrack);
  assert.ok(audioTrack);
  return {
    pictureTrack,
    audioTrack,
    pictureItems: pictureTrack.editorial.items.filter((item) => item.kind === "picture"),
    audioItems: audioTrack.editorial.items.filter((item) => item.kind === "audio"),
  };
}

function directView(
  domain: "picture" | "audio",
  nodeId: string,
  sourceStart: number,
  authorityId: string,
): TimelineEditSourceView {
  const common = {
    source: interval(sourceStart, 2),
    handles: { head: rational(1), tail: rational(1) },
    authorityId,
  };
  return domain === "picture"
    ? { ...common, kind: "picture", nodeId, timeMap: { kind: "constant", direction: "forward", rate: rational(1) } }
    : {
        ...common,
        kind: "audio",
        nodeId,
        rate: rational(1),
        fadeIn: rational(1, 10),
        fadeOut: rational(1, 10),
        presentationClock: { originDuration: rational(2), sliceOffset: rational(0), fadePolicy: "origin-relative" },
      };
}

function item(
  trackId: string,
  domain: TimelineEditTrackV1["domain"],
  originId: string,
  segmentId: string,
  start: number,
  sourceView: TimelineEditSourceView,
  linkId?: string,
): TimelineEditItemV1 {
  return {
    originId,
    segmentId,
    trackId,
    domain,
    ...(linkId ? { linkId } : {}),
    destination: interval(start, 2),
    sourceView,
    role: domain === "audio" ? "dialogue" : "picture",
    metadata: {},
    provenance: provenance(),
  };
}

function fixture(): CutAVIR {
  const ir = compile();
  const { pictureTrack, audioTrack, pictureItems, audioItems } = nodes(ir);
  assert.equal(pictureItems.length, 2);
  assert.equal(audioItems.length, 2);

  pictureTrack.editorial.trackId = "v1";
  pictureTrack.editorial.role = "primary picture";
  pictureTrack.editorial.metadata = { "org.example.lane": "main" };
  audioTrack.editorial.trackId = "a1";
  audioTrack.editorial.role = "dialogue";
  audioTrack.editorial.metadata = { "org.example.lane": "dialogue" };
  pictureItems.forEach((entry, index) => {
    entry.editId = index ? "picture_right" : "picture_left";
    entry.role = "picture";
    entry.metadata = { "org.example.take": index ? "right" : "left" };
  });
  audioItems.forEach((entry, index) => {
    entry.editId = index ? "audio_right" : "audio_left";
    entry.role = "dialogue";
    entry.metadata = { "org.example.take": index ? "right" : "left" };
  });

  const pictureTrackPlan: TimelineEditTrackV1 = {
    trackId: "v1",
    domain: "picture",
    order: 0,
    duration: rational(4),
    role: "primary picture",
    metadata: { "org.example.lane": "main" },
    items: [
      item("v1", "picture", "picture_left", "seg_picture_left", 0, directView("picture", pictureItems[0].nodeId, 1, "picture_authority_left"), "take_left"),
      item("v1", "picture", "picture_right", "seg_picture_right", 2, directView("picture", pictureItems[1].nodeId, 3, "picture_authority_right"), "take_right"),
    ],
  };
  const audioTrackPlan: TimelineEditTrackV1 = {
    trackId: "a1",
    domain: "audio",
    order: 1,
    duration: rational(4),
    role: "dialogue",
    metadata: { "org.example.lane": "dialogue" },
    items: [
      item("a1", "audio", "audio_left", "seg_audio_left", 0, directView("audio", audioItems[0].nodeId, 1, "audio_authority_left"), "take_left"),
      item("a1", "audio", "audio_right", "seg_audio_right", 2, directView("audio", audioItems[1].nodeId, 3, "audio_authority_right"), "take_right"),
    ],
  };
  const processedTrack: TimelineEditTrackV1 = {
    trackId: "a_processed",
    domain: "audio",
    order: 2,
    duration: rational(4),
    role: "processed dialogue",
    metadata: { "org.example.processor-policy": "single-evaluation" },
    items: [{
      originId: "processed_origin",
      segmentId: "processed_segment",
      trackId: "a_processed",
      domain: "audio",
      destination: interval(0, 4),
      sourceView: {
        kind: "processed-audio",
        source: interval(1, 4),
        handles: { head: rational(1), tail: rational(1) },
        authorityId: "processed_authority",
        regionId: audioTrack.id,
        sourceNodeId: audioItems[0].nodeId,
        processorNodeIds: [audioItems[1].nodeId],
        graphAuthorityId: "processed_graph_authority",
        rate: rational(1),
        fadeIn: rational(1, 5),
        fadeOut: rational(1, 4),
        presentationClock: { originDuration: rational(4), sliceOffset: rational(0), fadePolicy: "origin-relative" },
        statePolicy: "single-authorized-evaluation",
      },
      metadata: { "org.example.effect": "voice-chain" },
      provenance: provenance(),
    }],
  };
  const rampTrack: TimelineEditTrackV1 = {
    trackId: "v_ramp",
    domain: "picture",
    order: 3,
    duration: rational(4),
    role: "variable map",
    metadata: {},
    items: [{
      originId: "ramp_origin",
      segmentId: "ramp_segment",
      trackId: "v_ramp",
      domain: "picture",
      destination: interval(0, 4),
      sourceView: {
        kind: "picture",
        source: interval(0, 6),
        handles: { head: rational(0), tail: rational(0) },
        authorityId: "ramp_authority",
        nodeId: pictureItems[0].nodeId,
        timeMap: {
          kind: "speed-ramp",
          interpolation: "linear-rate",
          frameSelection: "floor",
          points: [{ at: rational(0), rate: rational(1) }, { at: rational(4), rate: rational(2) }],
        },
      },
      metadata: {},
      provenance: provenance(),
    }],
  };
  const nestedTrack: TimelineEditTrackV1 = {
    trackId: "av_nested",
    domain: "audiovisual",
    order: 4,
    duration: rational(4),
    role: "nested",
    metadata: { "org.example.clock": "shared" },
    items: [{
      originId: "nested_origin",
      segmentId: "nested_segment",
      trackId: "av_nested",
      domain: "audiovisual",
      destination: interval(0, 4),
      sourceView: {
        kind: "nested",
        source: interval(0, 4),
        handles: { head: rational(0), tail: rational(0) },
        authorityId: "nested_authority",
        nodeId: pictureTrack.id,
        compositionId: ir.compositions[0].id,
        rate: rational(1),
        sharedClock: true,
        placementPolicy: "static-same-track-copy",
      },
      metadata: {},
      provenance: provenance(),
    }],
  };
  const plan: TimelineEditPlanV1 = {
    version: 1,
    id: "timeline_edit_main",
    compositionId: ir.compositions[0].id,
    sceneId: Object.values(ir.scenes)[0].id,
    initialDuration: rational(4),
    finalDuration: rational(4),
    tracks: [pictureTrackPlan, audioTrackPlan, processedTrack, rampTrack, nestedTrack],
    operations: [
      {
        id: "jl_boundary",
        kind: "boundary-adjust",
        selection: { trackIds: ["v1", "a1"] },
        at: { picture: rational(9, 4), audio: rational(7, 4) },
        provenance: provenance(),
      },
      {
        id: "av_transition",
        kind: "transition",
        left: { trackIds: ["v1", "a1"], originIds: ["picture_left", "audio_left"] },
        right: { trackIds: ["v1", "a1"], originIds: ["picture_right", "audio_right"] },
        at: { picture: rational(9, 4), audio: rational(7, 4) },
        duration: { picture: rational(1, 2), audio: rational(1, 2) },
        picture: { kind: "wipe", direction: "left", softness: rational(1, 5) },
        audio: { curve: "equal-power" },
        provenance: provenance(),
      },
    ],
    provenance: provenance(),
  };
  ir.timelineEdits = [plan];
  finalizeGraphHashes(ir);
  return ir;
}

function expectCode(code: CutAvIrValidationError["code"], path?: RegExp) {
  return (error: unknown) => error instanceof CutAvIrValidationError
    && error.code === code
    && (path === undefined || path.test(error.path));
}

function hostile(mutate: (ir: CutAVIR) => void) {
  const ir = structuredClone(fixture());
  mutate(ir);
  finalizeGraphHashes(ir);
  return ir;
}

test("TimelineEdit v1 closed IR preserves exact J/L, handles, processed, variable-map, nested, metadata, and omission contracts", async () => {
  const ir = fixture();
  assert.equal(loadCutAvIr(JSON.stringify(ir)).buildId, ir.buildId);
  const plan = ir.timelineEdits?.[0];
  assert.ok(plan);
  assert.deepEqual((plan.operations[0] as { at: unknown }).at, { picture: rational(9, 4), audio: rational(7, 4) });
  assert.equal(plan.tracks.find((track) => track.trackId === "a_processed")?.items[0].sourceView.kind, "processed-audio");
  assert.equal(plan.tracks.find((track) => track.trackId === "v_ramp")?.items[0].sourceView.kind, "picture");
  assert.equal(plan.tracks.find((track) => track.trackId === "av_nested")?.items[0].sourceView.kind, "nested");

  const schema = JSON.parse(await readFile("schemas/cut-av-ir-v3.schema.json", "utf8")) as object;
  const validate = new Ajv({ schemaId: "auto", meta: false, validateSchema: false, allErrors: true, jsonPointers: true }).compile(schema);
  assert.equal(validate(ir), true, JSON.stringify(validate.errors));

  const omitted = compile();
  assert.equal(omitted.timelineEdits, undefined);
  assert.doesNotThrow(() => validateCutAvIr(omitted));
  assert.equal(validate(omitted), true, JSON.stringify(validate.errors));

  const replacedDirectLineage = structuredClone(ir);
  const pictureView = replacedDirectLineage.timelineEdits![0].tracks[0].items[0].sourceView;
  const audioView = replacedDirectLineage.timelineEdits![0].tracks[1].items[0].sourceView;
  assert.equal(pictureView.kind, "picture");
  assert.equal(audioView.kind, "audio");
  if (pictureView.kind === "picture") (pictureView as { nodeId: string }).nodeId = "historic_picture_lineage";
  if (audioView.kind === "audio") (audioView as { nodeId: string }).nodeId = "historic_audio_lineage";
  finalizeGraphHashes(replacedDirectLineage);
  assert.doesNotThrow(() => validateCutAvIr(replacedDirectLineage), "direct clip lineage ids need not remain live after materialization");
  assert.equal(validate(replacedDirectLineage), true, JSON.stringify(validate.errors));

  const empty = structuredClone(omitted);
  empty.timelineEdits = [];
  finalizeGraphHashes(empty);
  assert.throws(() => validateCutAvIr(empty), expectCode("CUT_IR_IDENTITY", /^\$\.timelineEdits$/u));
  assert.equal(validate(empty), false, "schema must require non-empty optional TimelineEdit plans");
});

test("TimelineEdit insert/overwrite operand records survive the closed loader and public schema", async () => {
  const ir = fixture();
  (ir.timelineEdits![0] as unknown as { operations: TimelineEditPlanV1["operations"] }).operations = [{
    id: "overwrite_picture",
    kind: "overwrite",
    targets: { picture: { trackIds: ["v1"], allowUnlinked: true } },
    at: { picture: rational(0) },
    operand: {
      parts: [{
        domain: "picture",
        sourceOriginId: "picture_left",
        originId: "picture_replacement",
        destinationDuration: rational(2),
        metadata: { "org.example.intent": "replacement" },
      }],
    },
    provenance: provenance(),
  }];
  finalizeGraphHashes(ir);
  assert.equal(loadCutAvIr(JSON.stringify(ir)).buildId, ir.buildId);
  const schema = JSON.parse(await readFile("schemas/cut-av-ir-v3.schema.json", "utf8")) as object;
  const validate = new Ajv({ schemaId: "auto", meta: false, validateSchema: false, allErrors: true, jsonPointers: true }).compile(schema);
  assert.equal(validate(ir), true, JSON.stringify(validate.errors));

  const missingLink = structuredClone(ir);
  const operation = missingLink.timelineEdits![0].operations[0];
  assert.equal(operation.kind, "overwrite");
  if (operation.kind === "overwrite") {
    (operation.targets as unknown as { audio: unknown }).audio = { trackIds: ["a1"], allowUnlinked: true };
    (operation.operand as unknown as { parts: unknown[] }).parts = [
      ...operation.operand.parts,
      {
        domain: "audio",
        sourceOriginId: "audio_left",
        originId: "audio_replacement",
        destinationDuration: rational(2),
        metadata: {},
      },
    ];
  }
  finalizeGraphHashes(missingLink);
  assert.throws(() => validateCutAvIr(missingLink), expectCode("CUT_TIMELINE_EDIT_LINK", /operand\.linkId/u));
  assert.equal(validate(missingLink), false, "schema also requires linkId for a coupled operand");
});

test("TimelineEdit loader and schema fail closed on hostile authority, operation, handle, metadata, nested-clock, and unknown-field mutations", async () => {
  const schema = JSON.parse(await readFile("schemas/cut-av-ir-v3.schema.json", "utf8")) as object;
  const validate = new Ajv({ schemaId: "auto", meta: false, validateSchema: false, allErrors: true, jsonPointers: true }).compile(schema);
  const cases: Array<{
    name: string;
    mutate: (ir: CutAVIR) => void;
    code: CutAvIrValidationError["code"];
    path: RegExp;
    schemaReject?: boolean;
  }> = [
    {
      name: "foreign processed source authority",
      mutate: (ir) => {
        const view = ir.timelineEdits![0].tracks[2].items[0].sourceView;
        assert.equal(view.kind, "processed-audio");
        if (view.kind === "processed-audio") (view as unknown as { sourceNodeId: string }).sourceNodeId = "node_missing";
      },
      code: "CUT_IR_REFERENCE",
      path: /sourceNodeId/u,
    },
    {
      name: "forged processed policy",
      mutate: (ir) => {
        const view = ir.timelineEdits![0].tracks[2].items[0].sourceView;
        assert.equal(view.kind, "processed-audio");
        if (view.kind === "processed-audio") (view as unknown as { statePolicy: string }).statePolicy = "per-slice";
      },
      code: "CUT_TIMELINE_EDIT_UNSUPPORTED",
      path: /statePolicy/u,
      schemaReject: true,
    },
    {
      name: "negative handle",
      mutate: (ir) => {
        const view = ir.timelineEdits![0].tracks[0].items[0].sourceView;
        assert.notEqual(view.kind, "gap");
        if (view.kind !== "gap") (view.handles as unknown as { head: Rational }).head = rational(-1);
      },
      code: "CUT_TIMELINE_EDIT_HANDLE",
      path: /handles/u,
    },
    {
      name: "missing presentation clock",
      mutate: (ir) => {
        const view = ir.timelineEdits![0].tracks[1].items[0].sourceView;
        assert.equal(view.kind, "audio");
        if (view.kind === "audio") delete (view as unknown as { presentationClock?: unknown }).presentationClock;
      },
      code: "CUT_IR_MISSING_FIELD",
      path: /sourceView/u,
      schemaReject: true,
    },
    {
      name: "presentation slice beyond origin",
      mutate: (ir) => {
        const view = ir.timelineEdits![0].tracks[1].items[0].sourceView;
        assert.equal(view.kind, "audio");
        if (view.kind === "audio") {
          (view.presentationClock as unknown as { sliceOffset: Rational }).sliceOffset = rational(1);
        }
      },
      code: "CUT_TIMELINE_EDIT_TIME",
      path: /presentationClock/u,
    },
    {
      name: "foreign operation track",
      mutate: (ir) => {
        const operation = ir.timelineEdits![0].operations[0];
        assert.equal(operation.kind, "boundary-adjust");
        if (operation.kind === "boundary-adjust") (operation.selection as unknown as { trackIds: string[] }).trackIds = ["foreign"];
      },
      code: "CUT_TIMELINE_EDIT_REFERENCE",
      path: /trackIds/u,
    },
    {
      name: "cross-domain source view",
      mutate: (ir) => {
        const picture = ir.timelineEdits![0].tracks[0].items[0];
        const audio = ir.timelineEdits![0].tracks[1].items[0];
        (picture as unknown as { sourceView: TimelineEditSourceView }).sourceView = audio.sourceView;
      },
      code: "CUT_TIMELINE_EDIT_SHAPE",
      path: /sourceView\.kind/u,
      schemaReject: true,
    },
    {
      name: "non-shared nested clock",
      mutate: (ir) => {
        const view = ir.timelineEdits![0].tracks[4].items[0].sourceView;
        assert.equal(view.kind, "nested");
        if (view.kind === "nested") (view as unknown as { sharedClock: boolean }).sharedClock = false;
      },
      code: "CUT_TIMELINE_EDIT_UNSUPPORTED",
      path: /sharedClock/u,
      schemaReject: true,
    },
    {
      name: "unknown nested placement policy",
      mutate: (ir) => {
        const view = ir.timelineEdits![0].tracks[4].items[0].sourceView;
        assert.equal(view.kind, "nested");
        if (view.kind === "nested") {
          (view as unknown as { placementPolicy: string }).placementPolicy =
            "copy-anywhere";
        }
      },
      code: "CUT_IR_ENUM",
      path: /placementPolicy/u,
      schemaReject: true,
    },
    {
      name: "unknown plan field",
      mutate: (ir) => {
        (ir.timelineEdits![0] as unknown as Record<string, unknown>).hidden = true;
      },
      code: "CUT_IR_UNKNOWN_FIELD",
      path: /timelineEdits\[0\]\.hidden/u,
      schemaReject: true,
    },
    {
      name: "metadata object escape",
      mutate: (ir) => {
        (ir.timelineEdits![0].tracks[0].metadata as Record<string, unknown>)["org.example.nested"] = { hidden: true };
      },
      code: "CUT_IR_TYPE",
      path: /metadata/u,
      schemaReject: true,
    },
    {
      name: "metadata missing namespace",
      mutate: (ir) => {
        (ir.timelineEdits![0].tracks[0] as unknown as {
          metadata: Record<string, string>;
        }).metadata = { owner: "fixture" };
      },
      code: "CUT_IR_STRING",
      path: /metadata\.owner/u,
      schemaReject: true,
    },
    {
      name: "reserved CUT metadata namespace",
      mutate: (ir) => {
        (ir.timelineEdits![0].tracks[0] as unknown as {
          metadata: Record<string, string>;
        }).metadata = { "cUt.private": "fixture" };
      },
      code: "CUT_IR_STRING",
      path: /metadata\.cUt\.private/u,
      schemaReject: true,
    },
    {
      name: "metadata control text",
      mutate: (ir) => {
        (ir.timelineEdits![0].tracks[0] as unknown as {
          metadata: Record<string, string>;
        }).metadata = { "org.example.owner": "bad\nvalue" };
      },
      code: "CUT_IR_STRING",
      path: /metadata\["org\.example\.owner"\]/u,
      schemaReject: true,
    },
    {
      name: "invalid authored edit id",
      mutate: (ir) => {
        const { pictureItems } = nodes(ir);
        pictureItems[0].editId = "contains spaces";
      },
      code: "CUT_IR_STRING",
      path: /editorial\.items\[0\]\.editId/u,
      schemaReject: true,
    },
    {
      name: "editorial metadata object escape",
      mutate: (ir) => {
        const { audioTrack } = nodes(ir);
        audioTrack.editorial.metadata = { "org.example.nested": { hidden: true } } as never;
      },
      code: "CUT_IR_TYPE",
      path: /editorial\.metadata/u,
      schemaReject: true,
    },
  ];
  for (const entry of cases) {
    const ir = hostile(entry.mutate);
    assert.throws(() => validateCutAvIr(ir), expectCode(entry.code, entry.path), entry.name);
    if (entry.schemaReject) assert.equal(validate(ir), false, `${entry.name} must also fail the public structural schema`);
  }
});
