import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import Ajv from "ajv";
import { cutAudioAuditionBindingsSha256 } from "../lib/audio-intelligence/audition";
import { stableJsonStringify } from "../lib/core/stable";
import { createYamnetSemanticTestArtifact } from "./yamnet-semantic-test-fixture";

const cli = resolve("dist-cli/cli/cut.js"), writeBoundaryModule = resolve("dist-cli/lib/project/write-boundary.js");
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

function rehashIndex(value: Record<string, unknown>) {
  const { indexSha256: _ignored, ...body } = value;
  return { ...body, indexSha256: sha256(stableJsonStringify(body)) };
}

function run(root: string, args: readonly string[], environment: Readonly<Record<string, string>> = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...environment, NO_COLOR: "1", FORCE_COLOR: "0" },
    timeout: 60_000,
  });
}

function wave(seed: number) {
  const sampleRate = 16_000, frames = 1_600, data = Buffer.alloc(frames * 2), bytes = Buffer.alloc(44 + data.byteLength);
  for (let frame = 0; frame < frames; frame += 1) {
    data.writeInt16LE(Math.round(Math.sin(frame * (0.01 + seed * 0.001)) * 8_000), frame * 2);
  }
  bytes.write("RIFF", 0, "ascii"); bytes.writeUInt32LE(bytes.byteLength - 8, 4); bytes.write("WAVEfmt ", 8, "ascii");
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii"); bytes.writeUInt32LE(data.byteLength, 40); data.copy(bytes, 44);
  return bytes;
}

function grant() {
  return {
    commercialUse: true,
    modification: true,
    audiovisualSynchronization: true,
    standaloneRedistribution: false,
    attributionRequired: true,
    shareAlike: false,
  };
}

const specifications = Object.freeze([
  { id: "ambient-bed", role: "music", tags: ["restrained"], scores: { 234: 0.8, 132: 0.6 }, reviewStatus: "approved" },
  { id: "desk-clicks", role: "sfx", tags: ["office"], scores: { 379: 0.7, 378: 0.5 }, reviewStatus: "approved" },
  { id: "road-bed", role: "ambience", tags: ["location"], scores: { 301: 0.75, 503: 0.5 }, reviewStatus: "pending" },
  { id: "voice-a", role: "dialogue", tags: ["voice"], scores: { 0: 0.9, 3: 0.4 }, reviewStatus: "approved" },
] as const);

type ProjectFixture = Readonly<{
  root: string;
  sourceLocators: Readonly<Record<string, string>>;
  rightsLocators: Readonly<Record<string, string>>;
  semanticLocators: Readonly<Record<string, string>>;
}>;

