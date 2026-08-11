import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { stableJsonStringify } from "../lib/core/stable";
import { parseCutAssetCatalog, type CutAssetCatalog, type CutAssetCatalogEntry } from "../lib/project/asset-catalog";
import {
  buildCutAudioSemanticIndex,
  cutAudioSearchLimitations,
  cutAudioSearchPolicy,
  searchCutAudioSemanticIndex,
  type BuildCutAudioSemanticIndexInput,
  type CutAudioSearchAuthenticatedCandidate,
  type CutAudioSearchAuthenticatedSemanticEvidence,
  type CutAudioSearchBindings,
  type CutAudioSemanticIndex,
} from "../lib/audio-intelligence/search";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

function grant(allowed = true) {
  return {
    commercialUse: allowed,
    modification: allowed,
    audiovisualSynchronization: allowed,
    standaloneRedistribution: false,
    attributionRequired: true,
    shareAlike: false,
  };
}

function audioEntry(
  id: string,
  role: "music" | "sfx" | "ambience" | "dialogue",
  options: Readonly<{ tags?: readonly string[]; reviewStatus?: "pending" | "approved" | "rejected" }> = {},
) {
  const sourceSha256 = sha256(`${id}-source`), evidenceSha256 = sha256(`${id}-rights`);
  return {
    id,
    label: `${id} candidate`,
    kind: "audio",
    description: "Exact local audio used for deterministic semantic retrieval tests.",
    tags: [...(options.tags ?? [])],
    downloadUrl: `https://assets.example.test/${id}.wav`,
    sha256: sourceSha256,
    bytes: 48_044,
    provenance: {
      creator: "CUT fixture",
      license: "CC BY 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      sourceUrl: `https://assets.example.test/source/${id}`,
      attribution: `${id} by CUT fixture`,
    },
    audio: {
      role,
      durationSamples: 24_000,
      sampleRate: 24_000,
      channels: 1,
      energy: role === "music" ? "medium" : "low",
      moods: role === "music" ? ["restrained"] : [],
      loopable: role === "music" || role === "ambience",
    },
    rights: {
      basis: "source-asserted",
      licenseId: "CC-BY-4.0",
      licenseVersion: "4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      evidenceSha256,
      compositionGrant: grant(),
      masterGrant: grant(),
      reviewStatus: options.reviewStatus ?? "approved",
    },
  };
}

const rawEntries = [
  audioEntry("ambient-bed", "music", { tags: ["bed"] }),
  audioEntry("desk-clicks", "sfx", { tags: ["office"] }),
  audioEntry("road-bed", "ambience", { tags: ["location"], reviewStatus: "pending" }),
  audioEntry("voice-a", "dialogue", { tags: ["voice"] }),
  audioEntry("not-indexed", "sfx", { tags: ["unused"] }),
  {
    id: "cover-image",
    label: "Cover",
    kind: "image",
    description: "Non-audio catalog coverage fixture.",
    tags: ["cover"],
    downloadUrl: "https://assets.example.test/cover.png",
    sha256: sha256("cover"),
    bytes: 100,
    provenance: {
      creator: "CUT fixture",
      license: "CC BY 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      sourceUrl: "https://assets.example.test/source/cover",
      attribution: "Cover by CUT fixture",
    },
  },
];

const catalog = parseCutAssetCatalog(stableJsonStringify({
  format: "cut-asset-catalog",
  version: 1,
  name: "Audio semantic search fixture",
  entries: rawEntries,
}));

const classSets = Object.freeze({
  "ambient-bed": Object.freeze([
    { classIndex: 132, label: "Music", score: 0.855 },
    { classIndex: 241, label: "Ambient music", score: 0.265 },
    { classIndex: 234, label: "Electronic music", score: 0.122 },
    { classIndex: 276, label: "Scary music", score: 0.02 },
  ]),
  "desk-clicks": Object.freeze([
    { classIndex: 379, label: "Typewriter", score: 0.125 },
    { classIndex: 378, label: "Typing", score: 0.097 },
    { classIndex: 500, label: "Inside, small room", score: 0.079 },
  ]),
  "road-bed": Object.freeze([
    { classIndex: 294, label: "Vehicle", score: 0.317 },
    { classIndex: 300, label: "Motor vehicle (road)", score: 0.125 },
    { classIndex: 301, label: "Car", score: 0.104 },
    { classIndex: 503, label: "Outside, urban or manmade", score: 0.07 },
  ]),
  "voice-a": Object.freeze([
    { classIndex: 0, label: "Speech", score: 0.993 },
    { classIndex: 5, label: "Speech synthesizer", score: 0.041 },
    { classIndex: 3, label: "Narration, monologue", score: 0.017 },
    { classIndex: 2, label: "Conversation", score: 0.003 },
  ]),
});

