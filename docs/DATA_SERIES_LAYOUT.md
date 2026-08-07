# Deterministic data-series layout core

Status: isolated nonvisual reference core. It is not public CUT syntax, a chart
renderer, or evidence that EDU-07/EDU-09 are expressible.

`lib/runtime/reference/data-series-layout.ts` is the deterministic bridge
between a typed `CutEvaluatedTableQuery` series result and a future retained
chart primitive. It exists to settle scale, mark, tick, legend, measurement,
identity, and resource-bound semantics before any package or compiler surface
is exposed.

## Two explicit phases

Phase one, `createCutDataSeriesGeometryPlan(query, spec)`, consumes a validated
`cut-query-result` v1 series and a closed `cut-data-series-layout-spec` v1. It
produces:

- exact scale domains and candidate ticks;
- deterministic, locale-independent tick text;
- exact rational mark coordinates;
- named-series and legend metadata;
- one measurement request for every axis or legend label;
- scale-, series-, mark-, and whole-plan identities.

It does not inspect a system font, invoke a shaper, choose a chart style, or
render pixels.

Phase two first binds measured text through
`createCutLockedTextMeasurementReceipt`. The receipt names a locked font
resource SHA-256, face index, and shaper identity SHA-256, and reports positive
integer bounds in `subpixel-1/64` units for exactly the requested labels.
`resolveCutDataSeriesLayout(plan, receipt)` then applies one closed collision
policy and one bounded legend-flow policy. CUT does not claim that this core
itself measured or shaped the text; a later public vertical slice must provide
and verify that producer.

## Scale contracts

- `linear`: explicit exact-rational `min < max`; 2-256 evenly spaced candidate
  ticks. Mark and tick mapping is exact rational arithmetic.
- `categorical`: String x values only. Categories retain first occurrence
  order, repeated categories share one band center, and the 256-category bound
  is checked before tick allocation.
- `date`: strict `YYYY-MM-DD` proleptic-Gregorian values and explicit domain.
  Day, month, or year steps are integer and bounded. Month/year stepping uses
  the original start-day anchor, so `2023-01-31` advances to `2023-02-28` and
  then `2023-03-31`; it does not accumulate clamping drift.
- `log`: explicit positive exact-rational domain and positive marks only.
  Candidate ticks are the endpoints plus interior powers of ten. Interior
  positions use the named v1 80-bit fixed-point logarithm with bounded series
  work; endpoint positions remain exact. No host floating-point logarithm or
  locale participates.

Numeric tick text is either a canonical fraction or a fixed decimal rounded
half-to-even. Date text is explicitly `iso-date`, `year-month`, or `year`.
Duplicate formatted tick labels fail instead of creating an ambiguous axis.

## Collision and legend policy

Axis candidates are ordered by exact screen coordinate. The first and last
labels are mandatory. If those endpoints cannot coexist with the declared
gap, resolution fails. Interior labels are considered in coordinate order and
retained greedily only when they clear both the prior retained label and the
mandatory final label. Every omitted candidate is reported as
`collision-thinned`; there is no nondeterministic font or browser layout.

Legend entries preserve the declared series order. Their width is
`swatchSize + swatchGap + measured label width`. Items flow left-to-right and
wrap before exceeding `maxWidth`; row count is bounded and overflow fails.

## Identity and locality

- Query result identity is recomputed before planning.
- X and Y scale identities are independent.
- Mark identities bind the typed key, x/value pair, field, exact mapped
  coordinate, and both scale identities. Legend display names do not invalidate
  mark geometry.
- Series metadata and legend measurements bind display names.
- A measurement-only revision changes the receipt and resolved-layout
  identities without changing the geometry-plan, scale, or mark identities.
- Caller order cannot change a measurement receipt: accepted measurements are
  canonicalized into request order.

Every public object is deeply frozen, bounded, and hash-addressed. Unknown
specification fields, unsafe keys, unreduced rationals, stale identities,
out-of-domain data, empty/no-op input, unsupported type/scale pairs, duplicate
keys or names, oversized work, missing measurements, and impossible collisions
fail with stable `CUT_DATA_LAYOUT_*` errors.

Every JavaScript boundary—query result, specification, geometry plan, locked-font
identity, measurement list, and receipt—is copied through a descriptor-only
snapshot before validation or hashing. Proxies, accessors, symbol or
non-enumerable properties, sparse or extended arrays, array subclasses, exotic
object prototypes, cycles, and unsafe keys are rejected. Rejection never invokes
a supplied getter or proxy trap. Validation, identity, and phase-two layout use
only the frozen snapshot, so caller aliases and post-call mutation cannot change
an accepted plan, receipt, or resolved layout.

## Deliberate nonclaims

This core does not expose `.cut` syntax, lower typed IR, load a font, shape
text, draw axes, render marks, choose colors, animate a chart, create accessible
descriptions, or prove data-join semantics. It is not a hidden chart template
or second renderer. EDU-07 and EDU-09 remain unexpressible until the complete
public vertical exists—syntax and types, IR, locked-font measurement, retained
pixels, inspect/diff/cache identity, tests, documentation, and unrelated CUT
studies.
