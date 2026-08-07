# OpenTimelineIO interchange

CUT has a deliberately narrow, fail-closed OpenTimelineIO JSON boundary. It is
an editorial interchange path, not an attempt to disguise CUT rendering,
animation, compositing, audio processing, or effects as portable OTIO meaning.

## Common interchange backend boundary

OTIO export is the first production adapter behind CUT's versioned
`cut-interchange-backend` v1 boundary in
`lib/interchange/backend`. The public `exportCutTimelineToOtio` route registers
`cut.otio-json` and dispatches through that boundary; the interface is not a
type-only roadmap placeholder.

Every adapter receives the same isolated
`cut-interchange-editorial-source` v1 envelope:

- complete canonical `CutAVIR` v3 editorial meaning;
- the caller's optional composition selector;
- the locked build ID and a SHA-256 of the complete dispatched semantic graph.

An adapter returns one target artifact and one typed loss report. The common
dispatcher requires `lossless-editorial` exactly when the loss array is empty,
requires `lossy-editorial` otherwise, validates every stable `CUT_*` issue,
binds the report to the registered adapter implementation, selected
composition and CUT build, and emits an execution receipt with the semantic
SHA-256 and issue count. Caller-owned IR is never passed to adapter code:
dispatch uses an isolated structured clone and refuses mutation of that clone
as `CUT_INTERCHANGE_BACKEND_MUTATION`.

Registration rejects duplicate and unknown backend IDs. Malformed descriptors,
untyped adapter failures, asynchronous/invalid results, forged report identity,
wrong-build/wrong-composition reports and contradictory loss status fail with
stable `CUT_INTERCHANGE_BACKEND_*` diagnostics. Target-specific stable
diagnostics such as `CUT_OTIO_*` remain intact.

The independent
`tests/fixtures/interchange/timeline-summary-backend.ts` adapter dispatches
through the same registry and preserves exact composition/scene timing while
reporting its omitted executable graph as typed loss. It is a real executable
conformance adapter, not a second production format.

This is a trusted, synchronous, in-process **translation** API. It grants no
filesystem, process, network, codec or publication capability, and the host
still owns transactional output publication. It is not an untrusted extension
sandbox or evidence that third-party native code is isolated. Such execution
remains outside this alpha's security claim.

### Canonical TimelineEdit editorial profile

The versioned `cut-otio-editorial-profile` v2 boundary maps CUT's representable
canonical [`TimelineEdit`](TIMELINE_EDIT.md) result into native OTIO track,
clip, gap, transition, time-effect, and metadata objects. Exact rational source
and destination ranges, track order/role/namespaced metadata, item
lineage/link identity, atomic two-boundary J/L metadata, transition handle
ownership, supported constant forward/reverse retime, and bounded
nested-presentation metadata are retained and independently reconciled against
the emitted OTIO structure.

The production OTIO exporter and strict importer both exercise that profile.
For one structurally identical linked Video/Audio pair, import reconstructs
the two exact picture/audio hard boundaries and their transition as one
scene-local canonical `TimelineEdit`; it refuses ambiguous, orphaned, or
multiply paired ownership rather than generating independent legacy edits.
Track roles, item roles, namespaced metadata, link identities, track order,
and exact source/destination intervals are part of the profile equality.
When any track or clip carries a role or namespaced editorial metadata, the
profile also publishes one composition-scoped
`CUT_OTIO_EDITORIAL_ROLE_METADATA_REQUIRED` loss targeted only at
`generic-otio`. Native `Track.1`/`Clip.2` objects still carry those exact
values, and CUT-profile import remains lossless for them; the loss records that
an arbitrary adapter or NLE has no verified semantic mapping unless it
preserves and reconciles the closed CUT profile. It does not become a
`cut-roundtrip` loss. Removing that profile while leaving its native role or
metadata fields is a stable import refusal, never a filename-, track-name-, or
free-form-metadata guess.

The preserved `current-v3` dialogue fixture remains immutable historical proof
of the narrower lossless linked J/L subset with profile semantic SHA-256
`63c024d0010a1c1f494ffd3805d94080cd2601779a5ae1569d46042306290e98`.
It is not rewritten to claim later profile extensions.

