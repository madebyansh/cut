# Audio artifact cache

Status: executable bounded alpha slice. This is not a claim that CUT caches its
complete mastering, stem, analysis, or delivery pipeline.

## Boundary

The reference renderer materializes one content-addressed artifact for the
composition's exact **pre-master stereo float mix**. The artifact is a headerless
interleaved stereo IEEE-754 `f32le` stream at the authored composition sample
rate. It contains exactly `duration * sampleRate` frames and eight bytes per
frame. CUT keeps this internal float-domain boundary so an otherwise
recoverable downstream gain or limiter is not preceded by hidden PCM24
saturation.

The cache boundary is deliberately before loudness normalization and AAC
delivery. Every render still derives and executes the current Meter target,
normalizes/measures the mix, verifies delivery, and encodes the requested
output. Stem export also remains a separate deterministic render path. A Meter
loudness or sample-peak target and a Bus/stem name/role therefore do not
invalidate PCM that they cannot change; the affected downstream assertion or
stage still reruns. Bus name and optional
closed role still participate in semantic/build/stem-manifest identity.

Artifacts live beneath
`.cut/cache/reference/audio/<key>/mix.f32le`. Source never names or manages this
path. CUT publishes the raw artifact and its internal manifest through atomic
sibling-file replacements inside the project write boundary.

## Key contract

The key is SHA-256 over a versioned cache contract containing:

- the ordered master audio roots and recursively projected executable audio
  graph, excluding compiler-assigned node IDs and source locations;
- exact node intervals and scene starts used for sample placement;
- actual signal content hashes for reachable automated properties;
- locked reachable resource bytes, locator, kind, state, and exact probe/stream
  selection metadata;
- relevant package versions/integrity hashes;
- exact composition duration, sample rate, channel count and sample format;
- CUT reference-runtime identity; and
- platform, architecture, Node version, and a digest of the complete bounded
  `ffmpeg -version` identity.

When a reachable graph contains `Limiter`, the key additionally includes the
CUT limiter processor identity, the static-compatibility policy identity, and a
fresh closed identity for the exact resolved FFmpeg compatibility executable:
its direct-file byte count/SHA-256, normalized version line, and complete
bounded version-banner SHA-256. A toolchain change during a render fails before
publication instead of storing samples under the earlier key.

Limiter core evidence also records whether execution used the unchanged
bounded in-memory core or the five-minute fixed-chunk private-file adapter. The
latter records its exact 65,536-frame chunk size. This path-free closed evidence
is revalidated on cache hits; the chunk-capable v3 processor identity prevents
an artifact made under the earlier 77.67-second-only implementation from being
authorized as current.

The graph projection follows child and explicit node-reference edges, including
sidechains and Send/Return routing. Picture-only nodes and picture-only controls
on linked clips/transitions are absent from the PCM identity. Consequently an
unrelated picture insertion may renumber IR nodes without invalidating sound,
while switching an otherwise identical two-Clip linked split from JCut to LCut
changes the exact hard audio boundary and therefore invalidates PCM. Source
bytes, selected streams, automation, routing, timing, processor
parameters, sample rate, package implementation, runtime, or FFmpeg identity do
invalidate it.

The key is an identity for executed PCM, not an authorization shortcut.
Before executable graph projection, key construction, filesystem allocation,
or a warm lookup, CUT independently replays and correlates every canonical
`TimelineEdit` materialization as well as the older linked-edit and processed
region authorities. Two valid edit histories may converge on the same PCM key;
a forged or stale history cannot inherit the cached result.

The current `Meter(samplePeak:)` ceiling is intentionally absent from this key:
it is an assertion over the cached pre-master samples, not an operation that
changes those samples. CUT freshly scans the exact bytes against the current
ceiling on every hit and miss. Reusing samples rendered under `0dbfs` can therefore
fail with `CUT_AUDIO_CLIPPING` under a later `-3dbfs` target without rebuilding
or mutating the artifact.

## Reuse and corruption

CUT never treats a matching key or prior build ID as proof that cached bytes are
usable. Before every hit it:

1. refuses non-regular artifact/manifest entries;
2. validates the closed cache manifest against the current graph and toolchain;
3. compares exact file length (`frames * 8`) and SHA-256; and
4. performs a bounded streaming scan that verifies complete stereo float32
   frames, exact frame count, finite samples and the invocation's sample-peak
   ceiling.

The closed manifest also retains every recursively prepared limiter execution:
CUT-owned core algorithm/ceiling/gain/peak evidence and either the exact
static two-authority reports or an explicit dynamic-ceiling not-applicable
record. Evidence has integrity hashes and contains no source paths, node IDs,
provenance or sample arrays. A missing, unknown, malformed, re-signed or
toolchain-mismatched limiter record cannot authorize a hit.

Missing, malformed, hash-mismatched, truncated, or wrong-format entries are not
reused. CUT safely renders a replacement and reports why the attempted reuse was
a miss. A hash-valid artifact that violates the current peak ceiling is not
corruption: CUT refuses it with the source-located `CUT_AUDIO_CLIPPING`
diagnostic. On a cache miss, this scan runs before publication, so clipping,
non-finite samples or an exact-length failure publishes no artifact, manifest or
advisory index.

