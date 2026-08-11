import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { stableJsonStringify } from "../lib/core/stable";
import {
  cutYamnetSemanticAnalysisPolicy,
  CutYamnetSemanticMaterializeError,
  materializeCutYamnetSemanticAnalysis,
  verifyCutYamnetSemanticAnalysisDerivation,
  type CutYamnetSemanticAnalysis,
  type CutYamnetSemanticAnalysisInput,
} from "../lib/audio-intelligence/yamnet-materialize";
import {
  cutYamnetLocalPolicy,
  type CutYamnetLocalAnalysis,
} from "../lib/audio-intelligence/yamnet-local";
import { cutYamnetAudioSetLabelMapSha256 } from "../lib/audio-intelligence/yamnet-taxonomy";
import {
  normalizeCutWaveForYamnet,
  type CutWaveNormalizationEvidence,
} from "../lib/audio-intelligence/wave-normalize";

const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

const officialClassMapBytes = gunzipSync(Buffer.from(
  "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",
  "base64",
));

function wave(samples = 4_800) {
  const dataBytes = samples * 2, bytes = Buffer.alloc(44 + dataBytes);
  bytes.write("RIFF", 0, "ascii"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii"); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16_000, 24); bytes.writeUInt32LE(32_000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples; index += 1) {
    const value = index < 1_600 ? 0 : index < 3_200 ? 16_384 : 8_192;
    bytes.writeInt16LE(value, 44 + index * 2);
  }
  return bytes;
}

function scores(patchCount: number) {
  const bytes = Buffer.alloc(patchCount * cutYamnetLocalPolicy.classCount * 4);
  for (let patchIndex = 0; patchIndex < patchCount; patchIndex += 1) {
    const offset = patchIndex * cutYamnetLocalPolicy.classCount * 4;
    bytes.writeFloatLE(0.8, offset + 0 * 4);
    bytes.writeFloatLE(0.4, offset + 132 * 4);
    bytes.writeFloatLE(0.4, offset + 271 * 4);
  }
  return bytes;
}

function rehashProvider(bodyValue: Omit<CutYamnetLocalAnalysis, "analysisSha256">): CutYamnetLocalAnalysis {
  const body = structuredClone(bodyValue);
  return { ...body, analysisSha256: hash(stableJsonStringify(body)) };
}

function providerAnalysis(pcmBytes: Buffer, scoreBytes: Buffer, topK = 2): CutYamnetLocalAnalysis {
  const samples = pcmBytes.byteLength / 4;
  const patchCount = samples <= cutYamnetLocalPolicy.patchSamples
    ? 1
    : 1 + Math.ceil((samples - cutYamnetLocalPolicy.patchSamples) / cutYamnetLocalPolicy.patchHopSamples);
  const labels = officialClassMapBytes.toString("utf8").slice(0, -1).split("\n");
  const patchScores = Array.from({ length: patchCount }, (_, patchIndex) => Array.from(
    { length: cutYamnetLocalPolicy.classCount },
    (_, classIndex) => scoreBytes.readFloatLE((patchIndex * cutYamnetLocalPolicy.classCount + classIndex) * 4),
  ));
  const stableTop = (values: readonly number[]) => Object.freeze(values.map((score, classIndex) => ({
    classIndex, label: labels[classIndex]!, score,
  })).sort((left, right) => right.score - left.score || left.classIndex - right.classIndex).slice(0, topK));
  const aggregateTopClasses = stableTop(Array.from(
    { length: cutYamnetLocalPolicy.classCount },
    (_, classIndex) => patchScores.reduce((sum, patch) => sum + patch[classIndex]!, 0) / patchCount,
  ));
  const body = {
    format: "cut-yamnet-local-analysis" as const,
    version: 1 as const,
    provider: cutYamnetLocalPolicy.provider,
    input: {
      sampleFormat: "f32le" as const,
      sampleRate: 16_000 as const,
      channels: 1 as const,
      samples,
      bytes: pcmBytes.byteLength,
      sha256: hash(pcmBytes),
    },
    framing: {
      patchSamples: 15_600 as const,
      patchHopSamples: 7_680 as const,
      rightPadFinalPatch: true as const,
      patchCount,
    },
    rawScores: {
      classCount: 521 as const,
      sampleFormat: "f32le" as const,
      bytes: scoreBytes.byteLength,
      sha256: hash(scoreBytes),
    },
    stderr: { bytes: 0, sha256: hash(Buffer.alloc(0)) },
    topK,
    aggregateTopClasses,
    patches: Array.from({ length: patchCount }, (_, patchIndex) => ({
      patchIndex,
      startSample: patchIndex * cutYamnetLocalPolicy.patchHopSamples,
      validSamples: Math.min(
        cutYamnetLocalPolicy.patchSamples,
        samples - patchIndex * cutYamnetLocalPolicy.patchHopSamples,
      ),
      topClasses: stableTop(patchScores[patchIndex]!),
    })),
    authorities: {
      pythonSha256: hash("python"),
      adapterSha256: hash("adapter"),
      environmentTreeSha256: hash("environment"),
      liteRtTreeSha256: hash("litert"),
      modelSha256: hash("model"),
      classMapSha256: cutYamnetAudioSetLabelMapSha256,
    },
    declarations: {
      callerDeclared: true as const,
      liteRtLicense: "Apache-2.0",
      model: { name: "YAMNet", revision: "1", license: "Apache-2.0", provenance: "declared test provenance" },
      classMap: { name: "AudioSet map", revision: "1", license: "CC-BY-4.0", provenance: "declared test provenance" },
    },
    evidenceScope: {
      authority: cutYamnetLocalPolicy.authorityScope,
      licenses: cutYamnetLocalPolicy.licenseBoundary,
      locality: cutYamnetLocalPolicy.localityBoundary,
      inference: cutYamnetLocalPolicy.inferenceBoundary,
    },
  } satisfies Omit<CutYamnetLocalAnalysis, "analysisSha256">;
  return rehashProvider(body);
}