The independently verified `current-v6-r10` closure exercises the current
profile and exact target-scoped loss policy across three unrelated projects.
Dialogue exports five authenticated direct-media authorities and truthfully
loses processor/fade reconstruction; because its generic import cannot
reconstruct that graph, re-export carries no V5 authority and reports the
exact seven-code compatibility envelope. Product/social exports and
re-exports four byte-identical authority rows while reporting its variable
picture-time, presentation, and nested-execution losses. Education/documentary
exports and re-exports two byte-identical authority rows while reporting only
the transcript-origin loss. The 153-command strict verification refuses any
omitted or surplus loss code, authority row, locked resource, interval,
handle, clock, role, metadata, transition, or semantic hash. Receipt SHA-256
is
`cbb27d29462ba23d8a0f4359b5390f2424ae26d0dcf2529ecd37bc2b7a696456`;
independent verification SHA-256 is
`91838004c0c4104ca78dba9ded24d5cd86624bb20ba790b35ad53a03255de69c`.
Unsupported variable retime, processor execution, arbitrary multi-segment
link groups, and executable nested import remain typed loss or stable refusal;
they are never silently flattened into a `lossless-editorial` result.

### Origin-clock profile extension V3

The current alpha also defines the closed
`cut-otio-editorial-profile-extension` V3 metadata contract in
`schemas/cut-otio-editorial-profile-v3.schema.json`. It does not replace or
rewrite the V2 native-track profile. Instead, it binds one exact V2 semantic
SHA-256 and records compiler-generated immutable audio origins plus their
structural destination views:

- source, destination, head/tail handle, role, namespaced metadata, authored
  link and segment-lineage identity are reconciled against the exact V2 Audio
  clip item;
- `lineageSegments` carries the parent-first, visible-ancestor closure from the
  exact TimelineEdit plan. Every record binds the plan, track, edit origin,
  source/destination clock mapping, handles, role, metadata, link identity and
  a recomputed semantic SHA-256. Intermediate segments created by two
  boundaries inside one operation remain explicit; discarded sibling branches
  are not misrepresented as visible lineage;
- `sliceOffset`, origin duration, source authority, fade clock, rate and
  `single-authorized-evaluation` state policy are exact rationals/identities;
- processed origins additionally bind the source node, ordered processor-node
  identities, graph authority and graph semantic SHA-256;
- a complete-origin cross-track placement keeps `audioOrigin.trackId` as the
  source AudioTrack owner while every lineage segment names its actual source
  or destination AudioTrack. Each visible V2 item must reconcile to that exact
  segment track, so multi-track placement is explicit rather than collapsed to
  one generic clip list;
- when one direct picture part is coupled to that processed-audio placement,
  V2 retains every source/insert/overwrite link-group pair and V3 retains the
  processed-audio view multiplicity. Processor reconstruction losses remain
  scoped to the audio view item IDs and never attach to the exact picture
  items;
- the V2 profile, its semantic SHA-256, and historical fixtures remain
  byte-stable when the extension is absent.

This extension is an authority/reconciliation boundary, not a generic OTIO
effect serialization format. The current importer cannot reconstruct an
arbitrary CUT processor graph from an authority digest. A processed origin
therefore must declare both
`CUT_OTIO_AUDIO_ORIGIN_GRAPH_RECONSTRUCTION_UNSUPPORTED` for the current
CUT-source round-trip and
`CUT_OTIO_AUDIO_ORIGIN_GRAPH_METADATA_REQUIRED` for generic OTIO. Likewise, a
transition intersecting an origin-clock view requires the exact
`CUT_OTIO_AUDIO_ORIGIN_TRANSITION_UNSUPPORTED` CUT-roundtrip loss. Origin views
carry the same exact constant forward rate in their native V2 clip; a
contradictory or variable native retime and audio nested-sequence substitution
fail closed. The source clock is derived as
`originStart + sliceOffset × rate`, while the presentation bound remains
`sliceOffset + destinationDuration <= originDuration`. These limitations are
deliberate: profile validation must never turn metadata presence into a false
`lossless-editorial` claim.

The public creation, embedded-profile validation, native-metadata observation,
and reconciliation functions live in
`lib/interchange/otio-editorial-profile-v3.ts`. Their hostile tests cover stale
base/profile hashes, origin/source/processor authority, source-clock mapping,
roles, metadata, links, lineage, retime, transitions and nesting. Executable
source import remains lossy/refused until a future version carries and
revalidates a closed processor recipe rather than guessing one from filenames
or node IDs.

