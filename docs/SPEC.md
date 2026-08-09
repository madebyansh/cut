# CUT 0.4 alpha language and IR specification

Status: implementation specification for the CUT 0.4 language in `cut-lang` 0.4.0-alpha.3. This document describes the formal language path implemented by the repository. It is not yet a frozen compatibility standard.

CUT is a programming language for audiovisual graphs. The canonical authoring artifact is UTF-8 `.cut` source. The compiler parses and type-checks that source, lowers it to CutAVIR v3, and binds it to content-locked resources and package implementations. A runtime executes the graph. JSON production plans and the earlier line-oriented editorial DSL are legacy compatibility formats, not CUT 0.4 source.

The normative architecture is:

```text
.cut source + local resources
        │
        ▼
lexer → parser → checker → compiler → CutAVIR v3
                                      │
                         cut.lock ─────┤
                                      ▼
                              conforming runtime
```

See [VISION.md](VISION.md) for the intended end state and [GENERALITY.md](GENERALITY.md) for the rule against showcase-specific executable behavior.

## 1. Source text and lexical structure

### 1.1 Encoding and layout

CUT source is UTF-8. Whitespace separates tokens but is otherwise insignificant. Indentation has no semantic meaning. Braces delimit blocks and semicolons terminate non-block declarations and statements.

`//` begins a comment that continues to the end of the line.

```cut
// This is a comment.
const title: String = "The Planet Has Ears";
```

The `#` character does not begin a comment. It begins a color literal.

### 1.2 Identifiers

Identifiers match `[A-Za-z_][A-Za-z0-9_]*`. Keywords are recognized by parser position rather than by a separate reserved-word token class. Authors should not reuse declaration or statement words as ordinary names.

### 1.3 Strings

Strings use double quotes. The implemented escapes are `\n`, `\r`, `\t`, `\"`, and `\\`. Unknown escapes and unterminated strings are errors.

### 1.4 Numbers and units

A number is an unsigned decimal literal optionally followed immediately by one unit. Negation is a unary operator.

| Unit | Dimension | Canonical lowering |
| --- | --- | --- |
| none | scalar | exact scalar rational |
| `ms`, `s` | time | seconds |
| `f` | time | seconds using the owning timeline FPS |
| `px` | length | pixels |
| `%` | ratio | unit ratio (`50%` becomes `1/2`) |
| `deg`, `rad` | angle | degrees (`rad` uses the fixed rational conversion below) |
| `db` | gain | decibels |
| `hz`, `khz` | frequency | hertz |
| `lufs` | loudness | LUFS |
| `dbtp` | true peak | dBTP |

Decimal spellings are converted from their source digits into reduced rational numbers; compilation does not first round them through binary floating point. For example, `141.5s` lowers to `283/2` seconds.

CutAVIR v3 has exactly one canonical unit per quantity dimension: `scalar`/
`scalar`, `time`/`s`, `length`/`px`, `ratio`/`ratio`, `angle`/`deg`,
`gain`/`db`, `frequency`/`hz`, `loudness`/`lufs`, and
`true-peak`/`dbtp`. The public JSON Schema and strict loader enforce each pair
at every nested IR value, not only at kernel inputs or signals. Source units
such as `ms`, `f`, `rad`, `khz`, and `%` are converted before IR emission.

Each reduced numerator and denominator is limited to 256 decimal digits, excluding a numerator sign. The checker reports an oversized source literal at its source span, and exact arithmetic is rechecked after every derived operation; CUT fails rather than rounding or emitting an IR value its public loader would reject.

Angles are canonicalized to degrees before arithmetic or execution. Because pi is irrational, exact rational arithmetic cannot represent the true radian-to-degree conversion. CUT 0.4 therefore defines `1rad` as the versioned rational decimal `57.29577951308232deg`; the approximation is deterministic, explicit, and never obtained through host floating-point math.

Frame literals require an owning timeline because their duration depends on FPS. They are rejected in top-level `asset` and `const` initializers and in the `fps:` expression itself. At 24 FPS, `12f` lowers exactly to `1/2` second. `seconds(number)` converts an exact scalar value to an exact time value.

### 1.5 Colors

Colors are `#RRGGBB` or `#RRGGBBAA`, case-insensitive in source and normalized to lowercase by the lexer.

### 1.6 Operators and precedence

From lowest to highest precedence:

1. `||`
2. `&&`
3. `==`, `!=`
4. `<`, `<=`, `>`, `>=`
5. `+`, `-`
6. `*`, `/`, `%`
7. unary `-`, `!`
8. member access, calls, indexing, and ranges

Binary operators are left-associative. Parentheses override precedence. Ranges use `start .. end` or `start ..< end`; audiovisual source ranges conventionally use the exclusive form.

## 2. Module structure

A module contains top-level declarations:

```text
module      = declaration*
declaration = language | project | import | asset | const |
              function | component | timeline | export
```

Every checked module must contain exactly one language declaration:

```cut
cut 0.4;
```

Other language versions are rejected by this compiler.

### 2.1 Project

```cut
project "Human-readable project title";
```

A project declaration supplies `CutAVIR.project`. An entry source requires exactly one project declaration. A project-relative user module must not declare a project.

### 2.2 Imports

```cut
import { Video, Text as Label } from "cut:visual";
```

Imports are named and may be aliased. The checker resolves built-ins and
verified local/file source packages against versioned manifests. A source
package may currently export public CUT components; its signature is derived
from the parsed declaration and its body expands with package provenance into
ordinary typed IR.

A specifier beginning with `.` is instead a user-authored source module. It
must use the canonical project-root-relative form `./path.cut`; it is never
resolved relative to the importing module. Empty/dot/dot-dot segments,
backslashes, absolute paths, missing/non-file targets, symlinks, realpath
escapes, cycles and duplicate imports fail closed. User modules can export
typed compile-time values, bounded pure functions, collections and components.
Module-owned assets/timelines and callable aliases/re-exports are not supported
in this slice. See [USER_MODULES.md](USER_MODULES.md) for the executable path,
limits and diagnostics. An unknown package, module, or symbol is a compile
error.

Core constructors and functions from `cut:core` are implicit: `video`, `audio`,
`image`, `font`, `data`, `caption`, `transcript`, `lut`, `imageSequence`,
`seconds`, and `render`.

### 2.3 Assets

```cut
asset footage: VideoAsset = video("media/interview.mov");
asset ambience: AudioAsset = audio("media/room.wav");
asset offline: VideoAsset = video("media/camera-master.mov", proxy: "media/camera-proxy.mp4");
asset multicam: VideoAsset = video(
  "media/program.mkv",
  videoStream: 2,
  audioStream: 3,
  proxy: "media/program-proxy.mkv",
  proxyVideoStream: 0,
  proxyAudioStream: 1,
);
asset translation: AudioAsset = audio("media/languages.mkv", stream: 4);
asset portrait: ImageAsset = image("media/portrait.jpg");
asset inter: FontAsset = font("fonts/Inter-Regular.ttf");
asset stations: DataAsset = data("data/stations.json");
asset subtitles: CaptionAsset = caption("captions/interview.vtt", format: "webvtt");
asset words: TranscriptAsset = transcript("transcripts/interview.cut-transcript.json");
asset grade: LUTAsset = lut("looks/interview.cube");
```

An asset must be a direct call to a known asset constructor with a path that lowers to a compile-time string. The path is resolved relative to the directory containing the `.cut` program. Declaring an asset does not read it during parsing or type checking; `cut lock` resolves and hashes it.

For `video` and `audio`, the optional proxy is the second declared parameter:
`video("master.mov", "proxy.mp4")` and
`video("master.mov", proxy: "proxy.mp4")` are exactly the same public
semantics. Both forms lower the proxy locator into typed project resources;
an accepted positional proxy is never discarded.

Asset constructors are legal only as the direct initializer of an `asset`
declaration. Using `video(...)`, `audio(...)`, `image(...)`, `font(...)`,
`data(...)`, `caption(...)`, `transcript(...)`, or `lut(...)` in a `const`,
`let`, nested call, or ordinary expression is a check-time error rather than a
deferred lock/runtime failure. Asset aliases must reference the original
declared asset directly; a second `asset` declaration cannot be initialized
from another asset value. `imageSequence(...)` is instead a compiler-owned
derived source value: it binds an explicit ordered list of already-declared
`ImageAsset` members and one strict manifest `DataAsset`, and is consumed by
the direct `ImageSequence` component. See [IMAGE_SEQUENCE.md](IMAGE_SEQUENCE.md).

Asset declarations may refer to compile-time top-level string constants. Top-level values are dependency-resolved, so a value may refer to one declared later. Cycles are rejected with the dependency chain.

`video` and `audio` accept one optional project-relative `proxy` string. Their
complete media signatures are:

```cut
video(path, proxy?, videoStream?, audioStream?, proxyVideoStream?, proxyAudioStream?)
audio(path, proxy?, stream?, proxyStream?)
```

The stream arguments are non-negative safe-integer **absolute** stream indexes,
the same indexes printed by ffprobe and accepted by FFmpeg mappings; they are
not per-type `v:0`/`a:0` ordinals. Named spelling is recommended. Master and
proxy selectors are independent because remuxing commonly changes absolute
indexes. A proxy selector without `proxy` fails during checking. An explicit
`audioStream` on a `VideoAsset` is semantic even when its current consumer is
picture-only: CUT locks that sound stream rather than silently discarding the
accepted argument.

For every consumed media type, omission is legal only when the probed variant
contains exactly one candidate of that type. Zero candidates or an explicit
index that is absent or wrong-type fails source-located as
`CUT_MEDIA_STREAM_NOT_FOUND`; multiple candidates with no selector fail as
`CUT_MEDIA_STREAM_AMBIGUOUS`. CUT never guesses from default dispositions and
never rounds selectors. Typed IR retains master/proxy authored selections;
lock, inspect, semantic diff, profile execution and cache identity all preserve
the selected variant. `cut lock` accepts a proxy only after proving exact
selected-stream start/duration and temporal frame/sample mapping; both files
receive independent byte hashes and probes. Audio proxies additionally require
a bounded decoded-content alignment witness. Picture proxies require a bounded
decoded RGB frame-correspondence witness, so matching cadence alone cannot
prove matching imagery. Image/font/data constructors reject proxy and stream
selectors. See [PROXIES.md](PROXIES.md).

### 2.4 Constants

```cut
const accent: Color = #22d3ee;
const sceneLength: Time = 3s;
```

Top-level constants are compile-time values. Their type can be annotated or inferred. Because top-level code has no FPS, `const sceneLength = 72f;` is invalid; use seconds at top level or a frame expression inside a timeline, scene, or component invocation.

### 2.5 Pure functions

```cut
function twice(value: Length) -> Length = value * 2;
function offset(value: Time, by: Time = 250ms) -> Time = value + by;
```

Functions require typed parameters, an explicit return type and one expression
body. They accept and return compile-time value types only. Recursive calls,
node/timeline/asset values and any read/analyze/generate/external or node call
are rejected. The compiler evaluates function calls into resolved typed IR; no
runtime interpreter or unevaluated user call is emitted. Function expansion is
bounded by 64 nested expansions, 100,000 calls and 1,000,000 value nodes.

### 2.6 Components

```cut
component TitleCard(title: String, accent: Color = #22d3ee) -> Visual {
  set self.opacity = 0%;
  animate self.opacity from 0% to 100% over 12f;
  Group() {
    Rect(width: 960px, height: 180px, fill: #071019e8, radius: 18px);
    Text(content: title, font: inter, size: 64px, color: accent);
  }
}
```

Parameters require types and may have compile-time defaults. The optional return type defaults to `AVNode`; authors should state `Visual`, `AudioNode`, or `AVNode` explicitly for ordinary components. Body node domains must be compatible with the declared result. Invocation child blocks use that same declared policy: `Visual` accepts only visual children, `AudioNode` accepts only audio children, and `AVNode` accepts either domain.

`DiagramNode` is the one structural component result. A component may declare
`-> DiagramNode` only when its body contains exactly one direct DiagramNode
node statement and no binding, control-flow or automation sibling outside that
node. Such a component cannot accept invocation children. At each call site it
expands transparently to exactly one `cut.diagram.node`, which remains a direct
child of its `DiagramLayout`; no `cut.kernel.fragment` is inserted. Definition
and invocation provenance are preserved on the expanded node. This rule works
across project-module imports and cannot be used to make an orphan DiagramNode,
hide extra layout children or bypass DiagramNode's closed local visual body.

Inside a component declared `-> Visual`, `self` is an implicit writable `Visual` reference to that invocation's fragment. Its closed executable property set is `opacity`, `x`, `y`, `scale`, and `rotation`; unsupported properties fail during checking. `self` is reserved and cannot be redeclared as a parameter, local, loop, or node binding, and it is unavailable in `DiagramNode`, `AudioNode`, or `AVNode` components and at non-Visual call sites. Invocation child blocks retain their call-site scope: they never inherit the callee's `self`, while an enclosing Visual component's own `self` remains in scope normally.

Except for the structurally closed `-> DiagramNode` case above, the compiler expands each invocation into a `cut.kernel.fragment` node whose children are the component body followed by any explicit invocation children. Writes through `self` attach ordinary signals to that fragment; they add no operation or special runtime primitive. IR provenance records both the definition and invocation spans. Components are ordinary language abstractions; the runtime does not receive film-specific component names or code.

The `0.4.0-alpha.3` reference runtime executes one closed retained-component
shape: a pure `-> Visual` invocation used directly as a scene visual root may
lower to one `cut.kernel.fragment` whose only child is one
`LocalSpace`. The fragment and `LocalSpace` must have exactly equal intervals;
the fragment has no runtime inputs or editorial payload after compile-time
parameter substitution. Only fragment `opacity`, `x`, `y`, `scale`, and
`rotation` execute. Anchor and skew, LocalSpace/body siblings, nesting beneath
any owner, fragment nesting, and composition-root use fail source-located; they
are not accepted as no-ops. Component names never select a runtime path.

For every output composition frame, CUT constructs one affine aggregate before
any retained tile is requested. It covers every admitted affine `LocalSpace`
owner in the active scene, actual parent-LocalSpace destinations as well as the
delivery canvas, and every executed `MotionBlur` shutter-sample placement.
Visible entries share caps of 256 transforms, 1 GiB of live output surfaces,
and 2 GiB of unscheduled peak work. Exact-zero opacity and supported tracking-
policy hides request no tile and consume none of those budgets. Component
admission uses one linear IR index rather than rescanning the graph per invocation.

Zero-skew entries that remain admitted by the historical RGB16 path retain
transform-work V2 identity byte for byte. Any nonzero admitted skew uses V3,
which models the installed scale -> simultaneous two-axis shear -> rotation
path; a mixed V2/V3 frame receives one V3 aggregate. A zero-rotation uniform
resize whose historical RGB16 intermediate alone would exceed the unchanged
512 MiB per-transform ceiling uses V4 planning and samples the original
retained RGBA8 tile once into the exact clipped destination. V4 retains every
existing source/destination/composition ceiling and refuses rotation/skew; a
mixed aggregate containing V4 is identified as V4. This changes resource
admission, not structural syntax:
ordinary `MotionBlur { Group { LocalSpace { ... } } }` remains unsupported,
as do general component nesting and the other boundaries above. Projective
`PlanarTrack` and `Plane3D` keep their separate projective budgets.

### 2.7 Timelines and scenes

```cut
timeline main(
  duration: 240f,
  fps: 24,
  width: 1920px,
  height: 1080px,
  sampleRate: 48khz,
) {
  scene opening(duration: 96f) {
    // audiovisual statements
  }

  scene resolution(duration: 144f) {
    // audiovisual statements
  }
}
```

`duration:` and `fps:` are required. `width:` and `height:` default to 1920×1080; `sampleRate:` defaults to 48 kHz. Width, height, and sample rate must evaluate to exact positive safe integers in their declared units. CUT never rounds a fractional canvas or sample rate into different executable semantics; it reports source-located `CUT_TIMELINE_INTEGER` instead.

A scene requires `duration:` and may declare `at:`. Without `at:`, it starts at the end of the furthest preceding scene. Scene intervals must be positive and remain within the timeline. The compiler can represent explicit placement; the current reference runtime imposes the stricter rule that scenes are contiguous, non-overlapping, declared in playback order, and cover the timeline exactly.

Timeline-level audio graphs are legal. The current reference runtime requires visual and linked audiovisual roots to be inside scenes.

### 2.8 Exports

```cut
export release = render(main, width: 1920px, height: 1080px, codec: "h264");
```

In the project entry source, an export expression must have type `RenderTarget`.
It names one output and points at a timeline plus target parameters. An entry
can define multiple render exports; the selected output is explicit at the CLI
or defaults to the first.

In a user module, `export publicName = expression;` exposes one supported
compile-time value. Exporting a function or component requires the expression
to directly name a function or component declared in that module. All other
declarations remain private.

## 3. Type system

CUT 0.4 performs static checking before graph lowering.

### 3.1 Primitive and structural types

- `String`, `Bool`/`Boolean`, and `Color`;
- dimensional quantities such as `Number`, `Time`, `Beat`, `Length`, `Ratio`, `Angle`, `Gain`, `Frequency`, `Loudness`, and `TruePeak`;
- homogeneous `List<T>`/`Array<T>`;
- `Range<T>`;
- inferred structural records from object literals;
- nominal media, graph, and domain types.

Known nominal types include `VideoAsset`, `AudioAsset`, `ImageAsset`,
`ImageSequenceAsset`, `FontAsset`, `DataAsset`, `CaptionAsset`,
`TranscriptAsset`, `LUTAsset`, `Data`, `Visual`, `DiagramNode`, `AudioNode`,
`AVNode`, `Timeline`, `RenderTarget`, `Easing`, `Vec2`, `Vec3`, `GeoPoint`,
`NoteEvent`, `TempoPoint`, `TempoMap`, `TranscriptEdit`,
`TranscriptMediaAuthority`, and `EditorialTransaction`. `TranscriptEdit` is the
closed scene-local compile-time selection described in section 6.4.2;
`TranscriptMediaAuthority` is its optional compile-time independent-media clock
authority. Neither is a runtime graph node. `EditorialTransaction` is
non-rendering and statement-scoped; it is not a general value or graph-node
type. `DiagramNode` is the closed structural visual result accepted as a direct
`DiagramLayout` child; its special component-expansion rule is defined in
section 2.6 and [Deterministic diagram layout](DIAGRAM_LAYOUT.md). `NoteEvent`
is the closed structural union accepted by `Synth`: exact `start`, `duration`,
and `velocity` fields plus exactly one of scalar MIDI `pitch` or `hz`
`Frequency`. The `@cut/audio` function `note(Time, Time, Number, Ratio)` is a
package-declared compile-time constructor for the MIDI-pitch record variant; it
emits no operation. `tempoPoint(Time, Number)` and
`tempoMap(List<TempoPoint>)` likewise construct closed compile-time records
consumed by `TempoDelay`; they do not analyze media or emit operations.
`Evidence` is a package component returning `Visual`; there is no separate
free-form nominal Evidence value that could bypass its locked resource
contract.

`Vec2` is the closed structural record `{ x: Length, y: Length }`. The reference
`Path` kernel accepts 2 through 4096 such points, bounds each coordinate to
±65536px, and requires a positive stroke width no greater than 4096px. Its
current primitive is an open stroked polyline; `fill` is refused rather than
silently ignored until closed-path semantics are specified.

`Trace` shares that exact geometry envelope and reveals the open polyline by
cumulative Euclidean arc length over an exact local `duration` after an optional
`delay`. An optional endpoint head follows the same prefix, then fades while the
completed stroke remains. Its closed timing, easing, head, interval, and
transform contract is specified in [Deterministic path tracing](TRACE.md).
Timing boundaries stay rational until the sampling decision. The runtime
prepares cumulative lengths once, uses binary-search prefix lookup, caches the
completed stroke, and enforces exact reachable point-frame budgets.

`Evidence` is a closed documentary integrity component, not a free-form text
alias. It takes a locked strict `cut-research` v1 `DataAsset`, exact `claimId`,
locked fixed `FontAsset`, explicit geometry/colors, and an optional closed
`mode`. `claim-card` is the pixel-stable default and shows source identity plus
the bounded claim. `source-chip` shows only a compact derived source label, with
`size` as its visible label size. Both emit only locked glyph paths. Their
schema, layout, resource, and failure semantics are specified in
[Locked Evidence](EVIDENCE.md).

`AVNode` is the common accepted result type for visual, audio, and linked audiovisual nodes. `GeoPoint` is structurally compatible with a record containing `latitude` or `lat` and `longitude`, `lon`, or `lng`, where both fields are scalar or angle quantities.

### 3.2 Dimensional arithmetic

Addition and subtraction require matching dimensions. Multiplication is implemented when either operand is scalar. Division by a scalar preserves the numerator dimension; division of matching dimensions returns a scalar. Modulo requires matching dimensions. Comparison requires compatible types.

```cut
const valid: Time = 3s + 250ms;
const alsoValid: Length = 2 * 40px;
const invalid = 3s + 4px; // type error
```

The compiler evaluates operations it can prove at compile time and otherwise retains an expression in IR. Release IR must pass the unresolved-value validator; symbolic values cannot leak into executable resource, interval, signal, or output fields.

### 3.3 Calls and named arguments

Calls accept positional arguments followed by named arguments. Positional arguments cannot follow a named argument, and a parameter cannot be supplied twice. Required parameters, declared parameter types, and unexpected names are checked against the package or component signature.

Package manifests may retain open named property bags while APIs stabilize, but
built-in node invocations are additionally checked against the closed executable
kernel registry. A named input absent from that registry is a source-located
error. The reference runtime consumes the same registry and revalidates loaded
IR, including input names, properties, child policy, domain, and signal
references. A package export is therefore not, by itself, a support claim.

### 3.4 Node properties

