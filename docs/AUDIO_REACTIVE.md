# Audio-reactive visual signals

Status: implemented public vertical slice in the `0.4.0-alpha.2` toolchain.
Public CUT source, checker/compiler, typed CutAVIR v3, strict loader, verified
selected-stream preparation, the ordinary visual transform resolver, inspect,
semantic diff, graph/cache identity, and focused conformance studies all execute.
This is a bounded amplitude-control primitive, not a claim of finished music
direction or a CUT 1.0 creative pass.

## Public source

`AmplitudeEnvelope` and its four typed mappers are exported by `@cut/data`:

```cut
cut 0.4;

project "Causal pulse";

import { Group, Rect } from "cut:visual";
import { AudioClip, Bus } from "@cut/audio";
import { AmplitudeEnvelope, mapNumber, mapRatio } from "@cut/data";

asset score: AudioAsset = audio("score.wav");

timeline main(duration: 8s, fps: 24, sampleRate: 48khz) {
  scene pulse(duration: 8s) {
    let energy: Signal<Ratio> = AmplitudeEnvelope(
      source: score,
      range: 0s ..< 8s,
      at: 0s,
      detector: "rms",
      window: 20ms,
      hop: 10ms,
      attack: 30ms,
      release: 140ms,
      floor: 2%,
      ceiling: 65%
    );

    Group() as card {
      Rect(width: 420px, height: 120px, fill: #55d6be);
    }
    set card.scale = mapNumber(energy, from: 1, to: 1.12);
    set card.opacity = mapRatio(energy, from: 35%, to: 100%);

    Bus(name: "score", role: "music") {
      AudioClip(source: score, range: 0s ..< 8s);
    }
  }
}

export out = render(main);
```

The analyzed `AudioAsset` is not implicitly audible. The example includes a
separate `AudioClip` because analysis and mixing are independent public
semantics.

The complete mapper surface is:

```text
mapNumber(Signal<Ratio>, from: Number, to: Number) -> Signal<Number>
mapRatio (Signal<Ratio>, from: Ratio,  to: Ratio)  -> Signal<Ratio>
mapLength(Signal<Ratio>, from: Length, to: Length) -> Signal<Length>
mapAngle (Signal<Ratio>, from: Angle,  to: Angle)  -> Signal<Angle>
```

`from` and `to` are exact typed endpoints and must differ. Mapping is linear;
reversing the endpoints is valid.

## Current authoring boundary

The initial public form is deliberately narrow and fail-closed:

- `AmplitudeEnvelope(...)` must be the direct initializer of a scene-local
  `let` binding. It cannot be hidden in a component, function, constructor
  argument, or free expression.
- A mapper must be the direct value of `set` in that same scene.
- The target must be a bound, direct scene-root `Group` property: `x`, `y`,
  `scale`, `rotation`, or `opacity`.
- The mapper type must exactly match the property type: `Length` for `x`/`y`,
  `Number` for `scale`, `Angle` for `rotation`, and `Ratio` for `opacity`.
- The Group's authored baseline must equal `from`, or the baseline must be
  omitted. A producer cannot share a property with authored `set`/`animate`
  events or another producer.
- One envelope binding may fan out through several mappers. Each attachment
  becomes an ordinary typed property signal; identical analysis plans are
  prepared only once per renderer invocation.

The Group boundary is not a visualizer preset: a Group may contain any
otherwise supported visual subtree. It is nevertheless a real current limit.
Direct attachment to `Rect`, text, an effect parameter, a nested Group, audio
control, or a cross-scene target is unsupported and diagnosed.

Mapped endpoint bounds are also executable:

| Property | Endpoint bound |
| --- | ---: |
| `x`, `y` | `-65536px` through `65536px` |
| `rotation` | `-360000deg` through `360000deg` |
| `opacity` | `0%` through `100%` |
| `scale` | `0.001` through `min(8, 16384/width, 16384/height, sqrt(67108864/(width*height)))` |

## Typed IR contract

`AmplitudeEnvelope` has source type `Signal<Ratio>`, but the compile-only let
value is not an untyped runtime expression. Each mapped attachment lowers to an
ordinary `track` signal with:

- exact `valueType` (`Number`, `Ratio`, `Length`, or `Angle`);
- `initial` exactly equal to `mapping.from`;
- no authored events;
- one closed `cut-audio-amplitude-producer` v1 descriptor;
- normal signal provenance and content hash.

The producer descriptor contains only public semantics:

```text
source:  locked AudioAsset resource reference
scope:   composition ID and scene ID
range:   half-open selected-source Time interval
at:      scene-local placement of range.start
detector/window/hop/attack/release/floor/ceiling
mapping: closed linear typed from/to endpoints
```

Unknown fields, missing fields, wrong quantity dimensions, noncanonical
rationals, orphan producers, producer/event combinations, conflicting
baselines, bad scopes/resources, unsupported targets, and forged identities
fail strict loading. Inspect reports the authored producer, its analysis-to-
scene clock boundary, and authored content identity. Semantic diff reports
producer-field edits rather than treating the derived track as opaque.

## Source range, placement, and exact clocks

`range: start ..< end` addresses the selected source stream and is always
half-open. Inclusive `..` is rejected. `at` is scene-local: it places
`range.start` at `scene.start + at` on the composition clock. The source range
must be nonempty and inside the lock-selected stream, while
`at + (range.end - range.start)` must remain inside the producer scene.

`range.start`, `range.end`, `scene.start + at`, `window`, `hop`, `attack`, and
`release` must land exactly on the composition sample grid. CUT does not round
authored analysis times to a nearby sample. The selected stream is
deterministically resampled to the composition sample rate before its exact
sample interval is trimmed.

Analysis uses full trailing causal windows. For sample-grid values
`rangeStart`, `window`, and `hop`, event `k` is placed at:

```text
scene.start + at + window + k * hop
```

and reads exactly:

```text
[rangeStart + k * hop, rangeStart + window + k * hop)
```

The event time must be strictly before the selected range end. An event at
visual time `t` therefore sees no sample at or after `t`. The final sub-hop
interval holds the last causal value. A nonzero signal resets at the exact
half-open range end. Runtime preparation converts composition-clock analysis
events into a scene-local property track before any frame is rendered.

## Detection, smoothing, and normalization

The two supported stereo-linked detectors are:

- `peak`: maximum absolute left-or-right sample in the window;
- `rms`: square root of the mean square across both channels and the complete
  window.

Swapping channels does not change a measurement. Let `d[k]` be a measured
window and `e[k]` the envelope. The first window initializes `e[0] = d[0]`.
Later windows use one attack/release pole:

```text
c = exp(-hopFrames / attackFrames)   when d[k] > e[k-1]
c = exp(-hopFrames / releaseFrames)  otherwise
e[k] = c * e[k-1] + (1 - c) * d[k]
```

`floor` and `ceiling` are exact linear-amplitude Ratios, not dB or power, and
must satisfy `0 <= floor < ceiling <= 100%`. The smoothed value becomes:

```text
clamp((e - floor) / (ceiling - floor), 0, 1)
```

The result is quantized to the nearest millionth Ratio with exact canonical
rational output. Peak and RMS carry distinct normalization identities; one
cannot be relabeled as the other.

Silence, a constant envelope, or a varying envelope are distinguished by the
analysis result. Runtime additionally requires at least two distinct mapped
values at actual output-frame times while a consumer Group is active. Thus a
technically nonempty event list, off-frame changes, a silent selected stream,
or an inaudible constant cannot masquerade as visible modulation.

## Locked source and runtime preparation

Rendering prepares producer signals before the first frame and uses the same
invocation-scoped verified resource snapshot as ordinary media rendering. CUT
binds and verifies:

- active `master` or `proxy` selection;
- locked resource bytes and SHA-256;
- the absolute selected audio stream index, its sample rate, duration, and
  canonical selected-stream identity;
- the bound FFmpeg/toolchain implementation identity;
- all exact analysis clocks, detector, normalization, smoothing, quantization,
  work, and mapping identity.

FFmpeg is used only to decode the explicitly selected stream and resample it to
exact interleaved stereo f32le. CUT names `[0:selectedStreamIndex]`; it never
falls back to a container's default stream. CUT owns the analysis plan,
windows, detector, smoothing, normalization, typed signal, mapping, scene-clock
adaptation, no-op check, graph identity, and cache verification.

Prepared signals live in one renderer-owned resolver. Sampling a producer
before preparation raises `CUT_SIGNAL_PRODUCER_UNPREPARED`, and prepared state
cannot leak into a second renderer.

## Identity, determinism, and cache behavior

Authored producer and mapping fields participate in signal content hash,
semantic diff, build meaning, and consuming-node picture identity. The
executable graph additionally binds the lock-selected source/stream identity
and `@cut/data` implementation integrity, so relocking changed audio cannot
reuse stale visual frames.

The decode/analysis plan key binds the selected master/proxy, locked bytes,
stream and decoder identities plus the exact detector and clock plan. Mapping
endpoints are intentionally outside that raw analysis plan: two typed mappings
of one envelope reuse one analysis in memory while retaining distinct signal
and picture identities. Master and proxy selections have disjoint keys.

