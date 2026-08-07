# Masks, mattes, and polygon clipping (0.4 alpha)

`Mask` is a closed, deterministic, two-child visual kernel. The first child is
the target and the second is the full-canvas matte. Every accepted control is
executed by the CPU reference compositor:

```cut
Mask(
  mode: "luminance",
  expand: 2px,
  feather: 3px,
  invert: false,
) {
  // target visual
  // matte visual
}
```

The signature is `Mask(mode?: String = "alpha", invert?: Boolean = false,
feather?: Length = 0px, expand?: Length = 0px)`. The ordinary visual transform
inputs `x`, `y`, `scale`, `rotation`, and `opacity` apply to the completed mask
result. The kernel requires exactly two source-ordered visual children. An
unknown input/property, unknown mode, wrong type, or ambiguous child graph is a
source/runtime error rather than accepted metadata.

## Coverage selection

`mode` is exactly one of:

- `alpha`: the matte alpha channel;
- `luminance`: linear-light Rec. 709 luminance of straight matte RGB,
  associated with matte alpha;
- `red`, `green`, or `blue`: the selected straight, linear-light RGB channel,
  associated with matte alpha.

For a premultiplied matte, encoded RGB is safely unpremultiplied before
linearization. Color-derived modes return zero whenever matte alpha is zero,
so hidden RGB cannot reveal target pixels or bleed into a feather. CUT does not
interpret arbitrary auxiliary channels, files, or layer names.

## Fixed operation order and edges

The executable order is:

1. select coverage from the matte;
2. apply signed `expand`;
3. apply `feather`;
4. apply `invert` when true;
5. multiply target alpha by the resulting coverage;
6. apply the enclosing Mask node's authored transform/opacity.

`expand` is an exact integer from `-64px` through `64px`. Positive values
dilate with a square neighborhood; negative values erode with the same
neighborhood. Coverage beyond the canvas is exactly zero. This makes edge
erosion explicit and prevents a backend-specific extend mode from entering the
language semantics.

`feather` is an exact integer from `0px` through `64px`. The CPU implementation
uses a normalized, separable, finite-support tent filter: normalized box radii
`floor(r / 2)` and `ceil(r / 2)` are convolved horizontally and vertically.
Coverage outside the canvas is zero. The algorithm is linear in canvas pixels,
bounded to 16,777,216 pixels, and does not delegate mask edges to a native image
library. It is deterministic on the JavaScript reference backend; CUT does not
claim cross-native/GPU bit identity yet.

## Alpha boundary

Mask math uses scalar coverage. The public result is always straight-alpha
RGBA. A premultiplied target is safely unpremultiplied at the boundary. Target
RGB remains unassociated while output alpha is non-zero; when output alpha is
zero, RGB is also zero. This avoids hidden-RGB leakage and double
premultiplication. The operation does not change the canvas size.

Nesting is semantic and executes inner-to-outer. A Mask inside `Composite`
changes source coverage before source-over; a `Composite` inside Mask is first
flattened and then masked. Argument order does not reorder coverage operations.

## Diagnostics and cache identity

Stable runtime/loaded-IR errors are source located:

- `CUT_MASK_GRAPH`: invalid domain or target/matte graph;
- `CUT_MASK_INPUT_TYPE`: wrong or unknown executable input/property;
- `CUT_MASK_MODE`: unsupported coverage selector;
- `CUT_MASK_VALUE_RANGE`: fractional or out-of-range expansion/feather;
- `CUT_MASK_RESOURCE_LIMIT`: unsafe canvas work.

Child identities, every Mask input, and the mask/compositor implementation
fingerprint participate in semantic/cache identity. Editing `expand`,
`feather`, `invert`, or `mode` invalidates the Mask and its containing picture
scene while unchanged children remain reusable.

Executable proof is in `tests/reference-mask.test.ts`: public typing and IR,
exact positive/negative morphology, feather and inversion pixels, alpha/luma/RGB
selection, premultiplied and hidden-RGB boundaries, language-to-frame pixels,
authored nesting, hostile loaded IR, stable JSON diagnostics, deterministic
replay, and localized cache invalidation.

## Closed polygon clipping