type Fixture = Readonly<{
  value: CutYamnetSemanticAnalysisInput;
  sourceBytes: Buffer;
  pcm: Buffer;
  rawScores: Buffer;
}>;

function fixture(sampleCount = 4_800, topK = 2): Fixture {
  const sourceBytes = wave(sampleCount);
  const normalized = normalizeCutWaveForYamnet(sourceBytes, { bytes: sourceBytes.byteLength, sha256: hash(sourceBytes) });
  const pcmBytes = normalized.pcmBytes;
  const patchCount = sampleCount <= cutYamnetLocalPolicy.patchSamples
    ? 1
    : 1 + Math.ceil((sampleCount - cutYamnetLocalPolicy.patchSamples) / cutYamnetLocalPolicy.patchHopSamples);
  const rawScores = scores(patchCount);
  const value: CutYamnetSemanticAnalysisInput = {
    source: { locator: "media/dialogue.wav", bytes: sourceBytes.byteLength, sha256: hash(sourceBytes) },
    sourceBytes,
    normalization: normalized.evidence,
    pcm: pcmBytes,
    providerAnalysis: providerAnalysis(pcmBytes, rawScores, topK),
    rawScoreBytes: rawScores,
    classMapBytes: officialClassMapBytes,
  };
  return Object.freeze({ value, sourceBytes, pcm: pcmBytes, rawScores });
}

function expectFailure(value: CutYamnetSemanticAnalysisInput, code: string, path?: RegExp) {
  assert.throws(
    () => materializeCutYamnetSemanticAnalysis(value),
    (error: unknown) => error instanceof CutYamnetSemanticMaterializeError
      && error.code === code && (!path || path.test(error.path)),
  );
}

function providerBody(value: CutYamnetLocalAnalysis) {
  const { analysisSha256: _ignored, ...body } = value;
  return structuredClone(body);
}

function rehashNormalization(
  bodyValue: Omit<CutWaveNormalizationEvidence, "evidenceSha256">,
): CutWaveNormalizationEvidence {
  const body = structuredClone(bodyValue);
  return { ...body, evidenceSha256: hash(stableJsonStringify(body)) };
}

function rehashSemanticArtifact(value: CutYamnetSemanticAnalysis) {
  const candidate = structuredClone(value) as unknown as Record<string, any>;
  delete candidate.analysisSha256;
  return { ...candidate, analysisSha256: hash(stableJsonStringify(candidate)) } as CutYamnetSemanticAnalysis;
}

function rehashMaterializedProvider(value: Record<string, any>) {
  const body = structuredClone(value);
  delete body.analysisSha256;
  return { ...body, analysisSha256: hash(stableJsonStringify(body)) };
}

