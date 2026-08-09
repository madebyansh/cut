# Deterministic audio stems

Status: implemented in the current `0.4.0-alpha.3` development line. This is a
narrow pre-master delivery contract, not a claim that arbitrary routing or
every professional audio workflow is complete. Explicit Send/Return/Submix
routing is supported inside one delivered program Bus and across program buses
into an explicitly declared auxiliary-return Bus. A program Bus may also use a
public `Sidechain(source:)` key owned by another program Bus; that signal-only
control dependency is explicit in the plan and manifest. The route remains
authored typed IR; no name-discovered or hidden mixer graph changes the boundary
below.

## Authoring and rendering

Each delivered stem is one top-level `Bus` in typed CUT source:

```cut
cut 0.4;
project "Podcast delivery";

import { AudioClip, Bus, Gain, Reverb, Return, Send } from "@cut/audio";

asset host: AudioAsset = audio("media/host.wav");
asset bed: AudioAsset = audio("media/music.wav");

timeline main(duration: 30s, fps: 30, sampleRate: 48khz) {
  Bus(name: "dialogue", role: "dialogue") as dialogue {
    Gain(amount: -2db) { AudioClip(source: host, range: 0s ..< 30s); }
  }
  let dialogueRoom = Send(amount: -18db, source: dialogue);

  Bus(name: "music", role: "music") as music {
    Gain(amount: -18db) { AudioClip(source: bed, range: 0s ..< 30s); }
  }
  let musicRoom = Send(amount: -24db, source: music);

  Bus(name: "room", role: "ambience", kind: "aux") {
    Reverb(wet: 100%) { Return(sends: [dialogueRoom, musicRoom]); }
  }

  scene picture(duration: 30s) {}
}

export release = render(main);
```

```bash
cut lock main.cut --out cut.lock
cut render main.cut --lock cut.lock --out output/release.mp4 --stems output/stems
```

`output/stems` then contains `dialogue.wav`, `music.wav`, `room.wav`, and the
canonical machine-readable `cut-stems.json` manifest.

Shared mastering has one explicit, deliberately narrow boundary:

```cut
Meter(target: -14lufs, truePeak: -1dbtp, samplePeak: -1dbfs) {
  Limiter(ceiling: -1dbtp) {
    Gain(amount: -2db) {
      Submix(name: "pre-master") {
        Bus(name: "dialogue", role: "dialogue") { /* route sources/inserts */ }
        Bus(name: "music", role: "music") { /* route sources/inserts */ }
      }
    }
  }
}
```

The master executes the authored shared inserts; stems select the direct Bus
nodes before them. The admitted outer chain is closed to one-child `Gain`,
`HighPass`, `LowPass`, `EQ`/`ParametricEQ`, `Compressor`, `DeEsser`, and
`Limiter`, with transparent `Meter` and component fragments. This reuses
public `Submix`; there is no hidden graph rewrite or inferred boundary.

## Exact routing semantics

For the selected render composition, every audible master root must resolve to
either a direct top-level `Bus` (the compatible legacy form) or the one explicit
pre-master Submix above. User-component fragments and `Meter` are transparent.
Direct unbused audio, multiple boundaries, branching shared inserts, a Bus
outside the boundary, non-Bus boundary children, or duration/routing processors
above it fail before FFmpeg starts. `Limiter { Bus(...) }` remains invalid and
reports how to author the explicit Submix.

Every top-level Bus has closed `kind: "program" | "aux"`; omission means
`"program"` and preserves earlier source/IR behavior. Every Bus must:

- have one non-empty portable name matching `[A-Za-z][A-Za-z0-9_-]{0,63}`;
- avoid Windows device names such as `CON`, `NUL`, `COM1`, and `LPT1`;
- be unique under ASCII case folding, so `Music` and `music` conflict;
- own an unshared child graph that is not reachable from another stem.

A program Bus must structurally contain at least one rendered source. An aux
Bus must contain no structural source and must instead contain at least one
`Return` dependency on a detached `Send(source:)` whose source is owned by a
program Bus. The public tap form is deliberately explicit:

