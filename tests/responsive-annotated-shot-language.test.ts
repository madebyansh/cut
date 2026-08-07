import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR, IRCallValue, IRNode } from "../lib/language/ir";
import { CutAvIrValidationError, loadCutAvIr } from "../lib/language/ir-loader";
import { parseCutLanguage } from "../lib/language/parser";
import { loadCutUserModuleGraph } from "../lib/language/user-modules";
import { finalizeGraphHashes } from "../lib/runtime/graph";

const visualImports = `import {
  Callout, CalloutLayer, Group, Image, LocalSpace, MediaCamera2D, Path, Rect,
  ResponsiveSlot, ResponsiveStack, anchoredLineTo, anchoredPath,
  responsiveStackPlan, visualAnchor
} from "cut:visual";`;

function component(name = "AnnotatedShot") {
  return `component ${name}(still: ImageAsset) -> Visual {
  let plan = responsiveStackPlan(weights: [2, 1], safeX: 4%, safeY: 6%, gap: 12px);
  ResponsiveStack(plan: plan) {
    ResponsiveSlot() {
      MediaCamera2D(zoom: 1.25) as shot {
        Image(source: still, fit: "cover");
      }
    }
    ResponsiveSlot() {
      Rect(width: 32px, height: 32px, fill: #f59e0b);
    }
  }
  Path(
    geometry: anchoredPath(
      start: visualAnchor(owner: shot, local: { x: 120px, y: 80px }),
      segments: [anchoredLineTo(to: { x: 200px, y: 100px })],
      closed: false
    ),
    stroke: #ffffff,
    width: 2px
  );
  CalloutLayer() {
    Callout(
      anchor: visualAnchor(owner: shot, local: { x: 160px, y: 90px }),
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
  }
}`;
}

function entry(invocation = "AnnotatedShot(still);", declaration = component()) {
  return `cut 0.4;
project "Responsive annotated identity fragment";
${visualImports}
${declaration}
asset still: ImageAsset = image("media/still.png");
timeline main(duration: 1s, fps: 24, width: 640px, height: 360px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    ${invocation}
  }
}
export out = render(main);`;
}

function parse(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics.filter((item) => item.severity === "error"), []);
  return parsed.module;
}

function errors(source: string) {
  return checkCutModule(parse(source)).diagnostics.filter((item) => item.severity === "error");
}

function compile(source: string) {
  const parsedModule = parse(source);
  const checked = checkCutModule(parsedModule);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), [], JSON.stringify(checked.diagnostics));
  return compileCutModule(parsedModule).ir;
}

function soleNode(ir: CutAVIR, op: string) {
  const nodes = Object.values(ir.nodes).filter((node) => node.op === op);
  assert.equal(nodes.length, 1, op);
  return nodes[0]!;
}

function boundary(ir: CutAVIR) {
  const fragment = soleNode(ir, "cut.kernel.fragment");
  const stack = ir.nodes[fragment.children[0]!]!;
  const path = fragment.children.map((id) => ir.nodes[id]!).find((node) => node.op === "cut.visual.path")!;
  const layer = fragment.children.map((id) => ir.nodes[id]!).find((node) => node.op === "cut.visual.callout_layer")!;
  const camera = stack.children.flatMap((slotId) => {
    const slot = ir.nodes[slotId]!;
    const child = ir.nodes[slot.children[0]!]!;
    return child.op === "cut.visual.media_camera2d" ? [child] : [];
  })[0]!;
  return { fragment, stack, path, layer, camera };
}

function annotatedSubtree(ir: CutAVIR, fragment: IRNode) {
  const pending = [fragment.id], seen = new Set<string>(), result: IRNode[] = [];
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = ir.nodes[id];
    if (!node) continue;
    result.push(node);
    pending.push(...node.children);
  }
  return result;
}

function anchorOwner(value: unknown) {
  const call = value as IRCallValue;
  assert.equal(call.kind, "call");
  const owner = call.named.owner;
  assert.equal(owner?.kind, "node-ref");
  return owner.id;
}

function mutateAndLoad(
  canonical: CutAVIR,
  mutate: (ir: CutAVIR) => void,
  code: CutAvIrValidationError["code"],
  path?: RegExp,
) {
  const hostile = structuredClone(canonical);
  mutate(hostile);
  finalizeGraphHashes(hostile);
  assert.throws(() => loadCutAvIr(JSON.stringify(hostile)), (error: unknown) => {
    assert.ok(error instanceof CutAvIrValidationError, String(error));
    assert.equal(error.code, code);
    if (path) assert.match(error.path, path);
    return true;
  });
}

