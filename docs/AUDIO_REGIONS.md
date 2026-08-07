# Processed AudioRegion contract (0.4 alpha)

`AudioRegion` is the executable manual-timeline primitive for one independently
processed take. It is public `@cut/edit` syntax, lowers to typed CutAVIR, is
authorized again after strict loading, executes in the reference audio runtime,
participates in semantic diff and cache identity, and can be delivered inside a
named stem. It is not hidden JSON and does not invoke a model.

```cut
cut 0.4;
project "Processed interview take";

import { AudioGap, AudioRegion, AudioTrack } from "@cut/edit";
import { AudioClip, Compressor, Gain, HighPass } from "@cut/audio";

asset interview: AudioAsset = audio("media/interview.wav");

timeline main(duration: 2s, fps: 25, sampleRate: 48khz) {
  AudioTrack() {
    AudioGap(destination: 0s ..< 500ms);
    AudioRegion(destination: 500ms ..< 1500ms) {
      Gain(amount: -6db) as cleanup {
        Compressor(threshold: -18db, ratio: 3) {
          HighPass(frequency: 80hz) {
            AudioClip(
              source: interview,
              range: 12s ..< 13s,
              fadeIn: 10ms,
              fadeOut: 20ms
            );
          }
        }
      }
      at 500ms { set cleanup.amount = -3db; }
    }
    AudioGap(destination: 1500ms ..< 2s);
  }
}

export out = render(main);
```

A closed region-only transition plan uses the same public `audioCrossfadeAt`
operation, with handle availability declared on the outer regions:

```cut
AudioTrack(
  sourceDuration: 2s,
  edits: [audioCrossfadeAt(at: 1s, duration: 200ms, curve: "equal-power")]
) {
  AudioRegion(destination: 0s ..< 1s, tailHandle: 100ms) {
    HighPass(frequency: 80hz) {
      AudioClip(source: interview, range: 5s ..< 6s);
    }
  }
  AudioRegion(destination: 1s ..< 2s, headHandle: 100ms) {
    Compressor(threshold: -18db, ratio: 3) {
      AudioClip(source: interview, range: 6100ms ..< 7100ms);
    }
  }
}
```

One ordinary manual region may instead own one exact source-to-destination
retime. This is still public source, not an IR-only escape hatch:

```cut
AudioTrack() {
  AudioRegion(destination: 0ms ..< 200ms) {
    Gain(amount: -6db) {
      TimeStretch(
        sourceDuration: 300ms,
        duration: 200ms,
        pitch: 3,
        quality: "draft"
      ) {
        AudioClip(source: interview, range: 5s ..< 5300ms);
      }
    }
  }
}
```

## Closed source shape

- `AudioRegion` is valid only as a direct `AudioTrack` item. It owns one exact
  half-open `destination`, optional manual A/V `link` identifier, and optional
  positive `headHandle`/`tailHandle` source availability. Handles belong to
  the outer region, not its leaf.
- It contains one unbranched audio path: zero or more unary inserts followed by
  exactly one ordinary `AudioClip` leaf. The current boundary-contained insert
  set is `Gain`, `Pan`, `ParametricEQ`, `HighPass`, `LowPass`, `Compressor`, and
  `DeEsser`, plus at most one `TimeStretch`. The executable nesting bound is 32
  inserts.
- The leaf owns only `source`, one exact half-open source `range`, optional
  `fadeIn`, and optional `fadeOut`. It cannot repeat destination/link placement
  or declare transition handles.
- Without `TimeStretch`, source and destination durations must be exactly equal.
  With one `TimeStretch`, its `sourceDuration` must exactly equal the leaf source
  range duration and its `duration` must exactly equal the outer destination.
  Destination endpoints and both stretch durations must land on the composition
  sample grid; after locking, source endpoints must land on the selected stream's
  native sample grid. Exact mixed-rate intervals, including 44.1 kHz source into
  48 kHz output, are resampled and retimed deterministically.
- Outside processed-transition mode, non-rendering `at` automation may target
  supported insert properties. Event
  time is region-local and is compiled onto the exact absolute composition
  sample clock. An event at the half-open region end is rejected because it
  would affect no region sample. A region participating in
  `audioCrossfadeAt` must have a fully static processor chain and zero leaf
  fades; it is refused rather than silently freezing or reinterpreting either.
  A region containing `TimeStretch` must also be fully static because CUT does
  not guess whether automation belongs to the source or destination clock.
