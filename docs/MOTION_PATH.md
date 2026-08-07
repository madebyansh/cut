# Deterministic motion paths

`MotionPath` moves exactly one visual child along either a bounded authored
polyline or the same typed `PathGeometry` consumed by retained `Path`.
The source remains ordinary typed CUT; no model or hidden planning graph is
involved.

```cut
import { MotionPath, Circle } from "cut:visual";
import { outCubic } from "@cut/motion";

MotionPath(
  points: [
    { x: 120px, y: 540px },
    { x: 960px, y: 180px },
    { x: 1800px, y: 540px }
  ],
  orientToPath: true
) as subject {
  Circle(radius: 24px, fill: #ff5a36);
}

animate subject.progress from 0% to 100% over 2s ease outCubic;
```

One geometry value can drive both the visible stroke and its subject:

```cut
import { Circle, MotionPath, Path, cubicTo, vectorPath } from "cut:visual";

const route = vectorPath(
  start: { x: 120px, y: 540px },
  segments: [
    cubicTo(
      control1: { x: 520px, y: 120px },
      control2: { x: 1400px, y: 120px },
      to: { x: 1800px, y: 540px }
    )
  ],
  closed: false
);

Path(geometry: route, stroke: #ff5a36, width: 6px);
MotionPath(geometry: route, progress: 0%, orientToPath: true) as subject {
  Circle(radius: 24px, fill: #ff5a36);
}
animate subject.progress from 0% to 100% over 2s ease outCubic;
```

## Executable contract

```text
MotionPath(
  points?: List<Vec2>,
  geometry?: PathGeometry,
  progress?: Ratio = 0%,
  closed?: Boolean = false,
  orientToPath?: Boolean = false,
  x?: Length,
  y?: Length,
  anchorX?: Length,
  anchorY?: Length,
  scale?: Number,
  skewX?: Angle,
  skewY?: Angle,
  rotation?: Angle,
  opacity?: Ratio
) { exactly one Visual child }
```

Exactly one of `points` and `geometry` is required. Supplying both or neither
fails at the source with `CUT_MOTION_PATH_GEOMETRY`; hostile loaded IR fails
with the same stable runtime code.

- `points` contains 2 through 1,024 closed `{ x: Length, y: Length }`
  values. Coordinates are absolute canvas pixel coordinates. Every coordinate
  is bounded to ±65,536 px and the path is bounded to 16,777,216 px of
  cumulative length.
- Coincident segments are skipped. A path whose every segment is coincident is
  refused instead of accepting motion controls that cannot affect output.
- `progress` is a signal-driven `Ratio`. It samples cumulative Euclidean arc
  length, not point index, so equal progress advances equal distance along the
  polyline. `0%` selects the first point and `100%` selects the last point.
- With `closed: true`, one final segment joins the last point to the first;
  `100%` therefore returns to the first point.
- `geometry` accepts either the closed `VectorPathGeometry` record built by
  `vectorPath(start:, segments:, closed:)` or versioned
  `AnchoredPathGeometry` built by `anchoredPath(...)`. Resolved line/cubic
  segments execute the same bounded adaptive flattening, cumulative lengths
  and terminal tangents used by retained `Path`.
- `PathGeometry` owns its `closed` state. Authoring `closed:` alongside
  `geometry:`—even `closed: false`—fails rather than accepting an ignored
  argument. `closed:` remains valid only for the legacy `points:` form.
- Geometry inherits the closed vector-path limits: 1 through 256 authored
  line/cubic segments, at most 65,536 flattened points, coordinates inside
  ±65,536 px, and no zero-length or redundant closed segment. MotionPath also
  applies its 16,777,216 px total-arc work limit after flattening.
- `orientToPath: true` adds the selected nonzero segment's screen-coordinate
  tangent to the authored `rotation`. Positive angles are clockwise because
  canvas y increases downward. At an exact internal vertex, CUT selects the
  incoming segment; this boundary rule is deterministic.
- Do not author `closed: false` on the points form or `orientToPath: false` on
  either form. Both are exact defaults and fail with `CUT_MOTION_PATH_NOOP`
  rather than being accepted as ignored controls.
