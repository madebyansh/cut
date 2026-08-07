# FlowText: shared layout and stable text-unit motion

`FlowText` is CUT's current public vertical slice for mixed-style text that
must wrap, shape and animate as one locked layout. Omitted `shaping` preserves
the implemented printable-ASCII path below. The opt-in `textShaping` record
executes the pinned feature-scoped HarfBuzz/bidi backend, ordered locked-font
fallback and shaped-cluster selectors described below. This remains a bounded
alpha contract, not a claim of full professional typography or cross-platform
typographic conformance.

```cut
import { FlowText, textSpan, textUnitMotion, textUnitPose } from "cut:visual";
import { outCubic } from "@cut/motion";

FlowText(
  spans: [
    textSpan(id: "lead", content: "THE SIGNAL "),
    textSpan(id: "answer", content: "ARRIVED", color: #ff684f, font: emphasisFace)
  ],
  font: face,
  size: 48px,
  color: #f4f0e8,
  motions: [
    textUnitMotion(
      span: "answer",
      by: "glyph",
      at: 400ms,
      each: 45ms,
      duration: 560ms,
      from: textUnitPose(y: 22px, opacity: 0%, scale: 0.7),
      before: "from",
      easing: outCubic
    )
  ],
  layoutX: 72px,
  baselineY: 160px,
  maxWidth: 620px,
  lineHeight: 54px,
  maxLines: 3
) as title;
animate title.x from 0px to 16px over 1s ease outCubic;
```

## Exact semantics

- `spans` concatenate in source order before tokenization and wrapping. Spaces
  and LF belong to that shared content; CUT does not insert whitespace.
- Every span has a unique stable `id`. Font, size, color, tracking and baseline
  shift inherit from `FlowText`; author only the overrides that differ. The
  optional `font` is the final public `textSpan` parameter so the established
  positional `(id, content, size, color, tracking, baselineShift)` ABI keeps
  exactly the same meaning. Prefer named `font:` authoring.
- `cut check` and `cut lint` reject a direct literal `textSpan(...)` override
  when its literal font, size, color, tracking or baseline shift exactly repeats
  the enclosing FlowText literal. Omitted FlowText tracking and baseline shift are
  statically known as `0px`, so explicitly repeating either zero is rejected
  with `CUT_FLOW_TEXT_INPUT_SHAPE`. Exact decimal spellings and opaque six/eight
  digit color spellings compare semantically, not as source strings.
- This source check is deliberately narrow. It does not evaluate identifiers,
  const references, arithmetic, helper functions or an indirect span list to
  guess equivalence, and it defers when a literal base is outside the runtime
  value range so the earlier `CUT_FLOW_TEXT_VALUE_RANGE` contract retains
  precedence. The unchanged runtime contract still validates fully lowered
  values and rejects a dynamically produced redundant override before font or
  pixel work.
- `layoutX` and `baselineY` place the intrinsic shaped layout. Constructor
  `x`/`y` and mutable `.x`/`.y` are the outer transform, so placement is not
  ambiguous.
- Unit selection is zero-based and scoped to the named span. `line` selects
  that span's glyphs on a resolved layout line; `word` selects its glyphs in a
  resolved word; `glyph` selects shaped glyphs, not Unicode code points.
- `start` defaults to `0`; omitted `count` means all remaining resolved units.
  `at` and `each` default to `0s`, omitted poses are identity, and omitted
  easing is linear. `duration`, `span` and `by` remain required. Identical
  endpoint poses fail as inert.
- `before: "from"` holds an entrance pose before delayed unit starts. It is
  refused when every selected unit starts at local `0s`, because then the
  choice could not execute. Explicit `before: "base"` is redundant and fails.
- Different selectors may not own the same shaped glyph. The exact same
  selector may repeat only as a non-overlapping pose-continuous sequence.
- Timing is exact rational time. Every selected unit must have an output frame
  strictly inside its motion interval so easing is observable. Typed linear,
  cubic and spring easings execute through the shared reference easing engine;
  unsafe overshoot in opacity, scale or coordinates fails at the exact sample.

## Shaping-omitted locked boundary

FlowText with `shaping` omitted accepts printable ASCII plus LF and a closed set of explicit
fixed-instance locked TTF/OTF faces. `FlowText.font` is the inherited base;
`textSpan(font:)` may select another declared `FontAsset`. Every selected face
must be locked and prepared by exact locator and SHA-256. CUT never queries a
host font, synthesizes a bold/italic face, or chooses a fallback. An absent,
forged, unlocked or byte-mismatched face fails with `CUT_FLOW_TEXT_RESOURCE`.

A face change is legal only at a whitespace boundary: the previous span must
end in space/LF or the next must begin with space/LF. Spaces advance in the
face of the span that owns the space. All faces share the one authored
`baselineY` and `lineHeight` grid; their locked outlines retain their own glyph
metrics. CUT does not silently shift baselines to compensate for a face.
Changing face inside one non-whitespace shaping run fails with
`CUT_FLOW_TEXT_SHAPING`. An explicit span face equal to the base face—or a
different FontAsset resolving to the same locked bytes—is redundant and fails.
The base face must remain used by at least one inherited span.

