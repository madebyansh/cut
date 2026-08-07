# Generic retained Callout layout

Status: **pre-1.0 executable vertical** in `0.4.0-alpha.1`.

`CalloutLayer` and `Callout` are public `cut:visual` primitives for attaching
one bounded retained visual tile to an explicit composition-space point and
coordinating several such tiles as one collision domain. The source lowers
through the ordinary checker and typed CutAVIR, survives strict IR loading,
executes in the reference renderer, appears in `cut inspect`, participates in
semantic/cache identity, and emits closed same-frame evidence.

This slice proves deterministic layout and raster execution. It does not prove
professional direction, replace complete playback review, infer a good label,
or make the current reference-study suite or CUT 1.0 complete.

## Complete public shape

```cut
cut 0.4;
project "generic callout";
import {
  CalloutLayer,
  Callout,
  Group,
  LocalSpace,
  Rect,
  visualAnchor
} from "cut:visual";
import { linear } from "@cut/motion";

timeline main(
  duration: 1s,
  fps: 24,
  width: 1280px,
  height: 720px,
  sampleRate: 48khz
) {
  scene only(duration: 1s) {
    Group(x: -180px, y: 40px) as evidence {
      LocalSpace(
        width: 320px,
        height: 180px,
        origin: { x: 160px, y: 90px }
      ) {
        Rect(
          width: 320px,
          height: 180px,
          x: 160px,
          y: 90px,
          fill: #243040
        );
      }
    }

    CalloutLayer() {
      Callout(
        anchor: visualAnchor(
          owner: evidence,
          local: { x: 0px, y: 0px }
        ),
        placements: ["right", "left", "above"],
        offset: 24px,
        safeArea: 48px,
        priority: 10,
        leader: "elbow",
        leaderColor: #ffcc33,
        leaderWidth: 2px
      ) as label {
        LocalSpace(
          width: 240px,
          height: 72px,
          origin: { x: 0px, y: 0px }
        ) {
          Rect(
            width: 240px,
            height: 72px,
            x: 120px,
            y: 36px,
            radius: 12px,
            fill: #ffffffff
          );
        }
      }

      animate label.opacity from 100% to 40% over 1s ease linear;
    }
  }
}

export out = render(
  main,
  width: 1280px,
  height: 720px,
  codec: "h264"
);
```

The public signatures are:

```text
CalloutLayer() {
  1..64 direct Callout children
}

Callout(
  anchor: SpatialPoint,
  placements: List<String>,
  offset: Length,
  safeArea: Length,
  priority?: Number,
  leader: "none" | "straight" | "elbow",
  leaderColor?: Color,
  leaderWidth?: Length,
  opacity?: Ratio
) {
  exactly one direct LocalSpace child
}
```

Only `Callout.opacity` is a property. Bind a direct Callout with `as name`,
then place its `animate name.opacity ...` statement after that Callout in the
same `CalloutLayer` body. `set`, non-opacity properties, detached Callouts, and
arbitrary control statements in the layer are refused.

## Closed ownership and timing

The topology is intentional:

- `CalloutLayer` is parameterless and pure. It is normally a direct visual
  scene root. The only nested form is a later direct child of the exact
  identity Visual component fragment documented in
  [`RESPONSIVE_LAYOUT.md`](RESPONSIVE_LAYOUT.md): ResponsiveStack first, then
  Path and/or CalloutLayer, all spanning the complete scene from exact zero.
  It has no editorial payload and owns only direct Callout children.
- A Callout is pure visual, belongs directly and exclusively to that layer,
  shares the layer's exact interval, and owns exactly one equal-interval direct
  `LocalSpace`.
- The LocalSpace width and height are the callout's retained tile dimensions.
  Its origin remains the normal LocalSpace registration point; layout places
  the tile's outer rectangle, not a delivery-sized hidden preraster.
- One composition may contain at most 128 Callouts across its layers.
- Unknown inputs, properties, child types, effects, and editorial fields fail.
  They are not stored for a future renderer and are never accepted as no-ops.

