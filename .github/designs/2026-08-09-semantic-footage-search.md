# Semantic Footage Search Design

## Goal

CUT should let an editor search hours of MP4/MOV footage with ordinary language, inspect ranked matches, and extract one exact source range without turning semantic search into part of the authoritative renderer.

The first useful workflow is:

```sh
cut footage setup --backend local
cut footage index media/ --out .cut/footage/index.json
cut footage search .cut/footage/index.json --query "founder opens the live dashboard" --out .cut/footage/search.json
cut footage extract .cut/footage/search.json --match 1 --handles 1s --out selects/dashboard.mp4
```

Search results are non-authoritative candidate evidence. Extraction is reproducible and provenance-bearing, but it does not silently edit a `.cut` program.

## Approaches Considered

### 1. CUT-owned contracts with an optional local Node sidecar (selected)

The npm package owns CLI parsing, manifests, validation, process limits, source hashing, search-result normalization, and exact extraction. An explicitly installed Node sidecar owns CLIP model loading and frame/text embedding. The two processes communicate through a small versioned JSON-lines protocol.

This keeps `npm install -g cut-lang` lightweight, works on CPU-only macOS and Linux, lets the local model evolve without changing CUT's public result format, and keeps untrusted model output outside the compositor. It requires one explicit setup step for users who want semantic search.

### 2. Wrap SentrySearch's current CLI directly

This is the quickest demo, but CUT would depend on human-formatted output, SentrySearch's private local state, and command behavior it does not own. Stable provenance, stale-source checks, and live-preview handoff would be fragile. This is acceptable as a research spike, not as CUT's public contract.

### 3. Put the model runtime in CUT's default npm dependency tree

This removes the explicit setup command, but it would add large platform-specific ML dependencies to every CUT install and make Apple Metal, CUDA, and CPU compatibility part of the core package. CUT instead uses npm as the explicit backend installer in a versioned user cache. The core package does not depend on the ML runtime.

## Implementation Scope

The implementation will establish the complete CUT-owned boundary without depending on the unfinished live-preview branch:

- `cut footage setup`, `index`, `search`, `extract`, and `doctor` command contracts
- versioned index, search-report, and extraction-manifest validators
- a bounded sidecar runner with handshake, time, memory/output, and cancellation limits
- recursive MP4/MOV discovery with stable ordering and stale-source detection
- overlapping chunk planning and near-duplicate result suppression
- a real local CPU CLIP adapter with pinned runtime, model revision, and setup smoke
- text-search normalization through the same executable protocol used by the real and deterministic test adapters
- exact half-open extraction through CUT's existing bound FFmpeg/FFprobe authority
- a stable handoff object that live preview can consume later
- real-model macOS and Linux smoke coverage without adding ML packages to default npm dependencies

The selected v1 backend is OpenAI CLIP `ViT-B/32`, converted for ONNX and pinned through `Xenova/clip-vit-base-patch32`. It performs real frame-text retrieval at 512 dimensions on CPU. Native-video Qwen embeddings, image queries, anomaly/highlight discovery, hosted backends, VLM reranking, Metal/CUDA acceleration, automatic timeline mutation, and a persistent player are follow-up work. They must fit the same manifests without changing the v1 contract.

The quarantined legacy `lib/core/indexer.ts` is not promoted. Its floating-point seconds, absolute roots, mutable JSON, and API-coupled analysis do not meet these contracts.

## Public Contracts

### Index manifest

`cut-footage-index` version 1 contains:

- a canonical project-relative root locator
- sorted source records with locator, byte length, SHA-256, media duration, streams, and probe identity
- exact half-open chunk ranges expressed as reduced rationals aligned to the selected source stream's frame or sample grid
- chunk duration and overlap policy
- backend protocol version, provider, model identity, embedding dimensions, and normalization
- an external vector-store artifact locator, byte length, and SHA-256
- creation evidence, not a mutable “last updated” authority

Embeddings stay in the sidecar-owned artifact rather than bloating JSON. Search refuses a changed source, changed vector artifact, incompatible backend/model, unknown field, duplicate chunk, unsafe path, or invalid range.

### Search report

`cut-footage-search` version 1 contains the canonical project-relative index locator and index identity, normalized text query, threshold, and sorted matches. Binding the locator into `searchSha256` lets `footage extract <search-report>` load the exact index without guessing a sibling filename or requiring another CLI argument. Each match has a stable ID, canonical integer `scorePpm`, source locator and SHA-256, selected stream, exact half-open source range, matched chunk IDs, and optional adjacent handles.

The adapter's floating score is admitted once, clamped, and quantized to integer parts per million before it enters a public report. Ordering is deterministic: descending `scorePpm`, then source locator, start time, end time, and stable match ID. Overlapping hits from the same source are merged or suppressed by one documented policy before ranking. A low-confidence result is reported honestly; CUT never pretends it found a confident match.

### Extraction manifest

`cut-footage-extract` version 1 binds the search report, chosen stable match ID, requested and effective handles, final range, source identity, FFmpeg/FFprobe identity, output stream facts, byte length, and SHA-256. It is explicitly labelled `candidate-only-not-cut-lock`. Existing outputs are no-clobber by default. Publication is staged and atomic.

### Live-preview handoff

