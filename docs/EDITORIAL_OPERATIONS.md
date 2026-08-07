# Deterministic picture-track edit operations (0.4 alpha)

This is an executable picture-editorial slice, not a claim that CUT already has
the complete 1.0 timeline. It adds a pure, ordered operation algebra to the
public `@cut/edit` `PictureTrack` API. CUT source remains canonical: the compiler
lowers every operation into a closed typed operation plan and materializes the
result as ordinary `PictureClip` and `Gap` nodes consumed by the reference
renderer. There is no model, mutable editor state, hidden JSON, or title-specific
render path.

```cut
import {
  Sequence, PictureTrack, PictureClip, Gap,
  editClip, split, slip, slide, rippleInsert, overwrite, lift, extract
} from "@cut/edit";

Sequence(duration: 2500ms) {
  PictureTrack(
    sourceDuration: 3s,
    edits: [
      split(at: 500ms),
      rippleInsert(
        at: 1s,
        item: editClip(source: blue, range: 0s ..< 500ms, duration: 500ms)
      ),
      overwrite(
        range: 1500ms ..< 2s,
        item: editClip(source: blue, range: 500ms ..< 1s, duration: 500ms)
      ),
      lift(range: 2s ..< 2500ms),
      extract(range: 2500ms ..< 3500ms)
    ]
  ) {
    PictureClip(source: red, range: 0s ..< 1s, duration: 1s);
    PictureClip(source: green, range: 0s ..< 1s, duration: 1s);
    Gap(duration: 1s);
  }
}
```

`sourceDuration` is the exact duration filled by the authored child items before
edits. The owning `Sequence.duration` is the required materialized duration.
They may differ, but the ordered operation result must equal the owning sequence
exactly. Both `sourceDuration` and `edits` are required together. An empty edit
list, a net no-op list, or either argument without the other fails explicitly.

All operation coordinates are exact half-open destination times relative to the
track origin. Each operation sees the result of the preceding operation. Every
point, range endpoint, and inserted duration must land on the composition frame
grid. Source ranges remain exact rationals and are checked against locked source
frame grids and bounds through the normal lock/runtime path.

## Closed public API

```text
PictureTrack(
  sourceDuration?: Time,
  edits?: List<PictureEdit>
) { PictureClip | Gap children }

editClip(
  source: VideoAsset,
  range: Range<Time>,
  duration: Time,
  headHandle?: Time,
  tailHandle?: Time,
  playback?: "normal" | "reverse" | "freeze",
  rate?: Number,
  freezeAt?: Time,
  speedRamp?: List<PictureSpeedPoint>,
  fit?: "cover" | "contain" | "fill",
  opacity?: Ratio,
  scale?: Number,
  rotation?: Angle,
  inputColor?: "srgb" | "linear-srgb" | "rec709-full" | "rec709-limited" | "bt470bg-smpte170m-limited"
) -> PictureEditItem

speedPoint(at: Time, rate: Number) -> PictureSpeedPoint

editGap(duration: Time) -> PictureEditItem

split(at: Time) -> PictureEdit
trim(keep: Range<Time>) -> PictureEdit
rippleInsert(at: Time, item: PictureEditItem) -> PictureEdit
rippleDelete(range: Range<Time>) -> PictureEdit
overwrite(range: Range<Time>, item: PictureEditItem) -> PictureEdit
replace(range: Range<Time>, item: PictureEditItem) -> PictureEdit
lift(range: Range<Time>) -> PictureEdit
extract(range: Range<Time>) -> PictureEdit
slip(range: Range<Time>, by: Time) -> PictureEdit
slide(range: Range<Time>, by: Time) -> PictureEdit
```

Unknown arguments and wrong operand types fail in the ordinary parser/type
checker. The reference compiler currently bounds one track plan to 256 ordered
operations.

## Exact operation semantics

