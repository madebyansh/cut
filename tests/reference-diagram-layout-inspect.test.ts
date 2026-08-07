import assert from "node:assert/strict";
import test from "node:test";
import { compileCutModule } from "../lib/language/compiler";
import { CutDiagramContractError } from "../lib/language/diagram-contract";
import { parseCutLanguage } from "../lib/language/parser";
import { inspectCutIr } from "../lib/runtime/inspect";

function source(edgeColor = "#d4513c", width = 54, rankGap = 42) {
  return `cut 0.4;
project "Diagram inspect proof";
import { DiagramLayout, DiagramNode, diagramEdge, diagramState } from "@cut/diagram";
import { Rect } from "cut:visual";
import { linear } from "@cut/motion";
const before = diagramState(id: "before", nodes: ["claim", "effect"], edges: []);
const after = diagramState(
  id: "after",
  nodes: ["claim", "effect"],
  edges: [diagramEdge(id: "cause", from: "claim", to: "effect", stroke: ${edgeColor}, width: 2px)]
);
timeline main(duration: 1s, fps: 24, width: 320px, height: 180px) {
  scene only(duration: 1s) {
    DiagramLayout(state: after, fromState: before, progress: 0%, direction: "horizontal", rankGap: ${rankGap}px) as graph {
      DiagramNode(id: "claim", width: ${width}px, height: 30px, rank: 0) { Rect(width: ${width}px, height: 30px, fill: #25364a); }
      DiagramNode(id: "effect", width: 54px, height: 30px, rank: 1) { Rect(width: 54px, height: 30px, fill: #d4513c); }
    }
    animate graph.progress from 0% to 100% over 1s ease linear;
  }
}
export out = render(main);`;
}

function compile(text: string) {
  const parsed = parseCutLanguage(text);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const compiled = compileCutModule(parsed.module);
  assert.deepEqual(compiled.check.diagnostics.filter((item) => item.severity === "error"), []);
  return compiled.ir;
}

function layoutInspection(text: string) {
  const report = inspectCutIr(compile(text), "main.cut");
  const layout = report.graph.nodes.find((node) => node.op === "cut.diagram.layout");
  assert.ok(layout?.diagramLayout);
  assert.equal(layout.diagramLayout.instances.length, 1);
  return { report, layout, instance: layout.diagramLayout.instances[0] };
}

test("inspect exposes exact DiagramLayout decisions, semantic endpoint dependencies, and the writable progress signal", () => {
  const { report, layout, instance } = layoutInspection(source());
  assert.equal(report.summary.diagramLayouts, 1);
  assert.equal(report.summary.diagramNodes, 2);
  assert.equal(instance.status, "planned");
  assert.equal(instance.algorithm, "cut-reference-diagram-layout-v1");
  assert.deepEqual(instance.states, { from: "before", to: "after" });
  assert.equal(instance.progress.execution.kind, "signal");
  assert.equal(instance.progress.execution.preparedByRuntime, false);
  assert.equal(instance.preflight?.samples, 24);
  assert.deepEqual(instance.preflight?.first?.at, { numerator: "0", denominator: "1" });
  assert.deepEqual(instance.preflight?.last?.at, { numerator: "23", denominator: "24" });
  assert.equal(instance.preflight?.plan.fromEndpoint?.nodes.length, 2);
  assert.equal(instance.preflight?.plan.toEndpoint.nodes.length, 2);
  assert.deepEqual(instance.contract.edges.map((edge) => [edge.id, edge.from, edge.to]), [["cause", "claim", "effect"]]);
  assert.deepEqual(layout.children.length, 2);

  const diagramNodes = report.graph.nodes.filter((node) => node.op === "cut.diagram.node");
  assert.equal(diagramNodes.length, 2);
  assert.ok(diagramNodes.every((node) => node.diagramNode?.instances[0].layoutNodeId === layout.id));
  assert.ok(diagramNodes.every((node) => node.diagramNode?.instances[0].childIds.length === 1));
});

test("inspect split identities preserve topology and geometry for edge-paint-only changes", () => {
  const before = layoutInspection(source()).instance.preflight!.plan;
  const after = layoutInspection(source("#2f7e74")).instance.preflight!.plan;
  assert.equal(before.topologyIdentity, after.topologyIdentity);
  assert.equal(before.geometryIdentity, after.geometryIdentity);
  assert.notEqual(before.paintIdentity, after.paintIdentity);
  assert.notEqual(before.receiptIdentity, after.receiptIdentity);
});

test("inspect reports source-located planner diagnostics instead of accepting an unsatisfiable layout", () => {
  assert.throws(
    () => inspectCutIr(compile(source("#d4513c", 140, 200)), "main.cut"),
    (error: unknown) => {
      assert.ok(error instanceof CutDiagramContractError, String(error));
      assert.equal(error.code, "CUT_DIAGRAM_LAYOUT_UNSAT");
      assert.match(error.message, /cut\.diagram\.layout at .*:\d+:\d+/u);
      return true;
    },
  );
});
