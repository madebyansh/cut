# Editorial annotations (0.4 alpha)

CUT has typed, non-rendering editorial annotations. They are metadata in the
canonical program and CutAVIR, not invisible comments and not visual overlay
nodes.

```cut
cut 0.4;
project "review pass";

import { Marker, Region } from "@cut/edit";

timeline main(duration: 3s, fps: 24, sampleRate: 48khz) {
  Marker(
    id: "opening",
    at: 1s,
    name: "Opening beat",
    color: #ff5500,
    role: "beat",
    comment: "Land on the reveal.",
    grid: "frame"
  );

  scene interview(duration: 3s) {
    Region(
      id: "review-range",
      range: 500ms ..< 1500ms,
      role: "review",
      grid: "frame"
    );
  }
}

export out = render(main);
```

## Executable contract

- `Marker` requires a project-unique `id` and one exact `at` time.
- `Region` requires a project-unique `id` and an end-exclusive, positive
  `range`.
- `Marker(...)` and `Region(...)` author ordered metadata only as direct
  statements in a timeline or scene statement block. Capturing or nesting an
  authoring call in a value, argument, collection, condition, `at` expression,
  function, or component value fails at that call with
  `CUT_ANNOTATION_CONTEXT`.
- `grid` is either `"frame"` or `"sample"`; every boundary must land exactly
  on that composition grid. CUT does not round annotation times.
- `name`, `role`, `comment`, and color have bounded, closed typed contracts.
  Unknown arguments fail at their CUT source span.
- A declaration at timeline scope uses the composition clock. A declaration
  inside a scene or `at` block uses that local clock, records its owning scene,
  and lowers to absolute composition time.
- Annotations participate in semantic/build identity, strict IR loading,
  lock/build/inspect output, semantic diff, and authored annotation queries.
  Formatting and comments outside the annotation do not alter semantic
  identity.
- A declaration itself emits no render node and therefore cannot alter pixels
  or samples. An **unqueried** annotation-only edit changes canonical build
  identity while preserving delivered media bytes and localized picture/audio
  cache artifacts. If a later query feeds node timing or another render input,
  that dependency intentionally changes the affected graph, media, and cache.

The helper queries `marker(id:)` and `region(id:)` resolve an earlier
declaration as an ordinary typed compile-time value. They can feed `let`, node
arguments, placement/timing expressions, conditions, and assertions. A missing
ID is a source-located `CUT_ANNOTATION_REFERENCE` diagnostic; CUT never invents
a default annotation or resolves a later declaration.

Query `at`/`range` values are always in **absolute composition coordinates**,
including queries made inside a nonzero-start scene. An `at` statement inside a
scene takes a scene-local offset, so author the conversion explicitly:

```cut
scene second(duration: 2s, at: 1s) {
  Marker(id: "cue", at: 250ms);          // absolute query time is 1.25s
  at marker("cue").at - 1s { /* ... */ } // explicit scene-local 250ms
}
```

CUT applies no hidden scene offset to query results and does not infer or
double-apply this conversion.

## OTIO

CUT exports these values as `Marker.2` objects on the OTIO timeline stack,
including exact rational start/duration, stable ID, kind, color, role, grid,
comment, composition ID, and optional scene ownership. Import reconstructs
timeline annotations and scene-relative annotations into canonical CUT source.

Unknown fields, duplicate annotation or scene IDs, kind/duration conflicts,
off-grid ranges, out-of-bounds ranges, missing scene owners, and ownership that
cannot survive the executable scene partition are stable import errors. CUT
does not silently flatten a scene-owned annotation to the timeline.

## Honest boundary

This slice provides markers, regions, roles, comments, colors, exact clocks,
queries, and native CUT OTIO round-trip. First-class named editorial track
declarations, arbitrary vendor metadata, transition/retime OTIO interchange,
and validation through external NLE adapters remain incomplete. Annotation
metadata is not a substitute for visible captions or rendered callouts.
