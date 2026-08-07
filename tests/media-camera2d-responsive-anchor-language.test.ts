import assert from "node:assert/strict";
import test from "node:test";
import { hash } from "../lib/core/stable";
import { cutAnchoredSpatialOps } from "../lib/language/anchored-path-contract";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRCallValue, IRValue } from "../lib/language/ir";
import { CutAvIrValidationError, loadCutAvIr } from "../lib/language/ir-loader";
import {
  cutMediaCamera2DOp,
  cutMediaCamera2DResponsiveSlotContextInput,
} from "../lib/language/media-camera2d-contract";
import { parseCutLanguage } from "../lib/language/parser";
import { finalizeGraphHashes } from "../lib/runtime/graph";

function parse(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(
    parsed.diagnostics.filter((item) => item.severity === "error"),
    [],
    JSON.stringify(parsed.diagnostics),
  );
  return parsed.module;
}

function diagnostics(source: string) {
  return checkCutModule(parse(source)).diagnostics.filter((item) => item.severity === "error");
}

function compile(source: string) {
  const parsedModule = parse(source);
  const checked = checkCutModule(parsedModule);
  assert.deepEqual(
    checked.diagnostics.filter((item) => item.severity === "error"),
    [],
    JSON.stringify(checked.diagnostics),
  );
  return compileCutModule(parsedModule).ir;
}

const imports = `import {
  Callout, CalloutLayer, Image, LocalSpace, MediaCamera2D, Path, Rect,
  ResponsiveSlot, ResponsiveStack, anchoredLineTo, anchoredPath,
  responsiveStackPlan, visualAnchor
} from "cut:visual";`;

function cameraSlot(alias = "shot") {
  return `ResponsiveSlot() {
        MediaCamera2D(zoom: 1.25) as ${alias} {
          Image(source: still, fit: "cover");
        }
      }`;
}

function panelSlot(alias = "") {
  return `ResponsiveSlot() {
        Rect(width: 32px, height: 32px, fill: #f59e0b)${alias ? ` as ${alias}` : ""};
      }`;
}

function stack(alias = "shot", second = panelSlot()) {
  return `let plan = responsiveStackPlan(weights: [2, 1], safeX: 4%, safeY: 6%, gap: 12px);
    ResponsiveStack(plan: plan) {
      ${cameraSlot(alias)}
      ${second}
    }`;
}

function callout(owner = "shot") {
  return `CalloutLayer() {
      Callout(
        anchor: visualAnchor(owner: ${owner}, local: { x: 120px, y: 80px }),
        placements: ["right", "left"],
        offset: 8px,
        safeArea: 8px,
        leader: "straight",
        leaderColor: #ffffff,
        leaderWidth: 2px
      ) {
        LocalSpace(width: 80px, height: 28px, origin: { x: 0px, y: 0px }) {
          Rect(width: 80px, height: 28px, x: 40px, y: 14px, fill: #1f2937);
        }
      }
    }`;
}

function sceneSource(options: {
  before?: string;
  firstAlias?: string;
  firstSecondSlot?: string;
  calloutOwner?: string;
  after?: string;
} = {}) {
  return `cut 0.4;
project "Responsive slot camera anchor language proof";
${imports}
asset still: ImageAsset = image("media/still.png");

timeline main(duration: 1s, fps: 24, width: 640px, height: 360px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    ${options.before ?? ""}
    ${stack(options.firstAlias ?? "shot", options.firstSecondSlot ?? panelSlot())}
    ${callout(options.calloutOwner ?? options.firstAlias ?? "shot")}
    ${options.after ?? ""}
  }
}
export out = render(main);`;
}

function path(owner = "shot") {
  return `Path(
      geometry: anchoredPath(
        start: visualAnchor(owner: ${owner}, local: { x: 120px, y: 80px }),
        segments: [anchoredLineTo(to: { x: 200px, y: 100px })],
        closed: false
      ),
      stroke: #ffffff,
      width: 2px
    );`;
}

function componentSource(consumer: string) {
  return `cut 0.4;
project "Responsive slot camera component lexical proof";
${imports}

component Card(still: ImageAsset) -> Visual {
  ${stack("shot")}
  ${consumer}
}

asset still: ImageAsset = image("media/still.png");
timeline main(duration: 1s, fps: 24, width: 640px, height: 360px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Card(still);
  }
}
export out = render(main);`;
}

function node(ir: CutAVIR, op: string) {
  const values = Object.values(ir.nodes).filter((candidate) => candidate.op === op);
  assert.equal(values.length, 1, op);
  return values[0]!;
}

function calloutAnchor(ir: CutAVIR) {
  const value = node(ir, "cut.visual.callout").inputs.anchor;
  assert.ok(value?.kind === "call");
  assert.equal(value.op, cutAnchoredSpatialOps.visualAnchor);
  return value as IRCallValue;
}

