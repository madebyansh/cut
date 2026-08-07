# Nested compositions

CUT's current alpha has two executable nested-composition slices. `Precomp`
instantiates a separate `Timeline` as a visual layer. It is a composition
reference with its own exact source clock, not a `Group` alias and not a copy of
the source nodes.

```cut
import { Precomp, Rect } from "cut:visual";

timeline delivery(duration: 2s, fps: 24, width: 1920px, height: 1080px, sampleRate: 48khz) {
  scene only(duration: 2s) {
    Rect(width: 1920px, height: 1080px, fill: #f5efe6);
    Precomp(source: title, range: 500ms ..< 1500ms, x: 80px, opacity: 90%);
  }
}

timeline title(duration: 2s, fps: 24, width: 1920px, height: 1080px, sampleRate: 48khz) {
  scene in(duration: 1s) { Rect(width: 400px, height: 160px, fill: #d1495b); }
  scene out(duration: 1s) { Rect(width: 160px, height: 400px, fill: #00798c); }
}
```

The public signature is:

`Precomp(source: Timeline, range?: Range<Time>, x?: Length, y?: Length, scale?: Number, rotation?: Angle, opacity?: Ratio, editId?: String, role?: String, metadata?: EditorialMetadata) -> Visual`

The call accepts no children. Timeline declarations are registered before
their bodies are lowered, so the source may appear later in the file. Every
call creates a distinct instance and playback state while retaining one
immutable source graph. Static and signal-driven transform properties execute
on the composed visual surface in the ordinary CUT transform order. Inside a
`PictureTrack`, `editId`, the closed editorial `role`, and bounded namespaced
`metadata` provide canonical item identity for the bounded `TimelineEdit`
slice. They are compiler-only editorial inputs and never become renderer
kernel inputs.

## Exact alpha contract

- The source is picture-only. Any audio, linked AV, or timeline-level node is
  rejected instead of being discarded.
- Source scenes must be contiguous, non-overlapping, frame-exact, and cover the
  source duration exactly.
- The instance begins at its authored parent position and lasts for the exact
  selected half-open source range; omission selects the complete source. Range
  endpoints and destination placement must be exact frame boundaries and
  remain inside their respective source and owning-scene clocks.
- Parent and source canvas, FPS, and sample rate must be identical. There is no
  implicit canvas adaptation, frame-rate conversion, or clock resampling.
- Nested composition pixels are transparent outside their authored layers.
  The opaque delivery background belongs only to a top-level render.
- Composition cycles fail with `CUT_PRECOMP_CYCLE`. Missing/bad references,
  type/shape errors, timing, format, audio-discard, and bounded expansion fail
  with the source-located `CUT_PRECOMP_*` diagnostic family.
- Nesting is limited to 16 composition levels, 1,024 expanded instances, and
  1,000,000 expanded frames before renderer preparation.
- A source composition's exact format, ordered scenes, clocks, roots, items,
  and transitive node hashes participate in each instance's content hash. A
  source edit invalidates its dependent instance and host picture scene; an
  unrelated timeline edit does not.

`tests/reference-precomp.test.ts` proves public checking/lowering, forward
references, source ownership, two-scene timing, transparent pixels, multiple
and recursively nested instances, source-located refusals, loaded-IR closure,
cycle/budget limits, and localized cache invalidation.

## Audiovisual `NestedSequence`

`NestedSequence` instantiates one exact half-open selection of the picture
output and deterministic pre-master audio root mix of another CUT timeline. Omitting the
range selects the complete source. Unlike visual `Precomp`, it cannot silently
discard sound and it does not expose picture transforms that would misrepresent
audio placement.

```cut
import { NestedSequence } from "@cut/edit";
import { Rect } from "cut:visual";
import { Tone } from "@cut/audio";

timeline delivery(duration: 3s, fps: 24, width: 1920px, height: 1080px, sampleRate: 48khz) {
  scene only(duration: 3s) {
    at 1s { NestedSequence(source: interviewBeat, range: 500ms ..< 1500ms); }
  }
}

timeline interviewBeat(duration: 2s, fps: 24, width: 1920px, height: 1080px, sampleRate: 48khz) {
  scene answer(duration: 2s) {
    Rect(width: 1920px, height: 1080px, fill: #f5efe6);
    Tone(frequency: 440hz, duration: 2s, amplitude: 10%);
  }
}
```

The public signature is:

`NestedSequence(source: Timeline, range?: Range<Time>) -> AVNode`

