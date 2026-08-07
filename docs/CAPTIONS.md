# Deterministic captions

`Captions` is CUT's canonical timed-caption visual source. It consumes a locked
strict WebVTT or SubRip sidecar and a locked TTF/OTF font. The typed `.cut`
program remains the complete execution plan: there is no ASR call, natural
language interpretation, filename inference, hidden cue JSON, or system-font
fallback.

```cut
import { Captions } from "cut:visual";

asset cues: CaptionAsset = caption("assets/dialogue.vtt", format: "webvtt");
asset face: FontAsset = font("assets/Inter-Regular.ttf");

timeline main(duration: 30s, fps: 24, width: 1920px, height: 1080px) {
  scene interview(duration: 30s) {
    Captions(
      source: cues,
      font: face,
      format: "webvtt",
      size: 52px,
      color: #ffffff,
      background: #000000d9,
      position: "cue",
      align: "cue",
      safeX: 5%,
      safeY: 8%,
      maxWidth: 90%,
      padding: 16px,
      radius: 12px,
      lineHeight: 120%
    );
  }
}
```

`format` is required and is exactly `"webvtt"` or `"srt"`. CUT never guesses
it from an extension. `CaptionAsset` is a nominal public type whose
compiler-owned byte authority binds that exact format and strict parser policy.
Its compatible outer IR/lock resource remains `kind: "data"`; legacy
`DataAsset = data(...)` sources remain accepted by `Captions` and omit the new
authority field exactly.

## Timing and interchange

Cue timestamps are canonical exact milliseconds represented as rational CUT
time. A cue is visible when `start <= local node time < end`; contiguous cues
therefore switch at one exact boundary. Cues must be authored in non-overlapping
order and remain within the `Captions` node interval. The frame rasterizer
samples that exact cue state at each frame timestamp.

The interchange module keeps sidecars separate from burn-in:

- `parseWebVtt` / `serializeWebVtt` preserve cue IDs, authored line order and
  the supported horizontal cue settings;
- `parseSubRip` / `serializeSubRip` preserve canonical numeric SRT IDs and
  CRLF delivery;
- conversion fails if a target format cannot preserve source identity or
  settings.

Burn-in does not replace an accessible sidecar. A rendered MP4 contains pixels,
not a selectable or screen-reader caption track. Deliver the canonical VTT/SRT
alongside the video when accessibility is required.

## Closed style contract

| Input | Default | Reference bound |
| --- | --- | --- |
| `size: Length` | `52px` | `12px...256px` |
| `color: Color` | `#ffffff` | six/eight-digit CUT color |
| `background: Color` | `#000000d9` | six/eight-digit CUT color |
| `position: String` | `"cue"` | `"cue"`, `"top"`, `"bottom"` |
| `align: String` | `"cue"` | `"cue"`, `"left"`, `"center"`, `"right"` |
| `safeX: Ratio` | `5%` | `0%...25%` |
| `safeY: Ratio` | `8%` | `0%...25%` |
| `maxWidth: Ratio` | `90%` | `25%...100%`, and inside `safeX` |
| `padding: Length` | `16px` | `0px...128px` |
| `radius: Length` | `12px` | `0px...64px` |
| `lineHeight: Ratio` | `120%` | `100%...200%` |

Authored lines are preserved top-to-bottom; CUT does not silently re-wrap,
truncate, or reorder them. Weight and style come from the exact locked font
file; `Captions` has no weight switch that could silently request a face the
asset does not contain. The runtime parses that fixed-instance font with
`opentype.js@1.3.4`, validates every code point against its cmap, precomputes
the selected glyph run and emits SVG paths rather than SVG text. Layout uses
the resulting advance and outline bounds. If a line exceeds its box it is
proportionally compressed on the x axis; this is a bounded reference policy,
not professional line breaking. WebVTT percentage `line`,
`position`, `size`, and horizontal `align` settings participate in layout;
the CUT safe area clamps the final box. Integer snap-to-line placement is
refused because that WebVTT layout algorithm is not implemented.

The current renderer maps WebVTT logical `start`/`end` to physical left/right.
The pinned OpenType engine deterministically applies the kerning/substitution
behavior it implements. Missing glyphs and shaped `.notdef` glyphs fail; there
is no fallback. CUT does not claim complex-script or bidirectional layout
conformance even when a font covers those characters, so such output requires
outside language review. Variable fonts, color/bitmap/SVG glyph fonts,
collections, WOFF, language-aware wrapping, ruby/voice markup, vertical
captions, regions, styling blocks, overlapping cue lanes and karaoke/word
highlighting are unsupported. Use a fixed-instance monochrome outline `.ttf`
or `.otf` with explicit coverage for the authored text. Sharp/
libvips rasterizes the already-resolved paths, so host font lookup cannot alter
the geometry; CUT still does not claim cross-platform raster bit identity.

## Fail-closed budgets

The reference path accepts at most 64 caption nodes per composition; 64 MiB of
unique locked caption/font bytes; 2 MiB per sidecar; 10,000 cues; 40,000 total
lines; four lines per cue; 4 KiB of text per cue; 1 MiB of total text; 240
Unicode code points per line; and 16 MiB/100,000 glyphs per font. Derived
geometry is limited to 20,000 path commands and 2 MiB per cue, 500,000 commands
and 4 MiB per track, and 2,000,000 commands/32 MiB across the composition. Parsed font/track
objects are shared by locked resource identity, and rasterized cue surfaces use
a 128 MiB LRU cache.

UTF-8 errors, XML-invalid noncharacters, unsafe/bidi controls, markup/entities/
ASS tags, duplicate IDs, overlaps, unsupported VTT settings, missing glyphs,
unsupported font tables, malformed fonts, cues outside the node interval,
unsafe layout, and style values outside the closed bounds all stop preparation
before frame work begins. Strict WebVTT requires a nonempty unique cue ID even
though the broader WebVTT standard permits an omitted ID. No font parsing,
glyph selection or path generation is deferred to a caption frame. Layout is
fully preflighted, then purely recomputed from those prepared bounds for the
same canvas during rasterization.

These bounds are part of the CPU reference runtime, not a promise that every
accepted caption design is aesthetically good. Authors remain responsible for
line breaks, font glyph coverage, reading speed, contrast, language review, and
accessibility QA.