function camerasInSceneOrder(ir: CutAVIR) {
  const scene = Object.values(ir.scenes)[0]!;
  return scene.items.flatMap((item) => {
    const root = ir.nodes[item.id];
    if (root?.op !== "cut.visual.responsive_stack") return [];
    return root.children.flatMap((slotId) => {
      const slot = ir.nodes[slotId];
      const camera = slot?.children.length === 1 ? ir.nodes[slot.children[0]!] : undefined;
      return camera?.op === cutMediaCamera2DOp ? [camera] : [];
    });
  });
}

function resignContext(value: IRValue) {
  assert.equal(value.kind, "object");
  const semantic = structuredClone(value);
  assert.equal(semantic.kind, "object");
  delete semantic.entries.contextIdentity;
  value.entries.contextIdentity = { kind: "string", value: hash(semantic) };
}

function expectLoadDiagnostic(
  canonical: CutAVIR,
  mutate: (hostile: CutAVIR) => void,
  code: CutAvIrValidationError["code"],
  path: RegExp,
) {
  const hostile = structuredClone(canonical);
  mutate(hostile);
  finalizeGraphHashes(hostile);
  assert.throws(() => loadCutAvIr(JSON.stringify(hostile)), (error: unknown) => {
    assert.ok(error instanceof CutAvIrValidationError, String(error));
    assert.equal(error.code, code);
    assert.match(error.path, path);
    return true;
  });
}

test("one direct slot-camera alias escapes after ResponsiveStack and lowers visualAnchor to the exact camera/context", () => {
  const source = sceneSource();
  assert.deepEqual(diagnostics(source), []);
  const ir = compile(source);
  const [camera] = camerasInSceneOrder(ir);
  assert.ok(camera);
  assert.equal(camera.ownership, "child");
  assert.ok(camera.inputs[cutMediaCamera2DResponsiveSlotContextInput]);
  assert.deepEqual(calloutAnchor(ir).named.owner, { kind: "node-ref", id: camera.id });
  assert.equal(loadCutAvIr(JSON.stringify(ir)).buildId, ir.buildId);

  const formatted = compile(source.replace(
    `${callout("shot")}`,
    `// comment cannot alter anchor identity\n    ${callout("shot")}`,
  ));
  assert.equal(formatted.buildId, ir.buildId);
});

test("slot-camera alias is late-bound, unique, collision-free, and the only nested alias that escapes", () => {
  const before = sceneSource({
    before: callout("shot"),
  });
  assert.ok(diagnostics(before).some((item) => item.code === "CUT2010" && item.message.includes("shot")));

  const collision = sceneSource({
    before: "Rect(width: 20px, height: 20px, fill: #ffffff) as shot;",
  });
  assert.ok(diagnostics(collision).some((item) =>
    item.code === "CUT_MEDIA_CAMERA_SCOPE"
    && item.message.includes("collides")));

  const twoAliases = sceneSource({
    firstSecondSlot: cameraSlot("otherShot"),
  });
  assert.ok(diagnostics(twoAliases).some((item) =>
    item.code === "CUT_MEDIA_CAMERA_SCOPE"
    && item.message.includes("at most one")));

  const unrelated = sceneSource({
    firstAlias: "shot",
    firstSecondSlot: panelSlot("panel"),
    calloutOwner: "panel",
  });
  assert.ok(diagnostics(unrelated).some((item) => item.code === "CUT2010" && item.message.includes("panel")));
});

test("alias is visible in its immediate component scope but never escapes the component boundary", () => {
  const local = componentSource(path("shot"));
  const localDiagnostics = diagnostics(local);
  assert.equal(localDiagnostics.some((item) => item.code === "CUT2010" && item.message.includes("shot")), false);
  assert.deepEqual(localDiagnostics, []);
  const localIr = compile(local);
  const fragment = node(localIr, "cut.kernel.fragment");
  assert.deepEqual(fragment.children.map((id) => localIr.nodes[id]!.op), [
    "cut.visual.responsive_stack",
    "cut.visual.path",
  ]);
  assert.equal(fragment.ownership, "root");
  assert.equal(loadCutAvIr(JSON.stringify(localIr)).buildId, localIr.buildId);

  const escaped = `cut 0.4;
project "Responsive slot camera component non-leak proof";
${imports}
component Card(still: ImageAsset) -> Visual {
  ${stack("shot")}
}
asset still: ImageAsset = image("media/still.png");
timeline main(duration: 1s, fps: 24, width: 640px, height: 360px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Card(still);
    Card(still);
    ${path("shot")}
  }
}
export out = render(main);`;
  assert.ok(diagnostics(escaped).some((item) => item.code === "CUT2010" && item.message.includes("shot")));
});

