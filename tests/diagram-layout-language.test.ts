import assert from "node:assert/strict";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import {
  cutDiagramOps,
  decodeCutDiagramLayout,
  type CutDiagramDiagnosticCode,
} from "../lib/language/diagram-contract";
import type { CutAVIR, IRValue } from "../lib/language/ir";
import { parseCutLanguage } from "../lib/language/parser";
import { builtinPackageImplementationFiles, builtinPackages } from "../lib/language/packages";
import { rational } from "../lib/language/rational";

function parse(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics.filter((item) => item.severity === "error"), [], JSON.stringify(parsed.diagnostics));
  return parsed.module;
}

function compile(source: string) {
  return compileCutModule(parse(source)).ir;
}

function expectDiagnostic(source: string, code: CutDiagramDiagnosticCode) {
  const parsedModule = parse(source), checked = checkCutModule(parsedModule);
  const checkedDiagnostic = checked.diagnostics.find((item) => item.code === code);
  if (checkedDiagnostic) return checkedDiagnostic;
  try { compileCutModule(parsedModule); }
  catch (error) {
    assert.ok(error instanceof CutCompileError, String(error));
    const compiledDiagnostic = error.result.diagnostics.find((item) => item.code === code);
    assert.ok(compiledDiagnostic, JSON.stringify(error.result.diagnostics));
    return compiledDiagnostic;
  }
  assert.fail(`Expected ${code}.`);
}

function valueCalls(value: IRValue): string[] {
  if (value.kind === "call") return [value.op, ...value.positional.flatMap(valueCalls), ...Object.values(value.named).flatMap(valueCalls)];
  if (value.kind === "array") return value.items.flatMap(valueCalls);
  if (value.kind === "object") return Object.values(value.entries).flatMap(valueCalls);
  if (value.kind === "range") return [...valueCalls(value.start), ...valueCalls(value.end)];
  if (value.kind === "unary") return valueCalls(value.value);
  if (value.kind === "binary") return [...valueCalls(value.left), ...valueCalls(value.right)];
  if (value.kind === "member") return valueCalls(value.object);
  if (value.kind === "index") return [...valueCalls(value.object), ...valueCalls(value.index)];
  return [];
}

function program() {
  return `cut 0.4;
project "diagram language proof";
import { DiagramLayout, DiagramNode, diagramEdge, diagramState } from "@cut/diagram";
import { Rect } from "cut:visual";
import { linear } from "@cut/motion";

const source: DiagramState = diagramState(id: "source", nodes: ["claim"], edges: []);
const branch: DiagramState = diagramState(
  id: "branch",
  nodes: ["claim", "proof"],
  edges: [diagramEdge(id: "claim-proof", from: "claim", to: "proof", stroke: #25a18e, width: 3px)]
);

timeline main(duration: 2s, fps: 24, width: 640px, height: 360px) {
  scene diagram(duration: 2s) {
    DiagramLayout(
      state: branch,
      fromState: source,
      progress: 0%,
      direction: "horizontal",
      width: 560px,
      height: 260px,
      nodeGap: 18px,
      rankGap: 72px
    ) as graph {
      DiagramNode(id: "claim", width: 132px, height: 58px, rank: 0) {
        Rect(width: 132px, height: 58px, fill: #243b53);
      }
      DiagramNode(id: "proof", width: 112px, height: 48px, rank: 1) {
        Rect(width: 112px, height: 48px, fill: #f4d35e);
      }
    }
    animate graph.progress from 0% to 100% over 1400ms ease linear;
  }
}
export out = render(main);`;
}

function diagramLayout(ir: CutAVIR) {
  const layout = Object.values(ir.nodes).find((node) => node.op === cutDiagramOps.layout);
  assert.ok(layout);
  return layout;
}

test("@cut/diagram exposes one closed public language package and implementation identity root", () => {
  const package_ = builtinPackages.get("@cut/diagram");
  assert.ok(package_);
  assert.deepEqual(Object.keys(package_.symbols), ["diagramEdge", "diagramState", "DiagramLayout", "DiagramNode"]);
  assert.deepEqual(
    Object.fromEntries(Object.entries(package_.symbols).map(([name, symbol]) => [name, { returns: symbol.returns, lowering: symbol.lowering, native: symbol.native }])),
    {
      diagramEdge: { returns: "DiagramEdge", lowering: "record", native: undefined },
      diagramState: { returns: "DiagramState", lowering: "record", native: undefined },
      DiagramLayout: { returns: "Visual", lowering: undefined, native: cutDiagramOps.layout },
      DiagramNode: { returns: "DiagramNode", lowering: undefined, native: cutDiagramOps.node },
    },
  );
  assert.ok(builtinPackageImplementationFiles("@cut/diagram").includes("language/diagram-contract"));
});

