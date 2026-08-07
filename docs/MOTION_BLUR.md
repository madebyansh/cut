# Motion blur

Status: executable, bounded reference-runtime slice for CUT 0.4 alpha. This is
temporal supersampling of one retained visual subtree. It is not optical flow,
motion-vector reconstruction, frame interpolation, or a complete camera model.

## Public source contract

`MotionBlur` is a closed unary component from `cut:visual`:

```cut
import { MotionBlur, Rect } from "cut:visual";

MotionBlur(shutterAngle: 180deg, samples: 8, startEdge: "hold") {
  Rect(width: 160px, height: 80px, fill: #ef233c) as card;
  animate card.x from -240px to 240px over 1s ease outCubic;
}
```

The signature is:

```text
MotionBlur(
  shutterAngle: Angle,
  samples: Number,
  startEdge?: "hold"
) { exactly one Visual }
```

The first two arguments are required; all three are static. `shutterAngle` must be greater than
`0deg` and at most `360deg`. `samples` must be an exact integer from 2 through
32. A zero shutter or one sample is rejected as a semantic no-op. Unknown
arguments, children other than exactly one visual node, and `set`/`animate` on
MotionBlur controls fail with source-located diagnostics. Omission of
`startEdge` is the canonical transparent-boundary spelling. An explicit
`startEdge: "transparent"` parses and type-checks only so semantic preflight can
return the stable `CUT_MOTION_BLUR_NOOP` diagnostic; it is never accepted as a
second spelling of the default.

## Exact shutter schedule

For output time `T`, output-frame duration `F`, shutter angle `A` in degrees,
and sample count `N`, CUT defines exposure duration `E = F * A / 360`. The
shutter is centered on `T`. Uniform midpoint sample `i`, for `0 <= i < N`, is:

```text
t_i = T - E/2 + E * (2i + 1) / (2N)
weight_i = 1/N
```

All schedule values remain reduced exact rationals. The child is evaluated at
each `t_i`, so ordinary signals, transforms, effects, visibility, and retained
node intervals observe the exact shutter time. Per-frame stochastic effects
such as temporal `Grain` continue to use the one output-frame index: shutter
sampling does not silently reseed them. Discrete `Video` and `PictureClip`
children select `floor(t_i * fps)` with exact rational arithmetic. Samples are
evaluated in chronological order because those nodes own one forward-only
decoder; CUT never races multiple reads from one shutter through that shared
decoder. Two nested shutters do not in general produce one globally monotonic
depth-first schedule, however. A `Video`, linked `Clip`, or `PictureClip`
beneath two or more `MotionBlur` ancestors is therefore refused during graph
preflight rather than risking a decoder race, an implicit seek, or altered
sample times.

CUT does not clamp a sample to the child interval by default. If the child is
inactive at an exact sample time, that sample is transparent. An authored
`startEdge: "hold"` changes only a reachable start boundary: when nominal output
time `T` is inside the direct child's half-open interval `[C0, C1)`, each shutter
sample before `C0` evaluates that direct child at exactly `C0`. Descendants keep
their own intervals, so a delayed descendant is not invented. Samples at or
after `C1` remain transparent. There is intentionally no symmetric `edge` or
`endEdge`: `[C0, C1)` has an exact first instant but no exact final instant, and
CUT will not invent an epsilon, media handle, or previous-frame convention.

The compiler proves a meaningful hold analytically. Static configuration and
boundary preflight currently run for every authored MotionBlur node associated
with a composition, not only nodes reachable from one selected output. Because
the centered shutter is at most one frame wide, only the first output-grid
instant jointly owned by wrapper and child can cross the start. If no exact sample does,
authored `hold` fails with `CUT_MOTION_BLUR_NOOP`. The resolved policy, exact
intervals, first reachable sample count, algorithm-versioned semantic identity,
and one exact shutter-to-source mapping are emitted by `cut inspect --json`.

## Alpha and color math

Each rendered child sample enters the accumulator as an RGBA surface. CUT
decodes RGB to linear-light sRGB, multiplies it by coverage, uniformly sums the
premultiplied linear values, then returns straight-alpha 8-bit RGBA. A fully
transparent sample cannot tint the result, and output pixels with zero alpha
have zero hidden RGB. The direct kernel can also return an explicitly requested
conventional encoded-sRGB premultiplied boundary.

This is a defined SDR reference calculation, not a claim that the complete CUT
pipeline is already scene-linear or color-managed. Floating-point transfer
math has byte goldens for the tested toolchain; CUT does not promise portable
byte identity across every CPU, Node, Sharp/libvips, or future backend.

## Work bounds and composition boundaries

Motion blur is full-canvas CPU work in the reference backend. Validation runs
before frame allocation or rendering and currently enforces:

- at most 32 samples and 8,294,400 pixels per direct accumulation;
- at most 33,177,600 direct pixel-samples per node evaluation;
- at most 32 MotionBlur nodes and 67,108,864 conservatively charged temporal
  pixel-samples per composition;
- at most 64 nested temporal sample amplification along one child path.

