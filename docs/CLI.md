# CUT command-line reference

This is the command reference for `cut-lang` 0.4 alpha. Typed `.cut` source is
the canonical input. Commands under `cut legacy` are a quarantined compatibility
surface and are not part of typed execution.

The installed binary exposes its exact closed command grammar:

```sh
cut --version
cut help
cut help --json
```

`help --json` emits `cut-cli-reference` version 1 with product/language/IR/runtime
identities, positional counts, every accepted option and option kind, required
options, aliases, and a separate category for legacy commands. Use that report
instead of guessing flags from another release. Unknown, duplicate, missing,
misordered, or extra arguments fail before filesystem, media, model, or render
work begins.

The optional semantic-footage surface is also closed and machine-readable:

```sh
cut footage setup --backend local --json
cut footage doctor --json
cut footage index media/ --out .cut/footage/index.json --json
cut footage search .cut/footage/index.json --query "a dog outdoors" \
  --out .cut/footage/search.json --json
cut footage extract .cut/footage/search.json --match 1 --handles 1s \
  --out selects/dog.mp4 --json
```

## First project

```sh
cut doctor
cut init hello-cut --name "Hello CUT"
cd hello-cut
cut project .
cut proxy media/camera-master.mov --project . \
  --out media/proxies/camera-640.mp4 --width 640 --json
cut fmt main.cut --check
cut check main.cut
cut lint main.cut --deny-warnings
cut migrate main.cut --check
cut lock main.cut --out cut.lock
cut build main.cut --lock cut.lock --out .cut/graph.cutir.json
cut inspect main.cut --lock cut.lock
cut test main.cut --lock cut.lock
cut preview main.cut --lock cut.lock --out output/preview.mp4
cut preview main.cut --lock cut.lock --range 2s:5s --width 640 \
  --out review/range.mp4 --json
cut render main.cut --lock cut.lock --output release --out output/release.mp4
cut diff .cut/graph.cutir.json .cut/graph.cutir.json
```

`cut init` writes a complete asset-free project with authored `preview` and
`release` render outputs. `preview` is not an implicit low-quality render: it
selects a declared output from source and selects only explicitly authored,
lock-verified video/audio proxies. Missing proxies report a master fallback.
The reference runtime always requires a lock for preview and render.

## Semantic footage search

Semantic search is optional. The ordinary CUT install contains the small,
five-file `adapters/footage-local` recipe, but it does not contain
`@huggingface/transformers`, ONNX Runtime, model weights, or a model cache.
Install the backend only when this workflow is needed:

```sh
cut footage setup --backend local --json
cut footage doctor --json
```

`footage setup` is the only network-bearing footage command. It uses the npm
CLI that belongs to the supported Node installation to install the locked
`@huggingface/transformers` 4.2.0 closure, including `onnxruntime-node` 1.24.3,
then downloads and verifies CPU q8
`Xenova/clip-vit-base-patch32` revision
`d15189d7028b43f1d3e65039190477f6af591c2a`. Homebrew is not required.
Indexing and extraction still require working FFmpeg and ffprobe executables;
they may come from any supported installation. Run `cut doctor --json` as well
as `cut footage doctor --json` before the first real project.
The exact macOS arm64 installation measured during design was roughly 387 MB
for the runtime and 161 MB for the model; Linux and future package metadata can
vary. The default location is below `~/.cut/footage`; automation may select one
canonical absolute directory with `CUT_FOOTAGE_HOME`.

After setup, index and search are offline. They load only the verified absolute
model-revision directory and never contact the model hub:

```sh
cut footage index media/ --out .cut/footage/index.json --json
cut footage search .cut/footage/index.json \
  --query "founder opens the live dashboard" \
  --out .cut/footage/search.json --json
cut footage extract .cut/footage/search.json \
  --match 1 --handles 1s --out selects/dashboard.mp4 --json
```

All footage locators are relative to the current project directory. Indexing
recursively admits regular, non-linked MP4/MOV files, hashes and probes each
source, and writes the canonical index plus its bound vector artifact. A second
run reuses only byte-identical, probe-identical chunks. Search rechecks the
sources, vectors, and backend before inference, then writes a deterministic
`cut-footage-search` v1 report. Its matches are candidate evidence; search does
not edit a `.cut` program or call the compositor.

Extraction accepts a one-based rank or the report's stable match ID. Optional
`--handles` is one exact non-negative `s` or `ms` value applied to both sides;
when omitted, the report's handles or exact zero are used. The command
revalidates the report and source, then publishes both the requested clip and
`<clip>.cut-footage.json` without overwriting either existing leaf. Extraction
is picture-only and removes source audio; CUT does not imply an audio selection
from a visual semantic match. JSON success
is respectively `cut-footage-local-setup-report`,
`cut-footage-local-doctor-report`, `cut-footage-index`,
`cut-footage-search`, and `cut-footage-extract`. Public failures use stable
`CUT_FOOTAGE_*` diagnostics and never include the private footage-home path or
raw model output.

## Transcript-editing workflow

A project using public `transcriptEdit`, `TranscriptAudio`,
`TranscriptPicture`, and `TranscriptCaptions` follows the ordinary formal CLI
path:

```sh
cut check main.cut --json
cut lock main.cut --out cut.lock --json
cut build main.cut --lock cut.lock --out graph.cutir.json --json
cut inspect main.cut --lock cut.lock --json
cut frame main.cut --lock cut.lock \
  --frame 24 --out review/caption.png --json
cut audition main.cut --lock cut.lock \
  --samples 0:96000 --out review/dialogue.wav --json
cut preview main.cut --lock cut.lock \
  --output release --out output/preview.mp4 --json
cut render main.cut --lock cut.lock \
  --output release --out output/release.mp4 --json
```

`check` reads the bounded declared `cut-transcript` v1 DataAsset because stable
word selection is part of deterministic lowering. It does not probe or
authenticate the audio at that stage. `lock` re-reads and hashes the sidecar,
reproduces the exact inclusive word-ID selection, and proves its media SHA,
stream, sample rate and duration against the locked master AudioAsset. When
`TranscriptPicture` is present, `lock` also authenticates the explicitly
selected co-located video stream, frame rate, independent decoded-video
duration, and the sidecar's optional nonzero
`audioVideoPresentationDelta` as decoded-audio anchor minus selected-video
anchor; omission canonically asserts exact zero. `build` translates the
audio-local word range onto the decoded-video-local clock before frame
coverage, then emits the typed ledger plus ordinary executable consumers.
`inspect` reports the selected text, IDs, exact intervals, frame-cover range,
and media authority. `frame` and `audition` provide direct pixel/sample
evidence.

Preview selects an authored audio or picture proxy only when its locked
decoded alignment authenticates it against the sidecar-bound master.
Unrelated same-cadence picture fails during `cut lock` as
`CUT_PROXY_VIDEO_ALIGNMENT`; an authenticated picture proxy is selected by
preview, while render always selects the master. Public `TranscriptPicture`
lowers the unique smallest source-frame
interval covering the selected words to an ordinary `PictureClip`; it does not
invoke a private picture renderer. There is no ASR, model call or
natural-language interpretation in this path. See
[Edit-safe transcript selection](TRANSCRIPT_EDITING.md) for source, sidecar,
typography and current-limit details.

## Agent authoring and repair

```sh
cut agent author brief.txt --out main.cut --trace author-trace --json
cut agent repair broken.cut --brief repair.txt --out repaired.cut \
  --trace repair-trace --json
```

`cut agent author` is the canonical, explicit model-assisted path from a bounded
UTF-8 brief to ordinary `.cut` source. `cut agent repair` supplies an existing
source and its exact source-located compiler feedback to the same bounded loop.
Both default to `--provider chatgpt` and the installed Codex/ChatGPT login;
`--provider api` is optional and requires `OPENAI_API_KEY`. `--model` records an
explicit model identity and `--attempts` is limited to 1–3. Run `cut legacy auth
login` if the ChatGPT provider reports that Codex is not authenticated.

The authoring prompt contains only the packed `AGENT_GUIDE.md`, this CLI
reference, the machine `cut help --json` reference, the supplied brief/current
source, and compiler diagnostics from earlier attempts. The Codex subprocess is
ephemeral and read-only, ignores local rules/config, sets approval to `never`,
and explicitly disables shell/unified exec, apps/MCP, browser/computer, image,
web-search, skill-install, tool-suggestion, and multi-agent feature surfaces.
The prompt enters on stdin and a JSON event-stream audit rejects any tool event
as defense in depth. Prompt, response, event, stderr, and time budgets are
closed. Only a candidate that formats, parses,
type-checks, and lowers can be atomically published, and an existing output is
never overwritten.

ChatGPT authentication currently comes from Codex's normal auth location under
the invoking user's real `HOME` because CUT does not read or copy those
credentials and no separate `CODEX_HOME` is configured automatically. The
subprocess environment is allowlisted, but this is not a filesystem-isolation
claim: use a dedicated OS account/container for a hostile brief or source.

`--json` emits `cut-agent-author-report` version 1 with provider/model/transport, public
context hashes, brief/input/output hashes, every attempt status, exact compiler
diagnostics, and audited event-stream identity. `--report` writes the same
bounded report. `--trace` is explicit opt-in because it preserves the complete
brief/current source, public context, prompts, candidate source, diagnostics,
and Codex JSONL events with mode `0600`; it never records environment variables,
auth tokens, or API request headers. Authoring is nondeterministic. The accepted
`.cut` file enters the ordinary `fmt`/`check`/`lock`/`test`/`preview`/`render`
path, whose locked execution remains deterministic.

## Project and environment commands