async function project(): Promise<ProjectFixture> {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-search-cli-"));
  await Promise.all([
    mkdir(resolve(root, "assets")),
    mkdir(resolve(root, "rights")),
    mkdir(resolve(root, ".cut/audio"), { recursive: true }),
  ]);
  const entries: Record<string, unknown>[] = [], bindings: Array<Readonly<{
    id: string;
    audioLocator: string;
    rightsEvidenceLocator: string;
    semanticAnalysis: Readonly<{ locator: string; bytes: number; fileSha256: string; analysisSha256: string }>;
  }>> = [];
  const sourceLocators: Record<string, string> = {}, rightsLocators: Record<string, string> = {}, semanticLocators: Record<string, string> = {};
  for (const [index, specification] of specifications.entries()) {
    const sourceLocator = `assets/${specification.id}.wav`, rightsLocator = `rights/${specification.id}.txt`;
    const semanticLocator = `.cut/audio/${specification.id}.analysis.json`, source = wave(index + 1);
    const rights = Buffer.from(`CC BY 4.0 evidence for ${specification.id}\n`, "utf8");
    const semantic = createYamnetSemanticTestArtifact(source, sourceLocator, specification.scores);
    sourceLocators[specification.id] = sourceLocator; rightsLocators[specification.id] = rightsLocator; semanticLocators[specification.id] = semanticLocator;
    await Promise.all([
      writeFile(resolve(root, sourceLocator), source, { flag: "wx" }),
      writeFile(resolve(root, rightsLocator), rights, { flag: "wx" }),
      writeFile(resolve(root, semanticLocator), semantic.bytes, { flag: "wx" }),
    ]);
    entries.push({
      id: specification.id,
      label: `${specification.id} candidate`,
      kind: "audio",
      description: "Exact project-local audio candidate for semantic search.",
      tags: specification.tags,
      downloadUrl: `https://assets.example.test/${specification.id}.wav`,
      sha256: sha256(source),
      bytes: source.byteLength,
      provenance: {
        creator: "CUT fixture",
        license: "CC BY 4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        sourceUrl: `https://assets.example.test/source/${specification.id}`,
        attribution: `${specification.id} by CUT fixture`,
      },
      audio: {
        role: specification.role,
        durationSamples: 1_600,
        sampleRate: 16_000,
        channels: 1,
        moods: [],
        loopable: specification.role === "music" || specification.role === "ambience",
      },
      rights: {
        basis: "source-asserted",
        licenseId: "CC-BY-4.0",
        licenseVersion: "4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        evidenceSha256: sha256(rights),
        compositionGrant: grant(),
        masterGrant: grant(),
        reviewStatus: specification.reviewStatus,
      },
    });
    bindings.push({
      id: specification.id,
      audioLocator: sourceLocator,
      rightsEvidenceLocator: rightsLocator,
      semanticAnalysis: {
        locator: semanticLocator,
        bytes: semantic.bytes.byteLength,
        fileSha256: semantic.fileSha256,
        analysisSha256: semantic.analysis.analysisSha256,
      },
    });
  }
  const catalog = { format: "cut-asset-catalog", version: 1, name: "Semantic audio candidates", entries };
  const bindingBody = { format: "cut-audio-audition-bindings" as const, version: 2 as const, entries: bindings };
  await Promise.all([
    writeFile(resolve(root, "catalog.json"), `${JSON.stringify(catalog)}\n`, { flag: "wx" }),
    writeFile(resolve(root, "bindings.json"), `${JSON.stringify({ ...bindingBody, bindingsSha256: cutAudioAuditionBindingsSha256(bindingBody) })}\n`, { flag: "wx" }),
  ]);
  return Object.freeze({
    root,
    sourceLocators: Object.freeze(sourceLocators),
    rightsLocators: Object.freeze(rightsLocators),
    semanticLocators: Object.freeze(semanticLocators),
  });
}

