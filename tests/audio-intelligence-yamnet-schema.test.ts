import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv from "ajv";
import { stableJsonStringify } from "../lib/core/stable";
import {
  cutYamnetSemanticAnalysisPolicy,
  CutYamnetSemanticMaterializeError,
  materializeCutYamnetSemanticAnalysis,
  verifyCutYamnetSemanticAnalysisDerivation,
  type CutYamnetSemanticAnalysis,
  type CutYamnetSemanticAnalysisInput,
} from "../lib/audio-intelligence/yamnet-materialize";
import { normalizeCutWaveForYamnet, cutWaveNormalizePolicy } from "../lib/audio-intelligence/wave-normalize";
import {
  cutYamnetLocalPolicy,
  type CutYamnetLocalAnalysis,
} from "../lib/audio-intelligence/yamnet-local";
import {
  cutYamnetAudioSetLabelMapSha256,
  cutYamnetAudioSetMapV1,
} from "../lib/audio-intelligence/yamnet-taxonomy";

const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const semanticSchemaPath = "schemas/cut-audio-semantic-analysis-v1.schema.json";

function wave(sampleCount = 32_000) {
  const data = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    const window = Math.floor(index / 1_600);
    const active = window % 5 === 0 && index % 1_600 < 800;
    data.writeInt16LE(active ? 16_384 : 0, index * 2);
  }
  const result = Buffer.alloc(44 + data.byteLength);
  result.write("RIFF", 0, "ascii");
  result.writeUInt32LE(result.byteLength - 8, 4);
  result.write("WAVEfmt ", 8, "ascii");
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(16_000, 24);
  result.writeUInt32LE(32_000, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write("data", 36, "ascii");
  result.writeUInt32LE(data.byteLength, 40);
  data.copy(result, 44);
  return result;
}

