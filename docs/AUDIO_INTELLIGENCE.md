# Audio intelligence

CUT's audio renderer is deterministic. Audio intelligence is an authoring
workflow that prepares inputs for that renderer; it is not a model hidden in
`cut render`.

The workflow has four separate jobs:

1. **Observe** exact audio bytes: activity, silence, loudness, onsets, tempo
   candidates, structural changes, speech and acoustic characteristics.
2. **Understand** those observations with bounded perceptual estimates such as
   `speech`, `music`, `ambience`, `sfx`, `tense`, `calm`, `sparse`, `dense`,
   `build`, and `release`. These are model similarities, not objective emotion.
3. **Acquire** project inputs: edit-safe transcripts, immutable narration WAVs,
   and rights-explicit music or sound-effect candidates.
4. **Author and audition** ordinary public CUT source using `AudioClip`, buses,
   sidechains, automation, effects, fades, stems, and mastering. Listening at
   normal speed remains a creative review gate.

Keeping these jobs separate matters. A legal loudness measurement does not
choose an evocative score. A semantic model does not clear music rights. A
voice generator does not make a script engaging. And none of them should make
the final renderer depend on a network service or an unpinned model.

## Deterministic boundary

Model inference happens before lock. Every accepted result is materialized as
project-local bytes with a closed receipt:

- exact source, model, adapter, policy, and output identities;
- explicit stream and sample-clock authority;
- bounded settings and execution limits;
- license and attribution facts where third-party media or models are used;
- a canonical SHA-256 over the receipt body.

`cut lock` and `cut render` consume only the resulting transcript, WAV, audio
analysis, and selected media files. They do not invoke Whisper, Kokoro, CLAP,
or any cloud API. Cross-machine inference need not be byte-identical because
the committed output bytes, not a future rerun, are the render authority.

## Local backend direction

The intended optional local backend is deliberately explicit and is never an
install-time download:

- **ASR:** `whisper.cpp`, initially with a pinned quantized English model and a
  multilingual model as an explicit alternative. It produces the existing
  strict `cut-transcript` v1 sidecar.
- **Narration:** the optional local Kokoro MLX provider authenticates one
  caller-installed macOS arm64 runtime, model, voice and eSpeak closure, then
  materializes an immutable WAV plus a generation receipt. Normal-speed voice
  review remains a separate human gate.
- **Audio semantics:** the shipped optional local backend uses caller-supplied
  YAMNet model bytes through direct LiteRT over fixed PCM windows. CUT bundles
  only its bounded adapter and exact 521-row AudioSet label map; it does not
  bundle Python, NumPy, LiteRT, model weights, a virtual environment, or a model
  cache. It provides coarse speech, music, ambience and sound-event evidence,
  not objective emotion or open-text similarity. Stock MediaPipe Tasks remains
  rejected for this role because its distributed Python runtime performs usage
  logging.
- **Signal analysis:** CUT's own bounded PCM kernels and FFmpeg toolchain for
  activity, silence, loudness, true peak, onsets, tempo candidates, and section
  evidence.

YAMNet setup itself performs no download or network access: install the
supported environment and model separately, then give CUT exact local paths.
Analysis, audition, lock, preview and render are local. Model-backed analysis,
transcription or narration commands must hash-check their model files and
native executables and remain local after setup.

Microsoft Edge Read Aloud is not a default backend. Community `edge-tts`
clients call an unofficial online endpoint, send script text off-device, and
cannot provide a stable or reproducible service contract. A future Microsoft
voice integration must use the official Azure Speech API as an explicit cloud
provider with user credentials and terms.

## Analysis contract

`cut-audio-analysis` v1 binds one selected source stream and normalized PCM to:

- exact window and hop policy;
- per-window RMS, peak, onset strength, and bounded semantic similarities;
- silence/activity spans and tempo/beat candidates;
- structural sections with role, mood, and confidence estimates;
- the exact backend/model/prompt-policy identity.

Sample indices are the canonical time representation. Windows and sections are
ordered, bounded by the selected duration, and interpreted on the declared
sample rate. Mood and emotion fields are always named perceptual estimates.

