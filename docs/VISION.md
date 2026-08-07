# CUT: end-state contract

CUT is a programming language for audiovisual work. Its canonical artifact is source code, not a prompt, chat transcript, editor project, or model-authored shell script.

The intended relationship is:

```text
human or agent taste
        ↓
     CUT source
        ↓
parser → type checker → canonical audiovisual graph → locked build
        ↓
preview / CPU / GPU / interchange / delivery backends
```

A model decides what the edit should mean. CUT gives that decision precise, compact, inspectable semantics. A runtime performs the media operations. The model does not write FFmpeg commands, rasterize frames, or improvise hidden edits after compilation.

## The bar

CUT succeeds when all of the following are true:

1. A human can express any ordinary professional edit in code, with low-level escape hatches for novel effects.
2. An agent can express the same edit with substantially fewer tokens and tool calls than manipulating files or application UI directly.
3. A much weaker model can reliably author valid edits because common editorial ideas are typed, composable primitives.
4. Locked source, assets, packages, compiler and runtime semantics reproduce the same audiovisual graph. Generative work is explicit, cached, attributable and lockable.
5. CUT projects can target multiple renderers and interchange formats without changing their editorial meaning.
6. Project-specific facts live only in project code and assets. The compiler and runtime never recognize the showcase film.

## Language layers

### 1. Core language

The core supplies declarations, components, lexical scope, exact rational time, dimensional quantities, arrays and records, loops over compile-time data, compile-time conditions, assertions, named arguments, composition, properties and signals.

Time, frames, pixels, ratios, angles, gain, frequency, loudness and true peak are different types. `3s + 4px` is invalid. Frame quantities are resolved only in an owning timeline's frame rate.

### 2. Audiovisual graph

Every node has:

- a typed domain: visual, audio, linked audiovisual, data or output;
- an exact interval;
- named inputs and typed ports;
- ordered children;
- animatable properties represented as signals;
- effects and capabilities;
- source provenance and a transitive content hash.

Graph identity is independent of timestamps, temporary paths and execution order. The graph is the portable semantic contract between frontends and runtimes.

### 3. Standard packages

Domain vocabulary belongs in libraries, not syntax:

- `cut:visual`: media, text, vector geometry, layout, masks, compositing, cameras, lights, shaders and grading;
- `@cut/audio`: clips, buses, gain, EQ, dynamics, spatialization, reverberation, metering and sidechains;
- `@cut/edit`: clips, sequences, transitions, J/L cuts and time mapping;
- `@cut/motion`: curves, springs, constraints and reusable motion systems;
- `@cut/geo`: maps, globes, geographic marks, routes and propagation;
- `@cut/data`: charts, waveforms, spectrograms and data-bound graphics;
- `@cut/documentary`: sourced claims, narration, captions and evidence displays.

`Globe`, `Chart` and `Evidence` are normal package components. They are not privileged language keywords. A third party can build an equally expressive medical-imaging, sports, 3D or social-video package.

The current `Chart` slice is executable rather than a privileged template: it
renders bounded exact values as bar/line/area geometry with explicit palette,
domain and frame controls. It deliberately supplies neither a preset dark
canvas nor host-font labels; see [CHARTS.md](CHARTS.md).

### 4. Escape hatches

High-level primitives must not cap expressiveness. The end state includes bounded custom shaders, kernels, fonts, color transforms, audio processors, geometry, codecs and host integrations. Each escape hatch declares capabilities, input/output types, version, implementation integrity and determinism tier. Release builds refuse undeclared access or unresolved effects.

## Determinism

CUT distinguishes three promises:

- **semantic determinism**: the same locked program produces the same canonical graph;
- **decoded-media determinism**: the same locked decoder/runtime produces the same frame and sample buffers;
- **bitstream determinism**: the same locked encoder produces identical output bytes.

These are never collapsed into a vague "deterministic" claim. A lock records source, resource, package API and implementation identities. A renderer verifies locked bytes again before decoding. Content-addressed caches are verified before reuse.

Generated video, images, speech, music or analysis are effect jobs. Their prompts, models, parameters, outputs and licenses become ordinary locked resources before a release render.

## Security boundary

A CUT program grants no ambient filesystem, shell, browser, network or secret access.

- Resource locators are project-relative, realpath-confined, regular files.
- Backends receive structured arguments, never model-authored shell strings.
- Data and media have size, duration, resolution and decode budgets.
- Package effects are explicit; release builds reject unresolved effects.
- Untrusted shaders and processors run behind declared capability and resource limits.
- The lock contains hashes and metadata, never credentials.

## What the model does

The model may research, choose sources, write narration, direct pacing, compose scenes and write CUT. That is the creative planning layer.

The model does not need to remember codec flags, calculate sample delays, manage raster frame files, concatenate clips, normalize loudness in two passes, project geographic coordinates or maintain cache dependencies. Those are reusable language/runtime semantics.

Without CUT, an agent typically writes one-off glue code or drives an editor UI and must repeatedly inspect mutable state. With CUT, it emits a small declarative program, receives diagnostics, and revises stable source. The comparison is valid only when both paths are asked to produce the same edit and the CUT runtime—not hidden benchmark code—does the heavy lifting.

## Current alpha boundary

The repository contains the CUT 0.4 parser, dimensional type checker, canonical graph IR, resource lock, incremental execution plan and direct reference picture/audio renderer. It can execute a useful documentary subset from `.cut` source with locked media, vector/text composition, data-bound maps and globes, signals, source audio, audio buses and mastering.

It is not yet a replacement for every Adobe, Resolve or 3D operation. The reference renderer is a correctness backend, not the final high-performance architecture. It now has deterministic two-child alpha/luminance/RGB masks with bounded expansion/erosion, feathering and inversion; a bounded static polygon ClipPath with fixed-grid coverage; exact centered-shutter temporal supersampling for one retained visual subtree; and a tested linear-light sRGB blend subset. Bezier/animated paths, multi-subpath authoring and roto/tracking, optical-flow/rolling-shutter and cross-composition blur, general shaders, full 3D, broader temporal edit combinators, end-to-end color management, font shaping, plugin sandboxing and production interchange still need complete implementations. Unsupported kernels must fail explicitly; they must never degrade to placeholders.

This distinction is deliberate: CUT is already a serious language/runtime prototype, while the industry-defining claim remains an engineering roadmap that must be earned feature by feature.
