import assert from "node:assert/strict";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { IRCallValue, IRNode, IRValue } from "../lib/language/ir";
import { CutAvIrValidationError, loadCutAvIr } from "../lib/language/ir-loader";
import { referenceKernelSchema } from "../lib/language/kernel-registry";
import { builtinPackages } from "../lib/language/packages";
import { parseCutLanguage } from "../lib/language/parser";
import { cutSignalContentHash, finalizeGraphHashes } from "../lib/runtime/graph";

const source = `cut 0.4;
project "generic visual callout language proof";
import { CalloutLayer, Callout, LocalSpace, Rect, visualAnchor } from "cut:visual";
import { linear } from "@cut/motion";

timeline main(duration: 1s, fps: 24, width: 320px, height: 180px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    LocalSpace(width: 100px, height: 80px, origin: { x: 50px, y: 40px }) as evidence {
      Rect(width: 100px, height: 80px, fill: #243040);
    }
    CalloutLayer() {
      Callout(
        anchor: visualAnchor(owner: evidence, local: { x: 0px, y: 0px }),
        placements: ["right", "left", "above"],
        offset: 12px,
        safeArea: 0px,
        priority: 10,
        leader: "elbow",
        leaderColor: #ffcc33,
        leaderWidth: 2px
      ) as label {
        LocalSpace(width: 80px, height: 32px, origin: { x: 40px, y: 16px }) {
          Rect(width: 80px, height: 32px, fill: #ffffff);
        }
      }
      animate label.opacity from 100% to 40% over 1s ease linear;
    }
  }
}
export out = render(main);`;

function parsed(program = source) {
  const result = parseCutLanguage(program);
  assert.ok(result.module, JSON.stringify(result.diagnostics));
  assert.deepEqual(
    result.diagnostics.filter((item) => item.severity === "error"),
    [],
    JSON.stringify(result.diagnostics),
  );
  return result.module;
}

function diagnostics(program: string) {
  return checkCutModule(parsed(program)).diagnostics.filter((item) => item.severity === "error");
}

function compile(program = source) {
  const parsedModule = parsed(program), checked = checkCutModule(parsedModule);
  assert.deepEqual(
    checked.diagnostics.filter((item) => item.severity === "error"),
    [],
    JSON.stringify(checked.diagnostics),
  );
  return compileCutModule(parsedModule).ir;
}

function fixture() {
  const ir = compile();
  const layer = Object.values(ir.nodes).find((node) => node.op === "cut.visual.callout_layer");
  const callout = Object.values(ir.nodes).find((node) => node.op === "cut.visual.callout");
  const evidence = Object.values(ir.nodes).find((node) =>
    node.op === "cut.visual.local_space" && node.ownership === "root");
  assert.ok(layer);
  assert.ok(callout);
  assert.ok(evidence);
  const localSpace = ir.nodes[callout.children[0]!];
  assert.ok(localSpace);
  const evidenceRect = ir.nodes[evidence.children[0]!];
  assert.ok(evidenceRect);
  return { ir, layer, callout, localSpace, evidence, evidenceRect };
}

function anchor(callout: IRNode) {
  const value = callout.inputs.anchor;
  assert.ok(value && value.kind === "call");
  return value as IRCallValue;
}

function quantity(
  dimension: "length" | "ratio" | "scalar",
  numerator: number,
  denominator = 1,
): IRValue {
  return {
    kind: "quantity",
    dimension,
    unit: dimension === "length" ? "px" : dimension,
    magnitude: { numerator: String(numerator), denominator: String(denominator) },
  };
}

function expectLoadDiagnostic(
  name: string,
  mutate: (value: ReturnType<typeof fixture>) => void,
  code: CutAvIrValidationError["code"],
  path: RegExp,
) {
  const value = fixture();
  mutate(value);
  finalizeGraphHashes(value.ir);
  assert.throws(() => loadCutAvIr(JSON.stringify(value.ir)), (error: unknown) => {
    assert.ok(error instanceof CutAvIrValidationError, `${name}: ${String(error)}`);
    assert.equal(error.code, code, name);
    assert.match(error.path, path, name);
    return true;
  });
}

