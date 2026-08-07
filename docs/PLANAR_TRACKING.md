# Locked planar-track playback and projective composition (0.4 alpha)

Status: executable, bounded pre-1.0 engineering slice. This is not an
automatic tracker and it is not creative-review evidence.

`PlanarTrack` projects exactly one directly owned `LocalSpace` tile through a
strict, content-locked four-corner observation stream. The observation file is
data only: it cannot contain CUT source, JavaScript, filters, renderer
instructions, a hidden production graph, or project-specific compiler logic.

```cut
import { LocalSpace, Mask, PlanarTrack, Rect } from "cut:visual";

asset plane: DataAsset = data("evidence-plane.planar.json");

PlanarTrack(
  source: plane,
  minConfidence: 75%,
  lowConfidence: "hold",
  occluded: "hold",
  outOfFrame: "hide",
  interpolation: "linear",
  opacity: 100%
) as tracked {
  LocalSpace(width: 640px, height: 360px, origin: { x: 0px, y: 0px }) {
    Mask(mode: "alpha", feather: 2px) {
      // Replacement art: first child.
      Rect(width: 640px, height: 360px, x: 320px, y: 180px, fill: #f3ead7);
      // Manual plane-local visibility coverage: second child.
      Rect(width: 520px, height: 360px, x: 260px, y: 180px, fill: #ffffffff);
    }
  }
}

animate tracked.opacity from 0% to 100% over 400ms;
```

The complete public signature is:

```cut
PlanarTrack(
  source: DataAsset,
  minConfidence: Ratio,
  lowConfidence: "fail" | "hold" | "hide",
  occluded: "fail" | "hold" | "hide",
  outOfFrame: "fail" | "hold" | "hide",
  interpolation?: "linear" | "hold" = "linear",
  opacity?: Ratio = 100%
) { exactly one direct LocalSpace }
```

Confidence and all three exceptional-state policies are required. `opacity`
is the only PlanarTrack property that can be animated. PlanarTrack deliberately
has no `x`, `y`, `scale`, `rotation`, `anchor`, `skew`, smoothing, binding, or
solver option: the sampled quadrilateral is the sole authority for projective
geometry. Unknown inputs fail rather than being ignored.

## Graph and coordinate contract

The body must contain exactly one direct `LocalSpace` node and no canvas
siblings, control flow, or direct body-level automation statement. The
PlanarTrack and LocalSpace must have the exact same start and duration. Loaded
IR is checked again, so a forged indirect, shortened, offset, or non-LocalSpace
child fails even if it bypassed source checking.

The LocalSpace's outer pixel-edge rectangle maps to the four named corners:

- `(0, 0)` to `topLeft`;
- `(width, 0)` to `topRight`;
- `(width, height)` to `bottomRight`;
- `(0, height)` to `bottomLeft`.

`LocalSpace.origin` remains the authoring registration for content inside the
tile; it does not translate the sampled quadrilateral. PlanarTrack is a
projective materialization boundary and is intentionally not inserted into the
retained affine Path chain.

The current LocalSpace descendant and retained-media grammar remains the one
documented in [RETAINED_MEDIA_VIEWPORT.md](RETAINED_MEDIA_VIEWPORT.md) and
[LOCAL_COMPOSITING.md](LOCAL_COMPOSITING.md). PlanarTrack adds one deliberately
small contextual guarantee over that existing public grammar:

- at most one `Mask` may appear in the direct PlanarTrack LocalSpace
  compositor (nested LocalSpace islands are separate coordinate contexts);
- that Mask must use `mode: "alpha"` or its identical default;
- child order remains target, then matte; public `invert`, integer-pixel
  `feather`/`expand`, and existing visual transforms/automation continue to
  execute;
- the matte is authored manually in direct plane-local pixels and resolves on
  the bounded LocalSpace tile before any projective sampling;
- no screen-space after-warp mask, hidden roto channel, inferred occlusion, or
  automatic solver exists.

The source and typed IR remain the ordinary public `Mask` node. The contextual
checker and compiled/runtime validators refuse a second Mask or non-alpha mode
with stable source-located diagnostics rather than silently treating it as a
partial-occlusion matte. Other unsupported mattes, clips, effects, layout,
precomposition, or nested camera/tracking forms still fail closed.

## `cut-planar-track` v1 sidecar

The shipped structural schema is
[`schemas/cut-planar-track-v1.schema.json`](../schemas/cut-planar-track-v1.schema.json).
Runtime and lock validation additionally enforce canonical rationals, full
clock coverage, composition binding, projective geometry, resource ownership,
and aggregate work limits.

