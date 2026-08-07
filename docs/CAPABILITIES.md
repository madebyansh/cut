# Capabilities and limitations

CUT 0.4 alpha provides a typed source language, deterministic compiler, locked
assets and packages, a reference picture/audio runtime, OTIO interchange, and a
headless CLI for authoring, inspection, review, and delivery.

Implemented areas include:

- multi-item picture/audio timelines with linked and unlinked edits;
- trims, splits, ripple edits, retiming, transitions, and nested sequences;
- media, shapes, paths, text, masks, tracking, maps, diagrams, charts, cameras,
  responsive layout, and compositing;
- captions, transcripts, complex-script text shaping, and local font fallback;
- audio routing, stems, dynamics, synthesis, fades, delays, and time stretching;
- exact resource locks, local CUT packages, semantic inspect/diff, and OTIO;
- deterministic frames, contacts, auditions, previews, and final renders.

Current alpha limitations:

- macOS arm64 is the officially supported media target, with maintained Node.js
  24.x (or Node.js 20.19+ compatibility) and FFmpeg 7 as its release baseline;
- Linux source and package execution is experimental and uses the JavaScript
  fallback when the optional native retained compositor is unavailable;
- FFmpeg compatibility is capability-gated by `cut doctor`; passing it is an
  installability check, not proof of full render parity;
- Windows descriptor-bound media execution is unsupported;
- complex retained compositions may render substantially slower than real time;
- local FFmpeg/Sharp processing is not a hostile-media sandbox;
- packages are local/file based; there is no registry or remote package execution;
- asset search is catalog-only and never downloads or grants rights;
- the VS Code extension is source-shipped but not yet distributed through a store;
- language, IR, lock, and package compatibility may change before 1.0.

The exact contract lives in [SPEC.md](SPEC.md). This page is a product summary,
not a release gate ledger.
