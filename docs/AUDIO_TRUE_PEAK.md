# CUT-owned true-peak scanner

The reference runtime contains a bounded, streaming true-peak measurement
kernel for exact interleaved stereo `f32le` at **48 kHz**. It implements the
48-coefficient, four-phase interpolating FIR published in ITU-R BS.1770-5
Annex 2. CUT performs the floating-point multiply/add sequence itself; FFmpeg is
not part of this measurement kernel.

The versioned algorithm identity also fixes behavior left implicit by the
coefficient table:

- input is exactly stereo 48 kHz `f32le` with an authored frame boundary;
- missing history and the finite tail are zero-extended;
- all 11 remaining input-frame delays are flushed at end of file;
- sample peak is a conservative floor for the finite four-times FIR estimate;
- equal peaks retain the first oversampled position and then the left channel;
- intersample positions are reported exactly as an integer numerator over eight
  source frames after compensating the 23.5-sample oversampled group delay;
- the complete coefficient JSON has fingerprint
  `sha256:2140fb1d2d303b567fb5786df874cc18a23390c163f6310f96ae54a9c75588a6`;
- a scan has a separate `2^32` FIR multiply-add ceiling, in addition to byte and
  chunk limits.

Measurement and policy are separate. `scanReferenceStereoF32LeTruePeak`
returns a complete measurement even when it is above digital full scale.
`assertReferenceAudioTruePeak` applies an authored dBTP ceiling to that result.
Silence has zero linear peak and a `null` dBTP representation and passes every
finite supported ceiling; it is not an unmeasurable true peak.

The owned file helper validates its contract before opening, uses no-follow
semantics, accepts only regular files, owns and closes its file handle, and
normalizes stream/I/O failures into bounded source-located diagnostics. Exact
byte-boundary and non-finite errors take precedence over a peak assertion.

## Evidence and limits

`tests/reference-audio-true-peak.test.ts` includes:

- a full coefficient fingerprint;
- an independent direct 48-tap convolution oracle;
- arbitrary byte-chunk replay;
- generated EBU Tech 3341 minimum-requirement signals 15 through 19 with their
  published `+0.2/-0.4 dBTP` tolerances;
- start and flushed-tail peaks, exact negative eighth-frame locations, equality
  and stereo tie behavior;
- hostile iterables, runtime types, exact-boundary precedence, no-follow file
  handling and explicit FIR work refusal.

This is now executable delivery evidence, but not a completed mastering claim. EBU
signals 20 through 23 have not been added because CUT does not yet carry a
reviewed redistributable copy or an independently validated generator for that
material. Rates other than 48 kHz fail with
`CUT_AUDIO_TRUE_PEAK_SAMPLE_RATE_UNSUPPORTED`; CUT does not silently reuse the
four-phase result as a portable lower-rate conformance claim. Render-manifest
v6 now retains scans of the private normalized PCM and every decoded AAC
candidate, with exact priming/trailing-padding evidence and a conservative,
separately named FFmpeg cross-check. Cross-platform decoded-buffer conformance
and production listening evidence also remain absent. Therefore `AUD-06`
remains **PARTIAL**.