The decoded f32le cache stores an exact byte count and SHA-256 beside the full
plan/decoder identity. A missing, malformed, wrong-size, symlinked, or
same-size-tampered entry is a miss and is regenerated. Preparation evidence
records cache status, source/decoder/PCM/analysis/prepared-signal identities,
decoded work, windows, and scene-local event count.

Semantic identity is deterministic for the locked inputs and implementation
described above. CUT does not claim portable floating-point byte identity
across JavaScript engines, decoded-media identity across unpinned native
toolchains, or final encoded bitstream identity across machines.

## Resource budgets

Per producer/unique analysis:

| Bound | Value |
| --- | ---: |
| Composition sample rate | 8,000–192,000 Hz |
| Selected stream index | 0–4,095 |
| Selected source range | at most 28,800,000 stereo frames |
| Window | at most 10 seconds and strictly shorter than the range |
| Hop | 1 sample through the window length |
| Attack | 1 sample through 10 seconds |
| Release | 1 sample through 30 seconds |
| Output windows | at most 131,072 |
| Detector work | at most 268,435,456 channel-sample visits |
| Absolute decoded input sample | at most 64 |

Aggregate per composition:

| Bound | Value |
| --- | ---: |
| Producer-backed mapped tracks | 32 |
| Unique analysis plans | 16 |
| Consumer property attachments | 256 |
| Decoded stereo frames | 57,600,000 |
| Decoded cache bytes | 512 MiB |
| Output windows | 262,144 |
| Detector work | 536,870,912 channel-sample visits |

All budgets are checked before installing produced signals. Values outside a
supported property bound, work/allocation overflow, and a first causal window
that cannot affect an in-scene output frame fail rather than degrading quality
or silently skipping analysis.

## Diagnostics

The source compiler reports stable `CUT_AUDIO_REACTIVE_*` diagnostics with
source spans. The strict IR loader reports the same semantic families at exact
JSON paths. Principal families are `CONTEXT`, `SCOPE`, `RESOURCE`, `RANGE`,
`TIME`, `TYPE`, `TARGET`, `CONFLICT`, `BASELINE`, `NOOP`, and `IDENTITY`.

Runtime preparation uses source-located
`CUT_AUDIO_REACTIVE_PRODUCER_{CONFIG,SCOPE,RESOURCE,GRID,LIMIT,DECODE,IDENTITY,NOOP}`
errors. The isolated kernel additionally closes malformed plan/value/PCM/work
inputs with `CUT_AUDIO_REACTIVE_{TYPE,VALUE,RANGE,NOOP,RESOURCE,PCM,IDENTITY}`.
Produced-signal sampling without a renderer preparation context fails with
`CUT_SIGNAL_PRODUCER_UNPREPARED`.

## Executable evidence

The conformance proof is intentionally split by boundary. These test paths
name source-repository evidence; the runtime tarball deliberately does not
ship the test suite.

- `tests/audio-reactive-language.test.ts`
  proves package types, source lowering, all four mappers, IR identity/diff,
  strict loading, and source-located refusals.
- `tests/reference-audio-reactive-core.test.ts`
  proves causal clocks, peak/RMS distinction, smoothing, quantization,
  identities, deterministic replay, and malformed/over-budget refusal.
- `tests/reference-audio-reactive-preparation.test.ts`
  proves verified exact-stream decode, actual pixel change, cold/warm and
  tamper-repair cache behavior, master/proxy separation, renderer isolation,
  selected-stream refusal, hostile endpoints, and ownership checks.
Together these tests cover source lowering, causal clocks, mapping, verified
decode, cache behavior, pixel change, audible graph output, and fail-closed
resource and endpoint handling. They are engineering conformance tests, not a
claim of musical or editorial quality.

## Explicit nonclaims

This slice does **not** implement or imply:

- onset, beat, tempo, transient-marker, or frequency-band analysis;
- spectral features, waveform/spectrogram values as general signals;
- Bus, stem, post-effect, post-mix, sidechain, microphone, or live-input
  analysis;
- centered/look-ahead windows;
- driving audio processors or analysis controls from the derived signal;
- attachment beyond direct scene-root Group `x`, `y`, `scale`, `rotation`, or
  `opacity`;
- automatic musical editing, production-quality score/SFX, taste, or creative
  review;
- a CUT 1.0 professional-film claim.

Those capabilities require separate public semantics and executable proof;
they must not be inferred from amplitude modulation.
