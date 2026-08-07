# Audio Track contract (0.4 alpha)

This document describes one executable editorial vertical slice. It does not
claim the complete CUT 1.0 timeline contract.

`AudioTrack`, `AudioRegion`, and `AudioGap` are public `@cut/edit` components. The existing
`@cut/audio` `AudioClip` gains track-only `destination`, `link`, `headHandle`,
and `tailHandle` arguments.
They pass through the normal CUT parser and dimensional type checker, lower to
typed CutAVIR, survive closed IR loading, and execute in the sample-domain
reference runtime. CUT source is the only edit description; there is no hidden
timeline or model step.

```cut
import { AudioTrack, AudioGap } from "@cut/edit";
import { AudioClip } from "@cut/audio";

AudioTrack() {
  AudioClip(
    source: interview,
    range: 12s ..< 14s,
    destination: 0s ..< 2s,
    link: "answer-a"
  );
  AudioGap(destination: 2s ..< 2500ms);
  AudioClip(
    source: roomTone,
    range: 4s ..< 5500ms,
    destination: 2500ms ..< 4s
  );
}
```

## Executable semantics

- An `AudioTrack` spans its owning interval. Its direct `AudioClip`,
  `AudioRegion`, and `AudioGap` items use explicit, half-open destination
  ranges relative to the track origin. A processed `AudioRegion` owns the
  destination while its one nested `AudioClip` owns source selection and
  fades.
- Item starts must be in nondecreasing temporal order. `AudioClip` intervals
  may overlap and are mixed by the runtime. Their interval union, together
  with explicit gaps, must cover the track exactly.
- Silence is never inferred. `AudioGap` must describe the exact uncovered
  interval and cannot overlap a clip or another gap.
- A track `AudioClip` requires a half-open source `range` and a half-open
  `destination`. Their durations must be exactly equal. This slice performs no
  implicit stretch, pitch change, hold, or resampling-based duration rounding.
  Any overlap is the exact authored intersection of destination ranges. The
  sole unequal-duration path is an explicit `TimeStretch` owned by a processed
  `AudioRegion`, with all three intervals reconciled before runtime.
- Destination endpoints, including scene placement, must land exactly on the
  composition sample grid. After locking, source endpoints must land exactly
  on the selected audio stream's reported source sample grid.
- The IR records source interval, destination interval, temporal order, and an
  optional link ID for every clip or region. A processed item additionally
  records the exact descendant `AudioClip` as `sourceNodeId`; `AudioGap`
  records only its destination. The runtime validates the complete track and
  region graph against source before rendering or cache/stem materialization.
- Multiple audio roots retain the normal CUT mix semantics. An audio processor
  may wrap an `AudioTrack`. Processors are not direct track items; use one
  `AudioRegion` when a manual take needs its own boundary-contained unary
  processing chain.

Formatting and comments do not alter semantic graph identity. Source bytes are
still recorded separately in `sourceHash` and the lock.

## Processed manual regions

`AudioRegion(destination:, link?, headHandle?, tailHandle?)` closes one independently processed manual
take: up to 32 unary `Gain`/`Pan`/`ParametricEQ`/`HighPass`/`LowPass`/
`Compressor`/`DeEsser` inserts and at most one `TimeStretch`, followed by
exactly one `AudioClip` leaf. The leaf may author only `source`, `range`,
`fadeIn`, and `fadeOut`. Without `TimeStretch`, source and destination durations
remain exactly equal. With it, `sourceDuration` must equal the exact leaf range
and `duration` must equal the exact outer destination.

Execution is source trim, resample, leaf fades, destination placement,
innermost-to-outermost inserts on the absolute sample clock, then an exact
outer half-open gate. Region-local automation is translated onto that clock,
processor state is independent between regions, and generated stateful tails
cannot cross the region end.

For a retimed region, inserts structurally inside `TimeStretch` execute on its
source span and inserts outside it execute on the destination span before the
same exact outer gate. The whole chain must be static. Handles, crossfades,
structural track plans, and linked edit transactions are refused rather than
assigned an implicit source/destination-clock interpretation.

