# GeoAnnotation: deterministic map-attached delivery overlays

`GeoAnnotation` projects a geographic anchor through CUT's fixed map
projection and owning `ParallaxCamera`, then resolves a bounded label in
delivery pixels. The label does not inherit world-camera scale or focus blur.

This is an executable pre-1.0 slice. The recommended form owns exactly one
direct `LocalSpace` child. Its declared local surface is the annotation
viewport, so child shapes and text author in local coordinates and rasterize at
local dimensions instead of first materializing a delivery-sized child and
cropping it.

```cut
import { DepthLayer, LocalSpace, ParallaxCamera, Rect, Text } from "cut:visual";
import { GeoAnnotation, Map } from "@cut/geo";

ParallaxCamera(focalLength: 900px) {
  DepthLayer(depth: 200px, edge: "transparent") {
    Map();
    GeoAnnotation(
      anchor: { latitude: 29.97, longitude: 32.55 },
      placements: ["right", "above"],
      offset: 12px,
      safeArea: 24px,
      leader: "elbow",
      leaderColor: #273b35,
      leaderWidth: 2px
    ) {
      LocalSpace(
        width: 168px,
        height: 60px,
        origin: { x: 0px, y: 0px }
      ) {
        Rect(width: 168px, height: 60px, x: 84px, y: 30px,
          fill: #f8f1dc, radius: 6px);
        Text(content: "ONE PASSAGE", font: face, size: 18px,
          x: 14px, y: 25px, maxWidth: 140px, color: #273b35);
      }
    }
  }
  DepthLayer(depth: 0px, edge: "transparent") {
    Rect(width: 8px, height: 8px, x: 8px, y: 8px, fill: #2563eb);
  }
}
```

## Viewport forms and migration

The pre-1.0 package accepts two deliberately separate forms:

- `GeoAnnotation(...) { LocalSpace(width:, height:, origin:) { ... } }` omits
  annotation `width` and `height`. The strict loader derives the complete
  viewport from that one direct typed child.
- The compatibility form
  `GeoAnnotation(width:, height:, ...) { ordinaryVisual }` requires both
  dimensions and retains the original centered delivery-canvas crop exactly.

Mixed forms fail with `CUT_GEO_ANNOTATION_VIEWPORT` in public source and a
stable loaded-IR diagnostic. An ordinary child with omitted dimensions, a
`LocalSpace` child with annotation dimensions, more than one child, indirect
ownership, unequal intervals, or shared ownership all fail before raster.
The compatibility path is never silently reinterpreted as local coordinates.

The frozen Atlas frame at index 144 remains an executable regression fixture:
the current runtime produces the preserved RGBA SHA-256
`889ab039e73c9495585d85aef67e282aedc6b52388a760ad6393707f06d47740`
through the legacy branch. Its package/build identities correctly change as
the current public implementation changes; byte-equal pixels are not a false
claim of historical cache-key equality.

## Closed public contract

- The node is one direct child of one `DepthLayer` beneath one
  `ParallaxCamera`. It owns exactly one visual child exclusively, and their
  half-open intervals are equal.
- `anchor` contains only `latitude` and `longitude`. Projection is fixed by
  `cut-reference-geo-annotation-map-v2`; a redundant `projection` argument is
  refused.
- A local viewport uses the child's required positive whole-pixel `width` and
  `height`. For candidate top-left `L`, authored local point `q` maps to
  `L + origin + q`; the complete declared tile, not measured alpha, occupies
  the collision rectangle.
- A legacy viewport uses required positive whole-pixel annotation dimensions
  and extracts exactly the centered declared rectangle. Padding and clipping
  at that rectangle remain semantic.
- `placements` contains one through four unique values from `right`, `above`,
  `below`, and `left`. Every fallback after the first must execute at a bounded
  exact validation sample or `cut check` reports it as inert.
- `offset` is at least `1px`; `safeArea` is a positive uniform delivery inset.
  A viewport either fits completely or is hidden.
- Collision resolves by descending optional whole-number `priority`, then
  structural order. Accepted overlays paint in reverse resolution order, so
  higher priority remains on top. Authored priority must change a validation
  outcome versus zero.
