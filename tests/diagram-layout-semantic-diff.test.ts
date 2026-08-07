import assert from "node:assert/strict";
import test from "node:test";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIRSemanticModify, CutDiagramSemanticChangeClass } from "../lib/language/semantic-diff";
import { diffCutAVIR, formatCutAVIRSemanticDiff } from "../lib/language/semantic-diff";
import { parseCutLanguage } from "../lib/language/parser";

function source(options: {
  edgeFrom?: "claim" | "context";
  edgeColor?: string;
  rankGap?: number;
  claimWidth?: number;
  claimFill?: string;
  animationMs?: number;
} = {}) {
  const edgeFrom = options.edgeFrom ?? "claim";
  const edgeColor = options.edgeColor ?? "#d4513c";
  const rankGap = options.rankGap ?? 42;
  const claimWidth = options.claimWidth ?? 54;
  const claimFill = options.claimFill ?? "#25364a";
  const animationMs = options.animationMs ?? 800;
  return `cut 0.4;
project "Diagram diff classification";
import { DiagramLayout, DiagramNode, diagramEdge, diagramState } from "@cut/diagram";
import { Rect } from "cut:visual";
import { linear } from "@cut/motion";
const before = diagramState(id: "before", nodes: ["claim", "context"], edges: []);
const after = diagramState(
  id: "after",
  nodes: ["claim", "context", "effect"],
  edges: [diagramEdge(id: "cause", from: "${edgeFrom}", to: "effect", stroke: ${edgeColor}, width: 2px)]
);
timeline main(duration: 1s, fps: 24, width: 320px, height: 180px) {
  scene only(duration: 1s) {
    DiagramLayout(state: after, fromState: before, progress: 0%, direction: "horizontal", rankGap: ${rankGap}px) as graph {
      DiagramNode(id: "claim", width: ${claimWidth}px, height: 30px, rank: 0) { Rect(width: ${claimWidth}px, height: 30px, fill: ${claimFill}); }
      DiagramNode(id: "context", width: 50px, height: 26px, rank: 0) { Rect(width: 50px, height: 26px, fill: #2f7e74); }
      DiagramNode(id: "effect", width: 54px, height: 30px, rank: 1) { Rect(width: 54px, height: 30px, fill: #d4513c); }
    }
    animate graph.progress from 0% to 100% over ${animationMs}ms ease linear;
  }
}
export out = render(main);`;
}

function compile(text: string) {
  const parsed = parseCutLanguage(text);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  return compileCutModule(parsed.module).ir;
}

function modifications(before: string, after: string) {
  return diffCutAVIR(compile(before), compile(after)).changes.filter(
    (change): change is CutAVIRSemanticModify => change.operation === "modify",
  );
}

function hasClass(changes: readonly CutAVIRSemanticModify[], value: CutDiagramSemanticChangeClass) {
  return changes.some((change) => change.classifications?.includes(value));
}

test("diagram semantic diff classifies topology, layout, edge paint, node paint, and progress separately", () => {
  const base = source();
  const topology = modifications(base, source({ edgeFrom: "context" }));
  const layout = modifications(base, source({ rankGap: 48 }));
  const edgePaint = modifications(base, source({ edgeColor: "#2f7e74" }));
  const nodeBounds = modifications(base, source({ claimWidth: 60 }));
  const nodePaint = modifications(base, source({ claimFill: "#18222f" }));
  const progress = modifications(base, source({ animationMs: 900 }));

  assert.equal(hasClass(topology, "topology"), true);
  assert.equal(hasClass(layout, "bounds-layout"), true);
  assert.equal(hasClass(edgePaint, "edge-paint"), true);
  assert.equal(hasClass(nodeBounds, "bounds-layout"), true);
  assert.equal(hasClass(nodePaint, "node-paint"), true);
  assert.equal(hasClass(progress, "progress"), true);

  assert.equal(hasClass(edgePaint, "topology"), false, "paint-only edits must not pretend to change topology");
  assert.equal(hasClass(nodePaint, "bounds-layout"), false, "same-bound node pixels must preserve placement meaning");
  assert.match(formatCutAVIRSemanticDiff(diffCutAVIR(compile(base), compile(source({ edgeColor: "#2f7e74" })))), /\[edge-paint\]/u);
});
