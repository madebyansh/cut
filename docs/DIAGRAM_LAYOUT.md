# Deterministic diagram layout

Status: **pre-1.0 executable public vertical; creative and multi-process-cache
gates incomplete**. The package surface now executes through parsing, checking,
typed IR, strict hostile-IR loading, exact bounded planning, retained reference
pixels, persistent cross-render subscene caching, inspect, semantic diff and
closed exact-frame receipts. That engineering closure is not a professional-
output, watched-study, hero-film or CUT 1.0 pass.

`@cut/diagram` is a closed retained-DAG authoring surface. It lets an author
declare stable semantic nodes and edges while leaving placement and routing to
one deterministic layout owner. It is not a card preset, a private graph JSON
format, a force-directed solver, or a general constraint language.

## Public API

```cut
import { DiagramLayout, DiagramNode, diagramEdge, diagramState } from "@cut/diagram";
import { Rect } from "cut:visual";

const before: DiagramState = diagramState(
  id: "before",
  nodes: ["claim"],
  edges: []
);

const after: DiagramState = diagramState(
  id: "after",
  nodes: ["claim", "proof"],
  edges: [
    diagramEdge(
      id: "claim-proof",
      from: "claim",
      to: "proof",
      stroke: #25a18e,
      width: 3px
    )
  ]
);

DiagramLayout(
  state: after,
  fromState: before,
  progress: 0%,
  direction: "horizontal",
  width: 560px,
  height: 260px
) as graph {
  DiagramNode(id: "claim", width: 132px, height: 58px, rank: 0) {
    Rect(width: 132px, height: 58px, fill: #243b53);
  }
  DiagramNode(id: "proof", width: 112px, height: 48px, rank: 1) {
    Rect(width: 112px, height: 48px, fill: #f4d35e);
  }
}
```

The closed signatures are:

```text
diagramEdge(id: String, from: String, to: String,
  fromPort?: "auto"|"top"|"right"|"bottom"|"left",
  toPort?: "auto"|"top"|"right"|"bottom"|"left",
  stroke: Color, width: Length, arrow?: TraceArrowhead) -> DiagramEdge

diagramState(id: String, nodes: List<String>,
  edges: List<DiagramEdge>) -> DiagramState

DiagramNode(id: String, width: Length, height: Length, rank?: Number)
  { Visual... } -> DiagramNode

DiagramLayout(state: DiagramState, fromState?: DiagramState, progress?: Ratio,
  direction?: "auto"|"horizontal"|"vertical",
  width?: Length, height?: Length, x?: Length, y?: Length,
  safeX?: Ratio, safeY?: Ratio, nodeGap?: Length, rankGap?: Length,
  edgeGap?: Length, edgeClearance?: Length) { DiagramNode... } -> Visual
```

`diagramEdge` and `diagramState` compile to ordinary closed IR objects; no
constructor call or hidden graph document survives lowering. `DiagramLayout`
and `DiagramNode` compile to stable operations `cut.diagram.layout` and
`cut.diagram.node`. `progress` is the only writable layout property and has
the exact `Ratio` signal type.

`DiagramNode` is a nominal structural result, so a reusable user component can
preserve the layout's direct-child contract:

```cut
component Card(id: String, rank: Number, color: Color) -> DiagramNode {
  DiagramNode(id: id, width: 96px, height: 48px, rank: rank) {
    Rect(width: 96px, height: 48px, fill: color);
  }
}

DiagramLayout(state: after, width: 560px, height: 260px) {
  Card(id: "claim", rank: 0, color: #243b53);
  Card(id: "proof", rank: 1, color: #f4d35e);
}
```

A component may declare `-> DiagramNode` only when its definition contains
exactly one direct DiagramNode node statement and no sibling binding, control-
flow or automation statement. Its invocation expands transparently to that one
`cut.diagram.node`; CUT does not insert the ordinary `cut.kernel.fragment`
component wrapper. Definition and invocation provenance remain attached to the
expanded node. A DiagramNode-returning component is structurally closed and
cannot accept an invocation child block. These rules apply equally to a
component imported from a project module; they do not expose a private package
or runtime escape hatch.

## Ownership and exact defaults

- A layout has 1 through 64 direct `DiagramNode` children and nothing else at
  that direct level. A direct invocation whose nominal result is `DiagramNode`
  expands to that same structure before IR ownership is established. A
  `DiagramNode` has exactly one direct layout owner.