- Authored `closed: true` and `orientToPath: true` are also checked against
  their omitted/default counterfactual on exact reachable output-frame times.
  Each control must change position or executed tangent orientation on at least
  one frame. The proof examines at most 4,096 frames per control; if no change
  is found before that bound, CUT fails closed with `CUT_MOTION_PATH_LIMIT`
  instead of accepting an unproved argument.
- `x`/`y` add an offset after the sampled canvas position. The common retained
  transform then applies `anchorX`/`anchorY`, scale, simultaneous two-axis
  skew, tangent plus authored rotation, destination placement and opacity.
- The sampled point translates a canvas-centred child for the ordinary
  materialized-shape path, so ordinary shapes retain their established centred
  defaults. An exact unary retained chain ending in `Path(geometry:)` instead
  establishes a real MotionPath subject-local origin: Path coordinate
  `(0px, 0px)` lands on the sampled point, and tangent/authored transforms are
  composed around that local origin. No canvas-half `Group` shim is needed, so
  reusable vector symbols survive aspect and canvas changes. This semantic is
  generic to eligible retained VectorPath subjects. A separate bounded
  `LocalSpace` child may now supply a multi-child local Rect/Circle/Path/Group
  or locked-font Text/FlowText subject through the same registration point;
  media, mask/effect/layout and other local descendants remain explicit gaps.
  Exactly one
  MotionPath may occur in one retained affine chain. Nested MotionPaths keep an
  ordinary materialization boundary between the two subjects; hostile attempts
  to forge a double-basis retained chain fail `CUT_RETAINED_PATH_CHAIN`.
- Allocation preflight evaluates every nonzero path-segment tangent composed
  with the initial retained transform. The runtime revalidates each executed
  tangent plus dynamic transform value immediately before creating a pixel
  intermediate, so orientation cannot bypass the shared axis/pixel budget.
- Exactly one visual child is required. Use an ordinary `Group` inside it when
  multiple shapes should travel together.

## MotionPath as a LocalSpace descendant

An ordinary `MotionPath` may be nested inside `LocalSpace`; this is distinct
from the older owner form in which MotionPath moves one complete LocalSpace
tile. Both legacy `points:` and `VectorPathGeometry` use the authored local
pixel-edge basis. Exact progress and tangent are sampled first, the point is
converted through the LocalSpace's Q16-derived raster origin, and tangent
orientation plus the authored transform/opacity stack is applied. The moving
subject is then clipped to the declared half-open local tile and source-over
composited before the outer retained owner runs. Nested components lower to the
same public fragment/group/shape path.

All normal MotionPath geometry, coordinate, arc-work and transform bounds
remain active, alongside LocalSpace tile and execution-domain bounds. The
strict loader and runtime independently refuse `AnchoredPathGeometry` here:
owner-resolved composition coordinates do not define an ordinary local basis,
and no delivery-canvas fallback is permitted.

Inspect keeps the established top-level centre-relative
`executedAtActiveStart` unchanged. The local branch additionally exposes an
identity-bound `localExecution.authoredLocalAtActiveStart`, dimensions,
Q16 origin, transform order, half-open clipping/source-over policy and tile
semantic identity. Focused tests require changing pixels, nested-component
composition, orientation/opacity behavior, hostile-input refusal and
byte-identical out-of-order `4 -> 0 -> 2 -> 4` seeking.
`examples/local-motion-path-camera.cut` is the unrelated public retained-camera
fixture. Neither it nor the pending film prototype is a creative pass.

### AnchoredPathGeometry motion

With `AnchoredPathGeometry`, one or more spatial points come from
`visualAnchor(owner:, local:)`; raw `Vec2` points remain composition-space
pixels and `compositionOffset(point:, by:)` adds a composition-space offset.
The owner contract is identical to retained Path. Retained-affine v1 accepts a
same-module, earlier-bound, same-scope visual with exactly one validated
LocalSpace and one of the owner kinds `scene-root`, `component-fragment`,
`group`, `camera-2d`, or `track-2d`. Additive v2 also accepts a direct
scene-root `MediaCamera2D`; for that owner, `local` is an exact fractional
post-crop source pixel centre in `[0, width - 1] x [0, height - 1]`, resolved
through the camera frame's admitted Q16 affine before opacity. It reuses the
same camera plan without another decode, grade, preraster, or resample.
The `MotionPath` consumer itself remains in root composition space. A nested
LocalSpace consumer, projective owner, MotionPath owner, or stacked local
basis is refused.