- `split(at:)` divides the one current `PictureClip` strictly containing `at`.
  Splitting at an existing boundary or splitting a gap is rejected as a no-op.
  Forward, reverse, constant-rate, freeze, and bounded speed-ramp mappings
  preserve their exact source-time meaning on both resulting clips. A ramp is
  integrated and sliced at the boundary rather than flattened.
- `trim(keep:)` requires a strict destination subrange of exactly one current
  picture clip. CUT retains that subrange, adjusts its source range, and
  materializes each removed edge as an explicit gap. Track duration is unchanged.
- `rippleInsert(at:item:)` splits at `at` when necessary, inserts one picture or
  explicit gap item, and shifts all following items later by its exact duration.
- `rippleDelete(range:)` removes the selected interval and shifts following
  material earlier. Removing the entire positive track is rejected.
- `overwrite(range:item:)` replaces any exact range, including a range crossing
  edit boundaries, without changing track duration. The operand duration must
  equal the overwritten range exactly.
- `replace(range:item:)` requires the range to identify exactly one current
  picture clip. It replaces that clip and ripples following material by the
  exact duration delta.
- `lift(range:)` replaces the selected interval with one explicit gap and leaves
  later material at the same destination times.
- `extract(range:)` removes the selected interval and ripples following material
  earlier. It retains a distinct typed operation identity from `rippleDelete`.
- `slip(range:by:)` requires `range` to identify one complete current
  `PictureClip`. Its signed `by` delta shifts the clip's chronological source
  window while leaving destination start, destination duration, and time-map
  shape unchanged. Freeze clips shift both the authored source range and
  `freezeAt`; speed-ramp points remain relative to the same destination clock.
  A zero
  delta, partial/gap/cross-boundary target, negative source start, off-grid
  delta, or locked source overflow fails explicitly.
- `slide(range:by:)` requires `range` to identify one complete current
  `PictureClip` with one explicit adjacent item on each side. The target keeps
  its source window and duration and moves by the signed delta. The previous
  item's duration changes by `+by`; the next item's duration changes by `-by`,
  so total track duration is invariant. Adjacent items may be gaps or picture
  clips. Picture extension/trim preserves forward, reverse, constant-rate,
  freeze, or bounded speed-ramp mapping and is checked against the locked
  source grid and media bound. Extending a ramped neighbor holds its nearest
  endpoint rate over the new interval.
  Track-edge targets, zero deltas, exhausted neighbors, or ambiguous ranges are
  refused.

Adjacent gaps created by an operation are coalesced deterministically. Final
materialized node IDs are derived from the track, temporal order, canonical
inputs, source interval, and time-map semantics—not source formatting or spans.
Operation/source provenance remains attached for diagnostics but is excluded
from semantic identity, so comments and formatting do not invalidate builds.

## Explicit linked picture/audio trim

`LinkedTrim` is a separate public transaction for the one coupled edit that is
currently closed end to end: a bounded, duration-preserving, non-ripple trim.
It is authored directly in a scene, alongside exactly one linked `PictureClip`
and one linked track `AudioClip`:

```cut
import { LinkedTrim, Sequence, PictureTrack, PictureClip, AudioTrack } from "@cut/edit";
import { AudioClip } from "@cut/audio";

scene take(duration: 4s) {
  LinkedTrim(link: "take-a", keep: 1s ..< 3s);
  Sequence(duration: 4s) { PictureTrack() {
    PictureClip(source: picture, range: 0s ..< 4s, duration: 4s, link: "take-a");
  } }
  AudioTrack() {
    AudioClip(source: voice, range: 0s ..< 4s,
              destination: 0s ..< 4s, link: "take-a");
  }
}
```

The declaration is non-rendering and may appear only as a direct scene
statement. `keep` is one positive, proper, half-open scene-local destination
subrange. Both endpoints must land on the composition picture-frame grid and
audio-sample grid. The link must resolve within that scene to exactly one direct
picture item and one direct audio item, and both items must contain the complete
keep range. Tracks with an existing operation plan or transition window are
rejected. A scene/link pair may be trimmed once; a compilation unit may contain
at most 256 transactions.