- Every insert and leaf is child-owned by exactly one region. Sharing,
  re-parenting, root promotion, cycles, excessive depth, unknown fields,
  unsupported processors, forged source metadata, and interval/scene mismatch
  fail with source-located diagnostics rather than being ignored.

## Normative execution order

For an ordinary non-transition region the reference backend executes:

`locked native-source trim -> resample -> leaf fades -> destination placement -> innermost-to-outermost unary inserts on the absolute composition sample clock -> exact outer half-open region gate`

Nesting is semantic. For example, `Gain { Compressor { AudioClip } }` executes
the compressor before gain and is observably different from the reverse order.
Each region instantiates independent processor state. The final outer gate owns
the region interval, so a stateful high-pass, low-pass, EQ, compressor, or
de-esser cannot leak a generated tail into the next edit. The last in-region
sample remains audible and the first sample at the exclusive end is outside the
region.

This boundary contract is why processors with intentional post-source tails or
non-unary topology are excluded. `Delay`, `Reverb`, `Limiter`, `Sidechain`,
`Send`, `Return`, `Bus`, `Submix`, and routing wrappers are not
silently flattened into a region.

For a retimed region, structural nesting determines processor order and clock:

`locked native-source trim -> leaf fades and inserts inside TimeStretch on the source span -> CUT-owned TimeStretch DSP -> inserts outside TimeStretch on the destination span -> exact outer destination gate`

Moving a stateful insert across the `TimeStretch` boundary is therefore an
observable semantic change. CUT preserves that order and state instead of
flattening the chain. Both speed-up and slow-down retain the exact authored
destination placement and sample count, even when a speed-up's locked source
range extends beyond the shorter destination/composition span.

For a region participating in a processed crossfade, the order is instead:

`extended locked native-source trim -> resample -> zero leaf fades -> extended destination placement -> static unary inserts innermost-to-outermost on the composition clock -> exact expanded half-open region gate -> transition envelope(s) -> track mix`

The centered transition consumes exactly half its duration from the outgoing
tail and incoming head. For an N-sample half-open overlap, `p = k / N` for
`0 <= k < N`; linear gains are `1-p` and `p`, and equal-power gains are
`cos(pi*p/2)` and `sin(pi*p/2)`. A middle region at two touching cuts is decoded
and processed once over the union of its head, visible interval, and tail, then
receives its incoming and outgoing envelopes. Processor state therefore warms
through the consumed head and is not restarted at the touching cut. The
expanded gate contains state or generated output before either envelope is
mixed.

## Links, edits, stems, cache, and interchange

`AudioRegion(link: "take-a")` may pair manually with exactly one
`PictureClip(link: "take-a")` in the same scene. The link records identity; it
does not copy timing. A processed audio crossfade may retain two different
passive picture links on its adjacent regions; it does not create, move, or
crossfade picture, and picture-scene cache identity is unchanged by an
audio-only transition edit. This is not an atomic linked A/V transition claim.

The accepted operation topology is deliberately narrow: a non-empty list of
`audioCrossfadeAt` calls over adjacent `AudioRegion` items only. Windows must be
disjoint (touching is allowed), every consumed handle must be declared and
locked in bounds/on the native sample grid, leaf fades must be zero, and all
processors must be static. Structural operations, mixed direct `AudioClip`,
`AudioGap`, automation, linked transactions, overlapping/non-adjacent items,
and unsupported processor topology fail closed. `LinkedTrim` and
`LinkedRippleDelete` still refuse processed-region operands.

A region containing `TimeStretch` uses ordinary `AudioTrack()` authoring only.
It cannot declare head/tail handles, enter a crossfade or any structural
`AudioTrack(sourceDuration:, edits:)` plan, participate in a linked edit
transaction, or contain automation. These cases are refused at compile time
and rechecked by the strict loader and runtime rather than deferred to DSP.

