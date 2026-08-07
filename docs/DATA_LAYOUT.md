# Public keyed bar layout

Status: bounded executable CUT 0.4 alpha slice. This is reusable data-layout
infrastructure, not a full chart grammar and not a CUT 1.0 claim.

`@cut/data` exposes five pure compile-time functions:

```cut
keyedNumber(key: String, label: String, value: Number) -> KeyedNumber
markTarget(key: String, x: Length, y: Length) -> MarkTarget
barLayout(
  data: List<KeyedNumber>,
  x: Length, y: Length, width: Length, height: Length,
  min: Number, max: Number, gap: Ratio, padding: Length
) -> BarLayout
barTargets(layout: BarLayout, targets: List<MarkTarget>)
  -> List<BarMarkTransform>
formatNumber(value: Number, decimals: Number, suffix: String) -> String
```

They disappear during compilation. Their results are ordinary typed object,
list, quantity, and string IR values. There is no `cut.data.bar_layout` node,
private production graph, runtime data operation, or second renderer. Authors
compose the result with public primitives such as `Rect`, `Text`, masks, and
ordinary CUT animation.

## Morph keyed bars with ordinary visual IR

```cut
cut 0.4;
project "keyed movement";
import { Rect } from "cut:visual";
import { linear } from "@cut/motion";
import {
  keyedNumber, markTarget, barLayout, barTargets, formatNumber
} from "@cut/data";

const layout: BarLayout = barLayout(
  data: [
    keyedNumber("alpha", "Alpha", 3),
    keyedNumber("beta", "Beta", 7),
    keyedNumber("gamma", "Gamma", 5)
  ],
  x: 160px, y: 90px, width: 240px, height: 120px,
  min: 0, max: 10, gap: 20%, padding: 10px
);

const moves: List<BarMarkTransform> = barTargets(layout, [
  // Target order is irrelevant. Output order remains layout order.
  markTarget("gamma", 250px, 65px),
  markTarget("alpha", 80px, 65px),
  markTarget("beta", 170px, 65px)
]);

timeline main(duration: 1s, fps: 30, width: 320px, height: 180px) {
  scene bars(duration: 1s) {
    assert formatNumber(201 / 200, 2, "%") == "1.01%";
    for move in moves {
      Rect(
        width: move.width,
        height: move.height,
        x: move.x,
        y: move.y,
        fill: #e63946
      ) as bar;

      // Rect x/y are the source centre. Mutable .x/.y are retained offsets,
      // so an absolute target is expressed as target minus source.
      animate bar.x from 0px to move.targetX - move.x over 800ms ease linear;
      animate bar.y from 0px to move.targetY - move.y over 800ms ease linear;
    }
  }
}

export out = render(main);
```

`BarLayout.id` is the lowercase SHA-256 identity of the canonical retained
data, frame, plot, domain, gap, and derived marks. `BarLayout.marks` is a
`List<BarMark>`. Each mark exposes:

| Field | Type | Meaning |
| --- | --- | --- |
| `key`, `label` | `String` | Stable join key and authored display label. |
| `value`, `index` | `Number` | Exact value and source-order integer index. |
| `x`, `y` | `Length` | Exact source centre. |
| `width`, `height` | `Length` | Exact source size. |
| `left`, `top`, `right`, `bottom` | `Length` | Exact source bounds. |
| `baselineY` | `Length` | Exact numeric-baseline canvas coordinate. |

`BarMarkTransform` exposes every `BarMark` field plus absolute `targetX` and
`targetY`. `barTargets` requires exactly one unique known target per mark,
rejects an all-stationary target set, ignores authored target order, and emits
source-order records. Reordering targets therefore cannot perturb graph
identity.

## Exact geometry

The frame is centred at `(x, y)`. Equal `padding` produces the plot rectangle.
The explicit increasing `[min, max]` domain must contain every value. The
baseline is zero when zero lies inside that domain; otherwise it is the nearest
domain edge. Slots divide plot width exactly, and `gap` removes the declared
ratio from every slot without floating-point layout math.

A value exactly on the baseline intentionally produces `height == 0px` and
`top == bottom == baselineY`. CUT does not fabricate a one-pixel data mark.
Such a mark remains in the keyed collection for labels, joins, inspection, and
semantic diff, but passing its zero height directly to `Rect` is invalid. An
author who wants a visible zero indicator must author that indicator as a
separate truthful graphic.

## Bounds and diagnostics

- 1 through 512 data items; keys are unique, 1 through 128 safe ASCII
  characters, and labels are bounded well-formed display text without control
  characters;
- values and explicit domain endpoints remain within `+/-1000000000000`;
- frame dimensions are positive and at most `65536px`; frame edges and targets
  remain within `+/-65536px`;
- padding must leave a positive plot; gap is at least `0%` and below `95%`;
- derived bars narrower than exactly `0.5px` fail instead of being clamped;
- exact rationals have a 256-digit numerator/denominator budget;
- `formatNumber` accepts 0 through 6 decimals, a printable ASCII suffix of at
  most 16 bytes, and uses locale-independent round-half-away-from-zero.

Stable diagnostic families are `CUT_DATA_KEY_*`, `CUT_BAR_LAYOUT_*`,
`CUT_BAR_TARGET_*`, and `CUT_DATA_FORMAT_*`. Compiler diagnostics point to the
nested authored key, value, target, or formatting argument when it is present
as a literal expression. Loaded layout objects are re-derived and compared
field by field; changing retained data, derived geometry, or the digest cannot
forge a valid layout.

## Evidence and limits

`tests/data-bar-layout-core.test.ts` proves exact rational derivation, hostile
revalidation, limits, keyed joins, and formatting. `tests/data-bar-layout-language.test.ts`
proves public parsing/checking/lowering, nominal members, ordinary `Rect`
animation with distinct start/mid/end pixels, stable nested diagnostics, no
surviving helper call/private operation, formatting/comment semantic stability,
semantic diff, and scene-local cache invalidation.

This slice provides one-dimensional keyed bars, one explicit linear numeric
domain, fixed equal slots, and centre-point target joins. It does not provide
ticks, axes, label placement, legends, multiple/stacked series, missing values,
date/log/category scales, collision handling, responsive reflow, arbitrary
mark shapes, general data joins, or chart accessibility metadata. The existing
`Chart` runtime component remains a separate bounded convenience primitive.
