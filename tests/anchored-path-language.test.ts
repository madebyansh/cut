import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv from "ajv";
import { stableJsonStringify } from "../lib/core/stable";
import { cutAnchoredSpatialOps } from "../lib/language/anchored-path-contract";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR, IRCallValue, IRNode, IRValue } from "../lib/language/ir";
import { CutAvIrValidationError, loadCutAvIr } from "../lib/language/ir-loader";
import { parseCutLanguage } from "../lib/language/parser";
import { builtinPackageImplementationFiles, builtinPackages, type PackageSymbol } from "../lib/language/packages";
import { assertResolvedCutIr, CutIrResolutionError } from "../lib/language/resolution";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { createIncrementalRenderPlan, finalizeGraphHashes } from "../lib/runtime/graph";
import { validateReferenceSession } from "../lib/runtime/reference/validate";

function parse(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics.filter((item) => item.severity === "error"), [], JSON.stringify(parsed.diagnostics));
  return parsed.module;
}

function compile(source: string) {
  const cutModule = parse(source), checked = checkCutModule(cutModule);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), [], JSON.stringify(checked.diagnostics));
  return compileCutModule(cutModule).ir;
}

function expectCompileDiagnostic(source: string, code: string) {
  const cutModule = parse(source), checked = checkCutModule(cutModule);
  const checkedDiagnostic = checked.diagnostics.find((item) => item.severity === "error" && item.code === code);
  if (checkedDiagnostic) return checkedDiagnostic;
  assert.throws(() => compileCutModule(cutModule), (error: unknown) => {
    assert.ok(error instanceof CutCompileError, String(error));
    const diagnostic = error.result.diagnostics.find((item) => item.severity === "error" && item.code === code);
    assert.ok(diagnostic, JSON.stringify(error.result.diagnostics));
    assert.ok(diagnostic.span.start.line >= 1 && diagnostic.span.start.column >= 1, "diagnostic must retain a public source location");
    return true;
  });
  return undefined;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function anchoredSource() {
  return `cut 0.4;
project "anchored path language proof";
import { LocalSpace, Rect, Circle, Path, MotionPath, visualAnchor, compositionOffset, anchoredLineTo, anchoredCubicTo, anchoredPath } from "cut:visual";

component Plate() -> Visual {
  LocalSpace(width: 100px, height: 80px, origin: { x: 50px, y: 40px }) {
    Rect(width: 20px, height: 20px, fill: #ffffff);
  }
}

timeline main(duration: 1s, fps: 24, width: 200px, height: 100px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Plate() as plate;
    Path(geometry: anchoredPath(
      start: visualAnchor(owner: plate, local: { x: 0px, y: 0px }),
      segments: [
        anchoredCubicTo(
          control1: { x: 20px, y: 0px },
          control2: compositionOffset(point: visualAnchor(owner: plate, local: { x: 10px, y: 0px }), by: { x: 20px, y: 5px }),
          to: { x: 100px, y: 50px }
        ),
        anchoredLineTo(to: compositionOffset(point: visualAnchor(owner: plate, local: { x: 0px, y: 10px }), by: { x: 5px, y: -5px }))
      ],
      closed: false
    ), stroke: #ffffff, width: 2px);
    Path(
      geometry: anchoredPath(visualAnchor(plate, { x: 0px, y: 0px }), [anchoredLineTo({ x: 120px, y: 40px })], false),
      stroke: #00ff00,
      width: 1px
    );
    MotionPath(
      geometry: anchoredPath(
        start: visualAnchor(owner: plate, local: { x: 0px, y: 0px }),
        segments: [anchoredLineTo(to: { x: 120px, y: 40px })],
        closed: false
      ),
      progress: 50%
    ) { Circle(radius: 3px, fill: #ff0000); }
  }
}
export out = render(main);`;
}

function anchoredGeometry(node: IRNode): IRCallValue {
  const geometry = node.inputs.geometry;
  assert.ok(geometry && geometry.kind === "call");
  assert.equal(geometry.op, cutAnchoredSpatialOps.anchoredPath);
  return geometry;
}

function anchoredNodes(ir: CutAVIR) {
  const paths = Object.values(ir.nodes).filter((node) => node.op === "cut.visual.path");
  const motion = Object.values(ir.nodes).find((node) => node.op === "cut.visual.motion_path");
  assert.equal(paths.length, 2);
  assert.ok(motion);
  return { paths, motion };
}

test("cut:visual exposes one closed, versioned anchored spatial language slice", () => {
  const visual = builtinPackages.get("cut:visual");
  assert.ok(visual);
  for (const [name, returns, parameters] of [
    ["visualAnchor", "VisualAnchor", ["owner", "local"]],
    ["compositionOffset", "SpatialPoint", ["point", "by"]],
    ["anchoredLineTo", "AnchoredLinePathSegment", ["to"]],
    ["anchoredCubicTo", "AnchoredCubicPathSegment", ["control1", "control2", "to"]],
    ["anchoredPath", "AnchoredPathGeometry", ["start", "segments", "closed"]],
  ] as const) {
    const packageSymbol: PackageSymbol | undefined = visual.symbols[name];
    assert.equal(packageSymbol?.kind, "function");
    assert.equal(packageSymbol?.lowering, "anchored-spatial-call");
    assert.equal(packageSymbol?.returns, returns);
    assert.deepEqual(packageSymbol?.parameters?.map((parameter) => parameter.name), parameters);
  }
  assert.equal(visual.symbols.Path.parameters?.find((item) => item.name === "geometry")?.type, "PathGeometry");
  assert.equal(visual.symbols.MotionPath.parameters?.find((item) => item.name === "geometry")?.type, "PathGeometry");
  assert.equal(visual.symbols.Path.parameters?.find((item) => item.name === "morphTo")?.type, "VectorPathGeometry");
  assert.ok(builtinPackageImplementationFiles("cut:visual").includes("language/anchored-path-contract"));
});

test("public named and positional source lower to the same exact owner-bound IR wire and survive strict loading", () => {
  const ir = compile(anchoredSource()), { paths, motion } = anchoredNodes(ir);
  const complex = anchoredGeometry(paths[0]), positional = anchoredGeometry(paths[1]), named = anchoredGeometry(motion);
  assert.deepEqual(positional, named, "positional and named authoring must canonicalize to one persisted value");
  assert.deepEqual(Object.keys(complex).sort(), ["effect", "kind", "named", "op", "positional"]);
  assert.deepEqual(complex.positional, []);
  assert.equal(complex.effect, "pure");
  assert.deepEqual(Object.keys(complex.named), ["start", "segments", "closed"]);
  const start = complex.named.start;
  assert.equal(start.kind, "call");
  if (start.kind !== "call") assert.fail("expected visualAnchor call");
  assert.equal(start.op, cutAnchoredSpatialOps.visualAnchor);
  assert.equal(start.named.owner?.kind, "node-ref");
  const segments = complex.named.segments;
  assert.equal(segments.kind, "array");
  if (segments.kind !== "array") assert.fail("expected anchored segment array");
  assert.deepEqual(segments.items.map((item) => item.kind === "call" ? item.op : item.kind), [
    cutAnchoredSpatialOps.anchoredCubicTo,
    cutAnchoredSpatialOps.anchoredLineTo,
  ]);
  assert.doesNotThrow(() => assertResolvedCutIr(ir));
  assert.equal(loadCutAvIr(JSON.stringify(ir)).buildId, ir.buildId);
  assert.equal(validateReferenceSession(ir).composition.id, "main", "public anchored source must pass the complete runtime semantic validator");
});

test("the existing vectorPath lowering remains the exact untagged record wire", () => {
  const ir = compile(`cut 0.4;
project "vector identity regression";
import { Path, lineTo, cubicTo, vectorPath } from "cut:visual";
timeline main(duration: 1s, fps: 24, width: 200px, height: 100px) {
  scene only(duration: 1s) {
    Path(geometry: vectorPath(
      start: { x: 1px, y: 2px },
      segments: [lineTo(to: { x: 3px, y: 4px }), cubicTo(control1: { x: 5px, y: 6px }, control2: { x: 7px, y: 8px }, to: { x: 9px, y: 10px })],
      closed: false
    ), stroke: #ffffff, width: 2px);
  }
}
export out = render(main);`);
  const node = Object.values(ir.nodes).find((item) => item.op === "cut.visual.path");
  assert.ok(node);
  const geometry = node.inputs.geometry;
  assert.equal(geometry?.kind, "object");
  assert.doesNotMatch(stableJsonStringify(geometry), /anchored|"op"|"version"/u);
  assert.equal(geometry && geometry.kind === "object" && geometry.entries.segments.kind === "array"
    ? geometry.entries.segments.items.length
    : 0, 2);
  assert.equal(loadCutAvIr(JSON.stringify(ir)).buildId, ir.buildId);
});

test("the checker closes SpatialPoint/PathGeometry types and rejects anchored morphing", () => {
  const wrongOwner = anchoredSource().replace("visualAnchor(owner: plate, local: { x: 0px, y: 0px })", "visualAnchor(owner: { x: 0px, y: 0px }, local: { x: 0px, y: 0px })");
  const diagnostic = expectCompileDiagnostic(wrongOwner, "CUT2029");
  assert.ok(diagnostic?.span.start.line);

  expectCompileDiagnostic(
    anchoredSource().replace("anchoredLineTo(to: { x: 120px, y: 40px })", "anchoredLineTo(to: { x: 120px, y: 40px, ignored: 1px })"),
    "CUT2029",
  );
  expectCompileDiagnostic(
    anchoredSource().replace(
      "stroke: #ffffff, width: 2px);",
      "morphTo: vectorPath(start: { x: 0px, y: 0px }, segments: [lineTo(to: { x: 10px, y: 0px })], closed: false), morph: 50%, stroke: #ffffff, width: 2px);",
    ).replace(
      "anchoredPath } from \"cut:visual\"",
      "anchoredPath, vectorPath, lineTo } from \"cut:visual\"",
    ),
    "CUT_ANCHORED_PATH_MORPH",
  );
});

test("compiler diagnostics reject static anchor lookalikes, no-op geometry, and bounded offset overflow", () => {
  const staticOnly = anchoredSource().replace(
    "start: visualAnchor(owner: plate, local: { x: 0px, y: 0px }),",
    "start: { x: 0px, y: 0px },",
  ).replaceAll("visualAnchor(owner: plate, local: { x: 10px, y: 0px })", "{ x: 10px, y: 0px }")
    .replaceAll("visualAnchor(owner: plate, local: { x: 0px, y: 10px })", "{ x: 0px, y: 10px }");
  expectCompileDiagnostic(staticOnly, "CUT_ANCHORED_PATH_OWNER");

  expectCompileDiagnostic(
    anchoredSource().replace("by: { x: 20px, y: 5px }", "by: { x: 0px, y: 0px }"),
    "CUT_ANCHORED_PATH_NOOP",
  );
  expectCompileDiagnostic(
    anchoredSource().replace(
      "compositionOffset(point: visualAnchor(owner: plate, local: { x: 10px, y: 0px }), by: { x: 20px, y: 5px })",
      "compositionOffset(point: compositionOffset(point: visualAnchor(owner: plate, local: { x: 10px, y: 0px }), by: { x: 10px, y: 0px }), by: { x: -10px, y: 0px })",
    ),
    "CUT_ANCHORED_PATH_NOOP",
  );
  expectCompileDiagnostic(
    anchoredSource().replace(
      "compositionOffset(point: visualAnchor(owner: plate, local: { x: 10px, y: 0px }), by: { x: 20px, y: 5px })",
      "compositionOffset(point: compositionOffset(point: visualAnchor(owner: plate, local: { x: 10px, y: 0px }), by: { x: 65536px, y: 0px }), by: { x: 1px, y: 0px })",
    ),
    "CUT_ANCHORED_PATH_LIMIT",
  );
});

test("the strict loader rejects unknown versions, hidden fields, bad effects, out-of-view anchors, and anchored morph forgery", () => {
  const canonical = compile(anchoredSource()), path = anchoredNodes(canonical).paths[0];
  const cases: Array<{
    mutate: (geometry: IRCallValue, node: IRNode, ir: CutAVIR) => void;
    code: CutAvIrValidationError["code"];
    path: RegExp;
  }> = [
    {
      mutate: (geometry) => { geometry.op = "cut.visual.anchored_path.v2" as typeof geometry.op; },
      code: "CUT_IR_ENUM",
      path: /\.inputs\.geometry\.op$/u,
    },
    {
      mutate: (geometry) => { (geometry.named as Record<string, IRValue>).hidden = { kind: "boolean", value: true }; },
      code: "CUT_IR_UNKNOWN_FIELD",
      path: /\.inputs\.geometry\.named\.hidden$/u,
    },
    {
      mutate: (geometry) => { geometry.effect = "read"; },
      code: "CUT_IR_TYPE",
      path: /\.inputs\.geometry\.effect$/u,
    },
    {
      mutate: (geometry) => {
        const start = geometry.named.start as IRCallValue;
        const local = start.named.local;
        assert.equal(local.kind, "object");
        if (local.kind === "object") local.entries.x = { kind: "quantity", dimension: "length", magnitude: { numerator: "51", denominator: "1" }, unit: "px" };
      },
      code: "CUT_IR_LIMIT",
      path: /\.named\.owner\.id$/u,
    },
    {
      mutate: (_geometry, node) => {
        node.inputs.morphTo = {
          kind: "object",
          entries: {
            start: { kind: "object", entries: { x: { kind: "quantity", dimension: "length", magnitude: { numerator: "0", denominator: "1" }, unit: "px" }, y: { kind: "quantity", dimension: "length", magnitude: { numerator: "0", denominator: "1" }, unit: "px" } } },
            segments: { kind: "array", items: [{ kind: "object", entries: { to: { kind: "object", entries: { x: { kind: "quantity", dimension: "length", magnitude: { numerator: "10", denominator: "1" }, unit: "px" }, y: { kind: "quantity", dimension: "length", magnitude: { numerator: "0", denominator: "1" }, unit: "px" } } } } }] },
            closed: { kind: "boolean", value: false },
          },
        };
      },
      code: "CUT_ANCHORED_PATH_MORPH",
      path: /\.inputs\.morphTo$/u,
    },
  ];
  for (const item of cases) {
    const hostile = clone(canonical), hostileNode = hostile.nodes[path.id], geometry = anchoredGeometry(hostileNode);
    item.mutate(geometry, hostileNode, hostile);
    finalizeGraphHashes(hostile);
    assert.throws(() => loadCutAvIr(JSON.stringify(hostile)), (error: unknown) => {
      assert.ok(error instanceof CutAvIrValidationError, String(error));
      assert.equal(error.code, item.code);
      assert.match(error.path, item.path);
      return true;
    });
  }
});

test("anchor values participate in resolution, semantic diff, and owner-local cache identity", () => {
  const before = compile(anchoredSource()), { paths } = anchoredNodes(before), path = paths[0];
  const unresolved = clone(before), unresolvedGeometry = anchoredGeometry(unresolved.nodes[path.id]);
  unresolvedGeometry.op = "cut.visual.anchored_path.v2" as typeof unresolvedGeometry.op;
  assert.throws(() => assertResolvedCutIr(unresolved), (error: unknown) => error instanceof CutIrResolutionError && /anchored_path\.v2/u.test(error.message));

  const pointEdit = clone(before), pointGeometry = anchoredGeometry(pointEdit.nodes[path.id]);
  const segments = pointGeometry.named.segments;
  assert.equal(segments.kind, "array");
  if (segments.kind !== "array") assert.fail("expected segments");
  const cubic = segments.items[0];
  assert.equal(cubic.kind, "call");
  if (cubic.kind !== "call") assert.fail("expected cubic");
  const control = cubic.named.control1;
  assert.equal(control.kind, "object");
  if (control.kind !== "object") assert.fail("expected Vec2");
  control.entries.x = { kind: "quantity", dimension: "length", magnitude: { numerator: "21", denominator: "1" }, unit: "px" };
  finalizeGraphHashes(pointEdit);
  const pathChange = diffCutAVIR(before, pointEdit).changes.find((change) => change.entity === "node" && change.id === path.id);
  assert.ok(pathChange && pathChange.operation === "modify");
  assert.ok(pathChange.fields?.some((field) => field.path.includes("geometry")), JSON.stringify(pathChange));

  const ownerEdit = clone(before), owner = Object.values(ownerEdit.nodes).find((node) => node.op === "cut.kernel.fragment");
  assert.ok(owner);
  const localSpace = ownerEdit.nodes[owner.children[0]];
  assert.equal(localSpace?.op, "cut.visual.local_space");
  const circle = Object.values(ownerEdit.nodes).find((node) => node.op === "cut.visual.circle");
  assert.ok(circle);
  const oldPathHash = ownerEdit.nodes[path.id].contentHash, oldCircleHash = circle.contentHash;
  localSpace.inputs.width = { kind: "quantity", dimension: "length", magnitude: { numerator: "120", denominator: "1" }, unit: "px" };
  finalizeGraphHashes(ownerEdit);
  assert.notEqual(ownerEdit.nodes[path.id].contentHash, oldPathHash, "owner LocalSpace basis must invalidate anchored consumers");
  assert.equal(ownerEdit.nodes[circle.id].contentHash, oldCircleHash, "an unrelated leaf must keep its localized cache identity");

  const baselineManifest = createIncrementalRenderPlan(before, before.compositions[0]!.id).manifest;
  const pathNodeId = paths[0]!.id;
  const ownerNodeId = Object.values(before.nodes).find((node) => node.op === "cut.kernel.fragment")!.id;
  const innerNodeId = Object.values(before.nodes).find((node) => node.op === "cut.visual.rect")!.id;
  const locality = (mutate: (ir: CutAVIR) => void) => {
    const changed = clone(before);
    mutate(changed);
    finalizeGraphHashes(changed);
    return createIncrementalRenderPlan(changed, changed.compositions[0]!.id, baselineManifest);
  };
  const innerPixels = locality((ir) => {
    ir.nodes[innerNodeId]!.inputs.fill = { kind: "color", value: "#112233" };
  });
  assert.equal(innerPixels.nodes.find((item) => item.id === pathNodeId)?.status, "hit", "inner owner pixels must not poison anchored geometry cache identity");
  assert.deepEqual(innerPixels.scenes.map((item) => item.status), ["miss"], "the composited scene must still invalidate for changed owner pixels");

  const opacityOnly = locality((ir) => {
    ir.nodes[ownerNodeId]!.properties.opacity = { kind: "quantity", dimension: "ratio", magnitude: { numerator: "1", denominator: "2" }, unit: "ratio" };
  });
  assert.equal(opacityOnly.nodes.find((item) => item.id === pathNodeId)?.status, "hit", "owner opacity does not move an anchor");
  assert.deepEqual(opacityOnly.scenes.map((item) => item.status), ["miss"], "owner opacity still changes composited scene pixels");

  const spatial = locality((ir) => {
    ir.nodes[ownerNodeId]!.properties.x = { kind: "quantity", dimension: "length", magnitude: { numerator: "7", denominator: "1" }, unit: "px" };
  });
  assert.equal(spatial.nodes.find((item) => item.id === pathNodeId)?.status, "miss", "owner spatial transforms must invalidate anchored consumers");
});

test("the public IR schema accepts exact anchored geometry and refuses unknown anchored call versions", async () => {
  const schema = JSON.parse(await readFile("schemas/cut-av-ir-v3.schema.json", "utf8")) as object;
  const validate = new Ajv({ schemaId: "auto", meta: false, validateSchema: false, allErrors: true, jsonPointers: true }).compile(schema);
  const canonical = compile(anchoredSource());
  assert.equal(validate(canonical), true, JSON.stringify(validate.errors));
  const hostile = clone(canonical), node = anchoredNodes(hostile).paths[0], geometry = anchoredGeometry(node);
  geometry.op = "cut.visual.anchored_path" as typeof geometry.op;
  assert.equal(validate(hostile), false);
  assert.ok(validate.errors?.some((error) => error.dataPath.endsWith("/inputs/geometry/op") || error.dataPath.endsWith(".inputs.geometry.op")), JSON.stringify(validate.errors));
});