### Nested-placement profile extension V4

The current alpha defines a second separate optional authority,
`cut-otio-editorial-nested-placement-extension` V4, in
`schemas/cut-otio-editorial-profile-v4.schema.json`. It does not change the
frozen V2 native profile or V3 audio-origin extension. V4 is emitted only for
bounded picture-only 1:1 `Precomp` items that survive canonical `TimelineEdit`
materialization. It distinguishes structural-only nested views from the
narrower static same-track copy policy required by insert/overwrite. It binds:

- the exact V2 profile semantic SHA-256 and composition;
- each visible parent-first segment lineage, plan/track/origin/segment
  identity, source composition authority, exact source and destination
  intervals, placement policy, role, namespaced metadata, and lineage
  SHA-256;
- each native nested placement to that exact lineage, nesting instance,
  source/destination interval, role, and metadata;
- the complete admitted static instance presentation tuple: `x`, `y`, `scale`,
  `rotation`, and `opacity`; and
- the source-then-placement metadata merge used by same-track complete-item
  insert and overwrite.

The native OTIO observation is reconciled against this authority. Duplicate,
orphaned, stale-base, timing, source-authority, role, metadata, lineage,
placement, hash, and unknown-field mutations fail through the closed
`CUT_OTIO_PROFILE_V4_*` diagnostic family.

V4 preserves CUT authority; it is not an executable nested-graph interchange
format. The generic adapter and an external NLE still cannot recreate the
separately owned CUT source graph or CUT-specific instance presentation.
Export therefore retains
`CUT_OTIO_NESTING_EXECUTABLE_IMPORT_UNSUPPORTED` and
`CUT_OTIO_NESTING_ADAPTER_UNSUPPORTED` loss where applicable. A statically
presented instance additionally emits the exact target-scoped
`CUT_OTIO_NESTED_INSTANCE_CONTROLS_UNSUPPORTED` loss for CUT round-trip and
generic OTIO; the authenticated V2/V4 profiles remain present, while default
import refuses and explicit lossy import never manufactures a `Precomp` or its
controls from opaque metadata. No generic or external-NLE nested execution is
claimed. The `current-v6-r10`
product fixture binds the V4 nested-placement authority and its exact generic
loss envelope; a fresh installed-package replay remains a separate gate.

### Direct-media authority extension V5

The optional
`cut-otio-editorial-direct-media-extension` V5 contract in
`schemas/cut-otio-editorial-profile-v5.schema.json` closes one narrower
interchange boundary for direct, locked `PictureClip` and `AudioClip` items
that declare unused source handles. It binds the exact V2 profile, native item
and track identities, selected stream clock, locked resource id/kind/SHA-256,
visible and available source intervals, destination, declared and consumed
handles, constant retime, link state, role, namespaced metadata, and related
transition/cut identities.

The importer reconciles those bytes against both native `Clip.2` and
`ExternalReference.1` metadata before source generation. It preserves the
authenticated resource identifier and declared surplus handles, so
recompile/re-export reproduces the same V5 semantic authority. Duplicate,
orphaned, renamed-resource, hash, clock, interval, handle, role, metadata,
link, transition, native-observation, or unknown-field mutations fail closed.
When no eligible direct item has a nonzero handle, V5 is omitted exactly.

V5 does **not** claim processor-graph, faded-region, nested-graph,
transcript-origin, generic-OTIO, or external-NLE reconstruction. If one
composition mixes an unsupported processed graph into the closed profile
shape, CUT omits the closed V2/V5 profile rather than authenticating a partial
timeline and emits exact structured loss through the compatibility exporter.
The earlier V2/V3/V4 formats and their historical evidence remain unchanged.
Repository `current-v6-r10` proof binds the exact phase-specific V5 authority
sets (dialogue 5 export/0 re-export, product 4/4, education 2/2). A fresh
installed-package replay must still be generated from the final shipped-byte
freeze; repository evidence does not substitute for it.

### Picture-time-map authority extension V6

The optional
`cut-otio-editorial-picture-time-map-extension` V6 contract in
`schemas/cut-otio-editorial-profile-v6.schema.json` closes CUT-source
round-trip for the final exact time law of a direct, locked `PictureClip` when
native OTIO can carry only a `LinearTimeWarp` approximation. It is additive:
the V2 native profile and V3/V4/V5 extensions retain their existing formats,
bytes, and meanings. V6 is emitted for bounded speed ramps, freeze maps, and
constant maps with non-default `nearest` or `frame-blend` sampling. Ordinary
floor-sampled constant retimes remain exactly represented by V2 and omit V6.

