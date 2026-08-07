# Retained vector paths

Status: executable pre-1.0 vertical slice. Public source, checker, compiler,
strict IR loader, typed runtime, exact-time renderer, diagnostics, inspect,
semantic diff/cache identity, and pixel tests are implemented. The reference
studies and complete creative review still fail, so this is not a CUT 1.0 or
professional-output claim.

## Public shape

The additive API preserves the existing `Path(points:, stroke:,
width:, ...)` positional order and pixel contract. New authoring uses pure,
typed geometry values:

```cut
import { Path, cubicTo, lineTo, vectorPath } from "cut:visual";

const resting = vectorPath(
  start: { x: 80px, y: 220px },
  segments: [
    lineTo(to: { x: 180px, y: 220px }),
    cubicTo(
      control1: { x: 240px, y: 220px },
      control2: { x: 280px, y: 120px },
      to: { x: 360px, y: 120px }
    )
  ],
  closed: false
);

const answering = vectorPath(
  start: { x: 80px, y: 260px },
  segments: [
    lineTo(to: { x: 180px, y: 260px }),
    cubicTo(
      control1: { x: 240px, y: 260px },
      control2: { x: 300px, y: 180px },
      to: { x: 400px, y: 180px }
    )
  ],
  closed: false
);

Path(
  geometry: resting,
  morphTo: answering,
  morph: 0%,
  stroke: #ed5b3a,
  width: 4px,
  trimStart: 0%,
  trimEnd: 35%,
  dash: [12px, 7px],
  dashOffset: 0px,
  lineCap: "round",
  lineJoin: "round"
) as route;

animate route.trimEnd from 35% to 100% over 700ms ease outCubic;
animate route.dashOffset from 0px to 24px over 700ms ease linear;
animate route.morph from 0% to 100% over 900ms delay 700ms ease inOutCubic;
```

`lineTo(to:)`, the existing `cubicTo(control1:, control2:, to:)`, and
`vectorPath(start:, segments:, closed:)` are pure compile-time record
constructors. They lower to ordinary typed IR values. They do not create helper
nodes, read files, select timing, or conceal a second renderer. A path geometry
is reusable in constants, functions, components, and public packages.

The segment list is a closed typed union. A line record contains exactly `to`;
a cubic record contains exactly `control1`, `control2`, and `to`. A retained
geometry contains exactly `start`, `segments`, and `closed`. Unknown or extra
fields fail rather than becoming ignored metadata.

## Owner-resolved geometry

`AnchoredPathGeometry` is the additive owner-resolved member of
`PathGeometry`. It lets a path endpoint follow an exact point in another
retained visual's authored local coordinate system without copying that
visual's placement into path source:

```cut
import {
  LocalSpace, Rect, Path,
  visualAnchor, compositionOffset,
  anchoredLineTo, anchoredCubicTo, anchoredPath
} from "cut:visual";

LocalSpace(width: 160px, height: 90px, origin: { x: 80px, y: 45px }) as label {
  Rect(width: 160px, height: 90px, fill: #19233a);
}

Path(
  geometry: anchoredPath(
    start: visualAnchor(owner: label, local: { x: 0px, y: 0px }),
    segments: [
      anchoredCubicTo(
        control1: { x: 640px, y: 180px },
        control2: compositionOffset(
          point: visualAnchor(owner: label, local: { x: 40px, y: 0px }),
          by: { x: 32px, y: 0px }
        ),
        to: visualAnchor(owner: label, local: { x: 40px, y: 0px })
      )
    ],
    closed: false
  ),
  stroke: #ed5b3a,
  width: 4px
);
```

The public constructors are closed and versioned:

- `visualAnchor(owner: Visual, local: Vec2) -> VisualAnchor` binds one local
  pixel point to a previously bound visual node;
- `compositionOffset(point: SpatialPoint, by: Vec2) -> SpatialPoint` applies
  an exact composition-pixel offset after owner placement;
- `anchoredLineTo(to:)` and `anchoredCubicTo(control1:, control2:, to:)`
  construct the anchored segment union; and
- `anchoredPath(start:, segments:, closed:) -> AnchoredPathGeometry` constructs
  one path containing at least one `visualAnchor`. A raw `Vec2` remains a
  legal composition-space `SpatialPoint`.

