# Locked 2D tracking contract (0.4 alpha)

`Track2D` is CUT's first public tracking-data binding. It consumes a strict,
content-locked `DataAsset` and applies its composition-space position to
exactly one retained visual child. Scale and rotation are independently
opt-in. The sidecar is transform data only: it cannot contain CUT, JavaScript,
filters, renderer instructions or film-specific behavior.

```cut
import { Circle, Track2D } from "cut:visual";

asset faceTrack: DataAsset = data("face.track.json");

Track2D(
  source: faceTrack,
  minConfidence: 75%,
  lowConfidence: "hold",
  occluded: "hold",
  outOfFrame: "hide",
  interpolation: "linear",
  bindScale: true,
  bindRotation: false
) {
  Circle(radius: 8px, fill: #ff4d32);
}
```

The complete public signature is:

```text
Track2D(
  source: DataAsset,
  minConfidence: Ratio,
  lowConfidence: "fail" | "hold" | "hide",
  occluded: "fail" | "hold" | "hide",
  outOfFrame: "fail" | "hold" | "hide",
  interpolation?: "linear" | "hold" = "linear",
  bindScale?: Boolean = false,
  bindRotation?: Boolean = false,
  x?: Length,
  y?: Length,
  scale?: Number,
  rotation?: Angle,
  opacity?: Ratio
) { exactly one Visual }
```

Confidence and all three exceptional-state policies are required. A caller
cannot accidentally inherit an undocumented tracker-specific fallback.
Authored `x`/`y` are offsets from the tracked position, authored scale
multiplies tracked scale, and authored rotation adds to tracked rotation.

When the retained child is `LocalSpace(width: w, height: h, origin: { x: ox,
y: oy })`, its children author around the registration point, not in stored
raster coordinates. The legal authored view is `[-ox, w - ox) × [-oy, h -
oy)`, and local `(0px, 0px)` lands on the tracked observation. For example, a
right-edge registration uses a negative-x label and a marker at `(0px, 0px)`;
authoring that label at positive raster x can intentionally clip it. `cut
inspect --json` exposes `localSpace.authoredView` so agents can catch this
before playback, but inspecting the actual frame remains required.

## Sidecar v1

The shipped machine-readable schema is
[`schemas/cut-track-2d-v1.schema.json`](../schemas/cut-track-2d-v1.schema.json).
Runtime validation is stricter than structural JSON Schema: it also proves
canonical reduced rationals, exact ordering, full clock coverage, bounds,
composition dimensions and requested binding fields.

```json
{
  "format": "cut-track-2d",
  "version": 1,
  "coordinateSpace": "composition-pixels",
  "width": 1920,
  "height": 1080,
  "samples": [
    {
      "at": { "numerator": "0", "denominator": "1" },
      "x": { "numerator": "960", "denominator": "1" },
      "y": { "numerator": "540", "denominator": "1" },
      "scale": { "numerator": "1", "denominator": "1" },
      "confidence": { "numerator": "99", "denominator": "100" },
      "status": "visible"
    },
    {
      "at": { "numerator": "5", "denominator": "1" },
      "x": { "numerator": "1200", "denominator": "1" },
      "y": { "numerator": "500", "denominator": "1" },
      "scale": { "numerator": "6", "denominator": "5" },
      "confidence": { "numerator": "9", "denominator": "10" },
      "status": "visible"
    }
  ]
}
```

- `at` is exact node-local time in seconds. The first sample must be `0/1` and
  the last must equal the `Track2D` node duration. Times are strictly
  increasing; the node's active interval is still half-open.
- `x` and `y` are exact pixel-center coordinates in the declared composition.
  A `visible` observation must be inside that composition. An outside position
  must explicitly use `status: "out-of-frame"`.
- `confidence` is required and lies from zero through one. `scale` and
  `rotation` (degrees) are optional unless their corresponding binding is true.
- A sidecar has 2–100,000 observations, at most 8 MiB, 64-digit rationals and
  closed fields. Decoded duplicate JSON keys, invalid UTF-8 and noncanonical
  rationals fail before frame rendering.

