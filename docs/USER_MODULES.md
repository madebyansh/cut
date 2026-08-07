# User modules and pure functions

Status: executable CUT 0.4 alpha slice. This is deliberately narrower than a
complete 1.0 module system, so the language contract remains PARTIAL.

CUT source can share typed values, bounded pure functions, collections, and
components through ordinary project files. The entry source stays canonical:
there is no generated JSON graph, remote model, module runtime, or hidden
interpreter.

## Five-minute example

`lib/theme.cut`:

```cut
cut 0.4;
import { Rect } from "cut:visual";

const base: Length = 20px;
function twice(value: Length) -> Length = value * 2;

component Card(size: Length, color: Color) -> Visual {
  Rect(width: size, height: size, fill: color);
}

export spacing = twice(base);
export twice = twice;
export palette = [#ff2200, #0044ff];
export Card = Card;
```

`main.cut`:

```cut
cut 0.4;
project "Module example";
import { Card, palette, spacing, twice } from "./lib/theme.cut";

timeline main(duration: 1s, fps: 24, width: 320px, height: 180px) {
  scene proof(duration: 1s) {
    Card(size: twice(spacing), color: palette[0]);
  }
}

export final = render(main);
```

Run the normal deterministic workflow:

```sh
cut check main.cut --json
cut fmt lib/theme.cut --check
cut lint main.cut --json
cut inspect main.cut --json
cut lock main.cut --out cut.lock
cut build main.cut --lock cut.lock
```

`cut lint` follows entry and user-module exports. `cut inspect --json` reports
the exact `sourceModules` identities and module provenance on expanded nodes.

## Retained visual component boundary

An imported or local pure `-> Visual` component may own a retained tile only in
this exact alpha shape:

```text
import { LocalSpace, Rect } from "cut:visual";

component Plate(color: Color) -> Visual {
  LocalSpace(width: 320px, height: 180px, origin: { x: 160px, y: 90px }) {
    Rect(width: 320px, height: 180px, x: 160px, y: 90px, fill: color);
  }
}

// Direct scene root; no invocation children.
Plate(color: #e85d04) as plate;
set plate.x = 120px;
set plate.y = -40px;
set plate.scale = 1.1;
set plate.rotation = 4deg;
set plate.opacity = 90%;
```

The compiler substitutes component parameters, then emits a pure visual
`cut.kernel.fragment` with zero runtime inputs or editorial payload and exactly
one equal-interval `LocalSpace` child. The call must be a direct scene visual
root. Nesting it in another component, group, composition root, or other owner;
adding a second component-body sibling or invocation child; or setting
anchor/skew is unsupported and fails. Only `opacity`, `x`, `y`, `scale`, and
`rotation` are executable fragment controls. This is a reusable
public-language/runtime path, not component-name dispatch or a private package
renderer. Other independent roots in the same scene are allowed.

At render time the component's retained affine placement enters the same single
composition-frame aggregate as every other admitted affine LocalSpace owner;
it does not receive a private component-only budget. The aggregate includes
actual nested parent-LocalSpace output sizes and all executed MotionBlur shutter
samples before tile work, under the shared 256-transform, 1 GiB live-output,
and 2 GiB unscheduled-peak caps. Zero-skew entries preserve V2 work identity;
nonzero skew elsewhere in the same frame selects the installed V3
scale -> simultaneous-shear -> rotation aggregate. This accounting does not
make component nesting, or `MotionBlur -> Group -> LocalSpace`, executable.

## Path and initialization contract

- A user-module import must start with `./` and end in `.cut`, for example
  `./lib/theme.cut`.
- The path is relative to the project root: the directory containing the entry
  `.cut` source. It is not relative to the importing module. One spelling
  therefore identifies one file throughout the graph.
- Forward slashes are mandatory. Empty segments, `.` segments, `..`, absolute
  paths, drive paths, control characters, missing files, directories, and
  symbolic links fail closed.
- CUT checks both lexical containment and `realpath` containment.
- The graph is a DAG. Import cycles and repeated imports of one module from the
  same source are errors.
- Every user module contains exactly one `cut 0.4;` declaration and no
  `project` declaration. In this slice, assets and timelines remain owned by the
  entry source; pass typed assets into module components.
