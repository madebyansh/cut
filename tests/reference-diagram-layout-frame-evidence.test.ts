import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import Ajv from "ajv";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { renderReferenceFrameArtifact } from "../lib/runtime/reference/authoring-review";

const source = `cut 0.4;
project "Diagram frame receipt";
import { DiagramLayout, DiagramNode, diagramState } from "@cut/diagram";
import { Rect } from "cut:visual";
const still: DiagramState = diagramState(id: "still", nodes: ["claim"], edges: []);
timeline main(duration: 1s, fps: 4, width: 96px, height: 64px) {
  scene only(duration: 1s) {
    DiagramLayout(state: still, width: 72px, height: 48px) {
      DiagramNode(id: "claim", width: 32px, height: 20px) {
        Rect(width: 32px, height: 20px, fill: #2a6fdb);
      }
    }
  }
}
export out = render(main);`;

function compile() {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const diagnostics = [...parsed.diagnostics, ...checkCutModule(parsed.module).diagnostics]
    .filter((item) => item.severity === "error");
  assert.deepEqual(diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

test("exact-frame artifacts publish closed DiagramLayout execution evidence without invalidating historical v2 receipts", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-diagram-frame-evidence-"));
  try {
    const ir = compile(), lock = await createCutLock(ir, root);
    await applyCutLock(ir, lock, root);
    const output = resolve(root, "review", "diagram.png");
    const manifest = await renderReferenceFrameArtifact(ir, root, output, { frame: 0 });
    const parentCounters = manifest.execution.localSpaces[0]!.counters;
    assert.deepEqual({
      localNodeRasterizations: parentCounters.localNodeRasterizations,
      localPaintSurfaceCacheHits: parentCounters.localPaintSurfaceCacheHits,
      localPaintSurfaceCacheMisses: parentCounters.localPaintSurfaceCacheMisses,
      localPaintSurfaceCacheBypasses: parentCounters.localPaintSurfaceCacheBypasses,
      localPaintSurfaceCacheEvictions: parentCounters.localPaintSurfaceCacheEvictions,
    }, {
      localNodeRasterizations: 0,
      localPaintSurfaceCacheHits: 0,
      localPaintSurfaceCacheMisses: 0,
      localPaintSurfaceCacheBypasses: 0,
      localPaintSurfaceCacheEvictions: 0,
    }, "DiagramNode contextual paint work must remain in its own receipt domain");
    assert.equal(manifest.execution.diagramLayouts.length, 1);
    const receipt = manifest.execution.diagramLayouts[0]!;
    assert.equal(receipt.version, 2);
    assert.equal(receipt.cacheScope, "persistent-cross-render");
    assert.equal(receipt.rasterCache.multiProcessCoordination, "not-claimed");
    assert.equal(receipt.rasterCache.receipts.length, 1);
    assert.equal(receipt.rasterCache.receipts[0]?.lookup, "built-miss");
    assert.match(receipt.outputRgbaSha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(receipt.exactTime, manifest.frame.timestamp);
    assert.deepEqual(receipt.sceneLocalTime, { numerator: "0", denominator: "1" });
    assert.equal(receipt.nodes.length, 1);
    assert.equal(receipt.nodes[0]?.visibleAlphaPixels, 32 * 20);
    const replay = await renderReferenceFrameArtifact(ir, root, resolve(root, "review", "diagram-replay.png"), { frame: 0 });
    const replayParentCounters = replay.execution.localSpaces[0]!.counters;
    assert.deepEqual({
      localNodeRasterizations: replayParentCounters.localNodeRasterizations,
      localPaintSurfaceCacheHits: replayParentCounters.localPaintSurfaceCacheHits,
      localPaintSurfaceCacheMisses: replayParentCounters.localPaintSurfaceCacheMisses,
      localPaintSurfaceCacheBypasses: replayParentCounters.localPaintSurfaceCacheBypasses,
      localPaintSurfaceCacheEvictions: replayParentCounters.localPaintSurfaceCacheEvictions,
    }, {
      localNodeRasterizations: 0,
      localPaintSurfaceCacheHits: 0,
      localPaintSurfaceCacheMisses: 0,
      localPaintSurfaceCacheBypasses: 0,
      localPaintSurfaceCacheEvictions: 0,
    }, "persistent DiagramNode reuse must not leak into parent LocalSpace cache counters");
    assert.equal(replay.artifact.rgbaSha256, manifest.artifact.rgbaSha256);
    assert.equal(replay.execution.diagramLayouts[0]?.executionIdentity, receipt.executionIdentity);
    assert.notEqual(replay.execution.diagramLayouts[0]?.observationIdentity, receipt.observationIdentity);
    assert.equal(replay.execution.diagramLayouts[0]?.rasterCache.receipts[0]?.lookup, "persistent-hit");
    assert.equal(replay.execution.diagramLayouts[0]?.outputRgbaSha256, receipt.outputRgbaSha256);

    const schema = JSON.parse(await readFile(resolve("schemas/cut-reference-frame-v2.schema.json"), "utf8"));
    const validate = new Ajv({ schemaId: "auto", meta: false, validateSchema: false, allErrors: true, jsonPointers: true }).compile(schema);
    assert.equal(validate(manifest), true, JSON.stringify(validate.errors));

    const hostile = structuredClone(manifest) as typeof manifest & { execution: typeof manifest.execution & { diagramLayouts: Array<Record<string, unknown>> } };
    hostile.execution.diagramLayouts[0] = { ...hostile.execution.diagramLayouts[0], ignored: true };
    assert.equal(validate(hostile), false, "closed DiagramLayout receipt must reject unknown fields");

    const historicalV1 = structuredClone(manifest) as unknown as { execution: { diagramLayouts: Array<Record<string, unknown>> } };
    const v1 = historicalV1.execution.diagramLayouts[0]!;
    v1.version = 1;
    v1.cacheScope = "scene-frame-invocation";
    delete v1.rasterCache;
    delete v1.observationIdentity;
    const counters = v1.counters as Record<string, unknown>;
    for (const key of Object.keys(counters).filter((key) => key.startsWith("persistent") || key === "sameProcessCoalescedWaits")) delete counters[key];
    for (const item of [...(v1.nodes as Array<Record<string, unknown>>), ...(v1.edges as Array<Record<string, unknown>>)]) {
      delete item.rasterCacheKey;
      delete item.rasterCacheRequest;
      delete item.rasterCacheReceiptIdentity;
      delete item.rasterBounds;
      delete item.rasterTileRgbaSha256;
    }
    assert.equal(validate(historicalV1), true, JSON.stringify(validate.errors));

    const historical = structuredClone(manifest) as unknown as { execution: Record<string, unknown> };
    delete historical.execution.diagramLayouts;
    assert.equal(validate(historical), true, JSON.stringify(validate.errors));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