function bindingEntry(id: keyof typeof classSets, entry: CutAssetCatalogEntry) {
  const semanticFile = Buffer.from(`${id}-semantic-file`);
  return {
    id,
    audioLocator: `assets/${id}.wav`,
    rightsEvidenceLocator: `rights/${id}.txt`,
    semanticAnalysis: {
      locator: `.cut/audio/${id}.analysis.json`,
      bytes: semanticFile.byteLength,
      fileSha256: sha256(semanticFile),
      analysisSha256: sha256(`${id}-analysis`),
    },
    source: { locator: `assets/${id}.wav`, bytes: entry.bytes, sha256: entry.sha256 },
  };
}

const catalogById = new Map(catalog.entries.map((entry) => [entry.id, entry]));
const bindingFixtures = (["desk-clicks", "ambient-bed", "voice-a", "road-bed"] as const)
  .map((id) => bindingEntry(id, catalogById.get(id)!));
const bindingBody = {
  format: "cut-audio-audition-bindings" as const,
  version: 2 as const,
  entries: bindingFixtures.map(({ source: _source, ...entry }) => entry),
};
const bindings: CutAudioSearchBindings = Object.freeze({
  ...bindingBody,
  bindingsSha256: sha256(stableJsonStringify(bindingBody)),
});

function semanticEvidence(
  fixture: typeof bindingFixtures[number],
): CutAudioSearchAuthenticatedSemanticEvidence {
  return {
    contract: "authenticated-source-and-embedded-semantic-derivation-recomputed-without-model-reexecution-v1",
    file: {
      locator: fixture.semanticAnalysis.locator,
      bytes: fixture.semanticAnalysis.bytes,
      sha256: fixture.semanticAnalysis.fileSha256,
    },
    analysisSha256: fixture.semanticAnalysis.analysisSha256,
    source: fixture.source,
    normalization: {
      evidenceSha256: sha256(`${fixture.id}-normalization-evidence`),
      policySha256: sha256("normalization-policy"),
      outputSha256: sha256(`${fixture.id}-normalized-pcm`),
      outputSamples: 16_000,
    },
    provider: {
      id: "cut-yamnet-litert-local-v1",
      analysisSha256: sha256(`${fixture.id}-provider-analysis`),
      rawScoreSha256: sha256(`${fixture.id}-raw-scores`),
      authorities: {
        pythonSha256: sha256("python"),
        adapterSha256: sha256("adapter"),
        environmentTreeSha256: sha256("environment"),
        liteRtTreeSha256: sha256("litert"),
        modelSha256: sha256("model"),
        classMapSha256: sha256("class-map"),
      },
      aggregateTopClasses: classSets[fixture.id],
    },
    taxonomy: {
      policySha256: sha256("taxonomy-policy"),
      suggestionsSha256: sha256(`${fixture.id}-suggestions`),
      interpretation: "editorial-suggestions-not-ground-truth-v1",
      musicMoodScope: "music-only-no-unmapped-mood-inference-v1",
      roleSuggestions: [
        { id: "speech", scorePpm: 0 },
        { id: "music", scorePpm: 0 },
        { id: "silence", scorePpm: 0 },
        { id: "sfx", scorePpm: 0 },
        { id: "ambience", scorePpm: 0 },
      ],
      musicMoodSuggestions: [
        { id: "joyful", scorePpm: 0 },
        { id: "somber", scorePpm: 0 },
        { id: "intimate", scorePpm: 0 },
        { id: "energetic", scorePpm: 0 },
        { id: "tense", scorePpm: 0 },
        { id: "ominous", scorePpm: 0 },
      ],
    },
    limitations: {
      semantics: "editorial-suggestions-not-ground-truth",
      emotion: "no-emotion-inference-claim",
      legal: "no-license-provenance-or-rights-claim",
      providerAuthority: "upstream-provider-evidence-not-reauthenticated-by-pure-materializer-public-cli-is-authenticated-composition-boundary",
    },
  };
}