```cut
Bus(name: "dialogue") as dialogue { /* source and inserts */ }
let roomSend = Send(amount: -18db, source: dialogue);
Bus(name: "room", kind: "aux") {
  Reverb(wet: 100%) { Return(sends: [roomSend]); }
}
```

An explicit pre-fader tap is equally structural. The program Bus must have one
direct `Gain` child so CUT has one unambiguous fader boundary:

```cut
Bus(name: "dialogue") as dialogue {
  Gain(amount: -6db) { AudioClip(source: host); }
}
let cueSend = Send(amount: -12db, source: dialogue, tap: "pre-fader");
Bus(name: "cue", kind: "aux") { Return(sends: [cueSend]); }
```

The delivered `dialogue` stem retains the `-6db` Gain. Only the `cue` input is
taken from the mixed direct children immediately before that Gain. A Bus with
no direct Gain or more than one direct child fails rather than guessing which
processor is a fader.

The `let` is semantic: it gives the Send reference ownership, so it is audible
only through its one claiming Return and cannot become another dry master root.
`Send(source:)` cannot have children or be authored as a root statement. The
older `Send(amount:) { audio }` form remains valid inside one structural Bus: it
passes its child dry at unity and exposes one claimed auxiliary copy.

Only aux Returns may cross a top-level stem boundary, and their Sends must tap
program-owned audio. A program Return cannot pull another program stem; an aux
cannot contain a direct source, tap another aux, feed itself, or be nested.
Cycles, orphan taps, duplicate claims, ambiguous/shared ownership and hostile
loaded IR fail before rendering with stable source-located diagnostics.

Cross-stem sidechain control is likewise explicit:

```cut
Bus(name: "dialogue", role: "dialogue") as dialogue {
  AudioClip(source: host, range: 0s ..< 30s);
}
Bus(name: "music", role: "music") {
  Sidechain(source: dialogue, amount: -8db, threshold: -28db) {
    AudioClip(source: bed, range: 0s ..< 30s);
  }
}
```

The controlled route records the Sidechain node, key node, owning source stem,
and both transitive graph hashes. The key is decoded for detection but is not
mixed into the controlled stem. When control crosses a stem boundary, both the
controlling and controlled top-level buses must be `program` routes. A
Sidechain whose key and controlled program remain inside one route is ordinary
intra-route processing and may also occur inside an aux route. A detached or
unowned key, a key with ambiguous structural ownership, any cross-stem aux
participation, or a cross-stem control cycle fails before backend work with source-located
`CUT_STEM_CONTROL_UNOWNED`, `CUT_STEM_CONTROL_AMBIGUOUS`,
`CUT_STEM_CONTROL_AUX`, or `CUT_STEM_CONTROL_CYCLE`. Malformed loaded control
graphs fail with `CUT_STEM_CONTROL_GRAPH`. A composition may disclose at most
1,024 Sidechain control dependencies; larger control graphs fail at the first
excess node with `CUT_STEM_CONTROL_LIMIT`. The exporter conservatively sizes
the complete v4 manifest from the validated plan and refuses an envelope over
1 MiB before it creates the destination directory or renders audio, so the
result remains admissible to the strict prior-manifest reader without spending
backend work first.

`Bus` also accepts optional closed routing metadata:

```cut
Bus(name: "room", role: "ambience", kind: "aux") { /* Return-fed processing */ }
Bus(name: "impacts", role: "sfx") { /* audio */ }
```

The complete role vocabulary is `dialogue`, `music`, `ambience`, and `sfx`.
Roles may repeat—two separately named dialogue stems are valid—and omission is
valid. A role classifies authored routing intent; it does not silently add EQ,
gain, ducking, cleanup, mastering, or any other processing.

A nested program Bus remains part of its nearest top-level stem and is not
exported as another file. A nested `kind: "aux"` fails because it cannot own an
independent additive delivery route. A nested Bus's optional role remains
ordinary authored IR metadata, while only the role on the top-level delivered
Bus appears on that stem's route and manifest entry. To place many dialogue
clips across time, put them inside one top-level
`Bus(name: "dialogue", role: "dialogue")`; repeating that top-level name
creates a deliberate duplicate-name error.

