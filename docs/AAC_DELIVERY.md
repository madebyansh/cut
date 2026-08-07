# Reference AAC delivery guard

The reference renderer normalizes one PCM master before AAC encoding. AAC can
create decoded intersample overshoot, so neither the source sample peak nor a
measurement of the PCM master proves the delivered file.

At the supported 48 kHz mastering rate, public `Meter.truePeak` now reaches a
second, CUT-owned delivery gate. Before publication CUT copies the authored
picture and normalized PCM into mode-0600 files inside one mode-0700 stage.
Every probe, decode, meter and encoder pass consumes those private snapshots,
so an authored path cannot change between evidence and encoding. CUT then
inspects every private AAC candidate:

1. The normalized master must contain exactly one stereo audio stream. An AAC
   candidate must contain exactly one video and one stereo audio stream, no
   extras; both streams start at zero and end on the same exact authored 48 kHz
   sample boundary.
2. The owned AAC encoder must expose one 1,024-sample priming packet with
   matching `Skip Samples` metadata. FFmpeg removes that priming on decode.
3. CUT decodes without resampling to bounded stereo `f32le`, derives the exact
   decoded frame count from the regular file size and reports the final partial
   codec-frame padding.
4. Only the authored `expectedFrames * 8` bytes enter CUT's versioned
   BS.1770-5 scanner. Priming and trailing padding cannot enter the peak claim.

CUT's scanner is the primary gate. FFmpeg loudnorm remains a separately named
cross-check and LUFS/LRA authority, but receives an exact
`atrim=end_sample=expectedFrames` boundary too. A candidate is accepted only
when the CUT scan passes and FFmpeg's true-peak value also passes whenever
FFmpeg supplies a finite value. Retry gain uses the larger available violation,
so a disagreement cannot weaken the ceiling and AAC padding cannot be measured
as programme audio by either authority.

The guard is bounded:

- codec: FFmpeg `aac` at 256 kb/s in MP4;
- MP4 movie timescale: the authored 48 kHz sample clock, not a millisecond
  approximation;
- maximum attempts: 3;
- every attempt starts from the same normalized PCM master;
- maximum cumulative delivery reduction: 6 dB;
- correction safety margin: 0.05 dB beyond the last measured violation;
- the scanner has its own exact `2^32` FIR multiply-add ceiling (about 15.5
  minutes at 48 kHz); longer single-pass scans remain an explicit alpha
  limitation pending a proven native/WASM streaming implementation.

If those bounds cannot produce a compliant candidate, rendering fails before
the target MP4, stems or final manifest are published. Delivery never adds gain
to chase LUFS after a true-peak correction.

Render-manifest v7 contains `audio.delivery`, a
`cut-reference-aac-delivery` v2 report. It retains normalized-PCM evidence and,
for every attempt, the encoded-file SHA-256, exact authored decoded-PCM SHA-256,
exact decode framing, the complete CUT true-peak scan, separately named CUT and
FFmpeg residuals/compliance, gain and loudness residual. One closed, integrity-
checked audio toolchain identity names the CUT runtime, platform, architecture,
Node executable identity and the SHA-256 of bounded `ffmpeg -version` output;
that identity applies to the normalized master and every attempt. Tests prove that 1,
100, 1,000, 1,600 and 2,000 authored samples retain exact stream durations. A
12,000-frame fixture proves that the decoded AAC has 12,288 frames, reports 288
padding frames, and both authorities inspect exactly the 12,000 authored
frames.

The candidate hash is rechecked after CUT decoding and again after loudnorm.
The accepted bytes are copied to a new private inode that no media subprocess
receives; exact identity is rechecked after the render's final color probe and
immediately before publication. A changed candidate fails
`CUT_AUDIO_DELIVERY_STRUCTURE` with reason `candidate-changed` and publishes
nothing.

The canonical renderer prepares the accepted candidate in a mode-0700
same-filesystem child directory, then promotes that verified artifact through
the same rollback-safe transaction as stems and manifests. Standalone delivery
replaces a destination leaf without following a symlink target. It freezes the
physical output parent and revalidates the lexical-to-physical mapping before
commit, so a changed symlink ancestor cannot redirect the verified file.
Preparation failures remove private staging and publish nothing.

Exact silence is a CUT-proven zero linear true peak even when LUFS is
unmeasurable; the report uses `loudness-unmeasurable`, not an unproven peak
status.

This is still a bounded reference path, not a universal broadcaster claim.
Rates other than 48 kHz fail before backend work with
`CUT_AUDIO_TRUE_PEAK_SAMPLE_RATE_UNSUPPORTED`. EBU Tech 3341 signals 20-23,
cross-platform decoded-buffer conformance and production listening evidence
remain open. The surrounding render manifest records the selected audio/backend
toolchain identity, and delivery-report v2 carries the same audio toolchain as a
first-class field alongside exact candidate bytes. AAC bytes are still not
claimed byte-identical across different FFmpeg identities.
