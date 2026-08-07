# Canonical TimelineEdit algebra (0.4 alpha)

`TimelineEdit` is CUT's scene-local, atomic nonlinear-edit authority. It is a
typed editorial transaction, not a rendering node and not a compatibility
alias for the older independent picture/audio operation lists.

The contract deliberately remains alpha. Direct media, the bounded
origin-clock processed/faded/constant-retimed audio subset, and the bounded
picture-only static `Precomp` subset execute through compiler materialization
and runtime replay; audiovisual nesting and transcript-derived forms are
accepted only at the boundaries listed below.
Unsupported forms fail with a stable `CUT_TIMELINE_EDIT_*` diagnostic before
pixel, PCM, cache, or output publication.

## Authored identity and clocks

Every participating `PictureTrack` or `AudioTrack` owns an authored `trackId`.
Every media item owns an authored `editId`; compiler node IDs, filenames, list
positions, and co-location are not editorial authority. Optional `role` is a
closed CUT role. Vendor metadata is a bounded string-to-string map whose keys
must use a dotted, non-`cut.*` namespace.

Picture and audio clocks are independent exact rationals. An `AVTime` may
therefore carry different picture and audio values; that is the canonical J/L
boundary rather than an error to normalize away. Every authored boundary must
land on its destination frame or sample grid.

```cut
TimelineEdit(id: "dialogue-assembly", operations: [
  editBoundary(
    selection: editSelection(trackIds: ["v1", "a1"]),
    at: avTime(picture: 2250ms, audio: 1750ms)
  ),
  editTransition(
    left: editSelection(
      trackIds: ["v1", "a1"],
      originIds: ["picture-left", "audio-left"]
    ),
    right: editSelection(
      trackIds: ["v1", "a1"],
      originIds: ["picture-right", "audio-right"]
    ),
    at: avTime(picture: 2250ms, audio: 1750ms),
    duration: avTime(picture: 500ms, audio: 500ms),
    pictureKind: "cross-dissolve",
    audioCurve: "equal-power"
  )
]);
```

Linked items are a closure: touching one side while its linked peer is outside
the selection fails. `allowUnlinked: true` is the explicit identity-bearing
request to edit one side intentionally.

## One operation model

The closed operation union is:

- `editSplit`
- `editTrim`
- `editRippleDelete`
- `editLift`
- `editExtract`
- `editSlip`
- `editSlide`
- `editBoundary`
- `editInsert`
- `editOverwrite`
- `editTransition`

All operations use the same `EditSelection`, exact interval, source-view,
lineage, link-closure, track-order, metadata, and atomic-publication laws.
Ripple and extract preserve fixed programme duration by materializing an
explicit transparent/silent tail. Lift and trim materialize explicit
transparent/silent coverage. Insert shifts material later and consumes only
declared tail-gap coverage. Overwrite preserves duration and replaces exactly
the declared coverage.

Insert and overwrite copy an operand from the transaction's immutable initial
tracks. A multi-domain operand requires a new `linkId` and is committed only
after every picture/audio target succeeds:

```cut
editInsert(
  picture: editSelection(trackIds: ["v1"]),
  audio: editSelection(trackIds: ["a1"]),
  at: avTime(picture: 2s, audio: 2s),
  operand: editOperand(
    linkId: "inserted-take",
    parts: [
      editOperandPart(
        domain: "picture",
        sourceOriginId: "source-picture",
        originId: "inserted-picture",
        duration: 2s
      ),
      editOperandPart(
        domain: "audio",
        sourceOriginId: "source-audio",
        originId: "inserted-audio",
        duration: 2s
      )
    ]
  )
)
```

No operation silently falls back to the old track operation lists. The direct
linked insert/overwrite form shown above has decoded picture and PCM witnesses
across seven paired boundaries, deterministic repeats, exact terminal link
ownership, and hostile failure-before-publication proof. A separate bounded
audio form copies one complete initial `AudioRegion` origin within its own
track or onto another AudioTrack without restarting its fades, processor state,
or constant `TimeStretch`, and another
copies one complete initial static 1:1 `Precomp` item without flattening its
source graph. Audio cross-track placement derives an explicit source-track plus
source-origin authority, evaluates that graph once under its source-track owner,
and gives every source/destination track an immutable view. One direct picture
part may be coupled to that complete-origin audio part in the same linked
insert/overwrite transaction; exact decoded pixels/PCM and OTIO link-group,
lineage, multiplicity, and target-scoped-loss tests cover this bounded form.
Multiple stateful parts, processed audiovisual/nested operands, and transformed
nested copies remain unsupported. The `Precomp` form remains same-track only.