The stem renderer selects the authored bus node as an execution root. For the
explicit form, selected-root authorization proves it is a direct Bus child of
the exact boundary reached through only the closed linear chain. It does not
clone, rewrite, mute, or synthesize alternate CutAVIR. Direct TypeScript callers
cannot substitute a composition object; signal, node and build identities are
recomputed before a plan or manifest is returned.

## Delivery contract

Every stem is an unnormalized, lossless WAVE file with:

- the composition's exact sample rate;
- exactly two channels;
- signed 24-bit little-endian PCM;
- exactly `timeline duration * sample rate` samples per channel;
- silence padded or trimmed to that exact length;
- the authored Bus node ID/transitive graph hash and a SHA-256 output-content
  hash recorded in `cut-stems.json`;
- the fresh exact raw-float peak scan, threshold, location, frame/byte counts,
  and observed peak recorded per route in lock-bound manifest version 5.

The internal handoff is deliberately not a WAVE file. CUT renders every stem
route into raw stereo `f32le` in one private staging directory, retaining
over-range samples until CUT has inspected them. For every route, CUT then:

1. verifies the exact expected frame and byte count;
2. rejects NaN or infinite samples;
3. enforces the decoded sample-peak ceiling;
4. quantizes the validated stream to CUT's canonical stereo 24-bit PCM WAVE;
5. re-opens and verifies the resulting WAVE before hashing it.

`cut-stems.json` also declares `peakValidation:
"exact-f32le-before-quantization"` and `quantization:
"nearest-ties-to-even"`; these are executable delivery contracts rather than
descriptive labels.

The runtime stem API requires `lockSha256`, the lowercase SHA-256 of the exact
already-verified `cut.lock` bytes applied by its caller. Optional
`samplePeakDbfs` and `source` are an independent pre-master serialization
ceiling and diagnostic owner; omission uses `0 dBFS` and the composition.
`cut render --stems` does not pass final `Meter.samplePeak` here: Meter gates the
authored master after shared inserts, while isolated pre-master Buses need only
fit losslessly into PCM24. Missing/malformed lock identity and unknown options
fail before graph, filesystem, cache, resource or media work. A ceiling
violation is a source-located
`CUT_AUDIO_CLIPPING` diagnostic; non-finite and malformed raw streams fail with
`CUT_AUDIO_NONFINITE` or `CUT_AUDIO_PEAK_STRUCTURE` rather than being saturated,
truncated, or published.

No public WAVE or manifest is replaced until all routes have rendered,
validated, quantized, re-opened, hashed, and the complete manifest has been
written in that same staging directory. A failure in any route removes staging
and leaves an existing public stem set byte-for-byte untouched. Publication of
the validated set uses ordered same-filesystem renames with rollback for caught
ordinary in-process backup or promotion failures. The standalone runtime API
retains this behavior through `renderReferenceAudioStems`; its preparation half
also lets a complete render join the same boundary.

When `cut render --stems` is used, CUT first writes and verifies AAC/color/
loudness against a same-parent staged MP4, fully prepares every WAVE and `cut-stems.json`,
and stages both the incremental composition manifest and adjacent render
manifest. One ordered publication transaction then covers all requested WAVs,
the stem manifest, the MP4, the composition manifest, and the render manifest.
The v11 render manifest contains only portable final locators relative to its
own adjacent MP4 directory (`output` is the MP4 basename; stem directory and
manifest locators use normalized `/` separators), binds the SHA-256 of the exact
canonical staged `cut-stems.json` bytes, and is promoted last as the commit
marker. Stem-manifest v5 independently binds the exact verified lock digest and
every delivered WAVE digest. A caught backup/promotion failure restores each prior
regular file or leaf symlink and returns newly introduced leaves to absence.

