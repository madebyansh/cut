# Edit-safe transcript selection

Status: executable public audiovisual vertical in `cut-lang`
`0.4.0-alpha.4`. This is a bounded transcript-editing contract, not a CUT 1.0
claim and not professional creative proof.

## What CUT owns

One `TranscriptEdit` is the canonical selection and placement record for a
spoken excerpt. It binds:

- one external `cut-transcript` v1 `TranscriptAsset` (or a legacy `DataAsset`);
- one `AudioAsset`;
- an inclusive range of stable word IDs;
- the exact source range derived from those words;
- one exact scene-local destination start; and
- an optional editorial link ID; and
- optionally, one authenticated `TranscriptMediaAuthority` that maps the
  transcript audio clock onto an independently declared video stream.

`TranscriptAudio(edit:)`, `TranscriptPicture(edit:, source:)`, and
`TranscriptCaptions(edit:)` consume that same record. The author does not copy
source timecodes, destination timecodes, or selected text into any consumer.
The compiler lowers the first two to ordinary sample-accurate `AudioClip` and
frame-quantized `PictureClip` runtime nodes; the reference runtime derives exact
caption cues from the selected words.

CUT does **not** run ASR, call a model, interpret prose, infer word IDs, or
accept hidden transcript JSON in this formal path. A human or external
deterministic transcription process must provide the sidecar. CUT validates
and authenticates it.

Prefer `TranscriptAsset = transcript("...")`. Its compiler-owned authority
binds `cut-transcript-v1` and the strict sidecar parser while preserving the
compatible outer `kind: "data"` IR/lock envelope. Existing
`DataAsset = data("...")` transcript programs remain source-compatible and
omit the authority field exactly.

## Canonical nonlinear-editor algebra

Transcript selections do not have a second structural editor. An
authority-backed `TranscriptPicture` and its linked `TranscriptAudio` may enter
the same public `TimelineEdit` transaction used by ordinary picture/audio
items:

```cut
TimelineEdit(id: "quote-split", operations: [
  editSplit(
    selection: editSelection(trackIds: ["v-dialogue", "a-dialogue"]),
    at: avTime(picture: 2s, audio: 2s)
  )
]);
```

The compiler first lowers both transcript consumers to ordinary direct media
leaves, then stages and atomically commits one canonical TimelineEdit plan.
Runtime validation replays that plan and correlates both tracks to one
materialization identity. Every picture slice preserves the authenticated
transcript/media origin identity and derives a new segment identity from its
exact source interval, destination interval, and time map. Audio slices retain
the same transcript binding while the canonical plan records their exact
origin/parent/segment lineage and origin-relative presentation clock.

This alpha slice is intentionally bounded: linked `editSplit`, `editTrim`, and
`editRippleDelete` are executable for transcript-selected picture/audio.
Trim and ripple preserve the immutable transcript selection and record exact
origin, parent-segment, source-window, destination, and materialization
lineage through the ordinary TimelineEdit result. Legacy co-located
`TranscriptPicture`, slip, slide, boundary changes, transitions,
insert/overwrite, and source-changing operations fail closed until CUT has
separately authenticated their transcript-origin, handle, fade, and retime
semantics. Selecting a different picture resource than the declared
`TranscriptMediaAuthority` also remains a source-located error. These limits
do not narrow ordinary TimelineEdit operands.

The current-source `current-v3` education/documentary conformance fixture
executes the same path rather than a transcript-only shortcut: it applies a
linked split, trim, and ripple through canonical `TimelineEdit`, renders the
retained one-second picture/PCM selection and the transparent/silent deleted
tail, and repeats both delivered byte sequences exactly. OTIO preserves the
representable roles, namespaced metadata, timing, and link structure while
reporting the transcript-origin semantic as the target-scoped
`CUT_OTIO_TRANSCRIPT_ORIGIN_UNSUPPORTED` loss. That is an honest interchange
boundary, not reconstructed transcript authority. V2 remains preserved
history.

This does not reopen `@cut/documentary Narration` as a metadata container.
`Narration(source:, range?:, fadeIn?:, fadeOut?:)` remains its complete public
signature; `Narration(..., transcript: "...")` still fails source-located
`CUT2059`. Use `TranscriptCaptions(edit:)` for visible text bound to this
selection, ordinary `Captions` for authored VTT/SRT, or `Marker`/`Region`
comments for non-rendering notes.

