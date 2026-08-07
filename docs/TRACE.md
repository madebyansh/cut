# Deterministic path tracing

`Trace` is a general `cut:visual` kernel for drawing an open polyline or cubic-
Bezier chain over time. It has no route, map, signal, or project-specific
meaning.

```cut
import { Trace } from "cut:visual";

Trace(
  points: [{ x: 80px, y: 120px }, { x: 420px, y: 120px }, { x: 520px, y: 260px }],
  stroke: #22d3ee,
  width: 5px,
  duration: 1200ms,
  delay: 200ms,
  headRadius: 8px,
  headColor: #ffffff,
  headFade: 120ms,
  easing: "outCubic"
);
```

For controlled curvature, author one start point and typed `cubicTo` records.
`traceArrow` adds a persistent triangular marker at the revealed endpoint:

```cut
import { Trace, cubicTo, traceArrow } from "cut:visual";

Trace(
  start: { x: 80px, y: 260px },
  curves: [
    cubicTo(
      control1: { x: 180px, y: 80px },
      control2: { x: 420px, y: 80px },
      to: { x: 540px, y: 240px }
    )
  ],
  stroke: #ed5b3a,
  width: 5px,
  duration: 1200ms,
  arrow: traceArrow(length: 16px, width: 12px, color: #ed5b3a)
);
```

Exactly one geometry form is legal: `points`, or the complete `start` plus
`curves` pair. The two forms cannot be mixed. A cubic list contains 1–256
closed `CubicPathSegment` values created by
`cubicTo(control1: Vec2, control2: Vec2, to: Vec2)`. `cubicTo` and
`traceArrow(length: Length, width: Length, color: Color)` are pure record
constructors: they disappear into ordinary typed IR and do not conceal helper
nodes or another renderer.

Timing is local to the node. Nothing is drawn before `delay`. From `delay`
through `delay + duration`, CUT reveals a prefix measured against the
prepared geometry's cumulative Euclidean arc length, so unequal segments and
corners do not change speed. The optional legacy circular head uses the exact
prefix endpoint. After completion the entire stroke remains; only that circle
fades linearly over `headFade`. A zero `headRadius` disables the circle and its
fade does not extend the required interval.

The alternative `arrow` moves at the revealed endpoint and follows the unit
tangent of the displayed terminal segment. It remains at the final tangent
after completion so direction is not lost. `arrow` and a positive
`headRadius` are mutually exclusive. `headColor` and `headFade` continue to
belong only to the legacy circle and are rejected when they cannot execute.

Delay, completion, and head-fade boundary decisions use CUT's exact rational
time values. They are not rounded through JavaScript `Number`; a legal
sub-frame delay therefore cannot begin one frame early, and any positive fade
includes the exact completion instant.

`duration` must be positive. `delay` and `headFade` cannot be negative, and the
complete draw plus any enabled head fade must fit the owning interval. `Trace`
inherits the `Path` geometry envelope: 2–4096 closed `{ x: Length, y: Length }`
points, coordinates within ±65536px, and width above 0px and at most 4096px.
The same coordinate envelope applies to cubic starts, controls and endpoints.
`headRadius` is 0–4096px; arrow length and width are above 0px and at most
4096px. Colors are canonical CUT colors.

## Cubic flattening contract

The CPU renderer uses version 1 deterministic De Casteljau subdivision. A
segment is accepted only when both its control-to-chord distance and control-
polygon excess satisfy the fixed local tolerance. The local tolerance is
`0.35px / 64`, preserving a maximum 0.35px geometry envelope for Trace's own
largest legal direct scale. Collinear overshoot/backtracking therefore cannot collapse
to one chord. Subdivision is bounded to depth 14, 65,536 flattened points per
Trace and 256 authored cubic segments; inability to satisfy the local tolerance
fails with `CUT_TRACE_LIMIT` instead of drawing coarse geometry.

That 0.35px statement is deliberately not a final-composition guarantee after
an ancestor `Group`, `Stack`, `Composite` or other retained wrapper scales the
already rasterized Trace surface. Nested transforms can magnify both geometry
and raster error. Nested output remains deterministic and tested, but final-
space adaptive flattening awaits retained local bounds and is a documented
limitation rather than a larger quality claim.

Arc-length reveal and arrow orientation both use that one prepared polyline.
The authored cubic controls—not derived samples—remain canonical IR and cache
identity. The implementation version is covered by the locked built-in package
identity. `cut inspect --json` reports geometry kind, authored segment count,
flattened point count, total prepared length, flattening version and arrow
contract.

## Retained LocalSpace execution

