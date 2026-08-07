import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { referenceDiagramLayoutQ16Scale, type ReferenceDiagramLayoutPlan } from "../lib/runtime/reference/diagram-layout";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import {
  ReferenceDiagramLayoutRenderError,
  ReferenceVisualRenderer,
  type ReferenceDiagramLayoutFrameEvidence,
} from "../lib/runtime/reference/visual";

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics.filter((item) => item.severity === "error"), [], JSON.stringify(parsed.diagnostics));
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), [], JSON.stringify(checked.diagnostics));
  const ir = compileCutModule(parsed.module).ir;
  ir.determinism.semantic = "locked";
  return ir;
}

function transitionSource(withArrow = true) {
  return `cut 0.4;
project "diagram retained renderer proof";
import { DiagramLayout, DiagramNode, diagramEdge, diagramState } from "@cut/diagram";
import { Rect, traceArrow } from "cut:visual";
import { linear } from "@cut/motion";

const alone: DiagramState = diagramState(id: "alone", nodes: ["claim", "proof"], edges: []);
const linked: DiagramState = diagramState(
  id: "linked",
  nodes: ["claim", "proof"],
  edges: [diagramEdge(
    id: "claim-proof", from: "claim", to: "proof", stroke: #00ff00, width: 4px${withArrow ? ",\n    arrow: traceArrow(length: 8px, width: 6px, color: #00ff00)" : ""}
  )]
);

timeline main(duration: 2s, fps: 4, width: 240px, height: 140px) {
  scene only(duration: 2s) {
    DiagramLayout(
      state: linked, fromState: alone, progress: 0%, direction: "horizontal",
      width: 200px, height: 100px, nodeGap: 16px, rankGap: 64px
    ) as graph {
      DiagramNode(id: "claim", width: 32px, height: 24px, rank: 0) {
        Rect(width: 40px, height: 32px, fill: #e53935);
      }
      DiagramNode(id: "proof", width: 32px, height: 24px, rank: 1) {
        Rect(width: 40px, height: 32px, fill: #1e88e5);
      }
    }
    animate graph.progress from 0% to 100% over 1s ease linear;
  }
}
export out = render(main);`;
}

function nodeCrossfadeSource() {
  return `cut 0.4;
project "diagram node crossfade proof";
import { DiagramLayout, DiagramNode, diagramState } from "@cut/diagram";
import { Rect } from "cut:visual";
import { linear } from "@cut/motion";
const one: DiagramState = diagramState(id: "one", nodes: ["claim"], edges: []);
const two: DiagramState = diagramState(id: "two", nodes: ["claim", "proof"], edges: []);
timeline main(duration: 2s, fps: 4, width: 240px, height: 140px) {
  scene only(duration: 2s) {
    DiagramLayout(state: two, fromState: one, progress: 0%, direction: "horizontal", width: 200px, height: 100px, rankGap: 64px) as graph {
      DiagramNode(id: "claim", width: 32px, height: 24px, rank: 0) { Rect(width: 32px, height: 24px, fill: #e53935); }
      DiagramNode(id: "proof", width: 32px, height: 24px, rank: 1) { Rect(width: 32px, height: 24px, fill: #1e88e5); }
    }
    animate graph.progress from 0% to 100% over 1s ease linear;
  }
}
export out = render(main);`;
}

function rgbaAt(frame: { data: Uint8Array; width: number }, x: number, y: number) {
  return [...frame.data.slice((y * frame.width + x) * 4, (y * frame.width + x) * 4 + 4)];
}

async function rendererFor(ir: CutAVIR) {
  const session = validateReferenceSession(ir), root = await mkdtemp(resolve(tmpdir(), "cut-diagram-render-"));
  const renderer = new ReferenceVisualRenderer(ir, session.composition, root, resolve(root, ".cut/cache"));
  return { renderer, root, composition: session.composition };
}

function localitySource(options: { targetRank: number; leftFill: string; edgeStroke: string }) {
  return `cut 0.4;
project "diagram cache locality";
import { DiagramLayout, DiagramNode, diagramEdge, diagramState } from "@cut/diagram";
import { Rect } from "cut:visual";
const linked: DiagramState = diagramState(
  id: "linked", nodes: ["left", "right"],
  edges: [diagramEdge(id: "link", from: "left", to: "right", stroke: ${options.edgeStroke}, width: 3px)]
);
timeline main(duration: 2s, fps: 4, width: 320px, height: 160px) {
  scene only(duration: 2s) {
    DiagramLayout(state: linked, direction: "horizontal", width: 280px, height: 120px, rankGap: 50px) {
      DiagramNode(id: "left", width: 44px, height: 28px, rank: 0) { Rect(width: 44px, height: 28px, fill: ${options.leftFill}); }
      DiagramNode(id: "right", width: 44px, height: 28px, rank: ${options.targetRank}) { Rect(width: 44px, height: 28px, fill: #2255cc); }
    }
  }
}
export out = render(main);`;
}

