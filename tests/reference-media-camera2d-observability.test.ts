import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import {
  ReferenceMediaCamera2DObservabilityError,
  referenceMediaCamera2DClampPadding,
  referenceMediaCamera2DQ16Affine,
  referenceMediaCamera2DQuantizedAffine,
  validateReferenceMediaCamera2DQ16Observability,
  type ReferenceMediaCamera2DObservabilityGrid,
} from "../lib/runtime/reference/media-camera2d-observability";
import {
  referenceMediaCamera2DFramePlanAt,
  validateReferenceMediaCamera2DGraph,
} from "../lib/runtime/reference/media-camera2d";
import {
  referenceRetainedMediaViewportQ16BilinearTapsAt,
  referenceRetainedMediaViewportQ16SamplingTransform,
  referenceRetainedMediaViewportQ16Units,
} from "../lib/runtime/reference/retained-media-viewport";
import { prepareReferenceVerifiedInputSession } from "../lib/runtime/reference/verified-input-session";

function program(
  controls: string,
  options: Readonly<{
    fit?: "cover" | "contain" | "fill";
    width?: number;
    height?: number;
    source?: string;
    animation?: string;
  }> = {},
) {
  const width = options.width ?? 8;
  const height = options.height ?? 8;
  return `cut 0.4;
project "MediaCamera2D Q16 observability";
import { Image, MediaCamera2D } from "cut:visual";
import { linear } from "@cut/motion";
asset media: ImageAsset = image("assets/${options.source ?? "source.png"}");
timeline main(duration: 1s, fps: 4, width: ${width}px, height: ${height}px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    MediaCamera2D(${controls}) as camera {
      Image(source: media, fit: "${options.fit ?? "fill"}");
    }
    ${options.animation ?? ""}
  }
}
export out = render(main, width: ${width}px, height: ${height}px, codec: "h264");`;
}

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics.filter((item) => item.severity === "error"), [], JSON.stringify(parsed.diagnostics));
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), [], JSON.stringify(checked.diagnostics));
  return compileCutModule(parsed.module).ir;
}

function camera(ir: CutAVIR) {
  const matches = Object.values(ir.nodes).filter((node) => node.op === "cut.visual.media_camera2d");
  assert.equal(matches.length, 1);
  return matches[0]!;
}

function scalar(value: string) {
  const [numerator, denominator = "1"] = value.split("/");
  return { kind: "quantity" as const, dimension: "scalar", unit: "scalar", magnitude: { numerator: numerator!, denominator } };
}

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "cut-media-camera-observability-"));
  await mkdir(resolve(root, "assets"));
  const small = Buffer.alloc(8 * 6 * 4, 255);
  await sharp(small, { raw: { width: 8, height: 6, channels: 4 } })
    .png()
    .toFile(resolve(root, "assets/source.png"));
  const wide = Buffer.alloc(1536 * 471 * 4, 255);
  await sharp(wide, { raw: { width: 1536, height: 471, channels: 4 } })
    .png()
    .toFile(resolve(root, "assets/wide.png"));
  const letterbox = Buffer.alloc(8 * 4 * 4, 255);
  await sharp(letterbox, { raw: { width: 8, height: 4, channels: 4 } })
    .png()
    .toFile(resolve(root, "assets/letterbox.png"));
  await sharp(Buffer.from([200, 50, 25, 255]), { raw: { width: 1, height: 1, channels: 4 } })
    .png()
    .toFile(resolve(root, "assets/one.png"));
  await sharp(Buffer.from([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 0, 255,
  ]), { raw: { width: 2, height: 2, channels: 4 } })
    .png()
    .toFile(resolve(root, "assets/two.png"));
  return root;
}

async function locked(root: string, source: string) {
  const ir = compile(source);
  const lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  return ir;
}