The same public `Trace` node can be an ordinary descendant of
`LocalSpace(width:, height:, origin:)`. Both polyline and cubic geometry keep
their authored local coordinates. CUT translates them by the LocalSpace's one
Q16-derived raster origin, clips them to the declared half-open local tile, and
only then lets the public LocalSpace owner place, track, project or composite
that tile. This is a dedicated retained-local raster path: it never creates a
delivery-canvas Trace and crops it back into the tile.

Delay, cumulative-arc-length reveal, easing, the optional fading circle and the
persistent terminal-tangent arrow are identical to direct Trace execution.
Before `delay`, the local path returns no surface and bypasses SVG raster plus
the local transform pass. Once visible, ordinary Trace x/y/scale/rotation and
opacity properties execute after the local drawing, inside the same bounded
tile. `cut inspect --json` identifies the owning LocalSpace, dimensions, exact
raster-origin phase, clipping rule, algorithm version and local-tile semantic
identity.

Admission prepares geometry before pixels are allocated. Across concurrently
renderable LocalSpaces in one scene/composition execution domain, at most
65,536 prepared Trace points may be visited per frame. This is in addition to
the existing per-Trace and per-composition point-frame limits and LocalSpace
pixel-pass/RGBA limits. Exceeding it fails source-located with
`CUT_LOCAL_SPACE_LIMIT`; unsupported local descendants still fail with
`CUT_LOCAL_SPACE_UNSUPPORTED` rather than falling back to the delivery canvas.
The local tile cache identity recursively includes Trace source/IR meaning,
exact frame time and backend identity, so a Trace edit invalidates its owning
tile and scene while an unrelated scene remains reusable.

An ordinary `MotionPath` may also be a LocalSpace descendant. Its
`VectorPathGeometry` coordinates are authored against the same declared local
origin as shapes and Trace. CUT samples progress and tangent at exact time,
translates the subject into the retained raster using the exact Q16 origin,
applies authored motion-path transforms, clips to the half-open tile, and
source-overs the result before any outer camera/track/projective placement.
`cut inspect --json` keeps the legacy top-level centre-relative
`executedAtActiveStart` unchanged and separately reports
`localExecution.authoredLocalAtActiveStart`, the local coordinate basis,
transform order, tile identity and no-fallback contract. The local-path
algorithm and node set are part of LocalSpace semantic and per-frame tile
identity. Owner-resolved `AnchoredPathGeometry` remains source-located
unsupported inside an ordinary LocalSpace.

The easing input is intentionally a closed string set: `"linear"`,
`"inCubic"`, `"outCubic"`, and `"inOutCubic"`. CUT's broader nominal `Easing`
family also names parameterized spring and cubic-Bezier values that this kernel
does not yet execute; accepting that type here would overstate the reference
contract.

`opacity`, `scale`, and `rotation` are optional call inputs. Loaded IR must keep
their canonical units (`ratio`, `scalar`, and `deg`) and ranges: opacity 0–1,
scale 0.001–64, and rotation within ±360000 degrees. Canonical loaded angles
are always degrees; the compiler converts authored radians with the fixed CUT
conversion. `x` and `y` remain post-bind properties, matching their execution
as a whole-layer transform rather than changing the authored point coordinates,
and are bounded to ±65536px:

```cut
Trace(points: points, stroke: #22d3ee, width: 4px, duration: 1s) as line;
set line.x = 24px;
animate line.y from 0px to 40px over 1s;
```

Named `x`/`y` call inputs are therefore rejected. This kernel intentionally
does not close or fill a path, infer control points, interpret prose, or choose
timing. Dash/trim animation and path morphing are not part of this slice.

The runtime validates every direct or signal-produced transform value before
rendering, including step points, keyframes, sets, and both ends of animations.
A track's initial `null` is the one deliberate exception: it means “use the
authored/default transform until the first future write.” Strings and wrong-unit
quantities never silently become defaults.

Trace geometry is prepared once per reachable node: cumulative segment lengths
are cached and each frame locates its endpoint by binary search. A completed
stroke is also cached while the optional circle fades or the arrow persists. To keep
legal two-hour inputs from turning into unbounded work, the reference runtime
charges `prepared point count × ceil(active interval × composition fps)`, with limits of
25,000,000 point-frames per Trace and 100,000,000 across reachable Traces in one
composition.

Stable diagnostics are `CUT_TRACE_GEOMETRY` for malformed, mixed or degenerate
geometry, `CUT_TRACE_ARROW` for malformed/conflicting endpoint markers and
`CUT_TRACE_LIMIT` for bounded-flattening/resource refusal. Typed-source errors
carry the authored span; hostile loaded-IR errors carry node id and original
module, line and column. Retained-local graph/work refusal uses the
source-located `CUT_LOCAL_SPACE_*` family described above.