This shaping-omitted boundary has no bidi reordering, combining-mark shaping,
complex-script shaping, Unicode fallback or language-aware breaking claim.
Leading/trailing/repeated spaces and empty lines fail. A non-face style
boundary inside a non-whitespace run is accepted only when both spans resolve
to the same style and shaping proves that the boundary does not split a
contextual or ligature glyph. For example, kerning across equal-style `A` / `V`
spans is preserved; an `f` / `i` boundary that would bisect an `fi` ligature
fails.

## Additive complex-shaping language contract

The public type surface executes this opt-in record without changing an
omitted legacy `FlowText` node:

```cut
import {
  FlowText,
  textShaping,
  textSpan,
  textUnitMotion,
  textUnitPose
} from "cut:visual";

FlowText(
  spans: [textSpan(id: "title", content: "CUT 10")],
  font: primary,
  size: 48px,
  color: #ffffff,
  shaping: textShaping(
    paragraphDirection: "rtl",
    language: "ar",
    fallbackFonts: [arabic, devanagari]
  ),
  motions: [
    textUnitMotion(
      span: "title",
      by: "cluster",
      order: "visual",
      each: 40ms,
      duration: 400ms,
      from: textUnitPose(opacity: 0%),
      before: "from"
    )
  ]
);
```

- `paragraphDirection` is explicitly `ltr` or `rtl`; there is no implicit
  host- or content-derived direction.
- `language` is an authored String whose bounded BCP-47 validation belongs to
  the complex backend.
- `fallbackFonts` is the ordered list of declared `FontAsset` resources after
  the primary `FlowText.font`. It is not a request for system-font discovery.
- `by: "cluster"` selects backend-resolved shaped clusters rather than Unicode
  code points. Optional `order` is `logical` or `visual`; omission is logical.
  `cluster` and `order` are invalid without an executing `shaping` profile.
- The complex backend binds its shaper, bidi and segmentation policy plus
  exact shipped implementation bytes, locked font bytes and resolved cluster
  evidence into build/cache/inspect identity. Missing, stale or inconsistent
  authority fails before pixels rather than silently falling back to the
  legacy path.

Complex shaping does not widen CUT's historical global five-package reference
backend tuple. A shaped node carries a separate, closed feature authority for
the exact HarfBuzz glue/WASM and bidi implementation bytes. The same authority
directly binds fallback
`first-whole-token-capable-locked-face-v1`, wrap
`explicit-lf-or-ascii-space-whole-token-v1`, selector
`harfbuzz-cluster-atomic-logical-or-visual-v1`, normalization `none`, and
`hostFontFallback: false`. It propagates through IR, lock, graph and persistent
picture-cache identity, runtime revalidation, inspect, and optional shaped
frame/contact/render evidence. Omitting `shaping` omits that feature authority
and the feature-specific evidence field.

`schemas/cut-complex-text-evidence-feature-v1.schema.json` is the shipped
closed schema for that optional evidence feature block. It intentionally does
not claim to validate an entire contact, preview or render manifest; each
producer's existing manifest contract remains separately authoritative.

Because this is a new public built-in and runtime implementation in the current
alpha, the affected built-in package closure and current lock identity still
migrate. Preserved historical locks remain byte-unchanged and may reject at
the explicit recorded-package implementation boundary. Recompile and relock is
required; it must preserve established shaping-omitted FlowText pixels and
node-specific inspect semantics rather than pretending the old implementation
identity is current.

## Authoring and evidence loop

1. Run `cut check` for parser/type/kernel diagnostics.
2. Run `cut lock`; every base/span font's bytes, package closure and runtime
   identity enter the lock and build identity. A shaped graph additionally
   carries the exact feature-scoped complex-text authority; the historical
   global reference backend remains the same five-package tuple.
3. Run `cut inspect --json`. The report exposes base style, spans, stable
   selectors, every resolved face ID/locator/hash, common line metrics, exact
   timing, layout contract, shaping boundary and outer-motion convention. For
   shaped FlowText it also exposes the exact backend byte and fallback/wrap/
   selector/normalization policy authority.
   `cut diff` and scene cache identity change with content, face selection,
   locked face bytes, style, selector, timing or easing edits; comments and
   formatting do not.
4. Use `cut frame`, `cut contact` and full-speed preview. Shaped frame,
   contact and render receipts repeat the optional feature authority;
   shaping-omitted receipts omit it. Motionless FlowText
   reuses one raster surface across frames; animated layouts are evaluated at
   exact frame or shutter time.

Stable runtime diagnostics are source-located under
`CUT_FLOW_TEXT_INPUT_TYPE`, `CUT_FLOW_TEXT_INPUT_ENUM`,
`CUT_FLOW_TEXT_INPUT_SHAPE`, `CUT_FLOW_TEXT_VALUE_RANGE`,
`CUT_FLOW_TEXT_RESOURCE`, `CUT_FLOW_TEXT_SHAPING`,
`CUT_FLOW_TEXT_SELECTION`, `CUT_FLOW_TEXT_MOTION` and
`CUT_FLOW_TEXT_BUDGET`. Loaded or forged IR receives the same closed checks.

The public regression suite covers direct and LocalSpace rendering, mixed
LTR/RTL text, Devanagari shaping, locked fallback fonts, stable cluster
selection, deterministic wrapping, repeated pixel hashes, and hostile authority
mutation. Those tests prove the bounded runtime contract, not typographic taste
or a complete multilingual publishing system.