| Command | Contract |
| --- | --- |
| `cut doctor [--json]` | Checks the media-input platform, Node, FFmpeg/ffprobe, encoder inventory, a real writable/cleanable private temp workspace, one bounded synthetic H.264/AAC mastering path through required audio filters, and Sharp/libvips. Windows reports stable failure `CUTD1003` because descriptor-bound media probing is not implemented. JSON format: `cut-doctor-report`. |
| `cut init <directory> [--name <name>]` | Atomically creates a deterministic project; refuses existing/symlink/unsafe targets. |
| `cut project <directory>` | Validates `cut.project.json`, its entry and default canvas/audio clock. |
| `cut probe <project-relative-media> [--project <directory>] [--out <file>]` | Emits a bounded media probe with content identity, streams, clocks, duration, dimensions/channels and native tool identity. |
| `cut asset search <catalog.json> --query <text> [--kind <kind>] [--limit 20] [--json]` | No-follow reads one closed provenance-bearing local catalog and deterministically returns candidate metadata. It performs no download and grants no runtime trust; selected bytes must be copied project-locally, hash-verified, probed where applicable, declared, and locked. See `ASSET_CATALOG.md`. |
| `cut proxy <project-relative-video> --project <directory> --out <project-relative-proxy.mp4> --width <even-px> [--stream <index>] [--json]` | Generates one bounded picture-only H.264 proxy, proves exact cadence/duration plus decoded-RGB correspondence, refuses overwrite, and reports the explicit `proxy:` argument to author. It never edits source or replaces `cut lock`. |
| `cut relink <program.cut> --asset <name> --to <project-relative-path> [--write] [--json]` | Probes a compatible replacement. Default is a byte-preserving dry run; `--write` atomically replaces one direct asset locator and makes the old lock stale. |

`doctor` does not read or write a CUT project and performs no network request.
It creates one private directory under the operating-system temp root, verifies
an exact write/read, encodes a 0.25-second synthetic 16×16 H.264/yuv420p and
AAC/48 kHz stereo MP4 through `aformat`, `volume`, `aresample`, and `loudnorm`,
verifies the CUT-owned limiter core separately on an exact stereo-f32 boundary,
and verifies the exact dimensions, two-frame picture, clocks and bounded
audio/video duration with ffprobe, enforces time/output/file-size budgets, waits
for terminated native processes, and removes the directory in a `finally` path.
The path and raw native
error text never enter JSON or human diagnostics. `CUTD1003` is the explicit
Windows media lock/probe/render exclusion; `CUTD1011` means temp creation,
write, verification, or cleanup failed; `CUTD1131` identifies a missing or
malformed reference-media capability with an actionable fixed remedy. This is
a small prerequisite/installability probe, not proof that a CUT project can
render and not a claim that every codec, filter, runtime stage, input or
platform/version combination is supported. The lock/build/preview/render loop
is the render proof.

## Source, diagnostics and graph commands