- `leader` is a required explicit policy: `none`, `straight`, or `elbow`.
  `leader: "none"` is the executable no-leader form under both ParallaxCamera
  and MapCamera and forbids `leaderColor`/`leaderWidth`. Visible `straight` and
  `elbow` leaders require a nontransparent `leaderColor` and positive
  `leaderWidth` and paint before their own viewport.
- `opacity` is the only annotation property. Exact zero skips occupancy and
  child raster. Positive opacity that is below the first possible RGBA8 alpha
  step still participates in placement/collision, but skips annotation-overlay
  placement and composition for that exact frame. Static opacity, or an entire
  bounded signal, that never reaches `round(255 * opacity) > 0` fails as a
  source-located no-op. Redundant explicit 100% and signals that never execute
  a change also fail as no-ops.

`cut check` runs graph, range, alignment, placement-reachability and no-op
analysis without a lock or raster backend. Lock and render still own resource
integrity, decoded media and backend validation.

## Execution, evidence and identity

For the local form the renderer requests the child tile only after the
annotation is accepted, paints that exact tile at the resolved rectangle, and
then draws its leader. `aggregateChildCanvasPixels` is zero for this form;
`execution.localSpaces` reports actual tile dimensions, per-node raster bytes,
placement and skip counters. This proves the child work is local-sized. It does
not claim that the final delivery overlay/composition performs no
delivery-sized work.

For the legacy form the old full-canvas child and centered crop execute
unchanged and remain separately visible in work evidence.

`cut inspect --json` distinguishes
`direct-LocalSpace-retained-tile` from the legacy crop, reports exact
dimensions/origin/Q16 registration and preserves recursive semantic identity.
Semantic diff and incremental cache identity propagate child edits through
LocalSpace, GeoAnnotation, layer, camera and scene while an unrelated sibling
can remain reusable. Placement state and tile identity stay separate.

`cut frame` writes `cut-reference-frame` v2. The same top-level renderer
invocation publishes ordered GeoAnnotation decisions at
`execution.geoAnnotations` and observed LocalSpace work at
`execution.localSpaces`; the closed schema is
`schemas/cut-reference-frame-v2.schema.json`. Nested/precomposition
LocalSpace receipts are not yet propagated into the outer frame manifest.
That limitation is explicit: top-level proof must not be relabeled as nested
receipt proof.

Algorithm v2 adds a required `renderedDecision` to each accepted annotation.
It is either `painted` (with positive `visibleAlpha`) or
`opacity-quantized-transparent` (without `visibleAlpha`). The transparent form
retains the accepted rectangle and paint order, reports source-alpha evidence,
and records zero annotation-overlay placement/composite pixels and bytes. Its
LocalSpace child tile can still have been materialized to prove source alpha;
that work remains visible in the LocalSpace receipt rather than being hidden.
GeoAnnotation execution identity binds these same-frame rendered decisions.
MapCamera receipts bind that execution identity, split accepted decisions into
actual `painted` and `opacityQuantizedTransparent` counts, and set
`annotationOverlayComposites` to the painted count rather than the planned
accepted count. Historical v1 frame evidence remains schema-readable.

## Bounded current implementation

Preflight caps annotations, placements, candidates, collision tests, local
surface dimensions/bytes, retained child work and delivery overlay work before
raster. Hidden/offscreen local annotations request no tile. Existing tests
cover local Text plus shape at 16:9 and 1:1, collision fallback and leaders,
the RGBA8 fade boundary with stable layout and zero-work transparent samples,
two exact camera-zoom samples, local work accounting, loaded-IR hostility,
diff/cache locality, schema-valid top-level frame evidence, and exact legacy
RGBA preservation.

The explicit 1x/2x/3x zoom matrix, zero-opacity local work fixture, complete
field mutation matrix, nested receipt propagation, wider LocalSpace descendant
support, unrelated product/science studies, playback review and creative
quality gates remain open. This engineering slice does not make a creative
PASS and does not change CUT's alpha version.
