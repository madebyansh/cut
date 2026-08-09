# task 3 report — bounded jsonl sidecar protocol

## status

complete. one focused commit: `feat: add bounded footage sidecar protocol`.

## files

- `lib/footage/sidecar.ts`
- `tests/fixtures/footage-deterministic-sidecar.mjs`
- `tests/footage-sidecar.test.ts`

## red / green evidence

- red: `node node_modules/typescript/bin/tsc -p tsconfig.cli.json && node --test dist-cli/tests/footage-sidecar.test.js`
  - expected failure: `Cannot find module '../lib/footage/sidecar'`.
- green (twice): `node node_modules/typescript/bin/tsc -p tsconfig.cli.json && node --test dist-cli/tests/footage-sidecar.test.js`
  - `7` pass, `0` fail both runs; timeout, crash, and abort assertions confirm no live child PID.
- final: `node node_modules/typescript/bin/tsc -p tsconfig.cli.json && node --test dist-cli/tests/footage-sidecar.test.js && node node_modules/eslint/bin/eslint.js lib/footage/sidecar.ts tests/footage-sidecar.test.ts tests/fixtures/footage-deterministic-sidecar.mjs && git diff --check`
  - passed; lint and whitespace check produced no findings.

## protocol decisions implemented

- starts a single serial session using exact executable and args, no shell, non-detached piped stdio, and only the explicit `CUT_FOOTAGE_CACHE_DIR` / `CUT_FOOTAGE_MODEL_DIR` environment allowlist.
- validates and freezes a closed handshake, comparing it exactly with the caller-supplied identity.
- validates closed index/search/close JSONL records; index transfers staged plan and destination paths, while search transfers bound artifact evidence and bounded text.
- keeps response settlement pending through a stdout data turn, so duplicate replies fail closed before callers receive success.
- caps request, response-line, aggregate stdout, stderr, candidate count, and operation durations; default response caps are 16 MiB line / 32 MiB aggregate.
- terminates on protocol errors, overflow, timeout, crash, or abort with SIGTERM then bounded SIGKILL fallback, draining streams and withholding public stderr, paths, and environment values.

## self-review

- hostile fixture covers exact handshake, request IDs, partial lines, unsolicited/unknown/malformed/duplicate output, bounds, timeout, crash, abort, invalid search candidates, idempotent close, and environment refusal.
- no model adapter, setup, doctor operation, or real vector indexing workflow was added.

## review round 1

- status: complete after focused follow-up fix commit `fix: harden footage sidecar limits and close lifecycle`.
- red: the 14-test focused sidecar suite exposed five failures: upward/unknown limit overrides, request overflow cleanup, handshake/index dimension drift, queued-close early exit, and close acknowledgement without a clean exit.
- green: `node node_modules/typescript/bin/tsc -p tsconfig.cli.json && node --test dist-cli/tests/footage-sidecar.test.js` passes all 14 tests, including close acknowledgement plus hang/exit-17 and no-live-PID checks.
- hard limits now accept only named downward overrides. a close completes only after its request is actually written, acknowledged, and followed by exit code zero; its timeout covers the full acknowledgement-and-exit lifetime.
- index artifact dimensions must exactly match the immutable handshake. new diagnostic tests prove child stderr/path-like text does not reach public errors, request overflow terminates without writing, bad executable startup fails closed, and the explicit environment does not inherit `PATH`.

## review round 2

- status: complete after focused follow-up fix commit `fix: seal footage sidecar after close`.
- red: a deterministic sidecar accepted post-close `index` / `searchText` requests while close remained pending; the new test observed fulfilled work after `session.close()` had been called.
- green: the 15-test focused suite passes twice. close intent now seals the session synchronously: later non-close public requests reject before validation or child writes, while a request already queued before close remains ordered ahead of close and completes normally.
