# Locked `.cube` LUT contract (0.4 alpha)

`LUT` is a closed unary visual kernel. It consumes project-local locked
`LUTAsset` bytes; it does not infer a lookup table from a filename at render
time, call a remote model, or hide a private grading graph.

```cut
import { LUT, Rect } from "cut:visual";

asset look: LUTAsset = lut("looks/channel-swap.cube");

timeline main(duration: 1s, fps: 24, width: 1920px, height: 1080px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    LUT(source: look, strength: 80%) as grade {
      Rect(width: 1920px, height: 1080px, fill: #336699);
    }
    animate grade.strength from 20% to 80% over 1s;
  }
}
```

The public signature is:

`LUT(source: LUTAsset, strength?: Ratio = 100%) { exactly one visual child } -> Visual`

The compiler-owned `LUTAsset` authority explicitly binds CUBE format and the
strict encoded-sRGB parser policy; CUT does not derive either from the locator.
The compatible outer IR/lock resource remains `kind: "data"`, and legacy
`DataAsset = data(...)` sources remain accepted with exact authority omission.
The consumer validates the table while creating and applying `cut.lock`, and
the renderer verifies the same locked SHA-256 and bytes again before frame
work. A malformed table therefore cannot become semantically locked.

## Accepted format

CUT implements one strict, bounded UTF-8 subset of the common `.cube` format:

- blank lines, horizontal whitespace, CRLF/LF, and `#` comments outside a
  quoted title;
- at most one `TITLE "..."`, no escape interpretation, at most 512 UTF-8
  bytes;
- either both `DOMAIN_MIN r g b` and `DOMAIN_MAX r g b`, once each, or neither;
- exactly one `LUT_1D_SIZE` from 2 through 65,536 or one `LUT_3D_SIZE` from 2
  through 65;
- exactly three finite decimal values per table row and the exact declared row
  count;
- normalized SDR table outputs from `0` through `1` inclusive;
- finite, increasing domains inside `-16...16` that contain CUT's complete
  encoded input interval `0...1`.

The file limit is 16 MiB, each line is at most 4,096 UTF-8 bytes, and a file is
at most 300,000 lines. A project may reference at most 64 distinct tables and
64 MiB of LUT source bytes; one rendered composition may reach at most 32
distinct tables and 32 MiB. Control characters, invalid UTF-8, unknown
directives, multiple/shaper-plus-3D tables, trailing rows, non-finite values,
unsafe sizes, and unsupported extensions fail rather than being guessed. In a
3D table red changes fastest, then green, then blue.

## Pixel semantics and order

The input and output triplets are straight-alpha, normalized, **encoded sRGB**
RGB. A 1D table uses independent per-channel linear interpolation. A 3D table
uses deterministic trilinear interpolation in red-fastest storage order.
`strength` mixes the original and sampled encoded RGB values; `0%` is an exact
pixel-byte bypass and `100%` is the complete table result. Alpha bytes are
copied exactly at every strength.

Nesting is the only operation-order mechanism. CUT evaluates the inner child
first, so `ColorGrade(...) { LUT(...) { child } }` applies the LUT before the
outer grade, while the inverse nesting applies the grade first. Argument order
does not change execution order. LUT bytes, strength signals, child content,
runtime implementation identity, and package identity participate in node and
scene cache keys; changing only LUT bytes invalidates the LUT and dependent
picture scene while leaving an unchanged child node reusable.

## Stable failures

- `CUT_LUT_INPUT_TYPE`: wrong canonical runtime quantity/resource value;
- `CUT_LUT_VALUE_RANGE`: strength, domain, or table value outside the closed
  subset;
- `CUT_LUT_SIGNAL`: missing or empty strength signal;
- `CUT_LUT_GRAPH`: invalid node domain or child shape;
- `CUT_LUT_RESOURCE`: missing/wrong/shared resource semantics or non-lowercase
  extension;
- `CUT_LUT_FORMAT`: malformed/ambiguous/unsupported `.cube` syntax;
- `CUT_LUT_LIMIT`: byte, line, title, row, or table-size budget violation.

Source type/argument/child errors also use the ordinary `CUT20xx` diagnostics;
lock tampering uses `CUT_LOCK_INTEGRITY`. Runtime LUT failures retain the
authoring module, line, column, and node ID. Loaded hostile CutAVIR must first
pass the closed IR loader and then the same LUT validator.

## Explicitly not claimed

This slice is not OCIO, ACES, camera-log interpretation, HDR grading, a device
transform, tetrahedral interpolation, a combined shaper-plus-3D pipeline, or an
end-to-end color-managed compositor. CUT currently requires normalized SDR
table outputs and makes no automatic transfer/primaries conversion around a
LUT. Cross-native decoded-frame bit identity also remains unverified. Use the
explicit encoded-sRGB boundary above and author nesting deliberately.

## Executable evidence

`tests/reference-lut.test.ts` is the direct contract suite. It covers public
typing and no-op refusal, strict parser and aggregate resource budgets, 1D and red-fastest 3D
pixel goldens, executed domains, strength endpoints and signal interpolation,
exact alpha, authored order relative to `ColorGrade`, lock tamper/revalidation,
shared-resource refusal, hostile loaded IR, stable JSON diagnostics, and
resource-local picture cache invalidation. Contact sheets or visual inspection
are not used as substitutes for these semantic checks.