| Command | Contract |
| --- | --- |
| `cut fmt <program.cut> [--check \| --stdout] [--json]` | Canonical formatter. `--check` never writes and exits 2 when formatting is needed. `--stdout` never writes. |
| `cut fmt <path> --stdin --stdout` | Formats bounded UTF-8 stdin while retaining `<path>` as the document identity. It cannot be combined with `--check` or `--json`. |
| `cut check <program.cut> [--json] [--stdin]` | Securely loads project-relative user modules, parses, type-checks and validates deterministic lowering. Syntax recovery reports up to 255 source-ordered grammar failures plus one closed `CUT_DIAGNOSTIC_LIMIT` sentinel; any syntax failure suppresses the executable AST rather than compiling a partial program. A reachable `transcriptEdit` also no-follow reads its bounded declared transcript DataAsset because the stable-word selection is compile-time semantics; it does not probe the bound audio. Stdin is bounded UTF-8; the positional path remains the module/package context. JSON format: `cut-diagnostics`. |
| `cut lint <program.cut> [--deny-warnings] [--json]` | Runs check plus entry/user-module export-reachability policy. JSON format: `cut-lint-report`. Warnings exit 2 only with `--deny-warnings`. |
| `cut migrate <artifact> [--check] [--out <new-file>] [--json]` | Detects current source/IR/lock/project formats, reports exact hash and compatibility evidence, performs only the verified archived CutAVIR identity canonicalization, and refuses unsafe migrations. Default and `--check` are read-only; `--out` is explicit, distinct, atomic and no-clobber. JSON format: `cut-migration-report`. See [MIGRATION.md](MIGRATION.md). |
| `cut lock <program.cut> [--out <cut.lock>] [--json]` | Probes and hashes entry/user-module source, resources, packages and native identities into a closed lock. Consumed audio gets a full decoded-frame plus independent PCM sample-bound witness; picture frame-index consumers get decoded cadence. Transcript bindings additionally reproduce their selected words from exact locked sidecar bytes and authenticate the sidecar media authority against the independently probed master audio. Before writing, CUT validates executable source bounds/grids, proxy equivalence and explicit input-color assertions against selected streams. JSON format: `cut-lock-report`. |
| `cut build <program.cut> [--lock <cut.lock>] [--out <graph.cutir.json>] [--json]` | Writes canonical CutAVIR v3, including a typed transcript-binding ledger when authored. A supplied lock is reapplied before output. JSON format: `cut-build-report`. |
| `cut inspect <program.cut> [--lock <cut.lock>] [--json]` | Reports exact clocks, roots, adjacency, provenance, resources, signals, package identities, exact user-source-module identities, jobs, outputs, assertions (including the ordered native predicate identities), transcript bindings and graph budgets. AudioTrack graph nodes additionally project their canonical ordered editorial items, including exact destination/source intervals, processed-region `sourceNodeId` and optional link identity. JSON format: `cut-inspect-report`. |
| `cut test <program.cut> [--lock <cut.lock>] [--json]` | Recomputes constant and supported domain assertions from final typed IR after optional lock application. Locked video/audio range predicates remain deliberately deferred without `--lock`; caption interval coverage and exact authored delivery-output contract predicates execute from the completed graph. This does not inspect encoded delivery bytes. JSON format: `cut-av-test-report`; failed or deferred assertions exit 2, while malformed assertion IR or stored-status tampering is a diagnostic failure. |
| `cut diff <before.cutir.json> <after.cutir.json> [--json]` | Strict-loads both CutAVIR v3 artifacts and compares semantic execution fields. JSON format: `cut-av-semantic-diff`; semantic changes exit 2. |
| `cut review <professional-output-review.json> [--json]` | Strict-loads and evaluates the closed professional hero-film evidence record, verifies every declared local artifact hash, and refuses category averaging. JSON format: `cut-professional-output-review-report`; a structurally valid review that requires revision exits 2. |
| `cut review-study <reference-study-review.json> [--json]` | Strict-loads and evaluates one short reference-study evidence record. It hash-binds source, lock, IR, render and review evidence; requires a named human's complete full-speed playback; requires a complete headphone listen for audio studies; and evaluates every preregistered pattern conjunctively. JSON format: `cut-reference-study-review-report`; a structurally valid review that requires revision exits 2. |
| `cut frame <program.cut> --lock <cut.lock> (--frame <index> \| --at <exact-time>) --out <frame.png> [--output <name>] [--profile master\|proxy] [--json]` | Evaluates one exact compositor frame from locked CUT, without decoding a completed video. Non-frame-grid `--at` values are refused rather than rounded. Writes `cut-reference-frame` v2 PNG evidence plus a sibling manifest; JSON format: `cut-frame-report`. The closed schema is `schemas/cut-reference-frame-v2.schema.json`; same-invocation GeoAnnotation decisions are ordered at `execution.geoAnnotations`, retained MapCamera evidence at `execution.mapCameras`, exact DiagramLayout planner/pixel/cache evidence at `execution.diagramLayouts`, and top-level LocalSpace work at `execution.localSpaces`. Current DiagramLayout frame evidence is v2 and declares a `persistent-cross-render` subscene-RGBA cache; historical DiagramLayout v1 evidence remains schema-valid without that claim. The cache is not the scene cache and its receipt explicitly says cross-process coordination is not claimed. |
| `cut contact <program.cut> --lock <cut.lock> --frames <i,j,...> --out <sheet.png> [--columns 1..8] [--thumbnail-width 64..1024] [--output <name>] [--profile master\|proxy] [--json]` | Evaluates 1–24 unique strictly increasing exact frames sequentially, then creates a bounded labeled review sheet. Writes `cut-reference-contact-sheet` v1 evidence plus a sibling manifest; JSON format: `cut-contact-report`. |
| `cut audition <program.cut> --lock <cut.lock> --samples <start:end> --out <excerpt.wav> [--stem <name>] [--output <name>] [--profile master\|proxy] [--json]` | Executes a non-empty half-open sample range through the authored master graph or one public named bus/stem and emits exact stereo PCM24, without trimming a completed delivery. Writes `cut-reference-audio-audition` v1 evidence plus a sibling manifest; JSON format: `cut-audition-report`. |

`check` and `lint` do not prove that locked bytes are current or that the native
backend can render every reachable kernel. Use the complete lock/build/inspect/
test/frame/contact/audition/preview/render loop for a release candidate.

`cut-inspect-report` version 1 represents each `cut.edit.audio_track` node in
`graph.nodes` with an `editorial` object whose `items` contain `nodeId`, optional
`sourceNodeId`, `order`, `kind`, exact `destination`, optional exact `source`,
and optional `linkId`. A processed `AudioRegion` item uses `nodeId` for the
region and `sourceNodeId` for its exact nested `AudioClip`; a direct
`AudioClip` deliberately omits `sourceNodeId`. Other graph nodes omit
`editorial`. The report version remains 1 because this is an additive optional
field in the current alpha interface: no existing field was removed, renamed,
or retyped. The final 1.0 compatibility freeze remains outstanding.

## Professional-output review

```sh
cut review review/professional-output-review.json --json
```

The input format is `cut-professional-output-review` version 1; its closed
machine schema ships at
`schemas/cut-professional-output-review-v1.schema.json`. This command is a
deterministic evidence validator, not an automated director or taste score. It
does not watch or listen on a human's behalf. A person still has to perform the
declared full-speed playback, complete headphone listen and side-by-side
reference comparison and record concrete timed observations. CUT accepts those
statements as unverified attestations: it does not authenticate reviewer
identity, ownership/licensing, the creator or video behind a public URL, or the
truth of a visual-defect annotation.