This structure gives `cut check` enough information to validate the public
graph without opening media. A MediaCamera2D-backed anchor is the one
asset-dependent exception: check closes its type, ownership, order and broad
coordinate bound, while lock-backed preparation validates the exact post-crop
source extent. The owner may be a direct scene root, the sole camera child of
an earlier ResponsiveSlot/ResponsiveStack in the same immediate lexical scope,
or that same camera when both stack and CalloutLayer are authenticated
children of the exact identity component fragment. All other nested-layer
shapes fail.

## SpatialPoint anchors

`anchor` is never inferred from imagery or text. It is an explicit
`SpatialPoint`:

```cut
anchor: { x: 640px, y: 360px }
```

A raw `Vec2` is a composition-pixel point. The existing
`compositionOffset(point:, by:)` wrapper may apply an explicit nonzero
composition-space offset.

For retained visual evidence, use the existing owner-bound form:

```cut
anchor: visualAnchor(
  owner: evidence,
  local: { x: 0px, y: 0px }
)
```

The owner must be bound earlier in the same source module and must be either an
earlier direct visual root in the same scene or the sole MediaCamera2D child of
an earlier ResponsiveSlot/ResponsiveStack in the same immediate lexical
scope. Its interval must contain the Callout. It cannot be a Callout
coordination node or a structural ancestor/descendant of the Callout. A
retained owner exposes one exact LocalSpace coordinate view; MediaCamera2D
exposes its locked post-crop source-pixel-centre view. A responsive camera
composes that source-to-slot affine with the exact integer slot placement.
Owner placement is sampled at the exact output time, so moving or tracking
that owner moves the anchor, candidate rectangles, leader, evidence, and
pixels together.

For a LocalSpace view, authored local coordinates are registration-relative and
must lie inside its closed authored bounds. For MediaCamera2D, coordinates are
exact possibly fractional post-crop source pixel centres and the runtime checks
them against the locked crop. Track2D hold/hide/fail policy remains
authoritative: hold resolves its retained placement, hide suppresses dependent
Callout work, and fail preserves the originating source-located Track2D error.
This is explicit attachment, not tracking, feature extraction, object
recognition, occlusion inference, or automatic label selection.

Only one aliased camera may escape a ResponsiveStack into its immediate scope,
and only after the complete stack statement. The alias cannot escape a
component invocation. A component-nested CalloutLayer is admitted only in the
exact pure, complete-interval identity shape above, where CUT authenticates
the shared expansion and dispatches the layer as a composition overlay with
zero wrapper work. It does not create or hide a second compositor.

## Placement and collision semantics

Each Callout supplies one through four unique fallback directions chosen from
`"right"`, `"above"`, `"below"`, and `"left"`. The order is authored policy.
For a tile of width `w`, height `h`, anchor `(x, y)`, and positive `offset`,
the reference layout constructs candidates as follows:

```text
right: left = round(x + offset),       top = round(y - h/2)
above: left = round(x - w/2),          top = round(y - offset - h)
below: left = round(x - w/2),          top = round(y + offset)
left:  left = round(x - offset - w),   top = round(y - h/2)
```

Here `round(v)` is the fixed `floor(v + 0.5)` rule. Candidate rectangles are
half-open. Touching edges do not collide; positive overlap on both axes does.

The algorithm is deterministic:

1. Resolve active Callouts by descending whole-number `priority`.
2. Break equal-priority ties by layer source order, then Callout child source
   order.
3. Hide an exact-zero-opacity Callout before anchor work.
4. Resolve the explicit anchor. A point outside
   `[0, width) × [0, height)` is `anchor-offscreen`.
5. Test fallback candidates in authored order. A candidate must lie completely
   inside the delivery rectangle inset uniformly by `safeArea` and must not
   collide with a previously accepted rectangle.
6. Accept the first eligible candidate. If none is eligible, hide it with
   `collision-overflow`.
7. Paint accepted Callouts in reverse resolution order. Thus higher-priority
   Callouts reserve space first and paint later. Each leader is painted
   immediately before its own retained tile.

`priority` defaults to structural order. An explicitly authored zero is
rejected because it repeats that default. Nonzero priority is an exact whole
number from `-1,000,000` through `1,000,000`.