async function renderLocalityVariant(root: string, options: { targetRank: number; leftFill: string; edgeStroke: string }) {
  const ir = compile(localitySource(options)), composition = validateReferenceSession(ir).composition;
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut/cache"));
  try {
    await renderer.prepare();
    await renderer.sceneFrame(ir.scenes[composition.sceneIds[0]!]!, 0, false);
    return renderer.referenceDiagramLayoutEvidence()[0]!;
  } finally { await renderer.closeAndWait(); }
}

test("DiagramLayout renders clipped local tiles, exact Q16 placement, progressive retained edges, arrows, and declared alpha order", { timeout: 30_000 }, async () => {
  const ir = compile(transitionSource()), opened = await rendererFor(ir), scene = ir.scenes[opened.composition.sceneIds[0]]!;
  try {
    await opened.renderer.prepare();
    const start = await opened.renderer.sceneFrame(scene, 0, false), startReceipt = opened.renderer.referenceDiagramLayoutEvidence()[0];
    assert.ok(startReceipt);
    assert.equal(startReceipt.plannerFrame.progressQ16, 0);
    assert.equal(startReceipt.edges[0]?.trimEndQ16, 0);
    assert.equal(startReceipt.edges[0]?.visibleAlphaPixels, 0);
    assert.equal(startReceipt.nodes.find((node) => node.id === "proof")?.maximumAlpha, 255);
    assert.equal(startReceipt.outputRgbaSha256, createHash("sha256").update(start.data).digest("hex"));

    const middle = await opened.renderer.sceneFrame(scene, 2, false), receipt = opened.renderer.referenceDiagramLayoutEvidence()[0];
    assert.ok(receipt);
    assert.deepEqual(receipt.exactTime, rational(1, 2));
    assert.deepEqual(receipt.sceneLocalTime, rational(1, 2));
    assert.equal(receipt.outputFrame, "2");
    assert.equal(receipt.plannerFrame.progressQ16, referenceDiagramLayoutQ16Scale / 2);
    assert.equal(receipt.edges[0]?.trimEndQ16, referenceDiagramLayoutQ16Scale / 2);
    assert.ok((receipt.edges[0]?.visibleAlphaPixels ?? 0) > 0);
    assert.ok(Math.abs((receipt.edges[0]?.terminalTangentQ16.xQ16 ?? 0)) + Math.abs((receipt.edges[0]?.terminalTangentQ16.yQ16 ?? 0)) === referenceDiagramLayoutQ16Scale);
    assert.deepEqual(receipt.nodes.map((node) => [node.id, node.phase, node.opacityQ16]), [
      ["claim", "persistent", referenceDiagramLayoutQ16Scale],
      ["proof", "persistent", referenceDiagramLayoutQ16Scale],
    ]);
    assert.equal(receipt.nodes.find((node) => node.id === "proof")?.maximumAlpha, 255);
    assert.equal(receipt.nodes.every((node) => node.tileRgbaSha256.length === 64 && node.placementIdentity.length === 64), true);
    assert.equal(receipt.edges.every((edge) => edge.rasterIdentity.length === 64 && edge.rgbaSha256.length === 64), true);
    assert.deepEqual(receipt.counters, {
      admittedCanvasPixels: 240 * 140,
      admittedPixelPasses: 2 * 32 * 24 + 240 * 140 * 7,
      maximumLiveSurfacePixels: 240 * 140 * 3 + 32 * 24,
      maximumConcurrentDiagramLayouts: 1,
      nodeTileRequests: 2,
      nodeTileRasterizations: 0,
      nodeTileMemoHits: 0,
      edgeRasterRequests: 1,
      edgeRasterizations: 1,
      edgeRasterMemoHits: 0,
      persistentLookups: 4,
      persistentHits: 2,
      persistentMisses: 2,
      sameProcessCoalescedWaits: 0,
      persistentBuilderExecutions: 1,
      persistentBytesRead: receipt.counters.persistentBytesRead,
      persistentBytesWritten: receipt.counters.persistentBytesWritten,
      persistentManifestsValidated: 2,
      persistentEvictedEntries: 0,
      persistentEvictedBytes: 0,
    });
    assert.ok(receipt.counters.persistentBytesRead > 2 * 32 * 24 * 4);
    assert.ok(receipt.counters.persistentBytesWritten > 0 && receipt.counters.persistentBytesWritten < 240 * 140 * 4, "one bounded edge tile must not persist a full delivery canvas");
    assert.equal(receipt.outputRgbaSha256, createHash("sha256").update(middle.data).digest("hex"));
    assert.equal(receipt.cacheScope, "persistent-cross-render");
    assert.equal(receipt.version, 2);
    assert.equal(receipt.rasterCache.multiProcessCoordination, "not-claimed");
    assert.equal(receipt.rasterCache.receipts.length, 3);
    assert.equal(receipt.rasterCache.receipts.filter((item) => item.lookup === "persistent-hit").length, 2);
    assert.equal(receipt.rasterCache.receipts.filter((item) => item.lookup === "built-miss").length, 1);
    assert.ok(receipt.edges.every((item) => item.rasterBounds.width * item.rasterBounds.height < 240 * 140));
    assert.ok(receipt.nodes.every((item) => item.rasterCacheKey.length === 64 && item.rasterCacheRequest === "materialized"));
    assert.ok(receipt.edges.every((item) => item.rasterCacheKey === item.rasterIdentity && item.rasterCacheRequest === "materialized"));

    for (const node of receipt.nodes) {
      if (node.opacityQ16 === 0) continue;
      const centerX = node.displayCenterQ16.xQ16 / referenceDiagramLayoutQ16Scale;
      const centerY = node.displayCenterQ16.yQ16 / referenceDiagramLayoutQ16Scale;
      const expected = node.id === "claim" ? [229, 57, 53, 255] : [30, 136, 229, 255];
      assert.deepEqual(rgbaAt(middle, centerX, centerY), expected);
      assert.equal(node.visibleAlphaPixels, 32 * 24, "oversized child Rect must be clipped to the declared DiagramNode tile");
    }

    const end = await opened.renderer.sceneFrame(scene, 4, false), endReceipt = opened.renderer.referenceDiagramLayoutEvidence()[0];
    assert.ok(endReceipt);
    const proof = endReceipt.nodes.find((node) => node.id === "proof")!, edge = endReceipt.edges[0]!;
    const proofBounds = {
      left: proof.displayRectQ16.leftQ16 / referenceDiagramLayoutQ16Scale,
      top: proof.displayRectQ16.topQ16 / referenceDiagramLayoutQ16Scale,
      right: proof.displayRectQ16.rightQ16 / referenceDiagramLayoutQ16Scale,
      bottom: proof.displayRectQ16.bottomQ16 / referenceDiagramLayoutQ16Scale,
    };
    assert.deepEqual(rgbaAt(end, proofBounds.left + 1, (proofBounds.top + proofBounds.bottom) / 2), [30, 136, 229, 255], "node paint must cover the edge cap at its endpoint");
    assert.equal(edge.trimEndQ16, referenceDiagramLayoutQ16Scale);
    assert.ok(edge.visibleAlphaPixels > 0);

    const repeated = await opened.renderer.sceneFrame(scene, 2, false), repeatedReceipt = opened.renderer.referenceDiagramLayoutEvidence()[0];
    assert.equal(createHash("sha256").update(repeated.data).digest("hex"), receipt.outputRgbaSha256);
    assert.equal(repeatedReceipt?.executionIdentity, receipt.executionIdentity);
    assert.notEqual(repeatedReceipt?.observationIdentity, receipt.observationIdentity);
    assert.equal(repeatedReceipt?.counters.persistentBuilderExecutions, 0);
    assert.equal(repeatedReceipt?.counters.persistentHits, 3);
    assert.ok(repeatedReceipt?.rasterCache.receipts.every((item) => item.lookup === "persistent-hit"));
    assert.deepEqual(repeatedReceipt?.nodes.map((node) => node.tileIdentity), receipt.nodes.map((node) => node.tileIdentity));
  } finally {
    await opened.renderer.closeAndWait();
    await rm(opened.root, { recursive: true, force: true });
  }
});