test("public records lower into ordinary typed IR and layout progress remains a Ratio signal", () => {
  const source = program(), parsedModule = parse(source), checked = checkCutModule(parsedModule);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), [], JSON.stringify(checked.diagnostics));
  const ir = compileCutModule(parsedModule).ir, layout = diagramLayout(ir);
  assert.deepEqual(Object.values(ir.nodes).filter((node) => node.op.startsWith("cut.diagram.")).map((node) => node.op), [cutDiagramOps.node, cutDiagramOps.node, cutDiagramOps.layout]);
  assert.equal(layout.inputs.state.kind, "object");
  assert.equal(layout.inputs.fromState?.kind, "object");
  assert.deepEqual(Object.values(layout.inputs).flatMap(valueCalls), [], "record constructors must not survive as hidden calls");
  assert.equal(layout.properties.progress && "signal" in layout.properties.progress, true);
  const progress = layout.properties.progress && "signal" in layout.properties.progress
    ? ir.signals[layout.properties.progress.signal]
    : undefined;
  assert.equal(progress?.valueType, "Ratio");

  const decoded = decodeCutDiagramLayout(ir, layout);
  assert.equal(decoded.direction, "horizontal");
  assert.deepEqual(decoded.width, rational(560));
  assert.deepEqual(decoded.height, rational(260));
  assert.deepEqual(decoded.safeX, rational(0));
  assert.deepEqual(decoded.safeY, rational(0));
  assert.deepEqual(decoded.edgeGap, rational(6));
  assert.deepEqual(decoded.edgeClearance, rational(4));
  assert.deepEqual(decoded.nodes.map((node) => [node.id, node.width, node.height, node.rank]), [
    ["claim", rational(132), rational(58), 0],
    ["proof", rational(112), rational(48), 1],
  ]);
});

test("a DiagramNode-returning component expands transparently to one direct planner-owned node", () => {
  const source = `cut 0.4;
project "reusable diagram node";
import { DiagramLayout, DiagramNode, diagramEdge, diagramState } from "@cut/diagram";
import { Rect } from "cut:visual";

component Card(id: String, rank: Number, color: Color) -> DiagramNode {
  DiagramNode(id: id, width: 96px, height: 48px, rank: rank) {
    Rect(width: 96px, height: 48px, fill: color);
  }
}

const state: DiagramState = diagramState(
  id: "pair",
  nodes: ["question", "answer"],
  edges: [diagramEdge(id: "answer", from: "question", to: "answer", stroke: #222222, width: 2px)]
);

timeline main(duration: 1s, fps: 24, width: 320px, height: 180px) {
  scene only(duration: 1s) {
    DiagramLayout(state: state, width: 280px, height: 140px) {
      Card(id: "question", rank: 0, color: #f4d35e);
      Card(id: "answer", rank: 1, color: #25a18e);
    }
  }
}
export out = render(main);`;
  const parsedModule = parse(source), checked = checkCutModule(parsedModule);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), [], JSON.stringify(checked.diagnostics));
  const ir = compileCutModule(parsedModule).ir, layout = diagramLayout(ir);
  assert.equal(layout.children.length, 2);
  assert.deepEqual(layout.children.map((id) => ir.nodes[id]?.op), [cutDiagramOps.node, cutDiagramOps.node]);
  assert.equal(Object.values(ir.nodes).filter((node) => node.op === "cut.kernel.fragment").length, 0, "the structural component must not insert a private fragment between layout and node");
  assert.deepEqual(decodeCutDiagramLayout(ir, layout).nodes.map((node) => node.id), ["question", "answer"]);
});