## `cut-transcript` v1

The shipped closed schema is
[`schemas/cut-transcript-v1.schema.json`](../schemas/cut-transcript-v1.schema.json).
A minimal document is:

```json
{
  "format": "cut-transcript",
  "version": 1,
  "media": {
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "audioStreamIndex": 1,
    "audioSampleRate": 48000,
    "duration": { "numerator": "2", "denominator": "1" },
    "videoStreamIndex": 0,
    "videoFrameRate": { "numerator": "24", "denominator": "1" },
    "videoDuration": { "numerator": "5", "denominator": "1" }
  },
  "words": [
    {
      "id": "answer.001",
      "start": { "numerator": "0", "denominator": "1" },
      "end": { "numerator": "1", "denominator": "2" },
      "text": "Words",
      "join": "none",
      "speaker": "guest"
    },
    {
      "id": "answer.002",
      "start": { "numerator": "1", "denominator": "2" },
      "end": { "numerator": "1", "denominator": "1" },
      "text": "matter.",
      "join": "space",
      "speaker": "guest"
    }
  ]
}
```

The example digest is illustrative; a real sidecar must contain the lowercase
SHA-256 of the exact master media bytes selected by `source`.

Times are reduced rational seconds. Word boundaries must be non-overlapping,
chronological, inside `media.duration`, and exactly representable on
`media.audioSampleRate`. IDs are unique stable ASCII identifiers. `join`
declares the separator before a word; the first word uses `none`. Optional
`speaker` changes caption grouping.

`media.videoStreamIndex` and `media.videoFrameRate` may be supplied together
when the selected audio is co-located with picture. `media.videoDuration` is
optional generally, but is mandatory for `TranscriptPicture`. It is an
independent decoded-video duration authority: it may differ from audio
`media.duration`, and CUT never reuses the audio duration as a picture bound.
When the selected streams have different presentation origins, add the
optional nonzero exact rational `media.audioVideoPresentationDelta`, defined
as:

```text
decoded audio first PTS × audio time base - selected video stream start
```

Positive means audio begins later than picture; negative means audio begins
earlier. Omission is the one canonical spelling of exact `0/1`, and an explicit
zero is refused so two sidecars cannot represent the same authority.
`audioVideoPresentationDelta` requires the complete video stream/rate/duration
trio. Locking independently observes and authenticates the declared delta
alongside those video fields.

## Independent transcript media authority

Use `transcriptMedia` when transcript audio and picture are independently
declared resources. It is a compile-time authority, not a decoder, synchronizer,
or filename convention:

```text
transcriptMedia(
  transcript: TranscriptAsset,
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

The function must directly initialize one scene-local `let`. Both stream
selectors are absolute integers from 0 through 65,535 and must agree with the
explicit selectors on the referenced asset declarations. `videoFrameRate`,
`videoDuration`, both clock anchors, and the positive exact rational
`videoRate` from 1/64 through 64 are author assertions that `cut lock`
re-authenticates against the selected locked bytes and native probe.

The sole clock law is:

```text
videoTime = videoAt + (audioTime - audioAt) * videoRate
```

CUT never guesses this relationship from a filename, directory, container
order, matching duration, waveform, or co-location. `audioAt` must land on the
authenticated audio sample grid. `videoAt` must land on the declared and
authenticated source-video frame grid. The complete mapped selection must
remain inside `[0, videoDuration]`.

Pass the authority through the final optional `media` argument:

```text
transcriptEdit(
  transcript: TranscriptAsset,
  source: AudioAsset,
  from: String,
  through: String,
  at: Time,
  link?: String,
  media?: TranscriptMediaAuthority
) -> TranscriptEdit
```

Omitting `media` preserves the existing co-located v1 semantics and identity.
Supplying it requires the exact same transcript and audio resource, in the
same scene, and authorizes only the authority's exact video resource.

## Public CUT source

`transcriptEdit` must be the direct initializer of a scene-local `let` binding.
`TranscriptAudio` must be a direct `AudioTrack` item. `TranscriptPicture` must
be a direct `PictureTrack` item. A caption statement must cover the complete
selected destination interval.

The source below is the legacy co-located contract-complete schematic, not a
standalone fixture:
its word IDs, selected text, exact one-second duration, stream indexes and
media/font paths must match assets in the caller's lock. The executable
real-media proof is generated by `tests/transcript-picture-cli-render.test.ts`.

```cut
cut 0.4;
project "Transcript selection";

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
import { Rect, TranscriptCaptions } from "cut:visual";