The installed YAMNet vertical is intentionally smaller than the general
analysis contract. It accepts one project-relative RIFF/WAVE file containing
16-, 24-, or 32-bit integer PCM, 1..8 channels, an 8..192 kHz sample rate, and
at most ten seconds of audio. The input may use classic PCM or the strict
40-byte WAVE_FORMAT_EXTENSIBLE PCM form with the standard PCM subformat GUID,
matching valid/container bits, and either no channel mask or a coherent
standard-speaker mask. A fixed pure kernel authenticates and copies the WAV,
downmixes with an equal-weight f64 mean, and either preserves mono 16 kHz
samples or applies the declared 32-tap resampler. The provider receives only
mono f32le 16 kHz PCM on standard input.

```sh
cut audio analyze-setup .cut/audio/yamnet-local.recipe.json \
  --out .cut/audio/yamnet-local.setup.json --json
cut audio analyze-doctor --setup .cut/audio/yamnet-local.setup.json --json
cut audio analyze media/source.wav \
  --setup .cut/audio/yamnet-local.setup.json \
  --out .cut/audio/source.analysis.json --top 8 --json
```

The setup recipe declares canonical absolute paths for one supported CPython,
its site-packages roots, the exact LiteRT subset, and one YAMNet model. CUT
injects its bundled adapter and label map, hashes every selected file, checks a
direct-LiteRT doctor, and publishes the bounded setup create-only (at most one
MiB of canonical JSON). No command downloads dependencies. Generated setup
files contain local absolute paths and should not be committed when that exposes
machine layout. A copyable shape is available at
[`yamnet-local.recipe.example.json`](fixtures/yamnet-local.recipe.example.json).

The supported optional execution profiles are Darwin arm64 and Linux x86_64.
The adapter denies network and subprocess calls as defense in depth, but this is
not an operating-system sandbox: authenticated native code still runs with the
user's permissions. Exact repeat is claimed only for the same authenticated
bytes and supported runtime identity; cross-machine floating-point identity is
not claimed. Model license and provenance strings are caller declarations. The
bundled label map is byte-fixed and carries its CC-BY-4.0 notice. Neither is
proof of rights.

The package also exports a pure dialogue-prosody analyzer over exact normalized
PCM and `cut-transcript` v1. It measures speaking and articulation rate,
acoustically witnessed pauses, phrase and sentence spans, same-speaker rate and
level contours, and bounded emphasis candidates. Speaker changes always split
phrases and sentences; CUT never compares delivery contours across speakers.
Its dialogue-space output combines measured transcript timing with an explicit
authored protection policy. It is not measured masking, emotion recognition,
or performance approval. The kernel recomputes PCM and transcript identities;
its media SHA is only a cross-binding to transcript authority, so an outer
workflow must still authenticate the original media bytes.

The installed CLI closes that outer authority for standalone integer-PCM WAVE
sources:

```sh
cut audio prosody media/interview.wav \
  --transcript assets/interview.cut-transcript.json \
  --out .cut/audio/interview.prosody.json --json
```

The transcript must bind the exact WAVE SHA-256, stream index zero, and the
same sample-rate/duration clock. CUT authenticates both project-relative files,
decodes the existing strict classic or WAVE_FORMAT_EXTENSIBLE 16/24/32-bit PCM
subset, equally downmixes channels to native-rate mono Float32 without
resampling, invokes the pure analyzer, then rechecks both files before one
create-only transaction. The WAVE is capped at 64 MiB, 100 million frames, and
100 million channel-sample reads; the canonical analysis artifact is capped at
32 MiB. Cancellation leaves no published output. The artifact is the existing
`cut-dialogue-prosody-analysis` v1 shape, not a second wrapper schema.

This is measured timing and level evidence, not emotion recognition, speaker
identification, pitch interpretation, acoustic masking measurement, or
performance approval. Speaker labels remain transcript declarations, and the
command does not modify source, lock, preview, render, or delivery behavior.

## Transcription and narration

Transcription materializes the existing `cut-transcript` v1 format so the
result immediately composes with transcript edits, captions, picture edits,
and CUT's ordinary audio-edit algebra. Provider timestamps are snapped only to
the authenticated source sample grid; zero-length, overlapping, out-of-range,
or reordered words fail closed.

The provider-independent materializer validates exact sample-index observations
and remains usable by other adapters. The public local-Whisper workflow now
adds the missing outer authority: it retains and rehashes source, FFmpeg,
compatible static whisper.cpp 1.9.2, and model bytes; normalizes through a
pipe-only FFmpeg input; executes private retained copies with `--no-gpu`; maps
integer-millisecond word boundaries onto the selected source sample clock; and
publishes the transcript and receipt create-only. Ordinary adjacent words that
share an off-grid millisecond boundary are snapped to one shared sample; the
separate one-sample repair for a tied zero-duration word remains narrowly
counted in the receipt.

