# Retained local compositing V1

Status: **PARTIAL**, executable in CUT `0.4.0-alpha.2`. This document defines
one bounded reference-runtime contract. It does not make CUT 1.0-ready and it
does not upgrade either additive study to a creative pass.

## Purpose

Ordinary visual wrappers historically materialized their children against the
delivery canvas. That is wrong for a small callout which must be finished first
and then moved by `Track2D`, or for a card which must be finished first and then
projectively warped by `Plane3D`.

V1 executes the following already-public nodes inside the exact declared
`LocalSpace(width:, height:)` tile, before the owning placement or warp:

- ordinary `MotionPath` with legacy points or `VectorPathGeometry`;
- `Composite` with the documented blend modes;
- `Mask` with target-then-matte child order;
- `ClipPath`;
- graphical `ColorGrade`;
- `Blur`, `Vignette`, `Sharpen`, `Grain`, and `Duotone`.

There is no new syntax. The same typed nodes lower to the same public CutAVIR.
The new behavior is a closed planner and runtime execution path for those nodes
when they are reachable below `LocalSpace`.

## Execution boundary

The tile is exactly `W * H * 4` bytes of straight RGBA8. Descendant operations
run in authored depth-first order and use `W` and `H` for validation,
allocation, clipping, effect work, semantic identity, and completed-frame
evidence. The implementation does not call the delivery-sized descendant
renderer. Once the tile is complete, the existing owner path applies
registration and one of the already-public transforms:

- `Camera2D` affine placement;
- `Track2D` observed affine placement;
- `PlanarTrack` four-corner projective placement;
- `Plane3D` / `Camera3D` projective placement;
- the closed direct scene-root Visual-component placement described below;
- existing scene, group, nested-LocalSpace, geographic-annotation, and depth
  owners.

`Composite` paints children serially in source order. `Mask` renders target
before matte. `ClipPath` prepares coverage at local dimensions. Temporal
`Grain` keys its deterministic field to the absolute output frame. The final
local boundary is straight alpha; operations that can expose zero alpha clear
hidden RGB, including the local `ColorGrade` path.

### Ordinary MotionPath descendant

`MotionPath` may be an ordinary descendant of `LocalSpace`; this is separate
from the historical `MotionPath { LocalSpace { ... } }` owner form. Legacy
`points:` and retained `geometry: VectorPathGeometry` are admitted. Their
coordinates are authored in the declared local pixel-edge basis. At each exact
time CUT samples progress and tangent, converts that authored point to the
retained raster through the LocalSpace's exact Q16-derived origin, then applies
tangent orientation, the authored MotionPath transform stack and opacity. The
result is clipped to the declared half-open tile and source-over composited in
source order before any outer camera, track or projective owner executes.
Nested public components are already lowered to ordinary fragment/group/shape
children and use the same path.

This path never materializes a delivery-sized MotionPath subject. Coordinate,
arc-work, transform, tile-pixel and execution-domain limits remain fail-closed.
Owner-resolved `AnchoredPathGeometry` is refused with a source-located
`CUT_LOCAL_SPACE_UNSUPPORTED` runtime diagnostic and an independently closed
strict-IR loader diagnostic because it has no ordinary local coordinate basis.

The local MotionPath algorithm and ordered node set participate in LocalSpace
semantic and exact-time tile identity. `cut inspect --json` preserves the
legacy top-level centre-relative `executedAtActiveStart` and separately exposes
the identity-bound `localExecution.authoredLocalAtActiveStart`, local
dimensions/origin, transform order, clip/composite rule and forbidden delivery
fallback. Tests execute a `4 -> 0 -> 2 -> 4` seek and require byte-identical
frame 4, while `examples/local-motion-path-camera.cut` provides an unrelated
retained-camera fixture. Those are deterministic engineering proofs, not
playback or creative approval.

For a direct `PlanarTrack { LocalSpace { ... } }` tile, at most one Mask in
that direct local compositor may serve as the bounded partial-occlusion matte.
It must use alpha mode and is evaluated here, on the exact plane-local tile,
before PlanarTrack's projective warp. Its existing target/matte child order,
invert, integer feather/expand and visual transform automation remain public.
Nested LocalSpace masks are ordinary nested composition rather than the direct
plane matte. CUT does not infer, solve, track or generate this manual coverage;
see [PLANAR_TRACKING.md](PLANAR_TRACKING.md).

Direct retained `Image`/`Video` branches keep the separate documented
retained-media viewport grammar: childless media, optional unary `Group`
chains, and at most one branch `ColorGrade`. The additive retained-media local
compositor V2 can now place those unchanged materialization islands beneath
the nine admitted wrappers. The island still performs lock/probe/decode,
native crop/color interpretation, fit and its historical affine first; the
surrounding wrapper then runs on the exact local tile before the owner
transform. The runtime never redirects either form through the delivery-sized
renderer. See `RETAINED_MEDIA_VIEWPORT.md`.

