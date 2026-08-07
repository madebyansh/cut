# Transition contracts (0.4 alpha)

CUT 0.4 alpha has three separate executable transition paths plus a bounded
atomic linked J/L hard-cut path. The first-class
picture-track path is the canonical editorial slice for new picture-only work.
The older linked A/V component remains available for one coupled picture/audio
overlap, but it is not used internally by `PictureTrack` and does not count as
implementation evidence for track handles. The third path is a bounded
retained-subject `MatchTransition` across an existing adjacent hard cut; it
does not consume media handles or imply audio overlap. Its equal-basis
Camera2D/LocalSpace contract, exact half-windows, continuity modes, color
convergence, diagnostics, cache identity, frame evidence and nonclaims are
normative in [`SEMANTIC_MATCH.md`](SEMANTIC_MATCH.md).

## First-class PictureTrack transition

```cut
import { Sequence, PictureTrack, PictureClip, transitionAt } from "@cut/edit";

Sequence(duration: 2s) {
  PictureTrack(sourceDuration: 2s, edits: [
    transitionAt(at: 1s, duration: 500ms, kind: "wipe",
                 direction: "left", softness: 12%)
  ]) {
    PictureClip(source: outgoing, range: 4s ..< 5s, duration: 1s,
                tailHandle: 250ms);
    PictureClip(source: incoming, range: 9s ..< 10s, duration: 1s,
                headHandle: 250ms);
  }
}
```

`headHandle` and `tailHandle` declare source media available before and after a
clip's visible half-open range. They are media availability, not a transition
declaration. Extra or entirely unused handles are legal. Locking validates the
full declared availability against the selected source duration, frame rate and
time base. Rendering decodes only the exact portion consumed by a transition,
so increasing unused availability changes source/structural evidence but not
render identity or cache keys.

`transitionAt` is a typed `PictureEdit`. In the current v1 operation plan:

- `at` must be an existing hard cut between two adjacent `PictureClip` items;
  gaps, track edges and points inside a clip fail with source-located
  diagnostics;
- the overlap is centered on the cut and `duration` must be an even number of
  at least two composition frames;
- each side consumes exactly `duration / 2`: the outgoing tail after its
  visible source range and the incoming head before its visible source range;
- both adjacent clips remain at their original destination intervals and total
  sequence duration is unchanged;
- adjacent clips must currently be unlinked, forward 1x picture. Reverse,
  freeze, non-1x, speed-ramp and coupled-audio handle mapping fail explicitly;
- structural edit operations materialize first, then every `transitionAt`
  resolves against that final hard-cut topology. A later split/trim/replace is
  therefore safe when the declared cut and required handles still exist; if it
  removes or moves them, the transition fails at its own source span rather
  than retaining stale node ownership;
- multiple transitions are allowed when their centered overlap intervals are
  disjoint. Adjacent cuts may share a middle clip's distinct head and tail
  handles when the overlap windows only touch; duplicate cuts or intersecting
  overlap windows fail instead of relying on source-order arbitration;
- cross-dissolve, dip, wipe, push and slide use the same deterministic,
  alpha-correct linear-light kernels described below. Kind-specific unused
  controls are rejected rather than ignored.

The typed IR records the exact cut, overlap, concrete outgoing/incoming node
IDs, exact consumed source intervals, canonical style and provenance. Runtime
validation replays the complete edit plan and compares every field before
decode. The compositor samples the actual handle frames; it does not freeze the
visible edge, shorten the sequence, synthesize an overlap, or invoke the legacy
`Transition` component.

The strict OTIO exporter currently emits
`CUT_OTIO_TRACK_TRANSITION_UNSUPPORTED` and marks the report lossy rather than
serializing a hard cut or silently dropping the consumed-handle semantics.

Executable proof is in
`tests/reference-picture-track-transition.test.ts`: public syntax and typed IR,
all five styles, `editClip` operands, two disjoint adjacent-cut transitions,
post-declaration structural edits, duplicate/overlap diagnostics, locked
bounds/grids, decoded handle-frame selection before and after both cuts,
duration preservation, strict loader and hostile-IR replay, unused-handle
identity/cache locality, semantic diff and explicit OTIO loss reporting.

## Linked A/V Transition component

`Transition` is a public `@cut/edit` component. It passes through the normal
CUT parser and dimensional type checker, lowers to canonical CutAVIR, survives
the strict public IR loader, is revalidated before execution, and drives both
the reference picture compositor and audio graph. CUT source is canonical; no
model, asset-name recognition, or hidden edit graph interprets this operation.

```cut
import { Clip, Transition } from "@cut/edit";

Transition(kind: "wipe", duration: 500ms, direction: "left", softness: 12%) {
  at 0s {
    Clip(source: outgoing, range: 4s ..< 5s, duration: 1s);
  }
  at 500ms {
    Clip(source: incoming, range: 9s ..< 10s, duration: 1s);
  }
}
```

The two `Clip` intervals overlap from `500ms` through `1s`. Picture and source
audio use that same exact half-open interval.

