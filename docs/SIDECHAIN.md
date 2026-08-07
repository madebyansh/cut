# CUT-owned Sidechain

Status: executable 0.4 alpha slice. This contract does not make AUD-03 or
AUD-04 complete.

`Sidechain` receives program audio from its children and a separate referenced
stereo `source` key. The key drives gain reduction and is not mixed into the
program output. `amount` is required and means the reduction produced by a
0 dBFS key. `threshold` defaults to -22 dB, `attack` to 80 ms, and `release`
to 350 ms.

```cut
cut 0.4;
project "dynamic ducking";
import { Noise, Sidechain, Tone } from "@cut/audio";
import { linear, outCubic } from "@cut/motion";

timeline main(duration: 2s, fps: 24, width: 64px, height: 64px, sampleRate: 48khz) {
  let key = Tone(frequency: 3khz, duration: 2s, amplitude: 80%);
  Sidechain(source: key, amount: -10db, threshold: -30db) as bed {
    Noise(duration: 2s, color: "pink", amplitude: 20%);
  }
  animate bed.attack from 80ms to 10ms over 500ms ease linear;
  animate bed.release from 350ms to 120ms over 500ms ease outCubic;
}
export out = render(main);
```

The closed control domains are amount -40 through 0 dB, threshold -60 through
0 dB, attack 0.01 through 2,000 ms, and release 0.01 through 9,000 ms. CUT also
requires `-amount <= -threshold * 19 / 20`. This is the old static processor's
bounded 20:1 calibration expressed without a backend compressor ratio. The
same rule is checked conservatively across every authored amount and threshold
automation value, so independently changing the controls cannot enter an
unbounded combination between events.

For each destination sample, the linked peak detector is the maximum absolute
value of key left and right. CUT chooses attack while that detector is above
the previous envelope and release otherwise. With time `t`, sample rate `fs`,
and previous envelope `e`, the coefficient is `exp(-1 / (t * fs))` and the new
envelope is `coefficient * e + (1 - coefficient) * detector`. If the envelope
is above the fixed numerical floor, its dB level is `20 / ln(10) * ln(e)`.
Above threshold, reduction is `amount * (envelopeDb - threshold) /
(-threshold)`; below threshold it is zero. Both program channels are multiplied
by `10^(reduction / 20)`. Threshold zero admits only amount zero and therefore
produces no reduction.

`Sidechain.amount` and `Sidechain.threshold` are public typed `Gain` properties;
`Sidechain.attack` and `Sidechain.release` are public typed `Time` properties.
`set`, `linear`, and `outCubic` changes execute at the exact destination sample.
For attack/release, the value at that sample computes that sample's one-pole
coefficient. One detector/envelope runs for the complete node and survives
every property event; the runtime does not split the processor or restart state
at event boundaries.

The reference runtime owns this recurrence and lowers one four-channel
program/key stream to a stateful sample evaluator. FFmpeg supplies graph
execution and PCM/codecs, not the ducking law. Semantic and pre-master
audio-cache identity include all four signal tracks.

When named stems are requested, a Sidechain key may be the authored binding of
another top-level program `Bus`. The controlled route's lock-bound v5 stem-manifest entry
then includes one closed `sidechainInputs` record with the Sidechain node ID,
key node ID, source-stem name, and both transitive graph hashes. The controlled
route graph and composition audio-cache identity therefore change when the key
graph changes. Detached/unowned, ambiguously owned, aux-participating
cross-stem, and cyclic cross-stem controls fail source-located with stable
`CUT_STEM_CONTROL_*` diagnostics. An intra-route key is normal processing and
does not become a cross-stem restriction merely because that one route is an
aux delivery. See [Deterministic audio stems](AUDIO_STEMS.md).

Executable evidence is in
`tests/reference-sidechain-automation.test.ts`: public typing, exact event
samples for amount/attack/release, static/property parity, decoded PCM versus
an independent scalar model for all four controls, continuous-state versus
reset discrimination, both curves, hostile loaded IR,
range/grid/easing/calibration/node/event/grouped-work refusal, and localized
picture plus pre-master audio cache invalidation. Existing key-presence proof
remains in
`tests/reference-audio.test.ts`.

This slice does not claim lookahead, RMS detection, soft knee, hold, key EQ,
multiband processing, native-backend parity,
portable floating-point byte identity, or production listening approval.