Formal review follows that marker rather than trusting the writer. It requires
the stem directory to equal the manifest locator's parent, closes the complete
v5 composition/relationship/route/peak shapes, reconciles runtime and
execution-build identity plus exact duration/sample arithmetic to render v10,
and independently verifies every direct non-symlink WAVE hash, size, PCM24
format, channel/rate contract and frame count. Professional hero-film review
requires stems; reference-study review permits omission for a silent study.

Route shrinkage removes a stale WAVE only when its direct portable filename was
owned by the previous regular, size-bounded, canonical, structurally closed CUT
stem manifest and is absent from the new manifest. New output is version 5.
Exact historical versions 3 and 4 remain readable only for cleanup
compatibility: v3 cannot contain Sidechain dependencies, v4 contains those
dependencies but no lock, and v5 requires both. Each version is validated
against its own closed shape. A reformatted, duplicate-key, unknown-field, malformed,
obsolete, symlinked, duplicate, unsafe, or otherwise invalid manifest grants no
deletion authority; unlisted neighbouring files are never removed.

This is a rollback group, not a claim of atomic visibility across filesystems,
crash/power-loss safety, or recovery from an unsuccessful rollback itself. A
consumer that needs a completion signal should treat the final render-manifest
promotion as the marker and still serialize against concurrent writers. Private
staging cleanup after commit is best effort so a cleanup error cannot report a
live committed delivery as failed; an interrupted or cleanup-denied run may
leave a hidden `.cut-stems-*`, `.cut-render-publication-*`, or
`.cut-composition-publication-*` staging residue or a hidden `.bak` backup that
is never referenced by manifests.

Each route and emitted manifest entry includes its resolved `kind`, an exact
ordered `auxiliaryInputs` list of Return node, Send node and source-stem
evidence, an exact ordered `sidechainInputs` list of Sidechain node, key node,
source stem and both graph identities, and `role` exactly when authored on the
corresponding top-level Bus. A control-key edit changes the controlled Bus's
transitive `graphHash`, the explicit Sidechain/key hashes, incremental node
identity and the composition-level pre-master audio-cache key. Program routes
have an empty auxiliary-input list; routes without Sidechain processing have an
empty sidechain-input list. A role-only edit changes semantic diff, build ID,
bus graph hash, and the stem manifest. Because Bus and role are sonically
transparent, that edit preserves decoded pre-master PCM and its audio artifact
cache key; executable tests verify a real cache hit and byte-identical 24-bit
WAVE output across such an edit.

The current published closed schema is
`schemas/cut-reference-stems-v5.schema.json`; the v4 schema remains published
for historical consumers. Runtime validation additionally
checks cross-entry ownership, route direction, ordering, and acyclicity that
JSON Schema cannot express.

The decoded stems sum to CUT's raw master mix before global mastering. Each stem
is quantized independently to 24-bit PCM, so summing delivered integer files can
differ from the separately quantized raw master by the bounded last-bit rounding
of its branches. The final MP4 is not the arithmetic stem sum: CUT applies the
authored/default global loudness target and encodes AAC after the pre-master mix.

Public `cut audition` uses the same raw-float handoff and CUT-owned
nearest-ties-to-even PCM24 quantizer as stem export. The additive
`mission-control-dialogue` V4 fixture proves its full-range master audition,
named-Bus audition and exported one-Bus stem are byte-identical while its
authenticated proxy preview and master final share the same normalized
pre-delivery PCM identity. V3 remains frozen as the canonical-audio repair; the
preserved V2 checkpoint records the prior one-LSB mismatch. This is a
serialization conformance result, not a claim that a multi-Bus integer stem
sum is byte-identical to a separately quantized master.

The exporter strips optional WAVE metadata and records the current reference
runtime identity. Repeated renders on the same pinned runtime are tested for
identical hashes. CUT still does not promise cross-platform bit identity until
the FFmpeg build and every native dependency are locked and proven.

## Explicit limitations

This slice does not implement inferred faders, surround/object routing,
aux-to-aux routing, sub-stem export, per-stem cache reuse, per-stem
loudness normalization, RF64 files larger than classic RIFF/WAVE, or routing
the audio half of a linked `@cut/edit` AV clip into a bus. Those cases fail or
remain outside the stem contract rather than being simulated.
