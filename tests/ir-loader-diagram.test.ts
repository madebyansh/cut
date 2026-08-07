import assert from "node:assert/strict";
import test from "node:test";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRNode, IRValue } from "../lib/language/ir";
import { CutAvIrValidationError, loadCutAvIr } from "../lib/language/ir-loader";
import { parseCutLanguage } from "../lib/language/parser";
import { finalizeGraphHashes } from "../lib/runtime/graph";

const source = `cut 0.4;
project "Diagram hostile loader proof";
import { DiagramLayout, DiagramNode, diagramEdge, diagramState } from "@cut/diagram";
import { Rect } from "cut:visual";
import { linear } from "@cut/motion";

const compact = diagramState(
  id: "compact",
  nodes: ["claim", "effect"],
  edges: [diagramEdge(id: "cause", from: "claim", to: "effect", stroke: #d4513c, width: 2px)]
);
const expanded = diagramState(
  id: "expanded",
  nodes: ["claim", "context", "effect"],
  edges: [
    diagramEdge(id: "cause", from: "claim", to: "effect", stroke: #d4513c, width: 2px),
    diagramEdge(id: "context-edge", from: "context", to: "effect", stroke: #2f7e74, width: 2px)
  ]
);

timeline main(duration: 1s, fps: 24, width: 320px, height: 180px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    DiagramLayout(
      state: expanded,
      fromState: compact,
      progress: 0%,
      direction: "horizontal",
      safeX: 5%,
      safeY: 10%,
      nodeGap: 12px,
      rankGap: 36px,
      edgeGap: 6px,
      edgeClearance: 3px
    ) as diagram {
      DiagramNode(id: "claim", width: 54px, height: 30px) {
        Rect(width: 54px, height: 30px, fill: #25364a);
      }
      DiagramNode(id: "context", width: 50px, height: 26px, rank: 0) {
        Rect(width: 50px, height: 26px, fill: #2f7e74);
      }
      DiagramNode(id: "effect", width: 54px, height: 30px, rank: 1) {
        Rect(width: 54px, height: 30px, fill: #d4513c);
      }
    }
    animate diagram.progress from 0% to 100% over 1s ease linear;
  }
}
export out = render(main);`;

type Fixture = {
  ir: CutAVIR;
  layout: IRNode;
  nodes: IRNode[];
};

function fixture(): Fixture {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const compiled = compileCutModule(parsed.module);
  assert.equal(compiled.check.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length, 0, JSON.stringify(compiled.check.diagnostics));
  const layout = Object.values(compiled.ir.nodes).find((node) => node.op === "cut.diagram.layout");
  assert.ok(layout);
  const nodes = layout.children.map((id) => compiled.ir.nodes[id]).filter((node): node is IRNode => node?.op === "cut.diagram.node");
  assert.equal(nodes.length, 3);
  return { ir: compiled.ir, layout, nodes };
}

function string(value: string): IRValue { return { kind: "string", value }; }
function px(value: number): IRValue {
  return { kind: "quantity", dimension: "length", magnitude: { numerator: String(value), denominator: "1" }, unit: "px" };
}

function expectMutation(
  name: string,
  mutate: (fixture: Fixture) => void,
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

test("loaded IR accepts the compiler's closed DiagramLayout graph", () => {
  const { ir, layout } = fixture();
  assert.equal(loadCutAvIr(JSON.stringify(ir)).nodes[layout.id].op, "cut.diagram.layout");
});

test("loaded IR repeats paired-field, identity, graph, bounds, and closed-field checks", () => {
  expectMutation("unpaired frame", ({ layout }) => { layout.inputs.width = px(200); }, "CUT_DIAGRAM_TYPE", /\.inputs\.width$/u);
  expectMutation("unknown layout field", ({ layout }) => { layout.inputs.privateSolver = string("force"); }, "CUT_IR_UNKNOWN_FIELD", /\.inputs\.privateSolver$/u);
  expectMutation("duplicate semantic node id", ({ nodes }) => { nodes[1].inputs.id = nodes[0].inputs.id; }, "CUT_DIAGRAM_IDENTITY", /\.inputs\.id$/u);
  expectMutation("unknown node field", ({ nodes }) => { nodes[0].inputs.x = px(12); }, "CUT_IR_UNKNOWN_FIELD", /\.inputs\.x$/u);
  expectMutation("fractional raster width", ({ nodes }) => {
    nodes[0].inputs.width = { kind: "quantity", dimension: "length", magnitude: { numerator: "109", denominator: "2" }, unit: "px" };
  }, "CUT_DIAGRAM_TYPE", /\.inputs\.width$/u);
  expectMutation("state references missing child", ({ layout }) => {
    const state = layout.inputs.state;
    assert.equal(state.kind, "object");
    const nodeList = state.entries.nodes;
    assert.equal(nodeList.kind, "array");
    nodeList.items[0] = string("absent");
  }, "CUT_DIAGRAM_GRAPH", /\.inputs\.state\.edges\[0\]\.from$/u);
});

test("loaded IR rejects a re-signed shared edge identity whose contract changed", () => {
  expectMutation("shared edge changed", ({ layout }) => {
    const state = layout.inputs.state;
    assert.equal(state.kind, "object");
    const edges = state.entries.edges;
    assert.equal(edges.kind, "array");
    const edge = edges.items[0];
    assert.equal(edge.kind, "object");
    edge.entries.stroke = { kind: "color", value: "#ffffffff" };
  }, "CUT_DIAGRAM_IDENTITY", /\.inputs\.state\.edges\[0\]\.id$/u);
});
