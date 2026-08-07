# Changelog

## 0.4.0-alpha.2

- Added experimental Linux x64/arm64 packaging through the JavaScript compositor fallback.
- Added maintained Node 24 support while retaining the tested Node 20.19 compatibility floor.
- Bound compositor and native-media implementation identity into locks and encoded caches.
- Added a clean installed-package Ubuntu media smoke without claiming cross-platform pixel or bitstream parity.
- Fixed exact-decimal admission, range lexing, Unicode diagnostics, parser recovery, and function-default dependency handling.
- Bumped the top-level lock format because backend identity v2 is intentionally incompatible with old locks.

## 0.4.0-alpha.1

- Published the CUT compiler, runtime, schemas, tests, examples, and VS Code source.
- Unified public source syntax under `cut 0.4`.
- Added typed nonlinear editing, transcript-bound edits, complex text shaping,
  local packages, deterministic asset locks, OTIO interchange, and stem-aware audio.
- Added deterministic frame, contact, audition, preview, render, inspect, and diff CLI flows.
- Documented the macOS arm64 support boundary and current preview-performance limitation.

Earlier private development candidates are not part of this public repository's
history or compatibility promise.