function rehashMaterializedTaxonomy(value: Record<string, any>) {
  const body = structuredClone(value);
  delete body.suggestionsSha256;
  return { ...body, suggestionsSha256: hash(stableJsonStringify(body)) };
}

test("materializes bound taxonomy plus deterministic activity, onset, tempo, and section evidence", () => {
  const { value } = fixture();
  const result = materializeCutYamnetSemanticAnalysis(value);
  assert.equal(result.format, "cut-audio-semantic-analysis");
  assert.equal(result.version, 1);
  assert.equal(result.provider.provider, cutYamnetLocalPolicy.provider);
  assert.equal(result.provider.format, "cut-yamnet-local-analysis");
  assert.equal(result.provider.version, 1);
  assert.equal(result.provider.analysisSha256, value.providerAnalysis.analysisSha256);
  assert.deepEqual(result.provider.stderr, value.providerAnalysis.stderr);
  assert.equal(result.provider.topK, 2);
  assert.deepEqual(result.provider.aggregateTopClasses, value.providerAnalysis.aggregateTopClasses);
  assert.deepEqual(result.provider.patches, value.providerAnalysis.patches);
  assert.deepEqual(result.provider.aggregateTopClasses.map(({ classIndex, label }) => [classIndex, label]), [
    [0, "Speech"], [132, "Music"],
  ]);
  assert.equal(result.provider.authorities.modelSha256, value.providerAnalysis.authorities.modelSha256);
  assert.equal(result.provider.evidenceScope.inference, cutYamnetLocalPolicy.inferenceBoundary);
  assert.deepEqual(
    {
      encoding: result.derivationInputs.rawScores.encoding,
      bytes: result.derivationInputs.rawScores.bytes,
      sha256: result.derivationInputs.rawScores.sha256,
    },
    { encoding: "base64", bytes: value.rawScoreBytes.byteLength, sha256: hash(value.rawScoreBytes) },
  );
  assert.deepEqual(Buffer.from(result.derivationInputs.rawScores.data, "base64"), value.rawScoreBytes);
  assert.deepEqual(
    {
      encoding: result.derivationInputs.classMap.encoding,
      bytes: result.derivationInputs.classMap.bytes,
      sha256: result.derivationInputs.classMap.sha256,
    },
    { encoding: "base64", bytes: value.classMapBytes.byteLength, sha256: cutYamnetAudioSetLabelMapSha256 },
  );
  assert.deepEqual(Buffer.from(result.derivationInputs.classMap.data, "base64"), value.classMapBytes);
  assert.equal(result.taxonomy.aggregate.roleSuggestions.find(({ id }) => id === "speech")?.scorePpm, 800_000);
  assert.equal(result.taxonomy.aggregate.musicMoodSuggestions.find(({ id }) => id === "joyful")?.scorePpm, 400_000);
  assert.deepEqual(result.signal.activity.map(({ state, range }) => [state, range.startSample, range.endSample]), [
    ["silence", 0, 1_600], ["active", 1_600, 3_200], ["active", 3_200, 4_800],
  ]);
  assert.deepEqual(result.signal.onsets.map(({ range, strengthPpm }) => [range.startSample, strengthPpm]), [[1_600, 1_000_000]]);
  assert.deepEqual(result.signal.sections, [
    { range: { startSample: 0, endSample: 1_600 }, state: "silence", windowCount: 1, maximumOnsetStrengthPpm: 0 },
    { range: { startSample: 1_600, endSample: 4_800 }, state: "active", windowCount: 2, maximumOnsetStrengthPpm: 1_000_000 },
  ]);
  assert.deepEqual(result.signal.tempo, { candidates: [], beatSamples: [] });
  assert.deepEqual(result.limitations, {
    semantics: "editorial-suggestions-not-ground-truth",
    emotion: "no-emotion-inference-claim",
    legal: "no-license-provenance-or-rights-claim",
    providerAuthority:
      "upstream-provider-evidence-not-reauthenticated-by-pure-materializer-public-cli-is-authenticated-composition-boundary",
  });
  const { analysisSha256, ...body } = result;
  assert.equal(analysisSha256, hash(stableJsonStringify(body)));
  assert.deepEqual(verifyCutYamnetSemanticAnalysisDerivation(result), result);
});

