# Decoded audio source bounds

Status: executable CUT 0.4 alpha contract. This closes selected-stream source
bounds; it does not by itself make the wider audio or 1.0 contract complete.

Every newly locked consumed audio stream carries a
`cut-decoded-audio-samples` v2 witness. CUT addresses the absolute selected
stream index and performs two independent bounded observations over stable,
already-open file descriptors:

1. `ffprobe -show_frames` supplies exact PTS, duration when present, and
   `nb_samples` for every decoded frame. CUT requires strictly increasing PTS
   on one globally phase-quantized sample clock and hashes canonical records.
   A frame normally closes at its cumulative decoded-sample start. A frame may
   instead close at its end only when its exact positive duration converts to
   fewer samples than `nb_samples`; the difference is recorded as real
   decoder-emitted leading discontinuity fill.
2. `ffmpeg -map 0:<absolute-index> -f s16le` supplies an independent decoded
   PCM byte stream. CUT counts whole interleaved sample frames and hashes the
   exact bytes. That count must equal the sum of the frame records.

The witness records the stream index, time base, sample rate, first/last PTS,
frame and duration coverage, decoder-output sample count and PCM SHA-256,
retained source sample count, terminal trim, leading-discontinuity frame/sample
counts, record SHA-256, and quantizer phase. Its authoritative duration is exactly
`decodedSampleCount / sampleRate`. Container duration and Matroska `DURATION`
tags are never authority. A valid raw stream duration is only corroboration and
must be within one codec tick or one sample of the decoded result.

## Priming and padding

Decoder-applied leading skip/discard is already reflected by the emitted frame
samples. CUT never subtracts an independent guessed priming value. Variable-
block Vorbis can emit an interior boundary frame whose `nb_samples` exceeds its
short presentation duration. CUT accepts that frame only when the exact end PTS
lands on the same cumulative sample clock, records the difference, and retains
those actual decoder samples. They fill the immediately preceding discontinuity;
they are not synthetic silence, codec priming, or terminal padding. The first
decoded `firstPts * timeBase` remains the presentation anchor.

If the last
frame has a shorter positive duration, CUT treats that difference as encoded
tail padding only when the frame used ordinary start-clock closure and the codec
time base is no coarser than one sample. A
coarse Matroska millisecond duration cannot trim PCM or FLAC samples. The
invariant is:

```text
decodedSampleCount + terminalTrimSamples == decoderOutputSampleCount
```

This applies a proven tail trim once. AAC-in-MP4 fixtures exercise decoder
priming plus a partial terminal packet; Opus-in-Matroska exercises decoder
skip/discard; PCM and FLAC exercise coarse and missing duration metadata. The
rights-cleared Atlas Vorbis fixture proves 5,437 variable-block frames,
5,443,200 independently decoded samples, 19 exact end-clock boundary frames and
8,512 retained leading-fill samples with no terminal trim. Any
disagreement between frame sample totals and independently decoded PCM fails
closed as `CUTP2017` rather than choosing one silently.

Historical v1 witness **shapes** remain structurally readable and inspectable,
so stale 0.4-alpha lock data receives bounded validation and an actionable
diagnostic rather than an unknown-version failure. That is not executable
compatibility. The repository has neither a persisted genuine v1 witness
fixture nor the frozen v1 record-hash scanner needed to prove native equality.
Current lock creation and native/private rescans emit v2; replay of a v1
witness fails as `CUT_LOCK_VERSION` with instructions to regenerate
`cut.lock`. CUT does not relabel a v2 digest as v1, normalize either witness,
or let v1 claim the variable-block end-clock rule.

## Linked picture/sound presentation offsets

Standalone `AudioAsset` time zero is the first semantic sample delivered by
the selected decoder. An absolute nonzero `firstPts * timeBase` is retained in
the lock and identity, but does not insert container-time silence before an
ordinary `AudioClip`.

A linked `Clip` shares one picture-relative source-time axis. For the selected
master or proxy, CUT derives `delta = firstPts * timeBase - video.start`, audio
coverage `[delta, delta + decodedDuration)`, and its intersection with the
selected picture interval `[sourceStart, sourceStart + Clip.duration)`. Only
that intersection is decoded. CUT subtracts `delta` to obtain decoder-local
source samples, places them at the matching destination samples, and emits
exact leading/trailing silence for uncovered picture time. Wholly disjoint
coverage has a null decoder-input plan and renders the complete Clip duration
from `anullsrc`; no audio decoder is opened for that Clip.

The signed delta must be exact on both source and destination sample grids;
actual destination intersection boundaries and decoder-local source endpoints
must also be exact on their respective grids. Stable source-located
`CUT_MEDIA_PRESENTATION_OFFSET_GRID`, `_METADATA`, and `_LIMIT` diagnostics
refuse unrepresentable or hostile evidence before output/cache publication.
Source ranges remain picture-bounded; incomplete source-audio coverage is
intentional silence. Coverage edges gain no implicit fades. Authored linked
Clip fades run over the complete destination duration.

Master and proxy may rebase both picture and sound by the same absolute amount.
They must preserve the exact relative delta plus decoded picture/audio mapping;
relative drift fails as `CUT_PROXY_TIMING`. Inspect exposes the full plan and
decoder decision, audio cache identity binds it, a generated 44.1-to-48 kHz
fixture proves resampler-end closure, and public overlap `Transition` consumes
the completed child streams. This remains **PARTIAL** overall: independent
picture/audio range authoring, linked retime offsets, broader codecs and
cross-platform decoded-buffer conformance remain open.

## Identity, proxies, and execution

The complete witness enters locked IR, inspect output, graph/cache identity and
private verified-input rescan. A forged but syntactically valid digest is
therefore detected against fresh native evidence before execution. Audio proxy
equivalence additionally requires a bounded pairwise content/timeline witness;
see [PROXIES.md](PROXIES.md). Codec time bases and codec priming PTS may differ.

Current hard bounds are 2,000,000 frame records, 2,147,483,647 sample frames,
64 channels, 16 MiB of ffprobe stdout, 4 KiB per frame record, and five minutes
per native scan. The current descriptor-safe implementation is macOS/Linux;
Windows media input remains explicitly unsupported as `CUTP2015`. Codec or
container combinations whose libav frame accounting disagrees with decoded
PCM are unsupported by design until a narrower proven rule is added.
