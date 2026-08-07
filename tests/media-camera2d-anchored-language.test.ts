import assert from "node:assert/strict";
import test from "node:test";
import { stableJsonStringify } from "../lib/core/stable";
import { cutAnchoredPathLimits, cutAnchoredSpatialOps } from "../lib/language/anchored-path-contract";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRCallValue, IRValue } from "../lib/language/ir";
import { CutAvIrValidationError, loadCutAvIr } from "../lib/language/ir-loader";
import { cutMediaCamera2DOp } from "../lib/language/media-camera2d-contract";
import { parseCutLanguage } from "../lib/language/parser";
import { finalizeGraphHashes } from "../lib/runtime/graph";

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics.filter((item) => item.severity === "error"), [], JSON.stringify(parsed.diagnostics));
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), [], JSON.stringify(checked.diagnostics));
  return compileCutModule(parsed.module).ir;
}

function mediaAnchorSource(x = "320.5px", y = "100.25px") {
  return `cut 0.4;
project "MediaCamera2D source anchor language proof";
import { MediaCamera2D, Image, Path, visualAnchor, anchoredLineTo, anchoredPath } from "cut:visual";
asset still: ImageAsset = image("media/still.png");

timeline main(duration: 1s, fps: 24, width: 320px, height: 180px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    MediaCamera2D(zoom: 1.25) as camera {
      Image(source: still, fit: "cover", crop: { x: 10%, y: 5%, width: 80%, height: 90% });
    }
    Path(
      geometry: anchoredPath(
        start: visualAnchor(owner: camera, local: { x: ${x}, y: ${y} }),
        segments: [anchoredLineTo(to: { x: 80px, y: 60px })],
        closed: false
      ),
      stroke: #ffffff,
      width: 2px
    );
  }
}
export out = render(main);`;
}

