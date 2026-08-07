# Proxy media

CUT can bind a project-local preview variant to a video or audio asset while
keeping the master as the canonical final-render source:

```cut
asset picture: VideoAsset = video(
  "media/camera-master.mov",
  proxy: "media/camera-proxy.mp4",
  videoStream: 0,
  audioStream: 1,
  proxyVideoStream: 2,
  proxyAudioStream: 3,
);

asset dialogue: AudioAsset = audio(
  "media/dialogue-master.wav",
  proxy: "media/dialogue-proxy.wav",
  stream: 1,
  proxyStream: 0,
);
```

When master and proxy picture tags differ, a closed author-declared color
interpretation can record both observations independently:

```cut
import { Video, observedVideoColor, interpretVideoColor } from "cut:visual";

asset picture: VideoAsset = video(
  "media/camera-master.mp4",
  proxy: "media/camera-proxy.mp4",
);

const pictureColor = interpretVideoColor(
  profile: "rec709-limited",
  master: observedVideoColor(
    pixelFormat: "yuv420p",
    fieldOrder: "progressive",
    // the four optional color fields were absent from the master probe
  ),
  proxy: observedVideoColor(
    pixelFormat: "yuv420p",
    fieldOrder: "progressive",
    range: "tv",
    matrix: "bt709",
    transfer: "bt709",
    primaries: "bt709",
  ),
);

// Later inside a scene:
// Video(source: picture, inputColorInterpretation: pictureColor);
```

The observations must come from the exact master/proxy probe. Omit a missing
optional property; do not spell absence as `"unknown"`. The interpretation is
author-owned and unverified, and successful locking emits
`CUTW_COLOR_INTERPRETATION_AUTHOR_DECLARED`. See [COLOR.md](COLOR.md) for the
supported profiles, bootstrap procedure and nonclaims.

`proxy` is a closed optional argument on `video` and `audio`. It is not
accepted by image, font or data assets. Unknown arguments and non-string proxy
locators fail during `cut check`; a proxy that names the master itself fails as
a no-op.

`videoStream`/`audioStream` and `stream` select non-negative safe-integer
absolute ffprobe/FFmpeg indexes on the master. `proxyVideoStream`/
`proxyAudioStream` and `proxyStream` independently select the proxy; those
arguments fail without a proxy locator. If a consumed type has multiple
candidate streams, omission fails as `CUT_MEDIA_STREAM_AMBIGUOUS` instead of
following container default disposition. A missing or wrong-type explicit
index fails as `CUT_MEDIA_STREAM_NOT_FOUND`. The selectors remain visible in
typed IR, inspect and semantic diff. Profile execution retains only the active
variant's selector, so a master-only remux does not pollute an unchanged proxy
preview's selected execution identity.

`tests/media-stream-selection.test.ts` contains two unrelated complete public
CUT engineering fixtures. One selects different absolute picture/audio indexes
from a four-stream master and remuxed proxy, locks incidental sound, selects the
proxy profile and verifies the intended decoded pixels. The other is a
standalone `AudioAsset` whose public `stream:` selector produces real decoded
PCM rather than FFmpeg's first audio stream. The suite also covers AudioAsset
and proxy-side ambiguity, wrong-type indexes, hostile IR/JSON Schema shapes,
inspect/diff evidence and master-versus-proxy cache locality. These are
conformance fixtures, not creative reference studies or professional-output
evidence.

## Editorial equivalence

`cut lock` probes and hashes the master and proxy independently. The current
alpha proves exact temporal mapping plus bounded decoded-content
correspondence for both picture and audio proxies:

- selected stream availability is preserved for every stream the asset type
  actually consumes;
- selected picture and audio decoded durations match exactly. Absolute
  container picture starts may differ only when picture and sound are rebased
  together: linked assets must preserve the exact relative
  `audioAnchor - videoAnchor` delta. Selected audio sample count still matches
  exactly even when codec priming PTS differs;
- picture proxies force a full decoded-cadence witness on both variants, even
  for plain untrimmed `Video`; chosen frame rate and decoded frame count match,
  while each codec time base exactly represents its own selected start. A
  pairwise decoded RGB witness must also pass;
- audio sample rate, channel count and channel layout match, both variants
  carry independently rescanned decoded-audio-samples v2 witnesses, and one
  pairwise decoded-content alignment witness passes;
- when a `VideoAsset` is decoded through any explicit managed `inputColor`, locked
  range, matrix/space, transfer and primaries tags match across variants. This
  includes typed `editClip` operands retained in operation history even when a
  later edit removes them from the materialized track.
