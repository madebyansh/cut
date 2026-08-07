# SDR color management and grading contract (0.4 alpha)

CUT has a bounded, executable SDR color-management slice. It does not claim a
Resolve-, ACES-, or OCIO-class pipeline. The public surface is ordinary CUT
source, survives typed IR and lock application, and is executed by the CPU
reference runtime:

```cut
Video(source: camera, inputColor: "rec709-limited");
PictureClip(source: camera, range: 4s ..< 8s, duration: 4s,
  inputColor: "rec709-limited");
Video(source: archive, inputColor: "bt470bg-smpte170m-limited");

ColorConvert(from: "srgb", to: "linear-srgb") {
  // exactly one straight-alpha visual child
}

TonalCurve(
  points: [
    curvePoint(input: 0%, output: 0%),
    curvePoint(input: 50%, output: 42%),
    curvePoint(input: 100%, output: 100%),
  ],
  space: "linear-srgb",
  channel: "rgb",
) {
  // exactly one straight-alpha visual child
}

export release = render(main, color: "rec709-limited");
```

The closed profile set is:

| CUT profile | Primaries / white | Transfer | 8-bit code range |
| --- | --- | --- | --- |
| `"srgb"` | BT.709 / D65 | IEC 61966-2-1 sRGB | full `0...255` |
| `"linear-srgb"` | BT.709 / D65 | linear | full `0...255` |
| `"rec709-full"` | BT.709 / D65 | BT.709 | full `0...255` |
| `"rec709-limited"` | BT.709 / D65 | BT.709 | legal `16...235` |

Those four names are the retained-surface, `ColorConvert`, and delivery set.
Video consumers additionally accept one deliberately input-only exact tuple,
`"bt470bg-smpte170m-limited"`. It cannot be used by `ColorConvert` or
`render(color:)`, preventing an archival decoder assertion from masquerading
as a general working/output profile.

sRGB and Rec.709 use the same primaries and white point, so this subset needs
no chromatic-adaptation matrix; their transfer functions differ. HDR/PQ/HLG,
camera log, ICC, OCIO and ACES names fail rather than being guessed.

## Working surface and alpha

The reference compositor's declared working boundary is 8-bit straight
(unassociated) encoded-sRGB RGBA. `ColorConvert` decodes each unassociated RGB
channel to linear light, applies the target transfer/range, and copies alpha
exactly. Hidden RGB under alpha zero is converted as independent straight RGB;
it is neither multiplied nor discarded. A premultiplied surface at this
boundary fails with `CUT_COLOR_ALPHA`, preventing accidental double
multiplication.

The exact transfer equations are:

```text
sRGB -> linear:
  E <= 0.04045 ? E / 12.92 : ((E + 0.055) / 1.055) ^ 2.4
linear -> sRGB:
  L <= 0.0031308 ? 12.92L : 1.055L ^ (1 / 2.4) - 0.055

Rec.709 -> linear:
  E < 0.081 ? E / 4.5 : ((E + 0.099) / 1.099) ^ (1 / 0.45)
linear -> Rec.709:
  L < 0.018 ? 4.5L : 1.099L ^ 0.45 - 0.099
```

Limited RGB code values normalize as `(code - 16) / 219`; output performs the
inverse mapping. A limited-range input containing a channel below 16 or above
235 fails with `CUT_COLOR_RANGE` instead of silently clipping. The reference
conformance inspection helper reports lower/upper legal violations, black/white clipping
counts and transparent-pixel counts. It is useful conformance evidence, not a
waveform, vectorscope, or UI scope.

`ColorConvert` executes at its authored graph position. Converting a completed
`Composite` and converting its children before compositing are intentionally
different programs. CUT inserts no implicit transform around a LUT, effect,
group, precomposition, or blend operation.

## Tonal curves

`TonalCurve` is a closed unary visual kernel, not prose metadata. Its `points`
are a finite `List<ColorCurvePoint>` built with the pure compile-time
`curvePoint(input: Ratio, output: Ratio)` helper. The helper lowers to ordinary
typed IR records and never becomes a runtime node. Each curve has 2 through 32
points; inputs and outputs are bounded to `0%...100%`; inputs must be strictly
increasing; and the first and last inputs must be exactly `0%` and `100%`.
Outputs need not be monotonic, so inverse and solarizing curves are expressible.

