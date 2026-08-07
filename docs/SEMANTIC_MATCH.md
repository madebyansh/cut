# Semantic match transition (V1 contract)

Status: executable bounded 0.4-alpha engineering slice. The public
declarations, closed typed IR, retained renderer, inspect/diff/cache identity,
frame receipts, nesting refusal and structured OTIO loss all execute. Two
unrelated asset-free fixtures pass exact-frame proof plus complete cold/warm
delivery with identical MP4 hashes through the same public runtime. Neither
fixture has passed a human full-speed viewing, headphone listening or
independent creative review, so this is not a creative or 1.0 claim.

`MatchTransition` is a visual-only transition across one existing hard cut. It
lets two differently authored retained subjects meet at one explicit delivery-
space pose. CUT does not infer semantic correspondence, inspect project names,
recognize fixture assets or ask a model what should match.

## Public source

```cut
import { Camera2D, Circle, LocalSpace } from "cut:visual";
import { MatchSubject, MatchTransition } from "@cut/edit";
import { inOutCubic } from "@cut/motion";

timeline main(duration: 6s, fps: 24, width: 640px, height: 360px) {
  scene outgoing(duration: 3s) {
    Camera2D(x: -170px, y: 24px, scale: 0.8, rotation: -8deg) as dial {
      LocalSpace(width: 240px, height: 240px,
                 origin: { x: 120px, y: 120px }) {
        Circle(radius: 72px, x: 0px, y: 0px, fill: #e8a33f);
      }
    }
    MatchSubject(id: "dial", subject: dial);
  }

  scene incoming(duration: 3s) {
    Camera2D(x: 180px, y: -18px, scale: 1.15, rotation: 12deg) as hub {
      LocalSpace(width: 240px, height: 240px,
                 origin: { x: 120px, y: 120px }) {
        Circle(radius: 72px, x: 0px, y: 0px, fill: #63d6ce);
      }
    }
    MatchSubject(id: "hub", subject: hub);
  }

  MatchTransition(
    id: "dial-to-hub",
    at: 3s,
    duration: 1s,
    outgoing: "dial",
    incoming: "hub",
    x: 0px,
    y: 0px,
    scale: 1,
    rotation: 0deg,
    color: #f0b04a,
    easing: inOutCubic,
    velocity: "carry"
  );
}
```

The closed declarations are:

```text
MatchSubject(id: String, subject: Visual) -> EditorialTransaction

MatchTransition(
  id: String,
  at: Time,
  duration: Time,
  outgoing: String,
  incoming: String,
  x: Length,
  y: Length,
  scale: Number,
  rotation: Angle,
  color?: Color,
  easing: Easing,
  velocity?: "settle" | "carry"
) -> EditorialTransaction
```

Both calls return the package ABI's `EditorialTransaction` nominal, but occupy
the narrower statement-only semantic-match declaration role. They do not
produce a value or render node. Neither accepts a child block, `as` binding, or
`let`/expression use. `MatchSubject` is valid only as a direct scene statement
after its subject binding. `MatchTransition` is valid only as a direct timeline
statement. It may appear anywhere in that direct timeline block; resolution is
deferred until every scene and subject declaration in the timeline has lowered.

## Retained subject boundary

One V1 subject is exactly:

```text
direct scene root Camera2D
  -> exactly one direct LocalSpace
    -> the supported bounded LocalSpace visual grammar
```

The `Camera2D` and its `LocalSpace` must both occupy the complete owning scene
interval. The camera body contains exactly the one `LocalSpace` node and no
direct automation or delivery-canvas siblings. Camera automation remains a
separate direct scene statement after the camera binding.

The transition consumes the existing retained camera placement order:

1. local registration;
2. uniform scale;
3. rotation;
4. delivery translation;
5. opacity.

The semantic match replaces only sampled `x`, `y`, `scale` and `rotation`
during its owned half-window. The LocalSpace content continues to evaluate at
the ordinary exact scene-local time. Camera opacity must be omitted or remain
exactly `100%` throughout the match window; opacity is not a V1 match channel.

The paired LocalSpaces must have exactly equal whole-pixel width and height and
the same exact origin. This gives both subjects one shared local registration
basis, so an authored target scale has the same geometric meaning on each side.
CUT does not infer visible alpha bounds, detect an object, or normalize two
unrelated raster silhouettes.

`Group`, ordinary delivery-canvas `Camera2D`, `MotionPath`, tracking owners,
MapCamera, ParallaxCamera, masks and precompositions are not MatchSubject
boundaries in V1. Other scene roots, including ordinary Camera2D backgrounds,
remain legal and retain their normal source-order paint position.