function extensibleWave(sampleCount = 32_000) {
  const classic = wave(sampleCount);
  const data = classic.subarray(44);
  const result = Buffer.alloc(68 + data.byteLength);
  result.write("RIFF", 0, "ascii");
  result.writeUInt32LE(result.byteLength - 8, 4);
  result.write("WAVEfmt ", 8, "ascii");
  result.writeUInt32LE(40, 16);
  result.writeUInt16LE(0xfffe, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(16_000, 24);
  result.writeUInt32LE(32_000, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.writeUInt16LE(22, 36);
  result.writeUInt16LE(16, 38);
  result.writeUInt32LE(0, 40);
  Buffer.from("0100000000001000800000aa00389b71", "hex").copy(result, 44);
  result.write("data", 60, "ascii");
  result.writeUInt32LE(data.byteLength, 64);
  data.copy(result, 68);
  return result;
}

function scoreBytes(patchCount: number) {
  const result = Buffer.alloc(patchCount * cutYamnetLocalPolicy.classCount * 4);
  for (let patchIndex = 0; patchIndex < patchCount; patchIndex += 1) {
    const patchOffset = patchIndex * cutYamnetLocalPolicy.classCount * 4;
    for (let classIndex = 0; classIndex < cutYamnetLocalPolicy.classCount; classIndex += 1) {
      const score = classIndex === 0 ? 0.9 : classIndex === 271 ? 0.5 : classIndex === 132 ? 0.4 : 0.001;
      result.writeFloatLE(score, patchOffset + classIndex * 4);
    }
  }
  return result;
}

function providerAnalysis(pcm: Buffer, scores: Buffer, labels: readonly string[]): CutYamnetLocalAnalysis {
  const samples = pcm.byteLength / 4;
  const patchCount = samples <= cutYamnetLocalPolicy.patchSamples
    ? 1
    : 1 + Math.ceil((samples - cutYamnetLocalPolicy.patchSamples) / cutYamnetLocalPolicy.patchHopSamples);
  const topClasses = Object.freeze([
    Object.freeze({ classIndex: 0, label: labels[0]!, score: scores.readFloatLE(0) }),
    Object.freeze({ classIndex: 271, label: labels[271]!, score: scores.readFloatLE(271 * 4) }),
    Object.freeze({ classIndex: 132, label: labels[132]!, score: scores.readFloatLE(132 * 4) }),
  ]);
  const body = {
    format: "cut-yamnet-local-analysis" as const,
    version: 1 as const,
    provider: cutYamnetLocalPolicy.provider,
    input: {
      sampleFormat: "f32le" as const,
      sampleRate: 16_000 as const,
      channels: 1 as const,
      samples,
      bytes: pcm.byteLength,
      sha256: digest(pcm),
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
      bytes: scores.byteLength,
      sha256: digest(scores),
    },
    stderr: { bytes: 0, sha256: digest(Buffer.alloc(0)) },
    topK: 3,
    aggregateTopClasses: topClasses,
    patches: Array.from({ length: patchCount }, (_, patchIndex) => ({
      patchIndex,
      startSample: patchIndex * cutYamnetLocalPolicy.patchHopSamples,
      validSamples: Math.min(cutYamnetLocalPolicy.patchSamples, samples - patchIndex * cutYamnetLocalPolicy.patchHopSamples),
      topClasses,
    })),
    authorities: {
      pythonSha256: digest("python"),
      adapterSha256: digest("adapter"),
      environmentTreeSha256: digest("environment"),
      liteRtTreeSha256: digest("litert"),
      modelSha256: digest("model"),
      classMapSha256: cutYamnetAudioSetLabelMapSha256,
    },
    declarations: {
      callerDeclared: true as const,
      liteRtLicense: "Apache-2.0",
      model: { name: "YAMNet", revision: "fixture-v1", license: "Apache-2.0", provenance: "caller-declared fixture model" },
      classMap: { name: "AudioSet labels", revision: "fixture-v1", license: "CC-BY-4.0", provenance: "caller-declared fixture labels" },
    },
    evidenceScope: {
      authority: cutYamnetLocalPolicy.authorityScope,
      licenses: cutYamnetLocalPolicy.licenseBoundary,
      locality: cutYamnetLocalPolicy.localityBoundary,
      inference: cutYamnetLocalPolicy.inferenceBoundary,
    },
  } satisfies Omit<CutYamnetLocalAnalysis, "analysisSha256">;
  return Object.freeze({ ...body, analysisSha256: digest(stableJsonStringify(body)) });
}

async function runtimeFixture(sourceBytes = wave()) {
  const normalization = normalizeCutWaveForYamnet(sourceBytes, { bytes: sourceBytes.byteLength, sha256: digest(sourceBytes) });
  const patchCount = normalization.evidence.output.samples <= cutYamnetLocalPolicy.patchSamples
    ? 1
    : 1 + Math.ceil((normalization.evidence.output.samples - cutYamnetLocalPolicy.patchSamples) / cutYamnetLocalPolicy.patchHopSamples);
  const scores = scoreBytes(patchCount);
  const classMapBytes = await readFile("adapters/audio-yamnet-local/yamnet_label_list.txt");
  const labels = classMapBytes.toString("utf8").slice(0, -1).split("\n");
  const input: CutYamnetSemanticAnalysisInput = {
    source: { locator: "media/semantic-source.wav", bytes: sourceBytes.byteLength, sha256: digest(sourceBytes) },
    sourceBytes,
    normalization: normalization.evidence,
    pcm: normalization.pcmBytes,
    providerAnalysis: providerAnalysis(normalization.pcmBytes, scores, labels),
    rawScoreBytes: scores,
    classMapBytes,
  };
  return Object.freeze({ input, artifact: materializeCutYamnetSemanticAnalysis(input) });
}

type JsonSchema = Record<string, unknown>;

async function compiledSchema() {
  const schema = JSON.parse(await readFile(semanticSchemaPath, "utf8")) as JsonSchema;
  const ajv = new Ajv({ schemaId: "auto", allErrors: true });
  assert.equal(ajv.validateSchema(schema), true, ajv.errorsText(ajv.errors));
  const validate = ajv.compile(schema);
  return { schema, validate };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function atPath(root: unknown, path: readonly (string | number)[]): Record<string, unknown> | unknown[] {
  let value = root as unknown;
  for (const segment of path) value = (value as Record<string | number, unknown>)[segment];
  assert.ok(value && typeof value === "object");
  return value as Record<string, unknown> | unknown[];
}

function resolveSchema(root: JsonSchema, raw: unknown): JsonSchema {
  let schema = raw as JsonSchema;
  if (typeof schema.$ref === "string") {
    const prefix = "#/definitions/";
    assert.ok(schema.$ref.startsWith(prefix));
    schema = (root.definitions as Record<string, JsonSchema>)[schema.$ref.slice(prefix.length)]!;
  }
  if (Array.isArray(schema.allOf)) {
    const objectPart = schema.allOf.map((item) => resolveSchema(root, item)).find((item) => item.type === "object");
    if (objectPart) schema = objectPart;
  }
  return schema;
}

function structuralObjectCases(root: JsonSchema, artifact: CutYamnetSemanticAnalysis) {
  const cases: Array<Readonly<{ label: string; mutate: (value: CutYamnetSemanticAnalysis) => void }>> = [];
  const visit = (value: unknown, rawSchema: unknown, path: readonly (string | number)[]) => {
    const schema = resolveSchema(root, rawSchema);
    if (schema.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
      const required = Array.isArray(schema.required) ? schema.required as string[] : [];
      for (const field of required) {
        cases.push({
          label: `missing ${[...path, field].join(".")}`,
          mutate: (candidate) => { delete (atPath(candidate, path) as Record<string, unknown>)[field]; },
        });
      }
      cases.push({
        label: `unknown ${path.join(".") || "$"}`,
        mutate: (candidate) => { (atPath(candidate, path) as Record<string, unknown>).unexpected = true; },
      });
      const properties = schema.properties as Record<string, unknown> | undefined;
      if (properties) for (const [field, childSchema] of Object.entries(properties)) {
        if (Object.hasOwn(value as object, field)) visit((value as Record<string, unknown>)[field], childSchema, [...path, field]);
      }
      return;
    }
    if (schema.type === "array" && Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const itemSchema = Array.isArray(schema.items) ? schema.items[index] : schema.items;
        if (itemSchema) visit(value[index], itemSchema, [...path, index]);
      }
    }
  };
  visit(artifact, root, []);
  return cases;
}

function artifactHashMatches(value: CutYamnetSemanticAnalysis) {
  const { analysisSha256, ...body } = value;
  return digest(stableJsonStringify(body)) === analysisSha256;
}

function rehashArtifact(value: Record<string, any>) {
  const body = clone(value);
  delete body.analysisSha256;
  return { ...body, analysisSha256: digest(stableJsonStringify(body)) };
}

function rehashProvider(value: Record<string, any>) {
  const body = clone(value);
  delete body.analysisSha256;
  return { ...body, analysisSha256: digest(stableJsonStringify(body)) };
}

function rehashTaxonomy(value: Record<string, any>) {
  const body = clone(value);
  delete body.suggestionsSha256;
  return { ...body, suggestionsSha256: digest(stableJsonStringify(body)) };
}

function waveVariantSemanticLawMatches(value: CutYamnetSemanticAnalysis) {
  const item = value.normalization.wave;
  return item.validBitsPerSample === item.bitsPerSample
    && (item.formatVariant !== "classic-pcm" || item.channelMask === 0);
}

test("closed Draft-07 schema admits one complete runtime-produced semantic analysis and binds current policy identities", async () => {
  const [{ schema, validate }, { artifact }, { artifact: extensibleArtifact }] = await Promise.all([
    compiledSchema(),
    runtimeFixture(),
    runtimeFixture(extensibleWave()),
  ]);
  assert.equal(schema.$schema, "http://json-schema.org/draft-07/schema#");
  assert.deepEqual(schema.required, [
    "analysisSha256", "derivationInputs", "format", "limitations", "normalization",
    "provider", "signal", "source", "taxonomy", "version",
  ], "pre-release schema v1 must retain its exact embedded-derivation root shape");
  assert.deepEqual(
    ((schema.definitions as Record<string, JsonSchema>).provider!.required),
    [
      "aggregateTopClasses", "analysisSha256", "authorities", "declarations", "evidenceScope",
      "format", "framing", "input", "patches", "provider", "rawScores", "stderr", "topK", "version",
    ],
    "pre-release schema v1 must retain the complete upstream provider body needed to recheck analysisSha256",
  );
  assert.equal(validate(artifact), true, JSON.stringify(validate.errors));
  assert.equal(validate(extensibleArtifact), true, JSON.stringify(validate.errors));
  assert.equal(artifactHashMatches(artifact), true);
  assert.deepEqual(verifyCutYamnetSemanticAnalysisDerivation(artifact), artifact);
  assert.equal(artifactHashMatches(extensibleArtifact), true);
  assert.equal(waveVariantSemanticLawMatches(artifact), true);
  assert.equal(waveVariantSemanticLawMatches(extensibleArtifact), true);
  assert.deepEqual(
    {
      formatVariant: artifact.normalization.wave.formatVariant,
      validBitsPerSample: artifact.normalization.wave.validBitsPerSample,
      channelMask: artifact.normalization.wave.channelMask,
    },
    { formatVariant: "classic-pcm", validBitsPerSample: 16, channelMask: 0 },
  );
  assert.deepEqual(
    {
      formatVariant: extensibleArtifact.normalization.wave.formatVariant,
      validBitsPerSample: extensibleArtifact.normalization.wave.validBitsPerSample,
      channelMask: extensibleArtifact.normalization.wave.channelMask,
    },
    { formatVariant: "extensible-pcm", validBitsPerSample: 16, channelMask: 0 },
  );
  const { evidenceSha256, ...normalizationBody } = artifact.normalization;
  assert.equal(digest(stableJsonStringify(normalizationBody)), evidenceSha256);
  const { suggestionsSha256, ...taxonomyBody } = artifact.taxonomy;
  assert.equal(digest(stableJsonStringify(taxonomyBody)), suggestionsSha256);
  assert.equal(artifact.normalization.policy.policySha256, cutWaveNormalizePolicy.policySha256);
  assert.equal(artifact.taxonomy.policySha256, cutYamnetAudioSetMapV1.policySha256);
  assert.equal(artifact.taxonomy.sourceScores.labelMapSha256, cutYamnetAudioSetLabelMapSha256);
  assert.equal(artifact.derivationInputs.rawScores.sha256, artifact.provider.rawScores.sha256);
  assert.equal(artifact.derivationInputs.classMap.sha256, artifact.provider.authorities.classMapSha256);
  assert.equal(Buffer.from(artifact.derivationInputs.rawScores.data, "base64").byteLength, artifact.derivationInputs.rawScores.bytes);
  assert.equal(Buffer.from(artifact.derivationInputs.classMap.data, "base64").byteLength, artifact.derivationInputs.classMap.bytes);
  assert.deepEqual(artifact.limitations, cutYamnetSemanticAnalysisPolicy.limitations);
  assert.ok(artifact.signal.tempo.candidates.length > 0, "representative runtime fixture must exercise tempo candidate shape");
});

test("every required object field and every reached object unknown-field boundary fails closed", async () => {
  const [{ schema, validate }, { artifact }] = await Promise.all([compiledSchema(), runtimeFixture()]);
  const cases = structuralObjectCases(schema, artifact);
  assert.ok(cases.length > 250, `expected broad nested coverage, observed ${cases.length}`);
  for (const item of cases) {
    const candidate = clone(artifact);
    item.mutate(candidate);
    assert.equal(validate(candidate), false, item.label);
  }
});

test("key enums, integer ranges, scores, hashes, locator, policies, and limitation ceilings fail closed", async () => {
  const [{ validate }, { artifact }] = await Promise.all([compiledSchema(), runtimeFixture()]);
  const cases: Array<readonly [string, (value: Record<string, any>) => void]> = [
    ["format", (value) => { value.format = "forged"; }],
    ["locator parent", (value) => { value.source.locator = "../source.wav"; }],
    ["locator control", (value) => { value.source.locator = "media/bad\nsource.wav"; }],
    ["source bytes", (value) => { value.source.bytes = 0; }],
    ["uppercase sha", (value) => { value.source.sha256 = "A".repeat(64); }],
    ["short sha", (value) => { value.analysisSha256 = "0".repeat(63); }],
    ["wave rate", (value) => { value.normalization.wave.sampleRate = 7_999; }],
    ["wave format variant", (value) => { value.normalization.wave.formatVariant = "foreign-pcm"; }],
    ["wave bits", (value) => { value.normalization.wave.bitsPerSample = 20; }],
    ["wave valid bits", (value) => { value.normalization.wave.validBitsPerSample = 20; }],
    ["wave channel mask lower", (value) => { value.normalization.wave.channelMask = -1; }],
    ["wave channel mask upper", (value) => { value.normalization.wave.channelMask = 262_144; }],
    ["normalizer policy", (value) => { value.normalization.policy.policySha256 = "0".repeat(64); }],
    ["provider", (value) => { value.provider.provider = "foreign"; }],
    ["provider format", (value) => { value.provider.format = "foreign"; }],
    ["provider stderr", (value) => { value.provider.stderr.bytes = -1; }],
    ["raw score encoding", (value) => { value.derivationInputs.rawScores.encoding = "hex"; }],
    ["raw score embedded bytes", (value) => { value.derivationInputs.rawScores.bytes = 2_083; }],
    ["raw score embedded base64", (value) => { value.derivationInputs.rawScores.data = "not_base64"; }],
    ["class map embedded bytes", (value) => { value.derivationInputs.classMap.bytes = 6_229; }],
    ["class map embedded identity", (value) => { value.derivationInputs.classMap.sha256 = "0".repeat(64); }],
    ["topK lower", (value) => { value.provider.topK = 0; }],
    ["topK upper", (value) => { value.provider.topK = 21; }],
    ["class index", (value) => { value.provider.aggregateTopClasses[0].classIndex = 521; }],
    ["class score lower", (value) => { value.provider.aggregateTopClasses[0].score = -0.01; }],
    ["class score upper", (value) => { value.provider.aggregateTopClasses[0].score = 1.01; }],
    ["class map identity", (value) => { value.provider.authorities.classMapSha256 = "0".repeat(64); }],
    ["taxonomy policy", (value) => { value.taxonomy.policySha256 = "0".repeat(64); }],
    ["role order", (value) => { value.taxonomy.aggregate.roleSuggestions[0].id = "music"; }],
    ["mood order", (value) => { value.taxonomy.aggregate.musicMoodSuggestions[0].id = "somber"; }],
    ["suggestion ppm", (value) => { value.taxonomy.aggregate.roleSuggestions[0].scorePpm = 1_000_001; }],
    ["activity state", (value) => { value.signal.activity[0].state = "unknown"; }],
    ["dbfs lower", (value) => { value.signal.activity[0].rmsDbfsMilli = -120_001; }],
    ["dbfs upper", (value) => { value.signal.activity[0].peakDbfsMilli = 1; }],
    ["onset ppm", (value) => { value.signal.onsets[0].strengthPpm = 0; }],
    ["tempo", (value) => { value.signal.tempo.candidates[0].bpmMilli = 49_999; }],
    ["section windows", (value) => { value.signal.sections[0].windowCount = 0; }],
    ["limitation", (value) => { value.limitations.emotion = "emotion-detected"; }],
    ["provider authority limitation", (value) => { value.limitations.providerAuthority = "fully-authenticated"; }],
  ];
  for (const [label, mutate] of cases) {
    const candidate = clone(artifact) as Record<string, any>;
    mutate(candidate);
    assert.equal(validate(candidate), false, label);
  }
});

test("schema and pure materializer agree on representative closed, locator, range, and authority boundaries", async () => {
  const [{ validate }, { input, artifact }] = await Promise.all([compiledSchema(), runtimeFixture()]);
  const pairs: Array<Readonly<{
    label: string;
    runtime: CutYamnetSemanticAnalysisInput;
    schema: (value: Record<string, any>) => void;
  }>> = [
    {
      label: "unknown root field",
      runtime: { ...input, unexpected: true } as CutYamnetSemanticAnalysisInput,
      schema: (value) => { value.unexpected = true; },
    },
    {
      label: "unsafe locator",
      runtime: { ...input, source: { ...input.source, locator: "../source.wav" } },
      schema: (value) => { value.source.locator = "../source.wav"; },
    },
    {
      label: "nonpositive source bytes",
      runtime: { ...input, source: { ...input.source, bytes: 0 } },
      schema: (value) => { value.source.bytes = 0; },
    },
    {
      label: "malformed source hash",
      runtime: { ...input, source: { ...input.source, sha256: "A".repeat(64) } },
      schema: (value) => { value.source.sha256 = "A".repeat(64); },
    },
    {
      label: "provider topK overflow",
      runtime: { ...input, providerAnalysis: { ...input.providerAnalysis, topK: 21 } },
      schema: (value) => { value.provider.topK = 21; },
    },
    {
      label: "foreign class map authority",
      runtime: {
        ...input,
        providerAnalysis: {
          ...input.providerAnalysis,
          authorities: { ...input.providerAnalysis.authorities, classMapSha256: "0".repeat(64) },
        },
      },
      schema: (value) => { value.provider.authorities.classMapSha256 = "0".repeat(64); },
    },
  ];
  for (const item of pairs) {
    assert.throws(
      () => materializeCutYamnetSemanticAnalysis(item.runtime),
      (error: unknown) => error instanceof CutYamnetSemanticMaterializeError,
      item.label,
    );
    const candidate = clone(artifact) as Record<string, any>;
    item.schema(candidate);
    assert.equal(validate(candidate), false, item.label);
  }
});

test("valid-shape self-hash tampering remains structurally typed but fails the explicit canonical identity law", async () => {
  const [{ validate }, { artifact }] = await Promise.all([compiledSchema(), runtimeFixture()]);
  const changed = { ...clone(artifact), analysisSha256: "0".repeat(64) };
  assert.equal(validate(changed), true, JSON.stringify(validate.errors));
  assert.equal(artifactHashMatches(changed), false);
});

test("schema-valid cascade rehashes still fail embedded provider and taxonomy derivation", async () => {
  const [{ validate }, { artifact }] = await Promise.all([compiledSchema(), runtimeFixture()]);

  const taxonomy = clone(artifact) as unknown as Record<string, any>;
  taxonomy.taxonomy.aggregate.roleSuggestions[1].scorePpm -= 1;
  taxonomy.taxonomy = rehashTaxonomy(taxonomy.taxonomy);
  const taxonomyCandidate = rehashArtifact(taxonomy);
  assert.equal(validate(taxonomyCandidate), true, JSON.stringify(validate.errors));
  assert.throws(
    () => verifyCutYamnetSemanticAnalysisDerivation(taxonomyCandidate),
    (error: unknown) => error instanceof CutYamnetSemanticMaterializeError
      && error.code === "CUT_YAMNET_MATERIALIZE_DERIVATION",
  );

  const provider = clone(artifact) as unknown as Record<string, any>;
  provider.provider.patches[0].topClasses[0].label = "Fabricated label";
  provider.provider = rehashProvider(provider.provider);
  const providerCandidate = rehashArtifact(provider);
  assert.equal(validate(providerCandidate), true, JSON.stringify(validate.errors));
  assert.throws(
    () => verifyCutYamnetSemanticAnalysisDerivation(providerCandidate),
    (error: unknown) => error instanceof CutYamnetSemanticMaterializeError
      && error.code === "CUT_YAMNET_MATERIALIZE_TOPK",
  );

  const scores = clone(artifact) as unknown as Record<string, any>;
  const changedScores = Buffer.from(scores.derivationInputs.rawScores.data, "base64");
  changedScores.writeFloatLE(0.2, 0);
  const changedScoreSha256 = digest(changedScores);
  scores.derivationInputs.rawScores.data = changedScores.toString("base64");
  scores.derivationInputs.rawScores.sha256 = changedScoreSha256;
  scores.provider.rawScores.sha256 = changedScoreSha256;
  scores.provider = rehashProvider(scores.provider);
  scores.taxonomy.sourceScores.sha256 = changedScoreSha256;
  scores.taxonomy = rehashTaxonomy(scores.taxonomy);
  const scoreCandidate = rehashArtifact(scores);
  assert.equal(validate(scoreCandidate), true, JSON.stringify(validate.errors));
  assert.throws(
    () => verifyCutYamnetSemanticAnalysisDerivation(scoreCandidate),
    (error: unknown) => error instanceof CutYamnetSemanticMaterializeError
      && error.code === "CUT_YAMNET_MATERIALIZE_TOPK",
  );
});

test("valid-shape WAVE field tampering fails the explicit variant and valid-bit semantic law", async () => {
  const [{ validate }, { artifact }] = await Promise.all([compiledSchema(), runtimeFixture()]);
  const unequalBits = clone(artifact) as unknown as { normalization: { wave: { validBitsPerSample: number } } };
  unequalBits.normalization.wave.validBitsPerSample = 24;
  assert.equal(validate(unequalBits), true, JSON.stringify(validate.errors));
  assert.equal(waveVariantSemanticLawMatches(unequalBits as CutYamnetSemanticAnalysis), false);

  const classicMask = clone(artifact) as unknown as { normalization: { wave: { channelMask: number } } };
  classicMask.normalization.wave.channelMask = 1;
  assert.equal(validate(classicMask), true, JSON.stringify(validate.errors));
  assert.equal(waveVariantSemanticLawMatches(classicMask as CutYamnetSemanticAnalysis), false);
});
