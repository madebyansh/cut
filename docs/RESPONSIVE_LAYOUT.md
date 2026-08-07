# Responsive layout design slice

Status: public bounded alpha vertical for CUT `0.4.0-alpha.2`. Source, typed
IR, renderer, inspect/diff/cache identity, hostile-IR and three-aspect
pixel/wrapping proofs pass. A second closed branch now renders one
signal-driven source-resolution `MediaCamera2D` directly into a slot across
three aspects. One exact identity-component form also dispatches that stack
with source-anchored Path and/or Callout overlays without creating a wrapper
raster. This is not a general responsive-design system or a creatively
reviewed multi-aspect production.

The public pair is intentionally small:

```cut
component ResponsiveStory() -> Visual {
  let plan = responsiveStackPlan(
    weights: [2, 1],
    safeX: 5%,
    safeY: 8%,
    gap: 32px,
  );
  ResponsiveStack(plan: plan) {
    ResponsiveSlot() { StoryBody(...); }
    ResponsiveSlot() { EvidenceRail(...); }
  }
}

timeline landscape(duration: 4s, width: 1920px, height: 1080px) {
  scene main(duration: 4s) { ResponsiveStory(); }
}
```

`responsiveStackPlan` is bound to the active composition. Authors do not repeat its width or height. Landscape compositions use a horizontal main axis. Square and portrait compositions use a vertical main axis. Safe insets, the remaining content rectangle, gap subtraction, weight division, slot edges and end closure are exact rational geometry. The plan identity binds the composition dimensions, weight order, safe-area ratios, gap and algorithm version.

A top-level `const plan = responsiveStackPlan(...)` is invalid because module scope has no active composition. It fails with `CUT_RESPONSIVE_STACK_CONTEXT`; put the plan inside a component invoked by a timeline or directly inside a timeline/scene statement scope.

`ResponsiveStack` accepts only explicit `ResponsiveSlot` direct children, with
one slot per retained weight in source order. A slot has one of two closed
forms:

- exactly one ordinary direct visual (normally a reusable component fragment)
  from the bounded local-raster grammar: component fragments, `Group`, `Rect`,
  `Circle`, legacy or retained `Path`, `Text`, and `FlowText`; or
- exactly one direct `MediaCamera2D`, followed only by local `set`/`animate`
  statements targeting that same camera's `focusX`, `focusY`, `zoom`,
  `rotation`, or `opacity`.

The media-camera branch may contain the closed native Image/Video and unary
finishing chain documented in
[`MEDIA_CAMERA2D.md`](MEDIA_CAMERA2D.md). The compiler owns the camera's exact
slot context; public source cannot author or transplant it. Arbitrary direct
Image/Video, nested `LocalSpace`, Captions, unrelated siblings, other
mutations, control flow and every other unsupported descendant fail until they
have a genuine, unambiguous slot-local renderer.

The runtime quantizes every exact slot edge once with
`exact-edge-round-half-up-v1`, derives a positive whole-pixel tile from those
shared monotone boundaries, gives that tile local origin `(0px, 0px)`, and
places it at the quantized safe-slot top-left. A positive gap that disappears
at this raster boundary is rejected as a no-op. `FlowText` therefore receives
the actual local raster width and performs real line wrapping before
compositing.

A slot-bound `MediaCamera2D` uses that same raster tile as its sole output
geometry. It decodes and finishes the locked source at native post-crop
resolution, executes its one Q16 camera resample directly into the slot-sized
surface, and then performs one integer translation plus half-open slot clip.
There is no delivery-sized media or composition preraster and no second
geometric resample. Its camera receipt and ResponsiveStack placement receipt
cross-bind the exact/raster slot, compiler context, controls, work,
allocations, source bytes and output hashes. Opacity-zero skips decode, affine
and outer placement while retaining an explicit transactional skip receipt.

One aliased slot camera may be referenced after its ResponsiveStack in the
same immediate lexical scope. Existing
`visualAnchor(owner: camera, local: sourcePixel)` semantics then compose the
already-admitted source-to-slot Q16 affine with the slot's exact integer
placement to produce a composition-space point. Retained Path/MotionPath and a
later direct-scene CalloutLayer reuse that chain without another media decode,
effect pass or geometric resample. The completed anchor receipt, camera
receipt and ResponsiveStack placement receipt are transactionally
cross-bound. The alias never escapes a component invocation or module, and no
other nested alias is hoisted.

The same alias may be consumed inside one deliberately narrow reusable Visual
component shape. After expansion, the component invocation must be a pure,
input-free and property-free `cut.kernel.fragment`, be one direct visual root,
start at exact zero, and span its complete scene. Its ordered direct children
must be:

1. one `ResponsiveStack` first;
2. at most one source-anchored `Path`; and/or
3. at most one `CalloutLayer`.

At least one overlay child is required. The stack must contain exactly one
direct `ResponsiveSlot -> MediaCamera2D` chain, and every overlay anchor must
name that same camera. The direct children, chosen slot and camera, every
Callout, and every Callout LocalSpace must carry the same authenticated
component expansion. Imported component definitions are supported: definition
provenance stays in the defining module while invocation provenance and the
fragment span stay at the call site. Separate invocations remain separate
semantic/cache identities.

