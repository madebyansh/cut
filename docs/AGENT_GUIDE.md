# CUT 0.4 agent authoring guide

This is the compact, public reference for generating one executable CUT 0.4 alpha program without a hidden template. Emit one UTF-8 `.cut` file. CUT source is code, not prose or Markdown: the compiler parses it, checks dimensions, lowers it to CutAVIR v3, and the reference runtime executes the locked graph.

## The program shape

Use declarations in this order:

```cut
cut 0.4;
project "Project title";

import { Rect, Text } from "cut:visual";
import { Tone, Gain, Limiter } from "@cut/audio";

// The root package ships this fixed-instance OFL fixture under examples/.
// Keep the locator project-relative; never substitute a machine font.
asset face: FontAsset = font("fixtures/Geist-Regular.ttf");
const accent: Color = #22d3ee;

component Label(message: String) -> Visual {
  Text(content: message, font: face, x: 80px, y: 120px, size: 48px, color: accent);
}

timeline main(duration: 3s, fps: 24, width: 1280px, height: 720px, sampleRate: 48khz) {
  scene only(duration: 3s) {
    Rect(width: 1280px, height: 720px, x: 640px, y: 360px, fill: #030712);
    Label(message: "HELLO");
    Limiter(ceiling: -1dbtp) {
      Gain(amount: -16db) {
        Tone(frequency: 220hz, duration: 500ms, amplitude: 25%, fadeOut: 350ms);
      }
    }
  }
}

export release = render(main, width: 1280px, height: 720px, codec: "h264");
```

Rules that prevent most parser failures:

- Start with exactly one `cut 0.4;`. The entry source needs exactly one `project`; user modules need none.
- Imports, assets, constants, components, timelines, and exports are top-level declarations. There is no top-level `audio { ... }` or `visual { ... }` declaration.
- For reusable code, import an explicit canonical project-root path such as `./lib/theme.cut`. User modules can export compile-time values, collections, pure typed expression functions, and directly named components. Paths are not relative to the importing file. Read [USER_MODULES.md](USER_MODULES.md) instead of guessing namespaces, callable re-exports, or dynamic loading.
- A pure function has typed parameters, an explicit return type, and one expression body. It cannot recurse, construct nodes, read media, or return assets/timelines. The compiler expands it to resolved values; there is no runtime function interpreter.
- Statements belong inside a component, timeline, scene, or `at` block. End non-block declarations and node statements with `;`. Do not put `;` after a closing component, timeline, scene, or child-block brace.
- Constructors such as `video`, `audio`, `image`, `font`, `data`, `seconds`, and `render` are implicit. Package components must be imported by their exact names.
- Asset paths are relative to the `.cut` file. `check` does not read them; `lock` requires a regular file that remains physically inside that project directory. `video(master, proxy: preview)` and `audio(master, proxy: preview)` attach one proxy. For multi-stream containers, use absolute ffprobe indexes: `video(path, videoStream: 0, audioStream: 1, proxy: preview, proxyVideoStream: 2, proxyAudioStream: 3)` or `audio(path, stream: 1, proxy: preview, proxyStream: 0)`. Master/proxy indexes are independent. Omit one only when that variant has exactly one consumed stream of the type; CUT refuses ambiguity instead of guessing a default. Both variants are byte-locked and must preserve exact temporal frame/sample mapping. Audio proxies pass a bounded decoded-sample witness; picture proxies pass a bounded fixed-geometry decoded RGB frame-correspondence witness. Neither proves transparent encoding or subjective quality, so review representative frames and complete playback. `preview` selects authenticated proxies and `render` selects masters.
- For discovery, use the closed local `cut asset search <catalog.json> --query ...` contract in [ASSET_CATALOG.md](ASSET_CATALOG.md). Its provenance-bearing rows are candidates only: copy selected bytes project-locally, verify the declared byte count/SHA, probe media, declare the exact typed asset, and run `cut lock`. Never infer authority, type, license, sync, or factual relevance from a filename or search rank.
- Scenes must be declared in playback order, contiguous, non-overlapping, and together cover the timeline exactly for the current reference runtime.

Use authored assertions when a graph invariant should be machine-checked rather
than left in a comment. These predicates are implicit `cut:core` functions
and need no import:

```cut
assert timelineDurationIs(main, 3s), "exact delivery duration";
assert timelineHasNoSceneGaps(main), "continuous scene coverage";
assert timelineHasNoSceneOverlaps(main), "non-overlapping scenes";
assert timeIsOnFrameGrid(main, 1s) && timeIsOnSampleGrid(main, 1s),
  "shared picture/audio boundary";
assert videoRangeWithinLockedMedia(picture, 0s ..< 3s),
  "picture range exists on the locked source grid";
assert audioRangeWithinLockedMedia(dialogue, 0s ..< 3s),
  "dialogue range exists on the locked source grid";
assert captionCoverageIncludes(main, 0s ..< 3s),
  "scheduled caption renderer covers the delivery";
assert deliveryTargetMatches(main, 1920px, 1080px, "h264", "rec709-limited"),
  "managed full-HD output contract is authored";
```

They run against the completed typed graph, regardless of whether the assertion
appears before or after the scenes. `cut test --json` recomputes them; the release
runtime also recomputes them and refuses failure, unsupported predicates, or a
stored-status mismatch. Locked media predicates are deliberately deferred until
`cut.lock` is applied; they validate the declared asset/range pair and never
infer stream duration or consumer intent from a filename. Caption coverage
means continuous scheduled direct `Captions`/`TranscriptCaptions` presentation
intervals, not nested or semantic spoken-word completeness or human
accessibility approval. Delivery matching checks the authored output contract,
not encoded bytes or playback. Keep final-IR predicates directly inside
`assert` (with optional `!`, `&&`, or `||`); using one in a constant, local,
function, `if`, or node argument is `CUT_ASSERT_CONTEXT` because its truth is
unavailable during ordinary compile-time evaluation.

## Literal types: spelling is semantic

Do not exchange dimensions merely because both values look numeric.

| Type | Correct literal | Common wrong literal |
| --- | --- | --- |
| `String` | `"cover"`, `"pink"` | an unquoted word |
| `Color` | `#22d3ee`, `#030712cc` | `"#22d3ee"` |
| `Bool` / `Boolean` | `true`, `false` | `"true"` |
| `Number` | `24`, `1.25`, `-3` | `24fps` |
| `Time` | `250ms`, `3s`, `12f` | a bare `3` |
| `Length` | `640px` | a bare `640` |
| `Ratio` | `25%`, `-20%` | `-10db` or bare `0.25` |
| `Gain` | `-10db` | `10%` |
| `Frequency` | `220hz`, `48khz` | a bare `220` |
| `Angle` | `-45deg`, `1.2rad` | a bare `-45` |
| `Loudness` | `-14lufs` | `-14db` |
| `TruePeak` | `-1dbtp` | `-1db` |

The important audio distinction is:

```cut
Gain(amount: -12db) {
  Tone(frequency: 220hz, duration: 1s, amplitude: 25%);
}
```

`Gain.amount`, `Send.amount`, `ParametricEQ.gain`, `Sidechain.amount`, and
`Sidechain.threshold` are decibel `Gain`. ParametricEQ and High/LowPass
`frequency` are `Frequency`; filter `q`, DeEsser `intensity`/`amount`, and
Compressor `ratio` are scalar `Number`; attack/release controls are `Time`.
Source `amplitude`, `Pan.position`, `Reverb.wet`, and
`Delay.decay`/`Delay.wet` are linear `Ratio` values.

`Gain.amount`, post-child `Send.amount`, `Pan.position`, `Reverb.wet`,
`Delay.wet`, all three ParametricEQ properties, High/LowPass `frequency`/`q`,
all five Compressor properties, DeEsser `intensity`/`amount`, and all four
Sidechain controls accept exact-sample `set`, `linear`, and `outCubic`
automation; other easings fail preflight. Each property permits at most 64
events; grouped processors permit 128. Composition preflight caps all
automated processors at 128 plus 131,072 rendered expression characters.

`Send.amount` stays between -120 and +12 dB and changes only the auxiliary
contribution; dry stays unity. `EQ` is the exact `ParametricEQ` compatibility
spelling. Filter cutoff stays between 1 Hz and 45% of sample rate and Q between
0.1 and 20. Static-only ParametricEQ admits 1 Hz to below Nyquist, -192..+60 dB
and Q 0.001..1000; any event narrows the whole node to 20 Hz..45% of sample
rate, -24..+24 dB and Q 0.1..20. Filter/EQ states survive every event.

Compressor bounds are threshold -60..0 dB, ratio 1:1..20:1, attack
0.01..2,000 ms, release 0.01..9,000 ms and makeup -24..+24 dB; events retain
one stereo-linked envelope. Sidechain uses amount -40..0 dB and the same
threshold/time bounds, with its calibration in [SIDECHAIN.md](SIDECHAIN.md);
events retain one stereo-linked key envelope. DeEsser controls stay in 0..1
and retain one causal split plus stereo-linked detector envelope. Zero is exact
output bypass with warm state; see [DEESSER.md](DEESSER.md). Hard dynamic-control
changes can be abrupt, so use curves when discontinuity is not intended.

`Limiter.ceiling` and `Limiter.release` are exact-sample signal controls;
`Limiter.lookahead`, `Delay.time`/`Delay.repeats`/`Delay.decay`, and
`TimeStretch` remain static-only. Limiter lookahead anticipates future audio,
never a future ceiling event; see [CUT-owned limiter](LIMITER.md). Delay wet
automation retains one finite tap topology; it is not feedback.
`TimeStretch.pitch` is a scalar semitone offset, not a `Frequency`,
`Ratio`, or `Gain`; durations and placement must land on exact samples. `Pan`
is stereo balance, not spatial audio. Reverb wet changes complementary
dry/effect coefficients around one continuous state. `Limiter.ceiling` is
`TruePeak`; `Meter.target` is `Loudness`. Colors are bare
`#RRGGBB`/`#RRGGBBAA`; values such as `Noise(color: "pink")`, `fit: "cover"`,
and codecs are strings.

Property event starts are half-open: a `set` or animation must begin before
its node ends, while an animation may end exactly with the node. CUT also
refuses an explicitly authored control when the complete valid graph proves
that it cannot affect output. Typed source reports `CUT2085` with the underlying
`CUT_NODE_NOOP` reason; hostile loaded IR reports `CUT_NODE_NOOP` directly.
Omit the inert control, author a value or later event that makes it effective,
or use the explicit semantic primitive (for example `AudioGap`) instead of
encoding intent through an inaudible source.