The search report exposes a minimal `sourceSelection` record: source locator and identity, selected stream, and exact half-open source-clock range. The current draft-preview branch accepts authored output-timeline ranges, so these ranges must never be passed directly into it. A future raw-source candidate viewer or temporary one-clip graph may consume the record after validating it. Semantic search never imports or calls the compositor. Until that bridge lands, `footage extract` is the executable handoff.

## Sidecar Protocol

CUT starts the configured executable without a shell and sends newline-delimited JSON. The sidecar must first return a protocol handshake containing its version, provider, model identity, dimensions, supported modalities, and hardware mode.

V1 requests are:

- `index`: receive immutable chunk descriptors and return vector-artifact evidence
- `searchText`: receive index identity and text, return bounded candidate chunk IDs and raw scores
- `close`: release resources and exit cleanly

CUT validates every response, normalizes scores, performs deduplication/range construction itself, and rejects unsolicited output. The runner caps request bytes, response bytes, stderr bytes, elapsed time, candidate count, and child lifetime. It terminates and drains the child on failure or cancellation.

The bundled setup recipe installs `@huggingface/transformers@4.2.0`, including its pinned `onnxruntime-node@1.24.3` runtime, in a versioned CUT user cache. It downloads `Xenova/clip-vit-base-patch32` revision `d15189d7028b43f1d3e65039190477f6af591c2a`, loads the q8 text and vision graphs on CPU, embeds one bundled probe image and text query, and records the exact installed identities and model-file hashes. A failed setup never replaces the last verified backend.

Normal indexing and search disable remote model access and load the exact verified revision directory by its absolute local path; they do not ask the hub client to rediscover cached repository metadata. Setup is the sole network-bearing footage command. Default CUT installation ships only the small sidecar and protocol/client files. The exact pinned macOS arm64 install currently occupies roughly 387 MB for the npm runtime closure and 161 MB for the model cache; platform totals may differ and setup reports measured bytes rather than promising one download size. Those bytes are installed only after `cut footage setup --backend local` is explicitly run. The sidecar samples each chunk deterministically, L2-normalizes its frame embeddings, and writes a CUT-bound float32 vector artifact. Search embeds the normalized text query and uses cosine similarity through dot products. CPU is the required v1 execution mode so macOS and Linux produce one supported behavior; hardware acceleration is not claimed in v1.

## Data Flow

1. Discover media below the requested root in canonical sorted order.
2. Probe and hash each source through bounded project utilities.
3. Produce exact overlapping chunk descriptors.
4. Hand immutable descriptors to the sidecar and bind its vector artifact into the index manifest.
5. On search, revalidate index, vector artifact, source facts, and sidecar identity.
6. Ask the sidecar only for candidate chunk IDs and scores.
7. Normalize, deduplicate, range-build, rank, and serialize in CUT.
8. On extraction, resolve one match, add bounded handles, clamp to source duration, decode/re-encode the exact range, verify it, and atomically publish media plus manifest.

## Error Model

Every public failure has one stable CUT code and source-safe message. The initial set is `CUT_FOOTAGE_BACKEND_MISSING`, `CUT_FOOTAGE_BACKEND_PROTOCOL`, `CUT_FOOTAGE_MODEL_MISMATCH`, `CUT_FOOTAGE_INDEX_STALE`, `CUT_FOOTAGE_UNSUPPORTED_MEDIA`, `CUT_FOOTAGE_RANGE`, `CUT_FOOTAGE_MATCH`, `CUT_FOOTAGE_NO_MATCH`, `CUT_FOOTAGE_OUTPUT_EXISTS`, and `CUT_FOOTAGE_PUBLISH`.

Failures do not leave partial indexes, clips, manifests, child processes, or temporary media. Machine reports never expose API keys, full environment variables, private temp paths, or raw model stderr.

## Testing

Implementation follows test-first development.

- Pure contract tests cover canonical encoding, hostile JSON, path/range bounds, deterministic ranking, overlap dedupe, and stale identities.
- A deterministic executable sidecar exercises the real subprocess protocol, timeouts, malformed messages, crashes, cancellation, and cleanup.
- Fixture MP4/MOV files exercise discovery, probing, exact chunk planning, handled-range clamping, extraction, no-clobber publication, and manifest hashes.
- Package tests install the built tarball and confirm normal CUT commands work without Python or ML dependencies.
- A cached real-backend smoke on macOS arm64 and Linux x64 installs the pinned runtime/model, ranks two visibly different fixture clips for one text query, extracts the first match, and validates its hashes and probe facts. Deterministic tests remain independent of model-network availability.
- Live-preview tests consume a frozen `sourceSelection` fixture, so the future UI does not depend on model execution.

## Acceptance Criteria

The implementation is ready when a fresh public `cut-lang` install can run `footage setup --backend local`, index fixture footage with the real pinned CLIP adapter, rank the expected semantic match, produce a validated deterministic search report, extract one stable match ID, and verify its manifest on macOS and Linux. The deterministic executable adapter must pass the same protocol boundary for exhaustive failure testing. A default npm install remains the same size class, no ML package or model enters CUT's default dependency tree or tarball, and all existing authoritative preview/render bytes remain unchanged. The issue remains open only for explicitly deferred quality backends and live-preview integration, not for basic usable semantic search.