test("an accepted DiagramEdge arrow changes retained edge pixels instead of becoming inert metadata", { timeout: 30_000 }, async () => {
  const renderEdge = async (withArrow: boolean) => {
    const ir = compile(transitionSource(withArrow)), opened = await rendererFor(ir), scene = ir.scenes[opened.composition.sceneIds[0]]!;
    try {
      await opened.renderer.prepare();
      await opened.renderer.sceneFrame(scene, 4, false);
      return opened.renderer.referenceDiagramLayoutEvidence()[0]!.edges[0]!;
    } finally {
      await opened.renderer.closeAndWait();
      await rm(opened.root, { recursive: true, force: true });
    }
  };
  const arrow = await renderEdge(true), plain = await renderEdge(false);
  assert.notEqual(arrow.rgbaSha256, plain.rgbaSha256);
  assert.notEqual(arrow.rasterIdentity, plain.rasterIdentity);
  assert.ok(arrow.visibleAlphaPixels > plain.visibleAlphaPixels);
});

test("DiagramNode executes retained Path and timed Trace children in its centered clipped tile", { timeout: 30_000 }, async () => {
  const source = `cut 0.4;
project "diagram local vector children";
import { DiagramLayout, DiagramNode, diagramState } from "@cut/diagram";
import { Path, Trace, lineTo, vectorPath } from "cut:visual";
const state: DiagramState = diagramState(id: "one", nodes: ["vector"], edges: []);
timeline main(duration: 1s, fps: 10, width: 120px, height: 100px) {
  scene only(duration: 1s) {
    DiagramLayout(state: state, width: 80px, height: 80px) {
      DiagramNode(id: "vector", width: 64px, height: 64px) {
        Path(geometry: vectorPath(start: { x: -24px, y: -10px }, segments: [lineTo(to: { x: 24px, y: -10px })], closed: false), stroke: #ff3300, width: 3px);
        Trace(points: [{ x: -24px, y: 10px }, { x: 24px, y: 10px }], stroke: #00cc66, width: 3px, duration: 400ms);
      }
    }
  }
}
export out = render(main);`;
  const ir = compile(source), opened = await rendererFor(ir), scene = ir.scenes[opened.composition.sceneIds[0]]!;
  try {
    await opened.renderer.prepare();
    await opened.renderer.sceneFrame(scene, 1, false);
    const drawingEarly = opened.renderer.referenceDiagramLayoutEvidence()[0]!;
    await opened.renderer.sceneFrame(scene, 2, false);
    const drawingLater = opened.renderer.referenceDiagramLayoutEvidence()[0]!;
    assert.notEqual(drawingLater.nodes[0]?.rasterCacheKey, drawingEarly.nodes[0]?.rasterCacheKey, "Trace drawing frames must retain their exact changing visual dependency");
    assert.notEqual(drawingLater.nodes[0]?.tileRgbaSha256, drawingEarly.nodes[0]?.tileRgbaSha256);
    assert.equal(drawingLater.counters.nodeTileRasterizations, 1);

    const frame = await opened.renderer.sceneFrame(scene, 5, false), receipt = opened.renderer.referenceDiagramLayoutEvidence()[0]!;
    assert.equal(receipt.nodes.length, 1);
    assert.ok(receipt.nodes[0].visibleAlphaPixels > 100);
    let red = 0, green = 0;
    for (let offset = 0; offset < frame.data.length; offset += 4) {
      if (frame.data[offset] > 180 && frame.data[offset + 1] < 100) red += 1;
      if (frame.data[offset + 1] > 130 && frame.data[offset] < 80) green += 1;
    }
    assert.ok(red > 50, `expected retained local Path pixels, observed ${red}`);
    assert.ok(green > 50, `expected timed local Trace pixels, observed ${green}`);
    await opened.renderer.sceneFrame(scene, 6, false);
    const later = opened.renderer.referenceDiagramLayoutEvidence()[0]!;
    assert.equal(later.nodes[0]?.rasterCacheKey, receipt.nodes[0]?.rasterCacheKey, "settled Trace frames with identical pixels must share one visual-dependency identity");
    assert.equal(later.nodes[0]?.tileRgbaSha256, receipt.nodes[0]?.tileRgbaSha256);
    assert.equal(later.counters.nodeTileRasterizations, 0);
    assert.equal(later.counters.persistentHits, 1);
    await opened.renderer.sceneFrame(scene, 5, false);
    const replay = opened.renderer.referenceDiagramLayoutEvidence()[0]!;
    assert.equal(replay.nodes[0]?.rasterCacheKey, receipt.nodes[0]?.rasterCacheKey);
    assert.equal(replay.counters.nodeTileRasterizations, 0);
    assert.equal(replay.counters.persistentHits, 1);
  } finally {
    await opened.renderer.closeAndWait();
    await rm(opened.root, { recursive: true, force: true });
  }
});