asset words: TranscriptAsset = transcript("assets/answer.cut-transcript.json");
asset voice: AudioAsset = audio("assets/answer.mov", stream: 1);
asset camera: VideoAsset = video(
  "assets/answer.mov",
  videoStream: 0,
  audioStream: 1
);
asset face: FontAsset = font("assets/Inter-Regular.ttf");

timeline main(
  duration: 2s,
  fps: 24,
  width: 1920px,
  height: 1080px,
  sampleRate: 48khz
) {
  scene answer(duration: 2s) {
    let quote: TranscriptEdit = transcriptEdit(
      transcript: words,
      source: voice,
      from: "answer.001",
      through: "answer.002",
      at: 500ms,
      link: "answer-a"
    );

    assert quote.duration == 1s, "selected spoken duration";
    assert quote.text == "Words matter.", "selected transcript text";

    Rect(
      width: 1920px,
      height: 1080px,
      x: 960px,
      y: 540px,
      fill: #16213a
    );
    TranscriptCaptions(
      edit: quote,
      font: face,
      maxWords: 2,
      position: "bottom"
    );

    Sequence(duration: 1500ms) {
      PictureTrack() {
        Gap(duration: 500ms);
        TranscriptPicture(
          edit: quote,
          source: camera,
          fit: "cover"
        );
      }
    }

    AudioTrack() {
      AudioGap(destination: 0s ..< 500ms);
      TranscriptAudio(edit: quote, fadeIn: 10ms, fadeOut: 20ms);
      AudioGap(destination: 1500ms ..< 2s);
    }
  }
}

export release = render(
  main,
  width: 1920px,
  height: 1080px,
  codec: "h264"
);
```

The public `TranscriptEdit` members are `sourceRange`, `destinationRange`,
`duration`, and `text`. `from` and `through` are inclusive. The destination
duration is exactly the selected source duration; this v1 slice does not
time-stretch a transcript selection.

In the legacy form, `TranscriptPicture` requires an explicitly selected
co-located video stream
whose rate exactly equals the composition rate. The direct `PictureTrack`
cursor and the edit destination start must be equal and frame-aligned. Let `d`
be the declared presentation delta, or exact zero when omitted. A word source
interval `[s,e)` on the decoded-audio-local clock maps to decoded-video-local
interval `[s+d,e+d)`. The complete mapped interval must lie inside
`[0,videoDuration]`; CUT refuses rather than intersecting it, holding a frame,
or inventing black.

CUT then chooses the unique smallest half-open source-frame interval:

```text
[floor((s + d) * fps) / fps, ceil((e + d) * fps) / fps)
```

The picture can therefore begin before the mapped first word and/or end after
the mapped last word. Each frame-edge extension is strictly less than one
frame period, so the combined extra head plus tail is non-negative and
strictly less than two frame periods. That full covering interval is the
lowered ordinary PictureClip duration; CUT does not silently trim its tail
back to the audio word duration or shift timestamps in the backend.

For independently declared media, bind the authority and use the same ordinary
picture operation:

```cut
import {
  TranscriptPicture,
  transcriptEdit,
  transcriptMedia
} from "@cut/edit";

asset words: TranscriptAsset = transcript("assets/lesson.cut-transcript.json");
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

The compiler maps the exact selected audio interval through the authority and
chooses the smallest complete source-frame cover at the authenticated source
cadence. If that source cadence differs from the composition cadence, CUT does
not silently snap or invent a retime. Default one-times placement is admitted
only when the derived destination duration lands exactly on the composition
frame grid. Otherwise provide both final `TranscriptPicture` arguments:

```text
duration: Time,
rate: Number
```

They use the ordinary constant-retime law:

```text
source duration = destination duration * rate
```

Providing only one, an inexact equation, or explicit `duration`/`rate` on the
legacy co-located form fails source-located. This changes picture timing only;
`TranscriptAudio` continues to place the selected audio interval at its exact
destination without stretching.