### Direct Visual-component owner

The additive component owner is deliberately exact. A pure Visual component
invocation must be a direct scene visual root and lower to one
`cut.kernel.fragment` with no runtime inputs or editorial payload and exactly
one equal-interval `LocalSpace` child. Source parameters are permitted because
they are substituted before this IR boundary. Invocation children,
LocalSpace/body siblings, nested fragments, any other structural parent,
composition-root ownership, and fragment anchor/skew are rejected. The only
owner controls are `opacity`, `x`, `y`, `scale`, and `rotation`, sampled at the
exact composition time.

Component admission constructs one linear graph index and shares it across all
candidate components; it does not rescan the complete graph per owner. Runtime
resource admission is broader: one composition-frame affine aggregate covers
all admitted scene-root, component, unary Group/MotionPath/Camera2D/Track2D,
nested-LocalSpace, accepted annotation, and depth-layer LocalSpace placements.
Nested tiles charge their actual parent-LocalSpace destination, not a fictional
delivery canvas. Every executed MotionBlur shutter-sample placement enters the
same aggregate before any retained tile is requested.

The shared ceilings are 256 visible affine transforms, 1,073,741,824 bytes
(1 GiB) of live output surfaces, and 2,147,483,648 bytes (2 GiB) of unscheduled
peak work. Exact-zero opacity and supported tracking-policy hides allocate no
tile or aggregate work. Non-skew transforms admitted by the historical
RGB16 path preserve V2 identity exactly. A nonzero skew uses V3, matching the
installed scale, simultaneous two-axis shear, then rotation path; one skewed
entry upgrades an otherwise V2 aggregate to V3. A zero-rotation resize whose
historical RGB16 peak alone exceeds the unchanged 512 MiB per-transform
ceiling uses V4 planning: the original retained RGBA8 tile is sampled once
into an exact delivery-clipped destination without allocating the forbidden
intermediate. V4 does not raise any source, destination, composition-live, or
unscheduled-work ceiling; a mixed aggregate containing V4 is identified as
V4. Projective PlanarTrack/Plane3D work remains separately bounded. The
aggregate does not widen ownership: ordinary
`MotionBlur -> Group -> LocalSpace` remains unsupported.

Component placement and tile identity remain separate. The stable placement
context binds the owner, LocalSpace, scene, delivery dimensions, and algorithm,
but not the component's complete graphical subtree. The exact placement plan
adds sampled owner controls, time, transform work, and the LocalSpace tile
identity. Consequently an owner-control edit preserves the retained tile while
invalidating placement; a child/media/finishing edit invalidates the tile and
final placement while preserving the stable placement context. Unrelated
scene and audio branches retain their normal localized cache identities. This
does not claim a separate persistent tile cache beyond the documented scene
cache.

## Planning, identity, and evidence

The planner identity is `cut-reference-local-compositing-v1`. It records:

- exact local dimensions and straight-RGBA boundary;
- ordered operation IDs, paths, public configurations, and work estimates;
- referenced signal hashes;
- a recomputed semantic identity for each complete reachable graphical
  subtree, including leaf values;
- one aggregate plan identity.

Consequently a leaf-only graphical change invalidates the operation, local
tile, semantic diff, and picture cache identity. An unrelated audio-only edit
does not. Formatting or comments do not participate.

`cut inspect` exposes the static plan and its refused halo boundary. Completed
frame-v2 evidence adds the plan identity, ordered operation identities, work
estimates, exact tile dimensions, and the final tile RGBA SHA-256. Owner
evidence remains separate, so a receipt distinguishes local rendering from
later placement or projective warp.

Every current exact-frame writer sets
`execution.evidenceProfile` to
`cut-reference-frame-execution/current-v2` and publishes a path-addressed,
root-first `execution.localSpaceExecutions` array. Each entry pairs one
completed execution and affine preflight for the root or a contributing
`Precomp`/`NestedSequence` renderer instance. The companion closed
`execution.localSpaceExecutionTree` binds the exact renderer count, ordered
path identity, ordered renderer-frame identities, and one tree identity.

Before publication, CUT requires a module-private `WeakSet`-branded authority
minted by that successful locked renderer invocation. It is bound by object
identity to the exact locked IR, root composition, complete ordered receipt
array, expected receipts, and expected tree. Copying, spreading, truncating, or
reconstructing its public-looking fields cannot produce authority. A new
successful frame revokes the preceding brand; renderer close revokes the
current brand. The root and nested renderers share one immutable whole-IR
structural index, which validation reuses across the complete tree.

One root-owned evidence generation remains active until every tracked sibling
node-frame promise settles, including after another sibling rejects. Only then
does CUT deactivate and detach its ledger, so late work from a failed frame
cannot append to a later frame or evade the normal reentrancy refusal.

