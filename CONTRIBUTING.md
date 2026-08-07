# Contributing to CUT

CUT is an early language and runtime. Contributions should make an editing
workflow more expressive, deterministic, portable, secure, or measurably faster.

## Setup

```sh
git clone https://github.com/ansh3002/cut.git
cd cut
npm ci --ignore-scripts
npm run verify
```

Node.js 20 and FFmpeg 7 are required. The native retained compositor currently
targets macOS arm64.

## Changes

1. Open an issue for language, IR, lock, package, or compatibility changes.
2. Keep the implementation general; do not add project-specific visual behavior.
3. Add positive and fail-closed tests for parser, checker, IR, or runtime changes.
4. Preserve exact pixels/samples when optimizing an existing semantic path.
5. Update the relevant public docs and schemas.
6. Run `npm run verify` and `npm pack --dry-run` before opening a pull request.

Do not commit credentials, private media, generated renders, `.cut` caches,
machine-local paths, raw performance profiles, or footage without redistribution
rights. Bug reports should use small synthetic or openly licensed fixtures.
