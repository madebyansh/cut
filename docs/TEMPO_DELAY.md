# Tempo maps and tempo-synchronized delay

Status: executable bounded alpha slice. This is a destination-clock audio
effect, not tempo analysis or a general musical-time engine.

## Public source

```cut
import { TempoDelay, Tone, tempoMap, tempoPoint } from "@cut/audio";

const scoreTempo: TempoMap = tempoMap(points: [
  tempoPoint(at: 0s, bpm: 120),
  tempoPoint(at: 8s, bpm: 132),
]);

TempoDelay(
  tempo: scoreTempo,
  delay: 0.5beat,
  feedback: 35%,
  mix: 25%,
) {
  Tone(frequency: 880hz, duration: 40ms);
}
```

`tempoPoint(at:, bpm:)` and `tempoMap(points:)` are pure compile-time value
constructors. They lower to closed ordinary typed-IR objects; no file, model,
analyzer, plug-in host or hidden project graph is consulted. A `Beat` is an
exact quantity authored with the `beat` unit. `TempoDelay` accepts exactly one
audio child and has a fixed topology in this slice; its controls are static.

`feedback` defaults to `35%` and `mix` defaults to `25%`. Explicit `mix: 0%`
is refused because it would make the accepted tempo and feedback controls
inert. Feedback may be zero for one musically placed echo, but must remain at
or below `95%` so the recursive state is bounded.

## Clock contract

The tempo map is piecewise constant on the composition's destination sample
clock:

- the first point is exactly `at: 0s`;
- points are strictly time-ordered, inside the half-open composition range,
  and land on its authored sample grid;
- BPM is an exact `Number` from 20 through 400; and
- a point owns its exact boundary sample. The previous BPM integrates over
  `[previous.at, point.at)` and the new BPM begins at `point.at`.

CUT integrates an exact continuous beat position over those segments. For
destination sample `n`, it subtracts the authored beat delay, inverts the
result through the same tempo map and reads the already-computed historical
feedback state. A target between source samples uses deterministic linear
interpolation. The delay must remain at least one complete sample behind the
current output under every authored BPM.

Changing tempo does not restart the delay line. Samples before the tempo-point
boundary are unchanged; later repeats move because the destination beat clock
now advances at the new BPM. The compiler/runtime exposes the exact tempo
segments, delay lookup spans, first echo sample and identities through
`cut inspect --json`.

## DSP and mix

The processor is CUT-owned stereo IEEE-754 float32. It renders the child graph
to one exact private `f32le` boundary, applies a causal recursive line, and
returns one exact float32 stream to the codec graph. FFmpeg does not implement
the tempo clock or feedback law.

For each channel, the version-1 recurrence is conceptually:

```text
delayed[n] = linear_read(state, beat_time(n) - delay)
state[n]   = f32(input[n] + f32(feedback * delayed[n]))
output[n]  = f32(f32((1 - mix) * input[n]) + f32(mix * delayed[n]))
```

Before the first covered historical beat, `delayed[n]` is zero. Constant-tempo
`feedback: 0%` therefore has the same dry/wet one-tap equation as ordinary
`Delay(time:, repeats: 1, wet:)` whenever the beat duration lands on the exact
sample grid. Ordinary `Delay` is a finite normalized feed-forward tap plan;
`TempoDelay` is a recursive beat-clock line, so nonzero feedback is not claimed
to match `Delay.repeats/decay`.

## Limits and diagnostics

The current executable bounds are 1-256 tempo points, 20-400 BPM, a positive
delay through 16 beats, feedback through 95%, 16 distinct nodes and 57,600,000
aggregate processed frames per composition. One node is limited to 28,800,000
stereo frames. Unknown fields, empty/multiple children, off-grid points,
unordered or endpoint-only maps, inaudible delays, inert mix, non-finite PCM,
uncomputed reads and over-budget graphs fail with stable source-located
`CUT_AUDIO_TEMPO_*` diagnostics.

Tempo points, beat delay, feedback, mix, child graph, package implementation
and algorithm identity participate in semantic diff and pre-master audio-cache
identity. A tempo-only edit invalidates its owning audio graph and ancestors;
unrelated picture identity remains outside the audio key.

## Explicit non-claims

This slice does not detect tempo, beats or onsets from media. It does not model
groove, shuffle, swing, tempo curves, pitch-synchronized echoes, fractional-
delay modulation or Doppler effects. It does not claim portable floating-point
byte identity across JavaScript engines. Human listening remains required for
musical feedback, masking and mix decisions.