The compiler and loaded-IR session preflight validate static configuration and
exact start-boundary meaning for every authored MotionBlur node before a
renderer constructs any shutter surfaces. Direct canvas/sample work and
aggregate composition work are then charged over the executable reachable
graph.
The documented inclusive boundary is executable: 3,840 x 2,160 pixels with
four samples is exactly 33,177,600 pixel-samples and is accepted; either
dimension/sample work above the corresponding limit is refused first.

Nested work is charged as executed, not merely as the sum of authored sample
counts. A MotionBlur node with `N` samples costs `N * (1 + childCost)`
full-canvas accumulation units; grouping sums child costs. Shared DAG
descendants may be charged more than once so safety does not depend on cache
scheduling. For example, nested 4-by-4 sampling costs 20 canvas units, not 8.

Nested temporal sampling remains executable for generated/vector/retained
content whose evaluation is random-access. It is currently refused when the
nested subtree reaches a forward-only decoded-media node. This is a stable
`CUT_MOTION_BLUR_PLAN` limitation, not a hidden fallback to one shutter. A
future implementation may lift it only with a bounded deterministic decoded-
frame seek/cache contract that preserves the same exact schedule.

The alpha does not allow a MotionBlur subtree to cross a `Precomp` or
`NestedSequence` boundary. Correct cross-composition blur needs subframe source
clocks, recursive temporal-work accounting, and a defined media policy. Such a
graph fails with `CUT_MOTION_BLUR_PLAN`. A MotionBlur authored *inside* a source
composition is supported: it is preflighted and rendered on that source's own
canvas and clock before an ordinary Precomp/NestedSequence instance uses it.

## Identity, diagnostics, and limitations

The exact shutter angle, sample count, meaningful resolved start-edge policy, ordered child graph, implementation
closure, and output-frame context participate in semantic/render identity.
Changing only MotionBlur controls invalidates the wrapper and its ancestors;
an unchanged child remains independently reusable in the semantic incremental
graph plan. CUT 0.4 does not yet provide a separate cold/warm on-disk visual
subgraph-cache trace, so this is not an on-disk cache-performance claim.

Stable refusal codes are:

- `CUT_MOTION_BLUR_CONFIG` for closed-shape, type, integer, and angle failures;
- `CUT_MOTION_BLUR_NOOP` for zero shutter, fewer than two samples, a redundant
  authored transparent default, or an authored hold that reaches no exact
  pre-start sample;
- `CUT_MOTION_BLUR_BUDGET` for rational, sample, canvas, nested, or aggregate
  work limits;
- `CUT_MOTION_BLUR_RATIONAL` for noncanonical exact-time data;
- `CUT_MOTION_BLUR_PLAN` for altered schedules, cycles, unsupported nested
  forward-only media, and unsupported composition-boundary sampling;
- `CUT_MOTION_BLUR_SURFACE` for malformed or incompatible RGBA samples.

Loaded-IR errors retain node ID plus module/line/column and bound hostile names
before JSON diagnostics are emitted. Only failures from MotionBlur's own
schedule or accumulator receive a `CUT_MOTION_BLUR_*` wrapper location. An
error raised while rendering its child retains the child's original error
object, code and source instead of being relabelled as a shutter configuration
failure.

This slice has no rolling shutter, asymmetric or weighted shutter curve,
per-sample camera exposure model, motion-vector/optical-flow blur, occlusion
reconstruction, frame synthesis, or media interpolation. Discrete decoded
video remains discrete: temporal samples can select different source frames,
but CUT does not synthesize subframes between them. The reference backend also
has no local retained effect bounds or GPU implementation.

Executable evidence lives in
`tests/reference-motion-blur-core.test.ts` and
`tests/reference-motion-blur.test.ts`,
`tests/reference-motion-blur-boundary.test.ts`, and the two additive study
fixtures named below. They cover exact schedules, alpha and
linear-light math, deterministic bytes, hostile plans/surfaces/IR, dynamic
pixels distinct from both a sharp frame and a collapsed first sample, fixed
temporal-Grain seed, transparent boundaries, source-composition preflight,
exact-bound work refusal, localized cache identity, repeated fresh locked-video
renders, a locked 2x `PictureClip` repeatability/mapping proof, tiny shutters
whose samples select the discrete frames on opposite sides of an exact frame
boundary, and early refusal of the formerly non-monotonic nested-media graph.
The additive `four-planes-of-place` v5 and unrelated bright 1:1 product/type
sting prove the public input in different source graphs. Their engineering
artifacts do not claim professional creative quality; complete human full-speed
and headphone review remains recorded separately and cannot be replaced by
hashes, selected frames, or inspect output. Their frozen locks are historical
active-alpha evidence, not locks that are silently refreshed whenever a shared
package changes. The regression suite hash-audits the immutable directories,
expects those historical locks to reject the current package identity, then
copies public source/assets into temporary projects and proves the current
runtime with ephemeral current locks against the frozen RGBA/pixel invariants.
Canonical current locks and renders will be frozen as a new additive iteration
only at a quiescent release-candidate closure.