Both the completed-tree pre-scan and the live generation ledger count exactly
one raw record for each renderer wrapper, tile, embedded
`localCompositing.operations` entry, placement, execution skip, preflight
admission, and preflight skip. Each record also costs its renderer-path depth
in copy units. One frame is capped at 65,536 raw evidence records
and 262,144 depth-weighted copy units. Live reservation refuses the first
over-budget append; the completed-tree pre-scan refuses excess before tree
identity hashing or authority deep-copy. Root publication recomputes both
totals from the completed receipt tree and requires exact equality with the
live ledger before minting evidence authority.

The semantic pass re-derives closed counters, tile and placement identities,
affine work, and aggregate preflight identity from the locked IR. Affine owner
skips are reconciled in an exact-sample O(n) multiset keyed by LocalSpace,
owner, skip kind, and canonical rational sample time: every preflight skip must
consume exactly one execution skip and no execution skip may remain. False
component-fragment, `Track2D`, or `DepthLayer` ownership therefore fails.

Persisted current-v1 JSON is separately checked for strict closure: every
per-renderer/frame identity, counter relation, count/path/frame/tree digest,
and the preserved root fields must recompute. This is integrity evidence, not
a signature or stored-artifact authenticity claim; external manifest digests
or deterministic locked rerender remain the persistence boundary. The profile,
tree, and renderer-array fields remain optional only so frozen frame-v2
manifests stay valid. Current writers always emit them, while historical
`execution.localSpaces` and `execution.localSpaceTransformPreflight` retain
their prior meanings.

When a plan contains retained media beneath a wrapper, additive
`execution.retainedMediaLocalCompositors[]` evidence records authored-preorder
inspection and complete child-first-postorder execution. Every admitted media
island and compositor operation is present exactly once as either `rendered`
or `skipped`; skips carry one closed runtime reason. A mixed LocalSpace with a
historical direct media island links the separate source-ordered composition
execution, its allocation identity and the same final tile hash. Omitting an
island, operation or mixed-plan link is a runtime-evidence error, not an
implicit skip.

## Bounds and diagnostics

V1 permits at most 512 admitted operations and 536,870,912 estimated operator
pixel-work units in one `LocalSpace`; one execution domain permits at most
4,096 operations and 1,073,741,824 work units. Existing LocalSpace, mask,
clip, effect, graph, and allocation limits also apply.

Planning failures are source-located and use the stable families:

- `CUT_LOCAL_COMPOSITING_GRAPH`;
- `CUT_LOCAL_COMPOSITING_UNSUPPORTED`;
- `CUT_LOCAL_COMPOSITING_LIMIT`.

The strict CutAVIR loader independently closes admitted descendants and hostile
operation counts before runtime execution.

## Explicit exclusions

`Shadow` and `Glow` are rejected inside this V1 boundary because their halo can
escape the declared tile and CUT has not published a halo expansion/clipping
policy. `MotionBlur`, `ChromaKey`, `LUT`, `TonalCurve`, `ColorConvert`,
`Stack`, `Precomp`, `ResponsiveStack`, `DiagramLayout`, and nested camera or
tracking graphs do not participate. No accepted excluded node is treated as a
no-op.

Ordinary points/VectorPath `MotionPath` is therefore not an exclusion.
Anchored owner-resolved geometry inside LocalSpace, a hidden delivery-canvas
fallback, and broader nested camera/tracking ownership remain exclusions.

This slice also does not provide effect-local expanded bounds, animation for
currently static effect inputs, HDR/scene-linear compositing, GPU parity, or
cross-platform pixel equivalence. Retained media is admitted only as maximal
unchanged V1 islands below this closed wrapper set; Precomp, ChromaKey,
MotionBlur, LUT, TonalCurve, ColorConvert and arbitrary media-bearing wrappers
remain refused.

## Executable proof

- `tests/reference-local-compositing.test.ts` covers all nine admitted
  operations on a `20x14` tile, exact order, local ClipPath dimensions,
  temporal Grain, zero-alpha RGB safety, leaf-edit identity/cache locality,
  audio neutrality, hostile counts, loader/runtime refusals, and an
  instrumented assertion that delivery-sized descendant rendering is never
  reached.
- `tests/reference-retained-media-viewport.test.ts` covers retained Image
  islands below Mask, ClipPath, Composite and Blur, mixed historical/V2 roots,
  complete rendered/skipped postorder evidence, omission/link tampering,
  straight-alpha output, source-order and zero delivery preraster.
- `tests/reference-local-compositing-studies.test.ts` renders two unrelated
  exact fixtures through the ordinary runtime: a `190x72` callout before
  `Track2D` placement and a `240x140` card before `Plane3D` / `Camera3D`
  projection.

These deterministic frames are engineering conformance, not full-speed
playback, sound, direction or professional-output approval.

The component-owner conformance fixtures are likewise engineering evidence
only. Complete full-speed playback, headphone listening, named-human review,
independent creative review, and professional-output approval remain
unperformed; this slice does not upgrade VIS-01 or any reference study to PASS.