A region can sit below a named top-level `Bus` and is then executed in that
stem; stem export does not bypass its inserts. Source selection, fades,
placement, processor values/order/automation, package/runtime identity, locked
resource bytes, consumed handles, transition windows/curves, and composition
sample contract affect the pre-master audio artifact key. Declared but
unconsumed handle surplus remains lock-validated availability metadata: it is
visible in CutAVIR, inspect, semantic diff, and source identity, but is excluded
from executable/build/PCM-cache identity. The current cache is still
composition-artifact-level: this slice does not claim per-region or
per-processor reuse after a small edit.

OTIO export preserves the exact nested `AudioClip` source range and destination
as an unprocessed hard clip, then emits
`CUT_OTIO_AUDIO_REGION_PROCESSING_UNSUPPORTED`. A processed crossfade also
emits `CUT_OTIO_AUDIO_CROSSFADE_UNSUPPORTED` describing the missing outer
handles, static processor-chain/state, expanded gate, and envelope semantics.
Processor order, automation and region link grouping do not round-trip, and
import does not reconstruct an `AudioRegion`.

A retimed region additionally emits
`CUT_OTIO_AUDIO_REGION_RETIME_UNSUPPORTED`, including the source/destination
durations, pitch/quality, processor ordering, and CUT-owned DSP identity that
the flattened OTIO clip cannot preserve.

## Diagnostics and evidence

Source shape failures use `CUT_AUDIO_REGION_SCOPE`,
`CUT_AUDIO_REGION_SHAPE`, or `CUT_AUDIO_REGION_UNSUPPORTED`. Compiler duration
closure uses the existing exact editorial diagnostics. Loaded/runtime ownership
and reconciliation failures use `CUT_EDIT_AUDIO_REGION`; processor value,
automation, native-grid, lock, and resource failures retain their narrower
`CUT_AUDIO_*` diagnostic codes.

Processed-crossfade refusals use four stable codes at compiler, loader,
authorization, cache and runtime entry boundaries:

- `CUT_AUDIO_REGION_CROSSFADE_TOPOLOGY` for anything other than the closed
  adjacent region-only shape;
- `CUT_AUDIO_REGION_CROSSFADE_HANDLE` for missing, insufficient, off-grid or
  out-of-bounds availability;
- `CUT_AUDIO_REGION_CROSSFADE_AUTOMATION` for dynamic processor properties;
- `CUT_AUDIO_REGION_CROSSFADE_PLAN` for malformed, stale, forged, mixed,
  structural, faded, linked-transaction or otherwise unreconciled plans.

Retimed-region refusals use `CUT_AUDIO_REGION_RETIME_TOPOLOGY` for duplicate or
nested stretch/handle topology, `CUT_AUDIO_REGION_RETIME_PLAN` for unreconciled
source, destination, track-plan, or transition identity, and
`CUT_AUDIO_REGION_RETIME_AUTOMATION` for an ambiguous dynamic chain.

`tests/reference-audio-region.test.ts` proves parser/checker/IR/runtime closure,
decoded source selection, exact dynamic sample boundaries, 44.1-to-48 kHz
resampling, nesting order, independent state, outer-gate tail containment,
manual link/refusal policy, cache identity, valid stem delivery, hostile loaded
graphs before allocation, warm-cache tamper refusal, and nested-composition
authorization. `tests/reference-audio-region-crossfade.test.ts` adds v2 typed
plan/strict-loader proof, real mixed-rate handle PCM, static processor-before-
envelope order, touching middle-state continuity and expanded-gate containment,
distinct passive picture links/picture-cache locality, stems, warm-cache
reauthorization, hostile IR and a 128-region/127-transition graph. Semantic
diff, OTIO, strict-loader tests and the surrounding audio regression matrix
provide the adjacent proof.

`tests/reference-audio-region-retime.test.ts` proves ordinary source through
checker/compiler, strict loading and runtime authorization; real mixed-rate
speed-up, slow-down and pitch PCM with exact destination counts; processor
order across the retime boundary; locked native bounds; stems; warm-cache
reauthorization; inspect/diff; explicit OTIO loss; and picture-cache locality.

These are engineering conformance fixtures, not a dialogue-film quality claim.
They do not advance `AUD-07`: CUT still lacks a qualifying human-reviewed
interview project proving cleanup, J/L editing, ambience continuity, ducking,
captions, stems, and a final mix together.