const candidates: readonly CutAudioSearchAuthenticatedCandidate[] = bindingFixtures.map((fixture) => ({
  id: fixture.id,
  rightsEvidence: {
    locator: fixture.rightsEvidenceLocator,
    bytes: Buffer.byteLength(`${fixture.id}-rights`),
    sha256: sha256(`${fixture.id}-rights`),
  },
  semantic: semanticEvidence(fixture),
}));

function input(overrides: Partial<BuildCutAudioSemanticIndexInput> = {}): BuildCutAudioSemanticIndexInput {
  return {
    catalog: {
      locator: "catalog.json",
      bytes: 10_000,
      sha256: sha256("catalog-file"),
      value: catalog,
    },
    bindings: {
      locator: "bindings-v2.json",
      bytes: 4_000,
      sha256: sha256("bindings-file"),
      value: bindings,
    },
    candidates,
    ...overrides,
  };
}

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

function clone<T>(value: T): Mutable<T> {
  return JSON.parse(JSON.stringify(value)) as Mutable<T>;
}

function rehashIndex(value: Mutable<CutAudioSemanticIndex>): CutAudioSemanticIndex {
  const { indexSha256: _ignored, ...body } = value;
  return { ...body, indexSha256: sha256(stableJsonStringify(body)) } as unknown as CutAudioSemanticIndex;
}

function assertDeepFrozen(value: unknown) {
  if (!value || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value as Record<string, unknown>)) assertDeepFrozen(child);
}

test("builds one canonical frozen exact-identity index and reports explicit coverage", () => {
  const index = buildCutAudioSemanticIndex(input());
  assert.deepEqual(index.entries.map((entry) => entry.id), ["ambient-bed", "desk-clicks", "road-bed", "voice-a"]);
  assert.deepEqual(index.coverage, {
    catalogEntries: 6,
    catalogAudioEntries: 5,
    indexedEntries: 4,
    omittedAudioEntryIds: ["not-indexed"],
  });
  assert.equal(index.entries[0]!.source.sha256, catalogById.get("ambient-bed")!.sha256);
  assert.equal(index.entries[0]!.aggregateTopClasses[1]!.label, "Ambient music");
  assert.equal(index.entries[0]!.aggregateTopClasses[1]!.scorePpm, 265_000);
  assert.equal(index.policy.policySha256, cutAudioSearchPolicy.policySha256);
  assert.deepEqual(index.limitations, cutAudioSearchLimitations);
  const { indexSha256, ...body } = index;
  assert.equal(indexSha256, sha256(stableJsonStringify(body)));
  assertDeepFrozen(index);
});

test("candidate input order cannot change the canonical index", () => {
  const left = buildCutAudioSemanticIndex(input());
  const right = buildCutAudioSemanticIndex(input({ candidates: [...candidates].reverse() }));
  assert.equal(left.indexSha256, right.indexSha256);
  assert.equal(stableJsonStringify(left), stableJsonStringify(right));
});

test("retrieves all four declared roles from authenticated rich AudioSet classes", () => {
  const index = buildCutAudioSemanticIndex(input());
  const cases = [
    { query: "electronic scary", role: "music" as const, id: "ambient-bed", scores: [122_000, 20_000] },
    { query: "typewriter", role: "sfx" as const, id: "desk-clicks", scores: [125_000] },
    { query: "vehicle outside", role: "ambience" as const, id: "road-bed", scores: [317_000, 70_000] },
    { query: "narration", role: "dialogue" as const, id: "voice-a", scores: [17_000] },
  ];
  for (const item of cases) {
    const report = searchCutAudioSemanticIndex(index, {
      indexLocator: ".cut/audio/index.json",
      query: item.query,
      role: item.role,
    });
    assert.equal(report.results.length, 1, item.query);
    assert.equal(report.results[0]!.id, item.id, item.query);
    assert.deepEqual(report.results[0]!.score.evidence.map((entry) => entry.scorePpm), item.scores, item.query);
    assert.equal(report.selection.trust, "candidate-only-authenticated-index-snapshot-not-cut-lock-or-rights-clearance");
    assert.equal(report.limitations.provider, "authenticated-materialized-evidence-not-provider-reexecution");
    const { searchSha256, ...body } = report;
    assert.equal(searchSha256, sha256(stableJsonStringify(body)));
    assertDeepFrozen(report);
  }
});

