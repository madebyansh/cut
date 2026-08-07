# ParallaxCamera: deterministic 2.5D

`ParallaxCamera` is CUT's narrow shared-camera primitive for parallel visual
planes. It is deterministic 2.5D. It is not `Camera3D`, does not rotate planes
in three dimensions, does not provide lights or meshes, and must not be
described as a general 3D scene.

```cut
import { ParallaxCamera, DepthLayer, Rect, Circle } from "cut:visual";
import { inOutCubic } from "@cut/motion";

ParallaxCamera(
  focalLength: 900px,
  focus: "linear",
  focusDepth: 0px,
  focusRange: 800px,
  maxBlur: 6px
) as camera {
  DepthLayer(depth: 1200px, edge: "clamp") {
    Rect(width: 1920px, height: 1080px, fill: #f0e6d2);
  }
  DepthLayer(depth: 240px, edge: "transparent") {
    Circle(x: 960px, y: 540px, radius: 80px, fill: #2457d6);
  }
  DepthLayer(depth: -180px, edge: "transparent") {
    Rect(width: 70px, height: 70px, x: 1180px, y: 620px, fill: #ef6a45);
  }
}

animate camera.x from 0px to 180px over 6s ease inOutCubic;
animate camera.y from 0px to -36px over 6s ease inOutCubic;
animate camera.z from 0px to 120px over 6s ease inOutCubic;
animate camera.focusDepth from 0px to 240px over 6s ease inOutCubic;
```

## Closed graph

- A camera has 2 through 64 direct `DepthLayer` children.
- A layer has 1 through 16 direct visual children and exactly one direct
  `ParallaxCamera` parent in this v1 slice.
- Camera, layer, and child half-open intervals are nested. At every exact
  output-frame sample where a layer is active, at least one direct child must
  be active. An empty active plane is an error, not hidden transparency.
- At least two active planes have distinct depth at an exact output frame.
- `depth` is static in this first slice. Camera `x`, `y`, `z`, and
  `focusDepth` are typed, animatable `Length` properties.

These rules are checked from source and revalidated from loaded CutAVIR.

## Projection

The projection is fixed by the kernel and therefore is not a redundant public
selector. `cut inspect --json` resolves it as `planar-perspective`.

Let `C` be the composition centre, `p` a point on one parallel layer, `f` the
positive focal length, `d` the layer depth, and camera position `(x, y, z)`.

```text
opticalDistance = f + d - z
scale           = f / opticalDistance
outputPoint     = C + scale * (p - C - [x, y])
```

Positive layer depth is farther away. Positive camera `z` dollies toward the
planes. Optical distance must remain positive and projection scale must remain
within the bounded executable range at every sampled time, including easing
overshoot. One camera signal drives every layer; authors do not duplicate
per-layer motion rates.

## Paint order

`ordering` is optional and defaults to `"depth"`.

- `"depth"`: greater depth paints first, smaller depth paints last. Exact
  depth ties preserve source order.
- `"source"`: source order paints bottom to top while depth still controls
  projection and focus. It is rejected when it resolves to the same order as
  the default because the authored control would do nothing.

Writing the default explicitly is also rejected. Omit it.

## Focus

Focus defaults to off; writing `focus: "off"` is redundant and rejected.
`focus: "linear"` requires `focusDepth`, positive `focusRange`, and positive
`maxBlur`.

```text
rawSigma      = maxBlur * clamp(abs(layer.depth - focusDepth) / focusRange, 0, 1)
executedSigma = rawSigma < 0.3px ? 0px : rawSigma
```

The sigma is measured in delivery pixels. For every plane the runtime:

1. materializes its ordinary public visual subtree;
2. applies the source edge policy;
3. projects and crops to the delivery canvas;
4. applies the exact focus blur on that delivery-space surface; and
5. composites completed planes in resolved paint order.

The `0.3px` deadband is normative public semantics and appears in inspect and
cache identity. It lets a continuous focus path cross a plane without asking
the existing alpha-coupled Gaussian backend to execute outside its supported
range; it is not a hidden backend clamp. Linear focus is refused unless at
least one reachable plane executes an unsaturated sigma from `0.3px` through
`64px`. If `focusDepth` is animated, at least one plane's executed sigma
profile must change after the deadband. Fully saturated or inert focus
controls fail as no-ops.

## Required edge policy