## Exact sampling and policies

The runtime evaluates node-local time as an exact rational. At an authored
sample it evaluates that observation. Between observations, `hold` uses the
left observation. `linear` interpolates position and any enabled scale or
rotation only when both endpoints are visible and meet `minConfidence`.
Rotation is an authored numeric degree channel, not an inferred shortest-arc
orientation.

An invalid left observation applies its matching policy across that
observation's half-open interval:

- `fail` emits source-located `CUT_TRACK2D_SAMPLE`;
- `hide` skips the retained child for that evaluation—no placeholder is
  painted;
- `hold` searches backward for the latest visible observation meeting the
  threshold. If none exists, `CUT_TRACK2D_HOLD_EMPTY` fails rather than
  inventing a transform.

If the right endpoint of a linear segment is invalid, the current visible
left transform is held until the invalid observation's exact time. This avoids
interpolating toward an untrusted transform and makes state changes occur at
their authored timestamps.

## Lock, identity and diagnostics

`data(...)` puts the sidecar in typed AV IR as a `DataAsset` resource
reference. `cut lock` pins its locator, byte count and SHA-256. Runtime
preparation re-reads exactly those bytes and validates the strict format.
Resource SHA-256 participates in node, scene and build/cache identity; `cut
inspect --json` reports both the closed Track2D binding/policy projection and
the locked resource hash, while `cut diff` reports tracking-resource and
authored-policy changes.
The same bytes cannot simultaneously be reinterpreted by a non-`Track2D`
kernel.

All tracking errors expose stable `CUT_TRACK2D_*` codes plus the public CUT
module, line, column and node ID. Unknown CUT arguments also fail at check time
through the closed kernel registry.

## Direct LocalSpace execution boundary

The exact unary form `Track2D { LocalSpace { ... } }` now checks, lowers to
ordinary typed IR, reloads through the strict IR validator, and produces a
bounded retained-source placement plan. Local authored `(0,0)` maps to the
sampled tracking point plus authored `x`/`y`; owner and tracked scale/rotation
compose without a delivery-half authoring shim. Mixed local/canvas children,
an indirect LocalSpace, duplicate ownership, unsupported local descendants,
cycles, and work-limit overflow fail before the tracking sidecar is opened.

The reference compositor consumes that plan directly. A visible sample
materializes the declared local tile, uses its one Q16 raster registration,
composes authored and tracked scale/rotation, applies owner opacity, and places
the result on the delivery canvas. A tracking-policy `hide` or exact owner
opacity zero terminates before tile or placement rasterization. The completed
frame receipt distinguishes those owner-policy and owner-opacity skips and
records the full executed placement transform.

`tests/reference-local-space-owner-render.test.ts` locks public CUT source and
sidecar bytes and proves exact output pixels, transform evidence, and zero-work
skip counters. This is engineering evidence only: no LocalSpace tracking study
or creative review is claimed. The ordinary non-LocalSpace child form remains
executable.

## Honest limits

This slice plays deterministic tracking observations; it does not extract or
solve them from footage. It has composition-space 2D position and optional
uniform scale/rotation, not perspective corner pinning, planar/3D camera
solves, mesh deformation, lens distortion, rolling-shutter compensation or
automatic multi-aspect reframing. `Track2D` does not by itself make a shot
well-directed or creatively passed.

The selected `light-rides-the-wing` study exercises the same public runtime on
raw CC0 30fps footage presented at 25fps, with 41 disclosed whole-pixel
observations, direct `LocalSpace`/`Trace` execution and asset-based audio. Its
frozen clipped-label V1 is authoring-failure evidence; current-lock V2 has a
complete render, intermediate-frame witness, stems and byte-identical warm
repeat, while the unrelated microscope/robotics fixtures prove execution, not
taste. The
older synthetic `moving-evidence` fixture remains historical engineering proof
but is excluded from the normative creative-study slot because its generated
plate bakes project-specific motion. Full-speed and headphone review for the
replacement study remain `UNPERFORMED`.
