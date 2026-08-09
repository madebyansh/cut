# Semantic Footage Search Implementation Plan

> **Goal:** ship `cut-lang@0.4.0-alpha.4` so a fresh macOS or Linux install can explicitly install a pinned local CPU CLIP backend, index MP4/MOV footage, search it with text, and extract a provenance-bearing exact match.

## Non-negotiable release proof

From a clean packed or public install, with an isolated `CUT_FOOTAGE_HOME`:

```sh
cut footage setup --backend local --json
cut footage doctor --json
cut footage index media/ --out .cut/footage/index.json --json
cut footage search .cut/footage/index.json --query "a dog outdoors" --out .cut/footage/search.json --json
cut footage extract .cut/footage/search.json --match 1 --handles 1s --out selects/dog.mp4 --json
```

The real q8 CPU model must rank the dog fixture first on macOS arm64 and Ubuntu x64, extraction must publish and validate `selects/dog.mp4` plus `selects/dog.mp4.cut-footage.json`, and the default CUT tarball must contain no ML runtime or model weights.

## Task 1: close the public contracts and exact-time core

**Files:**

- Create `lib/footage/diagnostics.ts`
- Create `lib/footage/contracts.ts`
- Create `lib/footage/range.ts`
- Create `tests/footage-contracts.test.ts`
- Create `tests/footage-range.test.ts`
- Create `schemas/cut-footage-index-v1.schema.json`
- Create `schemas/cut-footage-search-v1.schema.json`
- Create `schemas/cut-footage-extract-v1.schema.json`

**Red:** add hostile/closed-shape tests for the three formats, canonical identity tests, exact rational parsing, frame-grid floor/ceil, half-open chunk ranges, handle clamping, duplicate IDs, unsafe locators, noncanonical rationals, non-finite scores, and bounded collections. Run only the new compiled tests and confirm expected failures.

**Green:** implement the smallest strict decoders and pure range functions. Public time stays `{numerator, denominator}` and scores enter reports only as integer ppm. Canonical identities hash stable JSON with identity fields omitted.

**Verify:** build, run the two new test files, lint touched modules, and `git diff --check`.

## Task 2: bounded discovery, probing, and resumable source planning

**Files:**

- Create `lib/footage/discovery.ts`
- Create `lib/footage/planner.ts`
- Create `tests/footage-discovery.test.ts`
- Create `tests/footage-planner.test.ts`

**Red:** cover sorted recursive MP4/MOV discovery, extension case, ignored non-media, symlink refusal, project escape refusal, file/count/depth budgets, selected-video-stream requirements, exact overlapping chunks, and reuse only when locator/bytes/SHA/probe/backend/chunk policy all match.

**Green:** use `validateProjectLocator`, `resolveProjectFile`, `probeProjectMedia`, and `probeProjectBytes`; do not use `lib/core/indexer.ts`. Plan one-second samples at exact deterministic points inside each chunk and mark unchanged sources reusable.

**Verify:** focused tests and one fixture-media probe through the existing FFmpeg/FFprobe authority.

## Task 3: bounded JSONL sidecar protocol

**Files:**

- Create `lib/footage/sidecar.ts`
- Create `tests/fixtures/footage-deterministic-sidecar.mjs`
- Create `tests/footage-sidecar.test.ts`

**Red:** cover exact handshake, request IDs, `index`, `searchText`, `close`, partial lines, unsolicited output, unknown fields, malformed JSON, duplicate replies, stderr/output overflow, timeout, crash, signal cancellation, and child cleanup.

**Green:** spawn an exact executable/argument list without a shell, cap request/response/stderr bytes and elapsed time, validate every message, kill and drain on failure, and never expose raw stderr or environment values in public diagnostics.

**Verify:** deterministic sidecar tests pass repeatedly and leave no live child.

## Task 4: real optional local CLIP setup and doctor

**Files:**

- Create `adapters/footage-local/package.json`
- Generate `adapters/footage-local/package-lock.json`
- Create `adapters/footage-local/local-clip-sidecar.mjs`
- Create `adapters/footage-local/model.json`
- Create `adapters/footage-local/NOTICE.md`
- Create `lib/footage/setup.ts`
- Create `lib/footage/doctor.ts`
- Create `tests/footage-setup.test.ts`

**Pinned closure:** `@huggingface/transformers@4.2.0`, transitive `onnxruntime-node@1.24.3`, `Xenova/clip-vit-base-patch32` revision `d15189d7028b43f1d3e65039190477f6af591c2a`, CPU q8, 512 dimensions. Verify text graph SHA-256 `73baab855d406190da9faa498cfedf65f15cf309f4cc7385b7b032e6d08e5c3a` and vision graph SHA-256 `583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299`.

**Red:** cover missing backend, unsupported backend, unsafe home, existing verified install, failed staged install, lock contention, runtime/model hash drift, protocol mismatch, offline normal execution, and stable JSON diagnostics. Use a fake npm/model installer for deterministic tests.

**Green:** resolve default storage under the user's home with `CUT_FOOTAGE_HOME` as the explicit test/automation override; copy the locked recipe to a same-filesystem staging directory; run `npm ci --omit=dev --ignore-scripts=false`; prewarm real text and image encoders; hash the pinned graphs; write a closed install manifest; atomically promote only a verified install. `doctor` rechecks files, hashes, handshake, and one deterministic embedding.

**Verify:** deterministic setup tests plus one real isolated setup in a temporary footage home. Normal sidecar runs with remote model access disabled.