test("cut:visual exposes the closed CalloutLayer and Callout executable signatures", () => {
  const visual = builtinPackages.get("cut:visual");
  assert.ok(visual);
  assert.deepEqual(visual.symbols.CalloutLayer?.parameters ?? [], []);
  assert.equal(visual.symbols.CalloutLayer?.native, "cut.visual.callout_layer");
  assert.deepEqual(visual.symbols.Callout?.parameters?.map((parameter) => [
    parameter.name,
    parameter.type,
    Boolean(parameter.optional),
  ]), [
    ["anchor", "SpatialPoint", false],
    ["placements", "List<String>", false],
    ["offset", "Length", false],
    ["safeArea", "Length", false],
    ["priority", "Number", true],
    ["leader", "String", false],
    ["leaderColor", "Color", true],
    ["leaderWidth", "Length", true],
    ["opacity", "Ratio", true],
  ]);
  const layer = referenceKernelSchema("cut.visual.callout_layer");
  const callout = referenceKernelSchema("cut.visual.callout");
  assert.ok(layer?.support === "supported");
  assert.ok(callout?.support === "supported");
  assert.deepEqual([layer.minimumChildren, layer.maximumChildren, layer.properties], [1, 64, []]);
  assert.deepEqual([callout.minimumChildren, callout.maximumChildren, callout.properties], [1, 1, ["opacity"]]);
});

test("public Callout source lowers through ordinary typed IR and strict loading", () => {
  const { ir, layer, callout, localSpace, evidence } = fixture();
  assert.equal(layer.ownership, "root");
  assert.deepEqual(layer.children, [callout.id]);
  assert.deepEqual(layer.effects, ["pure"]);
  assert.equal(layer.editorial, undefined);
  assert.equal(callout.ownership, "child");
  assert.deepEqual(callout.children, [localSpace.id]);
  assert.deepEqual(callout.effects, ["pure"]);
  assert.equal(callout.editorial, undefined);
  assert.equal(localSpace.op, "cut.visual.local_space");
  assert.deepEqual(callout.inputs.safeArea, quantity("length", 0));
  const spatial = anchor(callout);
  assert.equal(spatial.op, "cut.visual.visual_anchor.v1");
  assert.deepEqual(spatial.named.owner, { kind: "node-ref", id: evidence.id });
  assert.deepEqual(Object.keys(callout.properties), ["opacity"]);
  const property = callout.properties.opacity;
  assert.ok(property && "signal" in property);
  const signal = ir.signals[property.signal];
  assert.ok(signal && signal.kind === "track");
  assert.deepEqual(signal.initial, quantity("ratio", 1));
  assert.equal(loadCutAvIr(JSON.stringify(ir)).buildId, ir.buildId);
});

test("Callout also accepts the existing static Vec2 SpatialPoint form without hidden anchor inference", () => {
  const ir = compile(source.replace(
    "visualAnchor(owner: evidence, local: { x: 0px, y: 0px })",
    "{ x: 160px, y: 90px }",
  ));
  const callout = Object.values(ir.nodes).find((node) => node.op === "cut.visual.callout");
  assert.ok(callout);
  assert.deepEqual(callout.inputs.anchor, {
    kind: "object",
    entries: {
      x: quantity("length", 160),
      y: quantity("length", 90),
    },
  });
  assert.doesNotThrow(() => loadCutAvIr(JSON.stringify(ir)));
});