Interpolation is deterministic piecewise linear in the required authored
`space`, either encoded `"srgb"` or `"linear-srgb"`. The closed `channel` is
`"rgb"`, `"red"`, `"green"`, or `"blue"`; nest curve nodes to author distinct
per-channel curves. The retained input/output is straight encoded-sRGB RGBA.
For a linear curve, CUT decodes sRGB, evaluates the curve in linear light, then
encodes sRGB once. Alpha is copied exactly, and hidden unassociated RGB under
alpha zero is transformed rather than discarded. A mathematical identity
curve bypasses the transfer path and is byte-preserving.

Curve points are static in this bounded slice. Unknown channels/spaces/alpha
modes, malformed or non-canonical exact rationals, extra point fields,
duplicate inputs, incomplete domains, non-unary graphs and premultiplied
surfaces fail. Per composition, the runtime permits at most 256 curve nodes and
4,096 total control points. Points, channel, space, child graph and builtin
implementation integrity all participate in localized cache identity.

## Machine-readable frame histogram

`inspectReferenceColorHistogram` is a public runtime inspection helper over one
rendered straight-RGBA retained frame. It returns stable JSON with format
`cut-color-histogram`, version `1`, exact dimensions/sample counts and 16, 32,
64, 128 or 256 bins for red, green, blue, linear Rec.709 luma and alpha. RGB
bins may project the encoded surface in `"srgb"` or decoded
`"linear-srgb"`; luma is always explicitly linear-sRGB. The alpha policy is
closed to `"nonzero"` (exclude fully transparent pixels) or `"all"`, and the
report records exclusions. Inspection is bounded to 16,777,216 pixels and does
not mutate the surface.

This is useful machine evidence for a rendered frame. It is not a temporal
waveform, vectorscope, parade UI, chroma/legal-broadcast analyzer or substitute
for viewing playback on the intended display.

## Locked video input metadata

`inputColor` is optional on `Video`, linked `Clip`, direct `PictureClip`, and
the `editClip` operand. When supplied, the selected ffprobe video stream must
carry exact locked `color_range`, `color_space`, `color_transfer`,
`color_primaries`, and pixel-format evidence matching the authored profile.
For example, `"rec709-limited"` requires `tv`, `bt709`, `bt709`, and `bt709`.
`"linear-srgb"` additionally requires an RGB-family stream. Missing or
conflicting tags fail with source-located `CUT_COLOR_METADATA` before decode.
The raw bounded ffprobe fields are part of `cut.lock`; tampering or a later
metadata change fails the ordinary lock identity check.

For explicit Rec.709 input, FFmpeg performs the locked BT.709 YUV matrix and
full/legal range expansion before RGBA. CUT then owns the deterministic transfer
conversion into the encoded-sRGB working surface. The backend/toolchain identity
remains lock material. Structural picture edits preserve `inputColor`; trims,
splits, transitions, and materialized edit operands cannot silently revert to
legacy interpretation. Omitted `inputColor` retains the exact pre-managed
decode filter order for backward compatibility; CUT does not pretend untagged
legacy media has known colorimetry.

## Author-declared interpretation of incomplete tags

`inputColor` remains a strict assertion: it is appropriate only when the
selected stream already carries the complete exact target tuple. CUT 0.4 alpha
also has one narrower, explicitly lower-trust path for otherwise usable
8-bit planar-YUV media whose selected-stream tags are incomplete or known to
be wrong:

```cut
import { Video, observedVideoColor, interpretVideoColor } from "cut:visual";

asset archive: VideoAsset = video("media/archive.webm");

const archiveColor = interpretVideoColor(
  profile: "bt470bg-smpte170m-limited",
  master: observedVideoColor(
    pixelFormat: "yuv420p",
    fieldOrder: "progressive",
    // range/matrix/transfer/primaries are omitted because the probe omitted them
  ),
);

timeline main(duration: 4s, fps: 24, width: 1280px, height: 720px, sampleRate: 48khz) {
  scene evidence(duration: 4s) {
    Video(
      source: archive,
      range: 0s ..< 4s,
      inputColorInterpretation: archiveColor,
    );
  }
}
```

