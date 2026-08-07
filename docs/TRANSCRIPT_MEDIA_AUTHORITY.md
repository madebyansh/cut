# Transcript media authority and clock transform

Status: normative DOC-10 engineering design, version 1. This document fixes the
implementation and acceptance boundary before product code changes. It does not
claim creative review, human playback, or CUT 1.0 eligibility.

## Purpose

Transcript selection already gives CUT an authenticated word range on one audio
clock. `TranscriptMediaAuthority` extends that abstraction so the selected audio
can be associated with an independently declared video stream without relying on
filenames, co-location, or stream-order guesses.

The authority is compile-time and lock-verified. It lowers to ordinary
`AudioClip` and `PictureClip` semantics; it is not a render component, template,
decoder, or project-specific media shortcut.

## Public source contract

```cut
let sync: TranscriptMediaAuthority = transcriptMedia(
  transcript: words,
  audio: voice,
  audioStream: 0,
  video: camera,
  videoStream: 1,
  videoFrameRate: 30000 / 1001,
  videoDuration: 20s,
  audioAt: 2s,
  videoAt: 1001ms,
  videoRate: 1
);

let quote: TranscriptEdit = transcriptEdit(
  transcript: words,
  source: voice,
  from: "quote.001",
  through: "quote.012",
  at: 3s,
  media: sync
);
```

`transcriptMedia` is the direct initializer of a scene-local `let`. Its
arguments are closed and exact:

- `transcript` is the same locked `cut-transcript` v1 `DataAsset` later used by
  `transcriptEdit`;
- `audio` and `video` are independently declared assets;
- `audioStream` and `videoStream` are absolute, non-negative stream indexes and
  must also be explicit on their respective asset declarations;
- `videoFrameRate` and `videoDuration` are exact author declarations verified
  against the locked selected video stream;
- `audioAt` and `videoAt` are non-negative clock anchors;
- `videoRate` is a positive exact rational number of video-clock seconds per
  audio-clock second.

The exact mapping is:

```text
videoTime = videoAt + (audioTime - audioAt) * videoRate
```

The authority binds the transcript sidecar identity, audio and video resource
identities, both selectors, declared video timing, the rational transform,
scene/composition ownership, provenance, and one canonical semantic identity.
The lock stage re-authenticates the transcript and audio against the sidecar,
then re-authenticates the independently locked video bytes, selected stream,
decoded cadence, duration, and every authority field. CUT verifies an authored
synchronization assertion; it does not claim to infer semantic lip sync.

`transcriptEdit` gains one optional `media` argument. Omission preserves the
existing co-located v1 contract byte-for-byte. When supplied, the authority
must belong to the same scene, transcript, and audio resource as the edit.

`TranscriptPicture` continues to require `source`; under an authority it must
be the authority's exact video resource. It maps the selected audio interval
through the affine clock, selects the smallest complete source-frame cover at
the authenticated source cadence, and lowers to an ordinary `PictureClip`.

For source cadence that differs from the composition cadence, CUT does not
silently snap or invent a retime. The default one-times placement is admitted
only when its derived destination duration lands on the composition frame
grid. Otherwise the author supplies both ordinary `duration` and `rate`, and
the existing exact equation

```text
source duration = destination duration * rate
```

must hold. This same explicit pair is permitted even when the cadences match.

## Ordinary edit algebra

An authority-backed transcript picture carries immutable origin lineage in the
typed picture-edit plan. Its initial source interval, destination interval,
time map, authority, and binding are authenticated once. Generic split and trim
operations slice the ordinary source interval and time map while retaining that
origin. Final materialized nodes receive a deterministic segment identity
derived from the authenticated origin and their exact final source,
destination, and time-map facts.

This slice admits:

- direct placement;
- split/cut and trim through `PictureTrack`'s ordinary operation plan; and
- one exact constant retime through ordinary `PictureClip` duration/rate
  semantics, including a retimed item that is subsequently split or trimmed.

Legacy co-located `TranscriptPicture` remains direct, unmaterialized, and
forward one-times. Transitions remain outside this slice because they require
separate authenticated handle ownership; they must not be implied by this
contract.

No runtime transcript-specific picture operation is added. Decoder choice,
frame mapping, compositing, caching, and publication remain ordinary locked
picture execution.

## Fail-closed requirements

Source checking, strict IR admission, lock replay, or verified-input execution
must deterministically reject:

- missing, foreign-scene, or forged authority values;
- a different transcript or audio resource at `transcriptEdit`;
- an authority video different from `TranscriptPicture source`;
- omitted or inconsistent explicit stream selectors;
- negative, zero, non-canonical, or over-limit stream/rational fields;
- changed transcript, audio, or video bytes;
- locked selector, sample-rate, frame-rate, cadence, or duration disagreement;
- clock anchors off their authenticated sample/frame grids;
- a mapped interval before zero or beyond the selected video duration;
- an implicit cross-cadence retime;
- an inexact explicit duration/rate equation;
- forged origin or segment identities;
- operation replay that changes resource, selector, range, destination, or
  time-map facts outside the generic plan;
- a post-lock verified-input mutation.

Every failure happens before affected media decode or artifact publication.

## Identity, schema, and package propagation

CutAVIR v3 gains optional, non-empty `transcriptMediaAuthorities`. Absence is
canonical and preserves programs that do not use this feature. The local
authority and segment identities bind their complete versioned semantic inputs.
The enclosing builtin-package closure, graph build identity, runtime/cache
identity, and receipts separately bind the shipped compiler/backend
implementation bytes, so a semantic algorithm change still changes package,
build, cache, and evidence identity without pretending the local semantic hash
is itself a module-byte digest.

The source schema, strict semantic loader, compiler, lock verifier, inspect and
semantic-diff surfaces, builtin package manifest, docs, generated CLI bytes,
packed schemas, and clean-consumer verifier must all carry the same contract.

## Scope and status ceiling

The two conformance fixtures are small capability proofs:

- dialogue/podcast: separate recorder audio and camera video, non-zero anchors,
  destination placement, captions, and a trimmed middle quote;
- product/education: separate narration audio and screen video at a different
  rational cadence, explicit constant retime, split, and trim.

They are not polished videos. Automated end-to-end success can move DOC-10 to
an engineering `PARTIAL` or `CLEAN` classification only at the benchmark's
actual implemented scope. Human speech, sync, playback, and creative review
remain separately `UNPERFORMED`; this work does not make CUT 1.0 eligible.
