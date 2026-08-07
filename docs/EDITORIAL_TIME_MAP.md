# Picture time-map contract (0.4 alpha)

This is the closed, picture-only retiming slice implemented by public
`@cut/edit PictureClip`. It includes constant/reverse/freeze maps and one
bounded forward speed-curve form. It is not a claim that CUT has arbitrary
source-time curves or linked audiovisual time stretching. The separate
constant-ratio audio `TimeStretch` processor does not alter this track map.

```cut
PictureClip(
  source: shot,
  range: 12s ..< 14s,
  duration: 1s,
  playback: "reverse",
  rate: 2,
  frameSelection: "nearest"
)

PictureClip(
  source: shot,
  range: 20s ..< 21s,
  duration: 1s,
  speedRamp: [
    speedPoint(at: 0s, rate: 0.5),
    speedPoint(at: 500ms, rate: 1.5),
    speedPoint(at: 1s, rate: 0.5)
  ]
)
```

## Public semantics

- `playback` is `"normal"` by default and accepts `"normal"`, `"reverse"`, or
  `"freeze"`.
- Normal and reverse playback accept an exact positive scalar `rate` from
  `1/64` through `64`. The half-open source duration must equal destination
  duration multiplied by `rate` exactly; CUT never infers a rate.
- Freeze playback requires `freezeAt: Time` inside the authored half-open
  source range. It rejects `rate` because that value would do nothing.
- Normal/reverse reject `freezeAt`. Unsupported combinations fail at the
  `PictureClip` source span with `CUT2086`.
- `frameSelection` is `"floor"` by default. Explicit `"floor"` canonicalizes
  to omission, preserving the pre-extension node, IR, and build identity.
  `"nearest"` is an identity-bearing discrete-frame policy for normal,
  reverse, and speed-ramp playback. Exact half-frame ties select the preceding
  frame; phases strictly above half select the following frame; selection is
  clamped inside the authored half-open source authority.
  `"frame-blend"` is a separate identity-bearing two-frame policy for normal,
  reverse, speed-ramp, and freeze playback. Freeze resolves to its one exact
  locked frame, so its blend phase is zero. `"optical-flow"` remains a
  reserved spelling that fails source-located rather than degrading to
  discrete sampling or frame blending.
- `speedRamp` accepts 2–32 `speedPoint(at: Time, rate: Number)` values. The
  first point must be at `0s`, the last must equal `PictureClip.duration`, and
  times must increase strictly on the destination frame grid. Every rate is
  positive and bounded from `1/64` through `64`.
- Between points, instantaneous rate changes linearly in destination time.
  CUT computes source offset by the exact rational trapezoid integral. For a
  segment starting at `(t0, r0)` and ending at `(t1, r1)`, offset at `t` is
  `r0*(t-t0) + (r1-r0)*(t-t0)^2 / (2*(t1-t0))`. The authored half-open source
  duration must equal the complete integral exactly; CUT never guesses source
  range or clip duration.
- Ramps are forward-only. They cannot combine with `playback`, `rate`,
  `freezeAt`, or `link`; zero/negative rates, reverse crossings, unsupported
  easing fields, excessive points, off-grid controls, and mismatched integrated
  duration fail explicitly. A curve whose rates are all equal canonicalizes to
  the equivalent constant-rate map and build identity.
- Omitted controls and explicit
  `playback: "normal", rate: 1, frameSelection: "floor"` canonicalize to the
  same node, track metadata, package identity, and build ID. The typed IR emits
  no redundant default time-map object.
- Non-default maps are identity-bearing typed IR:
  `constant(direction, rate, frameSelection?: nearest | frame-blend)`,
  `freeze(at, frameSelection?: frame-blend)`, or
  `speed-ramp(interpolation: linear-rate, frameSelection: floor | nearest | frame-blend, points)`.
  The closed IR loader rejects unknown modes, fields, point shapes, bounds, and
  ordering; reference preflight reconciles the object with canonical public
  inputs and reports `CUT_EDIT_PICTURE_TIME_MAP` on disagreement.

