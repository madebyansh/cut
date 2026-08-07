# Reference runtime identity

CUT separates source/graph identity from the identity of the installation that
executes a render.

## Package implementation identity

Every built-in package implementation fingerprint covers its generated
transitive local execution closure and the installed versions of this closed
runtime dependency set:

- `d3-geo`
- `opentype.js`
- `sharp`
- `topojson-client`
- `world-atlas`

The dependency versions are resolved from the packages installed beside CUT,
not copied from a declaration string. Missing, duplicate, additional, invalid,
or unresolvable entries fail package initialization. `npm-shrinkwrap.json`
provides the package-payload integrity boundary; this identity discloses and
hashes the installed versions that the implementation will execute.

This historical global tuple deliberately remains those five packages.
Opt-in complex `FlowText` instead carries a separate feature-scoped authority
for the exact HarfBuzz package/entry/glue/WASM bytes, the exact bidi runtime
bytes, and its fallback/wrap/selector/normalization/no-host-fallback policies.
That authority exists only for shaped graphs and propagates through IR, lock,
graph/cache, runtime revalidation, inspect and shaped frame/contact/render
evidence. Shaping omission omits it. See [FlowText](FLOW_TEXT.md) and the
current-alpha migration boundary in [MIGRATION.md](MIGRATION.md).

The build-time generator starts from one declared root set per built-in package
and follows local TypeScript value imports, value re-exports, side-effect
imports, literal dynamic imports, and the one closed `createRequire` policy.
Type-only edges do not enter execution identity. Missing, ambiguous, computed,
escaping, or untracked edges fail generation. The strictly sorted committed
closure is checked before compilation and copied byte-for-byte beside the
packed JavaScript implementation.

At runtime CUT validates the committed closure and hashes each member as bounded
stable bytes without importing it. Identities contain canonical lib-root-relative
module IDs, sizes, hashes, dependency identity and source-versus-packed
environment—not absolute install paths. Missing files, links, path escapes,
changed reads, invalid UTF-8 closure JSON, unknown overrides, stale generated
data and excessive files/bytes fail closed. The compiler path therefore does
not initialize Sharp's native addon; lock and render paths load the native
backend separately.

The generated closures include graph construction, validation, package/compiler
acceptance, no-op enforcement, automation/DSP, source preparation, routing,
editorial semantics and canonical hashing wherever each package reaches them.
Mutation-sensitive tests cover every package and formerly omitted transitive
modules such as `runtime/reference/noop-contract`, as well as audio resource,
ParametricEQ and `core/stable` dependencies. Package manifests consume this
identity directly; there is no parallel handwritten implementation-file list.

## Lock and render identity

`cut lock` records a closed `cut-reference-backend` identity containing:

- the reference runtime version;
- the canonical dependency identity;
- operating-system platform and architecture;
- Node's native-module ABI;
- Sharp's loaded runtime version; and
- the loaded libvips version.

Lock validation recomputes both nested integrity hashes. Commands that do not
execute media collect the current backend during full lock application and
require an exact complete-identity match. The media-executing `frame`,
`contact`, `audition`, `preview`, and `render` paths deliberately defer this
collection: they first apply the closed semantic lock contract, snapshot and
probe every master/proxy input, recheck those private bytes, and only then
collect and compare the complete canonical backend identity. The comparison is
over the full canonical value, not only its integrity field, and happens before
any picture/audio execution. If Sharp/native identity cannot be determined or
the identity differs, the private inputs are removed and no review/render
artifact is published.

The supported CLI execution path recompiles canonical public `.cut` source and
applies the separately supplied `cut.lock` in-process. The verified input
session requires that unchanged invocation-local applied result. A `.cutir.json`
file, including the usual `graph.cutir.json`, remains useful build, inspect and
semantic-diff evidence, but serializing, cloning, reordering or reloading it does not
carry trusted media-execution authority into a later call. Recomputed visible
graph hashes are not a substitute for the in-process lock application.