```sh
cut audio setup .cut/audio/whisper-local.recipe.json \
  --out .cut/audio/whisper-local.setup.json --json
cut audio doctor --setup .cut/audio/whisper-local.setup.json --json
cut audio transcribe media/interview.wav \
  --setup .cut/audio/whisper-local.setup.json \
  --out assets/interview.cut-transcript.json \
  --receipt assets/interview.cut-whisper.json \
  --stream 0 --language en --threads 8 --json
```

The recipe is a closed JSON object with `ffmpeg`, `whisperCli`, and `model`
records. Each record supplies one canonical absolute local path plus its
declared revision/license metadata; `whisperCli.sourceArchiveSha256` is the
pinned source-archive digest and `whisperCli.buildPolicy` names the compatible
build policy. Setup performs no download: CUT retains and hashes the selected
files, runs the existing version/linkage doctor only on authenticated private
copies, and writes the setup create-only. The output is machine-local because
it contains absolute paths, so it should not be committed when that would
disclose local filesystem layout.

A copyable recipe shape is available at
[`whisper-local.recipe.example.json`](fixtures/whisper-local.recipe.example.json).
Replace every `/absolute/path/to/...` value with the exact local file selected
for this machine; CUT will reject missing, linked, changed, or incompatible
bytes rather than guessing.

Setup is currently compatible with the Darwin arm64 execution policy. CUT
authenticates the caller-selected bytes and tested behavior; revision,
source-build and model-license labels are caller-declared provenance rather
than cryptographic proof. The initial punctuation-join policy is
English-oriented, so multilingual joining is not yet claimed.

Narration consumes a UTF-8 script and explicit voice, language, speed, model,
and pronunciation policy. It publishes an immutable WAV and receipt together.
Voice choice and speed are not treated as full emotional direction. Script
punctuation, sentence rhythm, take selection, and in-context listening remain
part of direction.

The installed alpha exposes one bounded, optional local command:

```sh
cut audio narrate scripts/intro.txt \
  --recipe .cut/audio/kokoro-mlx-local.recipe.json \
  --out assets/intro-narration.wav \
  --receipt assets/intro-narration.kokoro.json \
  --language en-us --speed 0.96 --seed 17072026 \
  --sample-rate 48000 --json
```

The script is currently one trimmed, NFC, control-free UTF-8 paragraph of at
most 64 KiB. A text file may end in exactly one conventional LF or CRLF, which
CUT removes before synthesis; leading whitespace, extra blank lines, internal
line breaks and other controls still fail. The raw script bytes and their
SHA-256 remain bound separately in the public result. Language is closed to
`en-us`; speed is `0.75..1.25`, seed is an
unsigned 32-bit integer, and sample rate is 24000 or 48000. The project-local
script and recipe are reauthenticated through the two-output create-only
transaction, so a changed input, cancellation, collision, or failed inference
publishes neither WAV nor receipt.

The strict recipe supplies canonical absolute paths and version identity for
CPython and eSpeak, caller-declared licenses for separately bounded
Python/native packages, the Kokoro model and one voice, plus CUT's fixed eSpeak
GPL notice. It deliberately has no adapter
path: CUT resolves and authenticates the adapter shipped in the installed npm
package. Start from the
[`kokoro-mlx-local.recipe.example.json`](fixtures/kokoro-mlx-local.recipe.example.json)
shape, then enumerate the complete import closure of the dedicated environment;
the illustrative roots are not a promise about another installation. Each
runtime component accepts at most 256 roots, which accommodates environments
whose import closure has many top-level modules and metadata/native files. The
existing aggregate authority remains stricter where it matters: at most 128
components, 256 declared packages, 32,768 authenticated runtime files and 512
MiB, with overlapping files rejected. No CUT
command downloads or installs Python, MLX, Kokoro, model, voice, or eSpeak
bytes. The machine-local recipe can disclose filesystem layout and should not
be committed unchanged.

This backend currently supports only macOS arm64 with CPython 3.12 and the
caller-selected compatible Kokoro MLX/MLX closure. It asks the provider to stay
offline and rejects adapter subprocess/network calls, but this is not an OS
sandbox. Runtime/model/voice license strings are declarations, not legal proof.
Seeded inference is not claimed byte-reproducible across executions: the
published WAV SHA-256 is the deterministic asset boundary consumed by lock and
render. The command does not claim transcript alignment, emotion control,
voice quality, or normal-speed listening approval.

