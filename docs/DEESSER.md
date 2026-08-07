# CUT-owned dynamic DeEsser

Status: executable pre-1.0 reference contract.

`DeEsser` is a causal stereo-linked high-band dynamics processor. CUT owns its
split, detector, automation, work limits, cache identity and diagnostics.
FFmpeg evaluates the closed recurrence and supplies PCM/codecs; CUT does not
delegate this node to FFmpeg's `deesser`, a high-shelf preset, or a sequence of
processor instances rebuilt at property events.

```cut
import { DeEsser, Noise } from "@cut/audio";
import { outCubic } from "@cut/motion";

DeEsser(intensity: 0.25, amount: 0.4) as voiceControl {
  Noise(duration: 2s, color: "white", seed: 21, amplitude: 20%);
}

at 600ms { set voiceControl.amount = 0.75; }
at 1s {
  animate voiceControl.intensity from 0.25 to 0.65 over 500ms ease outCubic;
}
```

Both controls are scalar `Number` values from `0` through `1`:

- `intensity` defaults to `0.35`. It jointly lowers the detector threshold and
  increases available high-band reduction.
- `amount` defaults to `0.5`. It scales the reduction available at the current
  intensity without changing the split or detector topology.

Both properties accept exact-sample `set`, `linear`, and `outCubic` tracks.
Other value types, values outside `0..1`, off-sample event boundaries, other
easings, missing/mistyped signals, unknown properties and excess work fail
with source-located stable diagnostics. A static constructor value and an
equivalent property write at sample zero traverse the same processor and are
PCM24-identical on the pinned backend.

## Normative recurrence

The static plan is compiled once per executable node from the composition
sample rate `fs`:

- crossover `fc = min(5500, 0.4 * fs)` Hz;
- attack `0.5ms` and release `50ms`;
- least/most-sensitive thresholds `-6dB` and `-48dB`;
- maximum reduction `18dB`.

For each stereo frame, let `c = exp(-2*pi*fc/fs)`. CUT advances one causal
low-pass state per channel:

```text
lowL = (1-c)*inL + c*previousLowL
lowR = (1-c)*inR + c*previousLowR
highL = inL - lowL
highR = inR - lowR
detector = max(abs(highL), abs(highR))
```

One stereo-linked envelope follows the detector. It selects
`exp(-1/(0.5ms*fs))` while rising and `exp(-1/(50ms*fs))` otherwise. For the
control values on that exact sample:

```text
thresholdDb = -6 + intensity * (-48 - -6)
depthDb = 18 * intensity * amount
activity = clamp((envelopeDb - thresholdDb) / -thresholdDb, 0, 1)
reductionDb = -depthDb * activity
gain = 10^(reductionDb/20)
out = low + high * gain
```

The same gain is applied to both residual channels. Only the complementary
high residual is attenuated. If either control is exactly zero, output is the
original input sample exactly, while the crossover and detector continue to
advance. A later nonzero event therefore observes warm continuous state; an
event never resets the processor.

## Closed limits and identity

- sample rate: integer `8,000..192,000` Hz;
- at most 16 reachable DeEsser nodes per composition;
- at most 268,435,456 DeEsser channel-samples per composition;
- at most 64 events per property and 128 grouped events per node;
- controls and the canonical static plan are included in semantic build and
  pre-master audio-cache identity; unrelated picture edits remain local.

Session validation and direct audio rendering preflight node/channel-sample
work before resolving media, creating a backend graph script, or allocating an
output. The in-memory scalar conformance helper has a separate 1,048,576-frame
batch bound and is not the streaming render path.

Executable evidence is in
`tests/reference-audio-deesser-core.test.ts` and
`tests/reference-audio-deesser-automation.test.ts`. It covers an independent
scalar/golden core, exact bypass with warm state, chunk continuity, channel
exchange, low/high selectivity, hostile object boundaries, public property
typing, exact event and curve PCM against the TypeScript recurrence, a reset
countermodel, static/sample-zero parity, loaded-IR diagnostics, cache locality
and pre-allocation work refusal.

## Explicit non-claims

This slice does not claim dialogue/phoneme classification, lookahead or a
linear-phase crossover, multiband dynamics, a sidechain key-EQ, true-peak or
loudness mastering, portable floating-point byte identity, or production
dialogue listening approval. Those require separate implementation and
listening/conformance evidence. Dynamic execution removes the former static
high-shelf substitute; it does not by itself complete CUT's professional
dialogue-cleanup or cross-platform audio gates.