The type system has names for the intended visual and audio property families,
but a bound built-in node exposes only the properties listed for its executable
kernel. The reference backend currently executes `opacity`, `x`, `y`, `scale`,
and `rotation` on supported visual kernels, `reveal` on the registered reveal
kernels, and `exposure`, `temperature`, `tint`, `brightness`, `hue`, `contrast`,
and `saturation` on `ColorGrade`. Grade properties are sampled from exact CUT
signals at each frame. Exposure executes in linear-light sRGB stops before the
bounded creative temperature/tint balance; the legacy modulation and contrast
stages follow in a fixed documented order. These creative controls are not
Kelvin/camera white-balance metadata or an end-to-end color-management claim.
Properties such as `blur`, `sourceTime`, and unsupported audio automation are
refused rather than accepted as no-ops. See [COLOR.md](COLOR.md).

Node properties are write-only targets of `set` and `animate` in CUT 0.4. A member expression such as `layer.opacity` is rejected in every value/read context; there is no implicit sampling of a signal or compile-time property getter. Authors who need the same value for a write and another expression keep that value in an explicit immutable binding.

## 4. Statements and graph construction

### 4.1 Node statements and child graphs

```cut
Video(source: footage, range: 0s ..< 4s, fit: "cover") as background;

Gain(amount: -8db) {
  AudioClip(source: ambience, range: 0s ..< 4s);
}
```

A rendering call used as a node statement must return `Visual`, `AudioNode`, or
`AVNode`. `as name` binds the emitted node for later properties, animation, or
node-reference inputs. A child block is permitted only when the component
manifest allows the corresponding child domain.

Typed non-rendering authoring declarations are the explicit exception to that
node-return rule. In particular, `MatchSubject` and `MatchTransition` return
`EditorialTransaction` and are valid only as direct scene and timeline
statements respectively. They emit typed `semanticMatches` records rather than
render nodes, cannot be used as expressions or `let` values, and reject both
`as` and child blocks. This statement-only role is sometimes described as a
match declaration; `MatchDeclaration` is not a second public nominal type.

Root node order is source order and defines visual compositing order and deterministic audio graph traversal. Child order is likewise preserved in CutAVIR.

In the current reference picture backend, primitive `x`/`y` inputs are canvas coordinates (`Rect`/`Circle` use a center; `Text` uses its text anchor/baseline), while a visual container's `x`/`y` is a translation of its composed child surface. `Group` additionally accepts static or signal-driven `anchorX`/`anchorY` lengths and `skewX`/`skewY` angles from -30 through 30 degrees. An anchor is an offset from the local composition centre; `x`/`y` names that pivot's destination relative to the destination composition centre. The default anchor and position are both `(0px, 0px)`. Its closed transform order is child composition, pivot subtraction, uniform scale, one simultaneous two-axis shear matrix, rotation, translation of the pivot to `x`/`y`, then opacity. Nested groups therefore form an explicit inner-to-outer ordered transform stack; reversing two nested groups is observably different.

A `Camera2D` with exactly one direct `LocalSpace` child and no siblings takes a
separate retained path. CUT first materializes the bounded local tile, registers
it at the LocalSpace origin, then applies scale, rotation, delivery translation
to composition centre plus camera `x/y`, and opacity. Every public Camera2D
control is typed and animatable; anchor and skew are not camera controls and a
forged value fails. Camera-only edits preserve local-tile identity while
changing placement identity. Every other Camera2D graph retains the historical
delivery-canvas behavior. A real resize with fractional final placement uses
one exact-Q16, destination-clipped associated-alpha sample from the original
tile. Admitted integer-phase output preserves its existing bytes; only a
zero-rotation resize whose old RGB16 intermediate would exceed the unchanged
512 MiB ceiling enters the same clipped direct sampler under V4 allocator
evidence. See [`CAMERA2D.md`](CAMERA2D.md) for the exact graph, diagnostics,
work limits, evidence, and nonclaims.

`MediaCamera2D(focusX?: Ratio, focusY?: Ratio, zoom?: Number, rotation?:
Angle, opacity?: Ratio, edge?: String)` is a separate source-resolution
affine camera for exactly one direct Image/Video branch, optionally under the
closed native finishing chain in [`MEDIA_CAMERA2D.md`](MEDIA_CAMERA2D.md). It
must be either a direct full-interval scene root or the sole structural child
of one `ResponsiveSlot`. The latter carries a compiler-owned exact/raster slot
context and permits only local writes to that same camera's five signal-driven
controls. After native crop and finishing, `fit` computes scale without making
a fitted raster; the post-crop focus point maps to the active output centre
under fit times zoom, rotation is about that centre, and opacity follows one
direct inverse-Q16 associated-alpha bilinear sample. The active output is the
composition for a direct root and the actual slot surface for a responsive
camera. Slot placement is one integer translation plus half-open clip with no
second geometric resample. Focus and opacity are bounded to `0%..100%`, zoom
to `1..8`, rotation to `-360000deg..360000deg`, and `edge` is exactly
`"transparent"` or `"clamp"`. Media spatial transforms, properties, siblings,
arbitrary effects/subtrees, other indirect placement, and all-default or
always-transparent cameras fail; no accepted argument is ignored. See
[`MEDIA_CAMERA2D.md`](MEDIA_CAMERA2D.md) for executable Video/color inputs,
sampling and edge semantics, diagnostics, a complete recipe, and nonclaims.

At most one aliased slot camera per ResponsiveStack becomes visible after that
stack in its immediate lexical scope. Existing `visualAnchor` may use that
alias as a source-pixel owner; the compiler/loader rederive the exact
camera→slot→stack ancestry and the runtime composes source-to-slot Q16 with the
slot's integer translation into composition pixels. The alias cannot cross a
component invocation. One exact exception executes within an invocation: an
expanded pure, input/property-free, complete-interval identity Visual fragment
may retain ResponsiveStack first and then one anchored Path and/or
CalloutLayer. Every anchor names the same sole slot camera; definition and
call-site provenance, including imports, authenticate its descendants. CUT
dispatches those children in source order with zero fragment raster,
allocation, transform, clip or resample work. Other nested CalloutLayers,
partial/transformed fragments, MotionPath or extra overlay kinds in this
fragment, let-bound rendering nodes, and cross-invocation owners remain
unsupported. Same-module definition/invocation symbols are exact; imported
definitions retain their defining symbol while the invocation uses the public
call-site symbol.

`MatchSubject(id:, subject:)` and `MatchTransition(...)` provide one bounded
cross-scene retained handoff. A subject declaration directly names a
scene-root `Camera2D` whose only child is one equal-basis `LocalSpace`; a
transition declaration directly names two such subjects on the exact adjacent
scene boundary. The outgoing and incoming half-windows execute inside their
ordinary scene renders before the existing hard concat. Authored target
position, scale and unwrapped rotation execute on both sides; optional color
converges through the documented linear-light chroma transform. `settle`
provides zero endpoint slopes and `carry` provides one exact C1 translation
velocity while refusing animated source positions. Formatting and comments do
not affect the optional typed `semanticMatches` identity. Side-local picture
cache projection, inspect state, semantic-diff entries and completed frame-v2
receipts are closed; audio is unaffected. Precomp/NestedSequence sources containing match
declarations fail with `CUT_MATCH_NESTING`, and OTIO export/import reports
`CUT_OTIO_SEMANTIC_MATCH_UNSUPPORTED` instead of inventing a dissolve. This is
not content-aware matching, shape morphing, optical flow, tracked/geographic
correspondence, audio transition behavior or automatic taste. See
[`SEMANTIC_MATCH.md`](SEMANTIC_MATCH.md).

Retained placement is CUT-owned for `Fragment`, `Precomp`, `Group`, `Stack`, `Composite`, `Mask`, `Camera2D`, and `ColorGrade`, and the same final placement path applies to every other rendered visual transform. `Image` and `Video` expose optional `x: Length` and `y: Length` on their public constructors; these are compositor translations, default to `0px`, and become the exact pre-event baseline when the same property is automated. CUT computes continuous `left`/`top` after child composition/effects and scale → skew → rotation, quantizes only the fractional phase to 1/65,536 pixel, and samples the transformed surface with a zero-extended separable bilinear kernel. Fractional sampling associates encoded-sRGB bytes with alpha, uses deterministic round-half-up, unassociates to the declared straight-RGBA boundary, and clears RGB whenever output alpha quantizes to zero, so hidden RGB cannot contaminate a resampled edge. Integer phases bypass filtering and preserve every straight-RGBA byte, including independent hidden RGB. Opacity follows translation. Thus signed half-pixel `x`/`y` and transformed `Group` anchors have exact analytic coverage rather than backend-dependent rounding. The input transformed-surface limit is 67,108,864 pixels and the output canvas limit is 16,777,216 pixels; malformed positions/surfaces/work fail with stable `CUT_VISUAL_SUBPIXEL_*` diagnostics.

`ParallaxCamera(focalLength:, ...)` is a separate deterministic 2.5D materialization boundary over 2 through 64 direct `DepthLayer(depth:, edge:)` planes. It is not `Camera3D`. One typed camera x/y/z path derives `scale = focalLength / (focalLength + depth - z)` and `C + scale * (p - C - camera.xy)` for every active plane; greater depth is farther. Depth order is default, source order is accepted only when an executed active subset changes paint order, and every layer explicitly chooses transparent or already-materialized-border clamp behavior. Optional linear focus derives a delivery-pixel raw sigma and executes `0px` below the public `0.3px` deadband, otherwise the exact bounded alpha-coupled Blur. The runtime budgets direct child surfaces, layer composites, clamp extensions, exact rounded resize intermediates, projected/focus outputs and camera composites per camera and across simultaneous cameras on composition-absolute frame time. Outer MotionBlur is refused in v1 because shutter subframes are outside this proof domain. Recursive subtree/native scratch bounds and the generic selected-stream graph-cache key remain partial. The closed formula, diagnostics and limitations are in [`PARALLAX_CAMERA.md`](PARALLAX_CAMERA.md).

`Camera3D(focalLength:, x?:, y?:, z?:, targetX?:, targetY?:, targetZ?:, roll?:)` is a direct scene-root bounded retained planar-3D camera over 2 through 16 direct `Plane3D` children. Every plane requires `z:` and `edge: "transparent"`, owns exactly one direct `LocalSpace`, and exposes animatable x/y/z rotation, uniform scale and opacity. Coordinates are x-right/y-down/z-away; the default look is from `(0,0,0)` toward `(0,0,1000)`. Registration, scale, Rx, Ry, Rz and world translation map each local outer-edge rectangle into world space, then the look-at view and `screen=C+f*[x/z,y/z]` derive one exact-Q16 projective warp. Disjoint projected quads retain source-stable ordering; touching/overlapping quads require strictly separated camera-depth intervals and paint far to near. Near-plane crossing, backfaces, intersecting/crossing depth, meshes, lights, z-buffer, depth-of-field and outer MotionBlur fail explicitly. Camera/plane samples are preflighted on every exact output frame; permanently transparent or off-output planes fail as no-ops. Inspect, semantic diff, split tile/projection/composite cache identities and closed same-frame frame-v2 evidence expose the executed matrices, quads, paint order, hashes and work. See [`CAMERA3D.md`](CAMERA3D.md) for the normative limits and diagnostics.

`MapCamera(latitude?: Number, longitude?: Number, scale?: Number, bearing?: Angle, pitch?: Angle)` is a scene-root-only retained geographic camera with bounded flat-plane projection. Direct `Map(detail:)`, `Route`, `RouteSubject`, `Marker`, `Wavefront`, and canonical `GeoAnnotation { LocalSpace { ... } }` children share one exact Natural Earth projection, one clipped final-space drawing stream, one delivery-size geo raster and zero resize/resample passes. Camera scale moves geometry without scaling delivery-pixel strokes or radii. Bearing defaults to `0deg`, is animatable, and first computes `q_t(g)=C+R_b(t)(scale(t)*(P(g)-P(center(t))))`. Positive bearing is clockwise compass/camera heading, so geography rotates counterclockwise on screen. Authored and sampled bearing remains unwrapped within `[-360000deg,360000deg]`; CUT performs no implicit shortest-path interpolation and derives only the effective projection angle modulo 360 in `[0deg,360deg)`. Pitch is a second animatable `Angle`, defaults to `0deg`, and is bounded to `[0deg,60deg]` without wrapping. With delivery-height focal distance `d=H`, offsets `u=q.x-C.x`, `v=q.y-C.y`, and pitch radians `p`, CUT then computes `den=d-v*sin(p)`, `Q.x=C.x+d*u/den`, and `Q.y=C.y+d*v*cos(p)/den`; positive pitch is top-far/bottom-near. Pitch zero takes an exact no-projective-work branch that preserves the v2 arithmetic/pixels. Nonzero pitch inverse-projects the delivery corners, refuses non-finite or nonpositive forward/inverse denominators, bounds preimage expansion to `8x`, and admits at most 2,097,152 projected stream point events per sample before one final clip/raster. This is one flat plane, not terrain, buildings, occlusion, lighting, a globe, or `Camera3D`. A static north-up-equivalent bearing or `pitch: 0deg` is a no-op error, while an executing track may start at its default. A MapCamera body may automate only a child bound earlier in that same lexical body; forward, parent-scope and arbitrary control statements fail. `Connections`, marker label/font controls, child projection/scale/rotation, nested/precomposed MapCamera use and persistent MapCamera caching are unsupported and source- or runtime-refused. Current identities are planning receipt/camera v4, `cut-reference-natural-earth-map-camera-v3`, retained render receipt v5 with `cut-reference-map-camera-final-space-render-v5`, same-invocation `cut-reference-map-camera-public-frame-evidence-v5`, and MapCamera-owned `cut-reference-geo-annotation-map-v3`. Current v5 evidence reports the bounded renderer-invocation canonical-raster cache outcome and publishes a fresh exact-time execution receipt on both raster work and identity-matched reuse; it reports zero persistent cache reads/writes and does not establish cold/warm persistent locality or release performance. Historical nested v1/v2/v3/v4 evidence branches retain their closed meanings inside the outer frame-v2 manifest. Static inspect is planner evidence, not pixel or creative proof. See [`MAP_CAMERA.md`](MAP_CAMERA.md).

`RouteSubject(points:, progress?:, color?:, radius?:, opacity?:)` is
MapCamera-only. It samples two through 4,096 authored, unlabeled geographic
points by cumulative spherical great-circle angular distance using the
versioned `d3-geo` distance/interpolation law, then projects the resulting
point through the owning camera. Every consecutive pair must have positive
spherical distance; the planner admits at most 4,000,000
segment-by-exact-frame evaluations per camera and carries the prevalidated
distances into direct frame seeking. `progress` and `opacity` are animatable
ratios; radius is a delivery-pixel circle. The algorithm identity is
`cut-reference-map-camera-route-subject-v1`. Current-v5 frame evidence binds
each subject's segment count, exact-frame samples and product, then
semantically correlates their sums with the camera work counters. A zero-length segment, inert
control, unsupported property, hostile ownership or over-limit point list
fails before pixel execution. It is not a vehicle simulation, sprite system,
collision solver, trail, tangent/orientation or standalone projection.

`GeoAnnotation` has two explicit migration forms. Under `ParallaxCamera > DepthLayer`, the legacy `GeoAnnotation(anchor:, width:, height:, ...) { ordinary visual }` path still renders a full-composition child and applies the declared centered crop. Under either that owner or `MapCamera`, the canonical form is `GeoAnnotation(anchor:, ...) { LocalSpace(width:, height:, origin:) { ... } }`: viewport size comes from LocalSpace, the bounded local tile is rendered directly, and annotation width/height are forbidden. `leader` remains a required explicit policy; `leader: "none"` is admitted as the executable no-leader form and forbids inert leader styling, while `straight` and `elbow` require both color and width. MapCamera accepts only the canonical LocalSpace form and projects the anchor through its exact camera `Q_t`. Placement fallback, priority, opacity, safe-area, tile/resource work, inspect, semantic diff and frame-v2 evidence fail closed. See [`GEO_ANNOTATION.md`](GEO_ANNOTATION.md).

`CalloutLayer() { ... }` and
`Callout(anchor:, placements:, offset:, safeArea:, priority?:, leader:,
leaderColor?:, leaderWidth?:, opacity?:) { LocalSpace { ... } }` are the
camera-independent generic retained annotation boundary. A CalloutLayer is a
parameterless complete-interval direct visual scene root with 1 through 64
direct Callout children; each Callout owns exactly one equal-interval retained
LocalSpace tile. `anchor` is an explicit `SpatialPoint`: a raw Vec2 is already
in composition pixels, while `visualAnchor(owner:, local:)` and
`compositionOffset(point:, by:)` reuse the versioned anchored-coordinate wire.
A visualAnchor owner must be bound earlier in the same module and be an earlier
direct root in the same scene, or the sole MediaCamera2D child of one earlier
ResponsiveSlot/ResponsiveStack in the same immediate lexical scope. Runtime
sampling follows the owner's exact retained affine or locked MediaCamera2D
source-pixel basis. A slot camera additionally composes its admitted
source-to-slot Q16 affine with the exact integer slot placement. No content,
feature, or label anchor is inferred.

Within one layer, exact whole-number priority descending then source order
determines collision reservation. CUT tests the authored unique
right/above/below/left fallback list against the uniform safe rectangle and
previously accepted half-open rectangles, accepts the first eligible candidate,
and paints accepted Callouts in reverse resolution order. Offscreen anchors,
collision overflow, owner-policy hide, exact-zero opacity, and post-opacity
RGBA quantization are explicit bounded branches with no fabricated placement.
Only opacity is animatable; inert all-zero/all-default states and unknown
inputs/properties fail. The LocalSpace tile, affine admission, placement,
leader, output pixels and recomputable work/order identities are cross-bound in
current frame-v2 evidence. See [`CALLOUT_LAYOUT.md`](CALLOUT_LAYOUT.md) for
syntax, formulas, limits, diagnostics, evidence, workflow and nonclaims. This
is one pre-1.0 executable vertical, not a reviewed reference study or
professional-output pass.

Most children outside the declared retained boundaries are still rasterized to a canvas-sized intermediate before their container transform, so negative child coordinates can clip before translation. Two bounded families execute. First, an exact unary chain ending in retained `Path(geometry:)` permits any one-child nesting of `Group`, `Camera2D`, `MotionPath`, and prepared `Track2D`; it is sampled at exact composition time and composed outer after inner. CUT keeps trim/dash in Path-local arc-length space, derives conservative local/final paint bounds, performs one tight final-space vector raster with combined opacity through the locked Sharp/libvips backend, then one integer canvas placement. Second, `LocalSpace` materializes its bounded multi-layer tile before its declared owner transform, including the admitted local compositing subset below. Nodes outside those boundaries remain materialization boundaries. `MotionBlur` remains such a boundary and evaluates a fresh child chain at every exact shutter sample. Other leaves should still keep translated local pixels inside the canvas.

For axis-aligned retained scale/translation, CUT derives Q16 source coordinates
once per clipped destination row/column, then applies the frozen
associated-alpha bilinear law in exact source order. This removes the large
resize intermediate and avoids per-pixel BigInt homography evaluation without
changing admitted fractional pixels. Integer-phase transforms still use the
established byte path unless the old intermediate exceeds its unchanged safety
ceiling. Rotation/skew are not claimed by this direct subset. Broader retained
bounds, final-space adaptive cubic flattening, higher-order reconstruction
filters, scene-linear spatial resampling, GPU/native parity, and cross-platform
conformance remain missing; Q16 phase and 8-bit output quantization remain
intentional limits, while each retained slice binds its runtime identity in
cache/inspect evidence.

Within that exact retained chain, `MotionPath` establishes a subject-local
VectorPath basis: leaf coordinate `(0px, 0px)` maps to the sampled path point.
The basis is derived from the actual composition, appears in the composed
inspect matrix, and is covered by the retained-chain algorithm/cache identity;
authors must not add a canvas-half compensation Group. The separate bounded
`LocalSpace(width,height,origin)` primitive now supports true local
Rect/Circle/Path/Trace/MotionPath/Group/nested-LocalSpace and locked-font
Text/FlowText surfaces, including use as a MotionPath subject. An ordinary
`MotionPath(geometry: VectorPathGeometry) { ... }` descendant samples its path
in the authored LocalSpace basis, applies tangent orientation and its normal
transform stack, clips to the declared tile, and composites there before the
outer retained owner runs. Owner-resolved `AnchoredPathGeometry` is refused in
that position because it has no ordinary local basis. Local Trace executes the same
timed polyline/cubic cumulative-arc-length reveal and persistent tangent arrow
inside the bounded tile after the exact Q16-derived origin translation; a
delivery-canvas fallback is forbidden, and aggregate prepared geometry fails
before raster. Retained local compositing V1 additionally executes existing
public `Composite`, `Mask`, `ClipPath`, graphical `ColorGrade`, `Blur`,
`Vignette`, `Sharpen`, `Grain`, and `Duotone` descendants against the exact
declared straight-RGBA8 tile in authored depth-first order before owner
placement. Local dimensions govern clipping, validation, work, allocation,
semantic identity and completed-frame evidence; delivery-sized descendant
rendering is forbidden. A recomputed complete reachable graphical-subtree
identity makes leaf edits invalidate the plan/tile/picture path while unrelated
audio-only edits do not. `Shadow` and `Glow` fail because no public halo
expansion/clipping policy exists. Media beneath one of these wrappers fails
before decode, and MotionBlur/ChromaKey/LUT/TonalCurve/ColorConvert/Stack/
Precomp/Responsive/Diagram and nested camera/tracking graphs remain outside
this V1 boundary. See [`LOCAL_COMPOSITING.md`](LOCAL_COMPOSITING.md).
Retained-media composition v2 admits one
through sixteen source-ordered direct branches, each containing up to eight
unary Groups, at most one ColorGrade, and exactly one childless locked Image or
Video; ordinary bounded local raster siblings may appear anywhere in the same
direct-child paint order. Normalized crop is resolved in native source pixels,
grade precedes fit, and one Q16 alpha-associated affine samples each fitted
result into the local viewport before linear-light source-over, without a
delivery-sized media or composition preraster. Unsupported branch topology and
Q16-singular transforms fail source-located before source open. Current
exact-frame manifests expose v1 per-branch execution at
`execution.retainedMediaViewports` and additive ordered-composition execution at
`execution.retainedMediaCompositions`; inspect remains planner evidence. Exact direct
`Camera2D { LocalSpace { ... } }`,
`Track2D { LocalSpace { ... } }`,
`PlanarTrack { LocalSpace { ... } }`, and
`ParallaxCamera { DepthLayer { LocalSpace { ... } } }`, plus
`Camera3D { Plane3D { LocalSpace { ... } } }` owners consume that
retained tile through their public camera-affine, tracked-affine, projective, or depth-projection
semantics and emit completed-frame transform/work evidence. The admitted local
mask/clip/blend/finishing subset applies to ordinary graphical descendants; it
does not extend the retained Image/Video branch grammar. Layout ownership,
precomposition media leaves, and arbitrary camera/tracking descendants remain
unsupported.