```json
{
  "format": "cut-planar-track",
  "version": 1,
  "coordinateSpace": "composition-pixel-edges",
  "width": 1920,
  "height": 1080,
  "samples": [
    {
      "at": { "numerator": "0", "denominator": "1" },
      "confidence": { "numerator": "99", "denominator": "100" },
      "status": "visible",
      "corners": {
        "topLeft": { "x": { "numerator": "320", "denominator": "1" }, "y": { "numerator": "180", "denominator": "1" } },
        "topRight": { "x": { "numerator": "1320", "denominator": "1" }, "y": { "numerator": "150", "denominator": "1" } },
        "bottomRight": { "x": { "numerator": "1390", "denominator": "1" }, "y": { "numerator": "820", "denominator": "1" } },
        "bottomLeft": { "x": { "numerator": "280", "denominator": "1" }, "y": { "numerator": "850", "denominator": "1" } }
      }
    },
    {
      "at": { "numerator": "5", "denominator": "1" },
      "confidence": { "numerator": "19", "denominator": "20" },
      "status": "visible",
      "corners": {
        "topLeft": { "x": { "numerator": "430", "denominator": "1" }, "y": { "numerator": "120", "denominator": "1" } },
        "topRight": { "x": { "numerator": "1510", "denominator": "1" }, "y": { "numerator": "210", "denominator": "1" } },
        "bottomRight": { "x": { "numerator": "1450", "denominator": "1" }, "y": { "numerator": "900", "denominator": "1" } },
        "bottomLeft": { "x": { "numerator": "360", "denominator": "1" }, "y": { "numerator": "810", "denominator": "1" } }
      }
    }
  ]
}
```

- `width` and `height` must equal the owning composition. Coordinates are
  exact pixel-edge positions in that composition, not normalized points or
  pixel centers.
- Every rational is a reduced numerator/positive-denominator pair of canonical
  integer strings. Signed zero, duplicate decoded JSON keys, unknown fields,
  malformed UTF-8, and noncanonical fractions fail.
- `at` uses exact node-local seconds. Samples are strictly increasing, begin at
  `0/1`, and end exactly at the PlanarTrack duration. The final observation
  closes the sidecar clock even though rendered node activity remains
  half-open.
- `confidence` is required from zero through one. `status` is exactly
  `visible`, `occluded`, or `out-of-frame`.
- Corners always retain source correspondence in
  `topLeft, topRight, bottomRight, bottomLeft` order. A visible observation
  must quantize to a clockwise, strictly convex, nondegenerate Q16 plane with a
  usable exact homography and a composition pixel-center intersection.
  Non-visible observations retain bounded corners for policy evaluation; CUT
  never treats them as usable geometry merely because coordinates are present.

## Exact sampling and policies

CUT evaluates exact node-local rational time. At an authored timestamp it uses
that observation. Between observations:

- `hold` uses the visible left observation;
- `linear` interpolates all eight corner coordinates as exact rationals only
  when both endpoints are visible and meet `minConfidence`;
- if a linear segment's right endpoint is unusable, CUT holds the current
  usable left plane until the right timestamp instead of moving toward
  untrusted geometry.

At an unusable observation, the matching `lowConfidence`, `occluded`, or
`outOfFrame` policy executes:

- `fail` raises source-located `CUT_PLANAR_TRACK_SAMPLE`;
- `hide` emits a transparent zero-work skip;
- `hold` selects the latest earlier visible sample meeting `minConfidence`.
  If none exists, `CUT_PLANAR_TRACK_HOLD_EMPTY` fails.

An exact evaluated opacity of zero also emits a zero-work skip. Hidden policies
and zero opacity terminate before LocalSpace tile rasterization or projective
allocation. Any other visible sample receives a freshly validated plan for the
actual LocalSpace dimensions.

## Projective execution

Before any root visual executes, the runtime recursively walks the active
scene DAG at the exact frame time. Ordinary wrappers recurse at that time,
MotionBlur expands its already validated shutter samples, shared DAG/time
samples reserve once. `Precomp` and `NestedSequence` whose source graph
contains a PlanarTrack currently fail closed during lowering with
`CUT_PRECOMP_INPUT` or `CUT_NESTED_INPUT`. CUT will not execute nested
projective work until nested receipts have a collision-free composition-instance
path. The aggregate visible PlanarTrack destination and canvas-copy work must
fit the composition-frame budget before any participating LocalSpace tile can
start.

For each admitted visible sample, the reference runtime:

1. materializes the direct LocalSpace once at its declared dimensions,
   including the optional single alpha Mask and all its exact-time local
   transforms;
2. quantizes the sampled quad to Q16 with signed ties matching
   `Math.round` (toward positive infinity);
3. validates order, convexity, edge/area/corner floors, exact homography,
   horizon distance, arithmetic size, source work, and pixel-center-tight
   clipped destination bounds before allocating output;
4. inverse-projects destination pixel centers and performs a zero-extended,
   alpha-associated bilinear read from the straight-RGBA tile; exact integer
   samples preserve source bytes, while fractional transparent RGB is cleared;
5. applies PlanarTrack opacity once after the warp and places the tight result
   on a transparent composition-sized surface for ordinary authored scene
   compositing.

The projective transform is CUT-owned. FFmpeg is not used to invent corner-pin
semantics, and no title- or fixture-specific renderer is involved. The current
reference path is CPU/8-bit SDR and does not claim GPU, HDR, cross-platform
pixel identity, lens-model, rolling-shutter, or production-performance parity.

## Locks, verified sessions, inspect, diff, cache, and receipts

`cut lock` validates PlanarTrack ownership, file sizes, exact sidecar bytes,
schema, dimensions, clock, samples, and visible projective geometry before it
publishes semantic determinism. It pins the ordinary `DataAsset` locator, byte
count, SHA-256, toolchain, package, and runtime identities. Full lock
application and `verifyLockedIrResources` re-read and revalidate the sidecar.
The deferred verified-input path revalidates the sealed private snapshot before
render work; a forged but self-consistent generic byte lock therefore cannot
smuggle invalid PlanarTrack semantics into execution.

A sidecar cannot be reinterpreted by another kernel. Sidecar bytes, authored
policies, interpolation, LocalSpace dimensions/content, runtime algorithms, and
backend identity participate in semantic graph/build/render identity.
Sidecar-only edits change the resource, preparation, sampled-quad, projective
plan, and affected output identities. Local-art-only edits preserve the locked
sidecar/preparation/sample geometry while changing the tile and output. Tests
also prove that either edit leaves an unrelated composition's incremental
render plan untouched.

`cut inspect --json` exposes the static public configuration, policies,
`composition-pixel-edges` coordinate space, direct LocalSpace dimensions and
semantic identity. It intentionally says sampled geometry requires locked
runtime data; inspect is planning evidence, not a fake sidecar sample, rendered
pixel, or creative result.

Completed exact-frame review artifacts expose
`execution.planarTracks[]` in the closed
[`cut-reference-frame` v2 schema](../schemas/cut-reference-frame-v2.schema.json).
A rendered receipt binds source hash/bytes/preparation, exact time and output
frame, policy resolution, opacity, Q16 quad, destination bounds, local tile
identity/hash, projective plan and observed work, tight warped surface,
canvas-copy work, output hash, backend algorithms, and one execution identity.
When the bounded partial-occlusion path is present, `tile.preProjectiveMatte`
also binds the Mask/target/matte node IDs, alpha mode, direct plane-local
coordinate space, manual-authoring status, pre-warp stage, contextual config
identity, LocalSpace compositor plan identity, and exact Mask operation
identity. The LocalSpace receipt independently records that same operation and
the final tile hash; the Planar receipt's tile hash is therefore the actual
masked input consumed by the warp, not an unexecuted planner claim.
A hidden receipt instead records its skip reason and exact zero work. Receipts
are staged and published only after the complete frame succeeds; a failed
frame cannot replace the last completed evidence with partial work. The closed
JSON Schema is followed by a semantic receipt verifier: opacity must be a
bounded, reduced exact rational in `[0, 1]`, rendered receipts must be nonzero,
and an `owner-opacity` skip must be exact zero. The verifier also checks every
Planar receipt time/confidence/progress rational, public canvas and LocalSpace
bounds, replays the Q16 projective plan, reconciles tight-surface, observed,
copy, pixel and RGBA-byte work, binds the completed frame's dimensions/time,
and recomputes `executionIdentity` from the complete canonical payload.