CUT collects these statements before applying them, so their source order
relative to the track declarations does not change the result. It stages every
affected picture/audio plan and every materialized child before committing any
of them. A failure in any later transaction leaves the input IR untouched. A
successful transaction retains the selected destination range on both tracks,
turns removed edges into explicit link-free gaps, independently advances each
source range, and preserves the shared link on the retained picture/audio pair.

CutAVIR v3 records the operation once in top-level `linkedEdits` as a versioned
`linked-trim` transaction with composition, scene, link, keep range, picture
track, audio track, and source provenance. The correlated trim in each track's
typed operation plan carries that transaction's `transactionId`. Transaction
identity is stable across formatting/comments and does not include `keep`, so a
keep change is a field-level semantic modification rather than delete/add.
Strict IR loading rejects missing, duplicated, unknown, or one-sided
correlation. Stable source diagnostics are `CUT_LINKED_TRIM_SCOPE`,
`CUT_LINKED_TRIM_TIME`, `CUT_LINKED_TRIM_UNSUPPORTED`,
`CUT_LINKED_TRIM_RESULT`, and `CUT_LINKED_TRIM_LIMIT`.

Before picture or audio execution, the central reference validator independently
re-correlates and replays both typed plans and their materialized children. It
issues one frozen authorization per valid transaction through mutation-resistant
read-only maps keyed by transaction, scene/link, and owning picture/audio track.
The per-track validators accept a transaction-bearing trim only with its exact
central authorization. Locked session validation, the direct visual constructor,
and direct audio rendering all cross this boundary, so a caller cannot bypass
the correlation check by invoking a backend directly. Runtime refusal uses
source-located `CUT_LINKED_TRIM_CARDINALITY`, `CUT_LINKED_TRIM_CORRELATION`,
`CUT_LINKED_TRIM_PLAN`, or `CUT_LINKED_TRIM_MATERIALIZATION` as applicable.

The complete public syntax -> typed IR -> immutable authorization -> picture and
audio runtime path is executable for this bounded slice. The focused runtime
proof locks generated FFV1 picture and PCM/WAV audio, decodes the exact retained
source frames and samples plus link-free destination gaps, proves direct
per-track calls fail without authorization, and proves a one-sided transaction
fails before audio output publication. OTIO export still emits one
provenance-backed `CUT_OTIO_LINKED_TRIM_UNSUPPORTED` `lossy-editorial` issue per
transaction instead of pretending the atomic operation can round-trip.

## Linked fixed-duration ripple delete (bounded executable slices)

`LinkedRippleDelete` is a separate coupled transaction with two closed forms.
Omitting `range` preserves the version-1 complete equal-range pair contract.
Supplying `range` selects one positive strict interior scene-local range from
one direct picture member and one direct audio member; their outer ranges may
differ, so ordinary J/L timing is preserved:

```cut
import { LinkedRippleDelete } from "@cut/edit";

scene take(duration: 4s) {
  LinkedRippleDelete(link: "false-start");
  // Direct PictureTrack and AudioTrack declarations containing exactly one
  // complete PictureClip/AudioClip pair linked as "false-start" follow.
}

scene jl_take(duration: 5s) {
  LinkedRippleDelete(link: "answer", range: 2s ..< 3s);
  // Picture may span 1s ..< 4s while audio spans 500ms ..< 4500ms.
}
```

The compiler resolves exactly one direct picture member and one direct audio
member in the scene. Version 1 requires identical complete destination
intervals. Version 2 requires the explicit range to be strictly inside both
members, leaving positive before and after fragments. It then stages, on both
tracks and as one all-or-nothing mutation:

1. a `ripple-insert` at the original track end containing transparent
   picture gap or audio silence equal to the selected duration; then