Canonical equality is recursive and exact, so an animation whose `from` and
`to` values are equal is refused for visual and audio properties. Visual
constant, step, keyframe, and track signals also receive a bounded exact
execution-grid proof. CUT follows the reachable scene graph and expands each
`MotionBlur` ancestor through the same shutter/boundary planner used by
rendering. It compares the complete signal with its signal-free input/default
and compares each step point, keyframe, `set`, or animation with the
counterfactual signal formed by removing just that item. An item that changes
neither an output-frame nor a reachable temporal-exposure sample is inert even
when its literal value or endpoints differ—for example, a `set` after the last
reachable sample, the first of two same-time writes, or a collinear keyframe.
Graph traversal plus counterfactual work is bounded to 4,000,000 exact visits
or comparisons, covering an ordinary five-minute 30fps node and supported
temporal amplification in normal-depth graphs. A graph above that bound is
refused with a located `CUT_NODE_NOOP` complexity diagnostic; CUT does not
accept a control after abandoning its executability proof. Any item that
changes a selected execution sample remains executable.

Audio no-op proof runs only after the attached automation contract is valid.
Malformed, unsupported, out-of-range, or off-sample-grid tracks therefore keep
their owning `CUT_AUDIO_AUTOMATION_*` diagnostic instead of being mislabeled as
inert. Every first ordinary non-audio visual/AV property track has one exact,
non-null initial value from the closed 40-kernel/214-property baseline matrix.
The same-named constructor input wins when it is the same control; primitive
geometry coordinates such as `Rect.x` remain independent and use the property
default. `DiagramLayout.progress`, `ParallaxCamera.focusDepth`,
`Camera3D.focalLength`, `Plane3D.z`, and `Wavefront.reveal` must establish an
explicit constructor baseline before automation. Current strict IR and the
runtime both reject missing, null, or conflicting baselines with
`CUT_VISUAL_BASELINE`. Producer-backed visual mappings and `MediaCamera2D` use
their separate closed contracts. Regenerate IR from source rather than
hand-editing this representation.

General audio preflight also caps recursively expanded audio
node-channel-samples (so a shared child referenced many times is charged many
times), stereo PCM24 output below the non-RF64 WAVE boundary, and the exact
emitted filter/argv plan. Every
emitted filter entry is conservatively charged across the full stereo output
sample interval. Cycles, depth and expansion fail at session, direct-render and
stem entry points before recursive graph construction. A raw
`spawn E2BIG` is a bug; valid over-budget source must fail first with a located
`CUT_AUDIO_RESOURCE_LIMIT`.

Frame literals are exact time values only where an owning timeline supplies FPS. Do not use `f` in a top-level asset/constant initializer or in `fps:` itself. Range endpoints must share a type, normally `0s ..< 4s` for media.

## Reference-safe primitives

These signatures are enough for basic picture, motion, and sound work in the current backend:

```text
Video(source: VideoAsset, range?: Range<Time>, fit?: String, x?: Length, y?: Length, loop?: Boolean, endBehavior?: String, inputColor?: "srgb" | "linear-srgb" | "rec709-full" | "rec709-limited" | "bt470bg-smpte170m-limited")
Image(source: ImageAsset, fit?: String, x?: Length, y?: Length)
Precomp(source: Timeline, range?: Range<Time>, x?: Length, y?: Length, scale?: Number, rotation?: Angle, opacity?: Ratio, editId?: String, role?: String, metadata?: EditorialMetadata)
NestedSequence(source: Timeline, range?: Range<Time>)
Text(content: String, font: FontAsset, size?: Length, color?: Color, align?: "start" | "middle" | "end")
FlowText(spans: List<TextSpan>, font: FontAsset, size: Length, color: Color, tracking?: Length, shaping?: TextShaping, motions?: List<TextUnitMotion>, layoutX?: Length, baselineY?: Length, maxWidth?: Length, lineHeight?: Length, maxLines?: Number, align?: "start" | "middle" | "end", x?: Length, y?: Length)
textSpan(id: String, content: String, size?: Length, color?: Color, tracking?: Length, baselineShift?: Length, font?: FontAsset)
textShaping(paragraphDirection: "ltr" | "rtl", language: String, fallbackFonts: List<FontAsset>)
textUnitMotion(span: String, by: "line" | "word" | "glyph" | "cluster", order?: "logical" | "visual", start?: Number, count?: Number, at?: Time, each?: Time, duration: Time, from?: TextUnitPose, to?: TextUnitPose, easing?: Easing, before?: "base" | "from")
Captions(source: DataAsset, font: FontAsset, format: String, size?: Length, color?: Color, background?: Color, position?: String, align?: String, safeX?: Ratio, safeY?: Ratio, maxWidth?: Ratio, padding?: Length, radius?: Length, lineHeight?: Ratio)
Evidence(research: DataAsset, claimId: String, font: FontAsset, x: Length, y: Length, size: Length, color: Color, accent: Color, maxWidth: Length, mode?: "claim-card" | "source-chip", opacity?: Ratio, scale?: Number, rotation?: Angle)
Map(points?: DataAsset, signal?: Color, reveal?: Ratio, font?: FontAsset)
MapCamera(latitude?: Number, longitude?: Number, scale?: Number, bearing?: Angle, pitch?: Angle) { direct retained Map/Route/RouteSubject/Marker/Wavefront/LocalSpace-backed GeoAnnotation children; scene root only }
RouteSubject(points: List<GeoPoint>, progress?: Ratio, color?: Color, radius?: Length, opacity?: Ratio) { direct MapCamera child only; cumulative great-circle progress }
Camera3D(focalLength: Length, x?: Length, y?: Length, z?: Length, targetX?: Length, targetY?: Length, targetZ?: Length, roll?: Angle) { 2..16 direct Plane3D children; scene root only }
Plane3D(z: Length, x?: Length, y?: Length, rotationX?: Angle, rotationY?: Angle, rotationZ?: Angle, scale?: Number, opacity?: Ratio, edge: "transparent") { exactly one direct LocalSpace child }
LocalSpace(width: Length, height: Length, origin: Vec2) { bounded local visual children }
GeoAnnotation(anchor: GeoPoint, width?: Length, height?: Length, placements: List<String>, offset: Length, safeArea: Length, priority?: Number, leader: "none" | "straight" | "elbow", leaderColor?: Color, leaderWidth?: Length, opacity?: Ratio) { exactly one visual child; direct DepthLayer or MapCamera child; leader is required, explicit "none" is the executable no-leader policy and forbids leaderColor/leaderWidth }
CalloutLayer() { 1..64 direct Callout children; direct complete-scene visual root }
Callout(anchor: SpatialPoint, placements: List<String>, offset: Length, safeArea: Length, priority?: Number, leader: "none" | "straight" | "elbow", leaderColor?: Color, leaderWidth?: Length, opacity?: Ratio) { exactly one direct LocalSpace child }
Marker(point: GeoPoint, projection?: "map" | "globe", label?: String, font?: FontAsset)
Connections(points?: DataAsset, stations?: DataAsset, target: GeoPoint, count?: Number, reveal?: Ratio, font?: FontAsset)
Rect(width: Length, height: Length, fill?: Color, radius?: Length)
Circle(radius: Length, fill?: Color)
Group() { visual children }
LUT(source: DataAsset, strength?: Ratio) { exactly one visual child }
ColorConvert(from: "srgb" | "linear-srgb" | "rec709-full" | "rec709-limited", to: same, alpha?: "straight") { exactly one visual child }
ColorGrade(exposure?: Number, temperature?: Number, tint?: Number, brightness?: Number, saturation?: Number, hue?: Angle, contrast?: Number) { exactly one visual child }
MotionBlur(shutterAngle: Angle, samples: Number, startEdge?: "hold") { exactly one visual child }

AudioClip(source: AudioAsset, range?: Range<Time>, fadeIn?: Time, fadeOut?: Time)
Narration(source: AudioAsset, range?: Range<Time>, fadeIn?: Time, fadeOut?: Time)
Synth(events: List<NoteEvent>, waveform?: String, attack?: Time, decay?: Time, sustain?: Ratio, release?: Time, polyphony?: Number)
Tone(frequency: Frequency, duration: Time, amplitude?: Ratio, fadeIn?: Time, fadeOut?: Time)
Noise(duration: Time, color?: String, amplitude?: Ratio, seed?: Number, fadeIn?: Time, fadeOut?: Time)
Bus(name?: String, role?: "dialogue" | "music" | "ambience" | "sfx", kind?: "program" | "aux") { audio children }
Submix(name: String) { audio children }
Send(amount: Gain, source?: AudioNode, tap?: "post" | "pre-fader") { audio children }
Return(sends: List<AudioNode>)
Gain(amount: Gain) { audio children }
ParametricEQ(frequency?: Frequency, gain?: Gain, q?: Number) { audio children }
EQ(frequency?: Frequency, gain?: Gain, q?: Number) { audio children } // compatibility spelling
HighPass(frequency: Frequency, q?: Number) { audio children }
LowPass(frequency: Frequency, q?: Number) { audio children }
Compressor(threshold?: Gain, ratio?: Number, attack?: Time, release?: Time, makeup?: Gain) { audio children }
TimeStretch(sourceDuration: Time, duration: Time, pitch?: Number, quality?: "draft" | "balanced") { exactly one audio child }
Pan(position: Ratio) { audio children }
ChannelMatrix(leftToLeft: Number, leftToRight: Number, rightToLeft: Number, rightToRight: Number) { exactly one audio child }
Reverb(wet?: Ratio) { audio children }
Delay(time: Time, repeats?: Number, decay?: Ratio, wet?: Ratio) { audio children }
Limiter(ceiling?: TruePeak, release?: Time, lookahead?: Time) { audio children }
Meter(target?: Loudness, truePeak?: TruePeak, samplePeak?: SamplePeak, range?: Number) { audio children }
```

`textShaping` opts into CUT's pinned feature-scoped HarfBuzz/bidi execution; it
never authorizes host shaping. Author `FlowText.shaping`, `by: "cluster"`, or
`order:` only with explicit paragraph direction, language and ordered locked
fallback fonts. Lock, inspect and shaped frame/contact/render evidence must
carry the exact backend-byte and policy authority. Omission keeps the
printable-ASCII `FlowText` contract and omits that feature authority. See
`FLOW_TEXT.md`.

### Reusable retained plate component

This is the complete supported component-owned `LocalSpace` shape, not a
template for arbitrary nesting:

```text
cut 0.4;
project "retained plate";
import { LocalSpace, Rect } from "cut:visual";

component Plate(color: Color) -> Visual {
  LocalSpace(width: 320px, height: 180px, origin: { x: 160px, y: 90px }) {
    Rect(width: 320px, height: 180px, x: 160px, y: 90px, fill: color);
  }
}

timeline main(duration: 1s, fps: 24, width: 1280px, height: 720px) {
  scene only(duration: 1s) {
    Plate(color: #e85d04) as plate;
    set plate.x = 120px;
    set plate.y = -40px;
    set plate.scale = 1.1;
    set plate.rotation = 4deg;
    set plate.opacity = 90%;
  }
}
export out = render(main);
```

The invocation must be a direct scene visual root. Its lowered pure
`cut.kernel.fragment` has zero runtime inputs/editorial payload and exactly one
equal-interval `LocalSpace`; compile-time source parameters remain valid.
Fragment nesting, a Group/camera/composition-root parent, invocation children
or a LocalSpace/body sibling, anchor, and skew fail. Other independent scene
roots remain valid. Do not work around the refusal by adding a second wrapper:
either keep this unary shape or author the currently supported owner explicitly.
Component names never dispatch renderer behavior.