- when a `VideoAsset` uses `inputColorInterpretation`, source declares an exact
  observation for both variants, each declaration matches the corresponding
  newly locked selected stream including structural absence, both streams are
  supported progressive 8-bit planar YUV, and one closed target profile governs
  both decodes.

A picture-only `Video` consumer selects video and ordinarily omits incidental
audio. An explicit `audioStream` or `proxyAudioStream` makes that audio
selection part of the asset's locked contract even if no current node consumes
it. A linked `Clip` selects both video and audio and therefore requires both variants
to preserve both. An `AudioAsset` selects audio; an incidental video stream in
an audio-only source is not part of its executable contract. Selected audio
always uses the decoded-sample witness. Neither container duration nor Matroska
duration tags are executable authority.

Codec, bitrate and video dimensions may differ. Pixel format may differ only
within the selected consumer's closed decoder contract. Raw color tags may
differ when the asset has no managed consumer, or when every managed consumer
uses an exact `inputColorInterpretation` with independently matching master and
proxy observations. Strict `inputColor` still requires exact target metadata
on both variants. Mixing strict and interpreted declarations on one consumer
fails instead of silently changing the look.
Codec time bases may differ. Picture clocks must still represent their exact
frame grid; audio equivalence instead uses the independently decoded sample
count plus content alignment. The current bounded v2 corpus rejects its
calibrated shifted, dropped, reordered, different-content, masked-component and
channel-swap fixtures. Missing linked audio, changed channel layout or a
non-representable clock also fails with a stable `CUT_PROXY_*` diagnostic at the
asset declaration. This is a concrete policy boundary, not proof that every
perceptually different pair in existence will be rejected.

Picture proxies additionally require the decoded RGB correspondence witness
below. Cadence equality cannot admit unrelated imagery: same-cadence red/blue,
one-frame corruption and coded-frame aspect drift fail lock. The witness is
still a bounded fixed policy rather than perceptual or subjective-quality
proof, so complete playback review remains required and the release contract
stays PARTIAL.

### Decoded picture alignment contract

Lossy/rescaled video does not reproduce equal pixels, so CUT does not require
equal frame hashes. Each selected frame is decoded through an already-open
descriptor, fit without cropping into a 32×32 raster, padded black, normalized
to `rgb24`, and compared at the same decoded-frame index. The closed v1 policy
stores integer parts-per-million metrics:

- mean absolute RGB error over the complete stream may not exceed 100,000 ppm;
- no frame may exceed 180,000 ppm mean absolute RGB error; and
- zero failed frames are allowed, so one corrupted frame cannot hide in the
  aggregate.

The witness binds both file hashes, selected stream indexes, source dimensions,
decoded frame counts, cadence-record hashes, analysis RGB hashes, fixed
geometry/policy, metrics, decision and canonical integrity. Coded-frame aspect
ratio must match exactly before comparison. Full apply and private verified
snapshots recompute the witness, so an internally consistent forged record is
not native execution authority.

Analysis is bounded to 64 MiB of RGB per variant and five minutes per native
process. At 32×32 this covers five minutes at 60 fps within the byte ceiling.
This is a calibrated correspondence test, not a color-managed perceptual
metric, codec-quality score or human playback review. Sample-aspect-ratio
metadata is not modeled. The descriptor-safe witness scanner is macOS/Linux
only; Windows fails closed as `CUTP2015`.

### Decoded audio alignment contract

Lossy codecs do not reproduce equal PCM bytes, so CUT never compares master and
proxy PCM hashes for equality. Instead `cut lock` independently resamples each
already descriptor-bound selected stream to interleaved signed 16-bit PCM at
16 kHz, trims to its proven decoded sample count, and compares corresponding
100 ms windows per channel. Current v2 also evaluates a gain-normalized
residual for every active 100 ms channel-window, then compares globally
gain-normalized energy in overlapping 20 ms windows with a 10 ms hop. The v2
policy is closed and stored in `cut.lock`:

- at least 0.970 normalized correlation over every complete channel and 0.900
  in every evaluated 100 ms channel-window;
- no evaluated 100 ms window may retain more than 20,000 ppm (2%, about
  -17 dB) unexplained power after the best positive per-window gain fit;
- every evaluated overlapping 20 ms envelope window must retain between
  850,000 and 1,250,000 ppm of the master's power after one global per-channel
  gain fit;
- no failed, silence-mismatched, or greater-than-4x energy-ratio window;
- RMS at or below 128 is silence, RMS at or above 256 is active; and
- equal all-silent timelines pass intentionally when all structural and timing
  requirements also match.

