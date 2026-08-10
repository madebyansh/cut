# Draft preview: first implementation tranche

Status: experimental design for `agent/interactive-draft-preview`. This does
not change the authoritative `cut preview` or `cut render` contracts.

## Measured boundary

Measurements use Node 20.20.2 on the same local machine and 640x360 review
output.

| workload | operation | wall time |
| --- | --- | ---: |
| generated 3 second graphics/audio project | exact first frame | 0.23-0.25s |
| generated 3 second graphics/audio project | exact bounded preview, cold | 2.29s |
| generated 3 second graphics/audio project | exact bounded preview, picture-cache hit | 1.51s |
| generated 3 second graphics/audio project | draft bounded preview, picture-cache hit | 1.23s |
| generated 3 second graphics/audio project, one color/title-class semantic edit | draft bounded preview, cold picture identity | 1.43s |
| 3 second video/text/audio interval from `examples/language-tour.cut` | exact frame in video scene, fresh invocation | 20.49s |
| same interval | exact bounded preview, picture-cache hit | 2.72s |
| same interval | draft bounded preview, picture-cache hit | 1.46s |

The small project already meets the warm target, but the media case shows the
actual authoring problem: process startup, verified snapshot/probe work,
decoder preparation, and exact delivery work are repeated before a useful
pixel appears. The exact path also performs loudness normalization, true-peak
scanning, AAC verification, and a release-style manifest even when the author
only needs a disposable review.

## Contract

The first end-to-end surface is:

```text
cut preview main.cut --lock cut.lock --draft --range 10s:20s --width 640
```

Draft output is deliberately a different artifact contract:

- proxy-profile resources remain lock-bound;
- picture evaluation keeps CUT's canonical clock and graph semantics;
- audio is rendered only for the selected interval and is muxed without final
  loudness normalization, true-peak scanning, AAC delivery verification,
  stems, or release manifests;
- the draft video carries a visible `CUT DRAFT` treatment and the manifest
  identifies it as non-authoritative;
- draft encoding may use a faster encoder preset and lower review bitrate;
- cancellation drains native children, removes staging files, and never
  replaces an existing destination with a partial artifact;
- `cut preview` without `--draft` and `cut render` remain byte-identical.

This tranche intentionally reuses the existing immutable picture-range cache,
so unchanged warm previews avoid picture rendering. It is the minimum useful
CLI slice, not the complete interactive player. The follow-on `cut play`
session will retain the verified proxy snapshot, compiler result, renderer,
and per-scene fragments across source changes; it must refuse source edits
that alter the initially authenticated resource/package authority until a new
lock is supplied.

## Acceptance

- first visible exact/draft review pixel within 2 seconds for asset-light work;
- unchanged warm draft artifact within 3 seconds;
- one-title or one-scene change visible within 5 seconds at 640x360 when the
  selected proxy scene does not require a cold native decoder bootstrap;
- manifest and visible pixels identify every draft as non-authoritative;
- hostile output paths, cancellation, native-process failure, and partial
  publication fail closed;
- authoritative preview/render bytes are unchanged by adding the draft branch.

The 20.49 second cold media-frame result means the persistent `cut play`
follow-on is still required to meet the edit target for decoder-heavy scenes.
The MVP must not claim that case closed merely because a warm cache is fast.