Run `cut check`, create/apply the lock, then use `cut inspect --json` and an
exact `cut frame ... --frame N --out ... --json` before a long render. CUT
preflights one composition-frame affine aggregate before any tile. It includes
the component plus every other admitted retained affine owner, actual nested
parent-LocalSpace destinations, and every executed MotionBlur shutter sample.
At most 256 visible transforms, 1 GiB of live outputs, and 2 GiB of unscheduled
peak work are admitted; exact zero opacity consumes none. Zero-skew entries
retain V2 work identity. Nonzero skew uses V3 for the installed scale ->
simultaneous two-axis shear -> rotation path and upgrades a mixed aggregate to
V3. Do not infer new topology: ordinary
`MotionBlur -> Group -> LocalSpace` and component nesting still fail.

These checks prove execution, not direction. A complete full-speed watch,
headphone listen where audio exists, and named-human creative review remain
separate requirements.

For generic footage, diagram, product, or evidence labels, use one
scene-root `CalloutLayer` as the collision domain. Each direct Callout must own
one bounded `LocalSpace`; give it an explicit composition Vec2 or
`visualAnchor(owner:, local:)`, an authored unique directional fallback list,
positive offset, uniform safe area, and explicit leader policy. The anchor
owner must be an earlier direct root in the same scene and source module.
Priority resolves descending, source order breaks ties, and accepted labels
paint in reverse resolution order. Only a directly bound Callout's `opacity`
may be animated in the layer body. Do not invent inferred anchors, arbitrary
obstacle inputs, Callout transforms, or styling parameters: unknown and inert
values fail. Copy the complete checked source and exact
check/inspect/frame/contact/preview workflow in
[`CALLOUT_LAYOUT.md`](CALLOUT_LAYOUT.md). Its conformance evidence proves this
bounded engine slice, not that the resulting annotation is well directed or
creatively reviewed.

For a source-resolution move over one Image/Video, prefer `MediaCamera2D`
instead of wrapping media in `Camera2D` or `Group`. Use it either as a direct
scene root or as the sole direct visual in one `ResponsiveSlot`. Author one
complete-interval media branch, optionally under the documented native
finishing chain, bind the camera with `as`, then animate `focusX`, `focusY`,
`zoom`, `rotation`, or `opacity`. In the responsive form, keep those writes in
the same slot and target only that camera. CUT derives the exact slot context,
renders the camera directly at slot size, and places it once; never author,
copy or patch the compiler-owned context in IR. Do not put `x`, `y`, `scale`,
`rotation`, `opacity`, dynamic properties, arbitrary effects, labels, or
sibling media inside the camera branch; it owns its only spatial sample and
rejects hidden ownership.

To attach a later Path/MotionPath or direct-scene Callout to a source pixel,
alias the slot camera and use
`visualAnchor(owner: camera, local: { x: ..., y: ... })` only after the
ResponsiveStack in the same immediate scope. CUT composes the camera's exact
source-to-slot affine with the slot placement; do not manually add slot
offsets. At most one camera alias escapes each stack, and it cannot escape a
component invocation. For reuse, the one admitted component-local form is a
pure, complete-interval identity Visual component with ResponsiveStack first,
then one anchored Path and/or one CalloutLayer against that same slot camera.
Preparatory `let` bindings may hold plans or other compile-time data, never
rendering nodes.
Do not add component transforms/properties, MotionPath, another camera, other
overlay kinds, or cross-invocation anchors: those still fail. The admitted
fragment dispatches directly in composition space with zero wrapper work; it
does not duplicate or hide a compositor. Read and copy the checked recipes in
[`MEDIA_CAMERA2D.md`](MEDIA_CAMERA2D.md) and
[`RESPONSIVE_LAYOUT.md`](RESPONSIVE_LAYOUT.md), including exact ranges, edge
behavior, Video/color inputs, and creative nonclaims.

For retained maps, bind Route/RouteSubject/Wavefront children inside `MapCamera` and place
their `set`/`animate` statements after those declarations in the same camera
body. The lexical rule is strict: a forward reference or a target inherited
from the scene scope fails. Animate the root camera beside its `MapCamera(...) as
camera` statement. A moving geographic subject is not a canvas `MotionPath`:
author `RouteSubject(points:, progress:)` with 2..4,096 unlabeled points and
animate `progress` from `0%` to `100%`. Every consecutive pair must have
positive spherical distance; CUT refuses wrapped-equivalent duplicates and
graphs above the 4,000,000 segment-by-exact-frame work ceiling. CUT advances
by cumulative spherical great-circle distance before the owning camera
projects the point, so direct seeking is deterministic. The v1 subject is a
delivery-pixel circle only; do not invent sprites, tangent orientation, trails
or collision behavior. `bearing` is a planar
compass/camera heading: positive is
clockwise, so projected geography rotates counterclockwise. It is an `Angle`,
defaults to `0deg`, remains authored and sampled unwrapped within
`[-360000deg,360000deg]`, and never takes an implicit shortest path. Thus a
linear `350deg -> 10deg` passes through `180deg`; author the desired unwrapped
endpoint yourself. Static multiples of `360deg` are north-up no-ops and fail,
while a turn with non-default exact output-frame samples executes. `Connections`,
marker-native labels/fonts, child transforms and a nested/precomposed MapCamera
are not public MapCamera features yet. Pitch, terrain and 3D orbit are also not
implied by planar bearing. Use a locked `Text` or `FlowText` inside
`GeoAnnotation { LocalSpace { ... } }` when
the label itself needs public collision/fallback semantics; this does not make
Marker's refused label/font arguments executable. A
MapCamera-owned GeoAnnotation must omit its own width/height and use exactly one
direct LocalSpace child. The older width/height plus ordinary-child form is
Parallax/DepthLayer-only.

For retained planar 3D, put two through sixteen direct `Plane3D` declarations
inside one scene-root `Camera3D`. Each plane contains one `LocalSpace`; bind and
animate that plane only after its completed block in the same camera body.
Animate the camera after its completed block in scene scope. The coordinate
system is x-right/y-down/z-away and the default look is toward `+z`. Projected
planes that touch or overlap must have strictly separated camera-depth
intervals for every exact frame; CUT refuses crossing geometry rather than
guessing a z order. Keep all corners beyond the near plane and front-facing.
Do not invent meshes, lights, shadows, depth-of-field, backfaces, clipping or
outer MotionBlur for this bounded slice. See [CAMERA3D.md](CAMERA3D.md).

Use [`FLOW_TEXT.md`](FLOW_TEXT.md) when mixed styles, shared wrapping, or
line/word/glyph motion would otherwise require many independently positioned
`Text` boxes. FlowText with `shaping` omitted remains printable ASCII plus LF
in an explicit closed set of fixed-instance locked faces. A named
`textSpan(font:)` may change face only at a space/LF boundary; all runs share
the authored baseline/line grid. Opt-in `textShaping` instead executes the
pinned complex backend with explicit LTR/RTL paragraph direction, bounded
language tags, ordered whole-token locked-font fallback and atomic shaped
clusters. Neither path permits host fallback, synthesized faces, arbitrary
rich-span boundaries or general Unicode line breaking/hyphenation.
Stable selectors are scoped to named spans, and overlapping different
selectors fail rather than silently choosing an owner. Inspect the resolved
face IDs/hashes and feature authority; let `cut lock`/cache identity carry
every selected face, backend byte and execution policy.

`Video` and `Image` fits implemented today are `"cover"`, `"contain"`, and `"fill"`; both accept compositor-owned `x`/`y` lengths. If a delayed `target.x` or `target.y` track is added, its `from` value must agree with the authored constructor position because that position is the exact pre-event baseline. Video `endBehavior` is `"error"` or `"hold"`. `Video` source ranges use `..<`, must land on both the locked source time base and source frame-rate grid, and cannot currently be combined with `loop: true`. `Video(fit: "contain")` produces transparent uncovered pixels, not baked black bars. A looping Video cannot author `endBehavior`, because there is no authored end event for it to govern. Optional `inputColor` on `Video`, linked `Clip`, direct `PictureClip`, and `editClip` is an assertion against exact lock-selected ffprobe metadata, not a hint; missing/mismatched tags fail and structural edits preserve it. The input-only `"bt470bg-smpte170m-limited"` name requires exact `tv/bt470bg/smpte170m/bt470bg` tags and bounded 8-bit YUV; it is not valid in `ColorConvert` or output delivery. Omit `inputColor` only for legacy untagged decode compatibility. Seeded `Noise` colors are `"white"`, `"pink"`, `"brown"`, `"blue"`, `"violet"`, and `"velvet"`.

`Precomp` is the bounded picture-only nested-composition slice. It instantiates
one exact half-open range (or the full source when omitted) on an independent
exact clock and accepts no child block. Parent/source canvas, FPS, and sample
rate must match; source scenes must cover the source duration; audio,
loop/hold/retime, and cross-canvas adaptation are refused. Inside
`PictureTrack`, `editId`, `role`, and namespaced `metadata` provide
compiler-only editorial identity. Canonical `TimelineEdit` may structurally
segment the authenticated range or copy one complete unlinked, childless,
property/effect-free static 1:1 item within that same track. It does not admit
cross-track, partial, transformed, linked, retimed, or audiovisual nested
operands. See [PRECOMPOSITIONS.md](PRECOMPOSITIONS.md).

`NestedSequence` is the bounded audiovisual sibling. It instantiates an
optional exact half-open source range (the full source when omitted) without
cloning the source graph. Picture retains the original source phase; CUT
instantiates the complete pre-master stereo root-mix graph, evaluates causal
state from sample zero through the selected range end, and retains only the
selected samples, so processor history is not reset at the range. Source
`Meter` targets do not run nested mastering; the parent delivery owns it.
Parent/source canvas, FPS, and sample rate must match, and every source/destination boundary
must be exact on its applicable frame and sample grids. There is no retime,
loop, hold, independent A/V range, exposed nested stem/bus, or cross-canvas
conversion. Use it as an AV scene node, not as a PictureTrack or AudioTrack
edit operand. Long/recursive source history and selected temporary raw stereo f32le audio are
explicitly budgeted before rendering. See [PRECOMPOSITIONS.md](PRECOMPOSITIONS.md).

`TimeStretch` is the bounded offline audio retime slice. It reads exactly
`sourceDuration` from its child beginning at the node placement and emits
exactly `duration` there; the ratio must be 0.5–2.0 and pitch must be -12–+12
semitones. Use `Bus { ... }` as the one child when several sources must be
mixed before retiming. Draft uses a 512/128 analysis window/hop and balanced
uses 1,024/256. It is not a variable track time map, does not preserve formants
or promise transient/stereo-phase quality, and is not safe to describe as a
production DAW-quality stretcher. See [AUDIO_TIME_STRETCH.md](AUDIO_TIME_STRETCH.md).