The multiscale v2 gate was calibrated against the checked-in same-source
PCM/FLAC/AAC/Opus fixture set. In that bounded corpus, the worst 100 ms
gain-normalized residual is 10,782 ppm (AAC), while the deliberately omitted
-12 dB component is 58,821 ppm and a five-millisecond dropout is 55,127 ppm.
Those two concrete v1 false equivalences are v2 regression fixtures. Historical
v1 records remain structurally readable under their exact original
correlation-only policy for inspection and migration. They do not authorize
native replay: current apply/private execution rescans with v2 and requires a
fresh lock rather than pretending the two algorithms emitted equal evidence.
New locks always emit v2.

The witness stores both locked file hashes, absolute selected stream indexes,
source sample rates/counts, separate analysis-PCM hashes, exact analysis
geometry, policy, per-channel/global/window residual and envelope metrics,
decision, and canonical integrity. Lock application recomputes the current v2
witness from source files; every render recomputes it again from private
snapshots before decoding. A forged internally consistent record therefore
cannot become execution authority.

The scan is deterministic and bounded to 64 MiB of analysis PCM **per variant**
and five minutes per native process. Its frequency coverage is explicitly DC
through 8 kHz. It proves only the measured v2 invariants at the declared
thresholds. It does not prove content that exists only above 8 kHz, transparent
codec quality, arbitrary adversarial perceptual equivalence, phase behavior
outside the downsampled observation, or subjective listening quality. Broader
speech, music, ambience, codec and long-form calibration remains required
before this row can become a 1.0 PASS. Human monitoring is still required for a
professional proxy. Unsupported codec/container frame accounting fails closed.
The descriptor-safe implementation remains macOS/Linux only; Windows fails as
`CUTP2015` rather than reopening a caller-controlled pathname.

Decoded audio priming/padding rules and fail-closed format boundaries are in
`docs/DECODED_AUDIO_SAMPLES.md`.

Both variants appear in `cut.lock` with their own locator, byte count, SHA-256
and bounded probe. Lock application and every render re-check both variants;
deleting or changing either file makes the lock stale even if that variant was
not selected for the requested output.

## Preview and final selection

The installed CLI has one deterministic policy:

```sh
cut preview main.cut --lock cut.lock --output preview --out output/preview.mp4 --json
cut preview main.cut --lock cut.lock --output preview --range 2s:5s \
  --width 640 --out review/range.mp4 --json
cut render main.cut --lock cut.lock --output release --out output/release.mp4 --json
```

- `cut preview` requests proxies for every video/audio resource.
- `cut render` selects masters for every video/audio resource.
- a resource without a proxy explicitly falls back to its master for preview.

`TranscriptPicture` uses the same locked proxy authority as every other direct
picture consumer. `cut check` accepts an authored `proxy:` so that `cut lock`
can prove it. Lock creation descriptor-safely decodes every selected frame of
both variants to a fixed 32×32 `rgb24` fit-and-pad analysis raster, binds the
file, stream, coded-frame aspect ratio, cadence-record identity and analysis
hashes, and applies fixed aggregate and worst-frame integer error limits.
Unrelated same-cadence imagery and a one-frame corruption fail source-located
`CUT_PROXY_VIDEO_ALIGNMENT`. Full lock replay and the private verified-input
session recompute the witness before preview selects the proxy.

This bounded witness proves correspondence under the current policy, not
transparent encoding or subjective preview quality. It is capped at 64 MiB of
analysis RGB per variant and does not model sample-aspect-ratio metadata.

### Executable coverage

The public proxy tests exercise source, lock, typed IR, preview/render,
manifest, cache, authenticated video alignment and master fallback. They prove
the bounded selection contract, not subjective proxy quality, colorimetric
correctness across displays or creative quality.

Supplying `--range` and/or `--width` keeps the same selection policy but uses
the bounded preview executor. It snapshots and verifies every locked variant,
then evaluates only the selected global frames and exact corresponding audio
samples against proxy paths. The adjacent manifest reports proxy/fallback
evidence, exact half-open frame/sample indices and the deterministic resize
contract. It is not a post-trim of a full preview.

The render manifest reports the requested profile, selected variant, fallback
flag, project-relative locator and locked SHA-256 for each media resource. There
is no filename convention, hidden relink table or project-specific selection.

## Generate one picture proxy

The public CLI can generate one bounded picture-only H.264 proxy from a
project-local video:

```sh
cut proxy media/camera-master.mov \
  --project . \
  --out media/proxies/camera-640.mp4 \
  --width 640 \
  --json
```

The command:

- accepts one zero-origin, constant-rate video stream no longer than five
  minutes; `--stream` is required when the input contains multiple video
  streams;
- preserves the exact coded aspect ratio, decoded frame count, nominal frame
  rate and semantic duration;
- uses a fixed H.264/yuv420p, no-B-frame, exact-aspect Lanczos policy;
- strips audio, chapters and metadata because this command produces only a
  picture proxy;
- refuses upscaling, non-integral/even output geometry, output collisions,
  source/output aliasing and non-project paths;
- enforces a fixed 2 GiB staged-output ceiling before publication, refuses an
  encode that reaches that ceiling, and removes the unpublished staging tree;
- scans every decoded master/proxy frame through CUT's bounded 32×32 RGB
  correspondence law before publishing. The analysis retains at most 64 MiB
  per variant, which bounds this alpha path to 21,845 decoded frames at
  3,072 RGB bytes per frame; and
- emits source/proxy hashes, dimensions, frame counts, correspondence metrics,
  bound FFmpeg and ffprobe executable/banner identities, and the exact
  `proxy:` argument to author.

Generation never mutates CUT source. The bytes remain inert until source names
them explicitly:

```cut
asset camera: VideoAsset = video(
  "media/camera-master.mov",
  proxy: "media/proxies/camera-640.mp4",
);
```

Run `cut check`, regenerate `cut.lock`, and run `cut preview`. Lock creation
independently repeats the authoritative temporal and decoded-content
equivalence checks; the generation report does not bypass or replace the lock.
The fixed generator currently covers picture-only proxies. A linked
picture-plus-sound asset or standalone `AudioAsset` needs an independently
authored and lock-verified audio proxy.

The generator validates a real, project-contained, non-symlink output parent
and publishes with a same-filesystem no-clobber hard link. As with the rest of
the local alpha CLI, pathname operations are not a sandbox against a hostile
peer concurrently renaming or replacing a parent directory between operating
system calls. Generate proxies only inside a trusted workspace.

CUT 0.4 has no stable public JavaScript runtime API or supported package export
for selecting media profiles. Inside the implementation, `mediaProfile:
"proxy"` selects proxies and omission selects masters; any other value fails as
`CUT_PROXY_PROFILE`. Those deep render/review entry points accept only the same
in-process IR actually produced by applying the external `cut.lock`; a
serialized, cloned or caller-constructed CutAVIR does not inherit execution
authority. A caller-supplied `lockSha256` option is manifest evidence, not
authorization by itself. The supported CLI guarantees that it is the digest of
the exact external lock bytes it verified. Low-level raw-IR, render, cache and
renderer modules are non-authoritative internal surfaces and must not be used to
weaken this source-plus-lock boundary.

## Cache identity

The canonical locked IR retains both variants for audit and replay. In the
supported verified-session flow, CUT derives an invocation-local
profile-specific execution projection containing only the selected variant.
Its selected locator, hash, probe and variant enter picture and audio cache
identity. For selected audio proxies, the algorithm/policy, analysis geometry,
selected proxy file/stream/sample identity and proxy analysis hash enter cache
identity; pairwise master metrics remain in canonical lock/build/inspect and
native/private rechecks. This preserves preview cache locality after a
master-only revision that freshly proves the unchanged proxy equivalent.
Selected picture proxies use the same projection rule: fixed analysis
geometry/policy plus selected proxy file/stream/cadence/RGB identities enter
picture cache identity, while pairwise master metrics stay in the canonical
authority. Picture-only alignment evidence is omitted from audio cache
identity. For an interpreted video consumer, the selected exact
observation and closed target profile also enter picture identity; the
unselected observation does not. Consequently:

- changing only proxy bytes invalidates proxy previews but not final renders;
- changing only master bytes invalidates final renders but not proxy previews;
- switching profiles cannot reuse decoded/composited media from the other
  profile under the same key;
- a preview fallback may reuse the master artifact because the chosen locked
  bytes are genuinely identical;
- changing only an authored/locked proxy color observation invalidates proxy
  picture artifacts without invalidating the selected-master picture path, and
  the converse holds; and
- picture interpretation does not invalidate or alter linked source-audio
  samples.

## Current boundary

This 0.4 alpha slice supports one proxy per `VideoAsset` or `AudioAsset` and a
bounded one-video-at-a-time picture proxy generator. It does not auto-edit
source, generate audio proxies, bulk-generate/relink a project, generate
image-sequence proxies, or manage multicam proxy sets. The explicit long-form
targets and current failed baseline are in
[PREVIEW_PERFORMANCE.md](PREVIEW_PERFORMANCE.md). Final renders never select
proxies implicitly.