test("direct complete-scene component lowers one authenticated identity fragment with ordered anchored consumers", () => {
  const source = entry();
  assert.deepEqual(errors(source), []);
  const ir = compile(source);
  const { fragment, stack, path, layer, camera } = boundary(ir);
  assert.equal(fragment.ownership, "root");
  assert.deepEqual(fragment.children.map((id) => ir.nodes[id]!.op), [
    "cut.visual.responsive_stack",
    "cut.visual.path",
    "cut.visual.callout_layer",
  ]);
  assert.deepEqual(fragment.inputs, {});
  assert.deepEqual(fragment.properties, {});
  assert.deepEqual(fragment.effects, ["pure"]);
  assert.equal(fragment.provenance.expandedFrom?.length, 2);
  assert.match(fragment.provenance.expandedFrom?.[0].symbol ?? "", /:definition$/u);
  assert.match(fragment.provenance.expandedFrom?.[1].symbol ?? "", /:invocation$/u);
  assert.equal(stack.ownership, "child");
  assert.equal(path.ownership, "child");
  assert.equal(layer.ownership, "child");
  assert.equal(anchorOwner((path.inputs.geometry as IRCallValue).named.start), camera.id);
  assert.equal(anchorOwner(soleNode(ir, "cut.visual.callout").inputs.anchor), camera.id);
  assert.equal(loadCutAvIr(JSON.stringify(ir)).buildId, ir.buildId);
});

test("annotated identity component remains direct-root, closed, unbound, and complete-interval only", async (context) => {
  await context.test("nested node", () => {
    const found = errors(entry(`Group() { AnnotatedShot(still); }`));
    assert.ok(found.some((item) => item.code === "CUT_RESPONSIVE_STACK_CONTEXT"));
  });
  await context.test("at block", () => {
    const found = errors(entry(`at 0s { AnnotatedShot(still); }`));
    assert.ok(found.some((item) => item.code === "CUT_RESPONSIVE_STACK_CONTEXT"));
  });
  await context.test("invocation children", () => {
    const found = errors(entry(`AnnotatedShot(still) { Rect(width: 8px, height: 8px, fill: #ffffff); }`));
    assert.ok(found.some((item) => item.code === "CUT_RESPONSIVE_STACK_GRAPH" && item.message.includes("structurally closed")));
  });
  await context.test("binding", () => {
    const found = errors(entry(`AnnotatedShot(still) as annotated;`));
    assert.ok(found.some((item) => item.code === "CUT_RESPONSIVE_STACK_GRAPH" && item.message.includes("cannot use")));
  });
});

test("annotated component refuses let-bound rendering nodes before lowering can orphan them", () => {
  const declaration = component().replace(
    "  let plan = responsiveStackPlan(",
    "  let ghost = Rect(width: 1px, height: 1px, fill: #ffffff);\n"
      + "  let plan = responsiveStackPlan(",
  );
  const source = entry("AnnotatedShot(still);", declaration);
  const found = errors(source);
  assert.ok(found.some((item) =>
    item.code === "CUT_RESPONSIVE_STACK_GRAPH"
    && item.message.includes("let-bound Visual/Audio/AV node")));
  assert.throws(
    () => compileCutModule(parse(source)),
    (error: unknown) => {
      assert.ok(error instanceof CutCompileError, String(error));
      assert.ok(error.result.diagnostics.some((item) =>
        item.code === "CUT_RESPONSIVE_STACK_GRAPH"));
      return true;
    },
  );
});

test("ordinary unary responsive components and direct-root CalloutLayer behavior remain unchanged", () => {
  const unary = `component AnnotatedShot(still: ImageAsset) -> Visual {
  let plan = responsiveStackPlan(weights: [2, 1], safeX: 4%, safeY: 6%, gap: 12px);
  ResponsiveStack(plan: plan) {
    ResponsiveSlot() {
      MediaCamera2D(zoom: 1.25) {
        Image(source: still, fit: "cover");
      }
    }
    ResponsiveSlot() {
      Rect(width: 32px, height: 32px, fill: #f59e0b);
    }
  }
}`;
  const unarySource = entry("AnnotatedShot(still);", unary);
  assert.deepEqual(errors(unarySource), []);
  assert.equal(loadCutAvIr(JSON.stringify(compile(unarySource))).format, "cut-av-ir");

  const direct = entry(
    `let directPlan = responsiveStackPlan(weights: [1], safeX: 4%, safeY: 6%, gap: 0px);
    ResponsiveStack(plan: directPlan) {
      ResponsiveSlot() {
        MediaCamera2D(zoom: 1.25) as shot {
          Image(source: still, fit: "cover");
        }
      }
    }
    CalloutLayer() {
      Callout(
        anchor: visualAnchor(owner: shot, local: { x: 160px, y: 90px }),
        placements: ["right"],
        offset: 8px,
        safeArea: 8px,
        leader: "straight",
        leaderColor: #ffffff,
        leaderWidth: 2px
      ) {
        LocalSpace(width: 80px, height: 28px, origin: { x: 0px, y: 0px }) {
          Rect(width: 80px, height: 28px, fill: #1f2937);
        }
      }
    }`,
    "",
  );
  assert.deepEqual(errors(direct), []);
  const directIr = compile(direct);
  assert.equal(soleNode(directIr, "cut.visual.callout_layer").ownership, "root");
  assert.equal(loadCutAvIr(JSON.stringify(directIr)).format, "cut-av-ir");
});