## Source-view and time-map boundaries

The planner represents direct picture, direct audio, processed audio, and
shared-clock nested source views. It retains source ranges, declared handles,
origin-relative audio presentation clocks, picture time maps, processor
authority, nested composition authority, and a closed nested placement policy
through lineage changes. New compiles emit either `structural-only` or
`static-same-track-copy`; legacy omission means structural-only and never
grants insert/overwrite authority.

Current executable compiler materialization is narrower:

| Source view | Planning | Compiler/runtime materialization |
| --- | --- | --- |
| direct picture, forward 1x | yes | yes |
| direct picture, constant speed/reverse/freeze/speed ramp | yes | yes for structurally valid operations; unsupported handle/transition/slip combinations fail |
| direct 1x audio with zero authored fades | yes | yes |
| faded direct exact-1x audio | yes | structural operations and complete-origin same-track/cross-track insert/overwrite preserve one source-owned origin-relative fade; authenticated slip, slide, boundary adjustment, and handled transition execute without cloning or restarting it. Declared head/tail media handles use the `selected-source-union-v1` envelope. Exact placement, two-direction slide/boundary, transition, scene-edge, cache, and hostile-tamper proofs are executable. |
| processed `AudioRegion`, exact-1x static unary chain | yes, with one authenticated graph evaluation | structural operations, complete-origin same-track/cross-track insert/overwrite, and authenticated slip, slide, boundary adjustment, and handled transition execute without restarting state. Cross-track views bind the exact source AudioTrack and share its single origin owner. Results that consume declared external handles evaluate the complete declared handle domain once under `full-declared-handle-domain-v1`. This path requires one non-empty static unary Gain/Pan/ParametricEQ/HighPass/LowPass/Compressor/DeEsser chain and one AudioClip leaf. |
| constant-retimed processed `AudioRegion` | yes, with one authenticated graph evaluation and origin-relative fade witness | structural operations, complete-origin same-track/cross-track insert/overwrite, authenticated slip, slide, boundary adjustment, and handled transition execute at the exact constant source clock. External media handles require exactly one innermost static `TimeStretch` directly above the `AudioClip`; CUT decodes the full source-handle domain, stretches it once, applies the remaining outer static chain once, and slices presentation views afterward. Variable or automated retime remains refused. |
| picture-only static 1x `Precomp` | yes | split, trim, lift, extract, and ripple-delete preserve the authenticated presentation; childless, property-static, pure instances whose only executable inputs are `source`, `range`, `x`, `y`, `scale`, `rotation`, and `opacity` gain same-track complete-item insert/overwrite authority |
| audiovisual shared-clock `NestedSequence` | yes for bounded structural planning | changed nested graph materialization is not yet public |

The executable `Precomp` row is deliberately narrower than generic nesting.
Its source must remain picture-only, unlinked, property-static, and 1:1.
Structural edits may segment the already authenticated half-open source range
while preserving static transform/opacity presentation inputs and their source
authority. Insert and overwrite are narrower: they may copy exactly one
complete initial-plan childless, property-static, pure item within its owning
`PictureTrack`; the closed executable-input set is `source`, `range`, `x`, `y`,
`scale`, `rotation`, and `opacity`. In every case,
the copied view keeps the source composition, range, lineage, role, and
source-then-placement metadata merge. Cross-track copies, linked, dynamically
transformed, effectful, or child-bearing placement operands, partial nested
operands, slip, boundary/handle edits,
transitions, and every audiovisual `NestedSequence` operand fail before graph
or cache allocation.

Picture mapping uses the exact contract in
[`EDITORIAL_TIME_MAP.md`](EDITORIAL_TIME_MAP.md). Slip refuses freeze and
variable ramps because their inverse source map is not closed. Transitions
require invertible handle mapping and never clamp or synthesize media.
Intersecting transition windows and structural operations after a terminal
transition fail.