## Bounded range-preview reuse

A bounded `cut preview --range ...` may reuse this full-program pre-master only
as an opportunistic exact hit. The preview cache probe is read-only: it never
renders a complete programme or creates, repairs, replaces, or indexes this
cache on a miss. Cold, invalidated, absent, malformed, linked, corrupt, or
current-peak-incompatible entries retain the ordinary selected-execution path.

An exact hit is reopened with no-follow semantics. CUT binds the manifest and
artifact paths to their open handles and inode metadata, validates the current
closed manifest, streams the complete artifact through a fresh exact-f32le and
sample-peak scan, compares its complete SHA-256 and byte length, and revalidates
path/handle identity after the read. During that same bounded pass it copies
only bytes `[startSample * 8, endSampleExclusive * 8)` into private preview
staging, hashes that exact slice, and never exposes the cache file itself as a
delivery input.

The range-preview manifest is `cut-reference-range-preview` version `4` and
binds the exact combined FFmpeg/ffprobe picture-toolchain identity.
`execution.audioSource.mode` is either `full-program-cache-slice`, with the
complete current cache-hit evidence and exact half-open slice bytes/hash, or
`selected-execution`, with the failed probe reason plus the independently
executed selected artifact's interval, bytes, and SHA-256. Loudness
normalization, AAC preparation/verification, and mux publication are unchanged
and execute after either source. This warm reuse avoids repeating an already
proved whole-program limiter/effect graph; it is not a cold-render optimization
or independent CCH-05 performance pass.

On a cache hit, cached root/filter counts are reported only as
`authorizedCachedBuild`; they are not current-invocation execution counters.
The manifest explicitly records
`audioState: full-program-cache-authority-no-graph-execution`. On a miss, the
selected path instead reports its own root/filter execution beneath
`audioSource.execution` and
`audioState: causal-history-executed-from-zero`. The top-level execution object
does not merge those unlike facts.

## Machine evidence

The adjacent render manifest exposes `cache.audio` with format
`cut-reference-audio-cache-evidence`, version `3`. It reports:

- `status`: `hit` or `miss`;
- one stable `CUT_AUDIO_CACHE_*` reason code;
- the current key and advisory previous key when present;
- project-relative artifact locator, artifact SHA-256, byte/sample contract and
  verification method;
- a fresh immutable `peak` record containing the applied dBFS/linear ceiling,
  measured peak, exact bytes/frames and deterministic sample location; and
- graph counts/digests plus the complete bounded audio toolchain identity; and
- closed `limiter` build evidence, including the exact count of prepared
  semantic executions and each static/dynamic compatibility disposition.

Stable reason codes are `CUT_AUDIO_CACHE_HIT`, `CUT_AUDIO_CACHE_COLD`,
`CUT_AUDIO_CACHE_KEY_CHANGED`, `CUT_AUDIO_CACHE_ARTIFACT_MISSING`,
`CUT_AUDIO_CACHE_MANIFEST_INVALID`, `CUT_AUDIO_CACHE_ARTIFACT_CORRUPT`, and
`CUT_AUDIO_CACHE_ARTIFACT_CONTRACT`.

`cache.hits`, `cache.misses`, and `cache.scenes` retain their existing picture
scene meaning. Consumers must read `cache.audio.status` for the independent
audio result rather than adding unlike stages together.

## Executable evidence and limits

`tests/reference-audio-cache.test.ts` proves:

- stable keys and exact float samples across picture color changes and unrelated picture
  insertions that renumber audio IR nodes;
- distinct keys and decoded samples across JCut/LCut because their exact hard audio
  boundaries differ, alongside distinct audiovisual build/scene identity;
- exact-length all-zero stereo f32le creation and verified reuse for an intentional-
  silence timeline with no audio roots;
- misses and changed exact samples for dynamic automation edits;
- misses and changed exact samples when locked source bytes change;
- sample-rate and audio-toolchain invalidation;
- byte corruption detection followed by deterministic reconstruction;
- threshold-independent keys with a fresh scan on every hit, including stricter
  threshold refusal without artifact mutation;
- clipping-miss refusal before any artifact, manifest or index publication;
- rejection of stale version-1 PCM24 WAVE cache entries; and
- persisted render-manifest hit/miss/key/hash/identity evidence.

`tests/reference-audio-limiter-cache.test.ts` separately proves nested and
TimeStretch-recursive limiter accumulation, exact cold/warm evidence reuse,
picture-only renumbering locality, and rebuild after persisted evidence
corruption.

This slice does not yet cache individual processors, subgraphs, stems,
normalization passes, analysis results, AAC outputs, or cross-format deliveries.
It has same-host evidence only. Cross-platform decoded-buffer conformance,
bounded eviction/garbage collection, concurrent-process stress, long-form
performance benchmarks and mastering/output-local cache layers remain required
before the broader CUT 1.0 cache contract can pass.
