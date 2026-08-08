# Contributing to CUT

CUT is an early language and runtime. Contributions should make an editing
workflow more expressive, deterministic, portable, secure, or measurably faster.

## Setup

```sh
git clone https://github.com/madebyansh/cut.git
cd cut
npm ci --ignore-scripts
npm run test:portable
```

Use stable Node.js 24.x, or Node.js 20.19 or newer within the Node.js 20 release
line. Node.js 24 is the maintained default; Node.js 20 remains a compatibility
lane. FFmpeg 7 is the macOS release baseline; on Linux, use an FFmpeg/ffprobe
build accepted by `cut doctor`. macOS arm64 is the officially supported target.
Linux source and package execution is experimental and uses the JavaScript
fallback when the optional native retained compositor is unavailable. Windows
descriptor-bound media execution is unsupported.

On macOS arm64 with FFmpeg 7, run `npm run verify` for the complete reference
suite. On Linux, `npm run test:portable` is the portability suite; the CI package
smoke separately installs the packed tarball and checks real frame and media
execution without claiming cross-platform pixel or bitstream parity.

## Changes

1. Open an issue for language, IR, lock, package, or compatibility changes.
2. Keep the implementation general; do not add project-specific visual behavior.
3. Add positive and fail-closed tests for parser, checker, IR, or runtime changes.
4. Preserve exact pixels/samples when optimizing an existing semantic path.
5. Update the relevant public docs and schemas.
6. Run the suite for your platform and `npm pack --dry-run` before opening a pull
   request. Release changes still require the complete macOS reference lane.

Do not commit credentials, private media, generated renders, `.cut` caches,
machine-local paths, raw performance profiles, or footage without redistribution
rights. Bug reports should use small synthetic or openly licensed fixtures.