## Half-open ownership and scene rendering

Let the hard cut be `C`, the authored transition duration be `D`, and
`H = D / 2`.

- the outgoing scene owns `[C-H, C)`;
- the incoming scene owns `[C, C+H)`;
- outside those intervals the cameras use their ordinary authored placement;
- the incoming frame at exactly `C` owns the cut and is exactly at the target
  pose;
- the outgoing pose approaches the same target as `t` approaches `C` but there
  is no outgoing frame at the half-open cut.

`C` must be the exact boundary between two adjacent, contiguous scenes. `D`
must contain an even number of composition frames, at least four frames, and
both half-windows must fit inside their scenes. Semantic match is picture-only;
sample-grid alignment, audio crossfade, J/L behavior and sound design are not
implied.

Each half executes inside the normal scene renderer. The outgoing frames are
matched before the outgoing scene MP4 is encoded; the incoming frames are
matched before the incoming scene MP4 is encoded. The existing hard concat
then joins those two ordinary scene artifacts unchanged. A cross-scene
compositor, post-concat filter, frame replacement or hidden delivery fix is
forbidden.

## Pose interpolation

The target `x` and `y` use the same composition-centre-relative delivery
coordinates as retained Camera2D. `scale` is positive uniform scale. Rotation
is an unwrapped authored angle: CUT performs no implicit shortest-path choice.

For outgoing composition time `t`:

```text
u = (t - (C-H)) / H
w = E(u)
pose(t) = lerp(nativeOutgoingPose(t), targetPose, w)
```

For incoming composition time `t`:

```text
v = (t - C) / H
w = E(v)
pose(t) = lerp(targetPose, nativeIncomingPose(t), w)
```

V1 accepts only `linear`, `inCubic`, `outCubic` and `inOutCubic`. They execute
as exact rational polynomial easing at exact frame time before the existing
Q16 retained-placement boundary. Arbitrary cubic Bezier and spring easing fail
instead of silently changing the continuity guarantee.

The omitted `velocity` form claims C0 pose continuity only.

`velocity: "settle"` requires `inOutCubic`. Its zero endpoint slopes make both
sides reach the cut with zero translation, scale and rotation velocity.

`velocity: "carry"` also requires `inOutCubic`, and the authored Camera2D `x`
and `y` must be static throughout both half-windows. Translation uses exact
cubic Hermite curves. With outgoing start `P0`, target `T`, incoming end `P1`
and half-duration `H`:

```text
A = (T - P0) / H
B = (P1 - T) / H
V = (A + B) / 2
outgoing = Hermite(P0, T, derivative 0 -> V)
incoming = Hermite(T, P1, derivative V -> 0)
```

This gives one shared C1 translation velocity at the cut and zero velocity at
the two static outer joins. All reachable Hermite samples are preflighted for
overshoot, finite values and retained allocation limits. Authored position
automation is refused in carry mode; it is never accepted and ignored.

## Optional color channel

When `color` is omitted, CUT performs no color operation. When present, it must
be an opaque Color and both subjects converge on one deterministic target
chroma at the cut:

1. unassociated sRGB is converted through CUT's fixed linear-light transfer;
2. Rec.709 luminance is computed;
3. luminance shapes the authored target chroma;
4. native and target-tinted premultiplied linear values interpolate by the
   same outgoing `w` or incoming `1-w`;
5. alpha remains exact;
6. straight RGBA8 uses round-half-up, and zero alpha clears hidden RGB.

Zero tint amount is an exact byte-preserving bypass. This is palette continuity,
not shape morphing, object correspondence or pixel identity.

## Typed IR

CutAVIR v3 gains an optional `semanticMatches` object, omitted rather than
serialized empty:

```text
semanticMatches: {
  version: 1,
  subjects: [{
    id, version: 1, kind: "semantic-match-subject",
    compositionId, sceneId, authoredId,
    cameraNodeId, localSpaceNodeId,
    basis: { width, height, origin }, provenance
  }],
  transitions: [{
    id, version: 1, kind: "semantic-match-transition",
    compositionId, authoredId, cut, duration,
    outgoingWindow, incomingWindow,
    outgoing: { sceneId, subjectId, cameraNodeId, localSpaceNodeId },
    incoming: { sceneId, subjectId, cameraNodeId, localSpaceNodeId },
    target: { x, y, scale, rotation, color? },
    easing, velocity?, provenance
  }]
}
```