Reference scene-cache keys include the complete backend integrity and the
closed `cut-reference-scene-encoding` v2 policy. At render time CUT additionally
resolves FFmpeg without following a substituted leaf. It reuses the closed
`cut-reference-audio-limiter-compatibility-toolchain` v1 identity: policy ID,
first banner line, normalized-banner SHA-256, executable SHA-256/size and the
canonical integrity hash. No absolute executable path enters the public cache
manifest. The internal binding retains that path and its file identity so a new
scene is encoded by the same executable and re-verified after encoder close,
before that scene artifact is published.

Bounded `cut preview` picture ranges use a distinct content-addressed cache.
The key projects the current typed graph through picture roots and binds the
ordered selected scene keys, exact frame interval, source/review canvases,
rational FPS, color and Lanczos law, scene-encoding contract, CUT runtime,
complete reference-backend integrity and the exact FFmpeg toolchain integrity.
The entry is a closed project-relative manifest; the immutable H.264 blob name
is its own SHA-256. Reads reject links, escapes, size/hash disagreement and any
decoded frame/timing/dimension/color mismatch. Corruption is quarantined and
rebuilt. Artifact-first and manifest-last hard-link publication never
overwrites a valid concurrent winner and refuses one key producing different
bytes. Audio is deliberately outside this picture artifact and executes
independently, preserving audio-only locality without treating a cached picture
as a final delivery.

### MapCamera invocation preparation

`ReferenceVisualRenderer` prepares each selected MapCamera graph once per
renderer invocation. A module-private WeakMap authority binds the preparation
to the exact in-memory IR and composition; copied, spread, foreign-IR or
foreign-composition receipts cannot execute. Preparation validates every
bounded signal entry over all exact output-frame samples and reads, hashes,
decodes and converts each selected locked `world-atlas` topology once. It also
binds the exact d3-geo/topojson/world-atlas and Sharp/librsvg/libvips identities.

This is an invocation-local verified input snapshot, not a persistent atlas or
pixel cache. Projection, camera state, canonical SVG serialization,
delivery-resolution rasterization, alpha canonicalization, surface hashing and
frame evidence still execute at every requested frame. The public preparation
receipt reports its renderer-only scope, backend identity, atlas byte/hash
evidence, one-time verification counts and zero persistent reads/writes.
Prepared frame receipts honestly report zero repeated dependency/atlas
verifications while isolated one-frame execution retains the original
per-execution verification path.

Shared graph node keys project each referenced locked media resource through
the decode domain that consumes it. A visual video node binds the active
master/proxy marker, locked byte count, selected-video tuple and the matching
canonical video-stream fields; an audio node binds the corresponding audio
selection; an audiovisual source binds both. Audio-backed visual analysis binds
audio because its resource is an `AudioAsset`. Selected duration, exact start,
time base, retained nominal/average frame-rate candidates and the chosen picture
clock are part of the tuple. Container duration and Matroska `DURATION` tags are
never executable stream authority. A plain untrimmed `Video` may use an exact
selected-stream duration; frame-index consumers, looping, missing video duration
and every authored picture proxy instead bind a decoded-cadence v2 witness. The
witness records selected absolute stream index, first/last/end PTS, decoded frame
count, duration-field coverage, a SHA-256 of every bounded frame record, and one
exact global phase-floor quantizer against the chosen nominal/average clock.
Semantic picture duration is exactly `frameCount / chosenFrameRate`. A raw
duration observed beside that witness remains non-authoritative because MOV/MP4
can report first-to-last PTS without the terminal frame period. Public absolute
stream selectors are authored resource identity and semantic diff. A selected
proxy execution projects the proxy's authored selection into the active
resource and removes the inactive master/proxy pair, so an unchanged proxy
keeps its picture/audio cache identity across a master-only selector edit.
Unselected
streams, unknown private metadata and wholly unreferenced resources do not
invalidate those local keys. A selected picture change invalidates the media leaf, every
ordinary or Parallax ancestor and its scene, while an unconsumed audio-selection
change does not invalidate that picture path. Referenced locked media with
incomplete probe, selection, duration authority, active variant or matching-
stream structure is refused as `CUT_GRAPH_RESOURCE` rather than collapsing to
a weaker locator/hash-only cache identity.