test("combines declared metadata with observed class evidence using the exact mean law", () => {
  const report = searchCutAudioSemanticIndex(buildCutAudioSemanticIndex(input()), {
    indexLocator: ".cut/audio/index.json",
    query: "office typewriter",
    role: "sfx",
  });
  assert.equal(report.results[0]!.id, "desk-clicks");
  assert.equal(report.results[0]!.score.declaredMatchedTokenCount, 1);
  assert.equal(report.results[0]!.score.totalPpm, 562_500);
  assert.deepEqual(report.results[0]!.score.evidence.map(({ token, source }) => ({ token, source })), [
    { token: "office", source: "declared-catalog-metadata" },
    { token: "typewriter", source: "authenticated-audioset-aggregate-class" },
  ]);
});

test("role filtering uses only catalog authority and exact tokens reject substrings", () => {
  const index = buildCutAudioSemanticIndex(input());
  assert.equal(searchCutAudioSemanticIndex(index, {
    indexLocator: ".cut/audio/index.json", query: "typewriter", role: "ambience",
  }).results.length, 0);
  assert.equal(searchCutAudioSemanticIndex(index, {
    indexLocator: ".cut/audio/index.json", query: "car", role: "music",
  }).results.length, 0, "car must not substring-match Scary music");
  assert.equal(searchCutAudioSemanticIndex(index, {
    indexLocator: ".cut/audio/index.json", query: "car", role: "ambience",
  }).results[0]!.id, "road-bed");
});

test("the optional rights filter is narrow, explicit, and never represented as clearance", () => {
  const index = buildCutAudioSemanticIndex(input());
  const any = searchCutAudioSemanticIndex(index, {
    indexLocator: ".cut/audio/index.json", query: "vehicle", rights: "any",
  });
  assert.equal(any.results[0]!.rights.reviewStatus, "pending");
  assert.equal(any.results[0]!.rights.declaredCommercialSync, false);
  const filtered = searchCutAudioSemanticIndex(index, {
    indexLocator: ".cut/audio/index.json", query: "vehicle", rights: "declared-commercial-sync",
  });
  assert.equal(filtered.results.length, 0);
  const approved = searchCutAudioSemanticIndex(index, {
    indexLocator: ".cut/audio/index.json", query: "typewriter", rights: "declared-commercial-sync",
  });
  assert.equal(approved.results[0]!.id, "desk-clicks");
  assert.equal(approved.limitations.rights, "declared-metadata-filter-not-rights-clearance");
});

test("query normalization deduplicates tokens but rejects unsafe and over-broad requests", () => {
  const index = buildCutAudioSemanticIndex(input());
  const repeated = searchCutAudioSemanticIndex(index, {
    indexLocator: ".cut/audio/index.json", query: "  TYPING typing  ", role: "sfx",
  });
  assert.deepEqual(repeated.query.tokens, ["typing"]);
  assert.equal(repeated.results[0]!.id, "desk-clicks");
  assert.throws(() => searchCutAudioSemanticIndex(index, {
    indexLocator: ".cut/audio/index.json", query: "one two three four five six seven eight nine",
  }), /CUT_AUDIO_SEARCH_QUERY/);
  assert.throws(() => searchCutAudioSemanticIndex(index, {
    indexLocator: ".cut/audio/index.json", query: "typing\u0000",
  }), /CUT_AUDIO_SEARCH_QUERY/);
  assert.throws(() => searchCutAudioSemanticIndex(index, {
    indexLocator: ".cut/audio/index.json", query: "typing", limit: 101,
  }), /CUT_AUDIO_SEARCH_LIMIT/);
  assert.throws(() => searchCutAudioSemanticIndex(index, {
    indexLocator: ".cut/audio/index.json", query: "typing", role: "noise" as never,
  }), /CUT_AUDIO_SEARCH_QUERY/);
});

test("fails closed on stale catalog or v1 and altered binding authority", () => {
  const staleCatalog = clone(catalog) as CutAssetCatalog;
  (staleCatalog as { name: string }).name = "mutated";
  assert.throws(() => buildCutAudioSemanticIndex(input({
    catalog: { ...input().catalog, value: staleCatalog },
  })), /CUT_AUDIO_SEARCH_CATALOG/);

  assert.throws(() => buildCutAudioSemanticIndex(input({
    bindings: { ...input().bindings, value: { ...bindings, version: 1 as never } },
  })), /CUT_AUDIO_SEARCH_BINDINGS/);

  const staleBindings = clone(bindings);
  staleBindings.entries[0]!.audioLocator = "assets/changed.wav";
  assert.throws(() => buildCutAudioSemanticIndex(input({
    bindings: { ...input().bindings, value: staleBindings },
  })), /CUT_AUDIO_SEARCH_BINDINGS/);
});

