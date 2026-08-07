# Typed table/query core

Status: isolated executable foundation for CUT 0.4 alpha. It is not yet a
public CUT language feature, renderer feature, EDU-08 promotion, or CUT 1.0
claim.

`lib/language/table-query.ts` establishes the resource-side semantics needed
for general tabular work without pretending that a compile-time helper can
read `DataAsset` bytes. The current public checker, compiler, package manifest,
CutAVIR, lock pipeline, reference runtime, inspect/diff surfaces, cache graph,
and visual components do not call this module yet.

## Honest boundary

There are four distinct values:

1. A source document is strict UTF-8 `cut-table` version 1 stored in a
   `DataAsset`.
2. A `cut-query-plan` version 1 is a closed typed declaration. Its source
   schemas are available for checking before resource bytes are read.
3. Evaluation occurs only after a caller supplies cut.lock v2 state plus the
   exact resource bytes. Size and SHA-256 are rechecked before parsing, and the
   file schema must exactly equal the plan schema.
4. A table or series `cut-query-result` is data. Series extraction does not
   plot pixels and there is no private chart renderer. A series retains its
   typed number/string/date x field, typed exact composite keys, exact-number
   values, and point order so a separate future scale/label/plot layer need not
   reinterpret strings.

The eventual runtime adapter should map a fully verified locked `IRResource`
to the small `CutLockedTableInput` envelope. It must not weaken or duplicate
the existing lock verifier.

The JS API accepts only direct ordinary `Uint8Array` or `Buffer` instances,
rejects proxies and `SharedArrayBuffer`, and immediately copies the supplied
view. Declared length, SHA-256, UTF-8 scanning, and parsing all use that one
private snapshot, so caller mutation cannot split hash and semantic identity.
Closed plan/resource objects and arrays must be direct plain data structures;
proxies, accessors, symbol keys, non-enumerable fields, array extras, and sparse
arrays fail before a getter or element is read.

## `cut-table` version 1

The file is a closed JSON object:

```json
{
  "format": "cut-table",
  "version": 1,
  "schema": {
    "fields": [
      { "name": "id", "type": { "kind": "string", "maxBytes": 32 } },
      { "name": "observed", "type": { "kind": "date" } },
      { "name": "included", "type": { "kind": "boolean" } },
      { "name": "value", "type": { "kind": "number" } }
    ],
    "key": ["id"]
  },
  "rows": [
    {
      "id": "sample_a",
      "observed": "2024-02-29",
      "included": true,
      "value": { "numerator": "5", "denominator": "2" }
    }
  ]
}
```

Field, source, step, and key names are bounded safe ASCII identifiers.
Prototype-control names are refused. Every row contains exactly the schema
fields, and the nonempty ordered composite key is unique. Numbers are reduced
canonical rational strings; authoritative cells never pass through a JS
floating-point number. Strings retain their exact decoded Unicode sequence,
are bounded by UTF-8 byte count, and are never normalized. Dates are real
proleptic-Gregorian `YYYY-MM-DD` values, including the full century/400-year
leap rule.

Before `JSON.parse` constructs a value, a bounded structural scanner proves
valid syntax, fatal UTF-8 decoding, depth/node/string limits, well-formed
Unicode, and unique decoded object keys. Thus `"id"` and `"\u0069d"` cannot
silently overwrite one another.

## Closed typed plans

A plan declares ordered sources, ordered steps, and one result relation. Each
source repeats its expected schema because type checking happens before the
locked bytes are available. Steps may reference only earlier sources/steps:

- `filter` uses a closed compare/and/or/not predicate tree and typed literals;
- `inner-join` uses one or more typed equality pairs, an explicit projection,
  explicit non-conflicting aliases, and an explicit output key;
- `group` declares one or more source fields and output aliases;
- `aggregate` consumes only a group and supports exact `count`, `sum`, `mean`,
  `min`, and `max` (`sum`/`mean` are numeric; Boolean ordering is refused);
- `sort` declares typed fields and ascending/descending direction; and
- terminal `series` declares one number/string/date x field and one or more
  exact-number value fields.

Unknown fields, forward references, non-table inputs, join type mismatches,
duplicate aliases, schema conflicts, invalid aggregate types, intermediate
group results, and operations after a series fail during plan validation,
before any resource bytes are read. There is no arbitrary expression, callback,
code execution, or `eval` path.

## Deterministic order and identity

- source table rows retain file order;
- filter retains input order;
- inner join is left-major and then right-source order;
- groups appear at the first matching input row;
- aggregate retains group order;
- sort compares strings by unsigned UTF-8 bytes and explicitly breaks complete
  ties by input index; and
- series points retain input table order.

Composite row/join/group identities encode arrays of type-tagged cells as
canonical JSON. They do not concatenate delimiters. Schema, locked source,
checked plan, and evaluated result each expose a SHA-256 identity. Source
identity binds resource id, byte digest/length, schema, and rows. Result
identity binds the ordered plan sources, checked plan, inferred output schema,
and exact output rows/points. Reordering the supplied resource envelope array
is non-semantic; changing locked bytes, plan semantics, or output is semantic.

## Work bounds and diagnostics

Hard ceilings cover individual/aggregate input bytes, JSON depth/nodes/string
bytes, fields, source rows/cells, rational digits, sources, steps, predicate
nodes, join output rows, groups, result rows, and result cells. Callers may
request lower limits but cannot raise a hard ceiling. Join cardinality and
result cells are counted before output row materialization; group creation is
checked before another group allocation; filter, sort, aggregate, and series
preflight their result shapes.

Failures use `CutTableQueryError` with stable `CUT_TABLE_*` or `CUT_QUERY_*`
codes and exact logical paths. `tests/table-query-core.test.ts` proves actual
rows, cells, exact aggregates, series points, byte/schema/identity binding,
order laws, malformed UTF-8, decoded duplicate keys, Gregorian dates,
non-normalization, rational/key/schema conflicts, and hostile resource,
cardinality, allocation, JSON, and predicate budgets. It also proves the byte
snapshot boundary and refuses shared/proxied/accessor/symbol-bearing inputs.

## Pending public vertical

Before EDU-08 can change classification, CUT still needs all of the following:

- public CUT schema/plan constructors and nominal member types;
- checked lowering into a versioned typed IR plan rather than a hidden call;
- lock-time/runtime resource ownership and exact schema validation;
- deterministic evaluation wired into the verified input session;
- IR loader hostility checks, inspect/diff/cache identity, and stable
  source-located diagnostics;
- an explicit bridge from series data to ordinary public visual primitives or
  a separately specified public scale/plot layer; and
- two unrelated public studies using original redistributable data, with tests
  that prove output rows/cells/aggregates and rendered pixels.

Until that vertical executes, the generality benchmark must continue to report
EDU-08 as unexpressible. EDU-07 and EDU-09 also remain open: this core does not
provide legends, axes, ticks, collision layout, logarithmic scales, or visual
date/category scales.
