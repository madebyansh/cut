# Deterministic geographic labels

`Map`, `Marker`, and `Connections` from `@cut/geo` can render labels without consulting SVG text layout or any font installed on the host. A visible label requires an explicit project-local `FontAsset`:

```cut
import { Marker } from "@cut/geo";

asset face: FontAsset = font("assets/Geist-Regular.ttf");

Marker(
  point: { latitude: 28.61, longitude: 77.21, label: "Delhi" },
  font: face,
  color: #22d3ee
);
```

The font must be a locked fixed-instance monochrome-outline `.ttf` or `.otf`. Before any frame work, the reference runtime checks the locked byte count and SHA-256, rejects malformed, variable, color, bitmap, or uncovered fonts, shapes every visible label through the fixed OpenType engine, and converts the result to bounded SVG path data. Rasterization receives `<path>` geometry only—never SVG `<text>`, `font-family`, a system fallback, or a hidden embedded font.

## Label sources

- `Map(points: data, font: face)` renders each valid point's string `label`, or string `name` when `label` is absent. A numeric/object/array label that could render is an error, not string-coerced.
- `Marker(point: point, label?: String, font?: FontAsset)` uses an authored `label` when present; even an empty authored label suppresses `point.label`. Otherwise it uses the point's string label.
- `Connections(target: point, font?: FontAsset)` uses the target's string label. Source points do not render labels.
- `Globe`, `Route`, and `Wavefront` do not render labels and therefore do not accept a font for label work.

A label-free node stays font- and resource-free. Conversely, passing `font` when the resolved node has no visible label is refused as a silent no-op. For data-bound `Map`, this last check necessarily occurs after the locked JSON bytes are opened and before frame generation.

## Placement and limits

Map labels use a fixed offset from their point. Connections labels use a fixed offset from the target. Marker labels use deterministic edge-aware placement: labels normally sit right/above the marker, move left near the right canvas edge, and move below near the top edge. CUT does **not** claim inter-label collision detection, avoidance, or leader-line layout.

The reference budgets are 256 geo-label nodes per composition, 16 MiB and 100,000 glyphs per font, 2,048 visible labels per node, 256 code points per label, 32,768 code points per node, 250,000 outline commands and 8 MiB of path data per node, and 2,000,000 commands/32 MiB of path data per session. Locked geo font resources share a 64 MiB session budget. Exceeding a bound fails with a source-located `CUT_GEO_FONT_BUDGET` diagnostic.

Font resource identity, locator, bytes, package implementation, runtime and backend identity participate in graph and scene cache keys. A font-byte edit therefore invalidates the affected picture scene. Font parsing and outline preparation happen before the first frame.

Stable runtime diagnostic families are `CUT_GEO_LABEL_TYPE`, `CUT_GEO_FONT_RESOURCE`, `CUT_GEO_FONT_COMBINATION`, `CUT_GEO_FONT_PARSE`, `CUT_GEO_FONT_COVERAGE`, `CUT_GEO_FONT_OUTLINE`, and `CUT_GEO_FONT_BUDGET`. Source checking additionally uses `CUT2082` for a literal visible label without `font` and `CUT2083` for a provably no-op literal `font`.

This is deterministic Latin/simple-script outline shaping through the current OpenType engine, not full HarfBuzz-quality complex-script shaping, bidi layout, language-aware breaking, font fallback, or collision-aware cartographic labeling.