## Transcript use

An authority-backed `TranscriptMediaAuthority` may feed linked
`TranscriptPicture` and `TranscriptAudio` into ordinary named tracks. A
canonical `TimelineEdit` then selects and materializes those items using the
same operation, lineage, link, grid, runtime replay, diff, and cache laws as
ordinary media.

The current executable transcript slice is authenticated linked split, trim,
and ripple-delete. Trim and ripple operate on the same selected track items,
derive ordinary segment lineage, and retain the immutable selected-word
binding; they do not invoke a transcript-only editor. Cross-file synchronized
audio/video sources are supported through explicit stream selectors and clock
mapping. Legacy co-located transcript picture, slip, slide, boundary,
transition, insert, overwrite, and source retime remain fail-closed until
their revised transcript-origin or media-handle authority is executable.
See [`TRANSCRIPT_MEDIA_AUTHORITY.md`](TRANSCRIPT_MEDIA_AUTHORITY.md).

## Runtime, inspect, diff, and cache

Compilation stages all selected tracks against one immutable initial graph,
then commits only after every track, source authority, handle, grid,
transition, node identity, and result invariant passes. The strict loader and
reference runtime independently replay the transaction before pixels or PCM.
A stale or forged plan cannot bless previously materialized children.
This replay is also mandatory at the direct PCM and stem boundaries and at the
supported picture-only `Precomp` selection boundary, before resource-path
resolution or output allocation; the audio cache is not a stronger semantic
gate than uncached execution. Changed audiovisual `NestedSequence`
materialization remains a source-located refusal, not an executable nested
selection claim.

`cut inspect` reports the plan, ordered tracks/items, source views, roles,
namespaced metadata, links, exact J/L relationship, transitions, historical
materialization ID, and provenance-free executable identity. Semantic diff
uses a first-class `timeline-edit` entity. Relevant plan/result semantics are
replayed before both picture and audio cache projection and participate in
their owning-scene identities; omission preserves the legacy graph shape.

## OTIO

The CUT OTIO editorial profile carries exact rational track/item intervals,
links, roles/namespaced metadata, constant forward/reverse retimes, transition
handles/styles/curves, and the supported materialized track subset.
Its closed linked-transition subset reconstructs a paired picture/audio J/L
edit as one canonical scene-local `TimelineEdit` containing the exact
`editBoundary` plus `editTransition`; it does not import two unrelated legacy
track edits. Representable profile data round-trips through the registered
production OTIO adapter and strict importer.

The separate optional V4 nested-placement authority binds a V2 profile to the
exact visible `TimelineEdit` lineage, nested instance identity, source
composition/range, closed placement policy, role, and namespaced metadata for
bounded `Precomp` lineage. Native OTIO metadata is reconciled against that
authority.
It does not make generic OTIO or an external NLE execute CUT's nested graph.
Unsupported processor graphs, arbitrary multi-segment link groups, executable
nested import, variable retime, and semantics without an OTIO equivalent are
reported as typed target-scoped loss or refused unless the caller explicitly
selects the documented lossy path. CUT never labels a flattened operation
lossless. See [`OTIO.md`](OTIO.md).

## Verification and honest status

The public test corpus covers source checking, operation laws, schema and
strict loading, compiler materialization, runtime replay, processed-audio
authority, transcript integration, inspect/diff/cache identity and the
supported OTIO profile. This is automated alpha conformance, not a claim of
generic NLE parity or human workflow approval.

This feature does not by itself close EDT-01..06/09, AUD-01, or OTI-01/04.
Multiple processed or nested state-bearing operands, processed
external-handle graphs outside the static unary-chain contract with at most one
innermost constant `TimeStretch`, audiovisual nested materialization,
dynamically transformed, effectful, child-bearing, or retimed nested operands,
nested transitions, transcript
source-changing and transition operations, variable audio retime,
intersecting/layered transitions, custom curve extensions,
generic/external-NLE nested execution parity, exact packed replay of the next
shipped-byte freeze, and human workflow review remain open. CCH-05,
cross-platform install, signing, rights, and human playback/creative gates
also remain open. CUT remains `0.4.0-alpha.1`.