### Component and composition-frame LocalSpace identity

The bounded direct scene-root Visual-component owner keeps retained tile and
placement identity separate. Its stable placement context binds the algorithm,
delivery composition dimensions, scene, fragment node and LocalSpace node. It
does not hash the fragment's complete child/media subtree or project-wide build
identity. The exact-frame plan separately binds rational time, sampled
`opacity`/`x`/`y`/`scale`/`rotation`, transform-work admission and the resulting
tile identity.

An owner-control edit therefore preserves LocalSpace tile identity but changes
placement identity. A child, media, or finishing edit changes the tile and
final placement while preserving the stable placement context. Formatting,
comments, unrelated scenes, and audio-only branches retain their normal local
identity behavior. This split is visible in inspect/frame evidence and scene
cache planning; it is not a claim of a separate persistent tile cache.

Component admission builds one graph index per untrusted IR document. Runtime
then hashes one composition-frame affine preflight across every admitted
retained affine owner, each actual delivery or parent-LocalSpace destination,
and every executed MotionBlur shutter-sample placement. Individual admissions
bind owner kind, exact sample time, raw transform and derived work; the aggregate
identity binds their sorted work identities and the shared memory envelope.

Historical admitted integer-phase scale/translation retains transform-work V2
and its Sharp/libvips bytes. Fractional final Q16 placement uses
`cut-reference-local-space-scale-translation-v2`, whose identity binds the
original retained source, exact Q16 destination quad, exact destination clip,
work-admission identity, and observed sampled/canvas work. A zero-rotation
resize that would otherwise exceed the unchanged 512 MiB RGB16-intermediate
ceiling receives
`cut-reference-local-space-destination-clipped-transform-work-v1` (V4) and
uses that same one-pass clipped sampler directly from the retained tile.
Rotation/skew remain on their separately tested paths. These runtime,
planning, projective, backend, and placement identities participate in current
frame evidence and invalidate cached placement output when the algorithm
changes.

That immutable structural index is shared by the root renderer and every
`Precomp`/`NestedSequence` renderer instance. Current exact-frame publication
declares profile `cut-reference-frame-execution/current-v2`, emits the
path-addressed root-first `execution.localSpaceExecutions` array, and adds
`execution.localSpaceExecutionTree`. The closed tree summary binds the exact
renderer-frame count, ordered execution-path digest, ordered
`rendererFrameIdentity` digest, and final `rendererTreeIdentity`.

Live publication additionally requires one module-private `WeakSet`-branded
complete-tree authority minted by the same successful renderer invocation. The
brand is bound by object identity to the exact locked IR, root composition,
complete ordered receipt array, independently retained expected receipts, and
expected tree. A copied or spread object has no brand; a truncated or rebuilt
array is not the issued array. A new successful frame revokes the prior brand,
and closing the renderer revokes the current one.

The root's same-frame evidence generation remains active while every tracked
sibling node-frame promise drains, even when one sibling has already failed.
CUT deactivates and detaches the generation only after that drain, preventing
late evidence writes from crossing into the next frame.

The live ledger and completed-tree pre-scan use the same accounting: one raw
record for every renderer wrapper, tile, embedded
`localCompositing.operations` entry, placement, execution skip, preflight
admission, and preflight skip. A record is additionally charged once per
renderer execution-path segment it crosses. The hard frame limits are 65,536
raw records and 262,144 depth-weighted copy units. Runtime reservation refuses
the first excess record; pre-scan refuses an oversized completed tree before
tree identity hashing or authority deep-copy. Root publication recomputes
these exact totals from the completed receipts and rejects any mismatch with
the live ledger.

With that authority, CUT re-derives from locked IR all counters, tile and
placement identities, transform-work identities, and preflight identity. The
owner-skip comparison is an exact-sample O(n) counted multiset keyed by
LocalSpace node, owner node, skip kind, and canonical rational sample time; it
requires one execution skip per preflight skip and rejects leftovers. False
zero work and forged component-fragment, `Track2D`, or `DepthLayer` ownership
therefore fail before publication.