test("strict loading rejects malformed identity wrapper, child order, interval, and provenance", () => {
  const canonical = compile(entry());
  mutateAndLoad(canonical, (ir) => {
    boundary(ir).fragment.properties.x = { kind: "quantity", dimension: "length", magnitude: { numerator: "1", denominator: "1" }, unit: "px" };
  }, "CUT_RESPONSIVE_STACK_GRAPH", /\.properties$/u);
  mutateAndLoad(canonical, (ir) => {
    const { fragment } = boundary(ir);
    [fragment.children[0], fragment.children[1]] = [fragment.children[1]!, fragment.children[0]!];
  }, "CUT_IR_IDENTITY", /\.named\.owner\.id$/u);
  mutateAndLoad(canonical, (ir) => {
    boundary(ir).fragment.interval.duration = { numerator: "1", denominator: "2" };
  }, "CUT_RESPONSIVE_STACK_GRAPH");
  mutateAndLoad(canonical, (ir) => {
    const { fragment, path } = boundary(ir);
    path.provenance.expandedFrom = structuredClone(fragment.provenance.expandedFrom);
    path.provenance.expandedFrom![1]!.module = "foreign.cut";
  }, "CUT_RESPONSIVE_STACK_GRAPH", /children/u);
  mutateAndLoad(canonical, (ir) => {
    const { fragment } = boundary(ir);
    delete (fragment.provenance as { symbol?: string }).symbol;
  }, "CUT_RESPONSIVE_STACK_GRAPH", /provenance\.expandedFrom$/u);
  mutateAndLoad(canonical, (ir) => {
    const { fragment } = boundary(ir);
    for (const node of annotatedSubtree(ir, fragment)) {
      if (node.provenance.expandedFrom?.length === 2) {
        node.provenance.expandedFrom[0]!.symbol = ":definition";
      }
    }
  }, "CUT_RESPONSIVE_STACK_GRAPH", /provenance\.expandedFrom$/u);
  mutateAndLoad(canonical, (ir) => {
    const { fragment } = boundary(ir);
    for (const node of annotatedSubtree(ir, fragment)) {
      if (node.provenance.expandedFrom?.length === 2) {
        node.provenance.expandedFrom[0]!.symbol =
          "ForgedButWellFormed:definition";
      }
    }
  }, "CUT_RESPONSIVE_STACK_GRAPH", /provenance\.expandedFrom$/u);
  mutateAndLoad(canonical, (ir) => {
    const { fragment } = boundary(ir);
    for (const node of annotatedSubtree(ir, fragment)) {
      if (node.provenance.expandedFrom?.length === 2) {
        node.provenance.expandedFrom[1]!.symbol =
          "ForgedButWellFormed:invocation";
      }
    }
  }, "CUT_RESPONSIVE_STACK_GRAPH", /provenance\.expandedFrom$/u);
});

test("strict loading rejects extra cameras and cross-invocation or transplanted consumers", () => {
  const double = entry(`AnnotatedShot(still);\n    AnnotatedShot(still);`);
  const canonical = compile(double);
  const fragments = Object.values(canonical.nodes).filter((node) => node.op === "cut.kernel.fragment");
  assert.equal(fragments.length, 2);
  const inspect = (ir: CutAVIR, fragment: IRNode) => {
    const stack = ir.nodes[fragment.children[0]!]!;
    const camera = stack.children.flatMap((slotId) => {
      const slot = ir.nodes[slotId]!;
      const child = ir.nodes[slot.children[0]!]!;
      return child.op === "cut.visual.media_camera2d" ? [child] : [];
    })[0]!;
    const path = fragment.children.map((id) => ir.nodes[id]!).find((node) => node.op === "cut.visual.path")!;
    return { stack, camera, path };
  };
  mutateAndLoad(canonical, (ir) => {
    const first = inspect(ir, ir.nodes[fragments[0]!.id]!);
    const second = inspect(ir, ir.nodes[fragments[1]!.id]!);
    const geometry = first.path.inputs.geometry as IRCallValue;
    const owner = (geometry.named.start as IRCallValue).named.owner;
    assert.equal(owner?.kind, "node-ref");
    owner.id = second.camera.id;
  }, "CUT_IR_IDENTITY");
  mutateAndLoad(canonical, (ir) => {
    const first = ir.nodes[fragments[0]!.id]!, second = ir.nodes[fragments[1]!.id]!;
    const firstPathIndex = first.children.findIndex((id) => ir.nodes[id]!.op === "cut.visual.path");
    const secondPath = second.children.find((id) => ir.nodes[id]!.op === "cut.visual.path")!;
    first.children[firstPathIndex] = secondPath;
  }, "CUT_IR_IDENTITY");
  mutateAndLoad(canonical, (ir) => {
    const first = inspect(ir, ir.nodes[fragments[0]!.id]!);
    const second = inspect(ir, ir.nodes[fragments[1]!.id]!);
    const secondCameraSlot = second.stack.children.find((slotId) =>
      ir.nodes[ir.nodes[slotId]!.children[0]!]!.id === second.camera.id)!;
    first.stack.children.push(secondCameraSlot);
  }, "CUT_IR_IDENTITY", /\.named\.owner\.id$/u);
});