test("uses one bounded DSP window for short normalized PCM", () => {
  const { value } = fixture(800);
  const result = materializeCutYamnetSemanticAnalysis(value);
  assert.deepEqual(result.signal.policy, {
    sampleRate: 16_000,
    windowSamples: 800,
    hopSamples: 800,
    silenceThresholdDbfsMilli: -50_000,
    tempoMinBpm: 50,
    tempoMaxBpm: 200,
    sectionLaw: "contiguous-dsp-window-activity-runs-v1",
  });
  assert.equal(result.signal.activity.length, 1);
  assert.equal(result.signal.activity[0]?.range.endSample, 800);
});

test("maximum admitted provider range keeps embedded replay evidence bounded and verifiable", () => {
  const { value } = fixture(cutYamnetLocalPolicy.maximumDurationSamples, cutYamnetLocalPolicy.maximumTopK);
  const result = materializeCutYamnetSemanticAnalysis(value);
  assert.equal(result.provider.framing.patchCount, 20);
  assert.equal(result.derivationInputs.rawScores.bytes, 41_680);
  assert.equal(result.derivationInputs.rawScores.data.length, 55_576);
  assert.equal(result.derivationInputs.classMap.bytes, 6_230);
  assert.equal(result.derivationInputs.classMap.data.length, 8_308);
  assert.ok(Buffer.byteLength(stableJsonStringify(result), "utf8") < 1024 * 1024);
  assert.deepEqual(verifyCutYamnetSemanticAnalysisDerivation(result), result);
});

test("rejects unknown, accessor, locator, source, normalization, and PCM identity drift", () => {
  const { value } = fixture();
  expectFailure({ ...value, extra: true } as CutYamnetSemanticAnalysisInput, "CUT_YAMNET_MATERIALIZE_FIELD");
  expectFailure({ ...value, source: { ...value.source, locator: "../media.wav" } }, "CUT_YAMNET_MATERIALIZE_LOCATOR");
  expectFailure({ ...value, source: { ...value.source, sha256: "0".repeat(64) } }, "CUT_YAMNET_MATERIALIZE_NORMALIZATION");
  expectFailure({ ...value, source: { ...value.source, bytes: value.source.bytes + 1 } }, "CUT_YAMNET_MATERIALIZE_NORMALIZATION");
  const changedSource = Buffer.from(value.sourceBytes); changedSource[44] ^= 1;
  expectFailure({ ...value, sourceBytes: changedSource }, "CUT_YAMNET_MATERIALIZE_NORMALIZATION");

  const { evidenceSha256: _ignored, ...normalizationBody } = value.normalization;
  const fabricatedNormalization = rehashNormalization({
    ...normalizationBody,
    output: { ...normalizationBody.output, sha256: "0".repeat(64) },
  });
  expectFailure({ ...value, normalization: fabricatedNormalization }, "CUT_YAMNET_MATERIALIZE_NORMALIZATION", /normalization/u);
  const changedPcm = Buffer.from(value.pcm); changedPcm.writeFloatLE(0.75, 0);
  expectFailure({ ...value, pcm: changedPcm }, "CUT_YAMNET_MATERIALIZE_NORMALIZATION");
  const accessor = { ...value } as Record<string, unknown>;
  Object.defineProperty(accessor, "pcm", { enumerable: true, get: () => value.pcm });
  expectFailure(accessor as CutYamnetSemanticAnalysisInput, "CUT_YAMNET_MATERIALIZE_TYPE", /\.pcm/u);
});

test("rejects proxy, hidden, symbol, sparse, accessor, and symbol-buffer metadata boundaries", () => {
  const { value } = fixture(15_601);
  expectFailure(new Proxy({ ...value }, {}) as CutYamnetSemanticAnalysisInput, "CUT_YAMNET_MATERIALIZE_TYPE", /^\$$/u);

  const hidden = { ...value, source: { ...value.source } };
  Object.defineProperty(hidden.source, "forged", { value: true, enumerable: false });
  expectFailure(hidden as CutYamnetSemanticAnalysisInput, "CUT_YAMNET_MATERIALIZE_FIELD", /\.source\.forged/u);

  const symbolic = { ...value, source: { ...value.source } };
  (symbolic.source as Record<PropertyKey, unknown>)[Symbol("forged")] = true;
  expectFailure(symbolic as CutYamnetSemanticAnalysisInput, "CUT_YAMNET_MATERIALIZE_FIELD", /\.source/u);

  const providerWithProxyArray = {
    ...value.providerAnalysis,
    patches: new Proxy([...value.providerAnalysis.patches], {}),
  };
  expectFailure({ ...value, providerAnalysis: providerWithProxyArray }, "CUT_YAMNET_MATERIALIZE_TYPE", /\.patches/u);

  const symbolicScores = Buffer.from(value.rawScoreBytes);
  (symbolicScores as unknown as Record<PropertyKey, unknown>)[Symbol("forged")] = true;
  expectFailure({ ...value, rawScoreBytes: symbolicScores }, "CUT_YAMNET_MATERIALIZE_FIELD", /rawScoreBytes/u);

  const proxiedPcm = new Proxy(Buffer.from(value.pcm), {});
  expectFailure({ ...value, pcm: proxiedPcm }, "CUT_YAMNET_MATERIALIZE_TYPE", /\.pcm/u);

  if (typeof SharedArrayBuffer !== "undefined") {
    const sharedScores = Buffer.from(new SharedArrayBuffer(value.rawScoreBytes.byteLength));
    value.rawScoreBytes.copy(sharedScores);
    expectFailure({ ...value, rawScoreBytes: sharedScores }, "CUT_YAMNET_MATERIALIZE_TYPE", /rawScoreBytes/u);
  }
});