## Semantic arrangement into public CUT source

Once dialogue, music, ambience and SFX have been deliberately selected, the
model-free arranger converts an explicit semantic/audio binding into ordinary
editable CUT source:

```sh
cut audio arrange audio-arrangement-input.json \
  --out audio-arrangement.cut \
  --manifest review/audio-arrangement.manifest.json --json
```

The input embeds an accepted `cut-audio-brief` v1, optional complete
dialogue-prosody analysis, and exact asset bindings. The documentary/podcast v1
profile requires one continuous dialogue asset, exact act music/ambience
bindings where requested, and at most one accepted SFX per filled brief event.
It authors public `AudioTrack`, `AudioRegion`, `AudioGap`, `AudioClip`, buses,
gain, pan, parametric EQ and reverb primitives. Perspective labels remain
metadata; only separately supplied numeric controls affect source. Intentional
silence removes supporting sound exactly while preserving dialogue.

Unlike the pure kernel alone, the installed command reopens every bound asset:
it no-follow authenticates `lockedResourceSha256`, decodes strict classic or
WAVE_FORMAT_EXTENSIBLE integer PCM at native rate, checks the declared sample
rate, and proves the source range fits actual duration. The public workflow is
bounded to 64 assets, 64 MiB each, 512 MiB aggregate encoded bytes and 100
million aggregate channel-sample reads, processed sequentially. It then
rechecks the input and every asset twice around one create-only source/manifest
publication transaction.

The `.cut` output must be a root-level filename so its project-relative asset
locators preserve their meaning; the manifest may be nested. Output bytes are
the exact pure-kernel source and canonical manifest. The command performs no
model execution, media discovery, asset selection, download, normalization,
retiming, lock, render, main-source mutation, normal-speed listening or rights
approval. Inspect and edit the proposal first, then run `cut lock` explicitly.

The [copyable input shape](fixtures/audio-arrangement-input.example.json) uses
all-zero script and resource SHA-256 values as honest placeholders. Replace
them with selected local authority and regenerate the canonical `briefSha256`
and `inputSha256`; they intentionally become stale whenever a bound field is
edited.

## Music and sound effects

CUT does not bundle stock music or effects. The implemented alpha can search a
closed catalog and can measure and audition exact local PCM candidates under
real dialogue. CLAP similarity and folder indexing remain planned until an
accepted model/runtime authority is installed. Catalog entries bind creator,
source, hashes, attribution, and separate composition/master grants. Candidate
discovery is not legal clearance.

The conservative audio-grant metadata helper is only a mechanical policy: both
composition and master grants must explicitly allow commercial use,
modification, and audiovisual synchronization; rejected, pending, noncommercial,
no-derivatives, share-alike, unknown, or incomplete grants do not pass. Human
rights approval can still be required by a project.

An authoring agent should create an audio brief before retrieval: narrative
role, intended arc, density, dialogue space, hit points, transitions, and the
single intended use of silence. It should audition several candidates under
the real dialogue rather than select from metadata alone.

## Available semantic index and search commands

The installed semantic retrieval slice indexes an explicit catalog and v2
binding file; it does not scan a directory or download, install, or execute a
model:

```text
cut audio index <catalog.json> \
  --bindings <audio-audition-bindings-v2.json> \
  --out <audio-semantic-index.json> [--json]

cut audio search <audio-semantic-index.json> \
  --query "ambient electronic" \
  [--role music|sfx|ambience|dialogue] \
  [--rights declared-commercial-sync] [--limit 20] [--json]
```

`audio index` requires semantic authority for every v2 binding. It no-follow
loads and hashes the actual project-local source, rights-evidence, and semantic
files; validates the shipped semantic schema; recomputes top AudioSet classes
and taxonomy from embedded score/class-map bytes; and replays normalization
and materialization from the authenticated source WAV. It then publishes one
create-only, canonical `cut-audio-semantic-index` v1 artifact, bounded to 1 MiB.
The closed schema is
[`cut-audio-semantic-index-v1.schema.json`](../schemas/cut-audio-semantic-index-v1.schema.json).
Unbound audio catalog entries are reported as omitted rather than silently
indexed.

`audio search` validates that closed artifact and canonical hash before use.
Matching uses NFKC-lowercased exact tokens from catalog metadata and positive
aggregate AudioSet labels. Every query token must match. Ranking is the mean of
the best per-token scores, then declared-match count, then bytewise candidate
id. `--role` comes only from catalog metadata. The optional rights filter means
only that CUT's narrow declared commercial-synchronization metadata predicate
passes; it is not legal clearance. JSON and human output retain the exact
per-token evidence explaining each match.

