# Deterministic event-list synthesis

`Synth` is one general `@cut/audio` source node for agent- and human-authored
underscore, score, tone-bed, and sound-design work. It consumes typed note
events; it does not interpret prose, recognize a project, generate a pattern,
or hide model-authored JSON.

```cut
import { Synth, note, Bus, Gain, Limiter } from "@cut/audio";

timeline main(duration: 2s, fps: 24, sampleRate: 48khz) {
  scene score(duration: 2s) {
    Bus(name: "music") {
      Limiter(ceiling: -1dbtp) {
        Gain(amount: -9db) {
          Synth(
            events: [
              note(0ms, 350ms, 48, 80%),
              note(0ms, 350ms, 55, 65%),
              { start: 500ms, duration: 350ms, hz: 440hz, velocity: 55% },
              note(1s, 600ms, 60.5, 70%)
            ],
            waveform: "triangle",
            attack: 5ms,
            decay: 50ms,
            sustain: 70%,
            release: 100ms,
            polyphony: 4
          );
        }
      }
    }
  }
}
```

The example's times are exact at 48 kHz. Every event uses this closed shape:

```text
{
  start: Time,
  duration: Time,
  pitch: Number | hz: Frequency,
  velocity: Ratio
}
```

Exactly one of `pitch` and `hz` is required. `pitch` is a MIDI note number from
0 through 127; fractional values provide microtonal pitch. `hz` must be greater
than zero and below the timeline's Nyquist frequency. Velocity must be greater
than `0%` and at most `100%`. Extra event fields fail in both the checker and
loaded-IR preflight.

`note(start: Time, duration: Time, pitch: Number, velocity: Ratio)` is the
compact MIDI-pitch spelling of that same record. Its package manifest declares
pure compile-time record lowering, so:

```cut
note(0ms, 350ms, 48, 80%)
```

lowers exactly to:

```cut
{ start: 0ms, duration: 350ms, pitch: 48, velocity: 80% }
```

There is no `note` node, effect job, retained call, native operation, or runtime
branch. Positional, named, and aliased calls normalize to fields in the declared
parameter order. The constructor intentionally accepts scalar MIDI pitch only;
frequency-authored events retain the explicit `{ hz: 440hz, ... }` union variant.
Both spellings receive the same Synth timing, range, polyphony, and resource
validation after lowering.

## Timing and envelope semantics

- Event `start` is relative to the `Synth` node's placement. Event `duration`
  is gate duration, not total audible duration.
- The node-level ADSR envelope is shared by every event. Release begins at the
  gate end, so an event occupies `duration + release` for bounds and polyphony.
- Attack, decay, release, node placement, and every event boundary must land
  exactly on the timeline sample grid. CUT refuses implicit rounding.
- Attack plus decay may not exceed an event's gate duration. A release tail
  must remain inside the node's owning scene or timeline interval.
- Omitted envelope inputs are the neutral exact envelope `0ms / 0ms / 100% /
  0ms`; omitted `waveform` is `"sine"`; omitted `polyphony` is 8.
- Voices begin at phase zero. Source order is the deterministic tie-breaker for
  events that start on the same sample.

Polyphony is a declared hard bound, not a hint. Release tails count as active
voices. If the score exceeds the bound, CUT fails before encoding instead of
stealing, truncating, or reprioritizing notes.

## Waveforms and signal path

The deterministic oscillator choices are `"sine"`, `"triangle"`, `"saw"`, and
`"square"`. Saw and square use a deterministic PolyBLEP discontinuity
correction; this reduces obvious aliasing but is not a claim of a fully
band-limited production synthesizer at every pitch. Triangle is the direct
mathematical waveform. Voice values are summed without hidden normalization or
limiting into stereo 32-bit float PCM, preserving peaks above full scale for an
authored downstream `Gain`, `Compressor`, or `Limiter`. The ordinary CUT audio
graph then owns routing, sidechain use, mastering, and 24-bit/stem delivery.

The reference backend renders the bounded score to a temporary float WAVE and
feeds it through the same public graph as clips, tone, and noise. FFmpeg remains
the codec/filter interchange backend; it does not define note, phase, envelope,
polyphony, score-bound, or sample-placement semantics.

## Executable resource limits

The reference backend currently enforces:

- 512 events and 50,000,000 voice samples per `Synth` node;
- polyphony from 1 through 32;
- 64 `Synth` nodes per rendered graph;
- 64,000,000 rendered span samples per node;
- 100,000,000 voice samples and 100,000,000 temporary rendered samples across
  the selected audio graph.

These limits bound CPU and temporary storage. A score whose first and last note
are separated by a very large silent span can hit the rendered-span limit even
when it contains few notes. The diagnostic says which bound failed.

## Determinism and current limits

Repeated rendering with the same locked IR, CUT runtime, Node implementation,
sample rate, and backend produces the same synthesized PCM in the conformance
fixtures. CUT's repository-level promise remains semantic determinism; this is
not a new claim of cross-CPU or cross-JavaScript-engine floating-point bit
identity.

This primitive does not yet provide per-note envelopes, per-note pan, filters,
oscillator detune/unison, pitch-bend automation, sample instruments, MIDI-file
import, plugin hosting, tempo/beat units, or production time stretch. Compose
the implemented graph processors around multiple `Synth` nodes when separate
timbres or envelopes are required. Unsupported features are not simulated.