`observedVideoColor` records one exact CUT-normalized selected-stream
observation. `pixelFormat` and `fieldOrder` are required. `range`, `matrix`,
`transfer`, and `primaries` are optional because ffprobe may omit them. Absence
is structural: omit an absent property. A string such as `"unknown"` means CUT
actually observed that token and is not interchangeable with omission.
In raw `cut probe` output, helper `range` maps from `colorRange`, `matrix` from
`colorSpace`, `transfer` from `colorTransfer`, and `primaries` from
`colorPrimaries`; canonical inspect already uses the helper field names.

`interpretVideoColor` takes one closed target profile, an exact master
observation, and an exact proxy observation when and only when the asset has a
proxy. Master and proxy observations are validated independently against the
new lock. The currently accepted target profiles are:

- `"rec709-full"`;
- `"rec709-limited"`; and
- `"bt470bg-smpte170m-limited"`.

All three require `yuv420p`, `yuv422p`, or `yuv444p` and exact
`fieldOrder: "progressive"`. RGB, `yuvj*`, interlaced/unknown scan order,
10-bit/float surfaces, chroma-location interpretation, HDR, log, ICC, OCIO and
ACES remain unsupported. `inputColor` and `inputColorInterpretation` are
mutually exclusive. If every authored observation already carries the exact
target tuple, interpretation is redundant and fails with instructions to use
strict `inputColor`.

The declaration's authority is always `author-declared-unverified`. Successful
`cut lock` emits one source-located
`CUTW_COLOR_INTERPRETATION_AUTHOR_DECLARED` warning per resource/profile pair;
the JSON lock report retains the same diagnostic. CUT proves only that the
new lock matches the authored observations and that it executes the named
closed profile. It cannot infer scene colorimetry, inspect a gray card, know the
camera/export history, or verify photographic correctness. The warning is not
an invitation to guess: establish the interpretation from source provenance
and qualified visual/color review.

Observed strings are evidence, never decoder syntax. Only the selected closed
profile supplies backend range/matrix constants and CUT transfer/primary
conversion. This prevents a probe token from becoming an FFmpeg argument.

The canonical locked graph and `cut inspect --json` retain the authored master
and proxy observations, authority, interpretation and field-by-field
differences from the target. A master or proxy execution clone reports only
its selected observation. In the observation record an absent property remains
omitted; only a `differences[]` entry represents that absence as JSON
`observed: null` so tooling can contrast it with `interpretedAs`. Semantic diff
sees authored observation/profile changes. Picture graph/cache identity includes the selected variant's
observation and target profile: changing only proxy bytes/observation preserves
master picture artifacts, and the converse also holds. The interpretation is
picture-only; changing it does not invalidate or alter linked source audio.

### Safe bootstrap workflow

Do not invent observation strings before probing. The source/lock dependency
is bootstrapped explicitly:

1. Author the `VideoAsset` and a temporary legacy consumer with no
   `inputColor` or `inputColorInterpretation`.
2. Run `cut probe <locator> --project <project-directory>` and `cut lock`.
3. Inspect the lock or `cut inspect --json` selected-video record. Copy
   `pixelFormat` and `fieldOrder`; copy each optional color field only when it
   exists. Preserve omission exactly.
4. Establish the intended profile from provenance and qualified visual/color
   review. Author `observedVideoColor` plus `interpretVideoColor`.
5. Regenerate `cut.lock`. Do not reuse the bootstrap lock: source, package and
   color semantics have changed.
6. Confirm the source-located warning and inspect the authored-versus-selected
   observations and target differences. Then compare representative frames
   and full-speed playback on a declared review path.

Public color and proxy tests use generated media with explicit probe metadata
to cover omission, interpretation, master/proxy selection and repeatable
decoded-picture witnesses. They do not substitute for calibrated display or
human color review.