- A node's local `(0, 0)` is its center. It accepts no `x` or `y`; the layout
  exclusively owns placement. The current retained reference renderer accepts
  the bounded local subset `Fragment`, `Group`, `Rect`, `Circle`, retained
  `Path`, `Trace`, `Text`, and `FlowText`. Retained media, effects and every
  other descendant fail source-located instead of falling back to a delivery-
  canvas render. Reusable components may own node-local artwork, while the
  defining `DiagramNode` wrapper remains explicit so graph identity and bounds
  cannot be hidden behind an ordinary fragment; a structurally checked
  DiagramNode-returning component only reuses that wrapper without adding one.
- Layouts cannot nest inside a layout or any node subtree in this first
  contract.
- Node `width` and `height`, plus explicit layout `width` and `height`, are
  positive whole-pixel lengths from 1 through 65,536. CUT never hides a raster
  dimension quantizer. Positions and gaps remain exact rational pixels; the
  retained planner's documented placement boundary is ties-to-even Q16.16.
- `width` and `height` are a pair. If omitted, the owning composition supplies
  the frame. `fromState` and `progress` are also a pair.
- Omitted values normalize to `direction: "auto"`, `x/y: 0px`, `safeX/safeY:
  0%`, `nodeGap: 16px`, `rankGap: 48px`, `edgeGap: 6px`, and
  `edgeClearance: 4px`.
- A rank is a whole number in `0..31` and is a hard edge-order constraint.
- Diagram IDs are non-empty trimmed UTF-8 strings of at most 128 bytes with no
  control characters. State/node/edge membership and IDs are exact and
  duplicate-free. A state is a DAG; cycles and self-edges fail.
- Shared edge IDs across active states must preserve endpoints, ports and
  paint. Fully transparent edge or arrow paint is rejected as an inert input.

Hard work limits are part of this boundary: 32 layouts per composition, 64
nodes per layout, 128 edges per state, two active states, 16,777,216 aggregate
declared node pixels per layout, four ordering sweeps, 16 route candidates per
edge, 4,096 transition samples, 4,096 node-pair tests per sample, 131,072
route/node tests per sample, and 50,000,000 validation tests per composition.

## Stable diagnostics

| Code | Meaning |
| --- | --- |
| `CUT_DIAGRAM_TYPE` | wrong type/unit, unknown field/argument, invalid enum or incomplete pair |
| `CUT_DIAGRAM_IDENTITY` | duplicate/reused identity or state/child mismatch |
| `CUT_DIAGRAM_GRAPH` | missing endpoint, self-edge, cycle or rank violation |
| `CUT_DIAGRAM_BOUNDS` | invalid bounds, inset or ownership |
| `CUT_DIAGRAM_LAYOUT_UNSAT` | bounded packing cannot fit |
| `CUT_DIAGRAM_ROUTE_UNSAT` | bounded routing cannot clear obstacles |
| `CUT_DIAGRAM_TRANSITION_COLLISION` | an exact transition sample collides |
| `CUT_DIAGRAM_LIMIT` | a declared work/resource limit is exceeded |
| `CUT_DIAGRAM_NOOP` | an accepted value would have no semantic effect |

Source checks own derivable argument, bounds, pair, no-op and direct-child
errors. The compiler and strict loaded-IR boundary repeat the complete closed
records, graph, identity, ownership and resource contract. Planner and raster
failures retain the same codes plus source module/line/column/node provenance;
unsupported descendants fail before pixel work.

## Executed planner and renderer

Algorithm identity is `cut-reference-diagram-layout-v1`. It performs stable
Kahn ranking, authored rank validation, exactly four alternating median-order
sweeps, exact centered packing and first-valid bounded five-point orthogonal
routing. Candidate routes use internal then safe-frame perimeter gutters. CUT
fails unsatisfiable packing, routing, overlap and resource budgets; it never
shrinks nodes, draws through them or accepts a hidden fallback.

`fromState` transitions preflight every exact active output-frame sample (up to
4,096 per layout) using the evaluated public Ratio signal. Common geometry is
interpolated in Q16.16, entering/exiting nodes crossfade, and entering/exiting
edges reveal/retract with retained trim and terminal-tangent arrows. Per-sample
collision limits and the composition-wide validation budget are both enforced.