Current exact-frame writers set `execution.evidenceProfile` to
`cut-reference-frame-execution/current-v2`. They emit
`execution.localSpaceExecutions`, ordered by stable renderer-instance path:
entry zero names the root composition, and later path segments identify each
public `Precomp` or `NestedSequence` instance and terminal source composition.
Each entry pairs that renderer's completed LocalSpace execution with its exact
affine preflight. `execution.localSpaceExecutionTree` is a closed v1 summary of
the exact renderer count, ordered path identity, ordered renderer-frame
identities, and final tree identity.

Publication uses one immutable structural index shared across the renderer
tree and requires a module-private `WeakSet`-branded same-invocation authority.
That authority is object-identity-bound to the exact locked IR, root
composition, complete receipt array, independently retained expected receipts,
and expected tree. Copying or spreading the authority does not preserve its
brand; a new successful frame revokes the prior authority and renderer close
revokes the current one.

The root same-frame evidence generation stays active until all tracked sibling
node-frame work drains, including siblings still running after another root
fails. Deactivation and detachment occur only after that drain, so late work
cannot charge a subsequent frame. A shared live ledger and a completed-tree
pre-scan count renderer wrappers, tiles, every embedded
`localCompositing.operations` entry, placements, execution skips, preflight
admissions, and preflight skips. The raw-record cap is 65,536. Each record also
charges its renderer execution-path depth against a 262,144-copy-unit cap.
Runtime refuses an over-budget reservation immediately; pre-scan rejects before
tree identity hashing or authority deep-copy. Root publication re-derives the
completed tree's exact record/copy totals and requires them to equal the live
ledger.

CUT then re-derives closed counters, tiles, placements, transform work, and
preflight identity from locked IR. It reconciles affine skips with an
exact-sample O(n) counted multiset over LocalSpace node, owner node, skip kind,
and canonical rational sample time, requiring a one-to-one match with no
leftovers. False component-fragment, `Track2D`, and `DepthLayer` evidence is
rejected. Persisted current-v1 validation also recomputes every receipt/frame
identity and the count/path/frame/tree identities, and reconciles the preserved
root fields. These hashes are an integrity closure, not a signature or a claim
that edited stored JSON is authentic; external manifest digest verification or
deterministic locked rerender remains necessary.

The profile, tree, and renderer array are optional only for frozen frame-v2
compatibility. Current writers always emit them, while historical
`execution.localSpaces` and `execution.localSpaceTransformPreflight` remain
present with their previous meanings.

At most one MotionPath may participate in one retained chain; nested
MotionPaths retain the ordinary materialization boundary, and a forged
double-basis chain is refused.

`MotionPath(points?:, geometry?:, progress:, closed:, orientToPath:)` applies
that same retained transform to exactly one visual child after sampling exactly
one bounded path form at constant cumulative arc length. `points:` preserves
the open/closed piecewise-linear form. `geometry:` consumes exact typed
`PathGeometry`: either static `VectorPathGeometry` or owner-resolved
`AnchoredPathGeometry`. Resolved line/cubic geometry shares retained Path's
bounded adaptive flattening and tangent. `progress` is a typed animated Ratio;
optional tangent orientation adds to authored rotation. Geometry owns closure,
so any authored `closed:` alongside `geometry:` is refused. For the points form,
when `closed` is true, a terminal point canonically equal to the first point is
refused as redundant; omitting it preserves the same closing edge. Explicit
`closed: true` and `orientToPath: true` controls must differ from their omitted
counterfactual on at least one exact reachable output frame. CUT checks up to
4,096 frames per control and fails closed when it cannot prove an effect.
The exact boundary and limitations are in [MOTION_PATH.md](MOTION_PATH.md).

`Trace(points?:, stroke:, width:, duration:, delay?:, headRadius?:,
headColor?:, headFade?:, easing?:, start?:, curves?:, arrow?:)` reveals either
an open polyline or a cubic-Bezier chain by prepared cumulative arc length.
Exactly one of `points` or `start + curves` is required. `cubicTo(control1:,
control2:, to:)` constructs a typed cubic segment; `traceArrow(length:, width:,
color:)` constructs a persistent tangent-oriented endpoint marker. See
[TRACE.md](TRACE.md) for exact timing, flattening, retained LocalSpace
execution, bounds and diagnostics.

`Path` has two exclusive forms. Legacy `points: List<Vec2>` retains its exact
open-polyline renderer and cache contract. Retained `geometry: PathGeometry`
accepts `VectorPathGeometry`, built with `vectorPath(start:, segments:,
closed:)`, `lineTo(to:)`, and `cubicTo(...)`; that static form executes
topology-safe `morphTo/morph`, cumulative-arc-length `trimStart/trimEnd`,
canonical `dash/dashOffset`, stroke, closed fill rules, and x/y placement.
`LinePathSegment` and
`CubicPathSegment` widen only toward `PathSegment`; `Trace.curves` remains
strictly cubic. A genuinely dynamic trim may have exact samples where
`trimStart == trimEnd`; a stroke-only sample is explicitly transparent and
bypasses retained raster/placement work, while a closed fill remains visible.
Static equal trim boundaries and any executed `trimStart > trimEnd` fail. Exact
output-frame preflight must still prove at least one visible active frame. See
[VECTOR_PATH.md](VECTOR_PATH.md) for exact bounds,
diagnostics, determinism, the exact unary retained-chain boundary, and the
remaining compositor limitations.

`AnchoredPathGeometry` is the second closed `PathGeometry` member. Public
`visualAnchor(owner:, local:)`, `compositionOffset(point:, by:)`,
`anchoredLineTo(to:)`, `anchoredCubicTo(...)`, and `anchoredPath(start:,
segments:, closed:)` lower to versioned pure IR calls; a raw `Vec2` is also a
composition-space `SpatialPoint`. At least one point must be a VisualAnchor.
Its owner is same-module and earlier-bound, shares the reachable scene and
interval, and exposes exactly one LocalSpace whose owner kind is
`scene-root`, `component-fragment`, `group`, `camera-2d`, or `track-2d`.
Consumers remain in root composition space. Exact render-time placement keeps
opacity-zero coordinates, while Track2D hold/hide/fail respectively resolves,
suppresses dependent work, or aborts. V1 refuses morphing, projective or
MotionPath owners, nested LocalSpace consumers, and stacked bases. Inspect
reports validated bindings and structural plans with
`requiresExactOwnerPlacement: true`; it never fabricates pre-render
coordinates. Geometry and owner placement/local-basis identities participate
in semantic diff and localized cache identity. See
[VECTOR_PATH.md](VECTOR_PATH.md).

An additive anchored-path v2 binding also accepts a direct scene-root
`MediaCamera2D` as the owner without introducing a fake `LocalSpace`. Its
`local` coordinate is an exact pixel centre in the locked post-crop source
basis, including fractional pixels, with closed bounds
`[0, cropWidth - 1] x [0, cropHeight - 1]`. Resolution reuses the exact
admitted Q16 camera affine before opacity and performs no second decode, grade,
preraster or resample. Crop/fit/output basis and focus/zoom/rotation affect
spatial identity; audit-only opacity, grade and source-byte evidence does not
when the affine is unchanged. Completed frames use the closed anchored-path v2
evidence branch while LocalSpace v1 remains wire-compatible. This is authored
source-coordinate binding, not tracking, feature extraction, object
understanding or projective correspondence.

The same v2 binding accepts one slot-bound MediaCamera2D alias used after its
ResponsiveStack in the immediate lexical scope. Resolution composes the
source-to-slot Q16 affine and zero-resample integer slot placement into an
exact source-to-composition affine. Completed frames cross-bind the
Path/MotionPath or Callout anchor receipt, camera receipt and ResponsiveStack
placement receipt in `execution.responsiveSlotMediaAnchors`. Other nested
owners and cross-component alias escape remain explicitly unsupported. The
only component-local overlay form is the authenticated identity fragment:
ResponsiveStack first, then one anchored Path and/or one CalloutLayer against
that fragment's sole slot camera, all at the complete scene interval. Frame-v2
adds `execution.identityComponentFragments` to bind ordered children and the
camera/stack/path/callout/link ledgers while proving zero wrapper work. This is
not arbitrary component compositing; see
[MEDIA_CAMERA2D.md](MEDIA_CAMERA2D.md).

`Track2D(source:, minConfidence:, lowConfidence:, occluded:, outOfFrame:)`
binds exactly one retained visual to a strict locked `cut-track-2d` v1
`DataAsset`. It always binds exact composition-space position and can
independently opt into recorded uniform scale and rotation. Linear/hold
sampling uses the node-local exact rational source clock; confidence,
occlusion and out-of-frame states execute explicit fail/hold/hide policies.
The sidecar hash participates in graph/cache identity and malformed or
ambiguous bytes fail with source-located `CUT_TRACK2D_*` diagnostics. CUT does
not yet extract those observations from footage. See
[TRACKING_2D.md](TRACKING_2D.md).

`PlanarTrack(source:, minConfidence:, lowConfidence:, occluded:,
outOfFrame:, interpolation?:, opacity?:) { LocalSpace { ... } }` projects
exactly one direct, equal-interval LocalSpace tile through a strict locked
`cut-planar-track` v1 `DataAsset`. Sidecar TL/TR/BR/BL observations use exact
composition-pixel-edge coordinates and the node-local clock. Linear sampling
interpolates exact corner rationals only between two usable observations;
otherwise the authored fail/hold/hide policy applies without moving toward an
untrusted right endpoint. The sampled quad is the sole geometry authority:
PlanarTrack accepts no affine placement surface and only `opacity` may be
animated. Lock creation, full apply, verified-input sessions and render
preparation revalidate bytes and semantics. `cut inspect` exposes a static
planner projection; completed exact-frame evidence appears in
`execution.planarTracks` with the sampled Q16 quad, tile/projective/output
hashes, work, policy resolution and explicit zero-work skips. CUT plays supplied
observations; it does not extract, solve or smooth a track, infer occlusion,
create a matte, correct a lens or reconstruct a 3D camera. See
[PLANAR_TRACKING.md](PLANAR_TRACKING.md).

`stagger(index:, each:, offset:)` from `@cut/motion` is a pure compile-time
timing helper. It accepts an exact integer `index` in `0..4095`, positive exact
`each: Time`, and optional non-negative exact `offset: Time`; the result is the
canonical rational time `offset + index * each`. It can feed ordinary `delay`
and `at` syntax and is completely reduced before typed IR is emitted. Invalid
domains fail with source-located `CUT_MOTION_STAGGER` rather than rounding or
clamping.

`Precomp(source: Timeline, range?: Range<Time>, x?: Length, y?: Length,
scale?: Number, rotation?: Angle, opacity?: Ratio, editId?: String,
role?: String, metadata?: EditorialMetadata)` is a childless visual source
with a distinct composition clock. The compiler declares all timeline headers
before lowering bodies, preserves the source as an `IRValue.timeline-ref`, and
does not clone or flatten its nodes into the host scene. The current executable
subset uses one exact positive half-open source range (or the complete source
when omitted) and requires identical canvas, FPS, and sample rate; a
picture-only, contiguous, frame-exact source; an exact in-bounds destination;
and an acyclic bounded composition graph. Nested output is transparent. The
source composition's exact clocks, ordered scenes/items, roots, and transitive
node hashes participate in the instance hash. Inside `PictureTrack`,
`editId`/`role`/namespaced `metadata` are compiler-only editorial inputs for
the bounded canonical nested-edit slice and never enter renderer kernel
inputs. See
[PRECOMPOSITIONS.md](PRECOMPOSITIONS.md) for the closed contract and explicit
non-claims.

### 4.2 Local values and node references

```cut
let key = NarrationProgram();
MusicProgram(key: key);
```

`let` binds a compile-time value. When its expression constructs a node, that node receives `reference` ownership rather than becoming an audible/visible root. This allows references such as sidechain keys without accidentally rendering a second root copy.

### 4.3 Immediate property writes

```cut
set card.opacity = 0%;
```

`set` appends an exact-time `set` event to the property's signal track. The assigned value must match the property's dimension/type. Its start must lie inside the owning node's half-open interval; a write at the exact end is rejected because it would execute on zero samples/frames. Its value holds until a later event for the same property begins.

### 4.4 Animation

```cut
animate card.opacity from 0% to 100% over 12f delay 4f ease outCubic;
```

An animation appends one bounded `animate` event with exact start/end times, `from`, `to`, and curve values on the owning scene/timeline clock. Start and end values must match the target property type; duration and optional delay must be time quantities. Delay cannot be negative, duration must be positive, the start must lie inside the half-open owning interval, and the animation end may equal that interval's end.

Multiple writes to one property are stably merged by event start time. Source order breaks ties, so the last source write at an identical timestamp wins. The first ordinary non-audio visual/AV property track always carries one exact, non-null typed baseline. A closed compiler/runtime registry covers all 214 properties on the 40 supported kernels outside `MediaCamera2D`, whose source-resolution camera contract remains separate. A same-named constructor input supplies the baseline when it is the same control; otherwise CUT uses the property's exact public default. Primitive geometry inputs that merely share a spelling with an additional property transform remain independent—for example `Rect.x`, `Text.x`, `Chart.x`, and `Globe.x`. `Globe.rotation` is different: its constructor and property are one intrinsic projection control, so the constructor supplies the track baseline and the outer compositor never applies it a second time. Five controls require an explicit constructor baseline before automation rather than a guessed value: `DiagramLayout.progress`, `ParallaxCamera.focusDepth`, `Camera3D.focalLength`, `Plane3D.z`, and `Wavefront.reveal`. Strict current IR rejects missing, null, or conflicting ordinary baselines with `CUT_VISUAL_BASELINE`; producer-backed visual tracks retain their separately closed mapping baseline. Time before the first event never borrows a future animation's `from` value. A later event truncates an earlier animation that would otherwise still be active; values hold across gaps and after an animation ends. The reference signal evaluator executes linear interpolation, `outCubic`, parameterized cubic Bezier curves, and a deterministic mass/stiffness/damping spring. Cubic Bezier x controls are bounded to `[0, 1]`; spring parameters must be finite and positive. Invalid curves fail preflight at the easing source location instead of falling back to a different curve.

Canonical IR equality is recursive and exact across every value kind. A visual
or audio animation whose `from` and `to` endpoints are canonically equal is
therefore refused with the executable no-op contract. After ordinary signal or
audio-automation validation retains diagnostic precedence, visual constant,
step, keyframe, and track signals are sampled on the owning node's complete
reachable execution grid. Ordinary ancestors preserve exact scene-local output
time; each `MotionBlur` ancestor expands it with the same centered-shutter and
start-boundary planner as the renderer, including nested shutters. The complete
signal is compared with its signal-free input/default. Each step point,
keyframe, `set`, and animation is also compared with the same signal with only
that item removed. If the two executions are equal at every selected output or
temporal-exposure sample, the signal or named item is refused even when its
literal values differ. This closes late sub-frame writes, same-time shadowing,
redundant steps, and sample-grid-collinear keyframes without falsely rejecting
a write visible only inside a shutter. Traversal and item counterfactual work
share a 4,000,000-visit/comparison bound. A larger proof is refused with a
located complexity diagnostic rather than accepted after incomplete sampling.
Any changed selected execution sample keeps the signal item executable.

### 4.5 Time placement

```cut
at 900ms {
  Tone(frequency: 54hz, duration: 600ms);
}
```

`at` moves the local placement cursor by an offset relative to the current owning interval. Nested offsets accumulate. The offset must be non-negative and cannot exceed the remaining interval. Nodes, property steps, animations, and audio sample delays retain that exact placement in IR.

### 4.6 Compile-time branch and iteration

```cut
for point in points {
  Marker(point: point);
}

if showEvidence {
  Evidence(research: research, claimId: "measured-result", font: inter,
    x: 72px, y: 760px, size: 42px, color: #f4f6f2,
    accent: #53d8c8, maxWidth: 1180px);
} else {
  Text(content: "Evidence withheld", font: inter);
}
```

`for` requires a compile-time array. `if` requires a compile-time boolean. The compiler expands only the selected branch/iterations; CUT 0.4 alpha does not contain a general runtime VM.

### 4.7 Assertions

```cut
assert 149f + 187f + 216f == 552f, "The scene budget must remain exact.";

assert timelineDurationIs(main, 2s), "The final duration is exact.";
assert timelineHasNoSceneGaps(main) &&
       timelineHasNoSceneOverlaps(main), "Scene coverage is exact.";
assert timeIsOnFrameGrid(main, 1s) &&
       timeIsOnSampleGrid(main, 1s), "The boundary is representable.";

assert videoRangeWithinLockedMedia(picture, 1s ..< 3s),
       "The selected picture range exists on its locked frame grid.";
assert audioRangeWithinLockedMedia(dialogue, 1s ..< 3s),
       "The selected dialogue range exists on its locked sample grid.";
assert captionCoverageIncludes(main, 0s ..< 2s),
       "A scheduled caption renderer covers the delivery interval.";
assert deliveryTargetMatches(main, 1920px, 1080px, "h264", "rec709-limited"),
       "The required managed delivery is actually exported.";
```

Assertions are preserved in CutAVIR with their typed expression, provenance,
message, and a derived `pass`, `fail`, or `deferred` status. Constant Boolean
expressions fold normally. The nine implicit `cut:core` domain predicates shown
above execute against the completed CutAVIR composition and scene graph, after
all timeline bodies have lowered, so moving an assertion before or after a
scene cannot change its result. Duration, scene intervals, FPS and sample-rate
checks use exact rational arithmetic; scene coverage is evaluated from sorted
half-open intervals rather than serialization order.

`videoRangeWithinLockedMedia` and `audioRangeWithinLockedMedia` deliberately
compile to `deferred` before a lock exists. Applying `cut.lock` embeds the exact
selected stream authority, recomputes the assertion, and updates its stored
status before final graph hashing. Each range must be non-empty, remain inside
the selected stream duration, and land on the selected picture-frame or audio-
sample grid. Missing, foreign, malformed, or changed lock authority fails
closed; an unlocked resource never guesses from a filename or container.

`captionCoverageIncludes` is intentionally a structural presentation
assertion. It computes the union of reachable `Captions` and
`TranscriptCaptions` node intervals in absolute Timeline time and requires that
union to cover the requested half-open range without a gap. It does **not**
claim that a sidecar contains every spoken word, that speech is intelligible,
or that a human approved caption quality. `deliveryTargetMatches` requires one
authored render-output contract for the Timeline with the exact canvas, codec,
and managed color contract (or the explicit `"legacy"` omission token). It
does not inspect an encoded file, mux, platform playback, or human delivery
review.

`cut test` recomputes supported predicates from final IR. The release runtime
does the same and refuses a failed result, an unsupported/deferred predicate,
or a stored status that disagrees with recomputation. Recognized malformed
calls fail with source-located stable `CUT_ASSERT_*` diagnostics. Scene-
interval, reachable-caption-node, and delivery-output visits share one bounded
aggregate final-graph budget across the complete assertion set rather than
resetting for every predicate. These predicates remain engineering assertions;
semantic caption completeness, platform playback and human delivery review are
separate gates.

Final-IR predicates are valid only inside an `assert` condition, including
direct `!`, `&&`, and `||` composition. They cannot initialize a constant/local,
appear in a pure function body, drive `if`, or serve as a node argument: their
truth intentionally does not exist until the graph is complete, and those uses
fail at the call with `CUT_ASSERT_CONTEXT`.

## 5. Time, intervals, and clocks

All compiled time values are reduced rational seconds represented as decimal strings in JSON numerators and denominators. Timeline FPS is also rational and may be expressed as an exact scalar expression such as `30000 / 1001`.

Scene start/duration, node start/duration, source ranges, signal times, and output duration therefore avoid cumulative floating-point timeline drift. A backend may convert rational values to frame or sample indices only at an explicit target boundary.

The reference picture runtime requires every scene duration multiplied by FPS to be an integer frame count. Executable audio placements and event/envelope boundaries must reduce to an exact integer sample at the timeline sample rate; the runtime refuses implicit rounding. Signals inside scenes are evaluated against the owning scene clock, including statements nested in `at` blocks.

## 6. Effects and capabilities

Package symbols declare one effect kind:

- `pure`: graph construction with no external read;
- `read`: access to an explicitly declared/locked resource;
- `analyze`: derived analysis that must become a locked artifact;
- `generate`: generative work that must become a locked artifact;
- `external`: another declared host capability.

The compiler emits non-pure/non-read effects as effect jobs. `cut lock` currently refuses unresolved effect jobs, and the reference runtime refuses any job that is not locked. No model-authored shell command is an effect mechanism.

The complete end state includes capability-bounded third-party effects. The
alpha has a public deterministic local/file resolver for source-level CUT
component packages, but it does not provide a registry or a production sandbox
for native/WASM/shader/audio plugins. The eight built-in visual effect wrappers
below are ordinary closed `pure` kernels, not plugin execution or an escape
hatch to a shell, shader, or model.

### 6.1 Bounded built-in visual effects

`Blur`, `Shadow`, `Glow`, `Vignette`, `Sharpen`, `Grain`, `Duotone`, and
`MotionBlur` are imported from `cut:visual`. Each is a unary retained wrapper:
it requires exactly one visual child, produces the same full-canvas dimensions,
and is applied after its child. Nesting therefore executes inner-to-outer in
authored source order. Zero or multiple children fail before cache lookup.

