# Source-resolution MediaCamera2D

Status: executable bounded CUT 0.4-alpha engineering slice. This is not a
creative-quality, professional-film, cross-platform-pixel, projective, or 3D
camera claim.

`MediaCamera2D` reframes exactly one locked `Image` or `Video` from its native
post-crop pixel space, optionally through a bounded native-crop finishing
chain. Unlike the general [`Camera2D`](CAMERA2D.md), it does not first
materialize an arbitrary child graph on a delivery-sized canvas. Use it when a
shot needs deterministic source-resolution finishing plus pan, zoom, or
rotation while preserving one geometric sampling operation.

## Public contract

| Input/property | Type | Default | Executable range | Signal-driven |
| --- | --- | --- | --- | --- |
| `focusX` | `Ratio` | `50%` | `0%` through `100%` | yes |
| `focusY` | `Ratio` | `50%` | `0%` through `100%` | yes |
| `zoom` | `Number` | `1` | `1` through `8` | yes |
| `rotation` | `Angle` | `0deg` | `-360000deg` through `360000deg` | yes |
| `opacity` | `Ratio` | `100%` | `0%` through `100%` | yes |
| `edge` | `String` | `"transparent"` | `"transparent"` or `"clamp"` | no |

The camera must span its scene's complete interval from exact zero and use one
of two explicit ownership forms:

- one direct visual scene root; or
- the sole structural child of one `ResponsiveSlot`, itself owned directly by
  one `ResponsiveStack`.

The slot-bound form receives a compiler-owned, strictly rederived output
context containing the exact and raster slot geometry. Public source cannot
author, transplant or re-sign that context. The slot may contain only local
`set`/`animate` statements targeting this camera's five signal-driven
controls; siblings, control flow and unrelated mutation fail closed.

Every admitted child has exactly one structural parent; sharing an effect or
media leaf between camera roots is rejected before decoder preparation. The
camera body is closed to either:

- one direct childless `Image` or `Video`; or
- a unary chain of at most eight `ColorGrade`, `Blur`, `Sharpen`, `Vignette`,
  `Grain`, or `Duotone` wrappers ending in one childless `Image` or `Video`.

The camera's own branch may not contain sibling nodes: it is exactly one leaf,
optionally under the closed effect chain. Independent scene-root graphics
alongside the camera remain allowed and composite through the ordinary scene
paint order. The chain permits at most one `ColorGrade`; its existing public
properties may remain signal-driven. The other admitted effects are static in
this slice, and `Grain` must use `mode: "static"`. Effects execute
inner-to-outer in authored nesting order on the fixed post-crop source bounds.
They cannot supply spatial properties. `Shadow`, `Glow`, LUTs, masks, mattes,
chroma/luma keys, motion blur, `Group`, precompositions, nested cameras,
`LocalSpace`, or other subtrees inside the branch are rejected.
The effect path is additionally bounded to `16,777,216` post-crop source
pixels, matching the CPU effect-kernel surface limit; larger sources must use a
smaller crop or a locked proxy. Direct media and direct-grade cameras retain
their existing larger camera admission bounds.

The media leaf cannot supply `x`, `y`, `scale`, `rotation`, `opacity`, or any
dynamic property: `MediaCamera2D` owns the branch's only spatial sample.
`Image` keeps its public `source`, `fit`, and normalized `crop` inputs. `Video`
keeps exactly:

- required `source`;
- optional `range`, normalized `crop`, and `fit: "cover" | "contain" |
  "fill"`;
- optional `loop` or `endBehavior: "error" | "hold"`, subject to the ordinary
  mutually exclusive video contract;
- optional strict `inputColor`: `"srgb"`, `"linear-srgb"`, `"rec709-full"`,
  `"rec709-limited"`, or `"bt470bg-smpte170m-limited"`; and
- optional `inputColorInterpretation` created by `interpretVideoColor` for
  locked master/proxy observations in `"rec709-full"`, `"rec709-limited"`, or
  `"bt470bg-smpte170m-limited"`.