test("checker closes Callout scene scope, direct topology and lexical automation", () => {
  const cases: Array<{ name: string; program: string; code: string }> = [
    {
      name: "Callout outside layer",
      program: source.replace("    CalloutLayer() {", "    Group() {\n").replace(
        'import { CalloutLayer, Callout, LocalSpace, Rect, visualAnchor }',
        'import { CalloutLayer, Callout, Group, LocalSpace, Rect, visualAnchor }',
      ),
      code: "CUT_CALLOUT_GRAPH",
    },
    {
      name: "nested layer",
      program: source.replace(
        "    CalloutLayer() {",
        "    Group() {\n      CalloutLayer() {",
      ).replace(
        "      animate label.opacity from 100% to 40% over 1s ease linear;\n    }",
        "      animate label.opacity from 100% to 40% over 1s ease linear;\n      }\n    }",
      ).replace(
        'import { CalloutLayer, Callout, LocalSpace, Rect, visualAnchor }',
        'import { CalloutLayer, Callout, Group, LocalSpace, Rect, visualAnchor }',
      ),
      code: "CUT_CALLOUT_GRAPH",
    },
    {
      name: "ordinary child",
      program: source.replace("      Callout(", "      Rect(width: 10px, height: 10px, fill: #ffffff);\n      Callout("),
      code: "CUT_CALLOUT_GRAPH",
    },
    {
      name: "wrong callout viewport",
      program: source.replace(
        "        LocalSpace(width: 80px, height: 32px, origin: { x: 40px, y: 16px }) {",
        "        Rect(width: 80px, height: 32px, fill: #ffffff) {",
      ),
      code: "CUT_CALLOUT_GRAPH",
    },
    {
      name: "set forbidden",
      program: source.replace(
        "      animate label.opacity from 100% to 40% over 1s ease linear;",
        "      set label.opacity = 40%;",
      ),
      code: "CUT_CALLOUT_GRAPH",
    },
    {
      name: "non-opacity automation",
      program: source.replace("animate label.opacity", "animate label.x"),
      code: "CUT_CALLOUT_GRAPH",
    },
    {
      name: "empty layer",
      program: source.replace(
        /      Callout\([\s\S]*?      animate label\.opacity from 100% to 40% over 1s ease linear;\n/u,
        "",
      ),
      code: "CUT_CALLOUT_LIMIT",
    },
  ];
  for (const item of cases) {
    const errors = diagnostics(item.program);
    assert.ok(errors.some((error) => error.code === item.code), `${item.name}: ${JSON.stringify(errors)}`);
  }
});

test("checker rejects invalid, redundant and inert Callout values with stable diagnostics", () => {
  const cases: Array<{ name: string; from: string; to: string; code: string }> = [
    { name: "duplicate placement", from: 'placements: ["right", "left", "above"]', to: 'placements: ["right", "right"]', code: "CUT_CALLOUT_NOOP" },
    { name: "invalid placement", from: 'placements: ["right", "left", "above"]', to: 'placements: ["diagonal"]', code: "CUT_CALLOUT_TYPE" },
    { name: "zero offset", from: "offset: 12px", to: "offset: 0px", code: "CUT_CALLOUT_TYPE" },
    { name: "negative safe area", from: "safeArea: 0px", to: "safeArea: -1px", code: "CUT_CALLOUT_TYPE" },
    { name: "zero priority", from: "priority: 10", to: "priority: 0", code: "CUT_CALLOUT_NOOP" },
    { name: "fractional priority", from: "priority: 10", to: "priority: 1.5", code: "CUT_CALLOUT_TYPE" },
    { name: "priority limit", from: "priority: 10", to: "priority: 1000001", code: "CUT_CALLOUT_LIMIT" },
    {
      name: "leader style missing",
      from: "leaderColor: #ffcc33,\n        leaderWidth: 2px",
      to: "leaderColor: #ffcc33",
      code: "CUT_CALLOUT_STYLE",
    },
    {
      name: "inert none style",
      from: 'leader: "elbow"',
      to: 'leader: "none"',
      code: "CUT_CALLOUT_NOOP",
    },
    {
      name: "transparent leader",
      from: "leaderColor: #ffcc33",
      to: "leaderColor: #ffcc3300",
      code: "CUT_CALLOUT_NOOP",
    },
    {
      name: "unknown argument",
      from: "safeArea: 0px,",
      to: "safeArea: 0px,\n        ignored: 1,",
      code: "CUT_CALLOUT_TYPE",
    },
  ];
  for (const item of cases) {
    const errors = diagnostics(source.replace(item.from, item.to));
    assert.ok(errors.some((error) => error.code === item.code), `${item.name}: ${JSON.stringify(errors)}`);
  }
});

test("checker distinguishes executing opacity animation from static hidden/default no-ops", () => {
  for (const opacity of ["0%", "100%"]) {
    const program = source
      .replace("leaderWidth: 2px", `leaderWidth: 2px,\n        opacity: ${opacity}`)
      .replace("      animate label.opacity from 100% to 40% over 1s ease linear;\n", "");
    const errors = diagnostics(program);
    assert.ok(
      errors.some((error) => error.code === "CUT_CALLOUT_NOOP"),
      `${opacity}: ${JSON.stringify(errors)}`,
    );
  }
  const animated = source.replace(
    "leaderWidth: 2px",
    "leaderWidth: 2px,\n        opacity: 100%",
  );
  assert.deepEqual(diagnostics(animated), []);
  const ir = compile(animated);
  assert.doesNotThrow(() => loadCutAvIr(JSON.stringify(ir)));
});

test("strict loader closes Callout values, graph ownership and retained viewport", () => {
  expectLoadDiagnostic(
    "unknown input",
    ({ callout }) => { callout.inputs.ignored = quantity("scalar", 1); },
    "CUT_CALLOUT_TYPE",
    /\.inputs\.ignored$/u,
  );
  expectLoadDiagnostic(
    "forged layer capability",
    ({ layer }) => { layer.effects = ["pure", "read"]; },
    "CUT_CALLOUT_GRAPH",
    /\.effects$/u,
  );
  expectLoadDiagnostic(
    "forged editorial payload",
    ({ callout, localSpace }) => {
      callout.editorial = {
        kind: "picture-track",
        items: [{
          nodeId: localSpace.id,
          order: 0,
          kind: "gap",
          destination: {
            start: { numerator: "0", denominator: "1" },
            duration: { numerator: "1", denominator: "1" },
          },
        }],
      };
    },
    "CUT_CALLOUT_GRAPH",
    /\.editorial$/u,
  );
  expectLoadDiagnostic(
    "empty layer",
    ({ layer }) => { layer.children = []; },
    "CUT_CALLOUT_LIMIT",
    /\.children$/u,
  );
  expectLoadDiagnostic(
    "layer loses root ownership",
    ({ layer }) => { layer.ownership = "child"; },
    "CUT_CALLOUT_GRAPH",
    /\.ownership$/u,
  );
  expectLoadDiagnostic(
    "ordinary direct layer child",
    ({ layer, evidence }) => { layer.children = [evidence.id]; },
    "CUT_CALLOUT_GRAPH",
    /\.children\[0\]$/u,
  );
  expectLoadDiagnostic(
    "Callout loses LocalSpace",
    ({ callout, evidenceRect }) => { callout.children = [evidenceRect.id]; },
    "CUT_CALLOUT_VIEWPORT",
    /\.children\[0\]$/u,
  );
  expectLoadDiagnostic(
    "duplicate placement",
    ({ callout }) => {
      callout.inputs.placements = {
        kind: "array",
        items: [{ kind: "string", value: "right" }, { kind: "string", value: "right" }],
      };
    },
    "CUT_CALLOUT_NOOP",
    /\.inputs\.placements\.items\[1\]\.value$/u,
  );
  expectLoadDiagnostic(
    "negative safe area",
    ({ callout }) => { callout.inputs.safeArea = quantity("length", -1); },
    "CUT_CALLOUT_TYPE",
    /\.inputs\.safeArea$/u,
  );
  expectLoadDiagnostic(
    "zero priority",
    ({ callout }) => { callout.inputs.priority = quantity("scalar", 0); },
    "CUT_CALLOUT_NOOP",
    /\.inputs\.priority$/u,
  );
  expectLoadDiagnostic(
    "none retains style",
    ({ callout }) => { callout.inputs.leader = { kind: "string", value: "none" }; },
    "CUT_CALLOUT_NOOP",
    /\.inputs$/u,
  );
});

test("strict loader reuses the exact SpatialPoint wire and rejects anchor forgery", () => {
  expectLoadDiagnostic(
    "forged spatial op",
    ({ callout }) => { anchor(callout).op = "cut.visual.fake_anchor.v1"; },
    "CUT_CALLOUT_TYPE",
    /\.inputs\.anchor(?:\.op)?$/u,
  );
  expectLoadDiagnostic(
    "unretained owner",
    ({ callout, evidenceRect }) => {
      const owner = anchor(callout).named.owner;
      assert.ok(owner && owner.kind === "node-ref");
      owner.id = evidenceRect.id;
    },
    "CUT_CALLOUT_ANCHOR",
    /\.inputs\.anchor\.named\.owner\.id$/u,
  );
  expectLoadDiagnostic(
    "owner is no longer a direct root",
    ({ evidence }) => { evidence.ownership = "child"; },
    "CUT_CALLOUT_ANCHOR",
    /\.inputs\.anchor\.named\.owner\.id$/u,
  );
  expectLoadDiagnostic(
    "owner is later in scene item order",
    ({ ir, layer, evidence }) => {
      const scene = ir.scenes[layer.sceneId!];
      const ownerIndex = scene.items.findIndex((item) => item.id === evidence.id);
      const layerIndex = scene.items.findIndex((item) => item.id === layer.id);
      assert.ok(ownerIndex >= 0 && layerIndex >= 0 && ownerIndex < layerIndex);
      const ownerItem = scene.items[ownerIndex]!, layerItem = scene.items[layerIndex]!;
      scene.items[ownerIndex] = layerItem;
      scene.items[layerIndex] = ownerItem;
      scene.rootVisualIds = scene.items
        .filter((item) => item.domain === "visual")
        .map((item) => item.id);
    },
    "CUT_CALLOUT_ANCHOR",
    /\.inputs\.anchor\.named\.owner\.id$/u,
  );
  expectLoadDiagnostic(
    "owner-local point outside retained view",
    ({ callout }) => {
      const local = anchor(callout).named.local;
      assert.ok(local && local.kind === "object");
      local.entries.x = quantity("length", 51);
    },
    "CUT_CALLOUT_ANCHOR",
    /\.inputs\.anchor\.named\.owner\.id$/u,
  );
});

test("strict loader rejects static default/hidden opacity and inert effective property states", () => {
  for (const value of [0, 1]) {
    expectLoadDiagnostic(
      `static opacity ${value}`,
      ({ ir, callout }) => {
        const property = callout.properties.opacity;
        assert.ok(property && "signal" in property);
        delete ir.signals[property.signal];
        delete callout.properties.opacity;
        callout.inputs.opacity = quantity("ratio", value);
      },
      "CUT_CALLOUT_NOOP",
      /\.inputs\.opacity$/u,
    );
  }

  for (const value of [0, 1]) {
    expectLoadDiagnostic(
      `static opacity property ${value}`,
      ({ ir, callout }) => {
        const property = callout.properties.opacity;
        assert.ok(property && "signal" in property);
        delete ir.signals[property.signal];
        callout.properties.opacity = quantity("ratio", value);
      },
      "CUT_CALLOUT_NOOP",
      /\.properties\.opacity$/u,
    );
  }

  expectLoadDiagnostic(
    "null static property substitutes the default 100% baseline",
    ({ ir, callout }) => {
      const property = callout.properties.opacity;
      assert.ok(property && "signal" in property);
      delete ir.signals[property.signal];
      callout.properties.opacity = { kind: "null" };
    },
    "CUT_CALLOUT_NOOP",
    /\.properties\.opacity$/u,
  );
  expectLoadDiagnostic(
    "null track states substitute the authored 0% baseline",
    ({ ir, callout }) => {
      callout.inputs.opacity = quantity("ratio", 0);
      const property = callout.properties.opacity;
      assert.ok(property && "signal" in property);
      const signal = ir.signals[property.signal];
      assert.ok(signal && signal.kind === "track");
      signal.initial = { kind: "null" };
      signal.events = signal.events.map((event) => event.kind === "set"
        ? { ...event, value: { kind: "null" } }
        : { ...event, from: { kind: "null" }, to: { kind: "null" } });
      signal.contentHash = cutSignalContentHash(signal);
    },
    "CUT_CALLOUT_NOOP",
    /\.properties\.opacity$/u,
  );
  for (const value of [0, 1]) {
    expectLoadDiagnostic(
      `all-${value} opacity signal`,
      ({ ir, callout }) => {
        callout.inputs.opacity = quantity("ratio", value);
        const property = callout.properties.opacity;
        assert.ok(property && "signal" in property);
        const signal = ir.signals[property.signal];
        assert.ok(signal && signal.kind === "track");
        signal.initial = quantity("ratio", value);
        signal.events = signal.events.map((event) => event.kind === "set"
          ? { ...event, value: quantity("ratio", value) }
          : {
            ...event,
            from: quantity("ratio", value),
            to: quantity("ratio", value),
          });
        signal.contentHash = cutSignalContentHash(signal);
      },
      "CUT_CALLOUT_NOOP",
      /\.properties\.opacity$/u,
    );
  }

  // A real change remains admissible even when the constructor starts hidden.
  const { ir, callout } = fixture();
  callout.inputs.opacity = quantity("ratio", 0);
  const property = callout.properties.opacity;
  assert.ok(property && "signal" in property);
  const signal = ir.signals[property.signal];
  assert.ok(signal && signal.kind === "track");
  signal.initial = quantity("ratio", 0);
  signal.contentHash = cutSignalContentHash(signal);
  finalizeGraphHashes(ir);
  assert.doesNotThrow(() => loadCutAvIr(JSON.stringify(ir)));
});