| Component | Typed inputs and reference defaults | Executable reference bounds |
| --- | --- | --- |
| `Blur` | required `radius: Length` | `0px` (identity) or `0.3px...64px`; radius is Gaussian sigma |
| `Shadow` | `x: Length = 0px`, `y: Length = 8px`, `radius: Length = 12px`, `color: Color = #000000`, `opacity: Ratio = 50%` | integer `x/y` in `-4096px...4096px`; radius as above; opacity `0%...100%` |
| `Glow` | `radius: Length = 16px`, `color: Color = #ffffff`, `opacity: Ratio = 50%` | radius as above; opacity `0%...100%` |
| `Vignette` | `amount: Ratio = 40%`, `radius: Ratio = 50%`, `softness: Ratio = 50%`, `color: Color = #000000` | amount/radius `0%...100%`; softness greater than `0%` and at most `100%` |
| `Sharpen` | `radius: Length = 1px`, `amount: Ratio = 100%` | radius `0px` or `0.3px...16px`; amount `0%...100%` |
| `Grain` | `amount: Ratio = 8%`, `size: Length = 1px`, `seed: Number = 0`, `mode: String = "static"`, `monochrome: Boolean = true` | amount `0%...100%`; exact integer size `1px...64px`; unsigned 32-bit integer seed; mode `static` or `temporal` |
| `Duotone` | `shadows: Color = #000000`, `highlights: Color = #ffffff`, `amount: Ratio = 100%` | opaque six-digit endpoints; amount `0%...100%` |
| `MotionBlur` | required `shutterAngle: Angle`, required `samples: Number`, optional static `startEdge: "hold"` | angle greater than `0deg` and at most `360deg`; exact integer samples `2...32` plus composition work bounds; authored hold must reach an exact pre-start shutter sample or fails as a no-op |

Shadow and glow derive coverage from the child's alpha, multiply it by the color literal's optional alpha and `opacity`, then composite the halo behind the unchanged child. Shadow offsets are exact integer pixels; glow is centered. Blur converts the straight 8-bit boundary to associated encoded-sRGB rgb16, runs one bounded Sharp/libvips Gaussian, receives unassociated rgb16 and quantizes once back to straight RGBA; output-alpha zero clears hidden RGB. Vignette computes an elliptical normalized distance, smoothsteps from `radius` across `softness`, mixes the selected color in linear-light sRGB, and preserves child alpha. Sharpen uses the same alpha-coupled rgb16 neighborhood for an encoded-sRGB unsharp mask while preserving source alpha and hidden zero-alpha RGB. Grain is a seeded integer-hash canvas-space field with explicit static/exact-frame temporal modes and a maximum signed excursion of 64 code values. Duotone uses linear-sRGB Rec. 709 luminance and opaque exact endpoints. MotionBlur evaluates its child at exact uniform midpoint samples over a centered shutter, keeps the output-frame stochastic seed fixed, treats inactive boundary samples as transparent by default, and averages premultiplied linear-sRGB values back to straight alpha. Authored `startEdge: "hold"` maps only reachable pre-start samples to the direct child's exact first instant; descendants keep their intervals and the half-open end stays transparent. Sharpen, Grain and Duotone copy alpha exactly and preserve zero-alpha hidden RGB. Every effect clips to the canvas. Spatial effect details are in [`VISUAL_EFFECTS.md`](VISUAL_EFFECTS.md); exact temporal scheduling, work bounds, composition-boundary refusal and limitations are in [`MOTION_BLUR.md`](MOTION_BLUR.md).

Effect inputs are static in this runtime. They are accepted only as typed call inputs and are fingerprinted with the ordered child graph and the `cut:visual` implementation identity. `set` or `animate` on an effect parameter is rejected; animate an enclosed child or enclosing `Group` for supported transforms/opacity. MotionBlur itself may contain animated content, but it cannot cross a Precomp/NestedSequence boundary in this alpha. Nested MotionBlur remains available for random-access retained content, while a Video, linked Clip, or PictureClip below two temporal ancestors fails with `CUT_MOTION_BLUR_PLAN`: depth-first nested shutter schedules are not generally monotonic for the current forward-only decoder, and CUT will not invent a seek or alter exact sample times. The backend is CPU-only, has no custom shader hook, and does not claim cross-libvips or cross-platform floating-point bit identity or end-to-end color management.

#### 6.1.1 Deterministic chroma key

`ChromaKey(key: Color, tolerance?: Ratio = 12%, softness?: Ratio = 8%,
spill?: Ratio = 50%)` is a separate closed unary `cut:visual` matte. The key
must be an opaque six-digit color with normalized encoded-sRGB Rec. 709 chroma
distance of at least `0.1` from neutral. The reference kernel safely
unassociates premultiplied input, measures
`clamp(hypot(Cb-keyCb, Cr-keyCr) / sqrt(2), 0, 1)`, and sets keep coverage to
zero at or below `tolerance`. Positive `softness` applies deterministic
smoothstep through `tolerance .. tolerance + softness`; zero softness is a hard
boundary. Coverage multiplies source alpha, and zero output alpha clears RGB.

Optional `spill` interpolates retained near-key pixels toward a neutral color
with the same linear-sRGB Rec. 709 luminance. All controls are static, bounded,
fingerprinted, and validated before allocation or cache lookup. The kernel
requires a provable encoded-sRGB child boundary and refuses wrong-space
`ColorConvert` results even through wrappers; explicitly convert back to
`srgb`. Stable `CUT_CHROMA_KEY_*` diagnostics cover graph, type, color,
color-space, range, no-op, work-budget, and surface failures. The exact formula,
ratio/canvas/composition bounds, cache contract, and exclusions are normative
in [`CHROMA_KEY.md`](CHROMA_KEY.md). This 8-bit static CPU slice does not claim
luma/difference keying, garbage/core mattes, edge reconstruction, temporal
tracking, HDR/log operation, or cross-platform pixel identity.

### 6.2 Locked `.cube` lookup tables

`LUT(source: DataAsset, strength?: Ratio = 100%)` is a unary retained visual
wrapper with exactly one child. The project-confined locator must end in
lowercase `.cube`. Lock creation and application parse the exact SHA-256-pinned
bytes before semantic lock; renderer preparation verifies and parses them again.
The strict UTF-8 subset accepts comments/whitespace, one optional quoted
`TITLE`, paired optional `DOMAIN_MIN`/`DOMAIN_MAX`, and exactly one bounded
`LUT_1D_SIZE` or `LUT_3D_SIZE` table. Multiple tables, unknown directives,
unsafe sizes, non-finite/out-of-range values, invalid domains, malformed row
counts and hostile byte/line budgets fail with source-located `CUT_LUT_*`
diagnostics. Three-dimensional storage is red-fastest.

Input/table/output RGB is normalized straight-alpha encoded sRGB. One-
dimensional tables interpolate each channel linearly; three-dimensional tables
use deterministic trilinear interpolation. Signal-driven `strength` mixes in
encoded RGB, `0%` is exact byte bypass, and alpha is copied exactly. Authored
nesting determines order; CUT inserts no hidden color transform. Locked bytes
and the signal/child graph participate in localized cache identity. See
[the complete LUT contract](LUTS.md) for exact limits and nonclaims.

### Managed SDR color boundary

The CPU reference runtime declares an 8-bit straight-alpha encoded-sRGB working
surface and a closed managed subset: `"srgb"`, `"linear-srgb"`,
`"rec709-full"`, and `"rec709-limited"`. All use BT.709 primaries and D65;
their sRGB/linear/BT.709 transfer and full/legal code ranges are semantically
distinct.

`ColorConvert(from: String, to: String, alpha?: "straight")` is a unary visual
kernel. It converts unassociated RGB at its authored graph position and copies
alpha exactly. Limited input outside 16...235, premultiplied input, unknown
profiles, and non-unary graphs fail with stable `CUT_COLOR_*`/`CUT_NODE_NOOP`
diagnostics. Equal `from` and `to` profiles are a provable identity and must be
replaced by the wrapper's child. HDR, log, ICC, OCIO, and ACES names are not
inferred.

`inputColor: profile` on `Video`, linked `Clip`, direct `PictureClip`, or an
`editClip` operand asserts the selected stream's locked ffprobe
range/matrix/transfer/primaries and pixel-format metadata before decoding. The
supported Rec.709 path performs an explicit BT.709 YUV range/matrix expansion,
then CUT converts transfer into the working surface. Picture edit
materialization preserves the assertion. Omission retains the exact legacy
decoder path and makes no colorimetry claim.

The mutually exclusive `inputColorInterpretation` path accepts the typed pure
records `observedVideoColor(pixelFormat:, fieldOrder:, range?:, matrix?:,
transfer?:, primaries?:) -> ObservedVideoColor` and
`interpretVideoColor(profile:, master:, proxy?:) -> VideoColorInterpretation`.
The four optional observation fields use structural absence: an omitted field
is distinct from any authored string. `pixelFormat` and `fieldOrder` are
required. The target profile is closed to `rec709-full`, `rec709-limited`, or
`bt470bg-smpte170m-limited`; every observation must be progressive
`yuv420p`/`yuv422p`/`yuv444p`. A proxy observation is required exactly when the
resource has a proxy. Lock creation validates each authored observation against
the corresponding newly probed selected stream, rejects a declaration whose
observations already exactly match the target as redundant strict
`inputColor`, and emits source-located
`CUTW_COLOR_INTERPRETATION_AUTHOR_DECLARED` on success.

The authority is `author-declared-unverified`: CUT executes constants from the
closed target profile and never passes observed tokens to the decoder. It does
not infer or verify photographic truth. Canonical inspect retains authority,
contract, target, master/proxy observations and field differences; a selected
master/proxy execution clone retains only that variant. Selected observation
and target participate in picture graph/cache identity and semantic diff;
linked audio identity/samples exclude this picture-only interpretation. The
safe source bootstrap is probe and temporary legacy lock, exact copy of
observed fields with omissions preserved, author review/target declaration,
then a newly generated lock. See [COLOR.md](COLOR.md).

Video inputs additionally accept the input-only exact profile
`"bt470bg-smpte170m-limited"`; it is intentionally absent from
`ColorConvert` and output profiles. The v1 contract requires one of
`yuv420p`/`yuv422p`/`yuv444p` and exact locked
`tv / bt470bg / smpte170m / bt470bg` range/matrix/transfer/primaries. FFmpeg
expands matrix/range into a full straight RGBA8 intermediate; CUT owns the
versioned SMPTE-170M transfer and D65 BT.470BG-to-BT.709 primary conversion
into the sRGB working surface. Unsupported or incomplete tuples fail rather
than being inferred. This strict v1 assertion locks but does not constrain the
selected field-order token; only `inputColorInterpretation` currently requires
exact progressive scan. See [the exact bounded contract](COLOR.md).

`render(timeline, color: profile)` converts the working surface, writes exact
H.264 VUI primaries/transfer/matrix/range with x264, and re-probes the delivered
MP4; mismatched/missing tags fail. Omission retains the old untagged encoder and
cache-target shape. ColorConvert and output color participate in localized
picture cache identity. See [the exact bounded contract](COLOR.md).

`curvePoint(input: Ratio, output: Ratio)` is a pure compile-time record
constructor. `TonalCurve(points:, space:, channel?:, alpha?:)` consumes 2...32
such points and exactly one child. Inputs cover `0%...100%` in strictly
increasing order; interpolation is piecewise linear in explicit `"srgb"` or
`"linear-srgb"`; channel is master RGB or one RGB channel; and straight alpha
is exact. Curves are static in this slice and can be nested for separate channel
maps. Malformed loaded IR and aggregate curve budgets fail source-located. The
runtime also exposes a bounded JSON histogram for rendered straight-RGBA frames
with explicit RGB projection and transparency policy. It does not claim a
waveform/vectorscope. See [the exact bounded contract](COLOR.md).

### 6.3 Deterministic masks and mattes

`Mask` requires exactly two source-ordered visual children: target, then matte.
Its closed `mode` is `alpha`, linear-light Rec. 709 `luminance`, or linear-light
`red`, `green`, or `blue`; every color-derived mode is associated with matte
alpha after safe encoded-sRGB unpremultiplication. The fixed scalar-coverage
order is selection, signed integer-pixel expansion/erosion, deterministic
finite-support feather, optional inversion, then target-alpha multiplication.
Expansion is bounded to `-64px...64px`, feather to `0px...64px`, and both must
be exact integer pixels. Morphology uses a square neighborhood; feather uses
the documented separable tent kernel; coverage outside the canvas is zero.

The result is straight-alpha full-canvas RGBA. RGB is zero when output alpha is
zero, preventing hidden-RGB leaks. Mask controls, children and implementation
participate in localized identity. An intentionally all-zero matte is authored
as a childless `Group()` rather
than a transparent painted primitive. Direct fully transparent Text, Rect,
Circle, Path, or Trace main paint is refused when the complete node has no
independently visible paint; nontransparent gradient endpoints, a positive
visible Trace head, and hidden-to-visible opacity automation remain executable.
`ClipPath(points:, fillRule?:, invert?:)`
separately clips exactly one child to a static implicitly closed polygon in
composition-pixel coordinates. It executes a fixed CUT-owned 4x4 pixel-center
coverage raster with half-open edge rules, `nonzero` or `evenodd` fill,
optional inversion, straight-alpha output and hidden-RGB safety. Geometry,
canvas, and scan work are bounded before allocation; malformed, degenerate,
identity, unknown, or off-budget paths fail source-located. Bezier/cubic
segments, multiple explicit subpaths, point animation, path feather/expansion,
roto/tracking and arbitrary mask channels remain refused rather than inferred.
See [the complete mask contract](MASKS.md).

### 6.4 Locked timed captions

`Captions` from `cut:visual` is a closed visual source with required
`source: DataAsset`, `font: FontAsset`, and explicit `format: String` inputs.
`format` is exactly `"webvtt"` or `"srt"`; extension guessing, ASR, prompt
interpretation, system-font lookup, and hidden cue JSON are outside the formal
path. The source bytes and TTF/OTF bytes are ordinary project-confined locked
resources. The consumer then applies a stricter caption parser, cue/time/text
budgets, full supported-subset OpenType parse, fixed-instance monochrome-outline
font policy, cmap/shaped-glyph coverage, bounded path extraction, and closed
safe-area style contract before frame work. Rasterization receives glyph paths,
not SVG text, so it performs no host-font lookup.

Cue time is exact rational milliseconds relative to the node. Visibility is
`cue.start <= localTime < cue.end`. Cue identifiers and authored line order are
preserved, cues may not overlap, and every cue end must remain within the node
interval. WebVTT percentage `line`, `position`, `size`, and horizontal `align`
settings are retained by interchange and participate in burn-in layout.
Integer snap-to-line placement and the unsupported WebVTT/markup subsets fail
closed.

The pure `parseWebVtt`, `parseSubRip`, `serializeWebVtt`, and
`serializeSubRip` boundary remains independent of rendering, so the same
canonical track can be delivered as a sidecar or burned in. Burned pixels are
not a selectable accessibility track. Exact defaults, budgets, layout behavior
and font/shaping limitations are normative in [Deterministic captions](CAPTIONS.md).

#### 6.4.1 Narration role and transcript ownership

`@cut/documentary Narration` is the audio-domain operation
`cut.documentary.narration`. Its closed public signature is
`Narration(source: AudioAsset, range?: Range<Time>, fadeIn?: Time, fadeOut?:
Time)`. The operation classifies a locked audio take as narration; it does not
own visible text or non-rendering script metadata. A named `transcript` input is
therefore a stable source error (`CUT2059`), not an accepted field that the
compiler or renderer may ignore.

Visible timed text belongs in `Captions` backed by a locked VTT/SRT resource or
in the separate executable `TranscriptCaptions(edit:)` path specified below.
Non-rendering transcript/editorial notes belong in `@cut/edit Marker` or
`Region` metadata with `role: "transcript"` and an explicit `comment`. CUT does
not infer one representation from the other.

Current canonical CutAVIR rejects `inputs.transcript` at the exact node-input
path before identity acceptance, cache lookup, OTIO publication, or rendering.
The explicit `legacy-0.3-compatible` loader mode may keep an exact
`cut-ts/0.3.0` graph structurally readable as evidence, but it grants no runtime
authority and does not make that input migratable current semantics.

#### 6.4.2 Edit-safe transcript selection

The current alpha has one public, audiovisual transcript-editing vertical. It
has a legacy co-located form and an additive independent-media authority form.
The following legacy source is illustrative rather than an independently
runnable fixture: the selected word IDs determine the exact audio duration and
frame-covering picture duration, so a concrete program must derive its sequence
length and trailing picture/audio gaps from the locked sidecar. The formal
contract and CLI procedure live in
[Edit-safe transcript selection](TRANSCRIPT_EDITING.md); the executable
real-media fixture is generated by the test suite rather than shipped as a
copyable production asset.

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
asset face: FontAsset = font("assets/Inter-Regular.ttf");

let quote: TranscriptEdit = transcriptEdit(
  transcript: words,
  source: voice,
  from: "answer.001",
  through: "answer.002",
  at: 1200ms,
  link: "answer-a"
);