Each V6 authority binds the exact V2 item/track/source/destination/native
retime, locked resource id/SHA-256, selected frame clock, closed
`cut-picture-time-map-v1` policy, and canonical time-map object. The same
authority is copied into the native `Clip.2` metadata and reconciled before
source generation. Import then emits the exact public `PictureClip` controls,
including `speedPoint` values, and a subsequent lock must reauthenticate the
selected media bytes and frame clock. Unknown fields, stale base/profile or
authority hashes, orphan items, resource/native-copy disagreement, invalid
rationals, inconsistent integrated ramp duration, out-of-range freeze time,
and contradictory V2 approximation fail closed.

V6 authenticates only the **final direct clip time map**. Its closed execution
spelling is `direct-picture-time-map-no-lineage`; it does not claim or encode
the `TimelineEdit` operations, discarded branches, user intent, or edit-plan
lineage that produced the final item. Generic OTIO and external NLEs still do
not execute CUT speed-ramp integration, freeze, or frame-selection laws, so
the existing generic-target loss codes and native approximation remain exact.
Only an authenticated CUT-profile import suppresses the corresponding
`cut-roundtrip` loss. A fresh installed-package replay is required after the
final shipped-byte freeze; source and repository tests alone are not package
acceptance.

## Export

```bash
cut otio export program.cut \
  --lock cut.lock \
  --out timeline.otio
```

Export requires a valid CUT resource lock. It writes native OTIO JSON plus a
machine-readable report at `timeline.otio.report.json` (or `--report <path>`).
The report is `lossless-editorial` only when every reachable CUT semantic is in
the representable editorial subset. Without `--allow-lossy`, a useful but lossy
export is normally still written and the command exits with status 2. Removed
Narration transcript metadata is a stricter compatibility boundary described
below: default export refuses it before writing OTIO.

The exporter currently represents exact placements and source ranges for:

- ordinary `Video`, `Image`, `AudioClip`, `Narration`, and linked `Clip` nodes;
- sequential OTIO clips and explicit gaps on Video and Audio tracks;
- looped video lowered to a bounded sequence of ordinary clips;
- timeline- and scene-owned CUT `Marker`/`Region` annotations as OTIO
  `Marker.2` objects with exact rational timing and CUT metadata;
- project-relative `ExternalReference` locators and locked SHA-256 metadata.

For `JCut`/`LCut`, export preserves both exact linked `Clip` Video/Audio track
pairs but reports `CUT_OTIO_LINKED_SPLIT_UNSUPPORTED` with `flattened`
disposition. Standard OTIO does not preserve CUT's distinct hard-picture cut
relative to its distinct hard-audio cut; the report therefore stays lossy instead of
silently manufacturing a dissolve or claiming round-trip equality.

For `AudioRegion`, export preserves the one nested `AudioClip` descendant as an
ordinary hard audio clip with its exact source range and destination placement.
It does not bake or pretend to serialize the ordered CUT processor chain. The
report adds one provenance-backed
`CUT_OTIO_AUDIO_REGION_PROCESSING_UNSUPPORTED` issue with `flattened`
disposition and explicitly records the loss of processing, region link grouping,
and processor automation. The emitted clip is unprocessed, import does not
reconstruct `AudioRegion`, and the report remains `lossy-editorial`.
If the region owns `TimeStretch`, export also emits
`CUT_OTIO_AUDIO_REGION_RETIME_UNSUPPORTED` with the source/destination
durations, pitch/quality, processor-side ordering and CUT-owned DSP identity
that the flattened hard clip cannot preserve.

For every `linkedEdits` `linked-trim` transaction owned by the selected
composition, export adds exactly one
`CUT_OTIO_LINKED_TRIM_UNSUPPORTED` issue with `flattened` disposition. Its
structured subject is the `linked-edit` transaction ID and the issue carries
the transaction's source provenance. The compiled track plans already contain
the materialized picture/audio hard-cut state, but standard OTIO and this CUT
subset cannot preserve the atomic cross-track correlation or reconstruct the
shared `transactionId`. The report therefore remains `lossy-editorial`; import
does not synthesize a `LinkedTrim` from flattened clip boundaries.