An anchor owner must be bound earlier in the same source module, share the
consumer's reachable scene/composition scope, and contain the consumer
interval. Retained-affine v1 owners expose exactly one validated `LocalSpace`;
v1 accepts only `scene-root`, `component-fragment`, `group`, `camera-2d`, and
`track-2d`. The anchor's local point must lie inside that LocalSpace's closed
authored view. The consuming `Path` is authored in root composition space; a
Path nested under another LocalSpace is refused so two local bases cannot
silently accumulate.

Owner placement is sampled at each exact render time. Opacity zero does not
erase position: an opacity-zero owner still resolves its anchor coordinates.
For a `Track2D` owner, `hold` resolves the held placement, `hide` suppresses
the complete dependent geometry with explicit zero work, and `fail` aborts
the render. `cut inspect --json` validates the owner bindings and reports
geometry, plan, paint, controls and structural work, but deliberately reports
`requiresExactOwnerPlacement: true` and does not invent coordinates before the
renderer's owner-aware preflight.

Anchored geometry participates in semantic diff and cache identity. Its
consumer cache binds the exact geometry and only the owner's placement/local
basis identity needed to resolve it; unrelated owner paint does not masquerade
as geometry. V1 does not support `morphTo`/`morph`, projective owners such as
`PlanarTrack`, a `MotionPath` as the anchor owner, a consumer nested under
LocalSpace, or multiple stacked local/projective bases. Those cases fail
explicitly rather than falling back to composition guesses. This is an
executable pre-1.0 slice, not a general tracking, perspective or creative
quality claim.

### MediaCamera2D source-pixel anchors v2

A second, additive owner binding accepts a direct scene-root
`MediaCamera2D` without manufacturing a `LocalSpace`. The same public source
shape is used:

```cut
MediaCamera2D(focusX: 35%, zoom: 1.3) as footageCamera {
  Image(source: still, fit: "cover");
}

Path(
  geometry: anchoredPath(
    start: visualAnchor(
      owner: footageCamera,
      local: { x: 640.5px, y: 287px }
    ),
    segments: [anchoredLineTo(to: { x: 1700px, y: 160px })],
    closed: false
  ),
  stroke: #ffcc33,
  width: 4px
);
```

Here `local` is the locked post-crop source pixel-centre basis, with exact
fractional coordinates and closed bounds `[0, width - 1] x [0, height - 1]`.
The runtime applies the exact camera frame's Q16 source-to-composition affine
before camera opacity. It reuses the admitted camera plan and performs no
second decode, grade, fitted raster, composition preraster, or resample.
Image and Video leaves share this coordinate contract.

Focus, zoom, rotation, crop, fit and delivery dimensions participate in
spatial identity. Opacity and audit-only media/grade receipts cannot poison
resolved geometry identity when the affine is unchanged. Inspect reports the
locked source basis; completed frames publish the closed anchored-path v2
evidence branch. LocalSpace v1 evidence and identities remain unchanged.

This binding does not follow content inside a frame. It is not tracking,
feature extraction, a planar/projective correspondence, or a subject-aware
annotation system. Projective owners and automatic callout placement remain
explicitly unsupported.

## Topology and morphing

`morphTo` and `morph` are a pair. The source and target must have:

- the same open/closed state;
- the same number of authored segments; and
- the same line-or-cubic kind at every segment index.

CUT linearly interpolates the corresponding start, control, and endpoint
coordinates at the exact signal-produced `morph` Ratio. It then runs the one
versioned bounded cubic-flattening algorithm on that intermediate geometry.
Changing a line into a cubic, changing closure, adding a point, or removing a
segment is not guessed: it fails with `CUT_VECTOR_PATH_TOPOLOGY` at the Path's
source location. Identical source/target geometry and static 0%/100% morph
endpoints are rejected as no-ops.

Morphing guarantees correspondence, not artistic interpolation. Authors or
packages remain responsible for placing compatible control points so the
in-between shape does not self-intersect, collapse, or leave the intended
frame. Every rendered frame is still bounded and validated.

## Trim and dash metric

`trimStart` and `trimEnd` are exact Ratios over the current geometry's complete
cumulative Euclidean arc length. They satisfy `0% <= trimStart <= trimEnd <=
100%` at every execution sample. `trimStart == trimEnd` is legal only when a
trim property is genuinely dynamic inside the Path's active interval. For a
stroke-only Path that exact state is explicitly transparent; it emits no
fragment or SVG, allocates no retained raster, performs no placement pass, and
may subsequently reveal. A static equal range remains `CUT_VECTOR_PATH_TRIM`
because it would permanently discard the stroke. `trimStart > trimEnd` always
fails. The boundary points are interpolated on the selected flattened segment;
CUT does not round the authored ratios to frames or vertex indices.

