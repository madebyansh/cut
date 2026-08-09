# CUT local packages

Status: executable local/file vertical slice in CUT `0.4.0-alpha.3`. Local/file
distribution is the only supported distribution boundary. Registry, Git,
native, WASM, shader-plugin, and network installation are not implemented.
The separate bounded zero-host-import executable ABI is documented in
[`EXTENSIONS.md`](EXTENSIONS.md); it is not a source-package escape hatch.

## Package model

A package is a regular, non-symlink directory containing a strict
`cut.package.json` and a UTF-8 `.cut` entry module. CUT source remains the
implementation: a package cannot provide a hidden graph, compiler callback,
JavaScript module, native operation, or title-specific render path.

Package entry modules may declare components using the public CUT language and
import built-in or manifest-declared packages. The v1 library boundary permits
language, project, import, and component declarations. Application roots may
also contain ordinary assets, constants, timelines, and render exports.

The current third-party proof is split between:

- `examples/packages/impact-cards`, an independent package implemented with
public `Rect` and `Circle` components;
- `examples/package-proof`, an application that imports `ImpactCard` by its
  package specifier.

The example has a CLI-generated lock and executable frame proof. The public
checker derives `ImpactCard`'s signature from package source; the compiler
expands its component body with package source provenance into ordinary
`cut.visual.rect`, `cut.visual.circle`, and `cut.kernel.fragment` IR; and the
reference compositor pixel-tests the dark consumer background, warm card,
coral rail, and coral circle. Resolver-only success is not runtime success.
The root exact-tarball verifier ships both directories, copies them from the
installed payload, runs `cut package verify`, checks the consumer, creates its
audiovisual lock, and renders the declared 320×180 preview. The source-level
pixel test remains the stronger color/placement proof; the clean install proves
the public package is not a source-checkout-only fixture.

`ImpactCard` accepts explicit canvas `x` and `y` parameters and derives its
child positions with ordinary exact CUT arithmetic. This proves source-package
expansion and parameter binding. It does not claim a retained component-local
coordinate system, which is a separate language/runtime capability.

## Manifest v1

```json
{
  "format": "cut-package",
  "manifestVersion": 1,
  "name": "@example/cards",
  "version": "1.2.0",
  "language": "0.4",
  "entry": "index.cut",
  "capabilities": ["visual"],
  "dependencies": {
    "@example/palette": {
      "source": "file:../palette",
      "version": "^1.0.0",
      "integrity": "sha256-<64 lowercase hex characters>"
    }
  },
  "exports": {
    "Card": {
      "kind": "component",
      "declaration": "Card",
      "documentation": "A reusable visual card."
    }
  },
  "integrity": {
    "algorithm": "sha256",
    "files": {
      "index.cut": "<64 lowercase hex characters>"
    }
  }
}
```

The loader is closed and budgeted. Unknown fields, duplicate decoded JSON
keys, unsafe keys, malformed UTF-8, oversized input, invalid SemVer, unsupported
ranges, non-canonical paths, absolute paths, symlinks, missing files, and hash
mismatches fail with stable `CUT_PACKAGE_*` diagnostics.

Package names are lowercase unscoped or scoped names. `cut:` and `@cut/` are
reserved for built-ins. Versions implement bounded SemVer 2.0 precedence.
Dependencies accept exact, caret, or tilde ranges and always pair that range
with one exact content-integrity pin.

Exports name component declarations; they do not restate parameter or return
types. CUT parses the exported declaration and derives the checker signature
from that AST. A manifest therefore cannot claim one signature while executing
another.

## Capabilities

Manifest v1 recognizes these declarations:

- `visual`, `audio`, `av`, and `data` for graph domains;
- `media-read` for a public `read` operation or a native CUT kernel that consumes a locked media/font/data asset;
- `analysis`, `generation`, and `external` for the matching effect kinds.

The resolver derives requirements from component return domains and the public
package operations actually called inside component bodies. A missing
capability fails before package execution. Declaring `external` does not grant
arbitrary code execution: source packages still have no JavaScript, shell, or
native extension boundary.

## Dependency lock

`cut.package.lock` v1 contains:

- the root package name, version, manifest identity, and content identity;
- one strictly sorted entry per resolved package;
- canonical project-relative `file:` source, exact version, entry hash,
  manifest/content identities, capabilities, and dependency edges;
- a canonical SHA-256 integrity over the complete lock body.