A pure region-only `AudioTrack(... edits: [audioCrossfadeAt(...)])` plan accepts
static chains with zero leaf fades. It extends the locked native source and
destination by the consumed outer handles, executes each static chain once
innermost-to-outermost on the composition clock, applies an expanded exact
gate, then applies the CUT crossfade envelope and mixes. A middle region at two
touching cuts is processed once over the union and receives two envelopes, so
its state warms through the head and is not reset at the second cut. Structural
edits, mixed clips/gaps, automation and linked transactions remain refused.
Processed regions can carry distinct passive manual A/V links and render inside
named stems; the audio transition neither edits picture nor claims an atomic
linked A/V transition. See [AUDIO_REGIONS.md](AUDIO_REGIONS.md) for the
normative shape, diagnostics, cache identity, OTIO loss and decoded evidence.

## Structural operation mode

`AudioTrack(sourceDuration:, edits:)` is an optional, executable structural
edit mode. Both arguments are required together. The direct children describe
the exact contiguous source track; the ordered typed edit list materializes
the exact final track. Public `audioSplit`, `audioTrim`, ripple insert/delete,
overwrite, replace, lift, extract, slip and slide calls lower to a closed typed
plan and then to ordinary `AudioClip`/`AudioGap` children. A bounded
`audioCrossfadeAt` operation resolves only after those structural operations.
Runtime replay reconciles the plan before sound work, including native source
grids/bounds, destination grids, final duration, child identity, kernel inputs,
and transition metadata.

See [EDITORIAL_AUDIO_OPERATIONS.md](EDITORIAL_AUDIO_OPERATIONS.md) for the
complete call vocabulary, exact half-open semantics, stable diagnostics,
budgets, decoded-PCM evidence and deliberate first-slice refusals. Ordinary
manual track authoring described above is unchanged.

## Track-integrated crossfades

```cut
import { AudioTrack, audioCrossfadeAt } from "@cut/edit";
import { AudioClip } from "@cut/audio";

AudioTrack(
  sourceDuration: 2s,
  edits: [
    audioCrossfadeAt(at: 1s, duration: 500ms, curve: "equal-power")
  ]
) {
  AudioClip(source: outgoing, range: 0s ..< 1s,
            destination: 0s ..< 1s, tailHandle: 250ms);
  AudioClip(source: incoming, range: 250ms ..< 1250ms,
            destination: 1s ..< 2s, headHandle: 250ms);
}
```

`audioCrossfadeAt(at:, duration:, curve:)` owns one exact hard cut in the
post-structural track. `duration` must be an even integer of at least two
destination samples. The overlap is centered on the cut without changing the
track duration: the outgoing clip consumes `duration / 2` of declared tail
availability and the incoming clip consumes `duration / 2` of declared head
availability. Each consumed endpoint must land on that asset's locked native
sample grid and remain inside the selected stream.

The supported curves are `"equal-power"` (the default) and `"linear"`. For an
N-sample half-open overlap, output sample `k` uses `p = k / N`, `0 <= k < N`.
Linear gains are `1-p` and `p`; equal-power gains are `cos(pi*p/2)` and
`sin(pi*p/2)`. CUT applies these envelopes to genuinely decoded handle audio;
they are not metadata around a hard cut or delegated transition semantics.

The operation rejects cuts at an edge, inside an item, beside silence, or
between overlapping/non-adjacent items. It also rejects odd/sub-two-sample
durations, insufficient/off-grid/out-of-media handles, duplicate or
intersecting transition windows, linked direct clips, nonzero manual fades,
retimed direct bases, and materialized metadata that disagrees with replay.
The separate processed mode accepts only an all-`AudioRegion`, crossfade-only
plan with static supported chains, zero leaf fades, and passive distinct links;
automation, structural calls, mixed clips/gaps, and linked transactions fail
with `CUT_AUDIO_REGION_CROSSFADE_*`. Half-open windows may touch, and a middle
item may contribute its distinct head and tail handles to adjacent transitions.
Unknown arguments or curve names fail at source; hostile loaded fields fail
before cache lookup or audio work.

Transition curve, cut, duration, extended source intervals and consumed handle
amounts participate in semantic/build/audio-cache identity. For processed
regions, outer/source/processor identity, chain order/static properties and the
expanded gate are also bound. Unconsumed surplus handle availability remains
strictly lock-validated and visible in IR/inspect/semantic diff/source identity,
but does not perturb executable/build/PCM-cache identity. A different valid
neutral structural history producing the same executable track also does not.
OTIO export reports both transition and processed-region semantics as
structured loss instead of silently flattening them.