test("audio index authenticates exact files and search exposes deterministic match evidence for every role", { timeout: 90_000 }, async () => {
  const value = await project();
  try {
    const first = run(value.root, ["audio", "index", "catalog.json", "--bindings", "bindings.json", "--out", ".cut/audio/index.json", "--json"]);
    const second = run(value.root, ["audio", "index", "catalog.json", "--bindings", "bindings.json", "--out", ".cut/audio/index-copy.json", "--json"]);
    assert.equal(first.status, 0, first.stdout + first.stderr); assert.equal(second.status, 0, second.stdout + second.stderr);
    const index = JSON.parse(first.stdout);
    assert.equal(index.format, "cut-audio-semantic-index"); assert.equal(index.status, "pass"); assert.equal(index.entries.length, 4);
    assert.equal(index.limitations.emotion, "no-emotion-inference-claim");
    assert.equal(index.limitations.provider, "authenticated-materialized-evidence-not-provider-reexecution");
    assert.deepEqual(await readFile(resolve(value.root, ".cut/audio/index.json")), await readFile(resolve(value.root, ".cut/audio/index-copy.json")));
    const schema = JSON.parse(await readFile(resolve("schemas/cut-audio-semantic-index-v1.schema.json"), "utf8"));
    const ajv = new Ajv({ allErrors: true, jsonPointers: true, strictKeywords: true });
    ajv.addKeyword("x-cut-semanticConstraints", { validate: () => true });
    const validate = ajv.compile(schema);
    assert.equal(validate(index), true, JSON.stringify(validate.errors));

    const cases = [
      { query: "electronic", role: "music", id: "ambient-bed", source: "authenticated-audioset-aggregate-class" },
      { query: "office typewriter", role: "sfx", id: "desk-clicks", source: "declared-catalog-metadata" },
      { query: "car", role: "ambience", id: "road-bed", source: "authenticated-audioset-aggregate-class" },
      { query: "speech", role: "dialogue", id: "voice-a", source: "authenticated-audioset-aggregate-class" },
    ];
    for (const item of cases) {
      const searched = run(value.root, ["audio", "search", ".cut/audio/index.json", "--query", item.query, "--role", item.role, "--json"]);
      assert.equal(searched.status, 0, searched.stdout + searched.stderr);
      const report = JSON.parse(searched.stdout);
      assert.equal(report.format, "cut-audio-semantic-search"); assert.equal(report.results[0]?.id, item.id, item.query);
      assert.equal(report.results[0]?.score.evidence[0]?.source, item.source, item.query);
      assert.equal(report.limitations.rights, "declared-metadata-filter-not-rights-clearance");
      assert.equal(report.selection.trust, "candidate-only-authenticated-index-snapshot-not-cut-lock-or-rights-clearance");
      assert.equal(searched.stdout.includes(value.root), false);
    }
    const rightsFiltered = run(value.root, ["audio", "search", ".cut/audio/index.json", "--query", "car", "--role", "ambience", "--rights", "declared-commercial-sync", "--json"]);
    assert.equal(rightsFiltered.status, 0, rightsFiltered.stdout + rightsFiltered.stderr);
    assert.deepEqual(JSON.parse(rightsFiltered.stdout).results, []);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("audio search rejects cascade-rehashed unknown, semantic-authority, and coverage drift", { timeout: 90_000 }, async () => {
  const value = await project();
  try {
    const built = run(value.root, ["audio", "index", "catalog.json", "--bindings", "bindings.json", "--out", ".cut/audio/index.json", "--json"]);
    assert.equal(built.status, 0, built.stdout + built.stderr);
    const original = JSON.parse(built.stdout) as Record<string, unknown>;
    const mutations: Array<Readonly<{ name: string; mutate: (value: Record<string, unknown>) => void; code: RegExp }>> = [
      { name: "unknown", mutate: (value) => { value.unknown = true; }, code: /CUT_AUDIO_SEARCH_SCHEMA/u },
      {
        name: "semantic-contract",
        mutate: (value) => { ((value.entries as Array<Record<string, unknown>>)[0]!.semanticAnalysis as Record<string, unknown>).contract = "forged"; },
        code: /CUT_AUDIO_SEARCH_SCHEMA/u,
      },
      {
        name: "coverage",
        mutate: (value) => { (value.coverage as Record<string, unknown>).indexedEntries = 3; },
        code: /CUT_AUDIO_SEARCH_COVERAGE/u,
      },
    ];
    for (const mutation of mutations) {
      const changed = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
      mutation.mutate(changed);
      const locator = `.cut/audio/${mutation.name}.json`;
      await writeFile(resolve(value.root, locator), `${stableJsonStringify(rehashIndex(changed))}\n`, { flag: "wx" });
      const searched = run(value.root, ["audio", "search", locator, "--query", "music", "--json"]);
      assert.equal(searched.status, 1, `${mutation.name}: ${searched.stdout}${searched.stderr}`);
      assert.match(JSON.parse(searched.stdout).diagnostics[0]?.code ?? "", mutation.code, mutation.name);
    }
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("audio index fails closed on source, rights, or semantic byte changes", { timeout: 90_000 }, async () => {
  for (const mutation of ["source", "rights", "semantic"] as const) {
    const value = await project();
    try {
      const locator = mutation === "source" ? value.sourceLocators["ambient-bed"]!
        : mutation === "rights" ? value.rightsLocators["ambient-bed"]! : value.semanticLocators["ambient-bed"]!;
      await writeFile(resolve(value.root, locator), `hostile ${mutation} bytes\n`);
      const result = run(value.root, ["audio", "index", "catalog.json", "--bindings", "bindings.json", "--out", ".cut/audio/index.json", "--json"]);
      assert.equal(result.status, 1, `${mutation}: ${result.stdout}${result.stderr}`);
      const report = JSON.parse(result.stdout);
      assert.ok(report.diagnostics.some((diagnostic: { code: string }) => /^CUT_AUDIO_(?:SEARCH|AUDITION)_/u.test(diagnostic.code)), mutation);
      await assert.rejects(readFile(resolve(value.root, ".cut/audio/index.json")), { code: "ENOENT" });
      assert.equal(result.stdout.includes(value.root), false);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  }
});

test("audio index is create-only and all public failures remain locator-only", { timeout: 90_000 }, async () => {
  const value = await project();
  try {
    await writeFile(resolve(value.root, "foreign.json"), "foreign\n", { flag: "wx" });
    const occupied = run(value.root, ["audio", "index", "catalog.json", "--bindings", "bindings.json", "--out", "foreign.json", "--json"]);
    assert.equal(occupied.status, 1); assert.equal(JSON.parse(occupied.stdout).diagnostics[0]?.code, "CUT_AUDIO_SEARCH_OUTPUT_EXISTS");
    assert.equal(await readFile(resolve(value.root, "foreign.json"), "utf8"), "foreign\n");
    assert.equal(occupied.stdout.includes(value.root), false); assert.equal(occupied.stdout.includes(tmpdir()), false);

    const missing = run(value.root, ["audio", "search", "missing-index.json", "--query", "music", "--json"]);
    assert.equal(missing.status, 1); assert.match(missing.stdout, /missing-index\.json/u);
    assert.equal(missing.stdout.includes(value.root), false); assert.equal(missing.stdout.includes(tmpdir()), false);

    const badRole = run(value.root, ["audio", "search", "missing-index.json", "--query", "music", "--role", "noise", "--json"]);
    assert.equal(badRole.status, 1); assert.equal(JSON.parse(badRole.stdout).diagnostics[0]?.code, "CUTC1007");
    assert.equal(badRole.stdout.includes("missing-index.json"), false, "closed option validation must fail before input I/O");
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("audio index cancellation at publication rolls back the exact output and temporary file", { timeout: 90_000 }, async () => {
  const value = await project();
  try {
    const preload = resolve(value.root, "cancel-audio-index.cjs");
    await writeFile(preload, `
const boundary = require(${JSON.stringify(writeBoundaryModule)});
const original = boundary.writeProjectArtifacts;
let injected = false;
boundary.writeProjectArtifacts = async (roots, artifacts, verifier) => original(roots, artifacts, async phase => {
  if (!injected && phase === "before-finalize" && artifacts.some(artifact => artifact.role === "audio-semantic-index")) {
    injected = true;
    process.emit("SIGTERM");
  }
  if (verifier) await verifier(phase);
});
`, { flag: "wx" });
    const cancelled = run(value.root, ["audio", "index", "catalog.json", "--bindings", "bindings.json", "--out", ".cut/audio/cancelled.json", "--json"], {
      NODE_OPTIONS: `--require=${preload}`,
    });
    assert.equal(cancelled.status, 1, cancelled.stdout + cancelled.stderr);
    assert.equal(JSON.parse(cancelled.stdout).diagnostics[0]?.code, "CUT_AUDIO_SEARCH_CANCELLED");
    await assert.rejects(readFile(resolve(value.root, ".cut/audio/cancelled.json")), { code: "ENOENT" });
    assert.equal((await readdir(resolve(value.root, ".cut/audio"))).some((name) => name.includes(".cut-") && name.endsWith(".tmp")), false);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("closed help exposes the exact public audio index and search grammars", () => {
  const result = run(process.cwd(), ["help", "--json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const commands = Object.fromEntries(JSON.parse(result.stdout).commands.map((command: { command: string }) => [command.command, command]));
  assert.deepEqual(commands["audio index"].options, [
    { name: "--bindings", kind: "value", required: true },
    { name: "--json", kind: "flag", required: false },
    { name: "--out", kind: "value", required: true },
  ]);
  assert.deepEqual(commands["audio search"].options, [
    { name: "--json", kind: "flag", required: false },
    { name: "--limit", kind: "value", required: false },
    { name: "--query", kind: "value", required: true },
    { name: "--rights", kind: "value", required: false },
    { name: "--role", kind: "value", required: false },
  ]);
});