2. a `ripple-delete` of the selected interval translated into that track's
   local clock.

Inserting closure first means even a complete-track deletion remains a valid
positive track. Later material shifts earlier in picture and sound, while the
owning track/scene duration remains fixed and the tail becomes explicitly
transparent/silent. The omitted-range form records version 1 and removes the
complete pair. The explicit-range form records version 2, keeps authored
`linkId` as relationship-group identity on all four survivors, and records two
compiler-derived `linkSegmentIds` (`before` and `after`). Corresponding picture
and audio survivors share one segment ID; arbitrary, orphan, mixed or reused
segment IDs fail strict loading. Both forms record the resolved `range`, track
IDs and provenance.
Exactly two operations per side carry the same `transactionId`; each ripple
deletion also carries `transactionVersion: 1 | 2`, and only version 2 requires
the closed before/after segment pair. This local discriminator lets the public
schema reject a stripped v2 correlation without guessing from a remote array.
Comments do not change transaction, segment, build or cache identity. Moving a
version-2 range changes the transaction and both survivor identities.

Version 2 accepts only direct neutral forward-1x clips. Non-default picture
fit, opacity, scale or rotation; animated picture properties; processed
AudioRegion graphs; fades; handles; overlap; freeze/reverse/retime/speed ramps;
pre-existing plans or transitions; edge-touching selections; nested operands;
and repeated or mixed linked transactions on one affected track remain refused.
CUT does not flatten or guess around those states. Diagnostics are
`CUT_LINKED_RIPPLE_SCOPE`, `CUT_LINKED_RIPPLE_TIME`,
`CUT_LINKED_RIPPLE_UNSUPPORTED`, `CUT_LINKED_RIPPLE_RESULT`, and
`CUT_LINKED_RIPPLE_LIMIT`.

Public parsing, checking, deterministic compiler staging, both pure operation
algebras, typed IR, strict loader/schema correlation and hostile-input proof
pass in `tests/linked-ripple-delete-language.test.ts`,
`tests/linked-ripple-delete-algebra.test.ts`, and
`tests/linked-ripple-delete-v2.test.ts`. The generalized central runtime
validator re-correlates and replays both operation plans, then issues immutable
authorization to the picture and audio tracks. Locked execution in
`tests/reference-linked-ripple-delete-runtime.test.ts` proves the shifted
red/blue/yellow/transparent decoded frame progression, exact corresponding PCM
progression plus silent tail, cold/warm audio-cache reuse, direct per-track
authorization refusal, and one-sided failure before visual or audio output
publication. OTIO export reports one exact
`CUT_OTIO_LINKED_RIPPLE_DELETE_UNSUPPORTED` lossy issue with transaction
provenance rather than claiming an atomic round trip. This closes complete-pair
v1 and strict interior/J-L-aware v2 vertical slices. Multi-item, processed,
overlap and nested ripple semantics remain release work, so no broad 1.0 row
advances to `PASS` from this slice alone.

## Diagnostics and hostile input

- `CUT2090`: malformed, empty, redundant, or net no-op operation plan;
- `CUT2091`: invalid range, point, duration, target, or picture-frame boundary;
- `CUT2092`: materialized duration/result cannot satisfy the owning sequence;
- `CUT2093`: an unsupported uncoupled use of `link:` in the ordinary
  picture-only operation plan; linked operations use explicit scene
  transactions rather than silently mutating one track;
- `CUT_EDIT_OPERATION`: loaded typed plan, canonical materialization, or runtime
  reconciliation failure with operation provenance.

The CutAVIR v3 loader closes every plan/item/operation field, validates exact
rationals, resource references, provenance, collection bounds, content hashes,
and build identity. Runtime validation replays the typed plan and reconciles
every final item ID, interval, source interval, time map, kernel input, and track
duration before picture execution.

## Evidence and current limits