Master/proxy and video-stream selection remain lock/resource semantics, not
camera arguments. Omitting `inputColor` preserves the existing legacy decoder
interpretation; CUT does not silently infer a managed profile.

## Geometry and sampling

For each visible output frame CUT performs this ordered operation:

1. select the verified master or proxy and decode the exact source frame;
2. apply the media leaf's normalized crop in native source pixels;
3. execute the admitted effect chain inner-to-outer on that native cropped
   straight-RGBA8 surface; a `ColorGrade` executes at its authored chain
   position rather than being moved ahead of other effects;
4. compute `cover`, `contain`, or `fill` scale from the unpadded crop without
   creating a fitted raster;
5. map the authored post-crop focus point to the active output centre under
   that fit scale multiplied by `zoom`;
6. rotate the result about the active output centre;
7. apply bounded clamp-edge padding when required and adjust only the affine's
   source origin for that copied border;
8. execute one inverse Q16 associated-alpha bilinear affine from the
   native/effected crop directly into the active output pixels; and
9. apply camera opacity after interpolation.

For a direct scene root, the active output is the composition. For a
slot-bound camera, it is the actual quantized slot surface. The latter is then
placed once by integer translation with a half-open slot clip; placement adds
no geometric resample and never creates a composition-sized media preraster.

The direct `ColorGrade { Image/Video }` form retains its original pre-chain
plan, cache, inspect, and frame-evidence wire. Additive native-effect plan,
allocation, work, and evidence fields appear only when at least one non-grade
wrapper exists, so historical no-effect and direct-grade manifests remain
valid.

`focusX` and `focusY` address source pixel centres: `0%` selects the first
post-crop pixel centre and `100%` the last. The selected point stays pinned to
the delivery centre while zoom and rotation change. Rotation is authored and
interpolated unwrapped; a static whole turn is visually the default, while an
animation from `0deg` to `360deg` remains observable.

There is no fitted media surface and no composition preraster. A visible frame
performs exactly one geometric resample through
`cut-q16-associated-alpha-bilinear-direct-affine-v1`. The current reference
path samples straight RGBA8 as associated alpha, unassociates the result, and
clears RGB where output alpha becomes zero.

`edge: "transparent"` uses normative zero extension outside the post-crop
surface. `edge: "clamp"` extends the required bounded border by copying edge
pixels, not by resampling, and then executes the same single affine sample.
The default is transparent. A frame whose resolved opacity quantizes to Q8
phase zero returns transparent delivery pixels without opening a frame
decoder, decoding a frame, executing any grade or native effect, padding an
edge, or running the affine sampler. Its closed effect-chain evidence records
the skip without claiming output surfaces. Lock verification and renderer
preparation may still access the already-declared resource path or bytes; the
frame receipt's `sourceOpens` counter means decoder opens attributable to that
frame, not all filesystem access in the process.

## Source-bound paths and callouts

The existing `visualAnchor(owner:, local:)` constructor can bind retained
`Path` or `MotionPath` geometry to a direct scene-root `MediaCamera2D`:

```cut
MediaCamera2D(focusX: 42%, zoom: 1.2) as shot {
  Video(source: footage, range: 0s ..< 4s, fit: "cover");
}

Path(
  geometry: anchoredPath(
    start: visualAnchor(owner: shot, local: { x: 824.5px, y: 311px }),
    segments: [anchoredLineTo(to: { x: 1680px, y: 180px })],
    closed: false
  ),
  stroke: #ffffff,
  width: 3px
);
```

For this owner kind, `local` is not a delivery coordinate or an inferred
subject position. It is an exact pixel-centre coordinate in the locked
post-crop source: `(0px, 0px)` is the first pixel centre and the closed valid
range is `[0px, cropWidth - 1px] x [0px, cropHeight - 1px]`. Fractional source
pixels are valid. The language applies a global `0px..16383px` admission bound;
the locked runtime then enforces the actual crop dimensions before rendering.