test("DiagramNode components refuse ambiguous structure, invocation children, and orphan use", () => {
  const base = `cut 0.4;
project "invalid reusable diagram node";
import { DiagramLayout, DiagramNode, diagramState } from "@cut/diagram";
import { Rect } from "cut:visual";
component Card(id: String) -> DiagramNode {
  DiagramNode(id: id, width: 40px, height: 40px) { Rect(width: 40px, height: 40px); }
}
const state: DiagramState = diagramState(id: "one", nodes: ["one"], edges: []);
timeline main(duration: 1s, fps: 24, width: 160px, height: 90px) {
  scene only(duration: 1s) {
    DiagramLayout(state: state, width: 120px, height: 80px) { Card(id: "one"); }
  }
}
export out = render(main);`;
  expectDiagnostic(base.replace(
    '  DiagramNode(id: id, width: 40px, height: 40px) { Rect(width: 40px, height: 40px); }',
    '  DiagramNode(id: id, width: 40px, height: 40px) { Rect(width: 40px, height: 40px); }\n  DiagramNode(id: "extra", width: 40px, height: 40px) { Rect(width: 40px, height: 40px); }',
  ), "CUT_DIAGRAM_BOUNDS");
  expectDiagnostic(base.replace('Card(id: "one");', 'Card(id: "one") { Rect(width: 10px, height: 10px); }'), "CUT_DIAGRAM_BOUNDS");
  expectDiagnostic(base.replace('DiagramLayout(state: state, width: 120px, height: 80px) { Card(id: "one"); }', 'Card(id: "one");'), "CUT_DIAGRAM_BOUNDS");
});

test("checker owns diagram pairing, whole-pixel bounds, no-op, and direct-child diagnostics", () => {
  expectDiagnostic(program().replace("      progress: 0%,\n", ""), "CUT_DIAGRAM_TYPE");
  expectDiagnostic(program().replace("      width: 560px,", "      width: 560.5px,"), "CUT_DIAGRAM_TYPE");
  expectDiagnostic(program().replace("      fromState: source,", "      fromState: branch,"), "CUT_DIAGRAM_NOOP");
  expectDiagnostic(program().replace("      rankGap: 72px", "      rankGap: 72px,\n      xPosition: 1px"), "CUT_DIAGRAM_TYPE");
  expectDiagnostic(program().replace(
    "      DiagramNode(id: \"claim\", width: 132px, height: 58px, rank: 0) {\n        Rect(width: 132px, height: 58px, fill: #243b53);\n      }",
    "      Rect(width: 132px, height: 58px, fill: #243b53);",
  ), "CUT_DIAGRAM_BOUNDS");

  const outside = `cut 0.4;
project "orphan diagram node";
import { DiagramNode } from "@cut/diagram";
import { Rect } from "cut:visual";
timeline main(duration: 1s, fps: 24, width: 320px, height: 180px) {
  scene one(duration: 1s) { DiagramNode(id: "orphan", width: 20px, height: 20px) { Rect(width: 20px, height: 20px); } }
}
export out = render(main);`;
  expectDiagnostic(outside, "CUT_DIAGRAM_BOUNDS");
});

test("compiler closes graph identity, DAG, membership, rank, and inert-paint failures", () => {
  expectDiagnostic(program().replace('to: "proof"', 'to: "claim"'), "CUT_DIAGRAM_GRAPH");
  expectDiagnostic(program().replace('nodes: ["claim", "proof"]', 'nodes: ["claim", "missing"]'), "CUT_DIAGRAM_GRAPH");
  expectDiagnostic(program().replace("stroke: #25a18e", "stroke: #25a18e00"), "CUT_DIAGRAM_NOOP");
  expectDiagnostic(program().replace("rank: 1", "rank: 0"), "CUT_DIAGRAM_GRAPH");

  const cyclic = program().replace(
    'edges: [diagramEdge(id: "claim-proof", from: "claim", to: "proof", stroke: #25a18e, width: 3px)]',
    'edges: [diagramEdge(id: "claim-proof", from: "claim", to: "proof", stroke: #25a18e, width: 3px), diagramEdge(id: "proof-claim", from: "proof", to: "claim", stroke: #ef476f, width: 3px)]',
  );
  expectDiagnostic(cyclic, "CUT_DIAGRAM_GRAPH");
});

test("format/comment-only source changes preserve diagram build identity", () => {
  const source = program(), before = compile(source), after = compile(source.replace('project "diagram language proof";', 'project "diagram language proof";\n// no semantic change'));
  assert.notEqual(before.sourceHash, after.sourceHash);
  assert.equal(before.buildId, after.buildId);
});