## Task 5: index workflow and vector artifact

**Files:**

- Create `lib/footage/indexer.ts`
- Create `tests/footage-indexer.test.ts`
- Extend `lib/project/native-process-authority.ts`
- Extend `lib/runtime/reference/ffmpeg.ts` only where execution evidence is missing

**Red:** generate tiny MP4/MOV fixtures and cover discovery/probe/chunk/sample calls, deterministic frame bytes, normalized 512-d vectors, sorted binary vector records, vector hash/length binding, partial-source resume, backend mismatch rebuild, stale source during work, and cleanup after adapter/FFmpeg failure.

**Green:** extract bounded frame samples through bound FFmpeg, let the sidecar embed them, average and L2-normalize per chunk, publish a compact float32 vector artifact and canonical index together, and reuse only still-valid source records from a prior index.

**Verify:** deterministic adapter workflow twice; second run must prove reuse and byte-identical output when inputs are unchanged.

## Task 6: text search, ranking, dedupe, and stable handoff

**Files:**

- Create `lib/footage/search.ts`
- Create `tests/footage-search.test.ts`

**Red:** cover query normalization/bounds, source/vector/backend stale checks before inference, score clamp and ppm quantization, threshold, limit, deterministic tiebreaks, same-source overlap suppression, no-match reporting, and exact `sourceSelection` output.

**Green:** embed text through the configured sidecar, compute bounded dot products in CUT, normalize candidates once, suppress overlapping lower-ranked hits, and atomically write a strict report. The sidecar never owns public ordering or report bytes.

**Verify:** golden report bytes are stable across repeated runs and input enumeration order.

## Task 7: exact no-clobber extraction

**Files:**

- Create `lib/footage/extract.ts`
- Create `tests/footage-extract.test.ts`
- Extend `lib/project/write-boundary.ts`
- Extend `tests/project-write-boundary.test.ts`

**Red:** cover rank and stable-ID selection, report/source stale checks, handle parsing and clamp, exact half-open re-encode, stream selection, output probe/hash, existing clip or manifest refusal, symlink/ancestor refusal, paired publication rollback, and no partial files.

**Green:** add create-only staged transaction semantics, run bound FFmpeg/FFprobe, verify the staged clip, then atomically publish clip and `<clip>.cut-footage.json`. Never overwrite an existing leaf.

**Verify:** extract the same match twice; first succeeds, second fails with `CUT_FOOTAGE_OUTPUT_EXISTS` and preserves both original hashes.

## Task 8: CLI, docs, packaging, and lightweight-install gates

**Files:**

- Create `lib/footage/index.ts`
- Modify `cli/cut.ts`
- Modify `tests/cli-help.test.ts`
- Create `tests/footage-cli.test.ts`
- Modify `docs/CLI.md`
- Modify `docs/FIRST_USE.md`
- Modify `package.json`
- Modify `scripts/audit-dist-cli-orphans.mjs` if required by the new adapter asset class
- Create or extend installed-package smoke scripts

**Red:** require all five machine-readable commands, closed options, missing-backend errors from an installed tarball, adapter recipe presence, and absence of `@huggingface/transformers`, `onnxruntime-node`, ONNX, and model cache bytes from CUT's root dependency tree/tarball.

**Green:** route `footage setup|doctor|index|search|extract`, add `dist-cli/lib/footage` and `adapters/footage-local/**` to package files, document exact setup/size/offline behavior, and preserve every existing command.

**Verify:** `npm pack --json`, inspect tarball inventory, install in a clean consumer, run normal CUT smoke and missing/setup diagnostics.

## Task 9: real-model macOS/Linux release smoke

**Files:**

- Add two tiny clearly different, redistribution-safe source images or generated fixtures with license/provenance notes
- Create `scripts/run-footage-real-smoke.mjs`
- Create `scripts/assert-footage-real-smoke.mjs`
- Modify `.github/workflows/ci.yml`

**Red:** assertion script must reject wrong rank, missing margin, wrong model/revision/hash, remote access during normal commands, extraction drift, and missing manifest/hash/probe evidence.

**Green:** cache the exact runtime/model by lock/revision, create short image-based videos with FFmpeg, run the installed tarball's full real workflow on macOS arm64 and Ubuntu x64 Node 20/24, and assert the expected first match plus extraction evidence. Keep deterministic unit tests independent of network/model availability.

**Verify:** local M4 CPU smoke passes, then every GitHub matrix job passes on the exact PR head.

## Task 10: review, merge, publish, and public-install proof

**Files:**

- Bump `package.json`, `npm-shrinkwrap.json`, `lib/version.ts`, `CHANGELOG.md`, and version assertions to `0.4.0-alpha.4`
- Update issue/PR text without claiming deferred live preview or Qwen work

**Steps:**

1. Run focused tests after each red/green cycle.
2. Run `npm run cli:build`, full `npm run verify`, `npm pack --dry-run`, and clean packed-install workflow.
3. Request independent code review; fix every real issue and rerun affected gates.
4. Push the branch, open a non-draft PR, and wait for exact-head CI green.
5. Squash-merge only while head/base/checks are unchanged.
6. Wait for exact merged-main CI green.
7. Publish `cut-lang@0.4.0-alpha.4`, verify registry metadata/tarball identity, install from the public registry into a clean consumer, and repeat setup/index/search/extract.
8. Mark the goal complete only after that public proof succeeds.