The input-only `"bt470bg-smpte170m-limited"` contract is versioned as
`cut-input-bt470bg-smpte170m-limited-v1`. It accepts only an 8-bit
`yuv420p`, `yuv422p`, or `yuv444p` selected stream with the complete exact
ffprobe tuple `tv / bt470bg / smpte170m / bt470bg`
(range / matrix / transfer / primaries). Missing tags, aliases, ten-bit input,
RGB input, or any mixed tuple fail with source-located `CUT_COLOR_METADATA`.
There is no PAL/NTSC, filename, resolution, or metadata inference.
This older strict assertion does not currently constrain selected-stream field
order; it locks and audits the observed field-order token but its v1 decoder
contract checks pixel format plus the four exact color tags. By contrast, the
new author-interpreted path accepts only exact `fieldOrder: "progressive"` and
fails any missing, unknown or interlaced value. Do not infer a progressive
guarantee from strict `inputColor` until its versioned contract says so.

For this profile, libswscale matrix coefficient 5 (`bt601`, the filter's
published alias for `bt470`/`smpte170m`) expands limited Y'CbCr to a
full-range straight RGBA8 BT.470BG/SMPTE-170M intermediate. CUT then decodes
the SMPTE-170M transfer, applies the fixed D65 BT.470BG-to-BT.709 linear-light
matrix below, clamps once, encodes sRGB, and rounds to nearest byte:

```text
[ 1.0440432087628346  -0.04404320876283506  0                  ]
[ 0                    1                    0                  ]
[ 0                    0.011793378284005201 0.988206621715995 ]
```

The intermediate/working formats, supported pixel formats, matrix and rounding
are frozen in the public runtime contract; decoder/backend identity remains in
the lock. Master and proxy streams are validated independently against the
same tuple. This is a bounded SDR archival-input slice, not support for all
BT.601-family variants, arbitrary chromatic adaptation, HDR, log or OCIO.

## Output metadata and delivery

`render(..., color: profile)` converts the working surface to the requested
transfer, encodes H.264 with explicit BT.709 matrix/primaries and full/legal
range, and writes x264 VUI metadata. CUT then independently reads the delivered
MP4 with ffprobe and refuses it with `CUT_COLOR_METADATA` unless all four tags
match. The render manifest records the working boundary, delivery profile and
observed ffprobe fields.

For `"rec709-limited"`, CUT produces full-range Rec.709 RGB code values and the
encoder performs the RGB-to-limited-YUV mapping once; it is not double-compressed.
Changing output color participates in picture target/cache identity. Changing a
`ColorConvert` profile invalidates that wrapper, its ancestors and containing
scene while retaining an unchanged child and unrelated scene.

Omitting output `color` uses `"legacy-untagged"`: the old raw encoder argument
sequence and pre-managed cache-target shape remain unchanged. This preserves
existing alpha behavior without making up metadata. New managed projects should
author an explicit delivery profile.

## ColorGrade and LUT order

`ColorGrade` remains a separate closed unary creative kernel:

```cut
ColorGrade(
  exposure: 0.5,
  temperature: 0.2,
  tint: -0.1,
  brightness: 1,
  saturation: 1,
  hue: 0deg,
  contrast: 1,
) {
  // exactly one visual child
}
```

Its fixed inner-to-outer order is linear-light exposure (`-16...16` stops),
linear-light creative temperature/tint (`-1...1`), encoded-sRGB
brightness/saturation/hue, then encoded-sRGB contrast. Temperature/tint use the
documented deterministic creative channel balance; they are not Kelvin,
camera-white-balance metadata, or chromatic adaptation. Constructor inputs and
`set`/`animate` share one bounded evaluator.

Strict locked `.cube` lookup tables remain a separate encoded-sRGB `LUT` kernel
documented in [LUTS.md](LUTS.md). Authored nesting determines whether a
`ColorConvert`, `TonalCurve`, `ColorGrade`, `LUT`, blend, or effect runs first.

## Diagnostics and executable evidence

- `CUT_COLOR_PROFILE`: unsupported or hostile profile;
- `CUT_COLOR_METADATA`: locked input tags or delivered output tags disagree;
- `CUT_COLOR_INPUT_COMBINATION`: strict and interpreted declarations were both
  authored;