test("exact annotated component admits CalloutLayer while every nonqualified nested CalloutLayer remains rejected", () => {
  const source = componentSource(callout("shot"));
  const errors = diagnostics(source);
  assert.equal(errors.some((item) => item.code === "CUT2010" && item.message.includes("shot")), false);
  assert.deepEqual(errors, []);
  const ir = compile(source);
  const fragment = node(ir, "cut.kernel.fragment");
  assert.deepEqual(fragment.children.map((id) => ir.nodes[id]!.op), [
    "cut.visual.responsive_stack",
    "cut.visual.callout_layer",
  ]);
  assert.equal(loadCutAvIr(JSON.stringify(ir)).buildId, ir.buildId);

  const nonqualified = source.replace(
    callout("shot"),
    `Rect(width: 12px, height: 12px, fill: #ffffff);\n    ${callout("shot")}`,
  );
  const rejected = diagnostics(nonqualified);
  assert.equal(rejected.some((item) => item.code === "CUT2010" && item.message.includes("shot")), false);
  assert.ok(rejected.some((item) =>
    item.code === "CUT_CALLOUT_GRAPH"
    && item.message.includes("direct scene-root")));
});

test("strict loading rejects late/foreign owners and forged or transplanted responsive context", () => {
  const secondStack = stack("lateShot").replace("let plan =", "let latePlan =")
    .replaceAll("plan: plan", "plan: latePlan");
  const canonical = compile(sceneSource({ after: secondStack }));
  const cameras = camerasInSceneOrder(canonical);
  assert.equal(cameras.length, 2);

  expectLoadDiagnostic(canonical, (hostile) => {
    const owner = calloutAnchor(hostile).named.owner;
    assert.ok(owner?.kind === "node-ref");
    owner.id = camerasInSceneOrder(hostile)[1]!.id;
  }, "CUT_CALLOUT_ANCHOR", /\.named\.owner\.id$/u);

  expectLoadDiagnostic(canonical, (hostile) => {
    const [first, second] = camerasInSceneOrder(hostile);
    first!.inputs[cutMediaCamera2DResponsiveSlotContextInput] = structuredClone(
      second!.inputs[cutMediaCamera2DResponsiveSlotContextInput]!,
    );
  }, "CUT_CALLOUT_ANCHOR", /responsiveSlotContext/u);

  expectLoadDiagnostic(canonical, (hostile) => {
    const [camera] = camerasInSceneOrder(hostile);
    const context = camera!.inputs[cutMediaCamera2DResponsiveSlotContextInput]!;
    assert.equal(context.kind, "object");
    context.entries.stackNodeId = { kind: "string", value: "forged-stack" };
    resignContext(context);
  }, "CUT_CALLOUT_ANCHOR", /stackNodeId$/u);
});

test("strict loading rejects incomplete, foreign-scene, non-slot, and unrelated nested owners", () => {
  const canonical = compile(sceneSource());

  expectLoadDiagnostic(canonical, (hostile) => {
    camerasInSceneOrder(hostile)[0]!.interval.duration = { numerator: "1", denominator: "2" };
  }, "CUT_CALLOUT_ANCHOR", /\.named\.owner\.id$/u);

  expectLoadDiagnostic(canonical, (hostile) => {
    camerasInSceneOrder(hostile)[0]!.sceneId = "foreign-scene";
  }, "CUT_IR_REFERENCE", /\.sceneId$/u);

  expectLoadDiagnostic(canonical, (hostile) => {
    const [camera] = camerasInSceneOrder(hostile);
    const slot = Object.values(hostile.nodes).find((candidate) => candidate.children.includes(camera!.id));
    assert.ok(slot);
    slot.op = "cut.visual.group";
  }, "CUT_CALLOUT_ANCHOR", /\.named\.owner\.id$/u);

  expectLoadDiagnostic(canonical, (hostile) => {
    const camera = camerasInSceneOrder(hostile)[0]!;
    const image = hostile.nodes[camera.children[0]!]!;
    const owner = calloutAnchor(hostile).named.owner;
    assert.ok(owner?.kind === "node-ref");
    owner.id = image.id;
  }, "CUT_CALLOUT_ANCHOR", /\.named\.owner\.id$/u);
});

test("direct scene-root MediaCamera2D visualAnchor behavior and wire remain unchanged", () => {
  const source = `cut 0.4;
project "Direct camera anchor compatibility";
${imports}
asset still: ImageAsset = image("media/still.png");
timeline main(duration: 1s, fps: 24, width: 640px, height: 360px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    MediaCamera2D(zoom: 1.25) as shot {
      Image(source: still, fit: "cover");
    }
    ${path("shot")}
  }
}
export out = render(main);`;
  const ir = compile(source);
  const camera = node(ir, cutMediaCamera2DOp);
  assert.equal(camera.ownership, "root");
  assert.equal(camera.inputs[cutMediaCamera2DResponsiveSlotContextInput], undefined);
  assert.equal(loadCutAvIr(JSON.stringify(ir)).buildId, ir.buildId);
});