The renderer paints each node in its declared clipped local tile, places it at
the exact planned center/opacity, paints routed edges incrementally, then paints
nodes above endpoint caps. An edge is persisted as its conservative tight RGBA
tile and placed on the delivery canvas only for composition; a fully retracted
edge uses one canonical transparent 1-by-1 tile. It is never stored as a full-
canvas cache artifact. Full-canvas DiagramLayout execution is FIFO and
resource-admitted before allocation.

Node tiles and edge tiles use the content-addressed
`cut-reference-diagram-raster-cache` v1 boundary under the project cache. Its
closed, path-free identity splits topology, geometry, paint and temporal
dependencies and also binds CUT's reference-runtime identity, the complete
`@cut/diagram` built-in implementation closure, platform, architecture, Node,
and the observed Sharp/libvips dependency versions. The split is intentionally
local:

- changing a node's rank or planned placement preserves unchanged local node
  pixels while invalidating any edge whose routed geometry changes;
- changing one node's local paint invalidates that tile, not unrelated node or
  edge tiles;
- changing edge paint or retained geometry invalidates that edge tile without
  invalidating node tiles; and
- authored node and edge IDs remain planner evidence but do not fragment a
  pixel cache entry whose executable raster inputs are otherwise identical.

Static node subtrees use a timeless dependency identity. Sampled subtrees hash
the values that can actually change their pixels: active state, evaluated
properties, retained `FlowText` output, and exact `Trace` phase. A drawing Trace
binds its exact reveal position, its head-fade binds exact elapsed fade time,
and before-delay or fully settled plateaus reuse one identity. Equal evaluated
property values likewise reuse; a newly admitted local operation falls back to
exact time/frame sampling until its narrower dependency contract is explicit.
This is visual-dependency reuse, not a promise that arbitrary time-varying
programs are static.

Every hit reopens the no-follow regular files and validates a strict closed
manifest, exact dimensions, exact `width * height * 4` byte count and SHA-256.
Missing, malformed or corrupt pairs are misses and rebuilds rather than trusted
pixels. Publication is artifact-first and manifest-last through same-directory
staging; same-process lookups coalesce, namespace scans are bounded, and
deterministic eviction enforces configured entry/byte limits. Paths and raw
backend strings do not enter the persisted identity or receipt.

Exact-frame manifests publish DiagramLayout frame evidence v2 at
`execution.diagramLayouts`. Each node/edge points to one closed cache receipt;
receipts identify `diagram-subscene-rgba` with scope `persistent-cross-render`,
the hit/miss reason, split identity, verified artifact and bounded counters.
`executionIdentity` excludes lookup status, cache counters and receipt history,
so the same exact rendered frame has one semantic execution identity on a cold
and warm replay. `observationIdentity` includes those cache observations and is
expected to differ. Historical DiagramLayout v1 frame evidence remains valid
under the schema, but it does not claim this cache boundary. Neither receipt is
evidence of scene-cache reuse.

Inspect exposes topology, endpoints, exact samples, solved geometry, work and
split topology/geometry/paint identities. Semantic diff classifies topology,
layout, edge paint, node paint and progress separately.

Cross-process publication, eviction and namespace leases are not coordinated
yet. A stage owned by another process is left untouched, and current v2 frame
evidence states `multiProcessCoordination: "not-claimed"`. Run one cache-writing
CUT process per project cache when relying on persistent DiagramLayout reuse;
same-process FIFO/coalescing is not a cross-process lock.

## Proof boundary

Language, loader, planner, renderer, cache, inspect/diff and exact-frame
evidence are covered by the focused `diagram-layout-*` and
`reference-diagram-*` tests. `signal-through-the-grid` V4
(`review/iterations/v4-diagram-components-cache`) and the unrelated
`cell-signal-cascade` study exercise the current public runtime, nominal node
components and persistent receipts as engineering evidence. Frozen
`signal-through-the-grid` V3 remains preserved historical layout/pixel evidence;
it predates the component/cache closure and is not promoted into current
persistent-cache proof. Both current studies retain complete named-human
full-speed playback and applicable headphone/deliberate-silence reviews as
`UNPERFORMED`. Cache hits, hashes, selected frames, contact sheets and test
passes cannot advance a creative gate. No diagram evidence here advances CUT's
pre-1.0 release status or proves professional direction.
