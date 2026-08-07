# Picture Sequence contract (0.4 alpha)

This document describes one executable editorial vertical slice. It does not
describe the eventual CUT 1.0 timeline contract.

`Sequence`, `PictureTrack`, `PictureClip`, and `Gap` are public `@cut/edit`
components. They pass through the normal CUT parser and dimensional type
checker, lower to typed CutAVIR, are validated after loading, and execute in the
reference picture runtime. No model or hidden edit graph is involved.

```cut
import { Sequence, PictureTrack, PictureClip, Gap } from "@cut/edit";

Sequence(duration: 3s) {
  PictureTrack() {
    PictureClip(source: opening, range: 4s ..< 5s, duration: 1s);
    Gap(duration: 1s);
    PictureClip(source: closing, range: 9s ..< 10s, duration: 1s);
  }
}
```

## Executable semantics

- A `Sequence` owns one exact positive destination interval and one or more
  direct `PictureTrack` children.
- Every `PictureTrack` spans the complete owning `Sequence` interval. Its
  direct `PictureClip` and `Gap` items execute sequentially in source order.
- A track must fill its interval exactly. Empty time is never inferred; author
  a `Gap` explicitly.
- `PictureClip.range` is an exact half-open source interval (`start ..< end`).
  Default playback requires equal source and destination durations. The closed
  [picture time-map contract](EDITORIAL_TIME_MAP.md) additionally executes
  exact constant normal/reverse rates, an explicit source-frame freeze, and a
  bounded forward piecewise-linear speed-rate curve.
- Destination placements and durations must land on composition picture-frame
  boundaries. After locking, source-range endpoints must also land on the
  selected locked video stream's reported frame rate. Missing source-rate
  metadata is an explicit unsupported error.
- Multiple picture tracks composite in authored order, bottom to top, using
  normal alpha. `PictureClip` executes `fit`, `opacity`, `scale`, and `rotation`.
- The IR records ordered destination intervals for every item and a source
  interval for every clip. The runtime reads those records; it does not infer
  editorial order from object enumeration or asset names.

Formatting and comments do not alter semantic graph identity. Source bytes are
still recorded separately in `sourceHash` and the lock.

## Closed authoring surface

```text
Sequence(duration: Time) { PictureTrack children }
PictureTrack(
  sourceDuration?: Time,
  edits?: List<PictureEdit>
) { PictureClip | Gap children }
PictureClip(
  source: VideoAsset,
  range: Range<Time>,
  duration: Time,
  headHandle?: Time,
  tailHandle?: Time,
  playback?: "normal" | "reverse" | "freeze",
  rate?: Number,
  freezeAt?: Time,
  speedRamp?: List<PictureSpeedPoint>,
  fit?: "cover" | "contain" | "fill",
  opacity?: Ratio,
  scale?: Number,
  rotation?: Angle,
  link?: String,
  inputColor?: "srgb" | "linear-srgb" | "rec709-full" | "rec709-limited" | "bt470bg-smpte170m-limited"
)
Gap(duration: Time)
```

Unknown arguments fail at their source span. Non-node statements directly
inside a sequence or track fail instead of being reordered. Audio, AV, and
ordinary visual nodes are not picture-track items. `PictureClip` and `Gap`
cannot be detached from a direct `PictureTrack` parent.

Stable compiler codes for this slice are:

- `CUT2070`: hidden control flow or another non-node track/sequence statement;
- `CUT2071`: invalid direct child kind;
- `CUT2072`: detached `PictureClip` or `Gap`;
- `CUT2073`: empty sequence or track;
- `CUT2074`: invalid destination interval, frame boundary, or track fill;
- `CUT2075`: invalid half-open source interval or implicit rate change;
- `CUT2076`: compiler defense against an invalid editorial structure;
- `CUT2081`: malformed or invalid picture/audio link grouping.
- `CUT2086`: invalid, ambiguous, out-of-range, or no-op picture time mapping.
- `CUT2090`: malformed, empty, redundant, or net no-op picture edit plan;
- `CUT2091`: invalid picture edit range, point, target, duration, or frame grid;
- `CUT2092`: picture edit materialization cannot satisfy the owning duration;
- `CUT2093`: explicitly unsupported linked/coupled edit behavior.

An optional `PictureClip.link` participates in the explicit one-picture / one-
audio relationship described by the [audio-track contract](EDITORIAL_AUDIO_TRACK.md).
It records grouping only and never copies or couples timing.

Loaded/tampered IR fails with the closed `CUT_IR_*` loader codes or the
source-located runtime codes `CUT_EDIT_SEQUENCE`, `CUT_EDIT_TRACK`,
`CUT_EDIT_PICTURE_CLIP`, and `CUT_EDIT_GAP`.
Non-default picture time-map/input disagreement uses the source-located
`CUT_EDIT_PICTURE_TIME_MAP` code.
Loaded operation-plan disagreement uses source-located `CUT_EDIT_OPERATION`.

## Check, lock, inspect, render

Use the normal deterministic workflow:

```bash
cut fmt edit.cut --check
cut check edit.cut
cut lint edit.cut --deny-warnings
cut lock edit.cut --out cut.lock
cut inspect edit.cut --lock cut.lock --json
cut render edit.cut --lock cut.lock --output out --out edit.mp4
```

`tests/reference-picture-sequence.test.ts` is the base executable proof. It checks
typed source/destination IR, closed diagnostics, tampered loaded IR, semantic
identity, locked source-frame alignment, exact gap boundaries, decoded pixels,
and two-track bottom-to-top compositing order.
`tests/reference-picture-time-map.test.ts` adds exact identity, IR tamper,
source-bound, frame-index, decoded-pixel, and decoded-alpha proof for constant
rate, reverse, freeze, and bounded piecewise-linear forward speed ramps.

## Deliberate limitations

The optional `sourceDuration` / `edits` pair now lowers the executable
[picture-track operation algebra](EDITORIAL_OPERATIONS.md): split, trim,
ripple insert/delete, overwrite, replace, lift, extract, slip, slide, explicit
gap operands, and multiple disjoint centered `transitionAt` declarations that
resolve after the structural edits. `PictureClip`/`editClip`
head and tail handles declare locked available media; unused availability is
legal and excluded from render/cache identity. Without the operation pair, the
original direct source-ordered contract and semantic identity remain unchanged.

The newer scene-local [`TimelineEdit`](TIMELINE_EDIT.md) authority unifies a
bounded subset of picture and audio operations under one atomic selection,
lineage, J/L, transition, metadata, inspect/diff, runtime-replay, and
interchange contract. It does not silently translate into this older
picture-only operation list.

This sequence remains picture-only and intentionally small. A separate
executable [AudioTrack slice](EDITORIAL_AUDIO_TRACK.md) now provides explicit
sample-accurate gaps, independent source/destination ranges, and link metadata.
The combined picture/audio track slices can express manually authored J/L
timing. Separate bounded two-Clip `JCut`/`LCut` wrappers now execute the atomic
crossed hard-picture/audio-boundary case, but the track operation algebras do **not** yet
implement nested-sequence operands or edits, coupled linked ripple/slip/slide, intersecting/layered
picture-track overlaps, linked audio
ripple/slip/slide,
reverse/freeze curve segments, eased/arbitrary source-time curves,
track-integrated retimed audio,
track-level effects, or sequence
relinking. The first-class picture transition and separate linked-AV
[`Transition`](EDITORIAL_TRANSITIONS.md) have distinct contracts; the latter
wraps legacy `Clip` children and is never silently accepted as a `PictureTrack`
item. Those missing operations remain mandatory work before CUT 1.0 and must
not be inferred from this slice.