test("Buffer string metadata, including non-enumerable metadata, cannot affect or propagate", () => {
  const { value } = fixture();
  const baseline = materializeCutYamnetSemanticAnalysis(value);
  const marked = {
    ...value,
    sourceBytes: Buffer.from(value.sourceBytes),
    pcm: Buffer.from(value.pcm),
    rawScoreBytes: Buffer.from(value.rawScoreBytes),
    classMapBytes: Buffer.from(value.classMapBytes),
  };
  for (const bytes of [marked.sourceBytes, marked.pcm, marked.rawScoreBytes, marked.classMapBytes]) {
    Object.defineProperty(bytes, "privateHostMetadata", {
      value: Object.freeze({ forged: true }),
      enumerable: false,
      configurable: false,
    });
    Object.defineProperty(bytes, "publicHostMetadata", {
      value: "ignored",
      enumerable: true,
      configurable: false,
    });
  }
  const observed = materializeCutYamnetSemanticAnalysis(marked);
  assert.deepEqual(observed, baseline);
  assert.doesNotMatch(stableJsonStringify(observed), /privateHostMetadata|publicHostMetadata|forged|ignored/u);
  for (const bytes of [marked.sourceBytes, marked.pcm, marked.rawScoreBytes, marked.classMapBytes]) {
    assert.deepEqual((bytes as unknown as Record<string, unknown>).privateHostMetadata, { forged: true });
    assert.equal((bytes as unknown as Record<string, unknown>).publicHostMetadata, "ignored");
  }
});

test("rejects provider self-hash, input, authority, raw-score, and patch-geometry drift", () => {
  const { value } = fixture(15_601);
  expectFailure({
    ...value,
    providerAnalysis: { ...value.providerAnalysis, analysisSha256: "0".repeat(64) },
  }, "CUT_YAMNET_MATERIALIZE_IDENTITY", /analysisSha256/u);

  const inputDrift = providerBody(value.providerAnalysis);
  inputDrift.input = { ...inputDrift.input, sha256: "0".repeat(64) };
  expectFailure({ ...value, providerAnalysis: rehashProvider(inputDrift) }, "CUT_YAMNET_MATERIALIZE_IDENTITY", /\.input/u);

  const authorityDrift = providerBody(value.providerAnalysis);
  authorityDrift.authorities = { ...authorityDrift.authorities, classMapSha256: hash("foreign labels") };
  expectFailure({ ...value, providerAnalysis: rehashProvider(authorityDrift) }, "CUT_YAMNET_MATERIALIZE_IDENTITY", /classMap/u);
  const changedClassMap = Buffer.from(value.classMapBytes); changedClassMap[0] = "X".charCodeAt(0);
  expectFailure({ ...value, classMapBytes: changedClassMap }, "CUT_YAMNET_MATERIALIZE_IDENTITY", /classMapBytes/u);

  const geometryDrift = providerBody(value.providerAnalysis);
  geometryDrift.patches = geometryDrift.patches.map((patch, index) => index === 1 ? { ...patch, startSample: 7_681 } : patch);
  expectFailure({ ...value, providerAnalysis: rehashProvider(geometryDrift) }, "CUT_YAMNET_MATERIALIZE_IDENTITY", /startSample/u);

  const changedScores = Buffer.from(value.rawScoreBytes); changedScores.writeFloatLE(0.5, 0);
  expectFailure({ ...value, rawScoreBytes: changedScores }, "CUT_YAMNET_MATERIALIZE_IDENTITY", /rawScores/u);

  const scoreBindingDrift = providerBody(value.providerAnalysis);
  scoreBindingDrift.rawScores = { ...scoreBindingDrift.rawScores, sha256: "0".repeat(64) };
  expectFailure({ ...value, providerAnalysis: rehashProvider(scoreBindingDrift) }, "CUT_YAMNET_MATERIALIZE_IDENTITY", /rawScores/u);

  const topKDrift = providerBody(value.providerAnalysis);
  topKDrift.topK = 3;
  expectFailure({ ...value, providerAnalysis: rehashProvider(topKDrift) }, "CUT_YAMNET_MATERIALIZE_COUNT", /aggregateTopClasses/u);

  const duplicateClass = providerBody(value.providerAnalysis);
  duplicateClass.patches = duplicateClass.patches.map((patch, index) => index === 0 ? {
    ...patch,
    topClasses: [patch.topClasses[0]!, { ...patch.topClasses[1]!, classIndex: patch.topClasses[0]!.classIndex }],
  } : patch);
  expectFailure({ ...value, providerAnalysis: rehashProvider(duplicateClass) }, "CUT_YAMNET_MATERIALIZE_DUPLICATE", /topClasses/u);
});