Resolution rejects name/source disagreement, incompatible versions, stale
integrity pins, duplicate instances, dependency conflicts, cycles, missing
edges, symlink traversal, depth/package/file/byte budget overruns, and lock
tampering. Locks contain no absolute machine paths.

Package content identity includes the semantic manifest, declared file hashes,
and exact dependency pins. The compiler-facing package identity additionally
derives its public API from parsed declarations. Resolved source packages and
their transitive dependencies are pinned in sorted CutAVIR modules. Source
package identities participate in expanded-node hashes, scene cache keys,
build IDs, and media locks alongside the built-in runtime package that executes
each ordinary node.

`cut.package.lock` is the dependency/source-package trust artifact. It is not
the audiovisual `cut.lock`, which pins the compiled entry, media/font/data
resources and native probe/runtime identity. Editing a packaged root entry
makes both identities stale. Restore them explicitly in this order:

```sh
cut package lock --project .
cut check main.cut
cut lock main.cut --out cut.lock
```

## Operations

Asset discovery is separate from package/runtime trust. Use the bounded local
[`cut asset search`](ASSET_CATALOG.md) workflow to find provenance-bearing
candidates, then copy and verify selected bytes, declare them explicitly in CUT
source, and run `cut lock`. Catalog rows and package names never grant media,
font, data, caption, transcript, LUT, or sequence authority by themselves.

The public CLI exposes deterministic init, add, remove, list, update, lock, and
verify operations. Every command supports `--json` with a stable success or
diagnostic envelope:

```sh
cut package init . --name my-film --entry main.cut
cut package add ../impact-cards --project .
cut package list --project .
cut package update --project .
cut package lock --project .
cut package verify --project .
cut package remove @cut-proof/impact-cards --project .
```

`add` reads the target package, validates its declared bytes and source module,
records its canonical relative source, chooses an exact or compatible SemVer
range, pins exact content integrity, resolves the complete graph, and writes a
new lock. `update` is the explicit operation that accepts changed local package
bytes and rewrites their pins. `lock` explicitly refreshes the root package's
declared file hashes and atomically regenerates its dependency lock. `verify`
checks the outer digest, semantic lock graph, current manifests, dependency
bytes, and source packages without changing trust. Ordinary check/build/render
operations fail on stale or missing locks rather than updating trust implicitly.

When `cut.package.json` exists beside the targeted program, ordinary
check/build/lock/inspect/test/preview/render commands require the program to be
that manifest's exact entry, load the existing `cut.package.lock`, re-resolve
the bounded local graph, and compare the complete canonical lock before type
checking. Missing, stale, tampered, conflicting, or byte-mismatched locks fail
with stable `CUT_PACKAGE_*` diagnostics. Package-source parser/type diagnostics
retain the package module path and exact source span in both human and JSON
`cut check` output.

## Current limitations

The npm release artifact is produced with `npm run pack:release`. That command
copies npm's allowlisted payload to an ephemeral staging directory, removes only
source-maintainer scripts from the staged `package.json`, records the omitted
script names under `cutArtifact`, and packs without mutating the checkout. The
exact packed-install verifier requires this runtime-profile manifest.

- Only local `file:` sources exist; there is no invented registry.
- Library entry modules cannot yet export functions, values, assets, timelines,
  native effects, or arbitrary implementation files.
- Packages run as source-level CUT component expansion, not an isolation
  sandbox for untrusted native media decoders.
- A separate `cut.extension.json` v1 manifest and zero-host-import WASM worker
  now make host-capability denial executable. Extension bytes are not yet
  integrated into package dependency resolution, CUT effect jobs, or render
  locks, and native extensions remain an explicit fail-closed refusal.
- The exact packed-install verifier classifies every packed entry and scans
  every non-reviewed-binary file as fatal UTF-8, so executable `.mjs`, source
  maps and extensionless text cannot silently evade private-path or secret
  checks. Its canonical CycloneDX 1.5 SBOM is reconciled against every
  production and optional shrinkwrap locator and dependency edge, not merely the
  package's direct dependency names. Missing, extra, drifted-integrity and
  development-only components fail with stable `CUT_RELEASE_SBOM_*` codes.
  The verifier also emits a
  deterministic unsigned provenance sidecar binding the exact tarball,
  payload, shrinkwrap, SBOM, builder and same-source replay. Package signing,
  registry provenance, revocation, collaborative installation,
  content-addressed global stores, and package-integrated/domain-specific
  WASM/native ABIs remain post-alpha work.
- Full formatting-insensitive semantic identity remains a language-wide release
  gate; package byte integrity intentionally still detects every declared-file
  change.