A pass requires the implementer and independent reviewer to assess all nine
categories separately—narrative, editorial, cinematography/composition, motion,
typography, visual explanation, sound, originality/cohesion and technical
delivery. Every one of the resulting 18 assessments must be marked pass, score
at least 8/10 and contain at least two timed observations. There is deliberately
no aggregate score and no averaging between reviewers or categories. Any hard
failure makes the result `revise`.

The same record must prove all of these without exception:

- a 3–5 minute `hero-film` whose `.cut` source, lock, CutAVIR, output and render
  manifest are retained and SHA-256 bound;
- a professional delivery canvas with at least a 1080-pixel short axis, no more
  than a 7680-pixel long axis, and an exact authored frame rate from
  `24000/1001` through 120 fps; a low-resolution or 1 fps conformance fixture
  can exercise the verifier only as `decision: "revise"`;
- public CUT source, packages and CLI only, with all project-specific creative
  and temporal intent represented there and no externally precomposed graphic,
  animation, transition or edit standing in for missing CUT semantics;
- no hidden compositor, title-specific branch, manual frame replacement or
  creative post-fix;
- one implementer review and a distinct, uninvolved, conflict-free independent
  review, each covering the full film at speed with headphones;
- one primary visual-journalism reference and at least two adjacent references
  from three distinct creators, with treatment, board, shot analyses and
  side-by-side notes retained solely for calibration—not copying;
- passing check, test, render-manifest, deterministic replay, frame-scan,
  audio-delivery, rights/provenance and canonical-source-boundary evidence;
- at least one distinct, hero-scale failed iteration of the same CUT project,
  with matching duration/canvas/rate, source, lock, IR, complete render and
  manifest preserved; its named implementer/independent reviewer must retain a
  complete full-speed/headphone rejection with timed evidence for every failed
  category.

Every referenced path is POSIX-relative to the review file. `cut review`
refuses missing, linked, escaped or non-regular evidence and rejects
case/NFC path aliases, same-target paths, hard links, and copied identical bytes
reused for unrelated evidence roles. The sole digest-alias exception is the
contract-required byte-identical hero/replay MP4 pair; even those must be
distinct files and inodes. The command hashes actual bytes before and after
semantic use and binds the declared hero output to its lock-bound
`cut-reference-render` v11 manifest's exact `cut.lock` digest, combined
FFmpeg/ffprobe picture-toolchain identity, filename,
duration and output digest. A malformed, dishonest or stale
record exits 1 with `CUT_REVIEW_*`; a valid `decision: "revise"` record exits 2;
only a complete passing record exits 0. Passing validates that this evidence
contract is internally consistent. It never establishes artistic quality
without the human reviews the record names.

The eight technical entries are distinct hashed JSON envelopes with fixed
format/command identities: `cut-professional-source-check`,
`cut-professional-source-test`, `cut-professional-render-binding`,
`cut-professional-deterministic-replay`, `cut-professional-frame-scan`,
`cut-professional-audio-delivery`, `cut-professional-rights-provenance` and
`cut-professional-canonical-source-boundary`, all version 1. Each envelope
binds the same source, lock, IR, render-manifest and output hashes, and each
must use its own artifact path; aliased evidence files are rejected. The source
envelopes retain the actual public CLI JSON reports; `sourceTest` must contain
the exact non-empty ordered compiled CUT assertion set and reconciled summary.
Replay retains a distinct probeable MP4 and manifest with identical output
bytes.

Review also recompiles the source and applies the strict-loaded lock, probes the
actual MP4 for exactly one H.264/yuv420p authored-rate video and one zero-start,
complete 48 kHz stereo AAC stream, and follows v5 stems to their PCM24 files.
It then creates a private blank project, securely copies only the exact locked
master/proxy resources through no-follow descriptors, starts with cold picture
and audio caches, renders the invocation-local lock-applied IR through the
current locked backend, and requires exact hero MP4 bytes plus equivalent
render/stem semantics. The authenticated private MP4 is decoded over the exact
authored sample interval; CUT independently checks sample count, silence,
sample peak, true peak and loudness. Every required role stem is independently
parsed and scanned as exact stereo PCM24 rather than trusting manifest numbers.
Professional hero audio rejects reachable procedural
`Tone`/`Noise`/`Synth`; narration, score, ambience and SFX rights rows must bind
locked audio resources actually consumed beneath matching dialogue, music,
ambience and SFX buses. A missing or incorrectly assigned required bus fails,
as does any missing or silent required program stem.

For dead-video evidence, CUT decodes the complete stream with SHA-256
`framehash` and reconciles the exact frame count, ordered digest sequence,
distinct-frame count, consecutive changes and longest identical run. This is a
technical static/slideshow detector only. Human reviewers remain solely
responsible for clipped-text, legibility, alpha/glitch classification, pacing,
motion quality, narrative and every other creative judgment. The report labels
reviewer, rights, reference identity and frame-defect statements
`accepted-unverified`; fresh machine execution is `verified`. Conformance
fixtures cannot satisfy the hero-film gate.

Reference URLs must use HTTPS and a public-looking DNS hostname; placeholder,
reserved, local, single-label and IP-literal hosts are refused. CUT does not
fetch a URL or authenticate that its declared creator/title identify the public
film. That identity remains part of the accepted-unverified human calibration
record.