## Linked versus independent trimming

`PictureClip.link` and track `AudioClip.link` record one explicit relationship.
Every authored link ID must identify exactly one `PictureClip` and one
`AudioClip` in the same scene. A link never copies timing or performs a hidden
coupled edit.

Picture and audio endpoints therefore remain independently trimmable. For
example, carrying an outgoing clip's audio beyond its picture cut produces an
L-cut; starting an incoming clip's audio before its picture cut produces a
J-cut. The author writes both ranges directly:

```cut
PictureClip(source: outgoingPicture, range: 0s ..< 1s, duration: 1s, link: "out");
PictureClip(source: incomingPicture, range: 0s ..< 1s, duration: 1s, link: "in");

AudioTrack() {
  AudioClip(source: outgoingAudio, range: 0s ..< 1250ms,
            destination: 0s ..< 1250ms, link: "out");
  AudioClip(source: incomingAudio, range: 0s ..< 1250ms,
            destination: 750ms ..< 2s, link: "in");
}
```

That example carries outgoing audio beyond the picture boundary and starts
incoming audio before it. The explicit overlap is mixed; the links still copy
or couple no timing.

The separate public `JCut` and `LCut` components now execute one atomic bounded
two-`Clip` overlap: JCut cuts audio at overlap start and picture at overlap end;
LCut cuts picture at overlap start and audio at overlap end. Each interval
selects exactly one audio child, without an injected fade or doubled mix. That wrapper is
documented in [EDITORIAL_TRANSITIONS.md](EDITORIAL_TRANSITIONS.md). This
`PictureClip`/`AudioTrack` path remains independently authored and ordinary
track operation algebras still do not implicitly couple edits. `LinkedTrim` and
the complete equal-range v1 plus direct-neutral strict-interior/J/L-aware v2
`LinkedRippleDelete` contracts are the bounded executable exceptions. The v2
form uses an explicit shared `range:` inside unequal outer picture/audio ranges,
generalized central immutable authorization and deterministic shared survivor
identity. Both forms preserve track duration with explicit tail silence and
have locked decoded PCM plus cold/warm audio-cache proof. A one-sided or
cross-owned transaction fails before output publication. Ripple over
multi-item/nested operands, processed/faded/handled/retimed/overlap bases,
coupled slip/slide/transition cases and lossless interchange are not implemented.

## Closed authoring surface

```text
AudioTrack() { AudioClip | AudioRegion | AudioGap children }
AudioTrack(sourceDuration: Time, edits: List<AudioEdit>) {
  AudioClip | AudioGap children
}
AudioRegion(destination: Range<Time>, link?: String,
            headHandle?: Time, tailHandle?: Time) {
  Gain | Pan | ParametricEQ | HighPass | LowPass | Compressor | DeEsser |
  at most one TimeStretch ... AudioClip
}
AudioClip(
  source: AudioAsset,
  range: Range<Time>,
  fadeIn?: Time,
  fadeOut?: Time,
  destination: Range<Time>,
  link?: String,
  headHandle?: Time,
  tailHandle?: Time
)
AudioGap(destination: Range<Time>)
PictureClip(..., link?: String)
```

`destination`, `link`, `headHandle`, and `tailHandle` are valid on `AudioClip`
only when it is a direct `AudioTrack` item. Handles declare available source;
they do not alter audible output until a transition consumes them. Ordinary
`AudioClip` behavior outside a track is unchanged.
Unknown arguments and invalid child kinds fail at their source span. Control
flow directly inside a track is rejected instead of being silently reordered.

Compiler diagnostics use the existing editorial series plus:

- `CUT2079`: track `AudioClip` omitted an explicit source or destination range,
  or its authored fades are invalid for the destination interval;
- `CUT2081`: malformed, unmatched, cross-scene, or non-unique link grouping.

Those codes intentionally do not overlap `CUT2077`/`CUT2078`, which belong to
the closed `Text` contract, or `CUT2080`, which belongs to the closed `Video`
contract.