### Ordinary picture edit algebra

An authority-backed `TranscriptPicture` carries an immutable origin identity
through the ordinary typed picture-edit plan. The current admitted subset is:

- direct placement;
- split/cut;
- trim; and
- one exact constant retime, including split or trim after that retime.

Each materialized segment gets a deterministic segment identity from the
authenticated origin plus its final exact source interval, destination
interval, and time map. The runtime still executes ordinary `PictureClip`
semantics; there is no transcript-specific decoder or compositor.

Transitions are intentionally excluded. CUT has not authenticated the source
handles that a transcript-bound transition would consume, so `transitionAt`
fails instead of inventing those handles. Legacy co-located
`TranscriptPicture` remains direct, forward 1x, and without a structural edit
plan.

One edit is bounded to 4,096 selected words and 1 MiB of selected UTF-8 text.
`TranscriptCaptions.maxWords` must be a whole number from 1 through 64.
Accepted arguments are closed; unknown or mistyped fields fail source-located
instead of becoming no-ops.

## Caption grouping and typography

`TranscriptCaptions` uses the same closed appearance controls and locked-font
outline renderer as `Captions`. Its cue clock remains exact rational time; it
does not quantize word boundaries to milliseconds. Grouping algorithm
`cut-transcript-caption-groups-v2` closes a cue at the first of:

- the authored `maxWords` ceiling;
- a speaker change;
- sentence-final punctuation; or
- an inter-word gap of at least 250 ms.

After those semantic boundaries are fixed, CUT derives a soft line budget from
the usable caption width and size at two Unicode code points per em. A group
over that budget is split at one authored space boundary into at most two
lines. The deterministic choice minimizes, in order, the wider line's code-
point count, the line-length imbalance, the word-count imbalance, and then the
split index. Timing does not change.

Actual locked-font outlines remain the authority. Preflight computes the
horizontal scale required by every resulting line and refuses a line below
`0.85` with source-located `CUT_CAPTION_LEGIBILITY`; it does not silently
squash arbitrarily long text. Shorten the cue, reduce size or padding, or
increase `maxWidth`.

This is a bounded legibility rule, not a full typography engine. CUT does not
yet claim production complex-script or bidirectional shaping, font fallback,
language-aware line breaking, hyphenation, selectable transcript-caption
delivery, or word highlighting. Use a locked fixed-instance monochrome-outline
TTF/OTF whose supported cmap covers every selected character.

## Lock and proxy authority

Compilation parses the bounded sidecar and records the selected IDs, selected
ID hash, text, exact source/destination ranges, words, media authority, and
source provenance in typed CutAVIR. `cut lock` then:

1. no-follow reads and hashes the project-confined `TranscriptAsset` (or legacy `DataAsset`);
2. reproduces the exact inclusive selection from those locked bytes;
3. proves the ledger still agrees with the selected IDs, text, words and times;
4. matches the sidecar SHA, absolute audio stream, sample rate, and duration to
   the independently probed locked master `AudioAsset`;
5. for `TranscriptPicture`, matches the absolute video stream, frame rate, and
   independent `videoDuration` to a decoded-video-cadence witness; and
6. independently derives audio-anchor minus video-anchor and requires it to
   equal `audioVideoPresentationDelta`, with omission asserting exact zero.

For an explicit `TranscriptMediaAuthority`, lock additionally authenticates the
independent video resource and selected stream, rechecks its exact cadence and
duration, validates both clock anchors, and replays the rational clock mapping.
The strict IR loader re-derives the authority identity and every materialized
picture origin/segment identity. A foreign scene/resource, selector drift,
changed bytes, forged identity, mapped underflow/overflow, time-map drift, or
post-lock mutation fails before affected decode or publication.

Lock apply and the verified-input runtime session repeat the relevant checks.
Changing the sidecar, media bytes, selector, timing, or lock metadata fails
before the transcript consumer may execute.

The sidecar remains authoritative for the master. A byte-different audio proxy
may execute in `cut preview` or `--profile proxy` only when the ordinary proxy
lock contains a valid CUT audio-alignment record proving it editorially
equivalent to that master. The proxy cannot replace the binding merely by
claiming the master's digest. `cut render` selects the master.