Collision applies only among Callouts in the same CalloutLayer. It does not
avoid arbitrary footage, titles, safe-title regions other than the authored
uniform inset, or Callouts in another layer.

## Leaders and opacity

`leader: "none"` forbids `leaderColor` and `leaderWidth`. `"straight"` and
`"elbow"` require both. A leader color must be a canonical nontransparent CUT
color, and width must be positive. Straight leaders contain one segment.
Elbow leaders use a fixed bounded three-segment construction. Vertices,
rounded caps/joins, work counts, and the selected tile edge appear in the
same-frame plan.

Opacity is sampled from the public Ratio property at exact composition time:

- omitted opacity has a `100%` baseline;
- static `0%` and explicit static `100%` are rejected as permanently hidden or
  redundant;
- a property whose complete authored effective states are demonstrably all
  `0%` or all `100%` is also rejected;
- an executing signal may begin or end at either boundary.

An exact zero sample skips anchor resolution, candidates, tile materialization,
leader work, placement, and compositing. A positive sample can still quantize
every tile alpha byte to zero. That path is recorded as
`opacity-quantized-transparent`: the bounded tile and affine admission remain
evidenced, but there is no placement raster, overlay, leader raster, or
source-over. Alpha-associated processing clears RGB whenever alpha quantizes
to zero.

## Diagnostics

Callout diagnostics are stable and source-located:

| Code | Boundary |
| --- | --- |
| `CUT_CALLOUT_TYPE` | Missing, unknown, malformed, or wrongly typed public value/property. |
| `CUT_CALLOUT_GRAPH` | Layer/Callout scene scope, ownership, interval, child, pure-effect, or editorial topology. |
| `CUT_CALLOUT_ANCHOR` | Invalid explicit SpatialPoint, owner, source order, local bound, or exact owner resolution. |
| `CUT_CALLOUT_VIEWPORT` | Missing/invalid retained LocalSpace or tile/safe rectangle that can never fit. |
| `CUT_CALLOUT_LAYOUT` | Invalid bounded layout geometry or an execution-time layout contradiction. |
| `CUT_CALLOUT_STYLE` | Invalid leader kind, color, width, or generated leader geometry. |
| `CUT_CALLOUT_LIMIT` | Layer/composition/candidate/collision/coordinate resource bound. |
| `CUT_CALLOUT_NOOP` | Duplicate fallback, redundant zero priority, inert leader styling, or provably hidden/default opacity. |
| `CUT_CALLOUT_EVIDENCE` | Persisted/current Callout receipt contradicts its derivable layout, raster, work, or identity. |

An owner-specific anchored-path, MediaCamera2D, LocalSpace, Track2D, or
PlanarTrack diagnostic is preserved when that subsystem is the cause. Repair
the named source location; do not hand-edit CutAVIR or evidence hashes.

## Authoring and review workflow

```sh
cut fmt main.cut --check
cut check main.cut
cut lock main.cut --out cut.lock --json
cut inspect main.cut --lock cut.lock --json
cut frame main.cut --lock cut.lock --frame 0 \
  --out review/frame-0.png --json
cut contact main.cut --lock cut.lock --frames 0,12,23 \
  --columns 3 --thumbnail-width 480 \
  --out review/callout-contact.png --json
cut preview main.cut --lock cut.lock --range 0s:1s \
  --width 640 --out review/callout-preview.mp4 --json
cut render main.cut --lock cut.lock --output release --out release.mp4
```

`cut inspect` reports the Callout and layer algorithm versions, retained
viewport, fallback list, priority, leader, explicit anchor-owner IDs, semantic
identity, and zero-work policies. It is static planner evidence, not a pixel
preview. `cut frame` and `cut contact` exercise exact rendered pixels; preview
and render exercise time. Actually watch animation at full speed and listen to
the complete mix when the project has audio. A correct manifest or contact
sheet is not a creative pass.

## Determinism, evidence, and locality

Current exact-frame output adds `execution.calloutLayers` to the frame-v2
manifest. Each receipt binds:

- composition, scene, exact local time, output frame, and nested execution
  path;