Canonical self-identity is not authenticity: an editor of persisted JSON can
recompute an unkeyed hash. The production frame-publication path therefore
also requires one independently retained, non-serialized trusted execution
captured by the live locked renderer. It compares the receipt field-for-field
against that authority, including locked source/resource/preparation,
backend/node/LocalSpace/composition/sample identities and the actual local
tile, tight-warp and Planar-output RGBA hashes. Missing authority, authority
for a different frame/source, or any coherently re-signed mutation fails with
`CUT_PLANAR_TRACK_EVIDENCE` and the first mismatching JSON path. The trusted
context is deliberately absent from the manifest so an editor cannot forge
the receipt and its claimed authority together. Structural validation or a
receipt's self-hash alone is not presented as semantic receipt proof.
`outputFrame` identifies the target review frame. `exactTime` identifies the
actual composition-absolute execution sample, so multiple MotionBlur shutter
receipts for that frame intentionally retain distinct exact times within the
owning scene clock.

Stable public diagnostics are `CUT_PLANAR_TRACK_GRAPH` plus the
`CUT_PLANAR_TRACK_*` family:

- `INPUT_TYPE`, `CONFIG`, `RESOURCE`, and `RESOURCE_CONFLICT`;
- `JSON`, `SCHEMA`, `DIMENSIONS`, `TIME`, and `RANGE`;
- `GEOMETRY`, `SAMPLE`, `HOLD_EMPTY`, and `LIMIT`.
- contextual matte failures are `CUT_PLANAR_TRACK_MATTE_GRAPH`,
  `CUT_PLANAR_TRACK_MATTE_MODE`, and `CUT_PLANAR_TRACK_MATTE_LIMIT`.

Post-lock byte drift remains the generic `CUT_LOCK_INTEGRITY` boundary.
Diagnostics carry the public CUT module, line, column, and node ID; unsupported
public arguments are also refused by the closed package/kernel checker.

## Bounded limits

The current reference limits are part of the executable alpha contract:

- one sidecar: 1 byte through 8 MiB, 2–16,384 samples, JSON depth 20,
  2,000,000 parsed values, 64-digit authored rationals;
- one composition: at most 128 PlanarTrack nodes, 128 distinct sidecars,
  32 MiB of sidecar bytes, and 1,000,000 observations;
- one project: at most 1,024 PlanarTrack nodes, 512 distinct sidecars, and
  128 MiB of sidecar bytes;
- one sidecar schema canvas axis: at most 65,536 pixels, but the required
  composition match and reference-runtime canvas contract make 4,096 pixels
  the effective public axis limit; absolute corner coordinate: at most
  131,072 pixels;
- one public LocalSpace source and one tight destination: at most 16,384
  pixels on either axis and 16,777,216 pixels; the LocalSpace contract is the
  tighter public bound even though the isolated internal warp kernel can admit
  a larger source surface;
- one direct plane-local partial-occlusion operation: at most one public alpha
  Mask; its target/matte and feather/expand work remain charged to the existing
  LocalSpace compositing pixel-work limits;
- one composition frame: at most 4,096 PlanarTrack executions and 4,096 total
  LocalSpace tile receipts shared with ordinary LocalSpace work; at most
  67,108,864 temporally retained source-tile pixels and 1,073,741,824 estimated
  LocalSpace pixel-passes;
- all visible PlanarTrack work in one composition frame: at most 67,108,864
  tight destination pixels and 268,435,456 composition-canvas RGBA copy bytes,
  reserved before any participating tile rasterization;
- dynamically authored PlanarTrack opacity in one composition: at most 100,000
  prepared signal values.

The current full-project semantic validator may perform up to the declared
1,024 PlanarTrack owners times 16,384 observations when every owner binds a
maximum sidecar. That finite worst case is accepted in this alpha because each
owner's duration and public configuration is independently bound; shared parse
memoization is a performance optimization, not a reason to skip validation.

Limits and exact-arithmetic/geometry floors fail before the affected allocation
or resource open whenever the required information is already available.

## Executable coverage

The public planar-tracking tests compile, lock, inspect, sample, and render
changing pixels across landscape and portrait synthetic fixtures. They cover
sidecar authority, plane geometry, clipping, cache locality, and hostile
mutation. They establish deterministic mechanics, not creative quality.

## Explicit nonclaims

PlanarTrack plays supplied observations and can execute one manually authored
plane-local alpha matte. It does not analyze footage, detect a plane, estimate
optical flow, solve or smooth a track, infer occlusion, generate or track the
matte, perform rotoscoping, correct lens distortion, compensate rolling
shutter, reconstruct a 3D camera/scene, relight footage, or automatically
reframe another aspect ratio. A third-party tracker may produce a sidecar, but
CUT currently verifies and executes only the locked playback contract above.

The slice proves that a bounded locally authored surface can be projected
deterministically through public CUT. It does not prove that the supplied track
is accurate, that the shot is well directed, or that any current film reaches
the professional-output bar.