`tests/reference-picture-edit-operations.test.ts` proves all ten public edit
operations plus the explicit gap operand semantically; exact
forward/reverse/freeze split and slip mapping; positive/negative slide over gap
and picture neighbors; exact speed-ramp slicing/slip/slide preservation; stable
source/loaded-IR diagnostics; locked source-bound refusal;
formatting-independent and delta-sensitive identity; and real decoded
red/blue/yellow/gap frame regions after unrelated multi-operation plans.
`tests/reference-linked-trim-runtime.test.ts` separately proves the bounded
cross-track transaction with a real lock, direct-entry authorization checks,
decoded FFV1 pixels, exact PCM boundaries, explicit destination gaps, and
failure-before-publication behavior.
`tests/reference-linked-ripple-delete-runtime.test.ts` proves the second
bounded cross-track transaction with locked decoded frame/PCM progression,
explicit transparent/silent tail, cold/warm audio-cache evidence, direct-entry
authorization checks and one-sided failure before publication. `tests/otio.test.ts`
proves its exact structured lossy report.

The ordinary operation algebra in this document remains picture-track only;
the separate audio-track operation algebra is documented in
`EDITORIAL_AUDIO_OPERATIONS.md`. `LinkedTrim`, complete equal-range
`LinkedRippleDelete` v1, and direct-neutral strict-interior/J-L-aware
`LinkedRippleDelete` v2 are bounded cross-track runtime transactions.
`PictureClip` and `editClip` expose
independently locked `headHandle` / `tailHandle` source availability, and
multiple `transitionAt` declarations can consume exact centered half-handles
without changing destination duration when their overlap windows are disjoint.
Structural edits materialize first, so every transition resolves or fails
against the final cut topology. Extra availability is legal and does not alter
render/cache identity. Slide still extends a neighbor through its visible range
semantics rather than consuming a transition reservation. CUT does not yet
implement intersecting/layered overlap edits, nested-sequence edits,
multi-item linked operands, linked slip/slide/transition selection,
processed/faded/handled/retimed/overlap linked-ripple bases, general undo
transactions, or lossless OTIO operation round-trip. Ordinary per-track edit plans still
refuse linked picture material instead of silently uncoupling it; use
explicit linked scene transactions only for their documented bounded contracts. EDT-02 therefore remains
`PARTIAL`, not `PASS`. See `EDITORIAL_TRANSITIONS.md` for the exact transition
and handle contract.

## TimelineEdit inspection, semantic diff, and cache identity

When a graph contains the canonical multi-track `TimelineEdit` plan, `cut
inspect --json` reports the complete authored plan and an independently replayed
execution summary. The report includes:

- owning composition/scene and exact initial/final duration;
- ordered track and item roles, namespaced metadata, links, handles, source
  authority, time maps, and destination intervals;
- each operation's exact picture/audio clocks, with aligned, J-cut, or L-cut
  classification;
- the replayed terminal tracks, picture/audio transition receipts, correlated
  linked cut boundaries, and both the historical provenance-bearing
  `materializationId` and provenance-free `semanticMaterializationId`.

`cut diff` treats each plan as one stable `timeline-edit` entity. Operation,
source authority, track/item role or metadata, retime, link, transition kind,
curve, handle, and exact-clock changes are reported as field-level modifications
instead of being hidden inside unrelated materialized node churn.

Build identity and the owning scene's picture-cache identity bind the complete
provenance-free authored plan under the package implementation closure; inspect
separately replays that plan and publishes the terminal semantic
materialization. Formatting and source spans therefore do not invalidate cache
reuse, while every executable edit change does. Strict loading/runtime replay
still validates a plan before rendering may consume that cache identity. Graphs
that omit `TimelineEdit` retain the legacy inspect, diff, and cache shapes
without an empty feature field.

This identity is not a claim that every edit already round-trips losslessly
through every interchange adapter. Inspect and diff report the exact CUT
semantics that exist; exporters must still issue structured loss records for
unsupported external representations.