Search results remain a canonical candidate-evidence snapshot, not `cut.lock`
authority or a creative decision. Listen to selected audio under the real mix,
retain human rights review, declare accepted bytes project-locally, and run
`cut lock` before rendering.

## Available audition command

The first installed end-to-end slice creates bounded, non-authoritative score
auditions under real dialogue. It authenticates the brief, catalog, project
audio, and separate local rights-evidence bytes; measures the actual PCM;
generates ordinary public CUT source with buses and sidechain ducking; and
renders review WAVs through CUT's existing locked audio path:

```text
cut audio audition <brief.json> \
  --dialogue <voice.wav> \
  --catalog <catalog.json> \
  --bindings <bindings.json> \
  --samples 0:1440000 \
  --music-start-sample 96000 \
  --out <review-directory> \
  [--top 3] [--json]
```

`bindings.json` maps each catalog candidate id to exact project-local audio and
rights-evidence files. Legacy v1 remains accepted exactly. V2 additionally
requires the exact `bytes`, file SHA-256, canonical analysis SHA-256, and
project-local locator reported by `cut audio analyze` for every candidate. The
closed formats are shipped as
[`cut-audio-audition-bindings-v1.schema.json`](../schemas/cut-audio-audition-bindings-v1.schema.json)
and
[`cut-audio-audition-bindings-v2.schema.json`](../schemas/cut-audio-audition-bindings-v2.schema.json),
with copyable examples at
[`audio-audition-bindings.example.json`](fixtures/audio-audition-bindings.example.json)
and
[`audio-audition-bindings-v2.example.json`](fixtures/audio-audition-bindings-v2.example.json).
`bindingsSha256` is the SHA-256 of CUT's canonical JSON for `format`, `version`
and `entries`; it changes whenever a binding changes. The candidate id must
match a `kind: "audio"` catalog entry, and both locators must remain inside the
project.

The first tranche accepts bounded classic integer PCM WAV inputs. V1 ranking
combines declared catalog semantics with deterministic signal measurements.
When every eligible candidate uses v2 bindings, CUT validates the closed
YAMNet artifact and its exact source identity, recomputes provider top classes
and taxonomy from the embedded bounded raw-score and official class-map bytes,
and replays normalization plus deterministic signal analysis from the
authenticated candidate WAV. Only an exact whole-source music result affects rank: the
music score is a centered additive adjustment capped at plus or minus 20,000
ppm per candidate (and therefore can change a pairwise margin by at most 40,000
ppm). Mood,
ambience, SFX, partial-window, and unsupported-role evidence remains visible
but unweighted because the current fixtures do not justify stronger claims.
CUT does not re-run the model during audition; the stored score bytes are the
bounded replay boundary.

Every candidate is measured over the exact source intervals that will be
heard, including repeated full loops and a terminal partial loop. A/B level
calibration targets -24 dBFS RMS before ducking, with a -1 dBFS peak ceiling
and bounded gain; this is an audition policy, not LUFS delivery mastering.
`--music-start-sample` places the candidate relative to the selected review
range and is bound into source and receipt identity. Rights evidence is
verified as input authority, but remains evidence rather than legal clearance.
Generated receipts keep human listening and rights approval explicitly
unperformed.

## Non-goals for the first tranche

- automatic music generation;
- claiming objective emotion recognition;
- automatic legal clearance;
- replacing normal-speed listening with metrics;
- putting model execution in `.cut` source, package evaluation, lock, preview,
  or final render;
- silently turning analysis suggestions into edits.

## Audio Brief

`cut-audio-brief` v1 is a hash-bound authoring artifact, not an edit plan. It
binds an exact script digest and program sample clock to contiguous narrative
acts, desired audio roles and moods, energy/density/dialogue-space direction,
sample-exact events, and intentional silence ranges. Acts must cover the full
program without gaps or overlaps; events and silences are ordered and bounded.
Role and mood arrays are authored priority order, not unordered tags. Silence
is represented only by `intentionalSilences`; event kinds do not duplicate its
start or end boundaries.

The brief helps retrieval and audition produce deliberate alternatives. It does
not select media, place clips, change CUT source, or authorize a renderer action.
An author or agent must turn accepted direction into ordinary reviewable CUT
source, and normal-speed listening remains the creative gate.