test("DiagramNode property-signal raster identity follows resolved values and reuses the settled plateau", { timeout: 30_000 }, async () => {
  const source = `cut 0.4;
project "diagram signal raster identity";
import { DiagramLayout, DiagramNode, diagramState } from "@cut/diagram";
import { Rect } from "cut:visual";
import { linear } from "@cut/motion";
const state: DiagramState = diagramState(id: "one", nodes: ["signal"], edges: []);
timeline main(duration: 1s, fps: 10, width: 120px, height: 100px) {
  scene only(duration: 1s) {
    DiagramLayout(state: state, width: 80px, height: 80px) {
      DiagramNode(id: "signal", width: 64px, height: 64px) {
        Rect(width: 48px, height: 32px, fill: #e53935, opacity: 20%) as plate;
        animate plate.opacity from 20% to 100% over 400ms ease linear;
      }
    }
  }
}
export out = render(main);`;
  const ir = compile(source), opened = await rendererFor(ir), scene = ir.scenes[opened.composition.sceneIds[0]]!;
  try {
    await opened.renderer.prepare();
    await opened.renderer.sceneFrame(scene, 1, false);
    const changingEarly = opened.renderer.referenceDiagramLayoutEvidence()[0]!;
    await opened.renderer.sceneFrame(scene, 2, false);
    const changingLater = opened.renderer.referenceDiagramLayoutEvidence()[0]!;
    assert.notEqual(changingLater.nodes[0]?.rasterCacheKey, changingEarly.nodes[0]?.rasterCacheKey);
    assert.notEqual(changingLater.nodes[0]?.tileRgbaSha256, changingEarly.nodes[0]?.tileRgbaSha256);
    assert.equal(changingLater.counters.nodeTileRasterizations, 1);

    await opened.renderer.sceneFrame(scene, 5, false);
    const settled = opened.renderer.referenceDiagramLayoutEvidence()[0]!;
    await opened.renderer.sceneFrame(scene, 6, false);
    const settledLater = opened.renderer.referenceDiagramLayoutEvidence()[0]!;
    assert.equal(settledLater.nodes[0]?.rasterCacheKey, settled.nodes[0]?.rasterCacheKey);
    assert.equal(settledLater.nodes[0]?.tileRgbaSha256, settled.nodes[0]?.tileRgbaSha256);
    assert.equal(settledLater.counters.nodeTileRasterizations, 0);
    assert.equal(settledLater.counters.persistentHits, 1);
  } finally {
    await opened.renderer.closeAndWait();
    await rm(opened.root, { recursive: true, force: true });
  }
});