`ColorGrade.exposure` is a scalar number of stops (`-16..16`); `temperature`
and `tint` are bounded creative controls (`-1..1`), not Kelvin/camera metadata.
All three are signal-automatable. See [the exact color contract](COLOR.md) for
operation order and the remaining color-management boundary.

`ColorConvert` executes where it is nested and accepts only the four bounded
SDR profiles above. CUT's retained surface is straight encoded-sRGB; alpha is
copied exactly, limited-range violations are refused, and premultiplied/HDR/
log/ICC/OCIO input is unsupported. For managed delivery use, for example,
`export release = render(main, color: "rec709-limited");`; CUT re-probes the
delivered H.264 tags. Omitting `color` preserves the legacy untagged encoder
path. An identity `ColorConvert` with equal `from` and `to` profiles is refused;
remove the wrapper. Read [COLOR.md](COLOR.md) before authoring a managed
pipeline.

For a deterministic tonal curve, author exact ratio points and choose the
working space explicitly:

```cut
import { curvePoint, Rect, TonalCurve } from "cut:visual";

TonalCurve(
  points: [
    curvePoint(input: 0%, output: 0%),
    curvePoint(input: 50%, output: 42%),
    curvePoint(input: 100%, output: 100%),
  ],
  space: "linear-srgb",
  channel: "rgb",
) {
  Rect(width: 1920px, height: 1080px, fill: #8492a6);
}
```

Use 2...32 points, begin at input `0%`, end at input `100%`, and keep inputs
strictly increasing. Nest `TonalCurve` nodes for distinct red, green and blue
maps. Do not invent luma, premultiplied, log, HDR, animated-point or spline
spellings: the 0.4 reference runtime refuses them.

`LUT` accepts only a project-local locked `DataAsset` whose locator ends in
lowercase `.cube`. It parses one strict bounded 1D or 3D table; do not invent a
mode, hidden shaper, OCIO context, or color-space conversion. `strength` is a
signal-automatable `Ratio`; authored nesting determines whether the encoded-
sRGB LUT runs before or after another grade. Read [LUTS.md](LUTS.md) before
authoring or repairing a table-backed look.

`Synth` accepts a closed event list. Each event is `{ start: Time, duration:
Time, pitch: Number, velocity: Ratio }` or the same shape with `hz: Frequency`
instead of `pitch`. Event time is relative to the node; duration is the gate;
release extends the audible end and counts toward polyphony. All time boundaries
must land on the sample grid. Use only `"sine"`, `"triangle"`, `"saw"`, or
`"square"`, and read [SYNTH.md](SYNTH.md) before authoring a nontrivial score.

`Delay` creates 1–16 explicit feed-forward taps at `time`, `2*time`, and so on. `time` must land on the output sample grid, each later tap is scaled by positive `decay`, and the tap bus is normalized before the complementary `wet` mix. `wet: 0%` is exact decoded-PCM bypass. Keep `time * repeats` within 30 seconds and make the final tap begin before the composition ends. A single tap has no meaningful `decay`, so omit `decay` when `repeats: 1`. Remaining tail is cut at the composition boundary.

Any visible `Map`, `Marker`, or `Connections` label requires `font:` pointing
to a locked fixed-instance monochrome-outline TTF/OTF. `Map` reads string
`label`/`name` fields from its locked data, Marker uses explicit `label` before
`point.label`, and Connections labels only its target. Do not pass `font` to a
label-free node: the runtime refuses the no-op. Marker placement is
deterministically edge-aware but does not resolve collisions between labels.
See [GEO_LABELS.md](GEO_LABELS.md) for the exact closed contract and budgets.

The current picture backend also reads common open named properties such as `x: Length`, `y: Length`, `opacity: Ratio`, and `scale: Number`; `Text` additionally reads `tracking: Length`, `maxWidth: Length`, `maxLines: Number`, `lineHeight: Length`, `shadowColor: Color`, `shadowOpacity: Ratio`, and `shadowBlur: Length`. Its font must be a locked fixed-instance monochrome-outline TTF/OTF; the runtime rejects missing/variable/color fonts, and the checker refuses `weight` rather than silently simulating a face. Bind a node with `as name`, then animate a typed property:

```cut
Group() as card {
  Rect(width: 800px, height: 180px, fill: #0b1220e8);
}
animate card.opacity from 0% to 100% over 12f ease outCubic;
```

Coordinate semantics are different for leaves and containers in this reference backend:

- `Rect.x/y` and `Circle.x/y` are the shape center in canvas coordinates. `Text.x/y` is its fixed-outline text anchor/baseline in canvas coordinates; `align` is exactly `start`, `middle`, or `end`.
- `Group.anchorX/anchorY` is a centre-relative local pivot offset; `Group.x/y` names that pivot's destination relative to the destination canvas centre. All four default to `0px`. They are signal-driven `Length` properties, so `animate card.anchorX from 0px to 100px over 12f;` is valid.
- Fractional `x`/`y` on retained canvas-surface wrappers (`Group`, `Stack`, `Composite`, `Mask`, `Camera2D`, `ColorGrade`, and `Precomp`), component fragments, and fractional `Group.anchorX/anchorY` execute through one CUT-owned sampler. After child composition/effects and scale → skew → rotation, CUT quantizes only the placement phase to Q16, applies zero-extended bilinear filtering to alpha-associated encoded-sRGB bytes, returns straight RGBA with zero-alpha RGB cleared on the fractional path, then applies opacity. Integer phases bypass filtering and preserve every straight-RGBA byte, including independent hidden RGB. Positive and negative `0.5px` positions are exact and observably distinct; no placement is delegated to Sharp/libvips rounding.
- A useful local panel pattern is therefore `Group(x: 80px, y: 1380px) { Rect(x: 460px, y: 180px, width: 920px, height: 360px); Text(x: 44px, y: 58px, ...); }`. The child panel occupies local non-negative bounds `0..920 × 0..360`, then the group moves it to canvas bounds `80..1000 × 1380..1740`.
- The alpha reference compositor clips each child to the canvas before the group transform. Avoid negative local child coordinates; they can disappear before anchoring or translation. This is a documented backend limitation, not the intended final retained-mode compositor architecture.

For a 40-pixel entrance, keep the children at their final local coordinates and animate the group translation from `y + 40px` to `y`.

Import `outCubic` or `linear` from `@cut/motion`. `set card.opacity = 0%;` is an exact step. `animate` runs only over its declared interval and then holds its final value. A later write truncates an earlier overlapping animation; the last source write wins at the same time.

The same module exports `stagger(index:, each:, offset:) -> Time`. Use it in a
bounded `for` loop to derive exact `delay` or `at` times without spelling out a
schedule: for example, `delay stagger(index: item.index, each: 3f)`. The index
must be an exact integer from 0 through 4,095, `each` must be positive and the
optional offset non-negative. CUT folds the call to a rational `Time` during
compilation; it is not a runtime effect or an automatic animation director.

For deterministic spatial motion, wrap one visual in `MotionPath` and animate
its typed `progress` Ratio. Use `points: [...]` for a direct polyline, or bind
the exact same `vectorPath(...)` value to both `Path(geometry:)` and
`MotionPath(geometry:)` when the drawn and moving geometry must not drift.
Progress is cumulative arc length rather than point or segment index. Add
`orientToPath: true` for tangent orientation; authored `rotation` remains an
offset. `closed:` belongs only to points; typed geometry already owns closure.
For closed points, omit a terminal point equal to the first point because the
flag supplies that edge. A retained `Path(geometry:)` subject is authored around
local `(0px, 0px)` directly—do not add a width/2, height/2 Group shim. CUT maps
that local origin to the sampled point for the exact unary retained chain.
Explicit true controls must affect at least one exact output frame and are
checked within a 4,096-frame conservative proof bound. See
[MOTION_PATH.md](MOTION_PATH.md) for exact bounds.

For a drawn cubic route, use `Trace(start:, curves: [cubicTo(...)], ...)` and
optionally `arrow: traceArrow(...)`. Do not supply `points` at the same time,
do not hand-author lookalike records, and do not use `headFade` for arrows:
arrows persist at the final tangent. [TRACE.md](TRACE.md) defines bounded
flattening and stable diagnostics. For a retained shape or route that needs
trim, dash phase, fill, or one topology-compatible morph target, build
`geometry: vectorPath(...)` from `lineTo`/`cubicTo` and use `Path`; never mix
that form with legacy `points:`. Prefer two exact-continuity Paths for a second
morph target rather than hiding a dissolve or private renderer. See
[VECTOR_PATH.md](VECTOR_PATH.md). A real reveal may author `trimEnd: 0%` and
animate from `0%`: the dynamic equality is an explicit transparent frame, not
a tiny visible stub. It must become visible on at least one exact active output
frame; static equal trim boundaries remain invalid. Keep retained-chain,
Path-anchor/skew/crop, and output-frame-only non-inertness limitations explicit.