Ordinary source media remains valid input: raw or cleared footage, archive and
evidence imagery, photographs, fonts, narration, licensed score, SFX and
ambience do not become CUT-authored merely by being assets. The required
`allProjectSpecificCreativeAndTemporalIntentInCut` field instead closes a more
dangerous loophole: it must be false when an external tool pre-renders a
project-specific map, data graphic, animation, composite, transition, camera
move or edit timing that CUT should express. Such an artifact is useful
engineering input, but it cannot prove the hero-film authoring claim.

Version 1 is intentionally the 3–5 minute hero-film release gate. It must not
be presented as a review profile for short reference studies.

### Reference-study review

```sh
cut review-study review/reference-study-review.json --json
```

Short studies use the separate closed `cut-reference-study-review` version 1
record and `schemas/cut-reference-study-review-v1.schema.json`. A pass binds a
1–120 second public-CUT source, lock, CutAVIR, output and render manifest;
requires at least two preregistered pattern requirements with at least two
timecoded observations each; and requires a named human to watch the complete
study at full speed. If the output contains audio, that human must listen to
the complete study on named headphones and the audio-delivery evidence must
pass. An intentionally silent study must declare both playback audio review
and audio-delivery evidence `not-applicable`; silence cannot masquerade as
finished sound design.

Every other technical, provenance and public-authoring gate remains
conjunctive. A review with any slideshow, spatial-continuity, motion,
typography, sound, technical, pattern, rights, hidden-post, incomplete-review
or copying hard failure cannot pass. Prior failed iterations are hash-bound
and must remain retained when declared. This command verifies the record and
bytes; it does not watch, hear or exercise taste for the named human.

## Exact authoring review artifacts

Source-resolution `MediaCamera2D` moves use this ordinary public workflow,
whether the camera is a direct scene root or the sole visual in a
`ResponsiveSlot`: run `cut check` and `cut lock`, extract exact
start/middle/end frames for every output composition, inspect contact sheets,
then watch each bounded `cut preview --range ... --width ...` at full speed
before final renders. The camera adds no hidden command or edit plan; a
responsive camera's exact slot context is compiler-owned and appears in
inspect/frame evidence. See the checked source and exact execution contracts
in [`MEDIA_CAMERA2D.md`](MEDIA_CAMERA2D.md) and
[`RESPONSIVE_LAYOUT.md`](RESPONSIVE_LAYOUT.md).

```sh
cut frame program.cut --lock cut.lock --frame 137 \
  --out review/frame-137.png --profile master --json

cut frame program.cut --lock cut.lock --at 1001/24000s \
  --out review/frame-time.png --profile proxy --json

cut contact program.cut --lock cut.lock --frames 0,48,96,144 \
  --columns 2 --thumbnail-width 480 --out review/contact.png --json

cut audition program.cut --lock cut.lock --samples 240000:336000 \
  --stem dialogue --out review/dialogue-5s-7s.wav --json
```

These commands are deterministic authoring aids, not substitutes for complete
playback or headphone listening. Each command recompiles public CUT, reapplies
the supplied lock, verifies all locked master and proxy bytes, selects the
requested media profile, and records both the canonical build ID and the
profile-specific execution build ID. Outputs and sibling manifests must stay
inside the source project; linked output ancestors are refused by the common
project write boundary. PNG manifests bind the exact composition frame,
rational timestamp, scene/local-frame identity, compositor RGBA hash, backend,
profile selection and lock hash. Contact frames are evaluated sequentially in
isolated renderer instances because compositor frame state is non-reentrant and
one review point must not inherit a forward-only decoder from another; CUT also
rejects duplicate or decreasing lists rather than silently sorting them. The
visible `F<number>` labels use CUT's fixed 3x5 raster, not a host font.

For a frame containing `DiagramLayout`, the current inner frame-evidence writer
publishes version 2 persistent raster receipts for bounded node tiles and tight
edge tiles. Each receipt closes topology/geometry/paint/temporal split hashes,
runtime/backend hashes, artifact dimensions/bytes/SHA-256, lookup reason and
counters. `executionIdentity` represents the exact rendered semantics and stays
stable across a verified cold/warm replay; `observationIdentity` additionally
binds whether the raster was built, hit, coalesced, repaired or accompanied by
eviction. Settled Trace and unchanged evaluated-property plateaus may therefore
reuse pixels without erasing cache-history evidence. The cache validates its
closed manifest and exact RGBA artifact before every hit. It provides
same-process coalescing but no cross-process lock or lease; the receipt records
`multiProcessCoordination: "not-claimed"`. These manifests help diagnose
execution and locality. They do not replace complete playback, headphone
listening or creative review.

`--at` accepts bounded exact decimal/rational seconds or milliseconds such as
`1.25s`, `1250ms`, or `1001/24000s`. It must land exactly on the selected
timeline's rational frame grid and must identify a frame inside the half-open
timeline. `--samples START:END` names sample indices directly, so there is no
time-to-sample rounding. The maximum audition is 120 seconds and 128 MiB. With
no `--stem`, audition executes every authored master root but deliberately
stops at the `authored-master-pre-delivery` boundary: output-level loudness
normalization and AAC delivery are proved only by `cut render`. A named stem is
the same public pre-master bus route used by stem delivery, including its
authored processing/control graph.