CUT resolves the point through the camera frame's already-admitted Q16
source-to-delivery affine, before camera opacity. The anchor reuses that frame
plan: it does not decode the source again, grade another surface, create a
fitted/composition preraster, or run another geometric sample. Camera focus,
zoom, rotation, fit, crop and delivery dimensions can move the resolved point.
Opacity zero keeps its coordinate while hiding only the camera pixels. Grade,
native-effect configuration/order, edge policy and source-byte edits remain
audit-visible but do not masquerade as coordinate changes when the affine is
unchanged.

Completed frame evidence uses the additive
`cut.reference.anchored-path-frame.v2` branch with the post-crop basis and
affine identity. Existing LocalSpace anchors retain their v1 wire and identity.
This is deterministic source-coordinate binding, not feature detection,
keypoint extraction, planar tracking, face/object understanding, or automatic
callout placement. A changing subject inside the footage still requires
authored coordinates or a separate explicit tracking-data primitive.

The bounded responsive form supports the same source-pixel anchor only when
the camera is the sole direct child of its `ResponsiveSlot` and its alias is
used later in the same immediate lexical scope. CUT first resolves the source
point through the camera's admitted source-to-slot Q16 affine, then composes
the slot's integer translation into composition pixels. Path/MotionPath and a
later direct-scene CalloutLayer reuse this exact plan. The anchor adds no
decode, finishing pass or geometric resample. Frame-v2 evidence cross-binds
the anchor occurrence, camera execution, ResponsiveStack execution, placement
identity and exact source/slot/composition bases before any ledger is
committed.

One exact Visual component form can retain the ResponsiveStack first and then
one anchored Path and/or one CalloutLayer in the same complete-interval,
direct-root, pure component fragment. Every anchor must reference the
fragment's sole slot camera. CUT authenticates component-definition and
call-site provenance—including imported definitions—through the stack, slot,
camera, Callouts and LocalSpaces, then dispatches the ordered children directly
to composition space. The fragment performs zero wrapper raster,
transform/clip, allocation, or resample work. `MotionPath` is not yet admitted
inside this component form.

This does not make arbitrary nested aliases visible. At most one slot-camera
alias escapes a ResponsiveStack into its immediate scope, only after the stack
statement, and it cannot cross a component invocation. Partial-interval or
transformed fragments, a second camera, other overlay children and arbitrary
nested CalloutLayers remain structurally unsupported.

## Copyable recipe

This is a complete checked program. Replace `media/shot.mp4` with project-local
footage, then run `cut lock` before frame, preview, or render commands.

```cut
cut 0.4;
project "Source-resolution move";

import { Grain, MediaCamera2D, Video, Vignette } from "cut:visual";
import { inOutCubic } from "@cut/motion";

asset footage: VideoAsset = video("media/shot.mp4");

timeline main(duration: 4s, fps: 24, width: 1920px, height: 1080px, sampleRate: 48khz) {
  scene move(duration: 4s) {
    MediaCamera2D(focusX: 42%, focusY: 48%, zoom: 1.15) as camera {
      Vignette(amount: 18%, radius: 68%, softness: 58%, color: #0b1018) {
        Grain(amount: 3%, size: 1px, seed: 2903, mode: "static", monochrome: true) {
          Video(source: footage, range: 0s ..< 4s, fit: "cover");
        }
      }
    }

    animate camera.focusX from 42% to 58% over 4s ease inOutCubic;
    animate camera.zoom from 1.15 to 1.35 over 4s ease inOutCubic;
  }
}

export release = render(main, width: 1920px, height: 1080px, codec: "h264");
```

Use exact frames and a bounded range before committing to a full render:

```sh
cut fmt main.cut --check
cut check main.cut
cut lock main.cut --out cut.lock
cut frame main.cut --lock cut.lock --frame 0 --out output/start.png
cut contact main.cut --lock cut.lock --frames 0,24,48,72,95 --out output/move.png
cut preview main.cut --lock cut.lock --range 0s:4s --width 960 --out output/move.mp4
cut render main.cut --lock cut.lock --output release --out output/release.mp4
```

Frame and contact-sheet evidence verify selected instants; they do not replace
watching the range at full speed.

## Cache identity and locality

Every authored camera control, its attached signal, `edge`, every admitted
effect configuration and order, and the media leaf's authored source
participate in executable picture identity. A slot-bound camera additionally
binds the ResponsiveStack plan, exact/raster slot and compiler context
identity. Changing any of them invalidates the camera's affected picture
ancestry and the encoded cache entry for its owning scene. Camera-only edits
leave unchanged effect and media-leaf node identities reusable; an effect-only
edit leaves the unchanged media leaf reusable; changing the leaf source
invalidates that leaf and its ancestors. Unrelated scene-picture entries and
pure-audio node identities remain stable.

This is scene-cache locality, not a claim that `MediaCamera2D` has its own
persisted node, tile, or source-frame cache. The current reference renderer
persists encoded picture scenes at this boundary. Exact regressions live in
`tests/media-camera2d-cache-locality.test.ts` and
`tests/reference-media-camera2d-native-effects.test.ts`; responsive placement
and source-anchor closure are exercised in
`tests/reference-responsive-slot-media-runtime.test.ts`.

## No-op and diagnostic behavior

CUT refuses an all-default camera, including a static whole-turn rotation, with
`CUT_MEDIA_CAMERA_NOOP`. It also refuses a camera whose opacity is zero for the
entire scene, even when another control is non-default. `edge: "clamp"` is
observable only when it changes the admitted sampling geometry; its authored
name alone is not evidence of execution.

Omission is the only canonical spelling of a constructor default. Explicit
`focusX: 50%`, `focusY: 50%`, `zoom: 1`, any static whole-turn `rotation`,
`opacity: 100%`, or `edge: "transparent"` fails individually with
`CUT_MEDIA_CAMERA_NOOP`, including when another control already makes the
camera visible. This rule is repeated by strict loaded-IR validation, so a
re-signed private graph cannot restore an ignored default argument.
Identity effect wrappers are also refused: examples include `Blur(radius:
0px)`, zero-amount finishing effects, and a static `ColorGrade` that remains
identity across every exact output-frame sample. Unsupported effect kinds,
more than eight wrappers, a second `ColorGrade`, temporal `Grain`, spatial
effect controls, and unknown fields fail source-located before pixels.
Every canonical camera track also carries a non-null initial value equal to
its same-named constructor input or, when omitted, the public default. Strict
loading rejects a null or conflicting track baseline with
`CUT_MEDIA_CAMERA_VALUE`; execution never silently discards constructor state.

After the source is locked, CUT performs a second, output-grid-specific no-op
proof before any resource snapshot, source decoder/open, or picture-cache
lookup. It samples every ordinary output frame in the camera's half-open scene
interval on the locked post-crop native dimensions, delivery dimensions,
`fit`, and `edge` policy. Each candidate plan is evaluated at a preregistered
bounded lattice of real output-pixel centres: both edges, quarter points and
centre on each axis (at most 25 pixels). The proof calls the same pure Q16
inverse-coordinate/tap kernel as the raster, with the same subtraction and
IEEE evaluation order. A changed original-source tap or integer bilinear
weight is positive executed-operator evidence. If a change exists only outside
the bounded lattice, CUT conservatively refuses it; a matrix difference alone
is never accepted as proof.

For every authored spatial control CUT holds all other controls fixed and
compares that sampler witness with the control's default counterfactual. It
also compares clamp with transparent extension, Q8 opacity phases, each whole
attached signal, and each individual track event, step point, or keyframe.
Any accepted source item must change at least one executed output-frame plan.
Opacity phase zero at every frame is refused even if authored floating-point
values are nonzero; execution and evidence use `phase / 255`, not ignored raw
precision.