Loaded or tampered graphs fail with closed `CUT_IR_*` codes or source-located
runtime codes `CUT_EDIT_AUDIO_TRACK`, `CUT_EDIT_AUDIO_CLIP`,
`CUT_EDIT_AUDIO_GAP`, and `CUT_EDIT_LINK`. Structural operation plans add the
stable `CUT_AUDIO_EDIT_SHAPE`, `CUT_AUDIO_EDIT_TIME`,
`CUT_AUDIO_EDIT_NOOP`, `CUT_AUDIO_EDIT_UNSUPPORTED`,
`CUT_AUDIO_EDIT_RESULT`, and `CUT_AUDIO_EDIT_LIMIT` family.

## Evidence

`tests/reference-audio-track.test.ts` is the executable proof. It checks typed
IR, closed diagnostics, semantic identity, loader refusal, exact locked source
sample boundaries, runtime metadata reconciliation, explicit PCM silence and
sample-domain fades. It also validates independently authored picture and audio
destination intervals, then renders generated color takes and constant-amplitude
audio takes and samples the exact frame/sample boundaries of one L-cut and one
J-cut. That proves the lower-level independently authored primitive path without
claiming a coupled track-operation command or a finished dialogue sequence.
`tests/reference-linked-split.test.ts` separately proves the bounded atomic
two-Clip JCut/LCut wrapper. Both use unrelated synthetic fixtures;
it is a conformance test, not a creative flagship.

`tests/audio-edit-operations.test.ts` and
`tests/reference-audio-edit-operations.test.ts` separately prove the pure
structural algebra and its public parser-to-decoded-PCM vertical slice. They
cover all ten operations, hostile plan/materialization tampering, exact
44.1-to-48 kHz source/destination clocks, and localized semantic/audio-cache
identity. See [EDITORIAL_AUDIO_OPERATIONS.md](EDITORIAL_AUDIO_OPERATIONS.md).

`tests/reference-audio-track-transition.test.ts` proves the crossfade vertical
slice through public syntax, type checking, typed IR/schema/loader, locked
native source grids, runtime replay, exact curve math, actual 44.1/48 kHz
sentinel handle samples, hostile metadata refusal, touching windows,
semantic/diff/cache locality and structured OTIO loss.

`tests/reference-audio-region-crossfade.test.ts` proves the processed v2 path:
typed participant/processor/source/handle identity, exact linear/equal-power
windows, static processor-before-envelope order, a real 44.1-to-48 kHz render,
single warm middle state at touching cuts, expanded-gate containment, passive
picture-link and picture-cache independence, stem parity, cold/warm hostile
reauthorization and bounded many-region graph construction.

`tests/reference-audio-region.test.ts` separately proves the processed manual
item from public source through closed IR, authorization, decoded PCM, dynamic
sample boundaries, 44.1-to-48 kHz conversion, ordered processing, independent
state, outer-gate containment, cache/stem identity and hostile warm-cache
refusal. Those conformance fixtures do not advance the missing dialogue
dogfood gate.

`tests/reference-audio-region-retime.test.ts` proves explicit unequal source
and destination durations through public source, typed IR, strict loading and
runtime authorization; real mixed-rate speed-up/slow-down/pitch PCM; exact
destination samples; processor order; cache/stem boundaries; OTIO loss; and
picture-cache locality.

## Deliberate limitations

The structural slice implements split, trim, ripple insert/delete, overwrite,
replace, lift/extract, slip and slide for neutral one-to-one audio items. It
does not yet slice or preserve `AudioRegion` processed bases through structural
operations, fades/retime/automation, accept linked operation plans, provide a
general transition plugin/model, edit nested
sequences, execute variable audio time maps, or apply automatic coupled
picture/audio edits. The executable track-transition slice is crossfade-only,
with two closed curves and disjoint centered windows; it does not yet cover
arbitrary curves, asymmetric transitions, transition-bearing linked A/V,
mixed direct/processed bases, dynamic processed chains, or lossless interchange. Explicit overlapping `AudioClip`
ranges outside operation mode are mixed and tested, but do not imply a
transition or hidden gain curve. The separate linked-AV
[`Transition`](EDITORIAL_TRANSITIONS.md) owns a complementary source-audio
crossfade for two legacy `Clip` children; it is not an `AudioTrack` item and
does not close these remaining requirements.