Progress and optional tangent orientation are evaluated only after every owner
has an exact placement at the output frame. Opacity-zero owners retain their
coordinates. A Track2D `hold` policy supplies the held placement, `hide`
suppresses the complete moving subject for that frame, and `fail` aborts.
Owner-aware preflight proves bounded flattened work and any
`orientToPath: true` effect before dependent subject pixels are allocated.

`cut inspect --json` uses the anchored preparation path rather than attempting
legacy MotionPath decoding. It reports validated owner bindings, authored
plan and controls, structural budget inputs, and
`requiresExactOwnerPlacement: true`. It does not publish a sampled point,
tangent or placement matrix without renderer evidence. Owner placement/local
basis and geometry participate in localized cache identity. Anchored v1 does
not support geometry morphing. The MediaCamera2D binding is source-coordinate
attachment, not content tracking, feature extraction, projective motion, or a
promise of creative quality.

The reference implementation validates every static and signal value before
rendering. Accepted controls participate in typed IR, inspect content hashes,
semantic diff, build identity and normal scene-cache identity. The test suite
checks shared Path/MotionPath IR and flattened geometry, the arc-length sampler,
typed animation, exact frame-12 midpoint, rendered positions, closed paths,
tangent orientation, authored transform composition, hostile loaded IR,
source locations, bounded exact control counterfactuals, responsive local
VectorPath subjects, work limits, child cardinality and audio-local cache
behavior.

For repeated timing, `@cut/motion` also exports
`stagger(index: Number, each: Time, offset?: Time = 0s) -> Time`. It is a pure
compile-time helper: `stagger(index: item.index, each: 3f)` reduces to the exact
rational time `item.index * 3f`, so it can feed ordinary `delay` or `at`
positions without leaving a runtime call in CutAVIR. The index must be an exact
integer from 0 through 4,095, `each` must be positive, and `offset` must be
non-negative; violations fail at the source call with `CUT_MOTION_STAGGER`.
This is deterministic timing arithmetic, not a hidden layout or choreography
planner.

## Stable diagnostics

| Code | Meaning |
| --- | --- |
| `CUT_MOTION_PATH_TYPE` | A point, progress value, boolean or attached signal has the wrong typed shape. |
| `CUT_MOTION_PATH_RANGE` | A coordinate or progress value is outside its closed range. |
| `CUT_MOTION_PATH_SHAPE` | A point is not a closed `Vec2`, or the path has no positive-length segment. |
| `CUT_MOTION_PATH_GEOMETRY` | Neither or both path forms were supplied, `closed:` was authored with geometry, or typed geometry is malformed/ineffective. |
| `CUT_MOTION_PATH_NOOP` | An explicit boolean is the default, or an opt-in control never differs from its omission counterfactual on any exact reachable output frame. |
| `CUT_MOTION_PATH_LIMIT` | Point count, cumulative arc length or the 4,096-frame control-effect proof bound exceeds the work budget. |
| `CUT2085` / `CUT_NODE_NOOP` | The wrapper does not contain exactly one visual child. |

## Honest current boundary

This slice supports legacy polyline points plus line/cubic typed geometry and an
exact stagger-time helper. Cubics use CUT's locked bounded adaptive flattening;
they are not an analytic arc-length solver. Editable spatial tangents,
automatic banking, per-segment temporal easing, 3D paths and tracked-path
authoring remain missing. Public `progress` easing provides deterministic
temporal easing across the complete shared arc. MotionBlur can wrap eligible
motion-path content through its documented retained/runtime boundaries, but
MotionPath does not silently synthesize blur. The bounded LocalSpace slice is a
separate materialization path and does not imply local media, masks, effects,
layout, cameras, tracking, or precompositions. Missing operations remain explicit
rather than being approximated behind a second renderer.
