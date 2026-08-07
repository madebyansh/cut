# AudioTrack edit operations (0.4 alpha)

This is the executable structural-edit contract for the public `AudioTrack`
operation vocabulary. It is a bounded vertical slice, not a claim that CUT's
complete 1.0 audio timeline is finished.

The source goes through the normal CUT parser and dimensional type checker,
lowers to a closed typed operation plan in CutAVIR, materializes ordinary
`AudioClip` and `AudioGap` children, replays and reconciles the plan in the
reference runtime, and then renders those children through the regular audio
backend. There is no model call, hidden timeline, fixture recognizer, or
operation-specific render shortcut.

That description is operation-plan v1. A separate v2 plan is selected only for
an all-`AudioRegion`, crossfade-only track. It preserves every outer region,
source leaf and static processor node, stores their canonical identities and
handle availability, and projects only typed transition metadata; it does not
flatten the processor graph into ordinary clips.

```cut
import {
  AudioTrack, AudioGap,
  editAudio, editSilence,
  audioSplit, audioTrim,
  audioRippleInsert, audioRippleDelete,
  audioOverwrite, audioReplace,
  audioLift, audioExtract,
  audioSlip, audioSlide
} from "@cut/edit";
import { AudioClip } from "@cut/audio";

AudioTrack(
  sourceDuration: 3s,
  edits: [
    audioSplit(at: 500ms),
    audioSlip(range: 500ms ..< 1s, by: 250ms),
    audioLift(range: 1s ..< 1250ms),
    audioOverwrite(
      range: 1250ms ..< 1500ms,
      item: editAudio(source: roomTone, range: 4s ..< 4250ms)
    )
  ]
) {
  AudioClip(source: answer, range: 8s ..< 9s,
            destination: 0s ..< 1s);
  AudioClip(source: answer, range: 10s ..< 11s,
            destination: 1s ..< 2s);
  AudioGap(destination: 2s ..< 3s);
}
```

`sourceDuration` is the exact duration covered by the source children before
the first operation. The owning `AudioTrack` interval is the required final
duration. Destination coordinates, destination ranges, `sourceDuration`, and
`audioSlide.by` are timeline quantities and must land exactly on the
composition sample grid. Source intervals are additionally checked against the
selected locked stream's native sample grid and duration.

`audioSlip.by` is different: it moves a source window without moving its
destination. It therefore belongs to the selected source's native clock, not
the composition clock. The compiler preserves the exact rational delta; after
resource locking, the runtime validates the resulting source endpoints against
that stream's sample rate. For example, a one-sample slip of a 44.1 kHz source
inside a 48 kHz composition is valid, while the same delta used for
`audioSlide.by` is rejected as off the 48 kHz destination grid.

## Operation semantics

| Public call | Exact effect |
| --- | --- |
| `audioSplit(at:)` | Splits the one clip strictly containing the point. A boundary point and explicit silence are refused. |
| `audioTrim(keep:)` | Keeps one strict subrange of one clip and replaces its trimmed head/tail with explicit silence. Duration does not ripple. |
| `audioRippleInsert(at:item:)` | Inserts one `editAudio` or `editSilence` item and shifts all following material later. |
| `audioRippleDelete(range:)` | Removes the exact range and shifts following material earlier. |
| `audioOverwrite(range:item:)` | Replaces an arbitrary range with one equal-duration item without changing track duration. |
| `audioReplace(range:item:)` | Replaces exactly one whole current clip; a duration delta ripples following material. |
| `audioLift(range:)` | Replaces the exact range with explicit silence without changing duration. |
| `audioExtract(range:)` | Removes the exact range and ripples following material earlier. |
| `audioSlip(range:by:)` | Shifts one whole current clip's source window without changing its destination interval. |
| `audioSlide(range:by:)` | Moves one whole current clip by resizing its immediate left/right clip or gap neighbors; total duration is preserved. |
| `audioCrossfadeAt(at:duration:curve?:)` | After every structural operation, resolves one exact final hard cut and creates a centered duration-preserving overlap from declared outgoing tail and incoming head handles. Curve is `"equal-power"` by default or `"linear"`. |