Every unsupported CUT node, parameter, property, signal, effect capability,
effect job, unresolved resource, or unrepresentable timing condition is listed
in the report. No model, renderer, FFmpeg process, or hidden flattening pass runs
during export.

### Narration transcript compatibility

Valid current `Narration(source:, range?, fadeIn?, fadeOut?)` clips retain the
`cut.documentary.narration` role in `metadata.cut.node_op`, round-trip back to
`Narration`, and emit no transcript field. Current CutAVIR containing the
removed `inputs.transcript` field is invalid and is refused before OTIO
publication even when `--allow-lossy` is present.

An explicitly loaded archived `cut-ts/0.3.0` graph may contain the historical
metadata-only field. Export refuses it by default. `--allow-lossy` may omit it
only from that archived compatibility path and adds
`CUT_OTIO_NARRATION_TRANSCRIPT_UNSUPPORTED` to the report with node provenance,
the exact IR value kind, and the exact string—including `""`. The OTIO clip
does not carry a hidden reconstructed transcript.

## Import

```bash
cut otio import timeline.otio --out program.cut
```

Legacy CUT-authored OTIO may contain `metadata.cut.transcript`. Import refuses
that field by default, including an empty string. An explicit
`cut otio import ... --allow-lossy` emits role-preserving current `Narration`
source without the field and records one
`CUT_OTIO_IMPORT_NARRATION_TRANSCRIPT_UNSUPPORTED` loss per occurrence with the
exact JSON path, track/item identity, node operation, and exact omitted string.
It never guesses whether the text should become visible `Captions` or a
non-rendering `Marker`/`Region` comment.

An OTIO file exported by CUT carries the canvas, rational frame rate, sample
rate, duration, exact CUT composition identifier, and scene metadata needed to
generate executable source. CUT-authored identifiers are preserved byte-for-byte
when canonical source can express them. Conflicting, invalid, or identity-changing
composition/scene metadata is refused rather than normalized. If an exact
timeline ID collides with an imported constructor or deterministic asset name,
the importer aliases the constructor or advances the generated asset ordinal;
it never renames the timeline. A
generic OTIO file must provide execution settings explicitly:

```bash
cut otio import timeline.otio \
  --out program.cut \
  --fps 30000/1001 \
  --width 1920 \
  --height 1080 \
  --sample-rate 48000
```

Import writes canonical typed CUT 0.4 source and a deterministic companion
report at `program.cut.import.report.json`. The source can be checked and then
locked through the ordinary lifecycle:

```bash
cut check program.cut
cut lock program.cut --out cut.lock
cut render program.cut --lock cut.lock --out output.mp4
```

Import does not trust or fetch media. `target_url` must already be a
project-relative POSIX locator with no dot/parent/empty segments. `cut lock`
later resolves the locator inside the project, rejects symlink escapes,
re-probes the media, and locks its actual bytes.

## Generic exact accepted import subset

This section describes OTIO that does not carry CUT's authenticated
`cut-otio-editorial-profile` v2 metadata. A CUT-profile artifact is additionally
eligible for the closed TimelineEdit reconstruction described above; profile
metadata is validated as authority rather than treated as arbitrary vendor
metadata.

The root must be `Timeline.1` with a null `global_start_time`, containing one
`Stack.1` of enabled `Track.1` Video/Audio tracks. Track children may contain
only enabled `Clip.2` and positive `Gap.1` objects. A clip must use exactly one
active `DEFAULT_MEDIA` `ExternalReference.1` with null available range/image
bounds. Container source ranges must be null.

For the generic subset, all effects must be empty. The stack marker list may
contain bounded `Marker.2` objects with CUT's closed annotation metadata
contract; markers on tracks or clips and arbitrary vendor marker metadata are
refused. Transitions, time effects, generators, missing references, disabled
items, global offsets, arbitrary URI/absolute references, and vendor metadata
cannot be represented by that generic subset and are refused. The profile path
admits only its separately closed transition/time-effect/metadata shapes.

OTIO `RationalTime.value` and `.rate` must be safe integers with a positive
rate. CUT reduces them exactly; it never rounds a floating-point rate. Timeline
and picture edit boundaries must land on the selected CUT frame grid. Audio
placements/source boundaries must land on the selected sample grid. Explicitly
linked CUT A/V tracks must satisfy both grids and must form one structurally
identical Video/Audio pair.