test("strict loading rejects Callout and LocalSpace descendant transplants across otherwise valid invocations", () => {
  const canonical = compile(entry(`AnnotatedShot(still);\n    AnnotatedShot(still);`));
  const fragments = Object.values(canonical.nodes).filter((node) => node.op === "cut.kernel.fragment");
  assert.equal(fragments.length, 2);
  const descendants = (ir: CutAVIR, fragmentId: string) => {
    const fragment = ir.nodes[fragmentId]!;
    const layer = fragment.children.map((id) => ir.nodes[id]!).find((node) => node.op === "cut.visual.callout_layer")!;
    const callout = ir.nodes[layer.children[0]!]!;
    const localSpace = ir.nodes[callout.children[0]!]!;
    return { layer, callout, localSpace };
  };
  mutateAndLoad(canonical, (ir) => {
    const first = descendants(ir, fragments[0]!.id), second = descendants(ir, fragments[1]!.id);
    [first.layer.children[0], second.layer.children[0]] = [second.callout.id, first.callout.id];
  }, "CUT_RESPONSIVE_STACK_GRAPH", /\.children\[0\]$/u);
  mutateAndLoad(canonical, (ir) => {
    const first = descendants(ir, fragments[0]!.id), second = descendants(ir, fragments[1]!.id);
    [first.callout.children[0], second.callout.children[0]] = [second.localSpace.id, first.localSpace.id];
  }, "CUT_RESPONSIVE_STACK_GRAPH", /\.children\[0\]$/u);
});

test("imported annotated components authenticate definition and invocation modules separately", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-responsive-annotated-module-"));
  await mkdir(resolve(root, "lib"));
  const reusable = `cut 0.4;
${visualImports}
${component()}
export AnnotatedShot = AnnotatedShot;
`;
  const source = `cut 0.4;
project "Imported responsive annotated identity fragment";
import { AnnotatedShot } from "./lib/shot.cut";
asset still: ImageAsset = image("media/still.png");
timeline main(duration: 1s, fps: 24, width: 640px, height: 360px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    AnnotatedShot(still);
  }
}
export out = render(main);`;
  await writeFile(resolve(root, "main.cut"), source);
  await writeFile(resolve(root, "lib/shot.cut"), reusable);
  const parsedModule = parse(source);
  const loaded = await loadCutUserModuleGraph(resolve(root, "main.cut"), parsedModule);
  assert.deepEqual(loaded.diagnostics, []);
  assert.ok(loaded.graph);
  const checked = checkCutModule(parsedModule, { userModules: loaded.graph.contracts, moduleKind: "entry" });
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  const ir = compileCutModule(parsedModule, {}, undefined, loaded.graph).ir;
  const fragment = soleNode(ir, "cut.kernel.fragment");
  assert.equal(fragment.provenance.module, "project.cut");
  assert.equal(fragment.provenance.expandedFrom?.[0].module, "./lib/shot.cut");
  assert.equal(fragment.provenance.expandedFrom?.[1].module, "project.cut");
  assert.equal(loadCutAvIr(JSON.stringify(ir)).format, "cut-av-ir");
});

test("a non-annotated component still cannot hide CalloutLayer", () => {
  const ordinary = `component Ordinary(still: ImageAsset) -> Visual {
  CalloutLayer() {
    Callout(
      anchor: visualAnchor(owner: still, local: { x: 0px, y: 0px }),
      placements: ["right"],
      offset: 8px,
      safeArea: 8px,
      leader: "straight",
      leaderColor: #ffffff,
      leaderWidth: 2px
    ) {
      LocalSpace(width: 40px, height: 20px, origin: { x: 0px, y: 0px }) {
        Rect(width: 40px, height: 20px, fill: #ffffff);
      }
    }
  }
}`;
  const found = errors(entry("Ordinary(still);", ordinary));
  assert.ok(found.some((item) => item.code === "CUT_CALLOUT_GRAPH"));
});