All ranges are positive and half-open. Operations run in source order against
the result of the preceding operation. A zero delta, boundary split,
semantically identical replacement, all-silence lift, or complete operation
list that recreates its source is a stable no-op diagnostic rather than an
accepted argument with no effect.

Crossfades are transition operations rather than structural mutations. CUT
first executes the complete structural list, then resolves every
`audioCrossfadeAt` against that final topology. The duration is an even integer
of at least two composition samples; each side consumes exactly half from the
adjacent clips' declared `tailHandle`/`headHandle`. Transition windows must be
pairwise disjoint, although half-open windows may touch. See
[EDITORIAL_AUDIO_TRACK.md](EDITORIAL_AUDIO_TRACK.md#track-integrated-crossfades)
for the exact envelope, native-source and refusal contract.

For processed regions, `audioCrossfadeAt` is valid only when every base item is
an adjacent `AudioRegion`, the operation list contains crossfades only, leaf
fades are zero, processor properties are static, and any manual picture links
are distinct passive identities. Each consumed half-handle extends the locked
native trim and placement before the static chain; the expanded gate precedes
the envelope and mix. A middle region at touching windows has one processor
instance over the union and two envelopes. Mixed direct clips, gaps, structural
operations, automation, linked transactions and unsupported topology fail
closed; picture timing, pixels, links and picture-cache entries are not edited.

`editAudio(source:, range:)` derives its destination duration exactly from its
source range. It performs no implicit retime, pitch change, rounding, or
stretch. `editSilence(duration:)` is an explicit positive silent operand.

## Materialization, identity, and cache behavior

Compile-time edit calls do not survive as runtime node inputs. For v1 the
compiler stores the closed operation plan as inspectable validation evidence
and emits canonical ordinary children whose IDs and timing are derived from the
final materialized items. For v2 it retains one canonical outer region plus its
source leaf and ordered processors for each base item, and stores transitions
only. Before audio work, the runtime:

1. validates locked audio resources, native source clocks, bounds and all
   destination sample boundaries;
2. re-executes the complete operation plan;
3. reconciles item count, order, IDs, source/destination metadata, child
   kernels, child inputs and final duration; and
4. refuses any mismatch with a source-located `CUT_AUDIO_EDIT_*` diagnostic.

After successful reconciliation, operation spelling, comments, provenance and
an alternative valid history that produces the same canonical items and
transitions do not invalidate render/build or pre-master audio-cache identity.
Changed materialized source, destination, resource, silence, item structure,
transition curve/window, consumed handle source, or processed region/source/
processor/static-property identity does. Unconsumed surplus handle availability
is excluded from executable/build/PCM-cache identity but remains lock-validated
and visible in CutAVIR, inspect, semantic diff and source identity. The plan
remains visible to `inspect` and source/lock evidence; it is excluded only from
executable identity after its result has been proven equivalent.

## Closed diagnostics and budgets

- `CUT_AUDIO_EDIT_SHAPE`: malformed pair, wrong call/operand/resource shape,
  leaked compile-time inputs, or non-canonical materialization;
- `CUT_AUDIO_EDIT_TIME`: invalid range/duration, grid/bound failure, or
  duration mismatch;
- `CUT_AUDIO_EDIT_NOOP`: accepted syntax would change no structural audio;
- `CUT_AUDIO_EDIT_UNSUPPORTED`: ambiguous operation or a deliberately
  unsupported processed/linked base;
- `CUT_AUDIO_EDIT_RESULT`: replay and materialized runtime graph disagree;
- `CUT_AUDIO_EDIT_LIMIT`: the bounded plan/item/rational/string/provenance
  budget is exceeded.

The processed v2 path additionally uses
`CUT_AUDIO_REGION_CROSSFADE_TOPOLOGY`,
`CUT_AUDIO_REGION_CROSSFADE_HANDLE`,
`CUT_AUDIO_REGION_CROSSFADE_AUTOMATION`, and
`CUT_AUDIO_REGION_CROSSFADE_PLAN` consistently across compiler, strict loader,
runtime authorization, cache entry and render reconciliation.

The public compiler accepts 1–256 operations per track. The closed IR/runtime
algebra caps materialization at 10,000 items and deliberately shares CutAVIR
v3's 256-digit rational, 256-frame provenance and 1 MiB per-string ceilings.
The strict loader's document-wide string budget still applies first. This
parity matters: IR accepted at the public loader boundary cannot later fail
only because plan replay used a smaller private evidence budget. Unknown fields
fail in the JSON Schema and strict loader; referenced resources must exist and
have the right locked media kind before execution.

When an operation creates a new source boundary—through split, trim, range
slicing, slip, or a slide's neighbor resize—the derived item carries the
operation's provenance. Native-clock and locked-duration diagnostics therefore
point to the causative edit call. Untouched items retain their base-clip
provenance, so pre-existing resource and range failures still point to the
original `AudioClip`.

## Evidence

`tests/audio-edit-operations.test.ts` proves the pure exact-rational algebra,
closed validation, deterministic identities and a seeded 250-case property
sweep. `tests/reference-audio-edit-operations.test.ts` proves every public call
through parser/type checker/compiler/typed IR/runtime, schema/loader and hostile
replay refusal, native 44.1 kHz to 48 kHz source/destination clocks, two
different histories with one semantic/cache identity, changed-source cache
invalidation, and decoded PCM values at exact edit and silence boundaries.
`tests/reference-audio-track-transition.test.ts` adds parser-to-render proof for
the post-structural crossfade, including real mixed-rate handle media and exact
per-sample curve semantics.
`tests/reference-audio-region-crossfade.test.ts` proves the v2 region plan,
static processor-before-envelope order, one warm state across touching windows,
expanded-gate containment, real 44.1-to-48 kHz handles, stems, passive picture
links and picture-cache locality, strict/warm-cache tamper refusal, and a
128-region/127-transition runtime graph.

These are conformance fixtures, not a creative dialogue-project gate.

## Deliberate limits

This first operation algebra is one-to-one structural editing. A base clip with
nonzero fades, overlap, retime or other processor state is refused instead of
having that state silently flattened. Ordinary `AudioTrack` authoring still
supports independently placed overlapping clips and sample-domain fades.

Ordinary operation plans containing `link:` remain refused instead of silently
uncoupling sound from picture. The separate direct-scene `LinkedTrim`
transaction is executable end to end. `LinkedRippleDelete(link:)` lowers a
complete equal-range pair, while `LinkedRippleDelete(link:, range:)` lowers one
strict shared interior range from neutral direct picture/audio clips whose
outer J/L ranges may differ. Version 2 gives corresponding before/after A/V
survivors compiler-owned segment identities while retaining authored group
`linkId`. Both forms execute correlated tail-silence insertion followed by
ripple deletion in the pure algebras and strict typed IR. The generalized
central validator issues immutable per-track authorization only after exact
cross-track correlation and replay. Locked execution proves the shifted decoded
PCM progression, an exact silent tail, cold/warm audio-cache reuse, and
one-sided refusal before output publication. OTIO preserves the materialized
track but reports the missing atomic round trip exactly as
`CUT_OTIO_LINKED_RIPPLE_DELETE_UNSUPPORTED`. Manual linked picture/audio
endpoints and the bounded two-Clip `JCut`/`LCut` wrappers remain executable
outside operation mode. Track-integrated crossfades now execute either for
neutral one-to-one unlinked bases with explicit locked source handles or for
the separate all-`AudioRegion` v2 static-chain topology, with two built-in
curves and disjoint centered windows. Structural slicing of processed regions,
dynamic/faded/retimed/overlapped processed bases, multi-item or nested linked ripple and linked
transition selection, variable/time-remapped audio, arbitrary transition
curves/plugins, multi-item/nested operands, coupled slip/slide/transition
cases, mixed direct/processed bases, lossless linked-operation/transition
interchange and a qualifying dialogue dogfood render remain
mandatory 1.0 work.