## Atomic linked JCut and LCut

`JCut` and `LCut` are public `@cut/edit` components over the same linked `Clip`
source primitive. They are executable hard edits, not aliases, metadata, fades,
or model-interpreted intent:

```cut
import { Clip, JCut, LCut } from "@cut/edit";

JCut(overlap: 500ms) {
  at 0s    { Clip(source: interviewer, range: 10s ..< 11s, duration: 1s); }
  at 500ms { Clip(source: guest, range: 20s ..< 21s, duration: 1s); }
}
```

Both forms require exactly two direct, source-ordered `Clip` children. The
first starts first, the second starts before the first ends, and the second
ends after the first. `overlap` must be positive and exactly equal the
half-open interval `[incoming.start, outgoing.end)`. Parent union, child
placements, and overlap start/duration must land on both the composition frame
grid and destination sample grid. Normal linked-Clip locking additionally
proves each source-range start/end/playback end against both the selected video
stream clock and selected source-audio sample clock.

The two child source clocks remain linked and run continuously:

- `JCut` hard-cuts audio at `overlap.start` and picture at `overlap.end`, so
  the overlap selects outgoing picture with incoming audio;
- `LCut` hard-cuts picture at `overlap.start` and audio at `overlap.end`, so
  the overlap selects incoming picture with outgoing audio;
- every half-open sample/frame interval selects exactly one child. CUT injects
  no doubled mix, fade, crossfade, duck, time shift, hold, or retime;
- an explicitly authored `Clip.fadeIn`/`fadeOut` still executes on that linked
  child; the wrapper neither invents nor removes it.

Canonical CutAVIR uses `cut.edit.jcut` or `cut.edit.lcut`, `domain: "av"`, one
exact union interval, the typed `overlap` input and two child-owned Clip IDs.
The strict loader accepts those closed kernels; compiler and runtime both
re-derive ordering, ownership, union, grids and overlap. Source errors use
`CUT2094`; hostile loaded graphs use source-located
`CUT_LINKED_SPLIT_CONTRACT`. Unknown input/type errors remain `CUT2059` and
`CUT2029`, and source-media clock failures remain `CUT_MEDIA_SOURCE_GRID` or
`CUT_EDIT_LINKED_CLIP`.

Picture/build/semantic identity distinguishes JCut from LCut. The pre-master
audio cache does too: the hard audio cut moves between overlap start and end,
so an otherwise identical JCut-to-LCut edit changes PCM and misses both audio
and picture caches. OTIO exports the exact two linked Clip track pairs and
emits `CUT_OTIO_LINKED_SPLIT_UNSUPPORTED`; standard OTIO cannot retain the
distinct hard-picture boundary, so CUT reports the flattening instead of
silently manufacturing an ordinary overlap or dissolve.

Executable proof lives in `tests/reference-linked-split.test.ts`: public
syntax, strict typed loading, stable source/runtime diagnostics, hostile IR,
decoded hard-cut pixels for both forms, exact PCM samples immediately before,
at and after both overlap boundaries, audiovisual/semantic identity, localized
picture/audio cache behavior and structured OTIO loss.

## Executable overlap semantics

- A `Transition` has exactly two direct, source-ordered linked `Clip` children.
  The first clip starts first; the second starts before the first ends and ends
  after it.
- `duration` must exactly equal `[incoming.start, outgoing.end)`. The transition
  node interval is exactly the ordered union of both children.
- Parent start/duration, overlap start/duration, and each linked-clip placement
  and duration land on both the composition frame grid and output sample grid.
  The overlap spans at least two picture frames.
- Each `Clip.range` is an explicit available source interval. When `duration`
  is shorter than that interval, playback consumes its exact prefix; CUT does
  not reinterpret the remainder as hidden transition handles. Applying
  `cut.lock` and pre-render verification reject a range beyond the earlier
  selected video/source-audio stream bound. Current `cut lock` creation probes
  and validates the selected streams before writing a lock, so a newly authored
  out-of-bounds range fails at lock creation; applying an existing lock repeats
  the same bound contract.
- Locked source-range start, authored end, and playback end must land on the
  selected picture stream's frame and time-base grids and the selected
  source-audio stream's sample grid. Linked audio uses exact source-sample
  `atrim` before deterministic resampling; floating-time trim rounding is not
  accepted as semantics.
- The two children are child-owned by this transition and cannot be shared with
  another direct parent.
- `fadeOut` on the outgoing child and `fadeIn` on the incoming child are refused:
  the transition owns those overlap envelopes and will not double-apply them.
- Picture endpoints are literal: progress zero is the outgoing frame and
  progress one is the incoming frame. Picture interpolation is deterministic
  premultiplied linear-light sRGB and returns straight-alpha RGBA.
- Source audio always receives a sample-indexed linear outgoing/incoming
  crossfade over the exact same overlap. Picture `kind` does not secretly alter
  the audio curve.

## Closed picture controls