Persisted current-v1 validation separately closes each receipt and its frame
identity, all counter relations, the count/path/frame/tree identities, and the
historical root aliases. These ordinary hashes establish integrity, not a
signature or persisted authenticity; an external manifest digest or
deterministic locked rerender supplies that boundary. The new profile, tree,
and array remain optional in frame-v2 only for frozen-artifact compatibility.
Current writers emit all three, while `execution.localSpaces` and
`execution.localSpaceTransformPreflight` keep their prior meanings.

The frame admits at most 256 visible affine transforms, 1 GiB live output, and
2 GiB unscheduled peak work. Exact-zero opacity and supported policy hides stay
as explicit per-owner skips but are excluded from aggregate allocation identity
and work. A wholly zero-skew frame preserves the historical V2 tile and
aggregate identities. Nonzero skew produces V3 for the installed scale ->
simultaneous two-axis shear -> rotation path, and mixed V2/V3 entries receive
one V3 aggregate. Projective PlanarTrack/Plane3D work remains outside this
affine identity. The resource receipt does not authorize new graph topology;
ordinary `MotionBlur -> Group -> LocalSpace` and component nesting remain
unsupported.

The cadence scan is a bounded full selected-stream decode: at most 200,000
frames, 16 MiB of stdout, 4 KiB per record and five minutes. Every PTS must be
strictly increasing and every retained duration must be floor/ceil of the one
chosen ideal period. Nominal and average rate candidates are retained from the
raw probe; decoded evidence selects one, permitting only alternative survivors
whose complete `N/rate` durations are equivalent within one codec tick. VFR,
dropped-frame and ambiguous schedules fail `CUTP2014`. Lock application and a
verified-input session rescan the private bytes and compare the complete witness,
including its record digest.

Picture source ranges are stream-relative and must land on the selected ideal
frame grid. The reference decoder maps the locked absolute stream, trims by
decoded `start_frame`/`end_frame`, rebuilds the proven CFR source clock and pins
delivery sampling with an exact rational `fps` filter plus `-fps_mode
passthrough`. No semantic `-ss`/`-t` decimal seek is used. A plain untrimmed
non-proxy `Video` may preserve decoded source PTS before delivery sampling; VFR
is not accepted for frame-index edits or proxy equivalence.

Every newly locked consumed audio selection binds a decoded-audio-samples v2
witness rather than trusting stream, container or tag duration. A full
selected-stream `ffprobe` frame scan proves one phase-quantized sample clock and
canonical record digest. Ordinary frames close at their cumulative decoded-
sample start; an exact short-duration variable-block boundary may close at its
end and records the real leading discontinuity-fill samples. An independent
absolute-stream FFmpeg s16le decode proves the decoder-output sample count and
PCM digest. Retained samples plus any sample-exact terminal padding trim must
equal that independent decoder count.
The exact `decodedSampleCount / sampleRate` duration, witness and matching
selected-stream metadata enter graph/cache identity, inspect and private-session
rescan. PCM/FLAC Matroska, AAC MP4, Opus Matroska and variable-block Vorbis OGG,
nonzero starts, absolute stream indexes, tamper and budgets pass. Audio proxies
add one bounded 16 kHz per-channel windowed content/timeline alignment witness;
the full pairwise proof stays in canonical lock/build/inspect and is rescanned,
while cache identity projects only selected proxy facts so unrelated master
changes preserve preview locality. Same-source PCM/FLAC/AAC/Opus, silence,
shift/drop/reorder/different-tone/channel-swap, tamper and budget fixtures pass.
See
`docs/DECODED_AUDIO_SAMPLES.md`. Windows media probing/rendering remains
explicitly unsupported (`CUTD1003`, `CUTP2015`) until CUT can pass an
already-open input handle to native tools safely.

Selected picture proxies carry a parallel bounded pairwise authority. The
canonical lock/inspect view retains both file/stream/cadence identities,
fixed 32×32 RGB analysis hashes, policy, metrics and integrity; full apply and
the private verified-input session recompute it. Profile-specific picture
identity projects only fixed analysis/policy plus the selected proxy facts, so
a freshly re-proved master-only revision does not invalidate unchanged proxy
picture caches. Picture-only correspondence evidence is excluded from audio
cache identity.

