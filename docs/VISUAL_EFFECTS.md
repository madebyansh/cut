# Bounded visual effects

Status: executable reference-runtime contract for CUT 0.4 alpha. This is not a
custom-kernel ABI, GPU promise, or claim of a complete professional effects
library.

This page specifies the seven spatial/pixel effects: `Blur`, `Shadow`, `Glow`,
`Vignette`, `Sharpen`, `Grain`, and `Duotone`. They are closed unary components
from `cut:visual`. Each accepts exactly one visual
child and returns the same full-canvas dimensions. Nesting is deterministic:
the innermost component executes first. All controls in this slice are static
constructor inputs; `set` or `animate` on them is rejected rather than ignored.
The eighth unary effect, exact-time temporal `MotionBlur`, has its own schedule,
work and boundary contract in [`MOTION_BLUR.md`](MOTION_BLUR.md).

## Blur alpha boundary

`Blur(radius:)` converts CUT's straight 8-bit encoded-sRGB surface to one
associated 16-bit RGBA intermediate before the bounded libvips Gaussian. The
native kernel keeps color and coverage coupled and returns unassociated rgb16;
CUT then quantizes the result once to its public straight 8-bit boundary.
This avoids both a second unpremultiplication and independent 8-bit
numerator/coverage rounding, either of which can turn neutral translucent
edges black or white. A result whose alpha quantizes to zero has zero hidden
RGB. `radius: 0px` remains exact byte identity.

## Sharpen

`Sharpen(radius: Length = 1px, amount: Ratio = 100%)` executes a bounded
encoded-sRGB unsharp mask. `radius` is `0px` for byte identity or a Gaussian
sigma from `0.3px` through `16px`; `amount` is `0%` through `100%`. The CPU
kernel uses the same associated rgb16 Gaussian, recovers the unassociated
neighborhood color, and changes only the source RGB. Source alpha is copied
byte-for-byte. Pixels with zero alpha keep their hidden RGB, so a transparent
colored neighbor cannot create an opaque color fringe. If filtered coverage
falls below one 16-bit alpha code, that source pixel is left unchanged rather
than deriving contrast from an undefined division. This is a practical static
unsharp mask, not deconvolution, local-contrast recovery, or a
frequency-selective detail tool.

## Grain

`Grain(amount: Ratio = 8%, size: Length = 1px, seed: Number = 0, mode: String
= "static", monochrome: Boolean = true)` adds deterministic encoded-sRGB noise.

- `amount` is `0%` through `100%`; at `100%` the signed excursion is at most 64
  8-bit code values per affected channel before clipping.
- `size` is an exact integer from `1px` through `64px`. One noise sample covers
  each canvas-origin-anchored `size` by `size` cell; there is no interpolation.
- `seed` is an exact unsigned 32-bit integer.
- `static` always uses phase zero. `temporal` uses the exact nonnegative output
  frame index as its phase, so seeking directly to a frame yields the same
  bytes as sequential playback. Frame zero deliberately equals static phase
  zero.
- `monochrome: true` uses one signed sample for RGB. `false` derives a separate
  channel sample.

The field is generated only with fixed 32-bit integer multiplication, xor and
shift mixing; it never reads ambient entropy or calls `Math.random`. Seed,
mode, size, amount, monochrome choice, frame index, canvas coordinates and
implementation identity are sufficient to reproduce it. Source alpha is
unchanged and zero-alpha hidden RGB is untouched. This is canvas-space digital
grain, not scanned film-stock simulation, luminance-dependent grain,
motion-compensated grain or a promise of perceptual spectral matching.

## Duotone

`Duotone(shadows: Color = #000000, highlights: Color = #ffffff, amount: Ratio
= 100%)` maps source luminance between two opaque endpoint colors. Source RGB
and both endpoint colors are decoded to linear-light sRGB. Luminance is
`0.2126 R + 0.7152 G + 0.0722 B`; the two endpoint vectors are interpolated by
that luminance, then mixed with source linear RGB by `amount` and encoded back
to sRGB. At `100%`, encoded black maps exactly to `shadows` and encoded white
maps exactly to `highlights`; at `0%` the operation is byte identity. Endpoint
colors must be opaque six-digit literals because the operation preserves
source alpha exactly. Zero-alpha hidden RGB is untouched.

## Bounds, identity, and diagnostics

Every effect validates its child shape and complete static configuration during
reference-session validation, before a scene-cache lookup or native frame work.
The reference boundary accepts positive integer RGBA dimensions up to
16,777,216 pixels and requires straight-alpha byte surfaces. Public named inputs
are closed in the package manifest and kernel registry. Effect inputs and
ordered children participate in node/build/cache identity; the implementation
source and installed Sharp/libvips versions participate in package/backend
identity.

Loaded-IR and direct-kernel refusal uses stable `CUT_VISUAL_EFFECT_SHAPE`,
`CUT_VISUAL_EFFECT_INPUT`, `CUT_VISUAL_EFFECT_RANGE`,
`CUT_VISUAL_EFFECT_COLOR`, `CUT_VISUAL_EFFECT_FRAME`, and
`CUT_VISUAL_EFFECT_SURFACE` codes. Source-backed configuration errors include
the node ID and module/line/column location.

The compositor remains CPU-bound and full-canvas. These effects have no local
retained bounds, parameter animation, GPU implementation or custom shader ABI.
Blur and Sharpen inherit the locked native backend identity but do not claim
byte-identical results across different libvips builds. The rgb16 Gaussian is
an alpha-precision intermediate, not a scene-linear color pipeline. Grain and
Duotone use the declared 8-bit reference boundary; CUT still lacks one
end-to-end managed float/scene-linear effects pipeline.