TranscriptCaptions(edit: quote, font: face, maxWords: 4);
Sequence(duration: 2200ms) {
  PictureTrack() {
    Gap(duration: 1200ms);
    TranscriptPicture(edit: quote, source: camera, fit: "cover");
  }
}
AudioTrack() {
  AudioGap(destination: 0s ..< 1200ms);
  TranscriptAudio(edit: quote, fadeIn: 10ms, fadeOut: 20ms);
}
```

`transcriptEdit` must be the direct initializer of one scene-local `let`
binding. Its closed signature is `transcriptEdit(transcript: DataAsset, source:
AudioAsset, from: String, through: String, at: Time, link?: String, media?:
TranscriptMediaAuthority) -> TranscriptEdit`. The new optional argument is
appended after `link`, preserving the legacy positional ABI and exact omission
semantics. `from` and `through` select an inclusive, ordered stable-word-ID
range. The compiler parses the bounded external `cut-transcript` v1 sidecar,
derives its exact source interval and text, and maps that interval without
retiming to the exact scene-local `at` destination. The destination must fit
the scene and both endpoints must land on the composition sample grid.

`transcriptMedia` is a closed package compile-time lowering:

```text
transcriptMedia(
  transcript: DataAsset,
  audio: AudioAsset,
  audioStream: Number,
  video: VideoAsset,
  videoStream: Number,
  videoFrameRate: Number,
  videoDuration: Time,
  audioAt: Time,
  videoAt: Time,
  videoRate: Number
) -> TranscriptMediaAuthority
```

It must directly initialize one scene-local `let`. `transcript` and `audio`
must be the same exact resources later passed to `transcriptEdit`; `video` is
one independently declared resource. Both stream indexes are explicit whole
absolute selectors from 0 through 65,535 that agree with the referenced asset
declarations. The positive exact rational `videoRate` from 1/64 through 64 and
non-negative exact anchors define:

```text
videoTime = videoAt + (audioTime - audioAt) * videoRate
```

`audioAt` lands on the authenticated sidecar/audio sample grid. `videoAt`
lands on the exact declared and authenticated selected-video frame grid.
`videoFrameRate` and `videoDuration` are author declarations re-authenticated
by lock. CUT does not infer this mapping from filenames, co-location, stream
order, equal duration, audio correlation, or any model.

The only public members are `sourceRange: Range<Time>`, `destinationRange:
Range<Time>`, `duration: Time`, and `text: String`. The compiler records a
typed transcript-binding ledger containing the selected IDs and their hash,
selected words/text, exact source/destination intervals, transcript and audio
resource identities, optional link, media authority and source provenance.
`TranscriptEdit` itself does not survive as a runtime operation.

CutAVIR v3 stores nonempty authority use in the optional top-level
`transcriptMediaAuthorities` array. Each closed version-1 record binds its
composition/scene, transcript/audio/video resource IDs, selectors, exact
video timing and affine clock fields, provenance, and canonical identity.
The corresponding transcript binding carries `mediaAuthorityId`; every
lowered picture carries the authority plus origin and segment lineage required
by strict semantic admission. Absence of the top-level array and binding field
is canonical legacy IR. The public schema, compiler, strict loader, lock,
inspect/diff, runtime, package implementation identity, and packed installed
bytes must agree on this representation.

`TranscriptAudio(edit:, fadeIn?:, fadeOut?:)` is legal only as a direct
`AudioTrack` item. It lowers to the ordinary `cut.audio.clip` runtime operation
with the ledger's exact AudioAsset, source range, destination range and link.
`TranscriptPicture(edit:, source:, fit?:, opacity?:, scale?:, rotation?:,
inputColor?:, inputColorInterpretation?:, duration?:, rate?:)` is legal only
as a direct `PictureTrack` item. The final two optional arguments are appended
after the existing appearance/color surface.

When the edit omits `media`, the picture requires an explicitly selected
co-located video stream whose exact rate equals the composition rate. It is a
direct, forward-1x item without an operation plan, and explicit
`duration`/`rate` are forbidden.

When the edit carries a `TranscriptMediaAuthority`, `source` must be that
authority's exact video resource. The compiler maps the selected audio interval
through the affine clock, selects the smallest complete source-frame cover at
the authenticated source cadence, and lowers an ordinary
`cut.edit.picture_clip`; the compiler-only
`cut.edit.transcript_picture` authoring op is never persisted. If the mapped
source cover cannot place one-times on the composition frame grid, the author
must supply both exact `duration: Time` and positive `rate: Number`, satisfying
`source duration = destination duration * rate`. CUT neither frame-snaps nor
invents an implicit retime.

An authority-backed picture may be the base of the ordinary `PictureTrack`
operation plan for direct placement, split/cut, trim, and one exact constant
retime, including split/trim after that retime. Its authenticated origin
identity is immutable; materialization derives a segment identity from that
origin and the exact final source range, destination range, and time map.
Transitions are excluded because this slice has no authenticated
transcript-media handle authority; `transitionAt` fails instead of inferring
handles.

`TranscriptCaptions(edit:, font:, maxWords?:, ...)` lowers to a strict visual
consumer of the same ledger and accepts the complete closed `Captions`
appearance surface. Its node interval must cover the complete transcript
destination.

Caption formation uses exact rational word times. `maxWords` is a whole number
from 1 through 64 and is a hard ceiling. A speaker change, sentence-final
punctuation, or an inter-word gap of at least 250 ms also closes a group. The
`cut-transcript-caption-groups-v2` then derives a soft line-code-point budget
from usable width and size at two code points per em. An over-budget group
splits at one authored space into at most two lines by the stable lexicographic
minimum of widest code-point line, line-length imbalance, word-count imbalance
and split index. Exact cue timing is unchanged. The locked-outline preflight is
final authority: a line requiring horizontal scale below `0.85` fails
source-located `CUT_CAPTION_LEGIBILITY` instead of being silently squashed. The
result does not call ASR, a model, or a natural-language interpreter and does
not quantize word times to milliseconds.

The closed `cut-transcript` v1 schema is
[`schemas/cut-transcript-v1.schema.json`](../schemas/cut-transcript-v1.schema.json).
It binds the exact master byte SHA-256, absolute audio stream, audio sample
rate, audio duration and sample-grid-aligned non-overlapping words. Optional
`videoStreamIndex` and `videoFrameRate` must appear together.
`videoDuration` is also required by `TranscriptPicture`; it is an independent
decoded-video bound and may differ from audio `duration`. Locking authenticates
the selected decoded-video cadence. Optional nonzero
`audioVideoPresentationDelta` declares decoded-audio first-PTS time minus
selected-video stream start; omission is the canonical spelling of exact zero,
and an explicit zero is invalid. The field requires complete
videoStreamIndex/videoFrameRate/videoDuration authority and lock independently
rederives the same delta.

For audio-local source interval `[s,e)`, presentation delta `d` (zero when
omitted), and exact video rate `f`, the complete mapped interval
`[s+d,e+d)` must lie inside decoded video. The picture source is the smallest
covering frame interval
`[floor((s+d)*f)/f, ceil((e+d)*f)/f)`. Each edge adds less than one frame, so
the total extra head plus tail is non-negative and strictly less than two frame
periods. The full covering duration survives into the picture destination and
cache identity; it is not replaced with the shorter audio word duration.
Mapped underflow/overflow is refused rather than clipped, held, padded, or
shifted again by the backend.

That formula is the legacy co-located mapping. For an explicit authority,
first map both audio endpoints through
`videoAt + (audioTime - audioAt) * videoRate`, then apply the same smallest
half-open source-frame-cover rule at the authority's exact `videoFrameRate`.
The complete cover must lie inside `[0, videoDuration]`. Negative/zero rate,
off-grid anchors, mapped underflow/overflow, selector/resource disagreement,
or an inexact explicit duration/rate equation fails deterministically before
media decode.

Lock creation and application reproduce the selection from no-follow,
bounded, exact locked `DataAsset` bytes and authenticate its SHA, stream,
sample rate and duration against the independently probed master `AudioAsset`.
For an explicit authority, lock separately authenticates the selected video
bytes, absolute selector, exact cadence and duration, then replays the complete
clock map and identity. Strict IR admission and verified-input execution
re-derive the authority, origin and final-segment identities. Foreign scene or
resource ownership, forged lineages, operation-plan range/time-map drift,
changed bytes, or post-lock mutation fails before affected decode or
publication.
Proxy execution is authorized only by CUT's ordinary pairwise alignment
records; a proxy cannot self-assert the master digest. Audio binds decoded
samples. Picture binds selected decoded cadence plus a bounded fixed-geometry
RGB correspondence witness, because cadence equality alone is not content
correspondence. Full apply and verified-input sessions recompute both records.
Text-only
correction with stable IDs/timing preserves ordinary audio- and picture-node
identity while changing caption and build identity.

One edit is bounded to 4,096 selected words and 1 MiB selected UTF-8 text. The
derived captions have deterministic at-most-two-line wrapping and the `0.85`
scale floor, but remain inside the fixed-font subset. Production complex-
script/bidi shaping, font fallback, language-aware line breaking, hyphenation,
selectable transcript-caption delivery, word highlighting, ASR, forced
alignment, implicit synchronization, variable/eased/reverse retiming,
transcript-bound transitions, and transcript-picture proxy equivalence are not
implemented. The explicit authority does admit independent audio/video
resources, a rational source-clock transform, rationally mismatched source and
composition frame rates, direct placement, split, trim, and one exact constant
retime through ordinary picture algebra. These are engineering capabilities,
not speech-sync or creative approval. Named-human normal-speed playback,
intelligibility and editorial review remain `UNPERFORMED`, so DOC-10 remains
at most `PARTIAL` until its complete installed end-to-end benchmark and human
gate are separately proved. The normative authoring and CLI workflow is
[Edit-safe transcript selection](TRANSCRIPT_EDITING.md).

### 6.5 Deterministic event-list synthesis

`Synth` from `@cut/audio` is a closed source kernel, not a pattern macro. Its
required `events: List<NoteEvent>` is lowered unchanged into CutAVIR. Every
event has exact relative `start` and gate `duration`, a `velocity` ratio, and
exactly one scalar MIDI `pitch` or `hz` frequency. One shared ADSR envelope,
one of four deterministic waveforms, and a hard polyphony bound produce
sample-domain PCM before the ordinary audio graph. Release tails participate in
bounds and polyphony; the runtime refuses voice stealing and implicit sample
rounding. See [Deterministic event-list synthesis](SYNTH.md) for the complete
defaults, formulas, limits, routing behavior, and non-claims.

`note(start, duration, pitch, velocity)` is exactly equivalent to authoring the
four-field MIDI-pitch object. Its manifest's closed `record` lowering maps
required arguments into parameter-order fields during compilation. It cannot
declare native, domain, child, open-named, optional, default, or effectful
semantics, and no constructor call survives into CutAVIR. The explicit `hz`
object variant remains available for frequency-authored events.

### 6.6 Locked geographic labels

`Map`, `Marker`, and `Connections` accept an optional `font: FontAsset` only
for labels they actually render. Every visible explicit or data-derived label
requires that locked fixed-instance font. Preparation validates label types,
font bytes, fixed-instance OpenType support, glyph coverage, and outline
budgets, then emits explicit paths; SVG text, system-font lookup, fallback, and
hidden embedded fonts are forbidden. A supplied font with no resolved visible
label is rejected as a no-op. Font bytes participate in package, graph, scene,
and cache identity. Marker placement is edge-aware only and does not claim
inter-label collision resolution. Exact label sources, precedence, budgets,
diagnostics, and non-claims are normative in
[Deterministic geographic labels](GEO_LABELS.md).

## 7. Package boundary

Package manifests define specifier, version, symbols, parameter types, result/domain, allowed child domain, effect kind, optional native operation identifier, optional closed compile-time lowering, API integrity, implementation integrity, and combined integrity. Compile-time lowerings are restricted to pure functions without native, domain, child, open-named, or manifest-default behavior and must disappear into ordinary IR values. Generic `record` lowering maps supplied arguments into closed parameter-named fields. The built-in `@cut/data` `data-bar-layout`, `data-bar-targets`, and `data-format-number` lowerings have fixed compiler-validated signatures and exact bounded semantics; they produce ordinary objects, lists, quantities, and strings rather than private operations. Lowering kind is part of package API and implementation identity, not a runtime escape hatch.

The built-in packages are:

| Specifier | Domain |
| --- | --- |
| `cut:core` | asset constructors, exact seconds conversion, outputs |
| `cut:visual` | media, typography, locked timed captions, geometry, compositing, bounded unary effects, cameras, light, grading, reserved shaders |
| `@cut/audio` | typed compile-time note/tempo records, media and deterministic oscillator sources, buses, gain, filtering, dynamics, bounded finite-tap and tempo-synchronized delay, bounded time stretch/pitch, spatialization, metering |
| `@cut/edit` | linked clips, sequences, transitions, J/L cuts, time mapping |
| `@cut/motion` | easing and motion functions |
| `@cut/geo` | map/globe projections and geographic graphics |
| `@cut/data` | compile-time keyed bar layout/formatting, strict locked-table query plans, retained series charts and signal-derived graphics |
| `@cut/diagram` | closed retained-DAG records, compiler/loader ownership, exact bounded layout/routing, retained reference pixels and persistent cross-render subscene-RGBA caching; cross-process cache coordination and creative-review gates remain incomplete |
| `@cut/documentary` | evidence, narration, captions |

The parser has no built-in knowledge of `Globe`, `Chart`, `Narration`, or another domain component. The checker resolves the imported symbol and the compiler lowers its manifest's native operation ID. This is the architectural boundary that allows future medical, sports, 3D, social-video, or other domain libraries without adding keywords to the language.

The pre-1.0 `@cut/diagram` boundary is specified in
[Deterministic diagram layout](DIAGRAM_LAYOUT.md). Its record lowering,
whole-pixel raster bounds, paired inputs, direct-child ownership, DAG identity,
exact Q16 planner, bounded five-point routing, transition preflight, retained
local raster subset, limits and stable diagnostics execute through the strict
loader and reference renderer. Node tiles and tight edge tiles now use a closed
persistent visual-subgraph cache whose identities bind exact executable raster
dependencies, backend/runtime identity and package implementation closure.
The public DiagramNode constructor returns nominal `DiagramNode`; a user or
project-module component can return that type only through the transparent
single-direct-DiagramNode expansion in section 2.6, never through a fragment or
an invocation child block.
Exact-frame v2 and inspect/diff evidence pass across two unrelated public
studies, but cross-process publication/eviction leases, complete human playback
reviews and professional-output gates do not. The package entry, cache hit or a
technically successful render cannot substitute for them.

External source packages use a strict `cut.package.json` plus a separately
integrity-protected `cut.package.lock`. The bounded resolver supports transitive
project-relative `file:` dependencies, exact/caret/tilde SemVer constraints,
declared source files, sorted dependency identity, cycle/conflict refusal and
capability checks. `cut package init/add/remove/list/update/lock/verify` is the
public mutation/verification workflow. Normal check/build/test/render commands
verify the existing package lock and never update trust implicitly. The shipped
ImpactCard proof expands a third-party component using public `Rect`/`Circle`
semantics without compiler edits. See [CUT local packages](PACKAGES.md) for the
closed manifest, lock, CLI and current export limitations.

Built-in combined signatures hash declared APIs and the compiler/runtime files
registered for them. Source-package identities hash their semantic manifest,
declared implementation bytes, derived exported API and dependency pins. These
identities do not freeze every transitive native dependency or the host FFmpeg
binary; that limitation matters for decoded-media and bitstream
reproducibility. Source packages cannot execute JavaScript, native code, shell
commands or ambient network/filesystem operations.

## 8. CutAVIR v3

The compiler emits a JSON-serializable graph with:

```ts
type CutAVIR = {
  format: "cut-av-ir"
  version: 3
  language: "0.4"
  compiler: string
  project: string
  sourceHash: string
  sourceModules?: { specifier: string, sha256: string, bytes: number }[]
  buildId: string
  determinism: {
    semantic: "locked" | "unlocked"
    decodedMedia: "unverified" | "verified"
    bitstream: "unverified" | "verified"
  }
  modules: PackageIdentity[]
  resources: Record<string, Resource>
  compositions: Composition[]
  scenes: Record<string, Scene>
  nodes: Record<string, Node>
  signals: Record<string, Signal>
  jobs: EffectJob[]
  outputs: Output[]
  assertions: Assertion[]
  annotations?: {
    markers: EditorialMarker<IRProvenance>[]
    regions: EditorialRegion<IRProvenance>[]
  }
}
```

The distribution ships `schemas/cut-av-ir-v3.schema.json` and a strict public
UTF-8 loader. The loader rejects duplicate decoded keys, unknown/missing fields,
invalid canonical rationals and identities, hostile references, graph/timing
inconsistency and configured resource-budget overruns before runtime use. The
TypeScript shape, closed JSON Schema and loader describe the current v3
boundary, including optional typed Marker/Region annotations. The
narrow alpha compatibility policy in `MIGRATION.md` detects current v3, refuses
unknown versions and can canonicalize only the verified archived 0.3
derived-identity representation after strict reload and an empty semantic diff.
A frozen cross-version corpus, complete schema-to-loader parity and the eventual
1.0 migration boundary remain pre-1.0 work.

### 8.1 Resources

A resource records stable ID/name, kind (`video`, `audio`, `image`, `font`, or `data`), locator, lock state, optional SHA-256/metadata, and source provenance.

### 8.2 Compositions and scenes

A composition records exact duration/FPS, integer canvas dimensions, sample rate, ordered scene IDs, ordered root IDs by domain, ordered timeline items, and provenance. A scene records exact start/duration, ordered roots/items, and provenance.

### 8.3 Nodes

Every node records:

- a stable ID and native operation ID;
- domain: `visual`, `audio`, `av`, `data`, or `output`;
- ownership: `root`, `child`, `reference`, or `detached`;
- optional owning scene and an exact interval;
- typed inputs and ordered children;
- constant properties or references to signals;
- effect kinds;
- a transitive content hash;
- source span, module/symbol, and component-expansion provenance.

Graph hashing includes operation, domain, interval, inputs, ordered child hashes, signal hashes, effects, package implementation identity, and locked resource identity. Cycles are rejected unless a future explicit feedback/delay primitive defines their semantics.

For every current node whose operation has a supported reference-kernel schema,
the public loader also closes domain, input names, property names, child
cardinality, and child domain against that schema before graph identity is
accepted. Merely changing `compiler` to an older string does not bypass this
contract. The only structural exception requires both exact compiler identity
`cut-ts/0.3.0` and explicit `legacy-0.3-compatible` identity mode; the reference
runtime independently rechecks the closed schema and never executes through
that evidence-only exception.

### 8.4 Signals

The compiler emits ordered `track` signals with an explicit initial value and events that are either exact-time `set` writes or bounded `animate` intervals with `from`, `to`, and curve values. Stable source order is retained for equal-time events. Animate end must be strictly later than start. CutAVIR v3 also retains constant, step, and keyframe signal variants for compatibility with earlier graph producers; step and keyframe collections cannot be empty.

Every signal has a value type, content hash, and provenance. The strict loader
checks every constant, step, keyframe and track-event payload against that
declared type: `Angle` is `angle/deg`, `Frequency` is `frequency/hz`, `Gain` is
`gain/db`, `Length` is `length/px`, `Number` is `scalar/scalar`, `Ratio` is
`ratio/ratio`, and `Time` is `time/s`. Null is allowed only as the initial value
of a non-empty closed-kernel track whose attachment unambiguously supplies the
declared type; null constants, event endpoints, empty-track baselines and
unresolved third-party baselines fail strict loading. Canonical `inferred`
types fail. The narrow archived loader may derive an inferred type only from a
unique closed-kernel attachment and still validates every payload before
migration.

The JSON Schema closes the structural signal escape hatches (`valueType`
enum, non-null stored payloads, non-empty step/keyframe sets, and a non-empty
event list for a null-baseline track). The strict loader remains authoritative
for the cross-record rule that an attachment-derived signal type matches every
payload's canonical quantity dimension/unit and that a null baseline is
actually attached to one uniquely typed closed property. Complete
schema-to-loader parity therefore remains PARTIAL rather than being inferred
from structural schema acceptance alone.

#### 8.4.1 Produced amplitude signals

`@cut/data` exports `AmplitudeEnvelope(...) -> Signal<Ratio>` plus the exact
typed linear mappers `mapNumber`, `mapRatio`, `mapLength`, and `mapAngle`.
`AmplitudeEnvelope` is valid only as a direct scene-local `let` initializer;
each mapper is valid only as a direct `set` value in that same scene. The
initial boundary accepts a bound direct scene-root `Group` and only its `x`,
`y`, `scale`, `rotation`, or `opacity` property. A Group may contain arbitrary
otherwise supported visual content, but direct/nested non-Group targets,
cross-scene use, effect properties and audio controls are rejected.

Each mapped attachment lowers to an ordinary typed `track` whose initial value
equals `mapping.from`, whose authored event list is empty, and whose closed
`cut-audio-amplitude-producer` v1 descriptor carries the locked `AudioAsset`
reference, composition/scene scope, half-open selected-source range,
scene-local `at`, peak/RMS detector, window/hop, attack/release, linear-amplitude
floor/ceiling, and typed linear mapping. The strict loader requires exact
sample-grid clocks, `at + selectedDuration` inside the scene, the selected
range inside the locked stream, an executable direct-root Group attachment,
matching value type/baseline, and no authored-event or second-producer
conflict. One envelope may fan out to several typed tracks; equal analysis
plans are prepared once while mappings retain distinct signal identities.

Runtime preparation decodes the exact lock-selected absolute stream—not the
container default—from the verified invocation snapshot, resamples it to the
composition sample rate as stereo f32le, and evaluates full trailing causal
windows. Analysis events use composition-sample time and are converted to a
scene-local track before frame work. At least two distinct mapped values must
be visible at actual output-frame times while a consumer is active; silence,
constant/off-frame changes and unprepared producers fail. Producer semantics,
locked selected-source/package identity and consuming ancestors participate in
inspect, semantic diff and graph/cache identity; decoded caches revalidate
exact size and SHA-256, and master/proxy selections remain disjoint.

The exact API, clocks, normalization, endpoint/aggregate resource bounds,
stable diagnostics, executable evidence and nonclaims are normative in
[Audio-reactive visual signals](AUDIO_REACTIVE.md). Onset/beat/tempo and
frequency-band detection, post-mix/live analysis, audio-control attachment and
automatic musical direction are not part of this slice.

### 8.5 Build identity

`sourceHash` hashes the exact entry `.cut` source text after UTF-8 decoding.
Optional `sourceModules` records every loaded project-relative user module's
canonical specifier, exact byte length and SHA-256. Both are pinned
independently by `cut.lock`. `buildId` hashes executable graph meaning while
excluding entry/module source bytes and source-location provenance. Node,
scene, signal, assertion, and output identities use semantic traversal slots
rather than byte offsets. A comment-only or formatter-only rewrite therefore
changes source evidence but preserves graph IDs, semantic diff and `buildId`;
a real audiovisual edit changes ordinary executable identities.

## 9. Resource lock and determinism

### 9.1 `cut.lock`

A v3 lockfile records:

- format/language, compiler, CutAVIR, package ABI and reference-runtime identity,
  including the dependency/native host and selected compositor implementation;
- exact entry source hash and, when used, the sorted project-relative user-module specifier/byte-count/SHA-256 list;
- package specifier, version, and combined integrity;
- each resource ID, kind, master locator, SHA-256, and byte length, plus an
  independently probed/hashed proxy variant when authored;
- authored master/proxy absolute stream selections plus bounded video/audio container, stream, time-base, duration and selected-stream metadata and the exact `ffprobe` implementation identity;
- decoded image dimensions, format, color space, channels and alpha plus exact Sharp/libvips identities;
- resolved effect-job artifact hashes.

The project root is the directory containing the input `.cut` program. A resource locator must resolve lexically inside that root and, after `realpath`, remain physically inside it. The target must be a regular file. Absolute escape, `..` escape, symlink escape, NUL bytes, missing files, changed byte length, and changed SHA-256 are rejected.

Creating a lock first resolves every consumed media type through its authored absolute selector, or requires exactly one candidate when omitted. It validates every executable media consumer—including superseded typed picture-operation operands—against the just-probed selected streams. Source ranges, handles, frame/sample grids, proxy temporal equivalence and explicit input-color declarations must pass before a lock that says `semantic: "locked"` is returned or written. Applying an existing lock then requires exact agreement on source hash, toolchain, package set/signatures, resource IDs, kinds, master/proxy locators, bytes, hashes, probe metadata and native probe identities. CUT re-probes both variants before mutating IR. A proxy may change codec, resolution, bitrate and absolute container presentation origin, but it must preserve every selected stream the asset type can execute, exact decoded duration, exact frame rate or sample/channel layout, exact linked picture-to-sound relative presentation delta, and codec clocks capable of representing every required frame/sample boundary. Audio proxies additionally require the bounded decoded-content alignment record. Picture proxies require a bounded full-frame-sequence correspondence record over fixed 32×32 RGB analysis rasters; clock equality alone cannot establish visual equivalence. Strict `inputColor` requires the complete exact target pixel-format/range/matrix/transfer/primaries contract on both variants. `inputColorInterpretation` instead requires exact independently authored master/proxy observations, including `fieldOrder` and structural absence, followed by one closed target profile; this relaxes metadata equality only, never timing/stream equivalence. Executable media source ranges are checked against both variants' selected streams before any decoder runs or semantic lock is declared. Public `Video` ranges must be positive, half-open, contained by the selected stream, and land on both its locked codec time base and positive exact frame-rate grid; destination placement and duration must land on the composition frame grid. Every reference picture/audio decoder and waveform/spectrogram analysis path names that selected absolute stream index rather than relying on FFmpeg's implicit/default stream selection. The validated probe is copied into each `IRResource`, graph hashes are recomputed, and semantic determinism becomes `locked`. The reference backend currently refuses locked `Video(loop: true, range: ...)` because it cannot yet repeat only the trimmed source range exactly; it also refuses an authored `endBehavior` on a looping source because that argument would have no end event to govern.

For every resource consumed by a linked `Clip`, CUT derives an exact
picture-relative audio plan independently for the selected master or proxy.
The picture anchor is the selected video stream's exact `start`; the sound
anchor is the decoded-audio witness's exact `firstPts * timeBase`; and
`delta = soundAnchor - pictureAnchor`. For a picture source interval
`P = [sourceStart, sourceStart + Clip.duration)`, source-audio coverage is
`A = [delta, delta + decodedAudioDuration)`. CUT decodes only `P ∩ A`, starting
at decoder-local sample time `max(P.start, A.start) - delta`, places it at the
corresponding destination sample, and emits exact silence for `P - A`. The
output always contains the complete `Clip.duration` sample grid. A wholly
disjoint interval has a null decoder-input plan and executes as generated
silence; CUT does not open an audio decoder merely to discard it.

`delta` must land on both source and destination sample grids. Actual
intersection endpoints must land on the destination grid, and decoder-local
intersection endpoints must land on the selected source-audio grid. Otherwise
locking or execution fails source-located as
`CUT_MEDIA_PRESENTATION_OFFSET_GRID`; malformed or unsafe evidence fails as
`CUT_MEDIA_PRESENTATION_OFFSET_METADATA` or
`CUT_MEDIA_PRESENTATION_OFFSET_LIMIT`. Linked source ranges are bounded by the
selected picture duration. Short or absent audio coverage is intentional
silence, not a picture-range error. CUT adds no synthetic fade at a coverage
edge; authored `fadeIn`/`fadeOut` remain defined over the complete linked Clip
destination interval.

Master and proxy may use different absolute container starts when both retain
the same exact `delta`, decoded duration, picture cadence/frame count, audio
sample count/layout and bounded decoded-audio alignment. A relative-delta
change fails as `CUT_PROXY_TIMING`. The complete plan and backend decoder-input
decision are visible in `cut inspect` and participate in audio cache identity.
Public linked `Transition` composes the complete child streams. This bounded
slice does not alter standalone `AudioAsset`: its local time zero remains the
decoder's first semantic sample. Independently ranged picture/audio linking,
retimed linked offsets and broader container/codec/platform conformance remain
pre-1.0 work.

`font` and generic `data` resources remain honest bytes-only locks. The lock
itself does not claim universal font-table validation/shaping/fallback/
rasterization or a universal data schema/semantic interpretation/external-
reference policy. `caption`, `transcript`, and `lut` deliberately retain the
compatible outer data-resource envelope while exposing distinct public nominal
types and a compiler-owned, closed kind/format/parser-policy authority. Lock
creation and application securely reread and strictly parse those exact bytes,
including unused typed declarations; their dedicated consumers reject a
different authority before execution. Legacy `data(...)` omission preserves
the earlier consumer-owned parsing contract. `ImageSequenceAsset` is likewise
not a new filesystem resource kind: its strict manifest and every ordered image
member remain independently locked resources, while the compiler-authenticated
derived source binds their order, dimensions, cadence, and cache identity. See
[CAPTIONS.md](CAPTIONS.md), [TRANSCRIPT_EDITING.md](TRANSCRIPT_EDITING.md),
[LUTS.md](LUTS.md), and [IMAGE_SEQUENCE.md](IMAGE_SEQUENCE.md). V1 and v2 locks
are preserved only as archived evidence and are refused by the active compiler
with instructions to regenerate. They cannot be safely auto-migrated because
v1 lacks required probe/native identity and v2 did not require the selected
compositor identity.

### 9.2 Three determinism tiers

CUT does not use one ambiguous determinism claim:

1. **Semantic determinism** means identical locked source, packages, resource bytes and validated metadata produce the same CutAVIR graph/build ID. Lock v3 implements this contract for its supported resource kinds.
2. **Decoded-media determinism** means identical locked decoder/runtime inputs produce identical frame/sample buffers. The reference runtime records this as `unverified`.
3. **Bitstream determinism** means the final encoded bytes are identical. The reference runtime records this as `unverified`.

Lock v3 pins the metadata-producing `ffprobe` or Sharp/libvips identity, the selected compositor, and CUT's reference-runtime identity. It does not pin CPU behavior, the FFmpeg decoder/encoder binary, codec implementation or every transitive native dependency. Those omissions are why decoded-media and bitstream determinism remain explicitly `unverified`; a render manifest hash is an observation, not a cross-machine bitstream guarantee.

### 9.3 CLI lifecycle

```bash
cut doctor
cut check project.cut
cut fmt project.cut --check --json
cut lint project.cut --deny-warnings --json
cut lock project.cut --out cut.lock --json
cut build project.cut --lock cut.lock --out graph.cutir.json --json
cut inspect project.cut --lock cut.lock --json
cut test project.cut --lock cut.lock --json
cut preview project.cut --lock cut.lock --json
cut preview project.cut --lock cut.lock --range 2s:5s --width 640 \
  --out review/range.mp4 --json
