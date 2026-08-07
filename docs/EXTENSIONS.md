# CUT extension boundary

Status: bounded public ABI slice in CUT `0.4.0-alpha.2`. This is not a claim
that arbitrary native plugins or untrusted media are safe.

Source packages remain ordinary `.cut` component expansion under
[`PACKAGES.md`](PACKAGES.md). An executable extension instead has a separate,
closed `cut.extension.json` manifest. The extension loader refuses a directory
that also contains `cut.package.json`; the source-package resolver never loads
or executes extension bytes.

## Manifest and capability vocabulary

[`cut-extension-v1.schema.json`](../schemas/cut-extension-v1.schema.json) is
the machine-readable manifest. It binds:

- exact extension name and semantic version;
- one `byte-processor`, `analysis`, `audio-processor`, `generator`, or `shader`
  declared domain;
- exact `cut-extension-wasm-byte-v1` ABI;
- implementation format, project-relative entry and SHA-256;
- determinism tier;
- hard wall-time, fixed-memory, module/input/output and concurrency budgets;
- explicit `filesystem:read-assets`, `filesystem:write-output`,
  `network:https`, `gpu:compute`, `native:host`, and `secret:read`
  capabilities.

The standard JSON Schema owns the closed structural vocabulary. Its
`x-cut-semanticValidation` annotation names the shipped
`validateCutExtensionManifest` validator that additionally enforces the
cross-field memory equation. A generic JSON Schema pass alone is not extension
admission and does not claim to execute that custom annotation.

Declaring a capability is not a grant. The v1 reference release grants none of
those host capabilities. Any non-empty capability list fails with
`CUT_EXTENSION_CAPABILITY_DENIED` before the implementation file is opened or a
worker is created. A WebAssembly module that imports anything except
`cut.memory` fails `CUT_EXTENSION_IMPORT_DENIED`. Native implementations fail
`CUT_EXTENSION_IMPLEMENTATION_DENIED`; there is no in-process, trusted-name, or
silent fallback.

## Executable ABI

The only executable v1 format is WebAssembly with exactly:

- one imported memory named `cut.memory`;
- one exported function `cut_abi_version() -> i32`, which must return `1`;
- one exported function
  `cut_process(inputOffset, inputLength, outputOffset, outputCapacity) -> i32`,
  which returns the written output length.

CUT owns a fresh fixed-maximum memory for each run. Input starts at byte zero;
output begins at the next 16-byte boundary. The extension cannot import a
clock, entropy, filesystem, network, GPU, native function, secret provider, or
process function. A dedicated Worker thread is used for bounded termination; it
is not described as an OS process or container sandbox. CUT gives termination
250 milliseconds to confirm. Rejection or expiry produces
`CUT_EXTENSION_WORKER_TERMINATION`, quarantines that exact manifest identity
for the rest of the process, and releases ordinary active-execution accounting;
later calls for the quarantined identity fail even when its declared
`maximumConcurrency` is greater than one, while unrelated identities remain
admissible. Input/output and memory admission happen before execution, and one
exact extension identity cannot exceed its declared in-process concurrency.

Release execution uses two fresh instances and requires byte-identical output
on the identified CUT/Node/V8/platform runtime. Only the `same-runtime-byte`
determinism tier is admitted. The report is path-free and
binds manifest/implementation/input/output hashes, budgets, the isolation
profile and the two-run reconciliation. Verification authenticates the module,
imports, exports, ABI handshake and exact function signatures without claiming
that `cut_process` has run; its report says reconciliation is required at
execution and not yet performed. Every report also binds the worker-source
SHA-256; the exact shipped parent-module byte hashes; the worker resource
limits, hard ceilings, concurrency/timeout/termination policies and
confirmation deadline; and the exact CUT, Node, Node ABI, V8, platform, and
architecture identity.

The current programmatic entry points are
`verifyCutExtension(directory)` and
`executeCutExtension(directory, input)` from
`dist-cli/lib/package/extension.js`. The exact packed-artifact gate must import
that installed module without source-tree resolution and execute both a passing
fixture and the denial corpus before this boundary counts as public release
evidence.

## Honest limitations

- Only `byte-processor` executes. The other declared domains fail
  `CUT_EXTENSION_KIND_DENIED`; a generic byte transform is not presented as a
  shader, audio processor, generator, or analysis ABI.
- Extension outputs are bounded bytes. They are not yet connected to CUT
  effect jobs, picture nodes, audio nodes, cache identity, or render locks.
- `shader` and `audio-processor` describe the intended domain; there is no GPU
  shader ABI or sample-block audio ABI yet.
- Native implementation is an explicit refusal, not an implemented native
  sandbox.
- The report authenticates the shipped security-relevant parent module set and
  the identified Node runtime. It does not claim that Node built-ins or the
  operating-system kernel are part of CUT's own byte closure.
- FFmpeg, ffprobe, Sharp and codec/image parsers still execute with the invoking
  user's privileges. This extension worker does not isolate native media.
- The studio still needs managed authentication, rate/concurrency controls,
  isolated render workers, per-user storage quotas and retention controls.

Accordingly this slice materially advances the package capability and
extension ABI gates, but it does not by itself satisfy `PKG-03`, `PKG-04`, or
`REL-05` at their complete 1.0 scope.