function grid(
  sourceWidth: number,
  sourceHeight: number,
  outputWidth = 8,
  outputHeight = 8,
  fit: ReferenceMediaCamera2DObservabilityGrid["fit"] = "fill",
  edge: ReferenceMediaCamera2DObservabilityGrid["edge"] = "transparent",
): ReferenceMediaCamera2DObservabilityGrid {
  return Object.freeze({
    source: Object.freeze({ width: sourceWidth, height: sourceHeight }),
    output: Object.freeze({ width: outputWidth, height: outputHeight }),
    fit,
    edge,
  });
}

function assertNoop(run: () => unknown, property: string) {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ReferenceMediaCamera2DObservabilityError);
    assert.equal(error.code, "CUT_MEDIA_CAMERA_NOOP");
    assert.equal(error.source.module, "project.cut");
    assert.equal(error.source.line, 8);
    assert.match(error.message, new RegExp(property, "u"));
    assert.match(error.message, /locked output-frame sample/u);
    return true;
  }, property);
}

test("tiny focusX, focusY, zoom, rotation, and opacity changes fail against executed locked-grid defaults", async () => {
  const root = await fixture();
  try {
    const cases = [
      ["focusX", "focusX: 50.000001%"],
      ["focusY", "focusY: 50.000001%"],
      ["zoom", "zoom: 1.000000000000000000000000000001"],
      ["rotation", "rotation: 0.000001deg"],
      ["opacity", "opacity: 99.999999%"],
    ] as const;
    for (const [property, controls] of cases) {
      const ir = await locked(root, program(controls));
      assertNoop(
        () => validateReferenceMediaCamera2DQ16Observability(ir, ir.compositions[0]!, camera(ir), grid(8, 6)),
        property,
      );
      assertNoop(
        () => validateReferenceMediaCamera2DGraph(ir, ir.compositions[0]!),
        property,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nearby spatial controls execute distinct Q16 plans and helper geometry equals the frame planner", async () => {
  const root = await fixture();
  try {
    const cases = [
      ["focusX", "focusX: 50.01%"],
      ["focusY", "focusY: 50.01%"],
      ["zoom", "zoom: 1.001"],
      ["rotation", "rotation: 0.01deg"],
    ] as const;
    for (const [property, controls] of cases) {
      const ir = await locked(root, program(controls));
      const owner = camera(ir);
      const report = validateReferenceMediaCamera2DQ16Observability(
        ir,
        ir.compositions[0]!,
        owner,
        grid(8, 6),
      );
      assert.deepEqual(report.authoredSpatialControls, [property]);
      assert.deepEqual(report.observableSpatialControls, [property]);
      assert.equal(report.opacityAuthored, false);
      assert.equal(report.opacityObservable, false);
      assert.equal(report.opacityPhaseUnits, 255);
      assert.equal(report.samples, 4);
      assert.equal(report.witnessPixelsPerPlan, 25);
      assert.equal(report.planEvaluations, 8);
      assert.equal(report.workUnits, 200);

      const plan = validateReferenceMediaCamera2DGraph(ir, ir.compositions[0]!).get(owner.id)!;
      assert.deepEqual(plan.observability, report, "the actual locked plan must retain the exact report that admitted its grid");
      const frame = referenceMediaCamera2DFramePlanAt(ir, ir.compositions[0]!, plan, rational(0));
      assert.deepEqual(
        referenceMediaCamera2DQ16Affine(owner, grid(8, 6), {
          focusX: frame.controls.focusX,
          focusY: frame.controls.focusY,
          zoom: frame.controls.zoom,
          rotationDegrees: frame.controls.rotationDegrees,
        }),
        frame.geometry.sourceToDeliveryQ16,
        "observability must use the exact executed Q16 matrix, not an estimate",
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("observability and raster share one Q16 tap kernel at the audited IEEE half-phase boundary", () => {
  const affine = Object.freeze({
    a: -0.6697235107421875,
    b: 0.1084136962890625,
    c: -0.079315185546875,
    d: -0.490020751953125,
    tx: 1039.1365051269531,
    ty: 1278.8800811767578,
  });
  const transform = referenceRetainedMediaViewportQ16SamplingTransform(affine);
  assert.ok(transform);
  const taps = referenceRetainedMediaViewportQ16BilinearTapsAt(transform, 607, 773);
  const topWeight = taps[0]![0] + taps[1]![0];
  const fy = referenceRetainedMediaViewportQ16Units - topWeight / referenceRetainedMediaViewportQ16Units;
  const sourceYQ = taps[0]![2] * referenceRetainedMediaViewportQ16Units + fy;
  assert.equal(sourceYQ, 75_046_372, "the old algebraically reordered proof rounded this exact state to 75,046,373");
});

test("a material RGBA8 opacity change is retained as an executed witness", async () => {
  const root = await fixture();
  try {
    const ir = await locked(root, program("opacity: 99%"));
    const owner = camera(ir);
    const plan = validateReferenceMediaCamera2DGraph(ir, ir.compositions[0]!).get(owner.id)!;
    assert.equal(plan.observability.opacityAuthored, true);
    assert.equal(plan.observability.opacityObservable, true);
    assert.equal(plan.observability.opacityPhaseUnits, 255);
    assert.deepEqual(plan.observability.authoredSpatialControls, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("matrix motion without a changed executed output-pixel sample is rejected on a degenerate locked grid", async () => {
  const root = await fixture();
  try {
    const ir = await locked(root, program("zoom: 1.1, opacity: 50%", {
      source: "one.png",
      width: 1,
      height: 1,
    }));
    const owner = camera(ir);
    assert.notDeepEqual(
      referenceMediaCamera2DQ16Affine(owner, grid(1, 1, 1, 1), { focusX: 0.5, focusY: 0.5, zoom: 1.1, rotationDegrees: 0 }),
      referenceMediaCamera2DQ16Affine(owner, grid(1, 1, 1, 1), { focusX: 0.5, focusY: 0.5, zoom: 1, rotationDegrees: 0 }),
      "the coefficient matrix differs even though the sole executed inverse sample does not",
    );
    assertNoop(
      () => validateReferenceMediaCamera2DGraph(ir, ir.compositions[0]!),
      "zoom",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a nondegenerate 2x2-to-2x8 subphase focus shift cannot pass on matrix difference alone", async () => {
  const root = await fixture();
  try {
    const ir = await locked(root, program("focusY: 50.0003%, opacity: 50%", {
      source: "two.png",
      width: 2,
      height: 8,
      fit: "fill",
    }));
    const owner = camera(ir);
    assert.notDeepEqual(
      referenceMediaCamera2DQ16Affine(owner, grid(2, 2, 2, 8), { focusX: 0.5, focusY: 0.500003, zoom: 1, rotationDegrees: 0 }),
      referenceMediaCamera2DQ16Affine(owner, grid(2, 2, 2, 8), { focusX: 0.5, focusY: 0.5, zoom: 1, rotationDegrees: 0 }),
    );
    assertNoop(
      () => validateReferenceMediaCamera2DGraph(ir, ir.compositions[0]!),
      "focusY",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Q8 phase-zero opacity and individually redundant Q8/Q16 track events fail closed", async () => {
  const root = await fixture();
  try {
    const transparent = await locked(root, program("opacity: 0.1%"));
    assertNoop(
      () => validateReferenceMediaCamera2DGraph(transparent, transparent.compositions[0]!),
      "Q8 phase zero",
    );
    const dynamicallyTransparent = await locked(root, program("opacity: 0.01%", {
      animation: "animate camera.opacity from 0.01% to 0.1% over 1s ease linear;",
    }));
    assertNoop(
      () => validateReferenceMediaCamera2DGraph(dynamicallyTransparent, dynamicallyTransparent.compositions[0]!),
      "Q8 phase zero",
    );

    const cases = [
      ["opacity", "opacity: 50%", "at 250ms { set camera.opacity = 60%; } at 500ms { set camera.opacity = 60.000001%; }"],
      ["zoom", "zoom: 1.2", "at 250ms { set camera.zoom = 1.3; } at 500ms { set camera.zoom = 1.300000000001; }"],
    ] as const;
    for (const [property, controls, animation] of cases) {
      const ir = await locked(root, program(controls, { animation }));
      assertNoop(
        () => validateReferenceMediaCamera2DGraph(ir, ir.compositions[0]!),
        `${property} signal .*events\\[1\\] set`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("constant, step-point, and keyframe counterfactuals use executed backend plans", async () => {
  const root = await fixture();
  try {
    const make = async () => {
      const ir = await locked(root, program("zoom: 1.2", {
        animation: "at 500ms { set camera.zoom = 1.3; }",
      }));
      const owner = camera(ir), attached = owner.properties.zoom;
      assert.ok(attached && "signal" in attached);
      return { ir, owner, signalId: attached.signal, original: ir.signals[attached.signal]! };
    };

    const constant = await make();
    constant.ir.signals[constant.signalId] = {
      id: constant.signalId,
      kind: "constant",
      valueType: "Number",
      value: scalar("1200000000001/1000000000000"),
      contentHash: constant.original.contentHash,
      provenance: constant.original.provenance,
    };
    assertNoop(
      () => validateReferenceMediaCamera2DGraph(constant.ir, constant.ir.compositions[0]!),
      "zoom signal .*signal-free constructor/default",
    );

    const step = await make();
    step.ir.signals[step.signalId] = {
      id: step.signalId,
      kind: "step",
      valueType: "Number",
      points: [
        { time: rational(0), value: scalar("13/10") },
        { time: rational(1, 2), value: scalar("1300000000001/1000000000000") },
      ],
      contentHash: step.original.contentHash,
      provenance: step.original.provenance,
    };
    assertNoop(
      () => validateReferenceMediaCamera2DGraph(step.ir, step.ir.compositions[0]!),
      "zoom signal .*points\\[",
    );

    const keyframes = await make();
    keyframes.ir.signals[keyframes.signalId] = {
      id: keyframes.signalId,
      kind: "keyframes",
      valueType: "Number",
      keyframes: [
        { time: rational(0), value: scalar("13/10"), curve: { kind: "symbol", name: "linear" } },
        { time: rational(1), value: scalar("1300000000001/1000000000000"), curve: { kind: "symbol", name: "linear" } },
      ],
      contentHash: keyframes.original.contentHash,
      provenance: keyframes.original.provenance,
    };
    assertNoop(
      () => validateReferenceMediaCamera2DGraph(keyframes.ir, keyframes.ir.compositions[0]!),
      "zoom signal .*keyframes\\[",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("same-phase accepted static opacity aliases share canonical executed frame identity", async () => {
  const root = await fixture();
  try {
    const first = await locked(root, program("opacity: 50%"));
    const second = await locked(root, program("opacity: 50.000001%"));
    const firstPlan = validateReferenceMediaCamera2DGraph(first, first.compositions[0]!).get(camera(first).id)!;
    const secondPlan = validateReferenceMediaCamera2DGraph(second, second.compositions[0]!).get(camera(second).id)!;
    assert.notEqual(firstPlan.semanticIdentity, secondPlan.semanticIdentity, "authored source provenance remains distinct");
    const firstFrame = referenceMediaCamera2DFramePlanAt(first, first.compositions[0]!, firstPlan, rational(0));
    const secondFrame = referenceMediaCamera2DFramePlanAt(second, second.compositions[0]!, secondPlan, rational(0));
    assert.equal(firstFrame.controls.opacityPhase, 128);
    assert.equal(secondFrame.controls.opacityPhase, 128);
    assert.equal(firstFrame.planIdentity, secondFrame.planIdentity, "executed identity must hash Q8, not ignored raw precision");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("comments and formatting do not change dynamic camera observability or executable plan identity", async () => {
  const root = await fixture();
  try {
    const canonicalSource = program("zoom: 1.2", {
      animation: "animate camera.zoom from 1.2 to 1.4 over 1s ease linear;",
    });
    const formattedSource = canonicalSource.replace(
      "timeline main",
      "// formatting-only camera note\n\n\ntimeline main",
    );
    const canonical = await locked(root, canonicalSource), formatted = await locked(root, formattedSource);
    const canonicalPlan = validateReferenceMediaCamera2DGraph(canonical, canonical.compositions[0]!).get(camera(canonical).id)!;
    const formattedPlan = validateReferenceMediaCamera2DGraph(formatted, formatted.compositions[0]!).get(camera(formatted).id)!;
    assert.equal(canonical.buildId, formatted.buildId);
    assert.equal(canonicalPlan.observability.authoredControlIdentity, formattedPlan.observability.authoredControlIdentity);
    assert.equal(canonicalPlan.semanticIdentity, formattedPlan.semanticIdentity);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a real whole-turn animation remains observable at intermediate output frames", async () => {
  const root = await fixture();
  try {
    const ir = await locked(root, program("", {
      animation: "animate camera.rotation from 0deg to 360deg over 1s ease linear;",
    }));
    const report = validateReferenceMediaCamera2DQ16Observability(
      ir,
      ir.compositions[0]!,
      camera(ir),
      grid(8, 6),
    );
    assert.deepEqual(report.authoredSpatialControls, ["rotation"]);
    assert.deepEqual(report.observableSpatialControls, ["rotation"]);
    assert.equal(report.samples, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clamp is rejected when locked geometry needs no padding and accepted when contain exposes an edge", async () => {
  const root = await fixture();
  try {
    const degenerate = await locked(root, program('zoom: 2, edge: "clamp"', {
      source: "wide.png",
      width: 960,
      height: 720,
      fit: "fill",
    }));
    assertNoop(
      () => validateReferenceMediaCamera2DQ16Observability(
        degenerate,
        degenerate.compositions[0]!,
        camera(degenerate),
        grid(1536, 471, 960, 720, "fill", "clamp"),
      ),
      "edge clamp",
    );
    assertNoop(
      () => validateReferenceMediaCamera2DGraph(degenerate, degenerate.compositions[0]!),
      "edge clamp",
    );

    const exposed = await locked(root, program('edge: "clamp"', {
      source: "letterbox.png",
      fit: "contain",
    }));
    const report = validateReferenceMediaCamera2DQ16Observability(
      exposed,
      exposed.compositions[0]!,
      camera(exposed),
      grid(8, 4, 8, 8, "contain", "clamp"),
    );
    assert.equal(report.edgeAuthored, true);
    assert.equal(report.edgeObservable, true);
    assert.deepEqual(report.authoredSpatialControls, []);
    const owner = camera(exposed);
    const plan = validateReferenceMediaCamera2DGraph(exposed, exposed.compositions[0]!).get(owner.id)!;
    assert.deepEqual(plan.observability, report);
    const frame = referenceMediaCamera2DFramePlanAt(exposed, exposed.compositions[0]!, plan, rational(0));
    const affine = referenceMediaCamera2DQuantizedAffine(owner, grid(8, 4, 8, 8, "contain", "clamp"), {
      focusX: frame.controls.focusX,
      focusY: frame.controls.focusY,
      zoom: frame.controls.zoom,
      rotationDegrees: frame.controls.rotationDegrees,
    });
    assert.deepEqual(
      referenceMediaCamera2DClampPadding(affine, { width: 8, height: 4 }, { width: 8, height: 8 }),
      frame.geometry.clampPadding,
      "observability and frame execution must share exact clamp-padding semantics",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an authored control must be causal even when another control already makes the camera observable", async () => {
  const root = await fixture();
  try {
    const ir = await locked(root, program("zoom: 1.000000000000000000000000000001, opacity: 50%"));
    assertNoop(
      () => validateReferenceMediaCamera2DQ16Observability(ir, ir.compositions[0]!, camera(ir), grid(8, 6)),
      "zoom",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the four-million sampler-observability budget is one real composition aggregate", async () => {
  const root = await fixture();
  try {
    const ir = await locked(root, program("focusX: 60%"));
    const composition = ir.compositions[0]!, scene = ir.scenes[composition.sceneIds[0]!]!;
    const firstCamera = camera(ir), firstLeaf = ir.nodes[firstCamera.children[0]!]!;
    const duration = rational(50_000);
    composition.fps = rational(1);
    composition.duration = duration;
    scene.duration = duration;
    firstCamera.interval.duration = duration;
    firstLeaf.interval.duration = duration;

    const secondCamera = structuredClone(firstCamera), secondLeaf = structuredClone(firstLeaf);
    secondCamera.id = "zzzz-shared-budget-camera";
    secondLeaf.id = "zzzz-shared-budget-leaf";
    secondCamera.children = [secondLeaf.id];
    secondCamera.interval.duration = duration;
    secondLeaf.interval.duration = duration;
    ir.nodes[secondCamera.id] = secondCamera;
    ir.nodes[secondLeaf.id] = secondLeaf;
    scene.rootVisualIds.push(secondCamera.id);
    scene.items.push({ id: secondCamera.id, domain: "visual" });

    assert.throws(
      () => validateReferenceMediaCamera2DGraph(ir, composition),
      (error: unknown) => {
        assert.ok(error instanceof ReferenceMediaCamera2DObservabilityError);
        assert.equal(error.code, "CUT_MEDIA_CAMERA_LIMIT");
        assert.match(error.message, /requires 2500000 Q16\/Q8 sampler-observability work units.*1500000 remain/u);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a representative animated camera admits five minutes at 30fps within the bounded production budget", async () => {
  const root = await fixture();
  try {
    const ir = await locked(root, program("zoom: 1.2", {
      animation: "animate camera.zoom from 1.2 to 1.6 over 1s ease linear;",
    }));
    const composition = ir.compositions[0]!, scene = ir.scenes[composition.sceneIds[0]!]!;
    const owner = camera(ir), leaf = ir.nodes[owner.children[0]!]!;
    const duration = rational(300);
    composition.fps = rational(30);
    composition.duration = duration;
    scene.duration = duration;
    owner.interval.duration = duration;
    leaf.interval.duration = duration;
    const property = owner.properties.zoom;
    assert.ok(property && "signal" in property);
    const signal = ir.signals[property.signal]!;
    if (signal.kind === "track") {
      for (const event of signal.events) if (event.kind === "animate") event.end = duration;
    }
    const report = validateReferenceMediaCamera2DQ16Observability(ir, composition, owner, grid(8, 6));
    assert.equal(report.samples, 9_000);
    assert.ok(report.workUnits <= 4_000_000);
    assert.ok(report.signalsProved.length >= 1);
    assert.ok(report.signalItemsProved.length >= 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("locked-grid no-op admission wins before any verified snapshot or source open", async () => {
  const root = await fixture();
  try {
    const ir = await locked(root, program("focusX: 50.000001%"));
    await rm(resolve(root, "assets/source.png"));
    await assert.rejects(
      prepareReferenceVerifiedInputSession(ir, root, "master"),
      (error: unknown) => {
        assert.ok(error instanceof ReferenceMediaCamera2DObservabilityError);
        assert.equal(error.code, "CUT_MEDIA_CAMERA_NOOP");
        assert.match(error.message, /authored focusX has no changed shared-kernel tap\/weight witness/u);
        return true;
      },
    );
    await assert.rejects(
      lstat(resolve(root, ".cut")),
      (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