- priority/source resolution order and reverse paint order;
- exact anchors, fallback candidates, half-open collision relationships,
  accepted rectangles, leader geometry, hidden reasons, and opacity samples;
- retained tile identity and RGBA hash;
- LocalSpace affine admission, transform-work, materialized tile, and actual
  placement identities;
- visible-alpha, overlay, source-over, allocation, and complete bounded work;
- final output RGBA hash, decision identity, and full execution identity.

Schema validation closes the JSON shape. Semantic validation independently
rebuilds order, collision, chosen candidates, paint order, work totals,
transparent-versus-painted state, and receipt identities. The current
LocalSpace execution-tree validator cross-binds the Callout to the exact
admission, tile, transform work, and placement from the same rendered frame.
Changing public hashes cannot legitimize contradictory evidence. Nested
Precomp instances receive distinct path-bound execution identities, and
evidence is published transactionally only after the complete renderer tree
succeeds; a failed later frame does not replace the last completed receipt.
Historical frame-v2 manifests remain schema-readable without the additive
Callout branch.

Direct layers record source order as `[sceneRootIndex, calloutIndex]`.
Identity-component layers record
`[fragmentRootIndex, layerChildIndex, calloutIndex]`. The schema and semantic
validator require the shape appropriate to the authenticated fragment binding;
shortening or rehashing a component source-order path cannot turn it into a
direct layer.

When the owner is slot-bound, the frame also contains one
`execution.responsiveSlotMediaAnchors` link per Path/MotionPath/Callout anchor
occurrence. It cross-binds the anchor receipt, camera execution,
ResponsiveStack execution, integer placement, source/slot/composition bases
and final affine. Forged or crossed receipts fail before the completed ledgers
are replaced.

For the identity-component form, the frame also contains
`execution.identityComponentFragments`. It cross-binds the exact ordered
fragment children to the camera, ResponsiveStack, Callout, optional Path and
all slot-anchor link receipts while asserting zero fragment
materialization/allocation/transform/clip/resample work.

Content and placement identity are deliberately separate. Moving only a
visualAnchor owner preserves the retained Callout tile identity and exact tile
RGBA while changing anchor, admission/placement, decision, output, and
execution identities. Editing tile content invalidates its retained tile and
picture path without pretending that an unchanged layout decision moved.
Audio-only edits do not become Callout layout state. These are localized
identity guarantees, not a claim of cross-platform byte-identical media
decoding.

## Resource bounds

| Bound | Current limit |
| --- | ---: |
| Direct Callouts per CalloutLayer | 1–64 |
| Callouts per composition | 128 |
| Unique placements per Callout | 1–4 |
| Candidate collision tests per layer sample | 16,384 |
| Leader segments per Callout | 3 |
| Absolute priority | 1,000,000 |
| Positive offset | at most 65,536 px |
| Uniform safe area | nonnegative and less than half the active width/height |

The LocalSpace tile must fit completely inside the safe rectangle. Existing
LocalSpace pixel, nesting, compositor, affine-preflight, frame-evidence, and
delivery-canvas budgets also apply. Bounds are checked before unbounded raster
or collision work.

## Executable coverage

The public callout tests cover multiple moving-owner labels, dynamic opacity,
straight and elbow leaders, safe-area collision, priority ordering and
deterministic fallback. They are conformance tests, not creative approval.

## Honest boundary

This vertical does not yet provide:

- automatic label text, tracking, semantic anchor selection, shot analysis, or
  placement chosen by a model at render time;
- arbitrary nonuniform safe regions, obstacle maps from other visual roots,
  leader routing around content, elastic layout, callout-to-callout animation,
  or a general constraint solver;
- projective Callout tiles, freeform leader paths, rich annotation semantics,
  occlusion masks, or layout shared across distinct CalloutLayers;
- a completed redistributable professional reference study, named-human
  full-speed/phone review, headphone review, independent creative approval, or
  evidence that the hero-film gate passes.

Callout is one real public language-to-runtime capability needed by visual
journalism and explanatory motion. CUT remains `0.4.0-alpha.1` until the whole
1.0 engineering and creative contract passes.
