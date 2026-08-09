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