test("fails closed on duplicate, missing, and unrelated authenticated candidate evidence", () => {
  assert.throws(() => buildCutAudioSemanticIndex(input({
    candidates: [candidates[0]!, candidates[0]!, candidates[2]!, candidates[3]!],
  })), /CUT_AUDIO_SEARCH_DUPLICATE/);
  assert.throws(() => buildCutAudioSemanticIndex(input({ candidates: candidates.slice(0, 3) })), /CUT_AUDIO_SEARCH_LIMIT/);
  const unrelated = clone(candidates);
  unrelated[0]!.id = "unrelated";
  assert.throws(() => buildCutAudioSemanticIndex(input({ candidates: unrelated })), /has no authenticated candidate evidence/);
});

test("fails closed on semantic file, analysis, source, and rights identity mutations", () => {
  for (const mutation of ["file", "analysis", "source", "rights"] as const) {
    const changed = clone(candidates);
    if (mutation === "file") changed[0]!.semantic.file.sha256 = sha256("changed-file");
    if (mutation === "analysis") changed[0]!.semantic.analysisSha256 = sha256("changed-analysis");
    if (mutation === "source") changed[0]!.semantic.source.sha256 = sha256("changed-source");
    if (mutation === "rights") changed[0]!.rightsEvidence.sha256 = sha256("changed-rights");
    assert.throws(() => buildCutAudioSemanticIndex(input({ candidates: changed })), /CUT_AUDIO_SEARCH_(?:SEMANTIC|SOURCE|RIGHTS)/, mutation);
  }
});

test("fails closed on malformed, duplicate, and incorrectly ordered observed classes", () => {
  for (const mutation of ["duplicate", "order", "nan", "control"] as const) {
    const changed = clone(candidates);
    const classes = changed[0]!.semantic.provider.aggregateTopClasses;
    if (mutation === "duplicate") classes[1]!.classIndex = classes[0]!.classIndex;
    if (mutation === "order") classes[1]!.score = 0.99;
    if (mutation === "nan") classes[0]!.score = Number.NaN;
    if (mutation === "control") classes[0]!.label = "Bad\u0000label";
    assert.throws(() => buildCutAudioSemanticIndex(input({ candidates: changed })), /CUT_AUDIO_SEARCH_(?:DUPLICATE|ORDER|SEMANTIC)/, mutation);
  }
});

test("search revalidates the canonical index and its derived metadata and rights projections", () => {
  const original = buildCutAudioSemanticIndex(input());
  const staleHash = clone(original);
  staleHash.entries[0]!.source.sha256 = sha256("changed");
  assert.throws(() => searchCutAudioSemanticIndex(staleHash as unknown as CutAudioSemanticIndex, {
    indexLocator: ".cut/audio/index.json", query: "ambient",
  }), /CUT_AUDIO_SEARCH_INDEX/);

  const tokens = clone(original);
  tokens.entries[0]!.declaredTokens.push("forged");
  assert.throws(() => searchCutAudioSemanticIndex(rehashIndex(tokens), {
    indexLocator: ".cut/audio/index.json", query: "forged",
  }), /declaredTokens/);

  const rights = clone(original);
  rights.entries[0]!.declaredCommercialSync = false;
  assert.throws(() => searchCutAudioSemanticIndex(rehashIndex(rights), {
    indexLocator: ".cut/audio/index.json", query: "ambient",
  }), /CUT_AUDIO_SEARCH_RIGHTS/);
});

test("zero-score observed classes never create false matches", () => {
  const changed = clone(candidates);
  changed[0]!.semantic.provider.aggregateTopClasses = [
    { classIndex: 379, label: "Typewriter", score: 0.125 },
    { classIndex: 378, label: "Typing", score: 0 },
  ];
  const index = buildCutAudioSemanticIndex(input({ candidates: changed }));
  assert.equal(searchCutAudioSemanticIndex(index, {
    indexLocator: ".cut/audio/index.json", query: "typing", role: "sfx",
  }).results.length, 0);
});