The source remains separately owned and is not cloned into the parent IR.
Picture is evaluated against the source timeline's original scene/frame clock,
so animation does not restart at the selected range start. Audio evaluates the
complete ordered source root-mix graph, advances its causal state from sample
zero through the selected range end, and applies the exact selected sample trim
at the final preparation boundary before parent placement. Stateful processors
therefore retain their real pre-range history without retaining a discarded
prefix or suffix in the temporary raw stereo f32le artifact. A source picture-only change
invalidates dependent parent frames but preserves the parent audio artifact
key; a source audio-only change does the inverse. The complete source still
participates in semantic/build identity. A source `Meter` remains transparent
in this pre-master projection: its mastering target is not recursively applied,
and the parent delivery owns downstream normalization/mastering.

The bounded contract requires a positive half-open range inside the source (or
omission for the complete source), equal canvas/FPS/sample rate, source range
endpoints on both source frame and sample grids, contiguous source scenes
covering the source duration, exact parent frame and sample placement, a
childless call, and no timeline-level picture or AV roots. Timeline-level audio
remains legal. Mixed `Precomp`/
`NestedSequence` recursion shares the 16-level, 1,024-instance and
1,000,000-frame limits, and every recursively reached source composition obeys
the ordinary 7,200-second runtime cap. Audiovisual preparation additionally
allows at most 2,000,000,000 exact causal-history samples and 4,294,967,192
aggregate selected raw stereo f32le bytes. The byte ceiling is the complete
8-byte-frame floor beneath one ordinary non-RF64 WAVE payload. Equal source-plus-range
selections in one composition share one preparation and one budget charge. Foreign timeline
roots, cycles, and malformed/tampered graphs fail through the source-located
`CUT_NESTED_*` family before recursive preparation.

A `Precomp` or `NestedSequence` source timeline containing `MatchSubject` or
`MatchTransition` declarations is currently refused with source-located
`CUT_MATCH_NESTING`. Semantic-match windows are composition-absolute and their
same-invocation frame receipts belong to one scene renderer; reusing them
inside an instance requires an explicit instance-clock and evidence-ownership
contract. CUT does not drop the declarations or silently render an unmatched
hard cut.

OTIO export reports `CUT_OTIO_NESTED_SEQUENCE_UNSUPPORTED` and omits the
instance. The current subset will not silently flatten a separately owned
timeline into duplicated clips and pretend the result is lossless. This is
separate from the optional V4 authority for static picture-only `Precomp`
placements described below; V4 does not make `NestedSequence` executable in
generic OTIO or an external NLE.

`tests/reference-nested-sequence.test.ts` plus the ranged picture/audio suites prove public typing/lowering,
source ownership, exact frame and sample placement, rendered pixels, byte-
exact nested raw stereo f32le selection, causal processor state, selected-audio/history
budgets with exact preparation deduplication, picture/audio cache locality,
format/timing/shape/cycle and hostile loaded-IR ownership refusals, and
structured OTIO loss.

## Explicitly not claimed

`NestedSequence.range` remains one 1:1 selection shared by picture and the
evaluated pre-master root mix; it is not a retime, loop, hold, independent
picture/audio offset, exposed nested bus/stem selection, or cross-canvas/aspect
adaptation. It cannot yet be a direct PictureTrack or AudioTrack operation
operand.

Picture-only `Precomp`, however, may be a direct `PictureTrack` item. Canonical
`TimelineEdit` split, trim, lift, extract, and ripple operations segment its
authenticated source range without flattening the source composition; static
transform/opacity presentation inputs remain authority-bound across those
structural slices. Bounded insert and overwrite may also copy exactly one
complete initial-plan source/range-only 1:1 item within its owning
`PictureTrack`. The typed source view records `structural-only` versus
`static-same-track-copy`; legacy omission is structural-only. The copied
placement retains exact composition/range authority and lineage; source
role/metadata are preserved, then explicitly authored placement metadata wins
on key collision. The source composition id, exact source/local intervals,
static instance controls, and parent plan identity remain explicit.

This insertion/overwrite form rejects linked items, a cross-track target,
partial or ambiguous source selection, transform/opacity inputs or properties,
effects, retime, and audiovisual `NestedSequence`. Nested slip,
boundary-handle adjustment and transitions remain fail-closed. The optional
`cut-otio-editorial-nested-placement-extension` V4 authority binds the
resulting visible lineage, native nested item identity, source
composition/range, placement policy, role, and metadata beside unchanged V2/V3
profiles. Generic OTIO import and external NLEs still cannot execute the nested
CUT graph and must retain typed loss.

Omitting `range` and spelling the exact complete range explicitly retain
distinct authored CutAVIR evidence but canonicalize to one executable meaning.
They share global build identity, semantic diff, picture-scene cache identity,
audio-cache identity, decoded picture, and PCM. A shifted or shortened range
remains a first-class semantic edit and invalidates only its affected domains.
