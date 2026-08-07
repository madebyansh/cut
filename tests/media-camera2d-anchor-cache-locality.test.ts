import assert from "node:assert/strict";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { parseCutLanguage } from "../lib/language/parser";
import { createIncrementalRenderPlan } from "../lib/runtime/graph";

type Fixture = Readonly<{
  focusX?: string;
  focusY?: string;
  zoom?: string;
  rotation?: string;
  opacity?: string;
  edge?: "clamp";
  exposure?: string;
  safeX?: string;
  safeY?: string;
  gap?: string;
  weights?: string;
  width?: number;
  height?: number;
  animation?: Readonly<{
    property: "focusX" | "focusY" | "zoom" | "rotation";
    from: string;
    to: string;
  }>;
}>;

function source(options: Fixture = {}) {
  const animation = options.animation
    ? `animate camera.${options.animation.property} from ${options.animation.from} to ${options.animation.to} over 1s ease linear;`
    : "";
  return `cut 0.4;
project "MediaCamera2D anchored consumer cache locality";
import {
  Callout, CalloutLayer, ColorGrade, Image, LocalSpace, MediaCamera2D, Path,
  Rect, ResponsiveSlot, ResponsiveStack, anchoredLineTo, anchoredPath,
  responsiveStackPlan, visualAnchor
} from "cut:visual";
import { linear } from "@cut/motion";
asset still: ImageAsset = image("media/still.png");
timeline main(duration: 1s, fps: 24, width: ${options.width ?? 64}px, height: ${options.height ?? 36}px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    let plan = responsiveStackPlan(
      weights: [${options.weights ?? "2, 1"}],
      safeX: ${options.safeX ?? "0%"},
      safeY: ${options.safeY ?? "0%"},
      gap: ${options.gap ?? "4px"}
    );
    ResponsiveStack(plan: plan) {
      ResponsiveSlot() {
        MediaCamera2D(
          focusX: ${options.focusX ?? "25%"},
          focusY: ${options.focusY ?? "45%"},
          zoom: ${options.zoom ?? "1.2"},
          rotation: ${options.rotation ?? "2deg"},
          opacity: ${options.opacity ?? "90%"}${options.edge ? `,
          edge: "${options.edge}"` : ""}
        ) as camera {
          ColorGrade(exposure: ${options.exposure ?? "0.2"}) {
            Image(source: still, fit: "cover");
          }
        }
        ${animation}
      }
      ResponsiveSlot() {
        Rect(width: 12px, height: 12px, fill: #d85b45);
      }
    }
    Path(
      geometry: anchoredPath(
        start: visualAnchor(owner: camera, local: { x: 1px, y: 2px }),
        segments: [anchoredLineTo(to: { x: 35px, y: 18px })],
        closed: false
      ),
      stroke: #ffffff,
      width: 1px
    );
    CalloutLayer() {
      Callout(
        anchor: visualAnchor(owner: camera, local: { x: 4px, y: 3px }),
        placements: ["right", "left"],
        offset: 2px,
        safeArea: 1px,
        leader: "straight",
        leaderColor: #ffffff,
        leaderWidth: 1px
      ) {
        LocalSpace(width: 8px, height: 4px, origin: { x: 0px, y: 0px }) {
          Rect(width: 8px, height: 4px, x: 4px, y: 2px, fill: #101820);
        }
      }
    }
  }
}
export out = render(main);`;
}

function compile(options: Fixture = {}) {
  const parsed = parseCutLanguage(source(options));
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(
    parsed.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
    JSON.stringify(parsed.diagnostics),
  );
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(
    checked.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
    JSON.stringify(checked.diagnostics),
  );
  return compileCutModule(parsed.module).ir;
}

function onlyNode(ir: CutAVIR, op: string) {
  const matches = Object.values(ir.nodes).filter((node) => node.op === op);
  assert.equal(matches.length, 1, op);
  return matches[0]!;
}

function consumers(ir: CutAVIR) {
  return [
    onlyNode(ir, "cut.visual.path"),
    onlyNode(ir, "cut.visual.callout"),
  ] as const;
}

function status(ir: CutAVIR, previous: ReturnType<typeof createIncrementalRenderPlan>["manifest"], node: IRNode) {
  const planned = createIncrementalRenderPlan(ir, "main", previous).nodes.find((item) => item.id === node.id);
  assert.ok(planned, node.id);
  return planned.status;
}

function assertConsumerChange(
  baseline: CutAVIR,
  changed: CutAVIR,
  expected: "hit" | "miss",
  label: string,
) {
  const previous = createIncrementalRenderPlan(baseline, "main").manifest;
  const baselineConsumers = consumers(baseline);
  const changedConsumers = consumers(changed);
  for (let index = 0; index < baselineConsumers.length; index += 1) {
    const before = baselineConsumers[index]!;
    const after = changedConsumers[index]!;
    assert.equal(after.id, before.id, `${label}: consumer id must remain stable`);
    if (expected === "miss") {
      assert.notEqual(after.contentHash, before.contentHash, `${label}: ${after.op} spatial identity`);
    } else {
      assert.equal(after.contentHash, before.contentHash, `${label}: ${after.op} geometry locality`);
    }
    assert.equal(status(changed, previous, after), expected, `${label}: ${after.op} incremental cache`);
  }
}

test("MediaCamera2D spatial controls and ResponsiveSlot placement invalidate anchored Path and Callout identities", () => {
  const baseline = compile();
  for (const [label, options] of [
    ["focusX", { focusX: "35%" }],
    ["focusY", { focusY: "55%" }],
    ["zoom", { zoom: "1.4" }],
    ["rotation", { rotation: "8deg" }],
    ["safeX", { safeX: "5%" }],
    ["safeY", { safeY: "5%" }],
    ["gap", { gap: "6px" }],
    ["weights", { weights: "1, 2" }],
    ["composition aspect", { width: 80, height: 36 }],
  ] as const satisfies readonly (readonly [string, Fixture])[]) {
    assertConsumerChange(baseline, compile(options), "miss", label);
  }
});

test("signal-backed MediaCamera2D spatial properties invalidate anchored consumer identities", () => {
  for (const [property, from, baselineTo, changedTo] of [
    ["focusX", "25%", "35%", "45%"],
    ["focusY", "45%", "55%", "65%"],
    ["zoom", "1.2", "1.3", "1.4"],
    ["rotation", "2deg", "5deg", "8deg"],
  ] as const) {
    const baseline = compile({ animation: { property, from, to: baselineTo } });
    const changed = compile({ animation: { property, from, to: changedTo } });
    assertConsumerChange(baseline, changed, "miss", `animated ${property}`);
  }
});

test("MediaCamera2D opacity, edge, and inner grade edits preserve anchored geometry locality", () => {
  const baseline = compile();
  for (const [label, options] of [
    ["opacity", { opacity: "80%" }],
    ["edge", { edge: "clamp" }],
    ["grade", { exposure: "0.4" }],
  ] as const satisfies readonly (readonly [string, Fixture])[]) {
    const changed = compile(options);
    assertConsumerChange(baseline, changed, "hit", label);
    const previous = createIncrementalRenderPlan(baseline, "main").manifest;
    assert.equal(
      status(changed, previous, onlyNode(changed, "cut.visual.media_camera2d")),
      "miss",
      `${label}: camera pixels still invalidate`,
    );
    assert.deepEqual(
      createIncrementalRenderPlan(changed, "main", previous).scenes.map((scene) => scene.status),
      ["miss"],
      `${label}: composed picture still invalidates`,
    );
  }
});