`dash` is a static list of 1–32 positive Lengths. Every entry is 0.25–4096px.
An odd authored list is canonically repeated in full to become even: `[6px,
3px, 2px]` executes as `[6px, 3px, 2px, 6px, 3px, 2px]`. The complete period
cannot exceed 65536px. Even entries are visible spans and odd entries are gaps.
`dashOffset` is an animatable Length within ±65536px. Positive offset advances
the pattern phase along the path. Runtime phase is canonical modulo the dash
period; a control whose active states are all equivalent to zero modulo that
period is rejected as a no-op.

Dash phase is measured from the untrimmed geometry start. Trimming therefore
reveals the same already-phased stroke instead of restarting the dash pattern
at the trim boundary. CUT materializes explicit visible polylines after
arc-length slicing; it does not pass a semantic SVG `stroke-dasharray` through
to an external renderer.

`morph`, `trimStart`, `trimEnd`, and `dashOffset` are signal-compatible public
properties. Static inputs supply their initial state. Exact output-frame
preflight catches crossed trim boundaries or eased/spring overshoot before a
pixel surface is allocated and proves that at least one exact active output
frame has visible paint. A dynamic stroke visible only between output frames is
conservatively rejected; shutter-subframe-only visibility does not satisfy this
non-inertness proof. Accepted static defaults that cannot affect pixels are
rejected as no-ops. Cache dynamism is also derived structurally from every
nonconstant signal interval overlapping the Path, rather than inferred only
from a few sampled values. A sharply delayed `cubicBezier` therefore remains
dynamic at exact motion-blur shutter subframes even when ordinary probes are
numerically close to its starting value.

## Open, closed, stroke, and fill

Legacy `points` remains an open polyline with the established default white
4px round stroke. Exactly one of `points` or `geometry` is legal; legacy points
cannot be a morph source.

A retained open path can be stroked but not filled. A retained closed path adds
one implicit final segment from its last endpoint to `start`; authors must not
repeat `start` as the last endpoint. Closed paths may use `fill` with
`fillRule: "nonzero" | "evenodd"`. `lineCap` is `"butt" | "round" |
"square"`; `lineJoin` is `"miter" | "round" | "bevel"`.

At least one visible paint must exist. If `fill` is absent, omitted `stroke`
keeps the legacy white-stroke default. If `fill` is present, omitted `stroke`
means fill-only. Fully transparent paint is rejected; omit it instead. Width,
dash, dash offset, trim, caps, and joins require a stroke. Trim is stroke-only:
a node may combine a complete closed fill with an independently trimmed and
dashed stroke. Trim never cuts the fill, so CUT does not invent a fill closure
across an animated open stroke fragment. At an exact dynamic zero-length trim,
a valid closed fill remains fully visible while only its stroke disappears.

The current working contract supports one subpath per retained geometry.
Compound paths and boolean path construction remain future work.
Closed fill coverage is validated under the authored fill rule after
deterministic flattening. Collinear and exactly retraced boundaries fail;
`evenodd` self-intersections such as a bow-tie are accepted when they contain
visible odd-winding lobes, while a twice-wound even-odd void fails. A nonzero
trim range whose dash phase emits no positive-length stroke still fails instead
of producing an empty SVG group. The only accepted empty stroke state is an
exact equal boundary on a genuinely dynamic trim range.

## Determinism and bounds

Retained paths share Trace's versioned De Casteljau cubic flattening: fixed
`0.35px / 64` local tolerance, maximum depth 14, at most 256 authored segments,
and at most 65,536 flattened points per frame. Direct coordinates remain within
±65536px. Stroke width is positive and at most 4096px. Dash fragmentation and
authored-segment/frame work have explicit per-node and per-composition limits.
Failure to meet a tolerance or work bound is `CUT_VECTOR_PATH_LIMIT`, never a
coarser fallback.

CUT owns geometry decoding, topology correspondence, morph interpolation,
flattening, arc-length trim, dash phase, and explicit dash segmentation. The
locked Sharp/libvips SVG surface remains low-level raster infrastructure for
the normalized paths, caps, joins, and fills. Its dependency/native identity is
part of the reference backend identity. This is semantic determinism under a
locked backend/toolchain, not a cross-platform byte-determinism claim.