test("DiagramLayout node and edge Promise memos deduplicate identical same-invocation requests above the persistent raster cache", { timeout: 30_000 }, async () => {
  const ir = compile(transitionSource()), opened = await rendererFor(ir);
  try {
    await opened.renderer.prepare();
    type Counters = ReferenceDiagramLayoutFrameEvidence["counters"] & Record<string, number>;
    const counters = {
      admittedCanvasPixels: 0, admittedPixelPasses: 0, maximumLiveSurfacePixels: 0, maximumConcurrentDiagramLayouts: 0,
      nodeTileRequests: 0, nodeTileRasterizations: 0, nodeTileMemoHits: 0,
      edgeRasterRequests: 0, edgeRasterizations: 0, edgeRasterMemoHits: 0,
    } as Counters;
    const internals = opened.renderer as unknown as {
      diagramLayouts: Map<string, { plan?: ReferenceDiagramLayoutPlan }>;
      diagramNodeTile: (node: ReferenceDiagramLayoutPlan["displayFrame"]["nodes"][number], time: ReturnType<typeof rational>, frame: number, counters: Counters) => { tileIdentity: string; memoHit: boolean; pending: Promise<{ receipt: { counters: { builderExecutions: number } } }> };
      diagramEdgeSurface: (node: CutAVIR["nodes"][string], edge: ReferenceDiagramLayoutPlan["displayFrame"]["edges"][number], counters: Counters) => { rasterIdentity: string; memoHit: boolean; pending: Promise<{ receipt: { counters: { builderExecutions: number } } }> };
    };
    const binding = [...internals.diagramLayouts.values()][0], plan = binding?.plan;
    assert.ok(plan);
    const node = plan.frames.at(-1)!.nodes[0], edge = plan.frames.at(-1)!.edges[0], layoutNode = ir.nodes[plan.layoutId]!;
    const nodeFirst = internals.diagramNodeTile(node, rational(1), 4, counters), nodeSecond = internals.diagramNodeTile(node, rational(1), 4, counters);
    assert.equal(nodeFirst.tileIdentity, nodeSecond.tileIdentity);
    assert.equal(nodeFirst.pending, nodeSecond.pending);
    const nodeMaterialized = await nodeFirst.pending;
    const edgeFirst = internals.diagramEdgeSurface(layoutNode, edge, counters), edgeSecond = internals.diagramEdgeSurface(layoutNode, edge, counters);
    assert.equal(edgeFirst.rasterIdentity, edgeSecond.rasterIdentity);
    assert.equal(edgeFirst.pending, edgeSecond.pending);
    const edgeMaterialized = await edgeFirst.pending;
    assert.equal(counters.nodeTileRequests, 2);
    assert.equal(counters.nodeTileRasterizations, 0, "frame receipt owns rasterization accounting after awaiting the materialization");
    assert.equal(counters.nodeTileMemoHits, 1);
    assert.equal(nodeFirst.memoHit, false);
    assert.equal(nodeSecond.memoHit, true);
    assert.equal(nodeMaterialized.receipt.counters.builderExecutions, 1);
    assert.equal(counters.edgeRasterRequests, 2);
    assert.equal(counters.edgeRasterizations, 0, "frame receipt owns rasterization accounting after awaiting the materialization");
    assert.equal(counters.edgeRasterMemoHits, 1);
    assert.equal(edgeFirst.memoHit, false);
    assert.equal(edgeSecond.memoHit, true);
    assert.equal(edgeMaterialized.receipt.counters.builderExecutions, 1);
  } finally {
    await opened.renderer.closeAndWait();
    await rm(opened.root, { recursive: true, force: true });
  }
});