```text
Transition(
  kind: "cross-dissolve" | "dip" | "wipe" | "push" | "slide",
  duration: Time,
  direction?: "left" | "right" | "up" | "down",
  softness?: Ratio,
  color?: Color
) { exactly two Clip children }
```

- `cross-dissolve` performs a linear-light pixel dissolve. It accepts no
  direction, softness, or color.
- `dip` passes through `color` at the exact midpoint; the default is opaque
  black. It accepts no direction or softness.
- `wipe` accepts direction and `softness` from `0%` through `100%`. The feather
  moves continuously from outside the incoming edge to outside the outgoing
  edge, preserving exact endpoints.
- `push` moves outgoing and incoming pictures together. `slide` moves the
  incoming picture over a stationary outgoing picture. Both accept direction;
  neither accepts softness or color.
- Omitted direction defaults to `left` for wipe, push, and slide. Direction
  describes incoming travel: `left` enters from the right edge.

Unknown inputs fail at their source span. A control that would not affect the
selected kind is rejected rather than accepted as a no-op.

## Typed IR and diagnostics

The canonical IR node uses `op: "cut.edit.transition"`, `domain: "av"`, the
exact union interval, two ordered child IDs, closed typed inputs, normal
provenance, and identity-bearing package integrity. The strict CutAVIR loader
closes fields, types, units, hashes, references, and timing. The shared runtime
contract then re-derives the overlap from the child intervals and rejects any
loaded graph that changes ordering, ownership, grids, bounds, or conditional
controls.

Stable source diagnostics include:

- `CUT2059`: unknown argument;
- `CUT2068`: unsupported kind or direction literal;
- `CUT2084`: invalid child/overlap/ownership/grid or a kind-specific no-op
  control.

Loaded or tampered executable graphs fail with source-located
`CUT_TRANSITION_CONTRACT`. Locked source-clock incompatibility fails with
`CUT_MEDIA_SOURCE_GRID`; hostile loaded linked-clip ranges fail with
`CUT_EDIT_LINKED_CLIP`. Both carry source locations and occur before decoding.

`cut check` performs the deterministic lowering validation that produces
`CUT2084`, so the VS Code problem matcher and command line do not report a
false pass for a malformed overlap. Source-clock compatibility necessarily
waits for `cut lock`, where those stream clocks are probed and frozen.

## Check, lock, inspect, render

```bash
cut check edit.cut
cut lock edit.cut --out cut.lock
cut inspect edit.cut --lock cut.lock
cut render edit.cut --lock cut.lock --output out --out edit.mp4
```

Executable proof lives in:

- `tests/reference-transition.test.ts`: source, checker/compiler, strict IR
  loading, cache identity, source diagnostics, locked handle bounds, decoded
  frame timing, exact PCM overlap boundaries, and correlated-source unity;
- `tests/reference-transition-config.test.ts`: hostile loaded-IR invariants and
  source-located runtime diagnostics;
- `tests/reference-transition-pixels.test.ts`: exact endpoints, linear-light
  dissolve, dip color/alpha, every direction, straight/premultiplied
  equivalence, hidden-RGB isolation, wipe softness continuity, push seams,
  slide behavior, and malformed-surface refusal;
- `tests/reference-linked-clip-source-grid.test.ts`: 44.1 kHz off-grid refusal
  and exact sample-indexed 44.1-to-48 kHz execution.

The coupled-path integration fixture uses generated lossless picture and PCM
assets with recorded hashes. The integration test
locks that exact source, renders literal red and blue endpoints plus the exact
linear-light midpoint, and checks both output channels at the sample before
the overlap, progress zero, midpoint, final overlap sample and first incoming
plateau sample. The adjacent invalid source remains a negative lock-creation
test; it is not allowed to prevent the valid program from executing.

## Deliberate limitations

The first-class track slice is picture-only, centered/even-frame and
forward-1x-only. It supports multiple transitions only when every centered
overlap has one unambiguous owner; intersecting overlaps are refused rather
than layered. It does not atomically couple a corresponding AudioTrack
crossfade into the same linked edit. The separate bounded
`audioCrossfadeAt` slice consumes locked AudioClip handles with linear or
equal-power envelopes, but linked A/V transition selection remains manual and
independent. The picture slice also lacks custom/eased curves, transition
packages, nested-sequence transition editing or lossless OTIO transition
interchange. The linked-A/V transition and J/L wrappers still lack separately
addressable picture/audio handles, bus/stem integration, per-channel overlap
control, multi-clip operation plans, coupled ripple/slip/slide, and nested
editable AV sequences. Push and slide use deterministic integer-pixel
displacement, which can visibly step on very small canvases.

Semantic match V1 is likewise bounded: it does not infer subject
correspondence, morph arbitrary geometry, normalize unequal local bases,
follow tracked/geographic owners, execute through nested compositions or
design sound. Its two unrelated public fixtures are engineering conformance,
not full-speed/headphone/independent creative approval.

These are executable vertical slices but remain **PARTIAL** evidence for EDT-02
and EDT-04. They must not be presented as the complete professional transition
model or as CUT 1.0 readiness.