The closed limits are 1,000,000 exact frames per camera and 4,000,000 aggregate
sampler-observability work units per composition. Work counts every worst-case
actual/counterfactual plan evaluation times the real witness-pixel count before
frame or signal-item arrays are allocated. Optional ColorGrade identity proof
charges seven property evaluations per exact frame against this same aggregate
before it loops. The aggregate is sized to admit a
representative animated five-minute 30fps camera while bounding hostile loaded
IR. Exceeding either limit fails source-located with `CUT_MEDIA_CAMERA_LIMIT`;
it is never accepted without proof.

The proof is content-independent: a uniform image or coincidental frame hash
cannot establish or erase operator causality. A true `0deg` to `360deg`
animation remains admitted when an intermediate sampled plan has a witnessed
tap/weight difference; motion entirely between output samples is
unobservable. Rejected quantized controls cannot create a false scene-cache
miss because execution stops before cache lookup.

Static planning binds each camera, every admitted effect in exact order, the
media leaf, every static effect configuration, and every directly attached
signal definition. Exact-frame admission recomputes those identities, so
mutating a signal or effect configuration behind a stale node hash cannot
bypass the locked-grid proof. `cut inspect --json` reports inspection order,
execution order, placement basis, bounded work, and first-frame chain identity.
Completed evidence carries the same information plus each operation's
configuration identity and output RGBA hash, the final pre-affine hash,
allocations, the observability report, the complete same-frame aggregate
admission, and the sampled grade execution identity when a grade actually
runs. Admission authority is invocation-local, single-use and revoked when a
frame closes; serialized receipts cannot be replayed to mint execution
evidence.

The stable camera contract families are:

- `CUT_MEDIA_CAMERA_SCOPE` for invalid source placement;
- `CUT_MEDIA_CAMERA_GRAPH` for unsupported branch topology or hidden spatial
  ownership;
- `CUT_MEDIA_CAMERA_VALUE` for invalid typed values, ranges, signals, or edge
  values;
- `CUT_MEDIA_CAMERA_NOOP` for provably inert public source or locked-grid
  sampling semantics; and
- runtime `CUT_MEDIA_CAMERA_INPUT`, `CUT_MEDIA_CAMERA_RESOURCE`,
  `CUT_MEDIA_CAMERA_RANGE`, `CUT_MEDIA_CAMERA_LIMIT`,
  `CUT_MEDIA_CAMERA_PREFLIGHT`, and `CUT_MEDIA_CAMERA_RASTER` failures after a
  hostile or unavailable locked execution boundary.

Unknown arguments and properties fail through the ordinary closed package,
kernel, and IR diagnostics; they are never ignored.

## Honest boundaries

- The exact graph is one media leaf under zero through eight members of the
  closed native-crop effect set. The static effects preserve the crop canvas;
  blur is clipped to that source bound rather than expanding it. General
  effects, masks, mattes, halo expansion, arbitrary subtrees, and multiple
  media layers belong outside this slice. Root-level Path/MotionPath callouts
  may bind to the camera's source coordinates as documented above; that does
  not place arbitrary overlays inside the camera branch.
- This is a two-dimensional affine camera. It has no perspective, depth,
  orbit, lens, lighting, projective warp, or 3D semantics.
- The reference sampler is CPU, Q16-phase, bilinear, and straight-RGBA8 at this
  boundary. Higher-order or scene-linear spatial reconstruction, GPU parity,
  and cross-platform pixel conformance are not claimed.
- Inspect, semantic diff, graph/build identity, pixels, allocations, and stable
  diagnostics are engineering evidence. The effect chain is currently proven
  by unrelated synthetic fixtures, not two reviewed professional reference
  studies. The slice therefore remains PARTIAL and has not passed the required
  creative, full-speed/headphone, or professional-film gates.