Every `DepthLayer` chooses one policy explicitly.

- `edge: "transparent"` samples transparent outside the selected source
  surface's declared boundary. That boundary is the composition canvas for an
  ordinary layer and the declared tile boundary for a direct `LocalSpace`.
  Use it for cut-outs and foreground layers.
- `edge: "clamp"` extends the selected source surface's declared border pixels
  only as far as the inverse-projected delivery frame needs, then projects and
  crops. It prevents a source-boundary seam for an appropriate background
  plane.

Clamp does **not** recover geometry authored outside an ordinary composition
canvas or outside a declared `LocalSpace` boundary. It can smear a bad border
and is not a substitute for a larger retained local scene. CUT reports the
exact source kind, boundary, padding, and this limitation in inspect output.
Clamp is rejected when no executed output frame needs it, and per-plane plus
aggregate pixel/byte budgets fail before allocation.

The plan accounts, by actual raster phase, for active direct-child delivery
surfaces, each layer composite's base and output, clamp extension, the exact
rounded Sharp resize intermediate, projected delivery output, focus output,
and the camera composite's base and output. Every explicit resized axis is
bounded before Sharp is called. Simultaneously active cameras also share one
composition-level logical pixel/byte ceiling on composition-absolute frame
time, and total camera-frame validation work is bounded.

This is an exact **camera-owned logical-surface** boundary. It is not yet a
bound on arbitrary recursive `Group` fan-out inside one child or on private
libvips scratch allocations; those broader runtime limits remain PARTIAL.

## Direct LocalSpace execution boundary

The exact unary form `DepthLayer { LocalSpace { ... } }` now checks, lowers to
ordinary typed IR, reloads through the strict IR validator, and produces a
bounded retained-source camera plan. Local authored `(0,0)` is registered at
composition centre on its parallel plane before the existing projection;
declared local bounds, origin, projected bounds, source placement, edge work,
aggregate work, and cache identity remain explicit. Mixed local/canvas
children, indirect or duplicate ownership, unsupported local descendants,
cycles, and work-limit overflow fail before media work.

The reference compositor consumes this plan directly. It materializes the
declared local tile rather than a delivery-size child canvas, applies
`transparent` outside the tile or replicates only the declared tile border for
`clamp`, then projects, focuses, and composites the plane through the same
camera path as an ordinary layer. The completed LocalSpace frame receipt binds
the depth owner, Q16 registration (including clamp padding), projection scale,
destination registration, and actual tile/placement work.

`tests/reference-local-space-owner-render.test.ts` locks public two-scene CUT
sources and proves transparent and clamp pixels, later-scene activation,
later-frame camera motion, and full owner transform evidence. These are
engineering fixtures, not a study or creative pass. Ordinary DepthLayer child
forms keep their existing executable full-canvas semantics.

## Determinism and diagnostics

The camera planner's semantic and frame identities include the public camera
subtree, recursive descendants, complete locked resource probe/selection
metadata, signals, exact time, derived matrices, raw and deadbanded focus
sigma, resized-raster plan, edge padding, resolved paint order, algorithm
version, and backend identity. Formatting and comments do not participate.
The separate generic incremental graph cache still has a selected-stream
metadata gap, so end-to-end cache correctness remains PARTIAL until that
shared cache key is fixed.

Stable failures use the `CUT_PARALLAX_*` family and carry module, line, column,
and node id. Relevant codes are `TYPE`, `GRAPH`, `RANGE`, `PROJECTION`,
`FOCUS`, `ORDERING`, `EDGE`, `LIMIT`, and `NOOP`.

## Current boundary

This slice solves one shared camera path, deterministic planar perspective,
depth ordering, stylized planar focus, and explicit selected-source edges.
It does not yet provide arbitrary z-rotated planes, camera orbit, occlusion
geometry, lights, meshes, or retained off-canvas bounds for every visual node.
It also refuses a reachable outer `MotionBlur` ancestor because v1 validates
ordinary output-frame samples, not shutter subframes; MotionBlur may be placed
inside a DepthLayer instead. These remain separate work; this API does not
disguise them as present.

Map-attached screen-size overlays are documented separately in
[`GEO_ANNOTATION.md`](GEO_ANNOTATION.md). That executable slice preserves a
geographic anchor through this camera while laying out its declared viewport
after projection; its centered full-canvas child boundary remains an explicit
pre-1.0 limitation.