- `CUT_COLOR_INTERPRETATION_SHAPE`, `CUT_COLOR_INTERPRETATION_PROFILE`,
  `CUT_COLOR_INTERPRETATION_PIXEL_FORMAT`, and
  `CUT_COLOR_INTERPRETATION_SCAN`: malformed, unsupported or unsafe authored
  interpretation;
- `CUT_COLOR_INTERPRETATION_OBSERVED`: the new lock's exact selected
  master/proxy observations disagree with source, or source omitted/added a
  proxy observation incorrectly;
- `CUT_COLOR_INTERPRETATION_REDUNDANT`: all observed tuples already match the
  target and strict `inputColor` must be used;
- `CUTW_COLOR_INTERPRETATION_AUTHOR_DECLARED`: successful source-located lock
  warning that photographic truth remains the author's responsibility;
- `CUT_COLOR_RANGE`: illegal limited-range channel code;
- `CUT_COLOR_ALPHA`: premultiplied surface at the straight-alpha boundary;
- `CUT_COLOR_CURVE_INPUT`, `CUT_COLOR_CURVE_POINTS`, and
  `CUT_COLOR_CURVE_RANGE`: malformed, incomplete, unordered or out-of-domain
  curve data;
- `CUT_COLOR_CURVE_RESOURCE`: per-composition curve work exceeds its bound;
- `CUT_COLOR_HISTOGRAM`: unsupported or unsafe histogram request;
- `CUT_COLOR_INPUT_TYPE`, `CUT_COLOR_SURFACE`, `CUT_COLOR_GRAPH`, and shared
  `CUT_NODE_NOOP`: malformed input, pixels, or unary graph;
- `CUT_OUTPUT_COLOR`: malformed loaded output profile.

`tests/reference-color-management.test.ts` covers exact transfer/range vectors,
hidden RGB/alpha, legal inspection, public syntax to typed IR, hostile loaded
IR, authored compositing order, localized cache behavior, lock probe/tamper and
metadata mismatch, managed versus legacy video decode, all four H.264 delivery
profiles, independent ffprobe verification, and the exact legacy encoder path.
`tests/reference-bt470bg-input-color.test.ts` independently derives the SD
Y'CbCr, SMPTE-170M and primary-conversion pixel expectations; covers all four
public video consumers, exact lock/proxy tuple refusal, hostile IR,
linked-audio and operation preservation, inspect/diff/cache identity, legacy
difference, and a second unrelated media fixture.
`tests/reference-video-color-interpretation.test.ts` covers public helper
typing and record lowering, structural absence, exact lock/proxy observations,
source-located warning and JSON report, canonical/selected inspect, target
conversion pixels, selected-variant cache locality, linked-audio neutrality,
edit-operation preservation, hostile lock/IR values and subprocess-token
injection resistance.
`tests/reference-tonal-curve.test.ts` covers public typed curve syntax and pure
record lowering, hostile loaded IR and resource bounds, encoded/linear pixel
goldens, straight alpha and hidden RGB, identity bypass, authored compositing
order, exact histogram bins/options, and localized cache invalidation.
`tests/reference-color-grade-contract.test.ts`, `tests/reference-lut.test.ts`
and `tests/reference-compositing.test.ts` cover the neighboring grade, LUT and
linear-light blend contracts.

## Honest boundary

This slice does not make the whole renderer color managed. Group/root assembly,
SVG/text/image rasterization, several transforms/effects, image ICC handling,
LUT interpolation, and the remaining Sharp/libvips operations do not all share
one declared linear working pipeline. There is no image `inputColor`, chromatic
adaptation, scene-referred float surface, temporal waveform/vectorscope,
legal-broadcast luma/chroma analyzer, OCIO/ACES, HDR/log path, GPU parity, or
cross-platform color-conformance proof. `linear-srgb` in 8-bit H.264 is a
deterministic conformance/delivery option, not a recommended mastering format.
Author-declared interpretation closes an execution gap for selected incomplete
metadata; it does not make the missing metadata true, repair arbitrary footage,
or expand this incomplete end-to-end pipeline.

Therefore `VIS-04` is `PARTIAL`, not `PASS`. `VIS-05` also remains `PARTIAL`.
The implemented SDR path is real and fail-closed; the missing whole-pipeline
work remains visible.