The contact-sheet thumbnail resize is a documented Lanczos3 review transform;
it does not alter, replace or claim to be the authored output. A preview with
`--range` and/or `--width` is different: CUT evaluates only the selected exact
half-open composition frames and corresponding audio samples, using the same
canonical source, verified proxy session and runtime. `--width` never upscales
and is accepted only when it preserves aspect ratio at an exact positive even
H.264 dimension. The resize contract is `lanczos3-v1`. CUT still lacks a
waveform renderer and built-in playback UI; those gaps remain open for 1.0.

Stateful audio processors retain causal correctness: a late range may evaluate
history from composition time zero through its start, but only the selected
sample interval is serialized and delivery does not render a complete output
and post-trim it. The manifest names this boundary
`audioState: causal-history-from-zero`.

When the exact current full-program pre-master audio artifact already exists,
bounded preview may instead obtain the same interval by a freshly verified
cache slice. The probe is read-only: a miss or invalid entry falls back to the
selected causal execution above and never renders a full programme merely to
populate the cache. A hit verifies the complete no-follow cache artifact,
copies only the exact half-open sample bytes, and retains the same downstream
normalization, AAC verification, and mux path. The version-3 range manifest
distinguishes `full-program-cache-slice` from `selected-execution` and
hash-binds both the full cache authority and selected bytes.
Cache-hit root/filter counts are labeled `authorizedCachedBuild`, not execution;
the selected-execution alternative reports its actual root/filter work
separately.

Bounded preview picture work has a separate content-addressed range cache. Its
key binds the selected transitive picture-scene keys, exact half-open frame
range, source and review canvases, rational frame rate, color/resize/scene
encoding laws, CUT runtime, complete reference backend, and the exact
FFmpeg-executable toolchain identity. A hit reopens a project-contained regular
file, verifies its byte count and SHA-256, and derives its H.264 frame count,
timing, dimensions and color contract with ffprobe before reuse. Invalid
manifests or artifacts rebuild; publication is artifact-first and uses
no-clobber links, so a concurrent different result for one key fails as
nondeterminism rather than overwriting a winner.

The picture cache stores picture-only H.264—not a final MP4 and not audio.
Normalization, AAC encode and final mux still execute for every bounded
preview; exact selected pre-master audio either executes directly or comes from
the separately verified full-program cache-slice boundary above. Consequently
an audio-only edit can reuse a verified picture artifact while a picture,
range, review-canvas, backend, package, codec or toolchain change gets a
distinct picture key. The range manifest reports
`hit`, `miss`, or `rebuilt` plus the key, immutable locator, artifact hash and
verification contract. This is engineering evidence; the representative
cold/warm performance gates remain governed by
[PREVIEW_PERFORMANCE.md](PREVIEW_PERFORMANCE.md).

## Preview, render and stems

```sh
cut preview program.cut --lock cut.lock \
  [--output preview] [--range 2s:5s] [--width 640] \
  [--out output/preview.mp4] [--json]

cut render program.cut --lock cut.lock --out output/release.mp4 \
  [--output release] [--stems output/stems] [--json]
```

`preview` requires `--lock`; `render` requires both `--lock` and `--out`.
`--output` selects a source-declared render target. `--stems` writes deterministic
pre-master named bus artifacts and a lock-bound v5 stem manifest. The adjacent
v11 render manifest binds the exact combined FFmpeg/ffprobe picture-toolchain
identity and canonical stem-manifest SHA-256 and count.
JSON formats are
`cut-preview-report` and `cut-render-report`. The adjacent media manifest records
the canonical locked build ID, profile-specific execution build ID, exact
master/proxy/fallback selection and hash for every media resource, selected
output, graph/runtime identity, delivery probe, audio measurements, stems and
cache evidence. `preview` requests proxies; `render` always requests masters.
For bounded previews the manifest additionally closes the exact first/end frame
and sample indices, selected-only execution, source/output dimensions,
`lanczos3-v1` resize identity, lock digest and artifact hash. Boundaries must
land on both authored grids and the selected duration is capped at 300 seconds
and 18,000 frames. The MP4 and final manifest publish as one rollback group
only after verified inputs are cleaned up. See [PROXIES.md](PROXIES.md).

## OpenTimelineIO

```sh
cut otio export program.cut --lock cut.lock --out timeline.otio \
  [--report timeline.report.json] [--composition <id>] [--allow-lossy]

cut otio import timeline.otio --out imported.cut \
  [--report import.report.json] \
  [--fps 24 --width 1920 --height 1080 --sample-rate 48000] \
  [--project-name <name>] [--timeline-name <name>]
```

Export always writes a structured semantic-loss report. Without
`--allow-lossy`, representable output may still be written but a lossy result
exits 2. Import accepts only the documented bounded subset and writes canonical
typed CUT source plus a report; it does not hide an OTIO graph inside private IR.
Generic OTIO lacking CUT clock/canvas metadata requires the explicit clock and
dimensions shown above.