- Resource ceilings are 256 modules, 1 MiB per module, 16 MiB total source, and
  64 import levels. Lower custom ceilings may be used by embedders; public
  ceilings cannot be raised through the API.

Package imports such as `cut:visual` and locked third-party package names keep
their existing resolution path. A string beginning with `.` is never treated
as a package, and a package name is never guessed to be a user file.

## Exports and privacy

`export publicName = expression;` exposes one compile-time value. A function or
component export must directly name a function or component declared in that
module:

```cut
export rhythm = [250ms, 500ms, 250ms];
export twice = twice;
export Card = Card;
```

Declarations are private unless explicitly exported. Importing a private name,
an absent name, a duplicate name, or a type-incompatible use produces a stable,
source-located diagnostic. Callable aliases and callable re-exports are not
implemented in this slice; this keeps implementation provenance closed and
unambiguous.

## Pure expression functions

The public syntax is:

```cut
function name(parameter: Type, optional: Type = default) -> ReturnType = expression;
```

Functions are type checked at their definition and every call site. They can
use literals, exact dimensional arithmetic, booleans, records, collections,
index/member access, other acyclic pure functions, and supported pure
compile-time package functions. Parameters and results must be compile-time
values. Visual/audio nodes, timelines, render targets, assets, analysis,
generation, media reads, and external effects are refused.

There is no runtime function interpreter. Calls are expanded and evaluated by
the compiler into resolved typed IR values. Recursion is refused. Expansion is
bounded by the shared 64-level expansion ceiling, 100,000 calls, and 1,000,000
compile-time value nodes. Exceeding a bound produces a stable located
diagnostic; CUT does not hang, truncate a collection, or silently leave an
unresolved call in CutAVIR.

## Determinism, locks, and cache identity

Each loaded module appears in CutAVIR `sourceModules` with its canonical
specifier, exact UTF-8 byte count, and SHA-256 digest. `cut.lock` stores and
revalidates the same list and independently re-reads those files when creating
or applying a lock. A changed module therefore makes an existing lock stale.

Semantic build identity deliberately excludes exact source bytes, just as it
excludes the entry `sourceHash`. Comments and formatting can change the module
digest without changing the semantic graph or semantic diff. A value,
function, or component change that affects executable lowering changes node,
composition, and build identities normally. This separates reproducible source
evidence from executable meaning.

Legacy single-file programs have no `sourceModules` field and retain their
existing lowering and serialized IR shape when the feature is unused.

## Stable diagnostics

The machine-readable surface uses the normal `cut check --json` envelope and
includes the canonical module path, line, and column. Module-specific codes in
this slice include:

- `CUT_MODULE_SPECIFIER`, `CUT_MODULE_ESCAPE`, `CUT_MODULE_SYMLINK`,
  `CUT_MODULE_MISSING`, `CUT_MODULE_FILE`, `CUT_MODULE_IO`, and
  `CUT_MODULE_ENCODING`;
- `CUT_MODULE_CYCLE`, `CUT_MODULE_DUPLICATE_IMPORT`, and `CUT_MODULE_LIMIT`;
- `CUT_MODULE_PRIVATE_SYMBOL`, `CUT_MODULE_MISSING_SYMBOL`,
  `CUT_MODULE_DUPLICATE_EXPORT`, and `CUT_MODULE_EXPORT_TYPE`;
- `CUT_MODULE_FUNCTION_TYPE`, `CUT_MODULE_FUNCTION_RETURN`,
  `CUT_MODULE_FUNCTION_EFFECT`, `CUT_MODULE_FUNCTION_CYCLE`,
  `CUT_MODULE_FUNCTION_LIMIT`, and `CUT_MODULE_VALUE_LIMIT`.

Parser and dimensional type diagnostics retain their existing stable CUT codes.

## Honest limitations

This slice does not yet provide namespaces, qualified imports, type aliases,
generic user functions, callable re-exports, module-owned assets/timelines,
conditional imports, dynamic loading, or a full language-server module index.
It supports reusable components but does not turn functions into runtime node
factories: audiovisual structure remains the responsibility of typed
components. The retained visual boundary above is unary and scene-root-only;
general nested component composition is not implied. Those omissions keep
CUT's 1.0 language/module contract PARTIAL.