Accepted long picture clips are split at other picture edit boundaries when
necessary to express the same layers through CUT's contiguous scene model.
Source ranges remain adjacent exact rationals. Generic Video and Audio tracks
are not guessed to be linked; only the explicit `linked_av_id` metadata emitted
by CUT is reconstructed as `Clip`.

Stack `Marker.2` objects become typed `Marker` or `Region` declarations. CUT
validates exact kind/duration agreement, frame/sample grids, IDs, bounds, and
closed metadata. CUT-authored `scene_id` metadata is restored as scene-relative
source only when the declared scene can be preserved exactly; otherwise import
fails rather than flattening ownership.

CUT-authored track and clip `scene_id` fields must identify the same declared
scene and their destination ranges must remain inside it. Unknown, conflicting,
or out-of-bounds ownership is refused instead of discarded.

CUT scene metadata is executable only when scenes are contiguous, declared in
playback order, and cover the timeline without media-driven subdivision. Export
retains exact metadata for sparse, overlapping, non-covering, or subdivided
layouts, but reports `CUT_OTIO_SCENE_LAYOUT_UNSUPPORTED` and never labels that
artifact `lossless-editorial`. A media boundary that would subdivide an otherwise
exact authored scene similarly reports `CUT_OTIO_SCENE_PARTITION_UNSUPPORTED`.
Import refuses either unreconstructable layout.

The loader enforces byte, JSON depth/node/string, track/item, clip, resource,
scene, generated-node, duration, source-time, and rational-digit budgets. It
uses fatal UTF-8 decoding, rejects decoded duplicate object keys (including
escaped aliases), rejects unknown structural fields, and emits deterministic
source/report bytes for identical input and options.

## Current limits

- Generic track/clip display names are retained in the import report, not
  invented as executable track objects. The authenticated TimelineEdit profile
  separately reconstructs its exact authored track/item IDs, roles, links and
  bounded namespaced metadata.
- Arbitrary OTIO metadata is refused instead of being silently discarded; only
  the closed annotation and TimelineEdit profile contracts are admitted.
- Generic OTIO has no transition, retime, effect, global-start, or available
  media-range import. The TimelineEdit profile admits its exact paired linked
  transition and supported constant-retime subset. Export of an unrelated
  first-class CUT PictureTrack transition still emits
  `CUT_OTIO_TRACK_TRANSITION_UNSUPPORTED` with `lossy-editorial` status; CUT
  never substitutes a hard cut for consumed source handles.
- `LinkedTrim` transaction identity and picture/audio correlation do not
  round-trip. Export reports `CUT_OTIO_LINKED_TRIM_UNSUPPORTED` with source
  provenance even when some materialized hard-cut state is otherwise
  representable.
- `AudioRegion` processing, link grouping, and processor automation do not
  round-trip. Export retains only the exact unprocessed hard-clip source and
  destination timing and reports
  `CUT_OTIO_AUDIO_REGION_PROCESSING_UNSUPPORTED`; a retimed region additionally
  reports `CUT_OTIO_AUDIO_REGION_RETIME_UNSUPPORTED`.
- Annotation support is the closed CUT `Marker.2` contract only. Track/clip
  markers, arbitrary metadata, and external-NLE adapter validation remain
  unsupported.
- Picture layers may be structurally segmented during import even though their
  editorial coverage, ordering, locators, and source timing are preserved.
- External validation through every OTIO adapter and round trips through major
  NLEs are still outstanding; the current conformance suite covers CUT's native
  JSON subset, refusal boundary, CLI, and export/import/recompile/re-export.
- Exact lossless V2-only profile proof is bounded to the representable linked
  picture/audio J/L subset. Authenticated V6 CUT-profile import additionally
  reconstructs final direct-picture variable/freeze/sampling time laws, while
  generic OTIO retains their typed losses. Processor graphs, executable nested
  operands, arbitrary multi-segment link groups, transcript-origin
  reconstruction, and TimelineEdit lineage remain outside that claim.
- The target-neutral backend dispatcher is executable and exercised by the
  production OTIO adapter plus an unrelated typed-loss fixture. Premiere,
  Resolve, Final Cut, AAF, and XML adapters do not exist yet; the fixture is
  conformance evidence for the boundary, not a second production format.