test("recomputes topK and rejects altered index, score, label, aggregate, tie order, sparse, and accessor arrays", () => {
  const { value } = fixture(15_601, 3);
  const patchMutation = (
    change: (entries: Array<{ classIndex: number; label: string; score: number }>) => void,
  ) => {
    const body = providerBody(value.providerAnalysis);
    const entries = body.patches[0]!.topClasses.map((entry) => ({ ...entry }));
    change(entries);
    body.patches = body.patches.map((patch, index) => index === 0 ? { ...patch, topClasses: entries } : patch);
    return rehashProvider(body);
  };

  expectFailure({ ...value, providerAnalysis: patchMutation((entries) => {
    entries[1]!.classIndex = 271;
  }) }, "CUT_YAMNET_MATERIALIZE_TOPK", /classIndex/u);
  expectFailure({ ...value, providerAnalysis: patchMutation((entries) => {
    entries[1]!.score = entries[1]!.score - 0.01;
  }) }, "CUT_YAMNET_MATERIALIZE_TOPK", /score/u);
  expectFailure({ ...value, providerAnalysis: patchMutation((entries) => {
    entries[1]!.label = "Fabricated music label";
  }) }, "CUT_YAMNET_MATERIALIZE_TOPK", /label/u);

  const aggregate = providerBody(value.providerAnalysis);
  aggregate.aggregateTopClasses = aggregate.aggregateTopClasses.map((entry, index) => index === 0
    ? { ...entry, score: entry.score - 0.01 }
    : entry);
  expectFailure({ ...value, providerAnalysis: rehashProvider(aggregate) }, "CUT_YAMNET_MATERIALIZE_TOPK", /aggregateTopClasses.*score/u);

  const tied = patchMutation((entries) => {
    [entries[1], entries[2]] = [entries[2]!, entries[1]!];
  });
  expectFailure({ ...value, providerAnalysis: tied }, "CUT_YAMNET_MATERIALIZE_TOPK", /topClasses.*classIndex/u);

  const sparseBody = providerBody(value.providerAnalysis);
  const sparsePatches = new Array<CutYamnetLocalAnalysis["patches"][number]>(sparseBody.patches.length);
  sparsePatches[0] = sparseBody.patches[0]!;
  sparseBody.patches = sparsePatches;
  expectFailure({ ...value, providerAnalysis: rehashProvider(sparseBody) }, "CUT_YAMNET_MATERIALIZE_TYPE", /patches\[1\]/u);

  const accessorBody = providerBody(value.providerAnalysis);
  const accessorAnalysis = rehashProvider(accessorBody), accessorPatches = [...accessorAnalysis.patches];
  Object.defineProperty(accessorPatches, "0", { enumerable: true, configurable: true, get: () => accessorAnalysis.patches[0] });
  expectFailure({
    ...value,
    providerAnalysis: { ...accessorAnalysis, patches: accessorPatches },
  }, "CUT_YAMNET_MATERIALIZE_TYPE", /patches\[0\]/u);
});