## User source modules

`import { name } from "./lib/module.cut";` is rooted at the entry source's
directory and is processed by every formal source command. It is distinct from
a versioned package: no manifest or package lock is needed, but exact module
bytes are recorded in CutAVIR and `cut.lock`. Run `cut fmt` on each authored
module file. Paths, cycles, visibility, function purity and expansion fail with
stable module diagnostics. See [USER_MODULES.md](USER_MODULES.md).

## Local/file packages

```sh
cut package init <directory> --name <package> \
  [--version 0.1.0] [--entry index.cut] [--json]
cut package add <file-source> [--project <directory>] [--exact] [--json]
cut package remove <name> [--project <directory>] [--json]
cut package list [--project <directory>] [--json]
cut package update [--project <directory>] [--name <direct-dependency>] \
  [--exact] [--json]
cut package lock [--project <directory>] [--json]
cut package verify [--project <directory>] [--json]
```

There is no implicit registry. `add` accepts a local/file source, validates its
manifest and public CUT module, resolves the bounded transitive graph and writes
an integrity lock. `update` is the explicit trust-changing operation for changed
package bytes. `verify` never refreshes trust. Package commands emit
`cut-package-command-report` or `cut-package-list` JSON.

## JSON and exit status

Machine-capable commands write one bounded JSON document to stdout when
`--json` is accepted. Human progress and media-tool output never contaminate
that document. Usage, language, lock, package and runtime failures use
`cut-cli-diagnostics` with stable codes; source-aware diagnostics include path,
line and column without leaking an absolute workspace path.

| Exit | Meaning |
| --- | --- |
| `0` | Command contract passed. |
| `1` | Usage, parse/type/lowering, package/lock, resource, backend or security failure. |
| `2` | A valid comparison/policy command found actionable state: formatting needed, denied lint warnings, failed/deferred authored assertion, professional review requiring revision, semantic diff, available migration, or unaccepted lossy OTIO export. |

Do not treat exit 2 as a successful release merely because a JSON document was
produced.

## Security and path behavior

- Options are parsed by a closed schema; extra flags fail before work.
- Subprocesses receive argument arrays, not an authored shell command.
- Formal media locators are project-relative and locks reject traversal,
  symlink escape, non-regular files and changed bytes.
- `proxy` binds and reports the exact FFmpeg and ffprobe executables used,
  writes into a private project-local staging tree under a fixed 2 GiB ceiling,
  verifies timing and bounded decoded-picture correspondence, and publishes
  with a no-clobber hard link. Its parent-path checks do not claim protection
  from a hostile peer concurrently renaming workspace directories.
- `fmt`, OTIO import, relink and migration use bounded reads and atomic writes.
- Migration never edits its input, refuses symlink aliases, resolves real paths
  and ancestor inodes before protecting the frozen 0.3 boundary, and
  revalidates the inspected output-parent inode immediately before stage and
  commit. It is not a sandbox against hostile directory renames between OS
  syscalls; use a trusted workspace.
- Formal execution has no ambient model call. ChatGPT or `OPENAI_API_KEY` is
  used only by an explicitly selected `cut agent` or `cut legacy` command; the
  accepted `.cut` source and all lock/build/test/preview/render commands make no
  model request.
- Native media decoding is still a local trusted-media alpha boundary; see
  [SECURITY.md](../SECURITY.md).

## Compatibility aliases and legacy

`av-build`, `av-inspect`, `av-test`, `av-diff` and `av-render` temporarily map to
their canonical formal commands. `--help`, `--version` and `-v` are ordinary
aliases. New automation should use canonical names.

`cut legacy <command> ...` contains the older model-assisted planning and
production-plan workflow. It can call Codex/OpenAI or media tooling and has a
different artifact model. It must not be used as evidence that typed `.cut`
source can execute a feature.

## Troubleshooting

1. Run `cut doctor --json`; repair failed dependencies before debugging source.
   `CUTD1011` is an operating-system temp-space/permission/cleanup failure.
   `CUTD1131` means the actual bounded H.264/libx264, AAC, mastering-filter or
   ffprobe path failed; encoder-list presence alone is not enough.
2. Run `cut help --json`; remove flags absent from the installed artifact.
3. Run `cut fmt <file> --check`, then `cut check <file> --json`.
4. Regenerate `cut.lock` after every semantic source, asset, font, package or
   LUT change. Never hand-edit a hash to silence staleness.
5. Use `cut inspect --json` to find the exact reachable node and provenance.
6. Re-run `cut test`, then preview. Preview cannot substitute for the authored
   final output.
7. For JSON failures, repair the stable code and source location; do not parse
   colorized human text.
8. Before carrying an older artifact forward, run `cut migrate <artifact>
   --check --json`. A lock-v1/v2 refusal means regenerate from exact source and
   resources; never add guessed probe fields by hand.

The interface remains alpha until the compatibility policy and full platform
matrix pass. The machine reference and this document describe current behavior,
not a 1.0 stability promise.