Built-in node calls are now closed by the executable kernel registry shared by
the checker and reference runtime. `check` rejects a named input, animated
property, or child shape that the backend would ignore. `Stack` and the
picture-only `Sequence` / `PictureTrack` / `PictureClip` / `Gap` slice are
executable today. The previously reserved `Chart` now has a closed executable
bar/line/area contract in [CHARTS.md](CHARTS.md); do not pass the old `data:`
shape or invent labels because unknown arguments fail. Reserved symbols such
as the legacy `@cut/documentary CaptionTrack` still fail explicitly until
their semantics are implemented. Do not infer support from a symbol name; use
[SPEC.md](SPEC.md#10-reference-runtime-conformance) and the registry diagnostic.

For a one-child `Stack`, centered/default alignment and distribution make
explicit symmetric `width`, `height`, `padding`, and `safeArea` inert; omit
those controls or choose a noncentered placement. Two-child and noncentered
counterexamples remain executable.

Use `Marker` and `Region` from `@cut/edit` for non-rendering editorial metadata,
not the geographic `Marker` from `@cut/geo`. Their exact frame/sample-grid
times, IDs, roles, comments and optional scene ownership participate in
semantic identity, inspect/diff and native CUT OTIO round-trip. See
[EDITORIAL_ANNOTATIONS.md](EDITORIAL_ANNOTATIONS.md); author declarations only
as direct timeline/scene statements. `marker()`/`region()` are ordinary typed
compile-time queries for earlier declarations and may drive later media. Their
times are absolute composition coordinates: explicitly subtract a nonzero
scene start before using one as scene-local `at`. Do not use source comments as
a substitute when an edit cue must survive compilation and interchange.

For deterministic picture edits, use the public ordered
`PictureTrack(sourceDuration:, edits:)` algebra rather than manually rewriting
dozens of clip ranges. `split`, `trim`, `rippleInsert`, `rippleDelete`,
`overwrite`, `replace`, `lift`, `extract`, `slip`, and `slide` operate on exact destination
coordinates and materialize ordinary `PictureClip`/`Gap` nodes. Read
[EDITORIAL_OPERATIONS.md](EDITORIAL_OPERATIONS.md) before authoring: current
operations are picture-only; slip/slide require one exact whole-clip target;
slide requires explicit positive-duration neighbors on both sides; and a linked
`link:` source is refused until CUT can couple the corresponding audio edit
honestly.

For one complete equal-range direct linked picture/audio pair, author
`LinkedRippleDelete(link: "take-id");` directly in the owning scene. To delete
one shared interior interval while preserving unequal outer J/L ranges, author
`LinkedRippleDelete(link: "take-id", range: 2s ..< 3s);`. The explicit range
must be strictly inside both direct neutral forward-1x members. `cut check` and
strict IR validate the atomic tail-gap/tail-
silence insertion plus picture/audio ripple deletion. `cut render` invokes the
generalized central validator before picture or audio work; it issues immutable
per-track authorizations only after exact correlation and replay. The bounded
runtime has locked decoded frame/PCM progression, exact transparent/silent tail,
cold/warm/range-sensitive audio-cache and one-sided pre-publication failure proof. OTIO export is
intentionally lossy and emits `CUT_OTIO_LINKED_RIPPLE_DELETE_UNSUPPORTED`.
Multi-item/nested operands, tracks with processed, faded, handled, retimed or
overlap bases, and coupled
slip/slide/transition cases require another explicit operation, not a guessed
rewrite.

For an independently cleaned manual take, use
`AudioRegion(destination:, link?)` as a direct child of a plain `AudioTrack`.
Put exactly one source-owning `AudioClip(source:, range:, fadeIn?, fadeOut?)`
beneath one unbranched chain of up to 32
Gain/Pan/ParametricEQ/HighPass/LowPass/Compressor/DeEsser inserts and at most one
`TimeStretch`. The region—not the leaf—owns destination and optional link.
Without `TimeStretch`, source and destination durations must match exactly;
with it, `sourceDuration` must equal the leaf range and `duration` must equal the
region destination. Inserts inside the stretch execute on its source span,
then CUT retimes, then outer inserts execute on the destination span. Moving an
insert across that boundary is therefore semantic. A retimed region must be
fully static and use ordinary `AudioTrack()` authoring: handles, crossfades,
structural edit plans, linked edit transactions, and automation fail closed.
For an unretimed region, insert automation uses region-local source syntax but
executes on the absolute composition sample clock. CUT performs native trim,
resample, leaf fades, placement, inner-to-outer inserts, then an exact half-open
gate so processor state cannot bleed into the next edit. Do not place routing,
Delay, Reverb, Limiter, or a second branch inside this closed shape. Unsupported
topology is refused rather than flattened. See
[AUDIO_REGIONS.md](AUDIO_REGIONS.md) for exact source/runtime diagnostics,
cache/stem behavior and OTIO loss.

For deterministic structural audio edits, use the parallel audio-prefixed
vocabulary in `AudioTrack(sourceDuration:, edits:)`: `audioSplit`,
`audioTrim`, `audioRippleInsert`, `audioRippleDelete`, `audioOverwrite`,
`audioReplace`, `audioLift`, `audioExtract`, `audioSlip`, and `audioSlide`, with
`editAudio` or `editSilence` operands. These coordinates are exact destination
sample times; locked source intervals must also land on the asset's native
sample grid. The first slice accepts only neutral one-to-one source children:
nonzero fades, overlaps/retime and `link:` in operation mode fail instead of
being flattened. Read
[EDITORIAL_AUDIO_OPERATIONS.md](EDITORIAL_AUDIO_OPERATIONS.md) for the exact
half-open semantics and repair codes. Manual overlapping and linked
`AudioTrack` clips remain available outside operation mode.

For a deterministic AudioTrack crossfade, keep the plan unlinked and neutral,
declare real source availability on the adjacent clips, then add
`audioCrossfadeAt(at: cut, duration: span, curve: "equal-power")` to the same
`edits` list. Declare at least half of `span` as `tailHandle` on the outgoing
clip and `headHandle` on the incoming clip. CUT executes all structural edits
first, resolves the named final hard cut, validates each handle on its asset's
locked native sample grid, and renders exact CUT-owned `p=k/N` envelopes.
`"linear"` is the only other curve. Duration must be an even integer of at
least two destination samples; windows may touch but cannot intersect. Do not
fake a transition with unexplained manual overlap or assume a declared handle
changes sound by itself. See
[EDITORIAL_AUDIO_TRACK.md](EDITORIAL_AUDIO_TRACK.md#track-integrated-crossfades).

For a bounded variable-speed picture edit, import `speedPoint` with
`PictureClip` and author `speedRamp: [speedPoint(at: 0s, rate: 0.5),
speedPoint(at: 500ms, rate: 1.5), speedPoint(at: 1s, rate: 0.5)]`. The first and
last points must cover the exact destination duration, every point must land on
the frame grid, and the source range duration must equal the exact linear-rate
integral. Ramps are forward-only and cannot carry `link`. Omitted or explicit
`frameSelection: "floor"` holds the preceding decoded frame and canonicalizes
to the historical identity. `"nearest"` uses exact rational phases, keeps an
exact half tie on the preceding frame, and participates in edit, inspect, diff,
and cache identity. `"frame-blend"` reads the two adjacent in-authority frames
at fractional phases and applies CUT's exact Q16 round-half-up,
associated-alpha encoded-sRGB law; integer endpoints copy source bytes and
fractional zero-alpha output clears RGB. It works for forward, reverse, ramp,
and freeze maps. Reserved `"optical-flow"` still fails source-located; read
[EDITORIAL_TIME_MAP.md](EDITORIAL_TIME_MAP.md) instead of inventing easing,
reverse ramp segments, motion estimation, or audio stretch.

`Composite` treats children as bottom-to-top layers in source order. Its
optional `blend` is one of `normal`, `source-over`, `multiply`, `screen`,
`overlay`, `darken`, `lighten`, `add`, `plus`, or `difference`; omission means
`normal`. `Mask` requires exactly two visual children: target first, matte
second. Its optional `mode` is `alpha` (the default), `luminance`, `red`,
`green`, or `blue`. `expand` is an exact signed integer from `-64px` through
`64px`; `feather` is an exact integer from `0px` through `64px`; `invert` is
Boolean. Execution order is coverage selection, expansion/erosion, feather,
inversion, then target coverage. Unknown modes/arguments, fractional radii and
ambiguous arity fail before frame rendering. These are deterministic
full-canvas raster mattes. To request an intentional all-zero matte, use a
childless `Group()` as the matte child. CUT refuses a fully transparent Text,
Rect, Circle, Path, or Trace main paint when no independent gradient, endpoint
head, or later opacity state can become visible. For Rect, equal gradient
endpoints are the same pixels as `fill`, so author that solid replacement.
For a static polygon, use unary
`ClipPath(points:, fillRule?: "nonzero" | "evenodd", invert?:)` around exactly
one child. Points are 3...512 exact composition-pixel `Vec2` values and close
implicitly; do not repeat the first point at the end. Child transforms/effects
execute before clipping. The path uses fixed 4x4 coverage and has no accepted
transform, feather, expansion or animation arguments; wrap the result in
`Group` when a completed clipped layer must move. Bezier paths, explicit
multiple subpaths and roto/tracking remain unsupported. See
[`MASKS.md`](MASKS.md) before authoring an advanced matte or clip.

`ChromaKey(key:, tolerance?: 12%, softness?: 8%, spill?: 50%)` is a
separate closed unary `cut:visual` component for static green/blue-screen
matting. It measures encoded-sRGB Rec. 709 Cb/Cr distance, multiplies the
source alpha by an exact hard-or-smoothstep matte, clears hidden RGB at zero
alpha, and applies optional luminance-preserving despill in linear sRGB. Put
the keyed subject inside the block, then composite a replacement layer beneath
it; use an enclosing `Group` for completed-layer transforms. All four inputs
are static and enter picture-cache identity. CUT refuses neutral or
alpha-bearing key colors, ineffective sub-code-value controls, ambiguous color
space, animation, and non-unary graphs. It does not infer a luma/difference
key, garbage/core matte, edge reconstruction, tracking, HDR/log workflow, or
production hair-detail cleanup. Read [`CHROMA_KEY.md`](CHROMA_KEY.md) for the
exact formula, bounds, diagnostics, and 8-bit SDR limits.

`Blur`, `Shadow`, `Glow`, `Vignette`, `Sharpen`, `Grain`, `Duotone`, and
`MotionBlur` are closed unary wrappers. Put exactly
one visual child in each block; nesting applies the inner effect first. A
copyable asset-light chain is in
[`examples/product-card-effects.cut`](../examples/product-card-effects.cut).
Effect parameters are static in the reference backend: `animate glow.radius`
is a source error, not an ignored animation. Blur/glow/shadow are bounded CPU
Gaussian work, every result is clipped to the canvas, and no custom shader or
GPU path is implied. See [SPEC section 6.1](SPEC.md#61-bounded-built-in-visual-effects)
and [`VISUAL_EFFECTS.md`](VISUAL_EFFECTS.md) for exact defaults, units, alpha
rules, seeded spatial/temporal Grain behavior and bounds. Grain never consumes
ambient entropy: choose an explicit unsigned 32-bit seed, `static` or
`temporal` mode, integer cell size, and monochrome policy. Sharpen, Grain and
Duotone keep alpha and zero-alpha hidden RGB; Duotone endpoint colors must be
opaque.

For actual motion exposure, place the moving subtree *inside* MotionBlur:

```cut
MotionBlur(shutterAngle: 180deg, samples: 8) {
  Rect(width: 160px, height: 80px, fill: #ef233c) as card;
  animate card.x from -240px to 240px over 1s ease outCubic;
}
```

At an authored opaque opening boundary, opt into the exact first-instant hold:

```cut
MotionBlur(shutterAngle: 180deg, samples: 8, startEdge: "hold") {
  Group() { /* moving opening frame */ }
}
```

Omission keeps out-of-range samples transparent. `hold` applies only before the
direct child's exact start and only while the nominal output owns that child;
it cannot fill an earlier gap or hold the half-open end. Do not write
`startEdge: "transparent"`: CUT refuses that redundant spelling as
`CUT_MOTION_BLUR_NOOP`.

Do not fake the control with opacity trails or repeated manually offset copies.
The runtime samples exact centered-shutter times and keeps seeded per-frame
effects on the output-frame seed. Its alpha boundary is transparent outside the
child interval. Use 2...32 exact integer samples and an angle greater than
`0deg` through `360deg`; both inputs are required and static. MotionBlur cannot
wrap a subtree containing Precomp/NestedSequence in this alpha. Author it inside
the source composition or restructure the shot; the compiler will not flatten
the boundary. One shutter may directly sample Video, linked Clip, or
PictureClip, but do not put a forward-only decoded-media node below two
MotionBlur ancestors: nested depth-first sample order is not generally
monotonic, so the compiler emits `CUT_MOTION_BLUR_PLAN` instead of seeking or
changing shutter times. Read [`MOTION_BLUR.md`](MOTION_BLUR.md) for the exact
schedule, work budgets, color/alpha rules and unsupported optical-flow/rolling-
shutter semantics.

`Captions` is the implemented timed-cue source; do not use the reserved
`CaptionTrack`. Declare the sidecar as locked `DataAsset` bytes, declare a
project-local TTF/OTF `FontAsset`, and state the format explicitly:

```cut
import { Captions } from "cut:visual";
asset cues: DataAsset = data("assets/dialogue.vtt");
asset face: FontAsset = font("assets/YourFixedFont-Regular.ttf");

Captions(
  source: cues,
  font: face,
  format: "webvtt",
  size: 52px,
  safeX: 5%,
  safeY: 8%,
  maxWidth: 90%
);
```

Cue time is local to the node and end-exclusive. CUT preserves authored cue
and line order; it does not call ASR, infer a format, wrap prose, or search for
a font. Font weight/style is the locked face itself, not a `Captions` input.
Use a fixed-instance monochrome outline TTF/OTF whose cmap covers every
authored character. Keep every cue within the node duration and supply explicit
readable line breaks. Burn-in is pixels, so deliver the VTT/SRT sidecar too for
accessibility. Integer WebVTT `line` placement, markup, regions, vertical text,
overlap lanes and word highlighting are refused. The complete supported
settings, limits and non-claims are in [CAPTIONS.md](CAPTIONS.md).

### Edit-safe transcript selection

When a project already has exact word timing, use the separate public
`transcriptEdit` path so one selection drives picture, audio, and captions. Do
not copy the same source timecodes, destination timecodes, or text into
multiple nodes:

The following source is deliberately schematic, not a paste-and-render
fixture. The selected word IDs determine the exact audio duration and
frame-covering picture duration, so the sequence length and trailing
`Gap`/`AudioGap` endpoints must be derived from the actual locked sidecar.
Use the complete formal contract and CLI procedure in
[Edit-safe transcript selection](TRANSCRIPT_EDITING.md); the executable
real-media fixture is generated by the test suite rather than shipped as
copyable production media.

```cut
import {
  AudioGap,
  AudioTrack,
  Gap,
  PictureTrack,
  Sequence,
  TranscriptAudio,
  TranscriptPicture,
  transcriptEdit
} from "@cut/edit";
import { TranscriptCaptions } from "cut:visual";

asset words: DataAsset = data("assets/answer.cut-transcript.json");
asset voice: AudioAsset = audio("assets/answer.mov", stream: 1);
asset camera: VideoAsset = video(
  "assets/answer.mov",
  videoStream: 0,
  audioStream: 1
);
asset face: FontAsset = font("assets/YourFixedFont-Regular.ttf");

let quote: TranscriptEdit = transcriptEdit(
  transcript: words,
  source: voice,
  from: "answer.0042",
  through: "answer.0061",
  at: 1200ms,
  link: "answer-a"
);

TranscriptCaptions(edit: quote, font: face, maxWords: 4, position: "bottom");
Sequence(duration: 4s) {
  PictureTrack() {
    Gap(duration: 1200ms);
    TranscriptPicture(edit: quote, source: camera, fit: "cover");
    // Add an explicit trailing Gap through the sequence end.
  }
}
AudioTrack() {
  AudioGap(destination: 0s ..< 1200ms);
  TranscriptAudio(edit: quote, fadeIn: 10ms, fadeOut: 20ms);
  // Add an explicit trailing AudioGap through the scene end.
}
```

The binding must be a direct scene-local `let` initializer.
`TranscriptAudio` must be a direct `AudioTrack` item and
`TranscriptPicture` a direct `PictureTrack` item. `from` and `through` are
inclusive stable word IDs; CUT derives the exact source range, selected text
and same-duration audio destination from the external `cut-transcript` v1
sidecar. Picture uses the smallest half-open source-frame interval covering the
word range, so its combined extra head plus tail is less than two frames. The
sidecar's exact master SHA, audio stream/rate/duration, independent video
stream/rate/duration, optional nonzero `audioVideoPresentationDelta`, and word
sample grid are authenticated during lock. The delta is decoded-audio anchor
minus selected-video anchor; omission canonically means zero. CUT maps the
audio-local word interval through that delta before covering complete source
frames and refuses a mapped range outside decoded video. Audio preview may use
a byte-different proxy only after the lock proves audio alignment. Picture
preview likewise requires CUT's fixed decoded RGB correspondence witness;
unrelated same-cadence imagery fails lock as
`CUT_PROXY_VIDEO_ALIGNMENT`. Master render remains valid.

When recorder audio and camera/screen video are separate resources, do not
rename or co-locate them to imply sync. Declare one exact scene-local authority:

```cut
import { transcriptEdit, transcriptMedia } from "@cut/edit";

asset words: DataAsset = data("assets/lesson.cut-transcript.json");
asset voice: AudioAsset = audio("assets/narration.wav", stream: 0);
asset screen: VideoAsset = video(
  "assets/screen-recording.mkv",
  videoStream: 2
);

let sync: TranscriptMediaAuthority = transcriptMedia(
  transcript: words,
  audio: voice,
  audioStream: 0,
  video: screen,
  videoStream: 2,
  videoFrameRate: 30000 / 1001,
  videoDuration: 5s,
  audioAt: 1s,
  videoAt: 1001s / 30000,
  videoRate: 1001 / 1000
);
let quote: TranscriptEdit = transcriptEdit(
  transcript: words,
  source: voice,
  from: "lesson.010",
  through: "lesson.024",
  at: 1s,
  media: sync
);
```

The exact mapping is `videoTime = videoAt + (audioTime - audioAt) *
videoRate`. Both selectors are absolute and explicit; both anchors land on
their authenticated source grids. `cut lock` verifies the authored assertion
against the transcript, audio, independently selected video bytes, cadence,
duration, and probes. It never derives sync from filenames, stream order,
matching duration, or co-location.

An authority-backed `TranscriptPicture` may append both `duration: Time` and
`rate: Number` when its source cadence differs from the composition cadence.
They must satisfy `source duration = destination duration * rate`; CUT does not
silently frame-snap. The resulting ordinary `PictureClip` may participate in a
`PictureTrack` plan containing split/cut and trim, including after that one
exact constant retime. Origin and final-segment identities make every range,
destination, and time-map change auditable. Do not put this item in
`transitionAt`: transcript-bound transition handles are not authenticated in
this slice and fail closed.

CUT does not create this sidecar: there is no ASR, model call, prompt
interpretation, forced alignment or speaker inference in formal execution.
`TranscriptCaptions` groups exact-rational words at the authored `maxWords`
ceiling, speaker changes, sentence punctuation and gaps of at least 250 ms.
Its v2 grouping may split an over-budget group at one authored space into at
most two code-point-balanced lines. Locked-outline preflight refuses any line
that would need horizontal scale below `0.85` with
`CUT_CAPTION_LEGIBILITY`; shorten the cue, reduce size or padding, or increase
`maxWidth`. This bounded rule is not production complex-script/bidi shaping,
font fallback, language-aware line breaking or hyphenation.

Omitting `media` preserves the bounded co-located v1 contract: authenticated
presentation-origin mapping, exact composition-rate picture, frame-aligned
direct placement, forward 1x playback, and no structural edit plan.
Supplying `media` admits only the independent-resource, affine-clock,
split/trim, and constant-retime subset above. It is not a general
transcript-based NLE, transition system, synchronization analyzer, or creative
approval. Packed macOS alpha execution remains unsigned local proof; named
human sync, listening, full-speed playback, and professional review stay
`UNPERFORMED`. Follow the complete sidecar, source, frame-cover, lock, proxy,
install and CLI contract in
[TRANSCRIPT_EDITING.md](TRANSCRIPT_EDITING.md).

### Narration text ownership

`Narration` is a role-classified locked audio take. Its executable inputs are
only `source`, optional `range`, `fadeIn`, and `fadeOut`; it is not a script or
transcript container. `Narration(..., transcript: "...")` fails with
source-located `CUT2059` because the current runtime cannot execute that text.

Use `Captions` backed by locked VTT/SRT, or the separate executable
`TranscriptCaptions(edit:)` path above, when text must be visible and timed.
For non-rendering editorial notes, keep the text in explicit annotation
metadata:

```cut
import { Narration } from "@cut/documentary";
import { Marker, Region } from "@cut/edit";

Narration(source: voice, range: 0s ..< 4s);
Marker(id: "vo-start", at: 0s, role: "transcript", comment: "Opening line editorial note");
Region(id: "vo-take", range: 0s ..< 4s, role: "transcript", comment: "Full take editorial note");
```

Marker/Region comments do not render. Choosing between visible captions and
non-rendering notes is an authorial decision, so `cut migrate` never guesses it.

## Audio roots and placement

Audio is graph structure, not a property of the timeline:

- An audio node statement directly inside a scene is an audible root. It begins at the scene's absolute start plus its local `at` offset.
- An audio node statement directly inside the timeline is also an audible root and uses timeline time. The current runtime permits timeline-level audio roots, but timeline-level visual or linked audiovisual roots are refused.
- Processor inputs are child blocks: `Limiter { Gain { AudioClip(...); } }`. Do not invent `source: main.audio`, `audio: master`, or a `main.audio` member.
- All scene and timeline audio roots are mixed automatically. The `render(...)` call has no audio argument.
- `at 900ms { ... }` shifts the contained nodes relative to their owning scene or timeline. Nested offsets accumulate.
- `let key = SomeAudioComponent();` creates a reference rather than an audible root; this is useful for `Sidechain(source: key, amount: -8db)`, but a reference alone is not mixed as program audio.
- Durations and placements must land on the timeline sample grid. Scene durations must also land on frame boundaries.

Explicit auxiliary routing uses node references, not string bus discovery:

```cut
Bus(name: "dialogue", role: "dialogue") as dialogue {
  AudioClip(source: host, range: 0s ..< 8s);
}
let roomSend = Send(amount: -12db, source: dialogue);
Bus(name: "room", role: "ambience", kind: "aux") {
  Gain(amount: -3db) { Reverb(wet: 100%) { Return(sends: [roomSend]); } }
}
```

Omitted `Bus.kind` means `"program"`. A top-level `kind: "aux"` Bus has no
direct source; it is an additive Return-fed stem. Cross-top-level program-to-aux
routing therefore uses the detached zero-child
`let tap = Send(amount:, source: boundProgramBus)` form. This form is necessary
because a binding authored inside a program Bus's child block cannot escape
that lexical scope to a sibling aux Bus. The detached Send contributes no
second dry root and is audible only through its one claiming Return.

The older structural `Send(amount:) { audio }` remains valid inside one Bus or
Submix: it contributes its child once dry at unity and once to its one Return at
the authored or sample-automated post-child gain. A Return takes 1–32 bound Send
nodes; every Send must be claimed exactly once. Use separately bound Sends for
multiple destinations. `Submix` groups dry and returned paths but does not
create a delivered stem; a named top-level Bus does. Program-to-aux routing is
supported. Pre-fader sends, feedback, arbitrary channel matrices,
program-to-program pulls, and aux-to-aux routing are not.

## Output and loudness truth

The complete `render` signature is:

```cut
render(timeline: Timeline, width?: Length, height?: Length, codec?: String) -> RenderTarget
```

No other render parameters exist in CUT 0.4 alpha. In particular, do not pass `audio`, `audioCodec`, `channels`, or `fastStart`. The current reference runtime gets FPS, sample rate, and actual canvas dimensions from the timeline, so repeat the same width and height in `render` and use `codec: "h264"`. It currently delivers H.264 picture, 256 kbps AAC stereo, and fast-start MP4; it is not a general transcode target yet.

`Meter` needs an audio child block. In the reference backend, a reachable `Meter(target:, truePeak:, samplePeak:, range:)` authors the complete release contract; omitted values default to `-14 LUFS`, `-1 dBTP`, `0 dBFS`, and `9 LU`. Detached meters do not affect an export. Multiple reachable meters must resolve to the exact same target or rendering fails instead of choosing silently. At the currently conformant 48 kHz rate, the renderer measures the raw mix, applies two-pass FFmpeg loudness normalization, scans the exact decoded normalized PCM with CUT's versioned BS.1770-5 kernel, and runs a bounded PCM-sourced AAC retry loop. Every AAC candidate is decoded without resampling; priming and trailing codec padding are reported, while both CUT and the FFmpeg cross-check measure only the same authored sample boundary. The owned MP4 timescale is the sample rate, so non-millisecond boundaries stay exact. Exact silence has a proven zero linear peak even when LUFS is unmeasurable. Render-manifest v8 and delivery-report v2 bind encoded and decoded-boundary hashes; v8 also retains the closed recursive Limiter execution evidence from the pre-master cache boundary. Other rates currently fail before backend work with `CUT_AUDIO_TRUE_PEAK_SAMPLE_RATE_UNSUPPORTED`; see [AAC delivery guard](AAC_DELIVERY.md). `Limiter` and the other audio processors execute before final normalization.

## Diagnostics and repair loop

For an installed packed artifact, run these commands from the directory where
`cut-lang` is installed. `--no-install` makes npm resolve the already installed
local binary and refuse to download a substitute. Rerun `lock` after the final
source edit:

```sh
npx --no-install cut help --json
npx --no-install cut check node_modules/cut-lang/examples/agent-guide-pulse.cut
npx --no-install cut lint node_modules/cut-lang/examples/agent-guide-pulse.cut --deny-warnings --json
npx --no-install cut lock node_modules/cut-lang/examples/agent-guide-pulse.cut --out agent-guide-pulse.cut.lock --json
npx --no-install cut inspect node_modules/cut-lang/examples/agent-guide-pulse.cut --lock agent-guide-pulse.cut.lock --json
npx --no-install cut render node_modules/cut-lang/examples/agent-guide-pulse.cut \
  --lock agent-guide-pulse.cut.lock \
  --output release \
  --out agent-guide-pulse.mp4
```

Inside an ordinary writable CUT project, inspect exact authored evidence before
paying for another complete render:

```sh
npx --no-install cut frame main.cut --lock cut.lock --frame 96 \
  --out review/frame-96.png --json
npx --no-install cut contact main.cut --lock cut.lock --frames 0,48,96,144 \
  --columns 2 --thumbnail-width 480 --out review/contact.png --json
npx --no-install cut audition main.cut --lock cut.lock --samples 240000:336000 \
  --stem dialogue --out review/dialogue-5s-7s.wav --json
npx --no-install cut preview main.cut --lock cut.lock --range 5s:7s \
  --width 640 --out review/range-5s-7s.mp4 --json
```

Use exact frame indices or an exact grid-aligned `--at`; CUT never rounds a
review timestamp. Contact indices must be unique and increasing; CUT evaluates
them sequentially in isolated renderer instances so mutable compositor/decoder
state cannot leak between review points. Audio ranges are half-open sample
indices evaluated inside the authored graph, not post-render trims. Read the
sibling manifests for build/profile/lock/hash evidence, then actually view and
listen to the artifacts. These commands do not replace full-speed playback,
headphones, or `cut render`. Range previews evaluate only exact selected frames
and samples; times must land on both grids. Width previews never upscale and
must preserve aspect ratio at an exact even output size. CUT has no playback UI
or waveform renderer, so use a real player and headphones for review.

The runtime tarball deliberately omits source-maintainer scripts. In a CUT
source checkout, maintainers can build once and use the repository wrappers:

```sh
npm run cli:build
npm run cut -- help --json
npm run cut -- check examples/agent-guide-pulse.cut
npm run cut -- lint examples/agent-guide-pulse.cut --deny-warnings --json
npm run cut -- lock examples/agent-guide-pulse.cut --out /tmp/agent-guide-pulse.cut.lock --json
npm run cut -- inspect examples/agent-guide-pulse.cut --lock /tmp/agent-guide-pulse.cut.lock --json
npm run cut -- render examples/agent-guide-pulse.cut \
  --lock /tmp/agent-guide-pulse.cut.lock \
  --output release \
  --out /tmp/agent-guide-pulse.mp4
```

The `cut-cli-reference` report from `help --json` is the authoritative closed
command/option inventory for this artifact. Do not guess flags from another
version or treat the separately labeled `legacy` category as typed execution.

Repair the reported location and code, not the whole program:

| Diagnostic | Meaning and usual repair |
| --- | --- |
| `CUT_REVIEW_TOOL_*` | An exact authoring-review selector, grid, range, order, output boundary, stem, graph/lock identity, size budget or WAVE contract failed. Preserve exact indices, keep outputs inside the project, rerun `lock` after edits, and do not substitute a post-render trim. |
| `CUT1001` | Invalid token/string/color. Use supported escapes and `#RRGGBB[AA]`. |
| `CUT1002` | Grammar failure. Check braces, commas, semicolons, declaration placement, and remember there is no top-level `audio` declaration. |
| `CUT_DIAGNOSTIC_LIMIT` | The parser reached its closed batch of 256 syntax diagnostics (255 grammar failures plus this sentinel). Repair that batch and rerun; CUT never compiles the recovered partial tree. |
| `CUT2003` / `CUT2004` | Unknown package/export. Use a built-in package and import the exact symbol. |
| `CUT2010` | Unknown symbol. Import it or fix the spelling; do not invent a primitive. |
| `CUT2027` | A closed callable has no such parameter. For `render`, use only `timeline`, `width`, `height`, and `codec`. |
| `CUT2028` | A required argument is missing. Supply the named argument shown. |
| `CUT2029` | Argument dimension/type mismatch. Unquote colors; use `%` for `Ratio`, `db` for `Gain`, `dbtp` for `TruePeak`, and `lufs` for `Loudness`. |
| `CUT2034` | The node cannot have children. Only place a child block on a processor/container that accepts it. |
| `CUT2036`–`CUT2040` | Property, animation, easing, or `at` type mismatch. Match the target property's dimension and use a `Time` duration/offset. |
| `CUT2054` / `CUT2055` | A frame literal has no valid FPS context. Use seconds at top level and a scalar FPS. |
| `CUT2057` | An asset constructor was used outside a direct `asset` initializer. Declare `asset source: VideoAsset = video("path");`, then reference `source`; do not put `video(...)`, `audio(...)`, `image(...)`, `font(...)`, or `data(...)` in `const`/`let`/nested expressions. |
| `CUT2082` / `CUT2083` | A literal geo label is visible without a locked `font`, or `font` is provably a no-op on a label-free geo node. Add the fixed-instance FontAsset only to a label-rendering Map, Marker, or Connections node. |
| `CUT2084` | A `Transition` has invalid children, ordering, overlap, duration, grid placement, ownership, edge fades, or kind-specific controls. Use exactly two source-ordered linked `Clip` children and make `duration` equal their exact overlap. |
| `CUT2085` / `CUT_NODE_NOOP` | A well-typed authored control is provably inert in its complete graph. `check` wraps the runtime reason as `CUT2085`; hostile loaded IR uses `CUT_NODE_NOOP`. Repair the named control or controlling value/event, or omit it. Invalid audio automation retains its more specific `CUT_AUDIO_AUTOMATION_*` code before inactivity is considered. |
| `CUT_VISUAL_SUBPIXEL_POSITION` / `CUT_VISUAL_SUBPIXEL_SURFACE` / `CUT_VISUAL_SUBPIXEL_WORK_LIMIT` | Retained translation received a non-finite/out-of-contract placement, malformed straight-RGBA surface, or work request beyond the transformed-surface/canvas limits. Repair hostile CutAVIR or reduce canvas/transform work; valid fractional authored positions do not trigger these diagnostics. |
| `CUT_CALLOUT_TYPE` / `CUT_CALLOUT_GRAPH` / `CUT_CALLOUT_ANCHOR` / `CUT_CALLOUT_VIEWPORT` / `CUT_CALLOUT_LAYOUT` / `CUT_CALLOUT_STYLE` / `CUT_CALLOUT_LIMIT` / `CUT_CALLOUT_NOOP` / `CUT_CALLOUT_EVIDENCE` | A Callout value, topology, explicit anchor, retained tile, layout, leader, resource bound, executing control, or persisted receipt violates the closed public contract. Repair the named source location, keep the CalloutLayer direct and full-scene, give each Callout exactly one LocalSpace and valid fallback/style, rerun the lock after source edits, and never repair a contradiction by editing IR or evidence hashes; see `CALLOUT_LAYOUT.md`. |
| `CUT2094` / `CUT_LINKED_SPLIT_CONTRACT` | A `JCut`/`LCut` has invalid children, ordering, ownership, union, grid placement, or overlap. Use exactly two direct source-ordered linked `Clip` children; make positive `overlap` exactly equal `[incoming.start, outgoing.end)`. JCut cuts audio at overlap start and picture at overlap end; LCut cuts picture at overlap start and audio at overlap end. Neither injects a fade or doubled mix. |
| `CUT_ASSERT_ARGUMENT` / `CUT_ASSERT_CALL_SHAPE` / `CUT_ASSERT_TIME_ARGUMENT` / `CUT_ASSERT_TIMELINE_REFERENCE` | A supported domain assertion has malformed typed arguments or references a missing/duplicate timeline. Author one of the five documented predicates with a `Timeline` and, where required, an exact `Time`; repair the reported source location. |
| `CUT_ASSERT_CONTEXT` | A final-IR predicate appears outside an `assert` condition. Move the direct call or its `!`/`&&`/`||` composition into `assert`; it cannot drive constants, locals, functions, `if`, or node arguments. |
| `CUT_ASSERT_TIMELINE_GRAPH` / `CUT_ASSERT_RATIONAL` / `CUT_ASSERT_BUDGET` / `CUT_ASSERT_CYCLE` | Final assertion evaluation found invalid exact graph data or exceeded a closed evaluator limit. Do not hand-edit CutAVIR; repair source or reduce the assertion/graph, rebuild, and rerun `cut test`. |
| `CUT_ASSERT_UNSUPPORTED_PREDICATE` / `CUT_ASSERT_UNSUPPORTED_EXPRESSION` | The typed assertion is not in the current executable domain subset. It remains deferred and release-blocking; use a supported Boolean composition or wait for a real predicate implementation rather than replacing the check with `true`. |
| `CUT_ASSERT_STATUS_MISMATCH` / `CUT_ASSERT_FAILED` | Runtime recomputation disagrees with stored IR status, or an authored assertion is false. Rebuild unmodified IR or repair the actual graph invariant; never edit the stored status. |
| `CUT2086` / `CUT_EDIT_PICTURE_TIME_MAP` | A picture playback map has an invalid combination, rate, speed point, integrated source duration, frame boundary, lock bound, or typed-IR disagreement. Use one constant/reverse/freeze form or the bounded forward `speedRamp` contract in `EDITORIAL_TIME_MAP.md`. |
| `CUT_EDIT_PICTURE_FRAME_BLEND` | A frame-blend surface, Q16 phase, policy identity, dimensions, or observed work violates the closed exact interpolation contract. Keep both locked RGBA sources equal-sized and inside the 7,680×4,320 bound; never substitute optical flow or an unbound backend blend. |
| `CUT_PRECOMP_*` | A visual timeline instance has an invalid reference, range, clock, format, audio/AV source, composition cycle, or expansion budget. Keep it picture-only, range/frame-exact, same-format and acyclic; see `PRECOMPOSITIONS.md`. |
| `CUT_NESTED_*` | An audiovisual timeline instance has an invalid reference, half-open source range, frame/sample clock, format, graph ownership, composition cycle, or expansion budget. Keep it childless, same-format, frame/sample-exact and acyclic; use one shared 1:1 range and do not invent retime/loop/independent-A/V controls. |
| `CUT_LUT_INPUT_TYPE` / `CUT_LUT_VALUE_RANGE` / `CUT_LUT_SIGNAL` / `CUT_LUT_GRAPH` / `CUT_LUT_RESOURCE` / `CUT_LUT_FORMAT` / `CUT_LUT_LIMIT` | A LUT node or its locked lowercase `.cube` bytes violate the closed contract. Use one child, `DataAsset` source, `0%..100%` strength, one bounded 1D/3D table, finite normalized output rows, and the encoded-sRGB rules in `LUTS.md`. |
| `CUTL1001`–`CUTL1005` | The linter found an import, asset/constant, component, or timeline unreachable from exported render targets, or found no export. Delete it, connect it to an exported target, or omit `--deny-warnings` while deliberately iterating. |
| `CUT_AUDIO_EDIT_SHAPE` / `CUT_AUDIO_EDIT_TIME` / `CUT_AUDIO_EDIT_NOOP` / `CUT_AUDIO_EDIT_UNSUPPORTED` / `CUT_AUDIO_EDIT_RESULT` / `CUT_AUDIO_EDIT_LIMIT` | An AudioTrack plan is malformed, off-grid/out-of-bounds, neutral, ambiguous/unsupported, inconsistent with materialized IR, or over budget. For `audioCrossfadeAt`, target a final internal hard cut between two neutral unlinked clips, use an even duration of at least two destination samples, declare at least half that duration as outgoing `tailHandle` and incoming `headHandle`, and keep every native source endpoint locked and in bounds. |
| `CUT_LINKED_RIPPLE_LIMIT` / `CUT_LINKED_RIPPLE_SCOPE` / `CUT_LINKED_RIPPLE_TIME` / `CUT_LINKED_RIPPLE_UNSUPPORTED` / `CUT_LINKED_RIPPLE_RESULT` / `CUT_LINKED_RIPPLE_CARDINALITY` / `CUT_LINKED_RIPPLE_CORRELATION` / `CUT_LINKED_RIPPLE_PLAN` / `CUT_LINKED_RIPPLE_MATERIALIZATION` | A bounded `LinkedRippleDelete` statement or transaction exceeds a limit, selects an unsupported treated operand, cannot materialize its result, or disagrees with its scene, frame/sample range, complete-pair v1 or strict-interior v2 direct-neutral contract, deterministic segment ownership, correlated four-operation plan, or materialized tracks. Keep the statement scene-direct; omit `range` only for a complete equal pair, or supply a strict shared interior range for J/L-aware v2. V2 picture operands must retain default cover framing, full opacity, unit scale and zero rotation; author treatments after the structural edit. Do not hand-edit generated transaction or segment IR. |
| `CUT_AUDIO_INPUT_TYPE` / `CUT_AUDIO_VALUE_RANGE` / `CUT_AUDIO_SAMPLE_GRID` / `CUT_AUDIO_RESOURCE_LIMIT` | A loaded or locked audio processor, composition work plan, PCM24 artifact, filter graph, or backend argv violates its closed runtime contract. For `Delay`, use exact sample-grid `time`, integer `repeats` from 1–16, positive `decay`, `wet` from 0–100%, and a final tap inside both the 30-second tail budget and composition. For a general graph, reduce reachable audio nodes/duration/sample rate, split delivery, or simplify filters; CUT refuses before backend spawn. |
| `CUT_AUDIO_ROUTING_DANGLING` / `CUT_AUDIO_ROUTING_DUPLICATE` / `CUT_AUDIO_ROUTING_GRAPH` / `CUT_AUDIO_ROUTING_CYCLE` / `CUT_AUDIO_ROUTING_LIMIT` / `CUT_AUDIO_ROUTING_NAME` | An explicit Send/Return/Submix graph is empty, unclaimed, multiply counted, mistyped, detached, cyclic, over budget, or uses an unsafe/duplicate Submix name. Bind each audible Send once, reference it from exactly one reachable Return, and keep the graph structural and acyclic. |
| `CUT_AUDIO_AUTOMATION_*` / `CUT_AUDIO_DEESSER_WORK_LIMIT` | Loaded audio automation violates its declared signal type/payload, value, sample grid, easing, signal shape, timing, limit, graph, or DeEsser work contract. Repair the source-located `Gain.amount`, `Send.amount`, `Pan.position`, `Reverb.wet`, `Delay.wet`, ParametricEQ `frequency`/`gain`/`q`, High/LowPass `frequency`/`q`, Compressor track, Limiter `ceiling`/`release`, DeEsser `intensity`/`amount`, or Sidechain controls. Keep parameters inside documented bounds and use only `linear`/`outCubic`; one property permits 64 events, grouped processors 128, and the composition permits 128 automated processors plus 131,072 expression characters. Limiter and DeEsser additionally have processor-specific node/channel-sample budgets. Limiter lookahead, Delay time/repeat/decay, and TimeStretch animation remain unsupported. |
| `CUT_AUDIO_TIME_STRETCH_*` | `TimeStretch` has an invalid type, value, sample grid, quality, graph, nesting, or work budget. Use one audio child, exact source/destination samples, a 0.5–2.0 duration ratio, -12–+12 semitone pitch and `"draft"` or `"balanced"`; keep the controls static. |

`check` proves parsing, static types, and deterministic lowering contracts such as Transition/J/L overlap, Chart inputs, bounded planar Camera3D graphs, and nested-composition graph closure; `lint` adds export-reachability policy but does not replace `check`. `inspect --json` is the stable machine graph view after compilation/optional locking; use its roots, adjacency, source locations and budget metrics before editing a generated graph. None of these commands alone constitutes complete reference-runtime preflight. A locked release can still refuse stale resources, a stale source hash, unsupported kernels, non-contiguous scenes, off-frame scene durations, off-sample audio placement, or source ranges incompatible with the locked media clocks. The reference backend intentionally refuses `Shader`, `Light`, the legacy `CaptionTrack`, and the general `TimeRemap` wrapper instead of substituting placeholders. Its executable `Camera3D` remains the narrower retained planar contract in [CAMERA3D.md](CAMERA3D.md), not a full 3D engine. Picture-only Precomp, shared-range AV NestedSequence, picture sequences, bounded PictureClip speed ramps/frame blend, picture-track edit/transition operations, sample-accurate AudioTrack edits and crossfades, the linked-Clip Transition, bounded `LinkedTrim`, complete equal-range v1 and strict-interior/J-L-aware direct-neutral v2 `LinkedRippleDelete`, text-free bar/line/area `Chart`, two-Clip JCut/LCut wrappers, and constant-ratio audio `TimeStretch` are separate executable slices. Canonical TimelineEdit additionally has bounded complete-origin same-track or cross-track processed/faded audio insertion/overwrite through one source-owned origin evaluation, permits one direct picture part in the same linked placement, and supports complete-item same-track static 1:1 `Precomp` insertion/overwrite. Those narrow forms do not imply audiovisual or transformed nested operands, multiple processed or nested state-bearing operands, independent nested A/V selection, coupled slip/slide/transition cases, processed/faded/handled/retimed/overlap ripple bases, lossless linked-operation interchange, labeled/multi-series/logarithmic chart grammar, arbitrary AudioTrack transitions, arbitrary source-time or transition curves, variable or track-integrated audio retiming, optical flow, or production transient/formant/stereo-phase stretch quality. See [CHARTS.md](CHARTS.md), [PRECOMPOSITIONS.md](PRECOMPOSITIONS.md), [TIMELINE_EDIT.md](TIMELINE_EDIT.md), [EDITORIAL_SEQUENCE.md](EDITORIAL_SEQUENCE.md), [EDITORIAL_OPERATIONS.md](EDITORIAL_OPERATIONS.md), [EDITORIAL_TIME_MAP.md](EDITORIAL_TIME_MAP.md), [EDITORIAL_AUDIO_TRACK.md](EDITORIAL_AUDIO_TRACK.md), [EDITORIAL_TRANSITIONS.md](EDITORIAL_TRANSITIONS.md), and [AUDIO_TIME_STRETCH.md](AUDIO_TIME_STRETCH.md).

Reference runtime limits include two hours, 1–120 FPS, 8–192 kHz audio, at most one million frames, and a canvas no larger than 4096×4096 or 16,777,216 pixels.

## Verified unrelated example

[The Beacon Pulse example](../examples/agent-guide-pulse.cut) is a self-contained 3-second program using the bundled fixed-instance OFL Geist fixture, a reusable visual component, typed animation, two scene-local sound events, a bus, gain staging, and limiting. Its adjacent [`Geist-LICENSE.txt`](../examples/fixtures/Geist-LICENSE.txt) is part of the redistributable fixture contract. CUT locks those project-local font bytes and never substitutes a system font. The example is unrelated to the flagship documentary. Its checked-in source is intended to be copied as reference material, not silently injected into a benchmark condition.

This guide describes the formal CUT 0.4 language and reference backend shipped by `cut-lang` 0.4.0-alpha.1. It does not claim that the alpha already replaces a complete NLE. See [VISION.md](VISION.md) for the end-state contract and [SPEC.md](SPEC.md) for the fuller language and IR specification.