`ClipPath` is a separate unary visual kernel for composition-space polygon
clipping. It accepts exactly one visual child:

```cut
ClipPath(
  points: [
    { x: 120px, y: 80px },
    { x: 940px, y: 120px },
    { x: 820px, y: 920px },
    { x: 180px, y: 840px },
  ],
  fillRule: "nonzero",
  invert: false,
) {
  // arbitrary child visual
}
```

The signature is `ClipPath(points: List<Vec2>, fillRule?: String =
"nonzero", invert?: Boolean = false)`. `fillRule` is exactly `"nonzero"` or
`"evenodd"`. Points are exact pixel `Length` values in the composition
coordinate system. The final edge closes implicitly from the last point to the
first; repeating the first point at the end is rejected. There must be 3...512
points, every coordinate must remain within ±65,536px, adjacent points must be
distinct, and the polygon must have a non-collinear two-dimensional interior.
Self-intersection and repeated non-adjacent vertices are intentional and are
resolved by the selected fill rule.

The child executes first, including its own transforms and effects. CUT then
clips that full-canvas result. `ClipPath` has no transform/property arguments;
wrap it in `Group` to transform the completed clipped result. This distinction
keeps path coordinates stable and prevents a nominal path transform from
silently moving the child as well.

Coverage is CUT-owned, not delegated to SVG/libvips. The CPU reference backend
uses a fixed 4x4 pixel-center grid, a half-open edge rule on Y, and left-closed,
right-open filled spans. Coverage therefore has exactly 17 possible values
from 0/16 through 16/16. `invert` complements this scalar coverage before
multiplying child alpha. Premultiplied child bytes are safely unassociated;
the output boundary is always straight alpha, and RGB is zero when output alpha
is zero. A polygon/invert combination that leaves every canvas pixel at full
child coverage is rejected as `CUT_CLIP_PATH_NOOP`, rather than counting an
identity wrapper as execution.

Resource validation happens before the coverage allocation. The canvas limit
is 16,777,216 pixels. For `p = pointCount`, the conservative scan budget is
`width * height + height * 4 * (2 * width + 1 + p * (p - 1) + 4 * p)` and must
not exceed 268,435,456 units. This exactly upper-bounds coverage initialization,
the per-sub-row difference reset and width scan, edge scan, deterministic
insertion-order comparisons/shifts, remaining crossing/span passes, and the
in-loop identity check. CUT deliberately does not rely on a native sort
complexity promise. Before any plane allocation, a composition also refuses
more than 128 ClipPath nodes, more than 67,108,864 aggregate coverage bytes,
or more than 1,073,741,824 aggregate scan-work units. These limits are not a
real-time-performance claim.

Stable loaded-IR/runtime codes are `CUT_CLIP_PATH_GRAPH`,
`CUT_CLIP_PATH_INPUT_TYPE`, `CUT_CLIP_PATH_FILL_RULE`,
`CUT_CLIP_PATH_VALUE_RANGE`, `CUT_CLIP_PATH_DEGENERATE`,
`CUT_CLIP_PATH_NOOP`, and `CUT_CLIP_PATH_RESOURCE_LIMIT`. Unknown controls are
bounded before they enter diagnostic text. Points, fill rule, inversion,
children, and implementation closure all participate in semantic/cache
identity, so a path edit invalidates the clip node and containing scene while
an unchanged child remains reusable.

Executable proof is in `tests/reference-clip-path.test.ts`: public syntax and
IR, exact square/antialias/fill-rule/inversion pixels, premultiplication and
hidden-RGB safety, nesting order, deterministic replay, degenerate/no-op/work
refusal, bounded hostile diagnostics, and localized cache invalidation.

## Honest limitation

This slice implements full-canvas raster mattes and static closed polygon
clipping. It does not implement cubic/Bezier segments, multiple independent
subpaths/holes other than fill-rule-resolved polygon winding, manual or tracked
rotoscoping, temporal tracking, point animation, path feather/expansion,
arbitrary channel expressions, or depth/vector mattes. `Mask(clipPath:)` and
unknown `ClipPath` controls are refused instead of inferred. Those capabilities
remain separate work, so VIS-02 stays PARTIAL.
