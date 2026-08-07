# Chroma key

`ChromaKey` is CUT's deterministic, full-canvas chroma-key component. It owns
the matte and despill algorithms in the reference runtime; FFmpeg and Sharp do
not define or execute its pixel semantics.

```cut
import { ChromaKey, Composite, Rect } from "cut:visual";

Composite() {
  Rect(width: 1920px, height: 1080px, fill: #172554);
  ChromaKey(
    key: #00ff00,
    tolerance: 12%,
    softness: 8%,
    spill: 50%,
  ) {
    Rect(width: 1920px, height: 1080px, fill: #00a000);
  }
}
```

The component accepts exactly one visual child. `key` is required and must be
an opaque six-digit CUT color. `tolerance`, `softness`, and `spill` are static
`Ratio` inputs with defaults of `12%`, `8%`, and `50%`. Chroma-key controls are
not currently animatable properties. Unknown inputs, properties, extra or
missing children, alpha-bearing keys, and wrong input types fail rather than
becoming no-ops.

## Executable contract

The input boundary is straight encoded-sRGB RGBA. Premultiplied runtime
surfaces are safely unassociated before key measurement, and the result is
always straight alpha. A zero-alpha result has zero RGB, preventing hidden
color from leaking through later filters.

The reference kernel computes Rec. 709 luma and chroma from encoded values:

```text
Y' = 0.2126 R' + 0.7152 G' + 0.0722 B'
Cb = (B' - Y') / 1.8556
Cr = (R' - Y') / 1.5748
d  = clamp(hypot(Cb - keyCb, Cr - keyCr) / sqrt(2), 0, 1)
```

Pixels at or inside `tolerance` have zero keep coverage. With positive
`softness`, coverage follows deterministic smoothstep from zero to one across
`tolerance .. tolerance + softness`; with zero softness, the boundary is hard.
The resulting coverage multiplies the source alpha.

Despill operates only on retained near-key pixels. It has full proximity
through the outer matte boundary, falls off by smoothstep over
`max(tolerance, softness)`, and then becomes zero. `spill` scales that
proximity. RGB is converted to linear sRGB and interpolated toward neutral at
the same linear Rec. 709 luminance before conversion back to encoded sRGB.
With `spill: 0%`, retained straight RGB bytes are copied exactly.

`ChromaKey` refuses a non-sRGB `ColorConvert` result at its input, including a
result hidden beneath another visual wrapper. Convert explicitly back to
`srgb` before the key boundary. This refusal exists because retained reference
surfaces do not yet propagate arbitrary per-surface color metadata.

## Bounds and diagnostics

- Each nonzero ratio must be at least `1/255`, the smallest control step that
  can affect the 8-bit reference boundary.
- `tolerance + softness` must not exceed `50%` of the normalized chroma
  envelope.
- A key must be at least `0.1` normalized chroma away from neutral.
- `spill > 0%` with both tolerance and softness at zero is rejected as inert.
- A canvas may contain at most 16,777,216 pixels.
- A composition may execute at most 64 reachable key nodes and 67,108,864
  aggregate key-pixel passes.

The compiler and loaded-IR preflight emit source-located stable codes:

| Code | Meaning |
| --- | --- |
| `CUT_CHROMA_KEY_GRAPH` | Invalid domain or unary visual-child graph |
| `CUT_CHROMA_KEY_INPUT_TYPE` | Wrong or unsupported input/property |
| `CUT_CHROMA_KEY_COLOR` | Invalid, alpha-bearing, or unreliable neutral key |
| `CUT_CHROMA_KEY_COLOR_SPACE` | Encoded-sRGB input cannot be proven |
| `CUT_CHROMA_KEY_RANGE` | Ratio or matte-window bound failed |
| `CUT_CHROMA_KEY_NOOP` | Authored controls cannot affect retained pixels |
| `CUT_CHROMA_KEY_RESOURCE_LIMIT` | Per-node or aggregate work budget failed |
| `CUT_CHROMA_KEY_SURFACE` | Runtime RGBA/alpha/allocation contract failed |

Validation and work-budget checks run before output allocation. Serialized IR
also remains subject to CUT's canonical rational, reference, ownership,
editorial, graph-hash, and domain validation.

## Determinism and cache identity

The kernel is a fixed JavaScript byte loop with explicit rounding. Its result
depends only on the validated child surface, key inputs, alpha mode, and the
versioned CUT runtime implementation. All four public inputs and the child
graph participate in node, scene, build, and localized picture-cache identity.
Formatting and comments do not. An unchanged render can reuse an on-disk scene
artifact; changing an executed key parameter invalidates that scene while
unrelated audio and child-node identities remain reusable.

## Deliberate limits

This slice implements a reliable chroma key, not a general luma key, difference
keyer, garbage-matte editor, edge-color reconstruction system, or temporal
matte tracker. Those remain separate future primitives. The component is
static for now; CUT refuses attempted property animation instead of pretending
it executed. The retained boundary is 8-bit SDR encoded sRGB, not scene-linear
float, HDR/log or camera-native color. There is no temporal denoise, dedicated
hair/edge-detail reconstruction, decoded green-screen production corpus, or
Linux/Windows pixel-conformance proof yet.