cut render project.cut --lock cut.lock --output release --out release.mp4
cut diff graph.cutir.json replay.cutir.json --json
```

- `check` parses and type-checks without probing project media. A reachable
  `transcriptEdit` additionally reads its bounded declared transcript DataAsset
  because the stable-word selection is compile-time semantics; audio bytes and
  native stream metadata are authenticated later by `lock`.
- `fmt` deterministically formats parseable source; `--stdin` plus `--stdout`
  supports dirty editor buffers while preserving the real source identity.
- `lint` follows imports, assets, constants, functions, components and timelines
  from entry and user-module exports. It emits stable source-located `CUTL1001`-`CUTL1006`
  warnings; warnings exit zero by default and `--deny-warnings` exits 2.
- `lock` compiles, resolves project-local resources, hashes them, and writes a
  lockfile. `--json` emits versioned frozen-resource/package/job counts and the
  three determinism tiers.
- `build` compiles CutAVIR; with `--lock`, it verifies and applies the lock
  before writing IR. `--json` emits the build ID, determinism state and graph
  entity counts.
- `inspect` prints graph counts and determinism state. `--json` emits the
  versioned executable graph view: exact composition clocks and roots, graph
  budget metrics, node adjacency/source locations, signal/resource/package
  counts, outputs, jobs and assertions. Each AudioTrack graph node also exposes
  its canonical ordered editorial-item projection: exact destination/source,
  region `nodeId`, processed-leaf `sourceNodeId`, and optional `linkId`. Direct
  AudioClip items omit `sourceNodeId`, and non-AudioTrack nodes omit the whole
  editorial projection. It also accepts `--lock`.
- `test` recomputes supported authored assertions from final IR after applying
  the exact lock; failed or unsupported/deferred results exit 2, while malformed
  assertion IR or a stored/recomputed status mismatch is a diagnostic failure.
- `preview` and `render` require source-declared outputs and use the same
  reference runtime; preview selects authored locked proxies with explicit
  master fallback and render selects masters. With neither `--range` nor
  `--width`, preview preserves the authored full-output behavior. Supplying
  either invokes the bounded preview contract: exact half-open endpoints must
  land on both the composition frame and sample grids, only those global frames
  and samples execute, and optional width reduction uses `lanczos3-v1` with no
  upscaling or aspect drift. CUT never rewrites source or renders a full movie
  and post-trims it for this path.
- `diff` emits versioned `cut-av-ir-semantic-diff` v2. It covers every current
  public CutAVIR v3 execution field: top-level compiler/project/determinism/
  timebase and ordered entity arrays, plus compositions, scenes, nodes,
  signals, resources, modules, jobs, outputs and assertions. It deliberately
  excludes exact-source/build container hashes, source provenance (including
  nested picture-edit operation/item spans) and derived node/signal content
  hashes. Comments and formatting therefore remain semantically invisible
  while authored or locked execution changes do not.
- `relink` dry-runs or atomically writes one typed inline asset locator and
  deliberately invalidates existing package/media locks.
- `package init/add/remove/list/update/lock/verify` owns local/file source
  dependency trust. `cut.package.lock` and audiovisual `cut.lock` are distinct.
- `otio export` and `otio import` operate on the documented strict editorial
  subset with structured lossy/refusal reports.

A `build` without `--lock` is useful for compiler inspection but remains
semantically unlocked and is refused by the reference renderer. The old
`av-build`/`av-inspect`/`av-render` spellings remain aliases during alpha; new
documentation uses the canonical names.

## 10. Reference runtime conformance

The included runtime is a correctness/reference backend, not the full CUT execution target.

### 10.1 Implemented picture subset

- trimmed video with exact selected-stream/time-base validation, full-source `loop`, or final-frame `endBehavior: "hold"` behavior; `fit: "contain"` leaves uncovered layer pixels transparent so lower layers remain visible rather than baking in black bars; public `Video.crop` shares the strict normalized native-pixel crop contract with Image;
- images with `cover`, `contain`, or `fill` and normalized source crops; up to sixteen direct Image/Video retained branches can execute in source order with ordinary bounded local raster siblings through the LocalSpace composition described above;
- `Text` shaped through the documented fixed-font subset into bounded paths from
  a locked fixed-instance monochrome-outline FontAsset, with no host fallback;
  tracking, fixed-font wrapping, line limits/alignment and optional hard or
  blurred shadow execute; complex-script/bidi execution belongs to opt-in
  `FlowText`, not this `Text` path;
- shaping-omitted `FlowText` shapes one shared printable-ASCII-plus-LF layout from a closed set
  of explicit locked fixed-instance FontAssets. `FlowText.font` is inherited;
  the optional final `textSpan.font` parameter selects another locked face only
  across a space/LF boundary. Each face keeps locked glyph metrics while all
  runs use one authored baseline/line grid. Host lookup, implicit fallback,
  synthesized faces, redundant base/same-byte overrides and in-word face
  changes fail closed. Every resolved face ID/locator/hash is inspectable and
  participates recursively in semantic, graph, scene and cache identity. This
  omitted profile does not claim bidi, complex scripts, combining marks,
  Unicode fallback or language-aware line breaking; the normative boundary is
  in `FLOW_TEXT.md`;
- the additive public `textShaping(paragraphDirection, language,
  fallbackFonts)` record, optional `FlowText.shaping`, and
  `textUnitMotion(by: "cluster", order?: "logical" | "visual")` fields execute
  the closed complex-text source/IR contract. Omission preserves the preceding
  legacy path. The opt-in path uses a feature-scoped pinned
  shaper/bidi/segmentation closure, ordered locked font bytes, explicit
  paragraph direction, stable cluster evidence and strict loader validation;
  it never authorizes host shaping or fallback. The exact backend bytes and
  fallback/wrap/selector/normalization policies enter IR, lock, graph/cache,
  inspect and shaped frame/contact/render evidence under the preregistered
  NAR-10 acceptance matrix;
- strict locked WebVTT/SRT `Captions` with exact end-exclusive cues, authored glyph-covered Unicode/multiline order, fixed-instance locked TTF/OTF glyph paths, bounded safe-area layout, and pure sidecar interchange;
- rectangles, circles, paths, and cumulative-arc-length `Trace` reveals;
- picture-only `Precomp(Timeline)` layers with exact full-source clocks,
  transparent recursive nesting, same-format refusal, bounded composition
  graphs, distinct instance state and transitive source-content cache identity;
- ordered groups and `Camera2D` containers; `Group` adds bounded two-axis skew and centre-relative anchors, and nested groups execute a documented inner-to-outer scale/skew/rotation/translation/opacity order; a direct unary `Camera2D { LocalSpace { ... } }` retains the complete bounded local tile through registration/scale/rotation/delivery-translation/opacity while all other Camera2D graphs preserve legacy canvas behavior; anchor parity on other retained layer forms remains missing;
- `Composite` with source-ordered children and `normal`, `source-over`, `multiply`, `screen`, `overlay`, `darken`, `lighten`, `add`, `plus`, and `difference` in linear-light sRGB;
- `Mask` with exactly two source-ordered visual children (target, then matte), alpha/linear-luminance/linear-RGB selection, signed expansion/erosion, deterministic feathering, inversion, straight-alpha output and hidden-RGB safety;
- unary `ClipPath` with a bounded static implicitly closed pixel-coordinate polygon, nonzero/even-odd fill, inversion, exact fixed-grid coverage, straight-alpha output and hidden-RGB safety;
- unary `Blur`, `Shadow`, `Glow`, `Vignette`, `Sharpen`, `Grain`, and `Duotone` chains with the closed inputs and bounds in section 6.1;
- unary `LUT` over locked strict 1D/3D `.cube` bytes with encoded-sRGB
  linear/trilinear interpolation, signal-driven strength, exact alpha and
  localized resource-byte cache identity;
- unary `ColorConvert` plus locked video-consumer strict `inputColor` or
  author-declared-unverified `inputColorInterpretation`, and tagged output color
  across the bounded encoded/linear-sRGB and full/limited-Rec.709 SDR set;
- data-bound globes/maps, routes, markers, wavefronts, and bounded connections; labels on Map, Marker, and Connections use locked fixed-font outline paths with no host-font fallback and Marker provides edge-aware—not inter-label collision-aware—placement;
- locked-range waveform/spectrogram analysis pictures;
- verified locked-source peak/RMS amplitude signals mapped through ordinary typed direct-root `Group` transform/opacity properties; see [Audio-reactive visual signals](AUDIO_REACTIVE.md);
- documentary evidence graphics;
- exact property event tracks plus the retained constant, step, and keyframe signal variants.

The picture surface is CPU-rasterized. Its declared retained boundary is 8-bit straight encoded-sRGB; the managed SDR input/convert/output slice above makes changes at explicit authored boundaries. `Composite` owns and tests its listed blend equations in linear-light sRGB. Vignette color mixing, Duotone mapping and effect halo compositing are linear-light sRGB, while Gaussian blur, Sharpen, Grain and `LUT` interpolation/strength operate on encoded-sRGB channels; Grain and Duotone preserve straight alpha exactly and the latter preserves exact endpoint bytes. Mask color coverage safely unpremultiplies encoded sRGB, converts the selected RGB/luminance channel to linear light, associates it with matte alpha, and returns straight-alpha output after deterministic scalar morphology/feathering. ClipPath uses CUT-owned scalar fixed-grid polygon coverage and the same straight-alpha/hidden-RGB boundary without interpreting color channels.

Final retained scale/translation is also CUT-owned: its direct fractional Q16
bilinear path samples the original tile only inside the exact destination clip,
operates on alpha-associated encoded-sRGB, and returns hidden-RGB-clean straight
bytes. The admitted integer bypass preserves independent hidden RGB exactly.
The same direct path is the bounded zero-rotation fallback when the historical
RGB16 resize intermediate would exceed 512 MiB; that fallback does not widen
the ceiling. Group/root assembly before that boundary, skew/rotation,
SVG/image/text rasterization, the remaining grading stages, and other
Sharp/libvips operations do not yet share one managed pipeline, so the backend
does not claim end-to-end color management, scene-linear float work, image ICC
handling, GPU parity, cross-platform color conformance, OCIO/ACES/HDR/log, or
real-time 4K effect chains. Every effect is full-canvas and clips its halo/blur
at the edge. Bezier/animated clipping paths, arbitrary channel expressions,
roto/tracking and animated mask controls remain absent. FFmpeg supplies codec
and low-level media conversion while CUT owns the declared input assertion,
transfer/range semantics, graph order, cache identity, delivery tags and
verification.

### 10.2 Implemented audio subset

- source audio, narration, and linked-clip source audio;
- exact native-source endpoints, destination placement, edge fades, deterministic resampling, and stereo formatting. Cross-rate durations map to the nearest destination sample with ties-to-even and a one-sample minimum for any non-empty source range; the IR-derived runtime config exposes whether the mapping was exact or rounded;
- deterministic sine tone and seeded colored noise;
- deterministic typed event-list `Synth` with exact pitch/Hz note placement, shared ADSR, sine/triangle/PolyBLEP saw/square waveforms, bounded polyphony, and explicit CPU/storage refusals; see [Deterministic event-list synthesis](SYNTH.md);
- buses/mixing, optional closed `Bus.role` routing metadata (`dialogue`, `music`, `ambience`, `sfx`), closed program/aux Bus delivery kinds, explicit bounded child or source-tap sends/returns/submixes, gain, pan, parametric EQ, high-pass, low-pass, compression, de-essing, limiting, reverb, finite-tap delay, and sidechain compression;
- bounded CUT-owned recursive `TempoDelay` driven by exact piecewise-constant destination-clock `TempoMap` records; see [Tempo maps and tempo-synchronized delay](TEMPO_DELAY.md);
- bounded CUT-owned offline `TimeStretch` with exact source/destination sample intervals, independent static semitone pitch, draft/balanced analysis tiers and fail-closed work limits; see [Bounded audio time stretch and pitch](AUDIO_TIME_STRETCH.md);
- deterministic named top-level program and explicit auxiliary-return Bus delivery as exact stereo 24-bit pre-master WAVE stems plus a content-hashed canonical manifest whose route exposes kind, ordered aux dependencies and optional top-level role; nested roles remain authored metadata and do not create implicit stems; see [Deterministic audio stems](AUDIO_STEMS.md);
- a pass-through `Meter` graph node whose typed `target`, `truePeak`, `samplePeak`, and `range` values resolve one release contract (defaults `-14 LUFS`, `-1 dBTP`, `0 dBFS`, `9 LU`; conflicting reachable targets fail). FFmpeg supplies LUFS/LRA normalization and a separately named cross-check, while CUT's 48 kHz BS.1770-5 kernel scans the exact decoded normalized-PCM and authored AAC boundaries. AAC priming and trailing codec padding are measured but excluded; silence is an exact zero-linear peak. Other mastering rates fail before backend work rather than inheriting the 48 kHz claim;
- raw stereo f32le pre-master cache boundary, 24-bit PCM post-normalization
  delivery intermediate, and 256 kbps AAC delivery audio.

`Gain.amount`, `Send.amount`, `Pan.position`, `Reverb.wet`, `Delay.wet`,
ParametricEQ `frequency`, `gain`, and `q`, High/LowPass `frequency` and `q`,
and Compressor `threshold`, `ratio`, `attack`, `release`, and `makeup`,
DeEsser `intensity` and `amount`, plus Sidechain `amount`, `threshold`, `attack`, and `release` execute signal automation per output
sample. `EQ`
is a compatibility spelling of `ParametricEQ` and lowers to the same kernel.
Every attached property signal carries its declared semantic `valueType` in
CutAVIR (`Frequency`, `Gain`, `Number`, `Time`, or `Ratio`); canonical loaded IR
with a mismatched or `inferred` type fails before execution. This audio path
supports `linear` and `outCubic`; other general signal easings fail with stable
source-located automation diagnostics. `Pan` is stereo balance, not spatial
audio. `Reverb.wet` is a Ratio that automates complementary dry/effect
coefficients around one continuously running effect state. High/LowPass cutoff
is a Frequency from 1 Hz through 45% of the composition sample rate and Q is
0.1 through 20. `Delay(time: Time, repeats?: Number = 3, decay?: Ratio =
50%, wet?: Ratio = 25%)` keeps one fixed finite-tap topology while `wet`
automates complementary dry/tap coefficients on the destination sample clock.
Its time, repeats, and decay remain closed static controls.

`ChannelMatrix(leftToLeft:, leftToRight:, rightToLeft:, rightToRight:)`
applies one static stereo 2×2 linear-amplitude matrix to exactly one audio
child. Output left is `leftToLeft * inputLeft + rightToLeft * inputRight`;
output right is `leftToRight * inputLeft + rightToRight * inputRight`.
Every coefficient is required and bounded to `-4` through `4`. The exact
identity matrix is rejected as an inert authored processor. The matrix neither
discovers channel layouts nor normalizes loudness, and it does not claim
surround, ambisonic, object-audio, or host downmix semantics.

`TempoDelay(tempo: TempoMap, delay: Beat, feedback?: Ratio = 35%, mix?:
Ratio = 25%)` accepts exactly one audio child. The first tempo point is exactly
zero; later points are strictly ordered, sample-grid-aligned destination times.
Each point owns its boundary sample and supplies one exact piecewise-constant
BPM segment. CUT integrates and inverts that beat clock to read a causal
historical recursive float32 state with deterministic linear fractional-sample
interpolation. Controls are static in this slice. Nonzero feedback is not
equivalent to finite-tap `Delay`; only the exact-grid, `feedback: 0%`,
`repeats: 1` case has the same one-tap dry/wet equation. The normative clock,
recurrence, limits, diagnostics, evidence and non-claims are specified in
[Tempo maps and tempo-synchronized delay](TEMPO_DELAY.md).

Limiter `ceiling`
and `release` execute on the exact destination-sample clock while `lookahead`
remains a static exact-sample topology control. Sidechain owns one stereo-linked peak envelope;
all four controls vary on the destination-sample clock without restarting that
envelope. Attack/release values choose the coefficient for that exact sample;
they do not divide the processor into static regions. The key
is a referenced AudioNode and is not mixed into program output. Its exact
calibration and recurrence are specified in [CUT-owned Sidechain](SIDECHAIN.md).

`DeEsser(intensity?: Number = 0.35, amount?: Number = 0.5)` owns one
causal complementary low/high split and one stereo-linked peak envelope.
Both controls stay in `0..1` and execute on the exact destination-sample clock
without rebuilding the split or resetting state. Intensity interpolates the
detector threshold from -6 to -48 dB while scaling the available 18 dB maximum
reduction; amount scales that reduction depth. Only the high residual is
attenuated, with one gain applied to both channels. An exact zero in either
control returns the original sample while still advancing crossover/envelope
state. The normative recurrence, work limits, evidence and non-claims are in
[CUT-owned dynamic DeEsser](DEESSER.md).

`ParametricEQ(frequency?: Frequency = 180hz, gain?: Gain = 0db, q?: Number =
1)` owns one continuously stateful trapezoidal-integrator state-variable bell.
On each output sample and independently for each channel, CUT computes
`A = 10^(gain/40)`, `g = tan(pi*frequency/fs)`, `k = 1/(Q*A)`,
`a1 = 1/(1+g*(g+k))`, `a2 = g*a1`, and `a3 = g*a2`. Given retained states
`s1` and `s2`, it then executes `v3 = x-s2`, `band = a1*s1+a2*v3`,
`low = s2+a2*s1+a3*v3`, updates `s1 = 2*band-s1` and `s2 = 2*low-s2`, and
emits `y = x+k*(A*A-1)*band`. The two integrator states are initialized once
and survive every coefficient change; there are no retained input/output delay
samples whose denominator polynomial is abruptly replaced.

Static-only ParametricEQ values admit frequency from 1 Hz to below Nyquist,
gain from -192 through +60 dB, and Q from 0.001 through 1000. If any of the
node's three properties has events, every authored/default frequency, gain and
Q control on that node must instead remain inside the time-varying safe
envelope: 20 Hz through 45% of sample rate, -24 through +24 dB, and Q 0.1
through 20. Inside that time-varying safe envelope, static constructor values
and equivalent sample-zero property writes traverse this same recurrence and
are decoded-PCM identical on the pinned backend. Broad static-only values do
not imply that an equivalent property write is admissible.

HighPass and LowPass share one normative trapezoidal-integrator state-variable
filter. For every channel and output sample, CUT evaluates the exact cutoff and
Q signals on that sample's global clock, computes `g = tan(pi * cutoff / sampleRate)`
and `k = 1 / Q`, then applies the standard two-integrator update:
`a1 = 1/(1+g*(g+k))`, `a2 = g*a1`, `a3 = g*a2`, `v3 = input-ic2`,
`v1 = a1*ic1+a2*v3`, `v2 = ic2+a2*ic1+a3*v3`, followed by
`ic1 = 2*v1-ic1` and `ic2 = 2*v2-ic2`. Low-pass emits `v2`; high-pass emits
`input-k*v1-v2`. The two integrator states are initialized once at graph start
and never reset or segmented at cutoff/Q set or animation events. Static cutoff/Q and
equivalent sample-zero property writes use this same path and are byte-identical
on the pinned backend. A hard `set` intentionally changes coefficients on its
exact event sample and can itself be abrupt; use `linear` or `outCubic` for a
smooth sweep.

One composition permits at most 32 automated High/LowPass nodes, 32 automated
ParametricEQ nodes, 128 automated processors across all supported classes, and
131,072 aggregate rendered backend-expression characters. It also permits at
most 536,870,912 aggregate channel-samples for either filter class. Each
property has at most 64 events; a filter or ParametricEQ node has at most 128
total events and 32,768 aggregate expression characters. Event expressions
use a balanced piecewise decision tree, preserving later-event precedence
while keeping conditional depth logarithmic in event count. Cutoff/Q bounds keep the tangent and
resonant state numerically bounded. The reference runtime mirrors the scalar
algorithms through independent mono FFmpeg `aeval` state banks before rejoining
stereo; backend command timing does not define coefficient changes. Tests
reconcile decoded PCM against the scalar updates, but CUT does not
yet claim byte identity across different FFmpeg/libm versions, SIMD choices,
architectures, or a production plugin/native backend.

The general audio graph has independent composition-wide resource preflight.
It admits at most 137,438,953,472 recursively expanded node-channel-samples and a
frame-aligned stereo PCM24 payload of 4,294,967,196 bytes; the latter is the
largest multiple-of-six payload whose ordinary 102-byte reference WAVE keeps
its RIFF chunk size representable without RF64. Repeated references to one IR
node are distinct execution visits, not one unit of work. The session, direct
audio and stem entry points use the same iterative cycle/depth/expansion
analysis before recursive backend construction. The exact emitted backend plan
then admits at most 137,438,953,472 conservative full-output stereo
filter-channel-samples, 2,048 filter entries, 1,048,576 UTF-8 filter-graph bytes,
4,096 arguments, 24,576 UTF-8 argv bytes including NUL terminators, and 8,192
bytes for any one argument. CUT writes the bounded filter graph to a private
temporary `-filter_complex_script` rather than making graph size depend on host
`ARG_MAX`; cleanup runs on success or failure. Tests render 2,046 independent
Tone roots at the exact 2,048-entry boundary, reject 5,000 roots, reject a
two-hour 2,046-fold duplicated child, and reject depth/cycles before temp,
output, or FFmpeg spawn. These are reference-backend work limits, not
recommendations for ordinary project complexity.

`Compressor(threshold?: Gain = -18db, ratio?: Number = 3, attack?: Time =
20ms, release?: Time = 180ms, makeup?: Gain = 0db)` is one CUT-owned,
stereo-linked peak compressor. At each output sample its detector is
`d = max(abs(left), abs(right))`. Given the previous envelope `e`, CUT chooses
the current attack time when `d > e` and the current release time otherwise,
computes `c = exp(-1/(time*sampleRate))`, and updates
`e = c*e + (1-c)*d`. When `e > 1e-12`, envelope level is
`L = (20/ln(10))*ln(e)` dB. Reduction is zero at or below threshold and
`-(L-threshold)*(1-1/ratio)` above it; output gain is
`10^((reduction+makeup)/20)`. One envelope is initialized to zero at graph
start and is never reset, segmented, or snapshotted by property events. Both
channels use the same detector/envelope/gain, so automation cannot shift the
stereo image.

Compressor threshold is -60 through 0 dB, ratio is 1:1 through 20:1, attack is
0.01 through 2,000 ms, release is 0.01 through 9,000 ms, and makeup is -24
through +24 dB. Static arguments and equivalent sample-zero property writes
use the same recurrence and are byte-identical on the pinned backend. A hard
threshold/ratio/makeup set can create an intentional gain discontinuity; use a
curve when that is not desired. Attack/release events change the coefficient
on their exact sample without clearing the envelope. One composition permits
at most 16 automated Compressor nodes and 268,435,456 aggregate Compressor
channel-samples. Each property retains the general 64-event limit, while one
Compressor is additionally capped at 128 total events and 65,536 aggregate
automation-expression characters.

This is a deterministic 80/20 dynamics primitive, not a claim of lookahead,
soft-knee, RMS, multiband, oversampled, analog-modelled, or mastering-grade
compression. Decoded PCM is reconciled against the scalar recurrence,
including a reset-discriminator and asymmetric-stereo fixtures. CUT does not
yet claim byte identity across FFmpeg/libm versions, SIMD choices,
architectures, or future native/plugin implementations.

`TimeStretch(sourceDuration: Time, duration: Time, pitch?: Number = 0,
quality?: String = "balanced") { audio }` owns one exact offline retime. The
node accepts exactly one audio child, reads the half-open child interval that
begins at the node's exact placement, and emits exactly `duration * sampleRate`
samples at that same placement. `sourceDuration`, `duration`, and placement
must be exact sample counts. The destination/source ratio is 0.5 through 2.0,
pitch is -12 through +12 semitones, and quality is exactly `"draft"` or
`"balanced"`. These arguments are static; the node exposes no dynamic
properties. Unknown inputs, nested TimeStretch nodes, invalid child graphs,
off-grid ranges and excess work fail with source-located
`CUT_AUDIO_TIME_STRETCH_*` diagnostics.

One ordinary `AudioTrack` item may own exactly one public `TimeStretch` inside
its closed `AudioRegion` unary chain. The leaf `AudioClip` range duration must
equal `sourceDuration`; `duration` must equal the outer region destination;
all descendants retain that destination placement/scene. The compiler, strict
IR loader and runtime independently reconcile this identity. Inserts inside
the stretch execute over its source span and inserts outside it execute over
the destination span. A retimed region is static and forbids head/tail handles,
crossfades, structural `AudioTrack(sourceDuration:, edits:)` plans and linked
edit transactions. Unequal intervals without this exact public node remain an
implicit-retime error.

Let `S` and `D` be the exact source and destination sample counts, `p` the
semitone shift, `f = 2^(p/12)`, and `M = floor(D*f + 0.5)`. CUT applies its
owned radix-2 phase vocoder from `S` to `M` independently on each channel, then
linearly resamples `M` to exactly `D`. Draft uses a 512-sample sine window with
a 128-sample analysis hop; balanced uses 1,024 and 256. Synthesis-frame starts
are deterministic integer mappings from source-frame starts; per-bin phase
advance unwraps the difference from the expected analysis advance and scales
it by the exact synthesis delta. Inverse transforms overlap-add with
squared-window normalization. `S == D` with zero pitch is an exact decoded-PCM
identity bypass. FFmpeg supplies the bounded child PCM and reads CUT's result;
it does not define these time/pitch semantics through `atempo`, `asetrate`, or
another retime filter.

Each chosen source and destination must contain at least four windows. One node
is limited to 2,000,000 source samples, 2,000,000 destination samples and
4,000,000 intermediate samples. One composition is limited to eight nodes,
8,000,000 aggregate destination samples, and 400,000,000 FFT work units. The
full algorithm, rounding, limits and evidence are normative in
[AUDIO_TIME_STRETCH.md](AUDIO_TIME_STRETCH.md). The alpha does not claim
transient or formant preservation, stereo phase locking, variable/eased or
multi-item retime, real-time execution, a production listening corpus,
or cross-platform decoded-buffer identity.

`Send` has two closed forms. `Send(amount: Gain) { audio }` is structurally
owned: its child graph passes through once at unity on the dry path, and the
same post-child signal is exposed once at `amount` to one `Return`.
`let tap = Send(amount: Gain, source: boundProgramAudio)` is a zero-child
reference node: it contributes no dry root and exposes the explicitly bound
program signal only through its claiming Return. Its compatible default
`tap: "post"` reads the complete bound source. `tap: "pre-fader"` is admitted
only when `source:` is one explicit structurally owned `Gain`, or a program
`Bus` whose sole direct child is one explicit `Gain`; it reads the mixed direct
children immediately before that Gain without altering the dry path. `source:` with children, a
root/structural `Send(source:)`, or a zero-child Send without `source:` fails
with a stable source diagnostic rather than becoming duplicated or silent.
In both forms `amount` may use exact sample-clock `set`, `linear`, or
`outCubic` automation from `-120db` through `12db`; it changes only the
auxiliary contribution and never restarts or mutates the program dry graph.
`Return(sends: List<AudioNode>)` mixes 1
through 32 explicitly referenced `Send` bindings in authored list order.
Every reachable Send must be claimed by exactly one reachable Return; duplicate
references, multiple claims, non-Send references, dangling Sends, empty
Returns, invalid detached routing nodes/references, duplicate structural ownership, and feedback
cycles fail with source-located `CUT_AUDIO_ROUTING_*` diagnostics. To feed more
than one destination, author separately bound Sends against the same program
binding. There is no route-name discovery or hidden bus matrix.

`Submix(name: String) { audio }` is an insert-capable structural mix container,
not an automatic delivery stem. Its composition-local name is unique under
ASCII case folding and must match `[A-Za-z][A-Za-z0-9_.-]{0,63}`. A composition
is limited to 256 Sends, 64 Returns, and 64 Submixes. These bounds and every
explicit node reference participate in typed IR, semantic/build identity, and
transitive cache invalidation. The current slice is explicit stereo routing.
`Send.amount` may be automated on the exact destination-sample clock while the
program dry graph stays at unity. CUT does not claim inferred faders, feedback,
surround/object matrices, or aux-to-aux routing.

`Bus(name?: String, role?: String, kind?: "program" | "aux") { audio }` keeps
all three values as ordinary typed node inputs. Omitted `kind` resolves to
`"program"` for source and IR compatibility. `role` is closed to `dialogue`,
`music`, `ambience`, and `sfx`; unknown strings, unknown kinds and non-string
hostile loaded IR fail source-located before audio or stem work. Roles are not
unique and have no DSP semantics.

For stem delivery, each top-level program Bus structurally owns its dry source
graph. Each top-level aux Bus structurally owns processors/Returns but no source
and must receive at least one detached Send whose `source:` belongs to a program
stem. Only aux Returns may cross stem boundaries. Direct sources in aux buses,
program-to-program pulls, aux-to-aux taps, nested aux buses, self/cyclic routes,
or missing/ambiguous owners fail with `CUT_STEM_AUX_*` or existing routing
diagnostics before backend work. Master execution and stem selection follow the
same authored node references; the compiler does not synthesize another graph.

Shared mastering uses exactly one `Submix(name: "pre-master")` whose direct
children are the uniquely named delivered Buses. It may sit below a linear
one-child chain of `Gain`, `HighPass`, `LowPass`, `EQ`/`ParametricEQ`,
`Compressor`, `DeEsser`, and `Limiter`, plus transparent `Meter`/component
fragments. Master execution retains that chain; stems execute from each Bus
before it. Multiple/branching boundaries, buses outside, non-Bus children,
duration/routing processors and inferred `Limiter { Bus }` fail before backend
or publication. Final `Meter.samplePeak` gates the authored master; pre-master
PCM24 serialization independently defaults to 0 dBFS. Existing manifest v5
already binds the build, lock, route graph and output hashes.

For a Sidechain inside a named stem, the key must resolve to exactly one
structural top-level stem owner. A cross-stem key requires two program stems;
unowned or ambiguous keys, cross-stem aux participation and cross-stem control cycles fail
source-located with stable `CUT_STEM_CONTROL_*` diagnostics. The key drives the
detector but is not mixed into the controlled stem.

Every stem-manifest v5 route records its resolved kind, ordered Return/Send/
source-stem dependencies, ordered Sidechain/key/source-stem dependencies with
both transitive graph identities, the route graph hash and optional role. Its
top-level `lock.sha256` binds the exact verified `cut.lock` bytes applied by the
caller.
Nested program-Bus roles remain inspectable metadata but do not create implicit
stems. Kind, role and dependencies participate in semantic/build/stem identity,
while sonically transparent metadata remains outside the pre-master sample-cache
key. Exact canonical v3 and v4 manifests retain bounded stale-file cleanup
compatibility against their historical closed shapes; new output and its closed
published JSON Schema are v5. Missing/malformed lock identity and unknown
stem-export options fail before graph, filesystem, resource, cache or media work.

Media ranges shorter than 32 native source samples use an explicit two-tap resampling kernel because the ordinary polyphase filter can consume such a range entirely while priming. Longer ranges retain the higher-quality polyphase path. The threshold and kernel choice are part of the locked reference-runtime implementation identity; decoded one-sample cross-rate output is covered by a sample-level conformance fixture.

The reference `Reverb` control is a deterministic dry/effect crossfade: `0%` is byte-identical dry bypass and `100%` removes the effect filter's direct component. Automated changes retain exactly one effect topology and state for the full node interval; only the complementary per-sample output coefficients change, so events do not restart the reverb or duplicate endpoints. The reference limiter is a CUT-owned private-f32 processor with a frozen four-phase Annex 2 envelope, stereo-linked lookahead gain, exact-sample ceiling/release controls, output rescan and bounded constant-ceiling reconciliation. Future audio peaks may change earlier gain inside the authored lookahead; future control events never do. Exact silence/frame counts and nested processing are preserved without an activity mask or FFmpeg `alimiter`. For static ceilings, CUT measures the same snapshotted Float32 boundary with its Annex 2 kernel and a separately identified FFmpeg loudnorm input meter, applies at most one programme-uniform correction to the worse result plus 0.01 dB safety, then requires both unchanged authorities to pass. Dynamic ceilings explicitly omit this global secondary correction, and varying ceilings that need a programme-wide non-causal core reconciliation fail. The original 48 kHz in-memory core retains its `2^30`/3,728,270-frame bound. Longer programmes select a fixed 65,536-frame private-file adapter with exact FIR/lookahead halos and continuous release state, bounded to five minutes per invocation and a separate `2^34` aggregate graph budget. Non-48 kHz processing, dynamic-meter reconciliation and the limited listening/platform corpus keep this bounded alpha evidence rather than a universal professional true-peak guarantee; see [CUT-owned limiter](LIMITER.md).

Reference `Delay` is a finite feed-forward tap plan, not recursive feedback. Tap `k` starts at exact output sample `k × time`; its effect-bus weight is `decay^(k-1)` normalized across the authored 1–16 taps. Output is the complementary mix `dry × (1-wet) + normalized taps × wet`; static `wet: 0%` returns the child graph unchanged at decoded PCM while all controls remain validated and hashed. A `wet` signal retains the same complete tap topology and changes only destination-sample coefficients, so a set or curve does not restart taps or discard tails. `time` must be at least one sample and at most 10 seconds, `decay` is greater than 0% through 100%, total tap offset is capped at 30 seconds, and the final tap must begin before the composition boundary. The composition boundary truncates any remaining audible tail. These bounds make CPU/filter cost explicit; they do not claim feedback, tempo synchronization, ping-pong routing, diffusion, or automation of time/repeats/decay.

### 10.3 Output and cache

`DiagramLayout` has a separate content-addressed, project-local
`diagram-subscene-rgba` cache beneath the reference cache root. It stores each
bounded DiagramNode local tile and each routed edge's conservative tight tile;
a fully retracted edge is the canonical transparent 1-by-1 artifact. A cache
key is the closed hash of kind, exact dimensions, straight RGBA8 format,
topology/geometry/paint/temporal split hashes, the reference runtime and the
full DiagramLayout raster backend identity. The backend identity includes the
`@cut/diagram` implementation closure, platform, architecture, Node and every
reported Sharp/libvips dependency version.

The node temporal split is based on exact visual dependencies, not blindly on
the output frame. Completely static subtrees are timeless. Otherwise CUT hashes
descendant activity, evaluated properties, retained FlowText output and Trace's
exact phase: drawing position and head-fade time vary, while before-delay and
fully settled plateaus reuse. Unknown future local operations conservatively
retain exact time/frame until their dependency rule is implemented. Placement
and rank are outside the local node-pixel key, so moving an unchanged node
reuses its tile; route geometry remains in an edge key, and node paint and edge
paint invalidate only their respective raster dependencies.

Each persistent hit no-follow reads regular files and validates a strict closed
manifest, expected dimensions, exact `width * height * 4` byte count and
artifact SHA-256. Missing, malformed or corrupt entries become rebuild misses.
Publication stages the artifact before the manifest, same-process duplicate
work coalesces, and bounded deterministic namespace eviction is applied. This
cache layer never claims a picture scene-cache hit. It also does not yet own a
cross-process lock, publication lease or coordinated eviction policy: stages
owned by other PIDs are preserved, and frame evidence explicitly records
`multiProcessCoordination: "not-claimed"`.

Current exact-frame DiagramLayout evidence is version 2. Its node and edge
records point to a closed receipt registry containing split identity, verified
artifact, lookup reason and counters. `executionIdentity` omits lookup state,
counters and receipt history, so a cold and warm execution of the same exact
frame retain one semantic rendering identity. `observationIdentity` binds those
cache observations and is expected to differ. Historical DiagramLayout v1
evidence remains accepted by the frame schema without gaining a persistent-
cache claim. These receipts are engineering evidence only; they do not watch a
film, listen to its mix or establish a creative pass.

Scenes are rendered to cache entries keyed by transitive graph content, target, reference-runtime version, the closed `cut-reference-scene-encoding` v2 contract, and a freshly observed combined FFmpeg/ffprobe picture-toolchain identity. Each H.264 scene segment disables reordered B-frames before CUT joins independently encoded segments by concat-demuxer stream copy; otherwise a short segment's negative decode timestamps can be rebased so the joined file declares less time than its presentation span. The versioned codec/B-frame/join contract is in picture-cache identity, preventing reuse of an older incompatible segment, and a one-frame plus three-frame fixture verifies exact final duration through the real delivery boundary. The runtime resolves and no-follow hashes both executables plus their bounded banners, puts the combined integrity in `cut-render-cache` v3 and the full identity in `cut-scene-cache` v4, and spawns the exact absolute FFmpeg executable for a miss. A new encode verifies FFmpeg unchanged after encoder close and before publishing that scene artifact. The scene manifest is closed to format/version/key/hash/frame/runtime/backend and combined-toolchain fields; every new artifact or hit runs the exact bound ffprobe with before/after executable verification and reconciles decoded-frame count, zero start, duration clock, FPS, dimensions, H.264/pixel format, zero B-frames and managed color tags. A hostile hash-consistent one-frame substitution under a four-frame manifest is therefore a miss and rebuild, not a laundered hit. Warm hits rely on the fresh start-of-render combined identity and bound probe; an all-hit render has no later FFmpeg executable recheck. This boundary still omits dynamically linked libav/x264 bytes, and `cut.lock` v3 does not pin either media executable, so it is not complete cross-machine or same-user concurrent-mutation toolchain capture.

The exact pre-master stereo float mix has a separate content-addressed `f32le` artifact boundary keyed by recursively projected reachable audio execution, exact signals, locked resource bytes/probes, relevant package integrity, composition duration/sample rate, runtime, Node/platform and the complete bounded FFmpeg identity digest. A reachable Limiter also keys the CUT processor/static-compatibility identities and exact resolved compatibility executable bytes/banner. Compiler-assigned IDs and source locations are excluded, so unrelated picture insertion/renumbering does not invalidate audio. Every audio hit verifies file length and SHA-256, reconciles exactly `frames × 2 × 4` bytes, rejects non-finite samples, freshly enforces the reachable `Meter.samplePeak` ceiling, and validates closed path-free recursive limiter evidence against the current graph/toolchain. That Meter ceiling is intentionally outside the cache key so a stricter assertion rescans rather than re-renders identical samples. Scene picture streams are concatenated, the cached-or-rendered float boundary is explicitly demuxed for normalization, and the final MP4 is written with H.264 picture already encoded per scene, AAC audio, and fast-start metadata. Stems are independently checked and quantized after raw-float rendering; normalization and final delivery remain downstream uncached stages. See [the audio cache contract](AUDIO_CACHE.md).

The adjacent render-manifest v11 records the SHA-256 of the exact verified
`cut.lock` bytes, the full path-free combined FFmpeg/ffprobe picture-toolchain
identity, the exact requested stem-manifest SHA-256 and count, runtime,
locked build ID, output path/SHA-256, exact duration,
canvas/FPS, audio graph summary, exact pre-master sample-peak and
limiter-execution evidence, loudness measurements, mastering-reconciliation
status and constraints, the versioned CUT true-peak algorithm/coefficient
identity, normalized-PCM scan, per-AAC-pass encoded and decoded-boundary
SHA-256 plus decode/priming/padding/peak evidence, picture scene cache results,
and independent `cache.audio` v3 status/reason/key/artifact/graph/toolchain/
limiter evidence. Missing, malformed, uppercase or unknown render options fail
before resource probing, cache access or media work. The lock digest is evidence
identity, not a semantic cache key: two verified lock byte streams that resolve
to the same canonical graph may reuse media caches while their manifests retain
their distinct lock hashes. Delivery-report v2 fixes the MP4 movie timescale to
the authored sample rate and requires CUT and FFmpeg to measure the same
padding-excluded boundary. Historical v8/v9 manifests remain readable artifacts
but cannot satisfy the current professional-output or reference-study gate.

Final reference delivery uses an ordered staged-file rollback group. CUT encodes
and verifies AAC/color/loudness at a same-parent staged MP4,
fully prepares requested validated stem WAVs and lock-bound stem-manifest v5,
hashes its exact canonical staged bytes into render-manifest v11, and stages the
incremental composition and adjacent render manifests before changing a
public leaf. The WAVs, safely prior-manifest-owned stale-WAV removals, stem
manifest, MP4 and composition manifest publish before the render manifest; the
latter is the final commit-marker promotion and contains final paths only.
Caught ordinary backup/promotion errors restore the prior-or-absent set. This
specifies neither global atomic visibility nor crash/power-loss atomicity, and
private staging cleanup after a successful marker is best effort rather than a
false render failure. See [Deterministic audio stems](AUDIO_STEMS.md).

### 10.4 Hard refusals

The reference runtime refuses:

- unlocked resources or unresolved effect jobs;
- failed or deferred assertions;
- unsupported node operation IDs;
- timeline-level visual/AV roots;
- scenes that overlap, leave gaps, do not cover the timeline, or do not land on frame boundaries;
- any input, property, child, domain, or signal reference outside the closed executable kernel schema;
- reserved kernels whose semantics are not executable yet: `Shader`, `Light`, the legacy `@cut/documentary CaptionTrack`, and `TimeRemap`.

`@cut/data Chart` is no longer a reserved/open-named symbol. It lowers a
closed exact `List<Number>` plus bounded geometry/domain/palette controls to
ordinary `cut.data.chart` IR; the shared compiler/runtime validator rejects
unknown, invisible, conflicting, over-budget, or hostile values before SVG
construction. The text-free bar/line/area and signal-driven reveal semantics
are normative in [CHARTS.md](CHARTS.md). Labels and richer chart grammars are
not inferred.

`@cut/data SeriesChart` is the separate retained, data-bound chart contract.
Canonical CUT source declares an ordered `tableSchema` for each locked
`cut-table` v1 `DataAsset`, binds it with `tableSource`, and closes a
`tableQuery(sources:, steps:, result:)`. The only executable query steps are a
typed filter; deterministic inner equi-join with an explicit renamed
projection and output key; stable first-occurrence grouping; exact `count`,
`sum`, `mean`, `min`, or `max`; stable ordered sort; and a terminal x plus one
or more exact numeric series projection. Field and relation references are
checked before rendering. Query records lower to closed typed IR and execute
without SQL, eval, natural-language interpretation, an external database, or a
hidden query document. Locked source bytes, schemas, plan and result identity
participate in inspect, semantic diff and picture-cache identity.

`SeriesChart(query:, font:, frame:, xScale:, yScale:, series:, kind:, ...)`
accepts exact linear, stable first-seen categorical, explicit proleptic-
Gregorian date, and deterministic fixed-point logarithmic scales. Its retained
`bar`, `line`, and `area` renderers use the same checked query result and scale
layout for marks, collision-thinned tick labels and the optional flowing
legend. Text is emitted only from a locked fixed-instance font; background is
bounded to the authored plot; reveal and retained transforms remain ordinary
public properties. The reference runtime bounds a chart to eight sources,
8 MiB of source data in total, 4,096 rows and 65,536 cells per source, 8,192
result cells, 512 marks, sixteen declared series, and its documented font,
outline, SVG and canvas budgets. The render target must retain the authored
composition canvas; a different output size is not an implicit responsive
layout.

This contract does not provide outer joins, arbitrary relational/window
operators, SQL import, schema inference or evolution, stacked/scatter/pie
charts, general collision-aware diagram layout, axis-title or machine-typed
physical-unit semantics, accessibility metadata, complex-script fallback, or
automatic responsive chart redesign. A series name may visibly include a unit,
but CUT does not infer dimensional meaning from that label. Two changing-frame
public studies and conformance tests establish execution, not a creative pass;
no study has completed named-human full-speed or headphone review.

The separate pure `@cut/data` `keyedNumber`, `markTarget`, `barLayout`,
`barTargets`, and `formatNumber` functions are compile-time public semantics.
They derive exact keyed bar source geometry, canonical target joins, semantic
layout identity, and bounded locale-independent fixed formatting, then vanish
into ordinary typed IR. A source program loops over `BarLayout.marks` or
`List<BarMarkTransform>` and authors its own `Rect`, typography, and animation;
there is no hidden bar-layout renderer or operation. Exact fields, diagnostic
codes, zero-height baseline behavior and the deliberately narrow non-general
scope are normative in [DATA_LAYOUT.md](DATA_LAYOUT.md).

`Stack` is executable in the reference backend. It lays out rendered visual children horizontally or vertically with closed `gap`, cross-axis `align`, main-axis `distribution`, `padding`, `safeArea`, frame, and transform inputs. Placement is deterministic and affects rendered pixels. With exactly one child and centered/default alignment and distribution, symmetric `width`, `height`, `padding`, and `safeArea` cannot move or resize that child, so explicitly authored instances are refused as inert; omit them, change the placement mode, or add the intended second child. The current implementation measures each child's rendered alpha bounds per frame, so animated visibility or content can intentionally change layout and may be expensive for dense scenes; constraint solving and intrinsic pre-render measurement remain outside this slice.

The public `Sequence` / `PictureTrack` / `PictureClip` / explicit `Gap` slice is
executable for the closed picture subset documented in
[EDITORIAL_SEQUENCE.md](EDITORIAL_SEQUENCE.md). `PictureClip` additionally has
a closed picture-only constant-rate/reverse/freeze and bounded forward
piecewise-linear speed-ramp contract documented in
[EDITORIAL_TIME_MAP.md](EDITORIAL_TIME_MAP.md). Its exact frame selector is
canonical `floor`, identity-bearing `nearest`, or identity-bearing
`frame-blend`. Frame blend converts exact rational phase to Q16
round-half-up, reads at most two adjacent in-authority frames, interpolates
associated-alpha encoded-sRGB deterministically, copies integer endpoints
literally, and clears RGB when fractional output alpha is zero. Reserved
`optical-flow` fails source-located instead of degrading. An optional, ordered
`PictureTrack(sourceDuration:, edits:)` algebra executes split, trim, ripple
insert/delete, overwrite, replace, lift, extract, exact source-window slip,
neighbor-compensated slide, explicit gap operands, and multiple disjoint
centered handle-consuming `transitionAt` declarations by lowering a closed typed plan and
materializing ordinary track items; its exact
semantics and limits are documented in
[EDITORIAL_OPERATIONS.md](EDITORIAL_OPERATIONS.md). The separate `AudioTrack` /
`AudioClip(destination:, range:, link:)` / `AudioGap` slice is executable for
the closed sample-accurate subset documented in
[EDITORIAL_AUDIO_TRACK.md](EDITORIAL_AUDIO_TRACK.md). A direct track item may
instead be `AudioRegion(destination:, link?, headHandle?, tailHandle?)` containing one unbranched closed
chain of up to 32 `Gain`, `Pan`, `ParametricEQ`, `HighPass`, `LowPass`,
`Compressor`, or `DeEsser` inserts and exactly one source-owning `AudioClip`
leaf. It executes locked native trim, resampling, leaf fades, placement,
innermost-to-outermost inserts on the absolute composition sample clock, then
an exact outer half-open gate. Region processor state is independent and
cannot leak a tail across the edit boundary. Region placement, leaf source,
processor order/values/automation, links, locked bytes, package/runtime, stems
and composition audio-cache identity are all executable. Unsupported topology,
incoming references to the private chain, contradictory track metadata,
sharing/foreign ownership and nested cycles fail source-located before direct,
cache or stem materialization. Exact restrictions and structured OTIO
processing loss are normative in [AUDIO_REGIONS.md](AUDIO_REGIONS.md).
Canonical `TimelineEdit` admits bounded origin-clock audio materialization.
Faded direct exact-1x `AudioClip` results may use declared handles for
authenticated slip, slide, boundary adjustment, and handled transition through
a `selected-source-union-v1` evaluation envelope. Processed `AudioRegion`
structural operations, complete-origin same-track or cross-track insert/overwrite,
one coupled direct-picture plus complete-origin audio placement, authenticated
slip/slide/boundary adjustment, and transitions reuse one
immutable processed/faded/constant-retimed evaluation. For an exact-1x
processed origin, or a constant-retimed origin with exactly one innermost
static `TimeStretch` directly above `AudioClip`, the otherwise static unary
Gain, Pan, ParametricEQ, HighPass, LowPass, Compressor, or DeEsser chain may
consume external handles. CUT decodes the complete declared source-handle
domain, runs `TimeStretch` once on that source-clock domain, runs outer static
processors once on the expanded destination-clock result, and only then slices
the timeline views under `full-declared-handle-domain-v1`. Automation, routing,
branching, tail-producing effects, nested or non-innermost time stretch,
variable retime and multiple processed or nested state-bearing operands remain
fail-closed. A
separate pure all-region `audioCrossfadeAt` v2 topology accepts only static
processor properties and zero leaf fades: consumed outer handles extend native
trim/resample and placement, the chain executes once inner-to-outer on the
composition clock, then an expanded gate precedes exact envelopes and mixing.
A middle region at touching cuts is processed once over the union with two
envelopes, so state is not restarted. Distinct manual picture links remain
passive; picture timing and cache identity are unchanged, and no atomic A/V
transition is implied. Optional paired
`AudioTrack(sourceDuration:, edits:)` arguments add a separate closed typed
audio plan for split, trim, ripple insert/delete, overwrite, replace, lift,
extract, source-window slip, neighbor-compensated slide and explicit silence
operands, plus a bounded `audioCrossfadeAt`. Plan v1 materializes ordinary
audio children after neutral structural edits; plan v2 preserves canonical
outer region/source/processor participants and stores transitions only. Both
replay/reconcile native source clocks, destination sample clocks, child inputs,
handles and transition metadata before cache lookup or audio work; see
[EDITORIAL_AUDIO_OPERATIONS.md](EDITORIAL_AUDIO_OPERATIONS.md). Both
track paths lower ordered, half-open source and destination intervals into
typed IR and reject implicit holes. Ordinary picture/audio link IDs are
scene-scoped identity metadata and do not implicitly couple per-track edits.

The direct-scene [`TimelineEdit`](TIMELINE_EDIT.md) statement is the canonical
atomic multi-track authority for the newer bounded nonlinear-edit slice. It
uses authored track/item identity, exact independent picture/audio clocks,
link-closure selection, deterministic lineage and one closed operation union
across split/trim/ripple/lift/extract/slip/slide/boundary/insert/overwrite/
transition. Compiler materialization and the reference runtime replay direct
picture, zero-fade 1x audio, bounded exact-1x faded-direct origin envelopes,
and the documented processed-origin subset transactionally. Processed/faded/
constant-retimed `AudioRegion` results preserve one origin evaluation across
structural edits and complete-origin same-track or cross-track insert/overwrite.
Cross-track audio views carry the exact source AudioTrack identity and reference
one source-owned origin evaluation; the processor graph never gains a second
structural parent and is never cloned per placement.
Authenticated in-origin slip, slide, boundary adjustment, and transition are
supported where their exact source-clock contract admits them; exact-1x static
processed origins and the documented single-innermost-`TimeStretch` topology
additionally admit the full-declared-handle-domain path. One unlinked,
property-static 1:1 `Precomp` supports the
structural subset without flattening; its typed source view binds
`structural-only` versus `static-same-track-copy`, and only the childless
effect-pure shape whose executable inputs are limited to `source`, `range`,
`x`, `y`, `scale`, `rotation`, and `opacity` supports same-track complete-item
insert/overwrite. Role, metadata and segment lineage remain explicit.
Audiovisual nesting and broader processed/nested/transcript forms
remain admitted only at the documented fail-closed boundaries; the statement
never degrades into an ordinary clip or the older independent track operation
lists. OTIO V4 optionally binds nested placement policy and lineage beside
unchanged V2/V3 authority, while generic/external-NLE nested execution remains
typed loss.

The explicit exception is direct scene statement
`LinkedTrim(link: String, keep: Range<Time>)`: it resolves exactly one linked
`PictureClip` and one linked track `AudioClip` in that scene, requires one
positive proper keep subrange on both the picture-frame and audio-sample grids,
and atomically stages correlated trim plans before committing materialized
children. Removed edges become link-free gaps; the retained items preserve the
link while their source windows advance independently. Existing operation
plans or transition windows are refused.

CutAVIR v3 records each operation as a versioned top-level `linked-trim` entry
with composition/scene/link/keep, both track IDs, and source provenance. The
picture and audio trim operations carry the same `transactionId`; the strict
loader rejects unknown, missing, duplicate, or one-sided correlation. Formatting
and comments do not change transaction identity, while `keep` changes produce a
field-level semantic diff. The compiler/typed-IR/strict-loader contract is
executable. Before picture or audio work, a central reference-runtime validator
re-correlates and replays both operation plans and their materialized children,
then exposes frozen authorizations through mutation-resistant read-only maps by
transaction, scene/link and owning track. Per-track validation accepts a
transaction-bearing trim only with that exact authorization. Locked session
validation plus direct visual and direct audio entry points all invoke the
central check. Generated locked FFV1 and PCM/WAV proof decodes the exact retained
picture/audio source ranges and link-free destination gaps; a one-sided
transaction fails before output publication. This makes the bounded non-ripple
`LinkedTrim` path executable end to end, but does not make the broader editorial
release rows `PASS`. OTIO export reports
`CUT_OTIO_LINKED_TRIM_UNSUPPORTED` with transaction provenance and
`lossy-editorial` status rather than claiming the materialized hard cuts
round-trip the atomic transaction.

The second public transaction is `LinkedRippleDelete(link: String, range?:
Range<Time>)`. Omitting `range` selects exactly one complete direct
picture/audio pair with identical scene-local destination intervals and keeps
the version-1 contract. Supplying `range` selects a positive strict interior
scene-local interval contained by both direct members; their outer intervals
may differ, preserving J/L timing. Compilation atomically builds two operations
on each track: an exact-duration tail
gap/silence insertion at original track end, followed by ripple deletion of the
selected interval. CutAVIR stores version 1 for complete deletion or version 2
for explicit interior deletion. Version 2 retains authored `linkId` on four
survivors and stores deterministic `before`/`after` `linkSegmentIds`; both
delete operations carry the same pair. Strict loading recomputes those IDs,
rejects orphan/mixed/reused segment metadata, and closes operation order,
translated ranges, tail insertion and exact survivor source/destination roles.
The pure picture/audio algebras execute even complete-track v1 deletion because
closure is inserted first. Version 2 refuses processed, faded, handled,
overlapped, retimed, pre-planned/transition or edge-touching operands rather
than flattening them. Mixed same-track transactions also fail with stable
`CUT_LINKED_RIPPLE_*` diagnostics.

Before picture or audio work, the generalized central reference-runtime
validator re-correlates and replays all four operations plus their materialized
children, then issues immutable authorization to each owning track. Direct
per-track validation refuses transaction-bearing edits without that exact
authorization. Locked execution proves shifted decoded frame and PCM
progression followed by an exact transparent/silent tail; cold/warm audio-cache
reuse preserves the same content hash and key, and a one-sided transaction
fails before visual or audio output publication. OTIO retains the materialized
tracks but reports the missing atomic round trip exactly as
`CUT_OTIO_LINKED_RIPPLE_DELETE_UNSUPPORTED` with transaction provenance and
lossy status.

This makes complete equal-range v1 and strict interior/J-L-aware v2 direct
`PictureClip`/`AudioClip` ripple executable end to end. It does not implement
multi-item/nested operands, coupled slip/slide/transition cases,
processed/faded/handled/retimed/overlap bases or lossless interchange, and
therefore does not make a broader 1.0 editorial row pass.

`PictureClip`/`editClip` and track `AudioClip` expose locked head/tail source
availability. Structural edits materialize first, then every picture
`transitionAt` and audio
`audioCrossfadeAt` resolves against final hard-cut topology and consumes exact
half-handles without changing track duration. Audio duration is an even
integer of at least two destination samples; its closed linear/equal-power
gain laws use `p=k/N` over the half-open overlap and decode the extended native
source intervals. Duplicate cuts and intersecting transition windows fail;
adjacent cuts may share a middle clip's distinct head and tail handles. The
separate public `Transition` slice executes one exact A/V overlap
around two linked `Clip` children as documented in
[EDITORIAL_TRANSITIONS.md](EDITORIAL_TRANSITIONS.md). Public `JCut` and `LCut`
use the same exact two-Clip overlap topology without a dissolve. `JCut` hard-
cuts audio at overlap start and picture at overlap end; `LCut` hard-cuts picture
at overlap start and audio at overlap end. Exactly one picture and one audio
child is selected at every instant. Compiler/runtime validation, locked source
clocks, decoded pixels/samples, semantic/cache identity and structured OTIO
loss are executable. Public childless
`NestedSequence(source: Timeline, range?: Range<Time>)` adds one bounded AV
nesting slice. The positive half-open range (or complete source when omitted)
is shared 1:1 by picture and sound. Equal-format source picture keeps its
original scene/frame phase. CUT instantiates the complete deterministic pre-
master source root-mix graph, evaluates causal state from sample zero through
the selected range end, and retains only the exact selected samples for parent
placement, preserving stateful processor history without a full-source raw stereo f32le
temporary. Every reachable source is capped at 7,200 seconds; exact preparation
deduplication is bounded by 2,000,000,000 causal-history samples and
4,294,967,192 aggregate selected raw stereo f32le bytes. The byte ceiling is
the complete 8-byte-frame floor beneath one ordinary non-RF64 WAVE payload. Source ownership is
not flattened; foreign timeline roots fail closed, picture/audio cache projections
invalidate independently, cycles/work are bounded, and unsupported OTIO
nesting is reported rather than silently duplicated. Source `Meter` targets do
not recursively master the nested pre-master projection. Retime/loop/hold,
independent A/V ranges, exposed nested buses/stems and editable
`NestedSequence` operands remain outside this slice. The separate static 1:1
picture-only `Precomp` same-track slice is documented above and does not
broaden this audiovisual contract. Intersecting/layered track transitions,
processed/faded/handled/retimed or overlapping audio-operation bases beyond
`TimelineEdit`'s closed origin-clock subsets, linked ripple beyond the direct
neutral strict-interior `LinkedRippleDelete` v2 subset,
multi-item/nested linked operands, coupled slip/slide and transition selection,
reverse- or freeze-bearing curves, custom transition curves/packages, eased/arbitrary source-time curves, and
variable or multi-item audio retime remain outside these subsets. The separate
bounded constant-ratio `TimeStretch` audio processor may alter exactly one
`AudioRegion` leaf-to-destination duration mapping under the static closed
contract above; it does not alter picture timing or authorize track operations.

The public `Marker` and `Region` declarations from `@cut/edit` are typed,
non-rendering editorial annotations. They own exact frame- or sample-grid
boundaries plus bounded identity/role/name/color/comment metadata. Timeline
scope uses the composition clock; scene and `at` scope preserve scene ownership
while lowering to absolute composition time. Authoring is legal only as a
direct timeline/scene node-statement root; a nested authoring call is
`CUT_ANNOTATION_CONTEXT`. `marker()` and `region()` resolve only earlier
declarations as typed compile-time values, always in absolute composition
coordinates. Inside a nonzero-start scene, an author must explicitly subtract
the scene start before using such a value as scene-local `at`; CUT applies no
hidden offset. Declarations participate in typed IR, semantic/build identity,
inspect/diff, render/cache execution and the closed native CUT OTIO `Marker.2`
boundary without emitting pixels or samples. Queries may intentionally drive
later media, in which case the dependent graph and localized cache identity
change. See [EDITORIAL_ANNOTATIONS.md](EDITORIAL_ANNOTATIONS.md).

A hard refusal is required. Substituting a placeholder would falsely change the meaning of the program.

## 11. Security model

A `.cut` program has no ambient shell, filesystem, network, browser, environment-secret, or process capability.

- Assets are explicit project-relative resources and must pass realpath confinement and content locking.
- The lock contains hashes and metadata, never credentials.
- Backend FFmpeg invocations use structured argument arrays, not shell strings assembled from model output.
- Data loading is size-bounded by the reference visual runtime; media/raster work remains subject to host process limits.
- Unresolved analysis, generation, and external effects cannot enter a reference release render.
- Unsupported kernels fail closed.

The alpha is not a complete hostile-code sandbox. FFmpeg, codecs, image decoders, and Sharp run as native host dependencies, and third-party plugin isolation is not implemented. Public multi-user deployment requires operating-system/process isolation, time/memory/storage quotas, authentication, and per-user project roots in addition to language validation.

## 12. Alpha limitations and roadmap boundary

CUT 0.4 alpha proves the language/compiler/runtime split, not universal NLE replacement.

Not yet complete:

- total type coverage for open component property bags;
- general timeline edit commands beyond the closed picture algebra,
  intersecting/layered track transitions, linked A/V ripple beyond the
  complete equal-range v1 and direct-neutral strict-interior/J/L-aware v2
  `LinkedRippleDelete` contracts, multi-item/nested linked operands,
  processed/faded/handled/retimed/overlap bases beyond `TimelineEdit`'s closed
  origin-clock subsets, coupled
  slip/slide and transition selection beyond the closed transactions and
  two-Clip J/L wrapper, lossless linked-operation interchange,
  audiovisual nested-sequence trim/retime and track-operation operands,
  and time-remap execution beyond the closed picture/audio track and linked-Clip
  subsets;
- rotoscoping, optical flow, and general automatic semantic reframing;
- explicit input/output color management, curves, scopes/legal-range
  diagnostics, OCIO/ACES or combined shaper/3D LUT pipelines, bounded custom
  shaders, and full 3D; the strict normalized encoded-sRGB 1D/3D `.cube`
  consumer is implemented;
- production font shaping, fallback and language-aware line breaking;
- word/karaoke caption animation, overlap lanes, vertical text, WebVTT regions and full bidirectional layout conformance;
- sample-accurate automation for every audio parameter, production-grade
  transient/formant-aware and variable/multi-item audio retiming, and a production
  plugin format;
- Git/npm registry distribution, signed provenance and capability-safe
  native/WASM/shader/audio extension installation and isolation beyond the
  implemented local/file CUT source-package boundary;
- decoded-buffer and bitstream reproducibility across pinned native toolchains;
- OTIO transitions, retimes/effects and external NLE validation, plus marker metadata beyond the closed CUT timeline/scene annotation contract, Premiere, Resolve, Final Cut, and other interchange backends beyond the documented strict OTIO editorial subset;
- broad quality and token-efficiency benchmarks against equivalent human/agent workflows.

These are missing compiler/runtime features, not work delegated invisibly to a model.

## 13. Legacy compatibility namespace

The current CLI quarantines the pre-formal semantic-planning, timeline-IR and
data-only `ProductionPlan` experiments under `cut legacy ...`. Their
subcommands include ingest/see/build/test/explain/render, research/produce and
the earlier direction/revision tools. Canonical top-level `build`, `test`,
`render` and `diff` operate on formal `.cut`/CutAVIR workflows and must not be
confused with that namespace.

Those legacy tools remain useful historical prototypes, but their prompt-like
line syntax and `.cutprod.json` artifacts are not part of this formal language
specification. New conforming work uses the canonical commands in section 9.3,
`.cut`, CutAVIR v3, `cut.package.lock` where packages exist, and `cut.lock` for
audiovisual resources.