test("embedded derivation verifier rejects cascade-rehashed taxonomy, provider, class-map, and score drift", () => {
  const { value } = fixture(15_601, 3);
  const baseline = materializeCutYamnetSemanticAnalysis(value);

  const taxonomyScore = structuredClone(baseline) as unknown as Record<string, any>;
  taxonomyScore.taxonomy.aggregate.roleSuggestions[1].scorePpm -= 1;
  taxonomyScore.taxonomy = rehashMaterializedTaxonomy(taxonomyScore.taxonomy);
  assert.throws(
    () => verifyCutYamnetSemanticAnalysisDerivation(rehashSemanticArtifact(taxonomyScore as CutYamnetSemanticAnalysis)),
    (error: unknown) => error instanceof CutYamnetSemanticMaterializeError
      && error.code === "CUT_YAMNET_MATERIALIZE_DERIVATION" && /taxonomy/u.test(error.path),
  );

  const providerTopK = structuredClone(baseline) as unknown as Record<string, any>;
  providerTopK.provider.topK = 2;
  providerTopK.provider = rehashMaterializedProvider(providerTopK.provider);
  assert.throws(
    () => verifyCutYamnetSemanticAnalysisDerivation(rehashSemanticArtifact(providerTopK as CutYamnetSemanticAnalysis)),
    (error: unknown) => error instanceof CutYamnetSemanticMaterializeError
      && error.code === "CUT_YAMNET_MATERIALIZE_COUNT" && /aggregateTopClasses/u.test(error.path),
  );

  const providerLabel = structuredClone(baseline) as unknown as Record<string, any>;
  providerLabel.provider.aggregateTopClasses[0].label = "Fabricated label";
  providerLabel.provider = rehashMaterializedProvider(providerLabel.provider);
  assert.throws(
    () => verifyCutYamnetSemanticAnalysisDerivation(rehashSemanticArtifact(providerLabel as CutYamnetSemanticAnalysis)),
    (error: unknown) => error instanceof CutYamnetSemanticMaterializeError
      && error.code === "CUT_YAMNET_MATERIALIZE_TOPK" && /label/u.test(error.path),
  );

  const classMap = structuredClone(baseline) as unknown as Record<string, any>;
  const classMapBytes = Buffer.from(classMap.derivationInputs.classMap.data, "base64");
  classMapBytes[0] ^= 1;
  const classMapSha256 = hash(classMapBytes);
  classMap.derivationInputs.classMap.data = classMapBytes.toString("base64");
  classMap.derivationInputs.classMap.sha256 = classMapSha256;
  classMap.provider.authorities.classMapSha256 = classMapSha256;
  classMap.provider = rehashMaterializedProvider(classMap.provider);
  classMap.taxonomy.sourceScores.labelMapSha256 = classMapSha256;
  classMap.taxonomy = rehashMaterializedTaxonomy(classMap.taxonomy);
  assert.throws(
    () => verifyCutYamnetSemanticAnalysisDerivation(rehashSemanticArtifact(classMap as CutYamnetSemanticAnalysis)),
    (error: unknown) => error instanceof CutYamnetSemanticMaterializeError
      && error.code === "CUT_YAMNET_MATERIALIZE_IDENTITY" && /classMapSha256/u.test(error.path),
  );

  const rawScores = structuredClone(baseline) as unknown as Record<string, any>;
  const rawScoreBytes = Buffer.from(rawScores.derivationInputs.rawScores.data, "base64");
  rawScoreBytes.writeFloatLE(0.7, 0);
  const rawScoreSha256 = hash(rawScoreBytes);
  rawScores.derivationInputs.rawScores.data = rawScoreBytes.toString("base64");
  rawScores.derivationInputs.rawScores.sha256 = rawScoreSha256;
  rawScores.provider.rawScores.sha256 = rawScoreSha256;
  rawScores.provider = rehashMaterializedProvider(rawScores.provider);
  rawScores.taxonomy.sourceScores.sha256 = rawScoreSha256;
  rawScores.taxonomy = rehashMaterializedTaxonomy(rawScores.taxonomy);
  assert.throws(
    () => verifyCutYamnetSemanticAnalysisDerivation(rehashSemanticArtifact(rawScores as CutYamnetSemanticAnalysis)),
    (error: unknown) => error instanceof CutYamnetSemanticMaterializeError
      && error.code === "CUT_YAMNET_MATERIALIZE_TOPK",
  );

  const noncanonical = structuredClone(baseline) as unknown as Record<string, any>;
  noncanonical.derivationInputs.rawScores.data = `${noncanonical.derivationInputs.rawScores.data.slice(0, -1)}A`;
  assert.throws(
    () => verifyCutYamnetSemanticAnalysisDerivation(rehashSemanticArtifact(noncanonical as CutYamnetSemanticAnalysis)),
    (error: unknown) => error instanceof CutYamnetSemanticMaterializeError
      && ["CUT_YAMNET_MATERIALIZE_BASE64", "CUT_YAMNET_MATERIALIZE_IDENTITY"].includes(error.code),
  );
});

