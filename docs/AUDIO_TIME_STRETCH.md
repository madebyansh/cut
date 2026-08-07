# Bounded audio time stretch and pitch

Status: executable 0.4 alpha slice; **partial**, not a production-quality claim.

`TimeStretch` is a CUT-owned offline audio processor. FFmpeg renders its child
graph to an exact PCM interval and later reads CUT's processed PCM, but no
FFmpeg `atempo`, `asetrate`, Rubber Band, or other retime filter defines the
time/pitch semantics.

## Public source contract

```cut
import { TimeStretch, AudioClip } from "@cut/audio";

TimeStretch(
  sourceDuration: 2s,
  duration: 3s,
  pitch: 0,
  quality: "balanced"
) {
  AudioClip(source: voice, range: 4s ..< 6s);
}
```

The signature is:

```text
TimeStretch(
  sourceDuration: Time,
  duration: Time,
  pitch?: Number = 0,
  quality?: "draft" | "balanced" = "balanced"
) { exactly one audio child }
```

For a node placed at exact destination sample `P`, `sourceDuration` selects the
half-open child-graph interval `[P, P + sourceSamples)`. CUT produces exactly
`destinationSamples` and places those samples in `[P, P +
destinationSamples)`. Both durations and `P` must land on the composition
sample grid. The rest of the composition is unchanged.

`pitch` is a signed semitone offset independent of destination duration. A
positive value raises pitch; a negative value lowers it. `quality` chooses the
documented analysis window and hop. All four arguments affect graph/cache
identity. `TimeStretch` has no settable or animatable properties in this slice;
an attempted `set` or `animate` fails checking instead of being ignored.

The child can be any executable audio graph. Use `Bus` when the processor needs
to receive several sources as its one structural child. Nested `TimeStretch`
nodes are refused in this bounded slice.

### Exact AudioRegion integration

One ordinary `AudioTrack` item may own the same public processor inside its
closed `AudioRegion` chain:

```cut
import { AudioRegion, AudioTrack } from "@cut/edit";
import { AudioClip, Gain, TimeStretch } from "@cut/audio";

AudioTrack() {
  AudioRegion(destination: 0ms ..< 200ms) {
    Gain(amount: -6db) {
      TimeStretch(
        sourceDuration: 300ms,
        duration: 200ms,
        pitch: 3,
        quality: "draft"
      ) {
        AudioClip(source: voice, range: 5s ..< 5300ms);
      }
    }
  }
}
```

The compiler, strict IR loader, and runtime independently require the leaf
range duration to equal `sourceDuration`, the outer destination duration to
equal `duration`, and all descendants to retain one exact scene/placement.
This locks both speed-up and slow-down before DSP. It is not an implicit retime
and cannot be synthesized by writing unequal track intervals alone.

The `TimeStretch` may appear at one structural point in the allowed unary
region chain. Inserts inside it execute over the source span; inserts outside
it execute after retiming over the destination span. Moving an insert across
that boundary changes executed PCM and cache identity. A retimed region must be
static and cannot declare handles, crossfades, structural track edits, or
linked edit transactions; these ambiguous combinations fail before rendering.

## Normative DSP

Let `S` be the exact source sample count, `D` the exact destination sample
count, `p` the pitch shift in semitones, and `f = 2^(p/12)`. CUT computes the
intermediate length as `M = floor(D*f + 0.5)`. The positive half-up rounding
rule is part of the reference contract.

The quality tiers are:

| Tier | Window | Analysis hop |
| --- | ---: | ---: |
| `draft` | 512 samples | 128 samples |
| `balanced` | 1,024 samples | 256 samples |

For each stereo channel independently, CUT:

1. applies a sine window `sin(pi*(n+0.5)/N)` to each analysis frame;
2. computes an owned radix-2 FFT;
3. unwraps each bin's phase deviation from its expected advance;
4. accumulates synthesis phase using the exact integer distance between the
   current and previous output-frame starts;
5. performs an inverse FFT and overlap-adds with squared-window
   normalization; and
6. linearly resamples the `M` intermediate samples to exactly `D` samples.

For bin `k`, window size `N`, analysis delta `A`, synthesis delta `B`, current
phase `phi`, previous phase `phiPrev`, and `omega = 2*pi*k/N`, the non-initial
frame update is:

```text
deviation = principal(phi - phiPrev - omega*A)
synthesisPhase += (omega + deviation/A) * B
```

This arrangement first changes duration while retaining sinusoidal pitch, then
uses the deterministic resampler to apply the independent pitch factor while
returning to exact destination length. Both channels use the same frame starts,
window, hop, and output length. They retain separate spectral phase state; the
alpha does not claim stereo phase locking.

When `S == D` and `pitch == 0`, CUT takes an exact identity path. The decoded
24-bit PCM is byte-identical to the unwrapped child graph on the pinned
reference backend. No FFT is used for that identity case.

## Bounds and refusal

- destination/source duration ratio: `0.5` through `2.0`;
- pitch: `-12` through `+12` semitones;
- minimum source and destination: four windows for the chosen quality;
- maximum source samples per node: 2,000,000;
- maximum destination samples per node: 2,000,000;
- maximum intermediate samples per node: 4,000,000;
- maximum nodes per composition: 8;
- maximum aggregate destination samples: 8,000,000; and
- maximum aggregate FFT work: 400,000,000 units, where one source analysis
  frame costs `windowSize * log2(windowSize) * 4` units for two channels and
  forward/inverse transforms.

Plans exceeding these limits fail before child decoding or FFT allocation.
The stable runtime diagnostic families are:

- `CUT_AUDIO_TIME_STRETCH_TYPE`;
- `CUT_AUDIO_TIME_STRETCH_VALUE_RANGE`;
- `CUT_AUDIO_TIME_STRETCH_SAMPLE_GRID`;
- `CUT_AUDIO_TIME_STRETCH_QUALITY`;
- `CUT_AUDIO_TIME_STRETCH_GRAPH`; and
- `CUT_AUDIO_TIME_STRETCH_SOURCE`; and
- `CUT_AUDIO_TIME_STRETCH_RESOURCE`.

Diagnostics retain module, line, column, and node ID. Unknown source arguments,
wrong source types, unsupported quality strings, child cardinality, and dynamic
properties also fail in the public checker/compiler before runtime.

## Evidence and determinism

`tests/reference-audio-time-stretch.test.ts` exercises the public package API,
typed IR, strict runtime plan, decoded output length and silence boundaries,
440 Hz preservation under a 2x duration change, an approximately 880 Hz result
for `+12` semitones, independent left/right tones, byte-exact identity bypass,
same-toolchain replay hashes, draft/balanced execution differences, source
selection, localized picture-cache reuse, hostile loaded IR, nested graphs, and
node/sample/FFT budgets.

`tests/reference-audio-region-retime.test.ts` adds the track-owned contract:
public source, typed IR and strict-loader reconciliation; real 44.1-to-48 kHz
speed-up, slow-down and pitch PCM; exact destination samples; locked native
source bounds; processor-order evidence; stems; warm-cache reauthorization;
inspect/diff; structured OTIO loss; and picture-cache locality.

Semantic identity includes the public arguments, child graph, `@cut/audio`
implementation integrity, reference runtime and native dependency identity.
The evidence establishes deterministic repeated decoded PCM on the pinned
toolchain. It does **not** establish byte identity across JavaScript engines,
CPU math implementations, FFmpeg PCM conversion versions, architectures, or a
future native/GPU backend.

## Honest limitations

This phase vocoder is useful for bounded speech, tonal material, tests, and
moderate creative retiming. It does not yet provide:

- transient preservation or identity phase locking;
- formant preservation;
- stereo phase/image coupling beyond shared timing;
- a production speech/music artifact corpus and human listening signoff;
- variable/eased time maps, reverse, freeze, scrub, or multi-item retime plans;
- independent source-offset/range authoring on the wrapper;
- nested time-stretch processors;
- dynamic pitch, duration, or quality automation;
- variable-retimed handles or general track-level crossfades; canonical
  `TimelineEdit` admits the bounded constant-retimed processed subset only when
  this is the single innermost `TimeStretch` directly above `AudioClip`;
- linked edit transactions beyond that bounded canonical audio-only subset;
- real-time/streaming execution; or
- cross-platform decoded-buffer conformance.

Accordingly, CUT 1.0 contract row `AUD-05` remains **PARTIAL**. This slice is
an executable foundation with explicit refusals, not an Elastique-,
Rubber-Band-, DAW-, or NLE-quality equivalence claim.