Picture proxy substitution is admitted only through the ordinary locked video
proxy contract. Matching clocks and frame counts are insufficient: `cut lock`
must create a descriptor-bound, integrity-checked decoded RGB correspondence
witness, and full apply plus the private verified-input session recompute it.
An unrelated same-cadence proxy fails source-located
`CUT_PROXY_VIDEO_ALIGNMENT`; a proved proxy is eligible for preview while
render continues to select the sidecar-bound master.

## Exact CLI workflow

From the project directory:

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

`check` must read the declared transcript sidecar because its selected words
are compile-time semantics; it does not authenticate the audio bytes or native
probe at that stage. `lock` supplies that media authority. `build` emits the
typed transcript ledger and ordinary executable consumers. `inspect` reports
the ledger without hiding it in a project-specific plan. `frame` proves caption
pixels, `audition` proves the exact sample interval, preview selects an
authenticated audio proxy when eligible and explicit master fallback
otherwise, and render selects the master.

Run `cut test`, full-speed playback, and headphone listening in addition to
this mechanical loop for a release candidate. These commands prove execution;
they do not judge pacing, speech intelligibility, caption taste, or creative
quality.

The clean packed-install proof must ship this exact public signature, IR/schema,
lock/runtime behavior, tests, and documentation, then execute from a consumer
directory with no source-tree module resolution. A local macOS alpha package
run is not a signed distribution, Linux/Windows result, independent human
install, or speech-picture review.

## Identity and current limits

Formatting and comments do not change the transcript selection's semantic
identity. A text-only sidecar correction that preserves word IDs and exact
timing leaves the lowered audio and picture node identities unchanged while
invalidating the caption identity and build identity.

This vertical is deliberately bounded:

- `TranscriptAudio`, `TranscriptPicture`, and `TranscriptCaptions` execute;
- omission of `media` preserves the forward-1x, co-located, exact-rate,
  direct-track legacy picture contract and authenticated A/V presentation
  delta;
- explicit `TranscriptMediaAuthority` admits independent audio/video
  resources, exact rational clock mapping, non-zero anchors, rationally
  mismatched source/composition cadences, destination placement, ordinary
  split/trim, and one exact constant retime;
- authority-backed linked transcript picture/audio also execute canonical
  TimelineEdit split, trim, and ripple-delete with ordinary segment lineage,
  runtime replay, inspect/diff, and cache identity;
- transition handle authority, variable retime, implicit synchronization,
  decoded transcript-picture proxy equivalence, and a general transcript NLE
  are not claimed;
- transcript captions have deterministic at-most-two-line wrapping and a
  `0.85` horizontal-scale floor, but no complex-script/full typography claim;
- no ASR, forced alignment, speaker inference, or natural-language editing is
  part of formal execution; and
- the two dialogue/podcast and product/education programs are engineering
  fixtures, not qualifying professional projects; named-human sync, full-speed
  playback, intelligibility, and creative review remain `UNPERFORMED`.

The repository therefore remains `0.4.0-alpha.4`. This slice reduces one real
authoring burden. The current-source V3 three-project nonlinear-editor
conformance is a technical pass with explicit partial ceilings; every
shipped-byte freeze must replay it from that exact package, and the separately
required human review remains open. DOC-10 and EDT-09 therefore remain
`PARTIAL`; this work does not by itself satisfy CUT 1.0.

## Executable evidence

The current contract is exercised by:

- `tests/transcript-sidecar.test.ts`
- `tests/transcript-language-surface.test.ts`
- `tests/transcript-language-runtime.test.ts`
- `tests/transcript-picture-contract.test.ts`
- `tests/transcript-picture-language.test.ts`
- `tests/transcript-picture-cli-render.test.ts`
- `tests/transcript-picture-origin-cli.test.ts`
- `tests/transcript-media-authority.test.ts`
- `tests/transcript-edit-algebra.test.ts`
- `tests/transcript-ir-consumer-contract.test.ts`
- `tests/transcript-timeline-edit.test.ts`
- `tests/transcript-lock.test.ts`
- `tests/reference-transcript-captions.test.ts`
- `tests/transcript-cli-workflow.test.ts`

The CLI fixture creates real master/proxy audio, a real locked font and ordinary
CUT source, then runs check, lock, build, inspect, frame, audition, preview and
render. It is engineering evidence, not a professional film or speech-quality
claim.