The compiler resolves identifiers, adjacent scenes, node IDs, basis and exact
windows. The strict loader and reference runtime rederive all of them. Match
records create dependency edges but never structural parent edges, so a match
cannot reparent a node or create a render-graph cycle.

## Diagnostics and limits

Stable V1 diagnostics are:

- `CUT_MATCH_SCOPE`: declaration in the wrong block, with children or `as`;
- `CUT_MATCH_ID`: malformed or duplicate authored ID;
- `CUT_MATCH_SUBJECT`: missing/forward/wrong node reference or incomplete
  scene interval;
- `CUT_MATCH_CAMERA`: subject is not the direct retained Camera2D boundary;
- `CUT_MATCH_CUT`: non-adjacent cut or invalid half-open/grid window;
- `CUT_MATCH_BASIS`: LocalSpace dimensions or origin disagree;
- `CUT_MATCH_TRANSFORM`: invalid target, opacity, sampled scale or allocation;
- `CUT_MATCH_EASING`: unsupported easing or continuity incompatibility;
- `CUT_MATCH_VELOCITY`: carry mode has position automation or unsafe velocity;
- `CUT_MATCH_CONFLICT`: one subject is ambiguously reused in overlapping
  windows;
- `CUT_MATCH_LIMIT`: count, frame or pixel-work bound exceeded;
- `CUT_MATCH_NOOP`: no transform channel differs on a reachable frame and no
  color operation exists;
- `CUT_MATCH_CONTRACT`: loaded IR disagrees with the rederived public contract;
- `CUT_MATCH_RENDER`: prepared plan and completed execution disagree;
- `CUT_MATCH_NESTING`: a timeline with semantic matches is used as a Precomp or
  NestedSequence source before that source-clock contract exists;
- `CUT_OTIO_SEMANTIC_MATCH_UNSUPPORTED`: structured interchange loss instead
  of a silently fabricated dissolve.

Source checking reports the offending argument span. Loaded-IR and runtime
diagnostics report the stored declaration or subject-node provenance.

Initial limits are 256 subjects and 128 transitions per composition, eight
distinct pairs at one cut, 600 output frames per transition and 16,777,216
actively tinted local pixels per frame. Target scale is in `(0, 64]`; position,
rotation and final transform work remain inside the existing Camera2D retained
allocation limits. A subject may enter at one cut and leave at another only
when its two owned windows are disjoint.

## Identity, cache, inspect and evidence

The global semantic/build identity includes the closed match records and the
owning `@cut/edit` integrity. Picture scene keys include only the execution
projection needed by that side:

- target, timing, easing or color changes invalidate both adjacent scenes;
- an outgoing tile-content edit invalidates only the outgoing scene;
- an incoming tile-content edit invalidates only the incoming scene;
- unrelated scenes and the audio cache remain reusable;
- carry mode includes both positional endpoints in both scene keys because its
  shared velocity depends on both.

The underlying LocalSpace tile identity remains content-and-time based.
Matched tint and final Camera2D placement have separate identities, preventing
target edits from pretending the retained tile itself changed.

`cut inspect` exposes the paired scenes/nodes, exact windows, local basis,
target, easing, velocity, derived carry velocity, limits and side-specific
cache dependencies. Semantic diff indexes subjects and transitions
independently; comments and formatting do not affect identity. There is no
public `cut graph` command in this alpha, so V1 makes no CLI graph-visualization
or dashed-edge evidence claim.

Every active rendered half emits a completed
`cut-reference-semantic-match-frame-evidence-v1` receipt with exact absolute
and scene-local time, side/window, native and applied pose, exact progress,
tint amount, carry velocity where applicable, tile/tint/placement/final RGBA
hashes, bounded work counters and execution identity. The receipt is additive
under frame-v2 `execution.semanticMatches`.

## Explicit nonclaims

V1 does not provide content-aware matching, optical flow, arbitrary shape
morphing, unequal local-basis normalization, camera-hierarchy inversion,
tracked or geographic subjects, mask/matte continuity, audio transition
semantics, Precomp/NestedSequence execution, 3D correspondence or automatic
taste. It provides a deterministic retained subject handoff that no longer
requires authors to copy low-level coordinates across adjacent scenes.

Asset-free implementation fixtures exercise the public contract but are not
creative-pass evidence. The executable chain is covered by
`tests/semantic-match-language.test.ts`,
`tests/semantic-match-ir-loader.test.ts`,
`tests/reference-semantic-match-v1.test.ts`, and
`tests/semantic-match-interchange-nesting.test.ts`. Full-speed playback,
headphone review and independent creative assessment remain separate release
gates.