test("rejects invalid semantic scores and fabricated normalized PCM even when caller hashes are recomputed", () => {
  const scoreFixture = fixture();
  const invalidScores = Buffer.from(scoreFixture.rawScores); invalidScores.writeFloatLE(Number.NaN, 400 * 4);
  const scoreProviderBody = providerBody(scoreFixture.value.providerAnalysis);
  scoreProviderBody.rawScores = { ...scoreProviderBody.rawScores, sha256: hash(invalidScores) };
  assert.throws(
    () => materializeCutYamnetSemanticAnalysis({
      ...scoreFixture.value,
      providerAnalysis: rehashProvider(scoreProviderBody),
      rawScoreBytes: invalidScores,
    }),
    /CUT_YAMNET_MATERIALIZE_SCORE/u,
  );

  const pcmFixture = fixture();
  const invalidPcm = Buffer.from(pcmFixture.pcm); invalidPcm.writeFloatLE(Number.NaN, 0);
  const pcmProviderBody = providerBody(pcmFixture.value.providerAnalysis);
  pcmProviderBody.input = { ...pcmProviderBody.input, sha256: hash(invalidPcm) };
  const { evidenceSha256: _ignored, ...normalizationBody } = pcmFixture.value.normalization;
  const fabricatedNormalization = rehashNormalization({
    ...normalizationBody,
    output: { ...normalizationBody.output, sha256: hash(invalidPcm) },
  });
  assert.throws(
    () => materializeCutYamnetSemanticAnalysis({
      ...pcmFixture.value,
      normalization: fabricatedNormalization,
      pcm: invalidPcm,
      providerAnalysis: rehashProvider(pcmProviderBody),
    }),
    /CUT_YAMNET_MATERIALIZE_NORMALIZATION/u,
  );
});

test("is repeatable, deeply immutable, nonaliasing, and nonmutating", () => {
  const { value } = fixture();
  const sourceBefore = Buffer.from(value.sourceBytes), pcmBefore = Buffer.from(value.pcm);
  const scoresBefore = Buffer.from(value.rawScoreBytes), classMapBefore = Buffer.from(value.classMapBytes);
  const providerBefore = structuredClone(value.providerAnalysis);
  const first = materializeCutYamnetSemanticAnalysis(value);
  const second = materializeCutYamnetSemanticAnalysis(value);
  assert.deepEqual(first, second);
  assert.deepEqual(value.pcm, pcmBefore);
  assert.deepEqual(value.sourceBytes, sourceBefore);
  assert.deepEqual(value.rawScoreBytes, scoresBefore);
  assert.deepEqual(value.classMapBytes, classMapBefore);
  assert.deepEqual(value.providerAnalysis, providerBefore);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.provider.authorities)
    && Object.isFrozen(first.derivationInputs.rawScores)
    && Object.isFrozen(first.taxonomy.patches) && Object.isFrozen(first.signal.sections));
  assert.throws(() => {
    (first.signal.activity[0]!.range as { endSample: number }).endSample = 99;
  }, TypeError);
  assert.equal(first.signal.activity[0]?.range.endSample, 1_600);
});

test("policy is closed around editorial, emotion, and legal limitations", () => {
  assert.deepEqual(cutYamnetSemanticAnalysisPolicy.limitations, {
    semantics: "editorial-suggestions-not-ground-truth",
    emotion: "no-emotion-inference-claim",
    legal: "no-license-provenance-or-rights-claim",
    providerAuthority:
      "upstream-provider-evidence-not-reauthenticated-by-pure-materializer-public-cli-is-authenticated-composition-boundary",
  });
  assert.ok(Object.isFrozen(cutYamnetSemanticAnalysisPolicy)
    && Object.isFrozen(cutYamnetSemanticAnalysisPolicy.limitations));
});