This fragment is transparent structural composition scope. The runtime
dispatches its admitted children in source order onto the composition and
performs zero wrapper raster materializations, canvas allocations, transforms,
clips, or geometric resamples. It is not a tile, precomposition, Group,
implicit transform, or second compositor.

The public vertical carries both closed forms through source checking and
composition-context lowering, typed IR, hostile-IR loading, graph and static
validation, reference rendering, inspect, semantic/cache identity, exact-frame
receipts, schema validation, docs and pixel/wrapping regression tests.

Inside a slot, shape `x` and `y` are ordinary local coordinates measured from that slot's top-left `(0px, 0px)`. Omitted shape coordinates center the shape in the current slot. Negative coordinates are allowed for intentional clipping, but a fully clipped layer is not creative proof; studies must verify visible pixels for every intended layer in every target aspect.

Closed boundaries:

- one weight is required per direct child; no implicit repeat, truncation or fallback;
- every direct child must be an explicit `ResponsiveSlot`; arbitrary direct visuals are never silently reinterpreted as local content;
- a reusable component wrapper around ResponsiveStack must be either the
  existing unary interval-preserving fragment or the exact identity-overlay
  shape above; wrapper inputs/properties, partial intervals, transforms,
  crops, effects, reordered children, a second camera, extra overlay kinds,
  `MotionPath` inside this component shape, and foreign/cross-invocation
  anchors fail instead of being flattened;
- preparatory `let` statements before the stack may bind compile-time values
  such as the responsive plan, but never Visual/Audio/AV nodes; an orphan
  rendering node fails at its source location and the compiler independently
  refuses any same-expansion node outside the fragment graph;
- weights must be positive exact Numbers and retain source order;
- safe-area ratios must be at least zero and less than 50%;
- gap must leave positive main-axis space, and a nonzero one-child gap is rejected as inert;
- loaded plans are re-derived, so a caller cannot re-hash invented slot geometry;
- child semantic identities must bind their public inputs, packages, resources and toolchain before execution;
- child intrinsic minimums that exceed the actual whole-pixel slot fail as overflow instead of clipping silently;
- a positive exact gap that becomes zero pixels at the sole raster boundary fails instead of becoming an accepted no-op.

Nonclaims for this slice: arbitrary breakpoints, grids, source-order changes,
hide/show rules, freeform media descendants, overlays inside the camera slot,
nested LocalSpace, constraint solving, CSS compatibility, intrinsic
measurement from final alpha pixels, or render-target-width reflow.
Responsive source anchors remain authored source coordinates—not feature
detection, tracking, subject understanding or automatic label placement.
CalloutLayer remains a direct scene root except when it is the authenticated
later child of the exact identity-component shape above. Arbitrary nested
CalloutLayer, component transforms, and general component compositing remain
rejected rather than flattened implicitly.
A plan is bound to its owning composition; one authored reusable component
must be invoked in separate 16:9, 1:1 and 9:16 timeline contexts to prove
reflow.
`render(timeline, width: ..., height: ...)` does not create another responsive
context: those dimensions are delivery assertions and a mismatch fails with
`CUT_OUTPUT_CANVAS_MISMATCH` rather than resizing or reflowing the timeline.
Public availability is bounded to the executed descendant grammars above.
Two unrelated local-raster sources and two unrelated locked Image/advancing
Video sources execute across all three aspects. These are engineering
conformance sources; named-human full-speed, phone and creative review remain
unperformed, so this evidence cannot satisfy the product dogfood or
professional-output gate.

The exact-frame manifest remains schema version 2 for compatibility. Current
writers add `execution.responsiveStacks`; the field is optional only so
historical v2 manifests remain valid. When present it is closed and records
the plan/execution identity, exact and raster slot geometry, per-slot RGBA
hash and visible-alpha count, observed `FlowText` line count/width, and the
closed nested MediaCamera2D execution/placement cross-binding when applicable.
The top-level camera receipt carries the same output context. Frames with a
slot-camera source anchor additionally publish the closed
`execution.responsiveSlotMediaAnchors` chain across the anchor consumer,
camera and stack receipts. Unknown receipt fields fail schema validation.
The reference runtime admits at most 4,096 aggregate responsive-slot media
anchor links per composition frame across Path, MotionPath, and Callout
consumers, matching the frame-v2 top-level array bound. Candidate collection
stops and fails with `CUT_RESPONSIVE_SLOT_ANCHOR_LIMIT` on the first
over-limit anchor, before receipt authentication or per-link camera/stack
binding; it does not first materialize an unbounded candidate or link ledger.
An admitted identity component additionally publishes
`execution.identityComponentFragments`. That receipt binds ordered child
content/output/cache identities, the exact camera, stack, Path, Callout and
slot-anchor ledgers, source order, scene output and zero wrapper-work counters.
Current rendered anchored-Path receipts include their final composition RGBA
hash; the field stays optional in the frame-v2 schema only so historical
manifests remain readable. The current fragment validator requires that hash
for its Path child and compares it with the authenticated anchored receipt.
It also requires a trusted scene RGBA hash recomputed from the completed
renderer surface (or from the persisted artifact pixels), rather than trusting
the fragment's self-declared scene hash. The public offline validators
recompute the complete source and link ledgers from serialized receipts;
contradictory, transplanted, oversized, pixel-forged or stale evidence fails
before a completed frame transaction is replaced. These hashes provide
deterministic integrity cross-binding, not a signature or provenance claim.