test("persistent DiagramLayout cache localizes rank, node-paint, and edge-paint edits to actual raster dependencies", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-diagram-locality-"));
  const lookup = (receipt: ReferenceDiagramLayoutFrameEvidence, item: { rasterCacheReceiptIdentity: string }) =>
    receipt.rasterCache.receipts.find((candidate) => candidate.executionIdentity === item.rasterCacheReceiptIdentity)?.lookup;
  try {
    const baseline = await renderLocalityVariant(root, { targetRank: 1, leftFill: "#cc3322", edgeStroke: "#228844" });
    assert.equal(baseline.counters.persistentBuilderExecutions, 3);

    const rankOnly = await renderLocalityVariant(root, { targetRank: 2, leftFill: "#cc3322", edgeStroke: "#228844" });
    assert.deepEqual(rankOnly.nodes.map((item) => item.rasterCacheKey), baseline.nodes.map((item) => item.rasterCacheKey), "placement/rank may not invalidate unchanged local node pixels");
    assert.ok(rankOnly.nodes.every((item) => lookup(rankOnly, item) === "persistent-hit"));
    assert.notEqual(rankOnly.edges[0]?.rasterCacheKey, baseline.edges[0]?.rasterCacheKey, "rank-induced routed geometry must invalidate the edge tile");
    assert.equal(lookup(rankOnly, rankOnly.edges[0]!), "built-miss");

    const nodePaint = await renderLocalityVariant(root, { targetRank: 2, leftFill: "#ddaa22", edgeStroke: "#228844" });
    assert.notEqual(nodePaint.nodes[0]?.rasterCacheKey, rankOnly.nodes[0]?.rasterCacheKey);
    assert.equal(nodePaint.nodes[1]?.rasterCacheKey, rankOnly.nodes[1]?.rasterCacheKey);
    assert.equal(lookup(nodePaint, nodePaint.nodes[0]!), "built-miss");
    assert.equal(lookup(nodePaint, nodePaint.nodes[1]!), "persistent-hit");
    assert.equal(lookup(nodePaint, nodePaint.edges[0]!), "persistent-hit");

    const edgePaint = await renderLocalityVariant(root, { targetRank: 2, leftFill: "#ddaa22", edgeStroke: "#aa3366" });
    assert.deepEqual(edgePaint.nodes.map((item) => item.rasterCacheKey), nodePaint.nodes.map((item) => item.rasterCacheKey));
    assert.ok(edgePaint.nodes.every((item) => lookup(edgePaint, item) === "persistent-hit"));
    assert.notEqual(edgePaint.edges[0]?.rasterCacheKey, nodePaint.edges[0]?.rasterCacheKey);
    assert.equal(lookup(edgePaint, edgePaint.edges[0]!), "built-miss");
    assert.ok(edgePaint.rasterCache.receipts.every((candidate) =>
      edgePaint.nodes.some((item) => item.rasterCacheReceiptIdentity === candidate.executionIdentity)
      || edgePaint.edges.some((item) => item.rasterCacheReceiptIdentity === candidate.executionIdentity)), "every frame-level cache receipt must be referenced by a rendered node or edge");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("entering DiagramNodes use exact Q16 transition opacity without changing their bounded placement", { timeout: 30_000 }, async () => {
  const ir = compile(nodeCrossfadeSource()), opened = await rendererFor(ir), scene = ir.scenes[opened.composition.sceneIds[0]]!;
  try {
    await opened.renderer.prepare();
    const start = await opened.renderer.sceneFrame(scene, 0, false), startReceipt = opened.renderer.referenceDiagramLayoutEvidence()[0]!;
    const startProof = startReceipt.nodes.find((node) => node.id === "proof")!;
    assert.equal(startProof.phase, "entering");
    assert.equal(startProof.opacityQ16, 0);
    assert.equal(startProof.maximumAlpha, 0);
    assert.deepEqual(rgbaAt(start, startProof.displayCenterQ16.xQ16 / referenceDiagramLayoutQ16Scale, startProof.displayCenterQ16.yQ16 / referenceDiagramLayoutQ16Scale), [0, 0, 0, 0]);

    const middle = await opened.renderer.sceneFrame(scene, 2, false), middleProof = opened.renderer.referenceDiagramLayoutEvidence()[0]!.nodes.find((node) => node.id === "proof")!;
    assert.equal(middleProof.opacityQ16, referenceDiagramLayoutQ16Scale / 2);
    assert.equal(middleProof.maximumAlpha, 128);
    assert.equal(middleProof.visibleAlphaPixels, 32 * 24);
    assert.deepEqual(rgbaAt(middle, middleProof.displayCenterQ16.xQ16 / referenceDiagramLayoutQ16Scale, middleProof.displayCenterQ16.yQ16 / referenceDiagramLayoutQ16Scale), [30, 136, 229, 128]);
  } finally {
    await opened.renderer.closeAndWait();
    await rm(opened.root, { recursive: true, force: true });
  }
});

test("unsupported DiagramNode descendants fail source-located in the constructor with no delivery fallback", async () => {
  const source = `cut 0.4;
project "unsupported diagram descendant";
import { DiagramLayout, DiagramNode, diagramState } from "@cut/diagram";
import { Rect, Stack } from "cut:visual";
const state: DiagramState = diagramState(id: "one", nodes: ["a"], edges: []);
timeline main(duration: 1s, fps: 4, width: 120px, height: 80px) {
  scene only(duration: 1s) {
    DiagramLayout(state: state) {
      DiagramNode(id: "a", width: 20px, height: 20px) {
        Stack(direction: "horizontal", gap: 2px) {
          Rect(width: 8px, height: 10px, fill: #ffffff);
          Rect(width: 8px, height: 10px, fill: #eeeeee);
        }
      }
    }
  }
}
export out = render(main);`;
  const ir = compile(source), session = validateReferenceSession(ir), root = await mkdtemp(resolve(tmpdir(), "cut-diagram-unsupported-"));
  try {
    assert.throws(
      () => new ReferenceVisualRenderer(ir, session.composition, root, resolve(root, ".cut/cache")),
      (error: unknown) => error instanceof ReferenceDiagramLayoutRenderError
        && error.code === "CUT_DIAGRAM_TYPE"
        && error.path.includes("$.nodes")
        && error.source.module === "project.cut"
        && /no delivery-canvas fallback/u.test(error.message),
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unsafe mid-transition fails during prepare before pixel work and planner diagnostics retain source provenance", async () => {
  const source = `cut 0.4;
project "diagram collision preflight";
import { DiagramLayout, DiagramNode, diagramState } from "@cut/diagram";
import { Rect } from "cut:visual";
import { linear } from "@cut/motion";
const before: DiagramState = diagramState(id: "before", nodes: ["a", "b"], edges: []);
const after: DiagramState = diagramState(id: "after", nodes: ["b", "a"], edges: []);
timeline main(duration: 1s, fps: 4, width: 240px, height: 120px) {
  scene only(duration: 1s) {
    DiagramLayout(state: after, fromState: before, progress: 0%, direction: "horizontal") as graph {
      DiagramNode(id: "a", width: 40px, height: 20px, rank: 0) { Rect(width: 40px, height: 20px, fill: #ff0000); }
      DiagramNode(id: "b", width: 40px, height: 20px, rank: 0) { Rect(width: 40px, height: 20px, fill: #0000ff); }
    }
    animate graph.progress from 0% to 100% over 1s ease linear;
  }
}
export out = render(main);`;
  const ir = compile(source), opened = await rendererFor(ir);
  try {
    await assert.rejects(
      () => opened.renderer.prepare(),
      (error: unknown) => error instanceof ReferenceDiagramLayoutRenderError
        && error.code === "CUT_DIAGRAM_TRANSITION_COLLISION"
        && error.source.module === "project.cut"
        && error.nodeId.length > 0,
    );
    const internals = opened.renderer as unknown as { diagramNodeTileMemo: Map<string, unknown>; diagramEdgeRasterMemo: Map<string, unknown> };
    assert.equal(internals.diagramNodeTileMemo.size, 0);
    assert.equal(internals.diagramEdgeRasterMemo.size, 0);
    assert.deepEqual(opened.renderer.referenceDiagramLayoutEvidence(), []);
  } finally {
    await opened.renderer.closeAndWait();
    await rm(opened.root, { recursive: true, force: true });
  }
});

test("failed frame publication preserves the prior completed DiagramLayout evidence", { timeout: 30_000 }, async () => {
  const ir = compile(transitionSource()), opened = await rendererFor(ir), scene = ir.scenes[opened.composition.sceneIds[0]]!;
  try {
    await opened.renderer.prepare();
    await opened.renderer.sceneFrame(scene, 0, false);
    const completed = opened.renderer.referenceDiagramLayoutEvidence();
    const internals = opened.renderer as unknown as { diagramLayoutFrame: (node: unknown, time: unknown, frame: number) => Promise<unknown> };
    const original = internals.diagramLayoutFrame.bind(opened.renderer);
    internals.diagramLayoutFrame = async (node, time, frame) => {
      await original(node, time, frame);
      throw new Error("synthetic failure after staged diagram execution");
    };
    await assert.rejects(() => opened.renderer.sceneFrame(scene, 1, false), /synthetic failure/u);
    assert.deepEqual(opened.renderer.referenceDiagramLayoutEvidence(), completed);
  } finally {
    await opened.renderer.closeAndWait();
    await rm(opened.root, { recursive: true, force: true });
  }
});

test("high-cardinality 4K diagrams fail admitted pixel work before allocating any node or edge raster", { timeout: 30_000 }, async () => {
  const ids = Array.from({ length: 64 }, (_, index) => `n${index}`);
  const nodes = ids.map((id) => `DiagramNode(id: "${id}", width: 1px, height: 1px, rank: 0) { Rect(width: 1px, height: 1px, fill: #ffffff); }`).join("\n");
  const source = `cut 0.4;
project "bounded diagram allocation";
import { DiagramLayout, DiagramNode, diagramState } from "@cut/diagram";
import { Rect } from "cut:visual";
const state: DiagramState = diagramState(id: "many", nodes: [${ids.map((id) => `"${id}"`).join(", ")}], edges: []);
timeline main(duration: 1s, fps: 1, width: 4096px, height: 4096px) {
  scene only(duration: 1s) { DiagramLayout(state: state, direction: "horizontal", nodeGap: 1px, rankGap: 1px) { ${nodes} } }
}
export out = render(main);`;
  const ir = compile(source), opened = await rendererFor(ir), scene = ir.scenes[opened.composition.sceneIds[0]]!;
  try {
    await opened.renderer.prepare();
    await assert.rejects(
      () => opened.renderer.sceneFrame(scene, 0, false),
      (error: unknown) => error instanceof ReferenceDiagramLayoutRenderError
        && error.code === "CUT_DIAGRAM_LIMIT"
        && /pixel-passes/u.test(error.message),
    );
    const internals = opened.renderer as unknown as { diagramNodeTileMemo: Map<string, unknown>; diagramEdgeRasterMemo: Map<string, unknown> };
    assert.equal(internals.diagramNodeTileMemo.size, 0);
    assert.equal(internals.diagramEdgeRasterMemo.size, 0);
  } finally {
    await opened.renderer.closeAndWait();
    await rm(opened.root, { recursive: true, force: true });
  }
});

test("DiagramLayout evidence uses composition-global time while planner sampling remains scene-local", { timeout: 30_000 }, async () => {
  const source = `cut 0.4;
project "later scene diagram time";
import { DiagramLayout, DiagramNode, diagramState } from "@cut/diagram";
import { Rect } from "cut:visual";
const state: DiagramState = diagramState(id: "one", nodes: ["a"], edges: []);
timeline main(duration: 2s, fps: 4, width: 120px, height: 80px) {
  scene first(duration: 1s) { Rect(width: 1px, height: 1px, fill: #010101); }
  scene second(duration: 1s) { DiagramLayout(state: state) { DiagramNode(id: "a", width: 20px, height: 20px) { Rect(width: 20px, height: 20px, fill: #ffffff); } } }
}
export out = render(main);`;
  const ir = compile(source), opened = await rendererFor(ir), scene = ir.scenes[opened.composition.sceneIds[1]]!;
  try {
    await opened.renderer.prepare();
    await opened.renderer.sceneFrame(scene, 0, false);
    const receipt = opened.renderer.referenceDiagramLayoutEvidence()[0];
    assert.ok(receipt);
    assert.deepEqual(receipt.sceneLocalTime, rational(0));
    assert.deepEqual(receipt.plannerFrame.at, rational(0));
    assert.deepEqual(receipt.exactTime, rational(1));
    assert.equal(receipt.outputFrame, "4");
  } finally {
    await opened.renderer.closeAndWait();
    await rm(opened.root, { recursive: true, force: true });
  }
});