One exact unary retained chain now avoids that historical full-canvas boundary.
A retained `Path` leaf may sit below any one-child nesting of `Group`,
`Camera2D`, `MotionPath`, and prepared `Track2D`. CUT samples every public
transform at the exact composition time, composes the affine matrices outer
after inner, multiplies opacity once, and keeps trim/dash arc length in Path
local space. When MotionPath owns the exact chain, it establishes a
subject-local coordinate basis: Path `(0px, 0px)` is the sampled path point,
without an authored canvas-half translation. The basis uses the actual
composition dimensions, participates in the composed inspect matrix, and is
bound by the versioned retained-chain cache algorithm. A retained chain may
contain at most one MotionPath; nested MotionPaths preserve an ordinary
materialization boundary so two implicit local bases can never accumulate.
CUT computes
conservative local and final-space paint bounds,
rasterizes the normalized vector once into the tight final-space viewport, and
performs one integer placement copy. Off-canvas local geometry can therefore be
moved into view without prior clipping, and cancelling nested translations or
scales do not introduce intermediate resampling. The retained cache key binds
the semantic chain, exact time, composed matrix, final raster bounds, canvas,
world bounds, algorithm, and Sharp/libvips backend identity. `cut inspect
--json` exposes the matrix, bounds, work, rasterization count, placement count,
opacity, cache digest, and materialization boundaries. A transparent-trim frame
reports `frameVisibility: "transparent-trim"`, zero raster/placement work, a
stable semantic frame digest, and `cacheDisposition: "transparent-bypass"`;
because no pixels are rasterized, it intentionally has no raster-cache digest
or raster bounds.

This is intentionally a narrow first compositor slice, not a general
retained-scene claim. Multi-child containers, effects (including
`MotionBlur` itself), masks, clipping paths, stacks, non-normal blends and
precompositions still materialize. They may contain an eligible retained child
below that boundary. `MotionBlur` samples that child chain independently at
each exact shutter time. Other visual leaf types still use their established
surface path. Arbitrary LocalSpace/tight materialization, Path-local crop and
perspective are not implemented, and cubics
are still flattened in local space before the affine rather than adaptively in
final space. Eligible retained geometry deliberately changes from repeated
raster resampling to one locked-backend vector raster; legacy `Path(points:)`
bytes and all non-eligible materializing paths remain on the old branch.

## Stable diagnostic families

- `CUT_VECTOR_PATH_GEOMETRY`: malformed, mixed, redundant, or degenerate path;
- `CUT_VECTOR_PATH_TOPOLOGY`: unsafe or inert morph contract;
- `CUT_VECTOR_PATH_PAINT`: invalid/inert stroke, fill, cap, join, or fill rule;
- `CUT_VECTOR_PATH_TRIM`: invalid or crossed executed trim state;
- `CUT_VECTOR_PATH_DASH`: malformed, inert, or unpaired dash controls;
- `CUT_VECTOR_PATH_SIGNAL`: wrong signal type/unit/range or missing signal;
- `CUT_VECTOR_PATH_LIMIT`: coordinate, flattening, fragmentation, or work bound.

Owner-resolved v1 additionally uses `CUT_ANCHORED_PATH_TYPE`/`SHAPE` for a
malformed closed value, `REFERENCE`/`GRAPH` for missing or invalid ownership,
`RANGE` for interval/local-view bounds, `LIMIT` for bounded work,
`UNSUPPORTED` for an excluded coordinate basis, `RESOLUTION` for failed exact
placement, and `CUT_ANCHORED_PATH_MORPH` for the explicit v1 morph exclusion.

`cut inspect --json` reports geometry kind, open/closed state, ordered
segment topology, authored/flattened counts, flattening version, morph target,
arc-length trim contract, canonical dash pattern/phase origin, paint, and the
attached property names plus their signal IDs and content hashes. It also
reports whether trim is dynamic, active-start paint visibility, the executed
active-start values, and the actual static `morph`,
`trimStart`, `trimEnd`, and canonical `dashOffsetPx` values when those controls
are not structurally dynamic. Ordinary node/signal hashes make every geometry
coordinate and property track part of semantic diff and localized cache
identity.
