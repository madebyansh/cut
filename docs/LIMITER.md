# CUT-owned true-peak limiter

`Limiter` is a public audio component, not a spelling for an FFmpeg filter:

```cut
Limiter(ceiling: -1dbtp, release: 80ms, lookahead: 5ms) as master {
  Bus(name: "programme") { /* audio children */ }
}

at 2s { set master.ceiling = -3dbtp; }
at 3s { animate master.release from 80ms to 250ms over 500ms ease outCubic; }
```

`ceiling` is `TruePeak` from -23.5 through 0 dBTP. `release` is `Time`
from 1 ms through 2 s. Both accept `set`, `linear`, and `outCubic` signals on
the exact composition sample clock. `lookahead` is a static exact-sample
`Time` from 0 through 20 ms; it changes processor topology and cannot be set or
animated. The default is -1 dBTP, 50 ms release, and 5 ms lookahead.

## Executable semantics

The reference path mixes the complete child graph to private exact stereo
`f32le`, then runs
`cut.reference-limiter/alpha-48khz-stereo-f32-bs1770-5-annex2-4x-linked-lookahead-reconciled-chunked-v3`.
FFmpeg does not implement the gain law.

1. CUT derives one group-delay-compensated stereo-linked envelope per source
   frame with the frozen BS.1770-5 Annex 2 four-phase FIR and a sample-peak
   floor.
2. A monotonic queue finds the largest future *audio* peak inside the inclusive
   lookahead window. It never reads a future ceiling value.
3. The current frame's ceiling and release values determine instantaneous
   downward gain and the release recurrence toward unity. One gain multiplies
   both channels.
4. CUT rescans the exact Float32 output. A constant ceiling may receive one
   recorded programme-uniform downward reconciliation plus 0.01 dB numeric
   safety. A varying ceiling that would require that non-causal correction
   fails `CUT_AUDIO_LIMITER_RECONCILIATION` with
   `dynamic-ceiling-reconciliation-unsupported`; CUT does not let a future
   automation event alter earlier PCM.
5. For a static ceiling, CUT binds the core bytes to a direct no-follow file
   snapshot and asks a separately identified FFmpeg `loudnorm` input meter to
   inspect those exact bytes over the same frame boundary. The worse of CUT's
   Annex 2 result and that secondary result authorizes the output. If needed,
   CUT applies one programme-uniform Float32 correction to
   `ceiling - 0.01 dB`, measures the corrected bytes once with both authorities,
   and refuses the build unless both pass under the unchanged executable
   identity. Dynamic ceilings record
   `not-applicable-dynamic-ceiling`; a global secondary-meter correction is
   deliberately not allowed to rewrite their time-varying intent.

Programmes through 3,728,270 frames retain the frozen in-memory
implementation. Longer programmes use a separate bounded file adapter. It
reads at most 65,536 real frames plus the exact FIR/lookahead halo at once.
FIR convolution retains global source-frame indices across every halo; the
lookahead queue is rebuilt from the overlapping envelope while the
stereo-linked release state carries continuously between chunks. The actual
Float32 output is rescanned from the private file with the same halos. If a
static ceiling needs correction, CUT writes one new private file and performs
one final complete verification pass. No media-backend limiter or chunk-local
state reset is involved.

The processor preserves the exact frame count and exact zero samples. It does
not delay programme placement: lookahead changes the gain applied before a
future audio transient, while the authored waveform stays on the composition
clock. A ceiling or release event first affects the gain law at its authored
sample.

The renderer prepares limiter boundaries recursively. Nested limiters therefore
execute inner-to-outer, and `Limiter(TimeStretch(...))` or
`TimeStretch(Limiter(...))` retains a private Float32 handoff instead of
quantizing through PCM24. The ordinary FFmpeg graph only ingests the prepared
result; executed-graph tests refuse an `alimiter=` filter.

## Bounds and honest limitations

- exactly stereo 48 kHz Float32 in this alpha slice;
- at most 960 lookahead samples;
- the original in-memory core remains capped at 3,728,270 frames (about 77.67
  seconds) and its three-scan `2^30` FIR multiply-add ceiling is unchanged;
- a longer invocation selects the fixed 65,536-frame file/chunk path, bounded
  to 14,400,000 frames (exactly five minutes at 48 kHz);
- aggregate materialized executions remain bounded: repeated references to one
  prepared limiter frontier inside the same render context reuse that exact
  source and are charged once, while nested Limiter, TimeStretch, and
  TempoDelay child-render contexts are charged separately when reuse is not
  valid; in-memory-only graphs retain the original `2^30` ceiling and any
  graph selecting the chunk path has a separate `2^34` aggregate FIR-work
  ceiling;
- chunk storage is an offline deterministic adapter, not a realtime
  native/WASM kernel;
- no oversampled clipper, multiband limiting, channel weighting beyond linked
  stereo, or production listening/platform corpus yet;
- dynamic-ceiling cases that need post-law reconciliation fail explicitly;
- static ceilings have the two-authority policy above, while dynamic ceilings
  have only the frozen Annex 2 contract and no secondary-meter reconciliation;
- compatibility evidence binds the resolved FFmpeg executable bytes and its
  complete bounded version banner, but not every dynamically loaded library;
- current execution evidence is macOS-only. A host without the required
  no-follow snapshot semantics fails explicitly; Linux CI proof remains open.

These are release blockers for a broad professional `Limiter` PASS, not hidden
fallbacks. Unsupported rates, work, controls, non-finite PCM, malformed private
boundaries, and unsafe dynamic reconciliation have stable source-located
diagnostics. Output names are reserved with create-new semantics, so an
existing file is never overwritten. `.unreconciled`, `.corrected`,
`.ceilings`, and the reserved output are removed after every failed execution.
Closed limiter evidence records `execution.mode` (`in-memory` or
`chunked-file`) and the fixed chunk size; that evidence and the v3 processor
identity participate in audio-cache authorization.

## Executable evidence

- `tests/reference-audio-limiter-contract.test.ts`: syntax, types, strict IR,
  exact-grid/bounds, automation, cache-bearing identity and hostile input.
- `tests/reference-audio-limiter-core.test.ts`: independent direct convolution,
  lookahead and release recurrence, exact automation boundaries, zero/one-
  sample adversarial fuzz, output rescans, reconciliation and refusal.
- `tests/reference-audio-limiter-runtime.test.ts`: public source to exact raw
  output, byte-identical independent core replay, nested execution, exact
  silence/onset/duration, no FFmpeg limiter, a complete 240-second public
  render and pre-output work refusal beyond five minutes.
- `tests/reference-audio-limiter-file.test.ts`: dynamic ceiling/release and FIR
  events across a chunk boundary are byte-identical to the frozen in-memory
  law; sparse 240-second processing preserves exact length; static
  reconciliation, deterministic dynamic-reconciliation refusal, later-chunk
  failure cleanup and existing-output collision behavior are executable.
- `tests/reference-audio-limiter-compatibility.test.ts`: the retained
  Nyquist-rich meter discrepancy, exact-boundary stdin measurement, one guarded
  correction, executable mutation, bounded process/parser behavior and closed
  path-free evidence validation.
- `tests/reference-audio-limiter-cache.test.ts`: recursive execution evidence,
  static/dynamic policy distinction and cold/warm cache authorization.

Final loudness normalization and lossy AAC compliance are separate downstream
contracts described in [Reference AAC delivery guard](AAC_DELIVERY.md).