function legacyLocalSpaceSource() {
  return `cut 0.4;
project "legacy retained anchor identity";
import { LocalSpace, Rect, Path, visualAnchor, anchoredLineTo, anchoredPath } from "cut:visual";
timeline main(duration: 1s, fps: 24, width: 320px, height: 180px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    LocalSpace(width: 100px, height: 80px, origin: { x: 50px, y: 40px }) as tile {
      Rect(width: 100px, height: 80px, fill: #202020);
    }
    Path(
      geometry: anchoredPath(
        start: visualAnchor(owner: tile, local: { x: -50px, y: -40px }),
        segments: [anchoredLineTo(to: { x: 80px, y: 60px })],
        closed: false
      ),
      stroke: #ffffff,
      width: 2px
    );
  }
}
export out = render(main);`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function camera(ir: CutAVIR) {
  const match = Object.values(ir.nodes).find((node) => node.op === cutMediaCamera2DOp);
  assert.ok(match);
  return match;
}

function anchoredPathNode(ir: CutAVIR) {
  const match = Object.values(ir.nodes).find((node) => node.op === "cut.visual.path");
  assert.ok(match);
  return match;
}

function anchorCall(ir: CutAVIR): IRCallValue {
  const geometry = anchoredPathNode(ir).inputs.geometry;
  assert.ok(geometry && geometry.kind === "call");
  assert.equal(geometry.op, cutAnchoredSpatialOps.anchoredPath);
  const start = geometry.named.start;
  assert.ok(start && start.kind === "call");
  assert.equal(start.op, cutAnchoredSpatialOps.visualAnchor);
  return start;
}

function setAnchorCoordinate(ir: CutAVIR, axis: "x" | "y", numerator: string, denominator = "1") {
  const anchor = anchorCall(ir), local = anchor.named.local;
  assert.ok(local && local.kind === "object");
  local.entries[axis] = {
    kind: "quantity",
    dimension: "length",
    magnitude: { numerator, denominator },
    unit: "px",
  };
  finalizeGraphHashes(ir);
}

function expectLoadDiagnostic(
  canonical: CutAVIR,
  mutate: (hostile: CutAVIR) => void,
  code: CutAvIrValidationError["code"],
  path: RegExp,
) {
  const hostile = clone(canonical);
  mutate(hostile);
  finalizeGraphHashes(hostile);
  assert.throws(() => loadCutAvIr(JSON.stringify(hostile)), (error: unknown) => {
    assert.ok(error instanceof CutAvIrValidationError, String(error));
    assert.equal(error.code, code);
    assert.match(error.path, path);
    return true;
  });
}

test("unchanged visualAnchor syntax binds a direct scene-root MediaCamera2D without a fake LocalSpace", () => {
  const ir = compile(mediaAnchorSource()), owner = camera(ir), anchor = anchorCall(ir);
  assert.equal(owner.ownership, "root");
  assert.equal(owner.children.length, 1);
  assert.equal(ir.nodes[owner.children[0]!]!.op, "cut.visual.image");
  assert.equal(Object.values(ir.nodes).some((node) => node.op === "cut.visual.local_space"), false);
  assert.deepEqual(Object.keys(anchor).sort(), ["effect", "kind", "named", "op", "positional"]);
  assert.deepEqual(Object.keys(anchor.named), ["owner", "local"]);
  assert.deepEqual(anchor.named.owner, { kind: "node-ref", id: owner.id });
  assert.equal(loadCutAvIr(JSON.stringify(ir)).buildId, ir.buildId);
});

test("loader admits exact fractional source pixels through the global last-centre bound and defers crop extent", () => {
  assert.equal(cutAnchoredPathLimits.maximumMediaSourceCoordinatePx, 16_383);
  for (const [x, y] of [
    ["0px", "0px"],
    ["0.5px", "1.25px"],
    ["16383px", "16383px"],
  ]) {
    const ir = compile(mediaAnchorSource(x, y));
    assert.doesNotThrow(() => loadCutAvIr(JSON.stringify(ir)), `${x}, ${y}`);
  }
});

test("hostile loaded IR rejects negative, globally impossible, detached, and cross-scene MediaCamera anchors", () => {
  const canonical = compile(mediaAnchorSource());
  for (const [axis, numerator, denominator] of [
    ["x", "-1", "2"],
    ["y", "163830001", "10000"],
  ] as const) {
    expectLoadDiagnostic(
      canonical,
      (hostile) => setAnchorCoordinate(hostile, axis, numerator, denominator),
      "CUT_IR_LIMIT",
      new RegExp(`\\.named\\.local\\.entries\\.${axis}\\.magnitude$`, "u"),
    );
  }
  expectLoadDiagnostic(
    canonical,
    (hostile) => {
      camera(hostile).ownership = "child";
    },
    "CUT_IR_IDENTITY",
    /\.named\.owner\.id$/u,
  );
  expectLoadDiagnostic(
    canonical,
    (hostile) => {
      const owner = camera(hostile), scene = hostile.scenes[owner.sceneId!];
      scene.rootVisualIds = scene.rootVisualIds.filter((id) => id !== owner.id);
    },
    "CUT_IR_IDENTITY",
    /\.named\.owner\.id$/u,
  );
  expectLoadDiagnostic(
    canonical,
    (hostile) => {
      camera(hostile).sceneId = "another-scene";
    },
    "CUT_IR_IDENTITY",
    /\.named\.owner\.id$/u,
  );
});

test("legacy LocalSpace anchors retain their signed coordinate semantics and exact loaded wire", () => {
  const ir = compile(legacyLocalSpaceSource()), before = stableJsonStringify(ir);
  const loaded = loadCutAvIr(JSON.stringify(ir));
  assert.equal(stableJsonStringify(loaded), before);
  const anchor = anchorCall(ir), local = anchor.named.local as Extract<IRValue, { kind: "object" }>;
  assert.deepEqual(local.entries.x, {
    kind: "quantity",
    dimension: "length",
    magnitude: { numerator: "-50", denominator: "1" },
    unit: "px",
  });
});