An author-declared video color interpretation adds a second selected-domain
projection. The canonical locked IR retains the target profile, authority and
exact authored master/proxy observations for audit and semantic diff. Before
execution in the supported verified-session flow, CUT derives an
invocation-local selected execution projection retaining only the active
variant's observation. Its required pixel format and field order,
structurally present or absent optional range/matrix/transfer/primaries, closed
target profile and decoder-contract identity enter that picture node and its
ancestors. An edit to only the unselected proxy observation/bytes therefore
preserves master picture build/cache identity in that supported flow, and the
converse holds. The declaration is excluded from linked source-audio
projection, so it neither
changes audio samples nor invalidates the pre-master audio artifact. A selected
variant missing the exact authored observation fails rather than falling back
to the other tuple or legacy decode.

`cut inspect --json` distinguishes the two views. Canonical inspect reports
`videoInputColorInterpretation` with `author-declared-unverified` authority,
contract/decoder identities, both authored observations and field-level target
differences; its resource record reports both locked selected-video
observations. Internal inspection of the active in-process selection reports
only the active master or proxy resource observation; a serialized copy of that
view is still evidence, not reusable execution authority. Neither view asserts
photographic truth.

The writer emits a `cut-render-cache` v3 composition manifest with `format`,
`version`, `runtime`, `backendIntegrity`, `sceneToolchainIntegrity`, `target`,
`nodes` and `scenes`. Its current reader treats that file only as an untrusted
hit-plan hint and does not yet strict-validate the outer record. A hinted hit
still has to pass the independently closed scene-artifact boundary. Each
`cut-scene-cache` v3 manifest accepts exactly `format`, `version`, `key`,
`sha256`, `frames`, `runtime`, `backendIntegrity` and `toolchainIntegrity`.
FPS, dimensions, pixel/color metadata and the remaining timing contract are
derived from the current locked composition/target rather than duplicated in
that manifest. Every new scene or cache hit reconciles those expectations with
the artifact SHA-256 and ffprobe's decoded frame count, start/duration clock,
FPS, dimensions, codec/pixel format, B-frame count and managed color tags. A
backend or FFmpeg identity observed at the start of a later render therefore
cannot authorize the old scene key.

This picture identity is not yet part of `cut.lock`. It also hashes the FFmpeg
executable, not the separately dynamically linked libav and x264 library bytes,
and the ffprobe used to authorize artifacts remains outside this scene identity.
Warm hits do not spawn the scene encoder or perform the post-encode executable
recheck; an all-hit render has no later picture-toolchain recheck before the
output transaction. The composition-manifest reader is also not a closed
runtime schema yet. Consequently this materially hardens warm-cache correctness
but does not claim resistance to a same-user mid-render tool replacement and
does not satisfy the complete toolchain-lock requirement for CUT 1.0.

Every public full render additionally emits `cut-reference-render` v10 with
`lock.sha256` equal to the exact verified `cut.lock` byte digest applied by the
CLI. This is publication evidence rather than a picture/audio cache input:
semantically equivalent lock byte streams may reuse the same media cache, but
the adjacent manifest always names the current digest. When stems are requested,
lock-bound stem-manifest v5 names every WAVE digest and v10 additionally binds
the SHA-256 of those exact canonical manifest bytes. Formal review also
reconciles v5 runtime/build/duration/sample identity to v10 and verifies each
declared WAVE leaf rather than treating the manifest hash as sufficient.
Missing, malformed or
unknown render/stem options fail before any project or media work. Current
professional-output and reference-study reviews reject historical v8/v9 render
manifests; those older artifacts remain preserved as historical evidence.

## Determinism boundary

This is an invalidation and disclosure boundary, not a claim that different
machines produce identical decoded pixels or encoded bytes. CUT continues to
label decoded-media and bitstream determinism unverified. The active FFmpeg
executable is now observed by picture-cache execution, but ffprobe, transitive
native codec libraries and resource-specific probe identities remain separate
or incomplete boundaries; native media parsers still require production
isolation for untrusted uploads.