For constant playback, destination frame `n` produces exact phase
`n / destinationFPS * rate * sourceFPS` in the locked source-frame buffer.
Floor selects the preceding integer frame. Nearest compares twice the exact
BigInt remainder with the denominator, rounds up only when it is strictly
greater, and therefore resolves exact halves to the preceding frame without
host floating-point behavior. Slow rates repeat frames; fast rates skip
frames. Reverse uses the same monotonic index over a bounded buffer whose
decoded order has been reversed. Freeze decodes one explicit locked source
frame and reuses it.

For a speed ramp, CUT evaluates the exact integrated source offset at each
destination frame and applies the same typed floor, nearest, or frame-blend
policy to `offset * lockedSourceFPS` in the forward decoded source buffer.
There is no motion synthesis, optical flow, or backend setpts curve. Positive
rates make decoder indices monotonic, so the runtime never seeks backward
within a ramp.

For frame blend, CUT keeps the exact rational source phase through planning,
then rounds only its fractional remainder to one Q16 value using
round-half-up. Integer phases copy the selected source RGBA bytes literally,
including hidden RGB. Fractional phases read the adjacent in-authority source
frames, interpolate encoded-sRGB RGB in associated alpha with integer
round-half-up, return straight RGBA8, and clear RGB when output alpha rounds to
zero. The two source buffers are read-only; the result is newly allocated.
At the final source frame the second sample clamps to that frame and the phase
is zero. The policy identity and exact observed copy/blend work are validated
before use; malformed dimensions, phases, policy identities, and frames above
the 7,680×4,320 / 132,710,400-byte bound fail with
`CUT_EDIT_PICTURE_FRAME_BLEND`.

## Lock and backend boundary

Source-range endpoints and `freezeAt` must land on both the lock-selected video
time base and source frame grid. Optional non-negative `headHandle` and
`tailHandle` extend the declared available source interval; their extended
boundaries must also land on the locked grids and remain inside the selected
stream duration. Unused handle availability does not expand the decoder window.
One first-class PictureTrack transition may consume exact forward-1x halves;
reverse, freeze, non-1x and speed-ramp handle mapping is explicitly unsupported.
The reference backend decodes picture at the locked source frame rate; CUT owns
the editorial mapping and gives FFmpeg only the already-validated raw
decode/reverse plan.

Reference reverse is deliberately bounded to 3,600 source frames and a
512 MiB canvas-sized raw-frame budget. Crossing either limit is an explicit
diagnostic, not an unbounded backend allocation.

Picture edit operations retain this map rather than flattening it. Split and
trim integrate and slice the curve at the exact edit boundary; slip shifts the
source window without altering points; moving a ramped target with slide keeps
its map unchanged. If slide extends a ramped adjacent clip, CUT holds that
neighbor's first or last authored rate across the new edge. The resulting
source endpoints still have to satisfy locked frame-grid and media-bound rules.

`tests/reference-picture-time-map.test.ts` proves canonical identity, stable
source diagnostics, closed/tamper-resistant IR, lock bounds, exact rational
integration/frame-index mapping, operation-plan slicing, identity invalidation,
inspect/diff and picture-cache locality, decoded 4 fps pixels for
floor/nearest/frame-blend forward, reverse, speed ramp, TimelineEdit slices,
and freeze, plus exact frame-blend Q16/alpha/hidden-RGB/nonmutation behavior
and decoded straight-alpha preservation across ramp-selected frames. The
normal picture-sequence regressions remain in
`tests/reference-picture-sequence.test.ts`.

## Honest limits

This slice does not retime audio and refuses a ramp carrying `link`. It does not
support reverse or freeze segments inside one curve, arbitrary source-time
control points, non-linear/eased rate interpolation, optical flow,
linked/track-integrated time-stretched audio, or separately addressable source
handles. Frame blend is exact adjacent-frame interpolation, not motion
estimation. The separate bounded audio `TimeStretch` wrapper provides
pitch-preserving constant-ratio processing outside this picture contract; the
reserved general `TimeRemap` wrapper remains refused. Pixel
proof currently uses a small CFR 4 fps fixture; a broader long-GOP, VFR,
29.97/59.94, codec, and platform corpus is still required. EDT-03 therefore
remains **PARTIAL**.
