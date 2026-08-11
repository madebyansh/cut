#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const maximumJsonBytes = 8 * 1024 * 1024;
const maximumWaveBytes = 8 * 1024 * 1024;
const sampleRate = 8_000;
const durationSamples = 8_000;
const musicStartSample = 0;

function fail(message) {
  throw new Error(`CUT_AUDIO_AUDITION_INSTALLED: ${message}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeJson(value, inArray = false) {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return inArray ? null : undefined;
  if (typeof value === "bigint") throw new TypeError("Canonical JSON cannot encode BigInt values.");
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (Array.isArray(value)) return value.map((entry) => normalizeJson(entry, true));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([key, entry]) => {
        const normalized = normalizeJson(entry);
        return normalized === undefined ? [] : [[key, normalized]];
      }));
  }
  return value;
}

function stableJsonStringify(value) {
  const encoded = JSON.stringify(normalizeJson(value));
  if (encoded === undefined) throw new TypeError("Canonical JSON needs a JSON-serializable root value.");
  return encoded;
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be one JSON object`);
  return value;
}

function exactDigest(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail(`${label} must be one lowercase SHA-256 digest`);
  return value;
}

function exactPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} must be one positive safe integer`);
  return value;
}

async function absent(path, label) {
  const metadata = await lstat(path).catch((error) => error?.code === "ENOENT" ? undefined : Promise.reject(error));
  if (metadata) fail(`${label} must remain absent`);
}

function projectPath(root, locator, label) {
  if (typeof locator !== "string" || locator.length < 1 || isAbsolute(locator) || locator.includes("\\")) {
    fail(`${label} must be one project-relative locator`);
  }
  const parts = locator.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) fail(`${label} is not canonical`);
  const path = resolve(root, ...parts), relation = relative(resolve(root), path);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) fail(`${label} escapes its project`);
  return path;
}

async function boundedFile(path, maximumBytes, label) {
  let handle;
  try {
    const metadata = await lstat(path, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size < 1n || metadata.size > BigInt(maximumBytes)) {
      fail(`${label} must be one 1..${maximumBytes}-byte regular non-symlink file`);
    }
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true }), bytes = await handle.readFile(), after = await handle.stat({ bigint: true });
    if (before.dev !== metadata.dev || before.ino !== metadata.ino || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
      || BigInt(bytes.byteLength) !== before.size) fail(`${label} changed during its authenticated read`);
    return Object.freeze({ bytes, size: bytes.byteLength, sha256: sha256(bytes) });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("CUT_AUDIO_AUDITION_INSTALLED:")) throw error;
    fail(`${label} could not be read safely: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function jsonFile(path, label) {
  const file = await boundedFile(path, maximumJsonBytes, label);
  try { return Object.freeze({ ...file, value: record(JSON.parse(file.bytes.toString("utf8")), label) }); }
  catch (error) { fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

function parseStdoutJson(result, label) {
  if (result.error) fail(`${label} could not launch: ${result.error.message}`);
  if (result.signal) fail(`${label} ended with signal ${result.signal}`);
  if (result.status !== 0) fail(`${label} exited ${String(result.status)}: ${result.stdout}${result.stderr}`);
  if (typeof result.stdout !== "string" || Buffer.byteLength(result.stdout) < 2 || Buffer.byteLength(result.stdout) > maximumJsonBytes) {
    fail(`${label} did not emit one bounded JSON report`);
  }
  try { return record(JSON.parse(result.stdout), label); }
  catch (error) { fail(`${label} stdout is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

function runCut(cutBinary, cwd, args) {
  return spawnSync(cutBinary, args, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: maximumJsonBytes,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
}

function wave(kind) {
  const channels = 2, bitsPerSample = 16, bytesPerSample = bitsPerSample / 8;
  const dataBytes = durationSamples * channels * bytesPerSample, bytes = Buffer.alloc(44 + dataBytes);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + dataBytes, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  bytes.writeUInt16LE(channels * bytesPerSample, 32);
  bytes.writeUInt16LE(bitsPerSample, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < durationSamples; frame += 1) {
    const value = kind === "dialogue"
      ? Math.sin(frame * 0.05) * 0.2
      : frame % 4_000 < 80 ? (1 - (frame % 4_000) / 80) * 0.8 : 0;
    for (let channel = 0; channel < channels; channel += 1) {
      bytes.writeInt16LE(Math.round(value * 32_767), 44 + (frame * channels + channel) * bytesPerSample);
    }
  }
  return bytes;
}

function fakeYamnetPython(platform, machine) {
  return `#!${process.execPath}
const args = process.argv.slice(2), get = flag => args[args.indexOf(flag) + 1];
if (get("--mode") === "doctor") {
  process.stdout.write(JSON.stringify({
    format: "cut-yamnet-local-adapter-result",
    version: 1,
    runtime: { implementation: "CPython", pythonVersion: "3.12.8", platform: ${JSON.stringify(platform)}, machine: ${JSON.stringify(machine)}, liteRtVersion: get("--litert-version") },
    model: { bytes: Number(get("--model-bytes")), sha256: get("--model-sha256") },
    classMap: { bytes: Number(get("--class-map-bytes")), sha256: get("--class-map-sha256"), classCount: 521 },
    policy: { sampleRate: 16000, patchSamples: 15600, patchHopSamples: 7680, rightPadFinalPatch: true, classCount: 521, interpreterThreads: 1 },
  }) + "\\n");
} else {
  const chunks = [];
  process.stdin.on("data", chunk => chunks.push(chunk));
  process.stdin.on("end", () => {
    const samples = Buffer.concat(chunks).length / 4;
    const patches = samples <= 15600 ? 1 : 1 + Math.ceil((samples - 15600) / 7680);
    const scores = Buffer.alloc(patches * 521 * 4);
    for (let patch = 0; patch < patches; patch += 1) {
      for (let index = 0; index < 521; index += 1) {
        const score = index === 137 ? 0.9 : index === 132 ? 0.4 : index === 0 ? 0.1 : 0.001;
        scores.writeFloatLE(score, (patch * 521 + index) * 4);
      }
    }
    process.stdout.write(scores);
  });
}
`;
}

async function prepareSemanticAnalysis(cutBinary, projectRoot) {
  const platform = process.platform === "linux" ? "linux" : process.platform === "darwin" ? "darwin" : undefined;
  const machine = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "arm64" : undefined;
  if (!platform || !machine) fail("installed semantic workflow requires one supported YAMNet host platform");
  const pythonPath = resolve(projectRoot, "provider", "fake-python");
  const environmentRoot = resolve(projectRoot, "provider", "site-packages");
  const liteRtRoot = resolve(environmentRoot, "ai_edge_litert");
  const liteRtMetadata = resolve(environmentRoot, "ai_edge_litert-2.1.6.dist-info");
  const numpyRoot = resolve(environmentRoot, "numpy");
  const modelPath = resolve(projectRoot, "provider", "yamnet.tflite");
  await Promise.all([
    mkdir(liteRtRoot, { recursive: true, mode: 0o700 }),
    mkdir(liteRtMetadata, { recursive: true, mode: 0o700 }),
    mkdir(numpyRoot, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    writeFile(resolve(liteRtRoot, "__init__.py"), "# installed verifier LiteRT fixture\n", { flag: "wx" }),
    writeFile(resolve(liteRtMetadata, "METADATA"), "Name: ai-edge-litert\nVersion: 2.1.6\n", { flag: "wx" }),
    writeFile(resolve(numpyRoot, "__init__.py"), "# installed verifier NumPy fixture\n", { flag: "wx" }),
    writeFile(modelPath, "installed verifier YAMNet model fixture\n", { flag: "wx" }),
    writeFile(pythonPath, fakeYamnetPython(platform, machine), { flag: "wx", mode: 0o700 }),
  ]);
  await chmod(pythonPath, 0o700);
  const recipe = {
    python: { path: pythonPath, pythonVersion: "3.12.8", platform, machine },
    environment: {
      sitePackagesRoot: environmentRoot,
      roots: ["ai_edge_litert", "ai_edge_litert-2.1.6.dist-info", "numpy"],
      revision: "installed-verifier-environment-v1",
    },
    liteRt: {
      roots: ["ai_edge_litert", "ai_edge_litert-2.1.6.dist-info"],
      packageVersion: "2.1.6",
      declaredLicense: "Apache-2.0",
    },
    model: {
      path: modelPath,
      name: "YAMNet TFLite fixture",
      revision: "installed-verifier-model-v1",
      declaredLicense: "Apache-2.0",
      declaredProvenance: "local deterministic installed-verifier fixture; not model-quality evidence",
    },
  };
  await writeFile(projectPath(projectRoot, "yamnet.recipe.json", "YAMNet recipe"), `${stableJsonStringify(recipe)}\n`, { flag: "wx" });
  const setup = runCut(cutBinary, projectRoot, ["audio", "analyze-setup", "yamnet.recipe.json", "--out", "yamnet.setup.json", "--json"]);
  const setupReport = parseStdoutJson(setup, "installed YAMNet setup");
  if (setup.stderr !== "" || setupReport.doctor?.status !== "PASS") fail("installed YAMNet setup/doctor did not pass cleanly");
  const doctor = runCut(cutBinary, projectRoot, ["audio", "analyze-doctor", "--setup", "yamnet.setup.json", "--json"]);
  const doctorReport = parseStdoutJson(doctor, "installed YAMNet doctor");
  if (doctor.stderr !== "" || doctorReport.status !== "PASS") fail("installed YAMNet doctor did not pass cleanly");
  const analyze = runCut(cutBinary, projectRoot, ["audio", "analyze", "assets/bed.wav", "--setup", "yamnet.setup.json", "--out", "bed.analysis.json", "--top", "3", "--json"]);
  const analyzeReport = parseStdoutJson(analyze, "installed YAMNet analysis");
  if (analyze.stderr !== "" || analyzeReport.output?.locator !== "bed.analysis.json") fail("installed YAMNet analysis did not publish the expected artifact");
  const analysis = await jsonFile(projectPath(projectRoot, "bed.analysis.json", "semantic analysis locator"), "semantic analysis");
  if (analysis.value.analysisSha256 !== analyzeReport.output.analysisSha256 || analysis.sha256 !== analyzeReport.output.fileSha256) {
    fail("installed YAMNet analysis report does not bind the published artifact");
  }
  return Object.freeze({
    setup: setupReport,
    doctor: doctorReport,
    analysis: Object.freeze({
      locator: "bed.analysis.json",
      bytes: analysis.size,
      fileSha256: analysis.sha256,
      analysisSha256: exactDigest(analysis.value.analysisSha256, "semantic analysis identity"),
    }),
  });
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

async function createProject(cutBinary, projectRoot) {
  const dialogue = wave("dialogue"), candidate = wave("candidate"), rightsEvidence = Buffer.from("CC BY 4.0 fixture evidence; human approval remains unperformed.\n");
  await Promise.all([
    mkdir(resolve(projectRoot, "assets"), { recursive: true }),
    mkdir(resolve(projectRoot, "rights"), { recursive: true }),
  ]);
  const briefBody = {
    format: "cut-audio-brief",
    version: 1,
    sampleRate,
    durationSamples,
    sourceScriptSha256: "1".repeat(64),
    acts: [{
      id: "hook",
      range: { startSample: 0, endSample: durationSamples },
      narrativeTurn: "hook",
      desiredRoles: ["music"],
      moods: ["curious"],
      energyPpm: 500_000,
      densityPpm: 500_000,
      dialogueSpacePpm: 900_000,
      intent: "Protect the spoken hook while comparing one local music candidate.",
    }],
    events: [],
    intentionalSilences: [],
  };
  const brief = { ...briefBody, briefSha256: sha256(stableJsonStringify(briefBody)) };
  const catalog = {
    format: "cut-asset-catalog",
    version: 1,
    name: "Installed audition fixture",
    entries: [{
      id: "bed",
      label: "Measured bed",
      kind: "audio",
      description: "One exact local PCM candidate for installed-package verification.",
      tags: ["curious"],
      downloadUrl: "https://assets.example.test/bed.wav",
      sha256: sha256(candidate),
      bytes: candidate.byteLength,
      provenance: {
        creator: "CUT fixture",
        license: "CC BY 4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        sourceUrl: "https://assets.example.test/source/bed",
        attribution: "Measured bed by CUT fixture",
      },
      audio: {
        role: "music",
        durationSamples,
        sampleRate,
        channels: 2,
        bpmMilli: 120_000,
        energy: "medium",
        moods: ["curious"],
        loopable: false,
      },
      rights: {
        basis: "source-asserted",
        licenseId: "CC-BY-4.0",
        licenseVersion: "4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        evidenceSha256: sha256(rightsEvidence),
        compositionGrant: grant(),
        masterGrant: grant(),
        reviewStatus: "approved",
      },
    }],
  };
  const transcript = {
    format: "cut-transcript",
    version: 1,
    media: {
      sha256: sha256(dialogue),
      audioStreamIndex: 0,
      audioSampleRate: sampleRate,
      duration: { numerator: "1", denominator: "1" },
    },
    words: [
      { id: "w1", start: { numerator: "0", denominator: "1" }, end: { numerator: "1", denominator: "5" }, text: "CUT", join: "none", speaker: "narrator" },
      { id: "w2", start: { numerator: "2", denominator: "5" }, end: { numerator: "3", denominator: "5" }, text: "speaks.", join: "space", speaker: "narrator" },
    ],
  };
  const baseFiles = {
    "assets/dialogue.wav": dialogue,
    "assets/bed.wav": candidate,
    "rights/bed.txt": rightsEvidence,
    "brief.json": Buffer.from(`${stableJsonStringify(brief)}\n`),
    "catalog.json": Buffer.from(`${stableJsonStringify(catalog)}\n`),
    "transcript.json": Buffer.from(`${stableJsonStringify(transcript)}\n`),
  };
  await Promise.all(Object.entries(baseFiles).map(([locator, bytes]) => writeFile(projectPath(projectRoot, locator, locator), bytes, { flag: "wx" })));
  const semantic = await prepareSemanticAnalysis(cutBinary, projectRoot);
  const bindingsBody = {
    format: "cut-audio-audition-bindings",
    version: 2,
    entries: [{ id: "bed", audioLocator: "assets/bed.wav", rightsEvidenceLocator: "rights/bed.txt", semanticAnalysis: semantic.analysis }],
  };
  const bindings = { ...bindingsBody, bindingsSha256: sha256(stableJsonStringify(bindingsBody)) };
  const files = {
    ...baseFiles,
    "bed.analysis.json": (await boundedFile(projectPath(projectRoot, "bed.analysis.json", "semantic analysis locator"), maximumJsonBytes, "semantic analysis")).bytes,
    "bindings.json": Buffer.from(`${stableJsonStringify(bindings)}\n`),
  };
  await writeFile(projectPath(projectRoot, "bindings.json", "bindings.json"), files["bindings.json"], { flag: "wx" });
  return Object.freeze({
    files: Object.freeze(Object.fromEntries(Object.entries(files).map(([locator, bytes]) => [locator, Object.freeze({ bytes: bytes.byteLength, sha256: sha256(bytes) })]))),
    brief: Object.freeze(brief),
    semantic,
  });
}

function validateHelp(help) {
  if (help.format !== "cut-cli-reference" || help.version !== 1 || help.status !== "pass") fail("installed cut help contract is invalid");
  if (!Array.isArray(help.commands)) fail("installed cut help commands must be an array");
  const exactCommand = (name) => {
    const matches = help.commands.filter((entry) => entry?.command === name);
    if (matches.length !== 1) fail(`installed cut help must expose ${name} exactly once`);
    return record(matches[0], `${name} help`);
  };
  const command = exactCommand("audio audition");
  if (command.category !== "audio" || command.stability !== "alpha" || command.positionals !== 1) fail("installed audio audition help classification changed");
  const options = Object.fromEntries(command.options.map((entry) => [entry.name, entry]));
  const expected = ["--bindings", "--catalog", "--dialogue", "--json", "--music-start-sample", "--out", "--samples", "--top"];
  if (JSON.stringify(Object.keys(options).sort()) !== JSON.stringify(expected)) fail("installed audio audition help options changed");
  for (const name of ["--bindings", "--catalog", "--dialogue", "--out", "--samples"]) if (options[name]?.required !== true) fail(`${name} must remain required`);
  for (const name of ["--json", "--music-start-sample", "--top"]) if (options[name]?.required !== false) fail(`${name} must remain optional`);
  const index = exactCommand("audio index"), search = exactCommand("audio search");
  if (index.category !== "audio" || index.stability !== "alpha" || index.positionals !== 1
    || search.category !== "audio" || search.stability !== "alpha" || search.positionals !== 1) fail("installed audio search help classification changed");
  if (stableJsonStringify(index.options) !== stableJsonStringify([
    { name: "--bindings", kind: "value", required: true },
    { name: "--json", kind: "flag", required: false },
    { name: "--out", kind: "value", required: true },
  ])) fail("installed audio index help options changed");
  if (stableJsonStringify(search.options) !== stableJsonStringify([
    { name: "--json", kind: "flag", required: false },
    { name: "--limit", kind: "value", required: false },
    { name: "--query", kind: "value", required: true },
    { name: "--rights", kind: "value", required: false },
    { name: "--role", kind: "value", required: false },
  ])) fail("installed audio search help options changed");
  const prosody = exactCommand("audio prosody"), narrate = exactCommand("audio narrate"), arrange = exactCommand("audio arrange");
  for (const [name, entry] of [["prosody", prosody], ["narrate", narrate], ["arrange", arrange]]) {
    if (entry.category !== "audio" || entry.stability !== "alpha" || entry.positionals !== 1) {
      fail(`installed audio ${name} help classification changed`);
    }
  }
  if (stableJsonStringify(prosody.options) !== stableJsonStringify([
    { name: "--json", kind: "flag", required: false },
    { name: "--out", kind: "value", required: true },
    { name: "--transcript", kind: "value", required: true },
  ])) fail("installed audio prosody help options changed");
  if (stableJsonStringify(narrate.options) !== stableJsonStringify([
    { name: "--json", kind: "flag", required: false },
    { name: "--language", kind: "value", required: false },
    { name: "--out", kind: "value", required: true },
    { name: "--receipt", kind: "value", required: true },
    { name: "--recipe", kind: "value", required: true },
    { name: "--sample-rate", kind: "value", required: false },
    { name: "--seed", kind: "value", required: false },
    { name: "--speed", kind: "value", required: false },
  ])) fail("installed audio narrate help options changed");
  if (stableJsonStringify(arrange.options) !== stableJsonStringify([
    { name: "--json", kind: "flag", required: false },
    { name: "--manifest", kind: "value", required: true },
    { name: "--out", kind: "value", required: true },
  ])) fail("installed audio arrange help options changed");
}

function canonicalEmbeddedIdentity(value, field, label) {
  const item = record(value, label), observed = exactDigest(item[field], `${label}.${field}`), body = { ...item };
  delete body[field];
  if (observed !== sha256(stableJsonStringify(body))) fail(`${label}.${field} does not bind its canonical content`);
  return observed;
}

async function assertNoTransactionResidue(projectRoot) {
  const pending = [projectRoot], residue = [];
  while (pending.length) {
    const directory = pending.pop(), entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.startsWith(".") && entry.name.includes(".cut-") && entry.name.endsWith(".tmp")) {
        residue.push(entry.name);
      }
    }
  }
  if (residue.length) fail(`installed audio workflows retained ${residue.length} transaction staging file(s)`);
}

async function verifyProsody(cutBinary, projectRoot, fixtureFiles) {
  const args = [
    "audio", "prosody", "assets/dialogue.wav",
    "--transcript", "transcript.json",
    "--out", "dialogue.prosody.json",
    "--json",
  ];
  const result = runCut(cutBinary, projectRoot, args), report = parseStdoutJson(result, "installed audio prosody");
  if (result.stderr !== "" || result.stdout.includes(projectRoot)) fail("installed audio prosody leaked a path or wrote unexpected stderr");
  if (report.format !== "cut-audio-prosody-result" || report.version !== 1 || report.status !== "pass") {
    fail("installed audio prosody result contract changed");
  }
  const expectedSource = fixtureFiles["assets/dialogue.wav"], expectedTranscript = fixtureFiles["transcript.json"];
  if (report.source?.locator !== "assets/dialogue.wav" || report.source?.bytes !== expectedSource.bytes
    || report.source?.sha256 !== expectedSource.sha256) fail("installed prosody result does not bind the exact dialogue WAVE");
  if (report.transcript?.locator !== "transcript.json" || report.transcript?.bytes !== expectedTranscript.bytes
    || report.transcript?.fileSha256 !== expectedTranscript.sha256) fail("installed prosody result does not bind the exact transcript bytes");
  if (report.normalization?.contract !== "authenticated-native-rate-equal-weight-mono-f32-v1"
    || report.normalization?.sourceChannels !== 2 || report.normalization?.outputChannels !== 1
    || report.normalization?.sampleRate !== sampleRate || report.normalization?.durationSamples !== durationSamples) {
    fail("installed prosody normalization contract changed");
  }
  const artifact = await jsonFile(
    projectPath(projectRoot, "dialogue.prosody.json", "dialogue prosody locator"),
    "installed dialogue prosody analysis",
  );
  if (report.output?.locator !== "dialogue.prosody.json" || report.output?.bytes !== artifact.size
    || report.output?.fileSha256 !== artifact.sha256 || report.output?.analysisSha256 !== artifact.value.analysisSha256
    || artifact.bytes.toString("utf8") !== `${stableJsonStringify(artifact.value)}\n`) {
    fail("installed prosody result does not bind the canonical published analysis");
  }
  const analysisSha256 = canonicalEmbeddedIdentity(artifact.value, "analysisSha256", "dialogue prosody analysis");
  if (artifact.value.format !== "cut-dialogue-prosody-analysis" || artifact.value.version !== 1
    || artifact.value.authority?.mediaSha256 !== expectedSource.sha256
    || artifact.value.authority?.sampleRate !== sampleRate || artifact.value.authority?.channels !== 1
    || artifact.value.authority?.durationSamples !== durationSamples
    || artifact.value.range?.startSample !== 0 || artifact.value.range?.endSample !== durationSamples
    || artifact.value.interpretation !== "measured-timing-plus-authored-policy-not-emotion-or-performance-approval"
    || report.measured?.words !== 2) fail("installed prosody analysis changed its authenticated fixture semantics");
  await assertNoTransactionResidue(projectRoot);
  return Object.freeze({
    analysis: artifact.value,
    evidence: Object.freeze({
      sourceSha256: expectedSource.sha256,
      transcriptFileSha256: expectedTranscript.sha256,
      output: Object.freeze({ locator: "dialogue.prosody.json", bytes: artifact.size, fileSha256: artifact.sha256, analysisSha256 }),
      measured: Object.freeze({ words: report.measured.words, phrases: report.measured.phrases, pauses: report.measured.pauses }),
      interpretation: report.limitations?.interpretation,
    }),
  });
}

function arrangementInput(fixture, prosody) {
  const body = {
    format: "cut-audio-arrangement-input",
    version: 1,
    profile: "documentary-podcast-arrangement-v1",
    brief: fixture.brief,
    prosody,
    assets: [
      {
        id: "host-dialogue",
        role: "dialogue",
        locator: "assets/dialogue.wav",
        lockedResourceSha256: fixture.files["assets/dialogue.wav"].sha256,
        sampleRate,
        sourceRange: { startSample: 0, endSample: durationSamples },
        assignment: { kind: "program-dialogue" },
        perspective: {
          distance: "near", gainDbMilli: 0, panPpm: 0, eqFrequencyHz: 3_000,
          eqGainDbMilli: 1_000, eqQMilli: 1_000, reverbWetPpm: 0,
        },
      },
      {
        id: "music-bed",
        role: "music",
        locator: "assets/bed.wav",
        lockedResourceSha256: fixture.files["assets/bed.wav"].sha256,
        sampleRate,
        sourceRange: { startSample: 0, endSample: durationSamples },
        assignment: { kind: "act", actId: "hook" },
        perspective: {
          distance: "mid", gainDbMilli: -3_000, panPpm: 0, eqFrequencyHz: 1_000,
          eqGainDbMilli: -1_000, eqQMilli: 1_000, reverbWetPpm: 0,
        },
      },
    ],
  };
  return Object.freeze({ ...body, inputSha256: sha256(stableJsonStringify(body)) });
}

async function verifyArrangement(cutBinary, projectRoot, fixture, prosody) {
  const input = arrangementInput(fixture, prosody), inputBytes = Buffer.from(`${stableJsonStringify(input)}\n`);
  await writeFile(projectPath(projectRoot, "arrangement-input.json", "arrangement input locator"), inputBytes, { flag: "wx" });
  const args = [
    "audio", "arrange", "arrangement-input.json",
    "--out", "arrangement.cut",
    "--manifest", "review/arrangement.manifest.json",
    "--json",
  ];
  const result = runCut(cutBinary, projectRoot, args), report = parseStdoutJson(result, "installed audio arrange");
  if (result.stderr !== "" || result.stdout.includes(projectRoot)) fail("installed audio arrange leaked a path or wrote unexpected stderr");
  if (report.format !== "cut-audio-arrange-result" || report.version !== 1 || report.status !== "pass") {
    fail("installed audio arrange result contract changed");
  }
  if (report.input?.locator !== "arrangement-input.json" || report.input?.bytes !== inputBytes.byteLength
    || report.input?.sha256 !== sha256(inputBytes) || canonicalEmbeddedIdentity(input, "inputSha256", "audio arrangement input") !== input.inputSha256) {
    fail("installed audio arrange result does not bind the exact input bytes");
  }
  if (report.assets?.count !== 2 || report.assets?.encodedBytes !== fixture.files["assets/dialogue.wav"].bytes + fixture.files["assets/bed.wav"].bytes
    || report.assets?.channelSampleReads !== durationSamples * 4) fail("installed audio arrange work accounting changed");

  const source = await boundedFile(projectPath(projectRoot, "arrangement.cut", "arrangement CUT locator"), maximumJsonBytes, "installed arrangement source");
  const manifest = await jsonFile(
    projectPath(projectRoot, "review/arrangement.manifest.json", "arrangement manifest locator"),
    "installed arrangement manifest",
  );
  const manifestSha256 = canonicalEmbeddedIdentity(manifest.value, "manifestSha256", "audio arrangement manifest");
  if (report.output?.locator !== "arrangement.cut" || report.output?.bytes !== source.size || report.output?.sha256 !== source.sha256
    || report.manifest?.locator !== "review/arrangement.manifest.json" || report.manifest?.bytes !== manifest.size
    || report.manifest?.fileSha256 !== manifest.sha256 || report.manifest?.manifestSha256 !== manifestSha256
    || manifest.bytes.toString("utf8") !== `${stableJsonStringify(manifest.value)}\n`) {
    fail("installed audio arrange result does not bind exact source and manifest bytes");
  }
  if (manifest.value.format !== "cut-audio-arrangement-manifest" || manifest.value.version !== 1
    || manifest.value.authority?.inputSha256 !== input.inputSha256
    || manifest.value.authority?.briefSha256 !== fixture.brief.briefSha256
    || manifest.value.authority?.prosodyAnalysisSha256 !== prosody.analysisSha256
    || manifest.value.authority?.sourceSha256 !== source.sha256
    || manifest.value.clock?.sampleRate !== sampleRate || manifest.value.clock?.durationSamples !== durationSamples
    || !Array.isArray(manifest.value.assets) || manifest.value.assets.length !== 2) {
    fail("installed arrangement manifest changed its canonical authority");
  }
  const manifestAssets = Object.fromEntries(manifest.value.assets.map((asset) => [asset.locator, asset]));
  for (const locator of ["assets/dialogue.wav", "assets/bed.wav"]) {
    if (manifestAssets[locator]?.lockedResourceSha256 !== fixture.files[locator].sha256) {
      fail(`installed arrangement manifest does not bind ${locator}`);
    }
  }
  const sourceText = source.bytes.toString("utf8");
  if (!sourceText.includes('audio("assets/dialogue.wav")') || !sourceText.includes('audio("assets/bed.wav")')
    || !sourceText.includes('Bus(name: "dialogue"') || !sourceText.includes('Bus(name: "music"')) {
    fail("installed arrangement source lost the authenticated assets or routed buses");
  }
  const arrangementBody = {
    format: "cut-audio-arrangement",
    version: 1,
    source: sourceText,
    sourceSha256: source.sha256,
    manifest: manifest.value,
  };
  if (report.arrangementSha256 !== sha256(stableJsonStringify(arrangementBody))) {
    fail("installed audio arrangement identity does not bind source and manifest");
  }
  const checked = parseStdoutJson(runCut(cutBinary, projectRoot, ["check", "arrangement.cut", "--json"]), "installed check of arranged source");
  if (checked.format !== "cut-diagnostics" || checked.status !== "pass") fail("installed check did not accept arranged source");

  const before = Object.freeze({ source: Object.freeze({ bytes: source.size, sha256: source.sha256 }), manifest: Object.freeze({ bytes: manifest.size, sha256: manifest.sha256 }) });
  const occupied = runCut(cutBinary, projectRoot, args);
  if (occupied.error || occupied.signal || occupied.status !== 1) fail("installed audio arrange no-clobber rerun must exit 1 without a signal");
  let diagnostics;
  try { diagnostics = record(JSON.parse(occupied.stdout), "audio arrange no-clobber diagnostics"); }
  catch (error) { fail(`audio arrange no-clobber rerun did not emit JSON diagnostics: ${error instanceof Error ? error.message : String(error)}`); }
  if (!Array.isArray(diagnostics.diagnostics)
    || !diagnostics.diagnostics.some((item) => item?.code === "CUT_AUDIO_ARRANGEMENT_OUTPUT_EXISTS")
    || occupied.stdout.includes(projectRoot) || occupied.stderr.includes(projectRoot)) {
    fail("audio arrange no-clobber did not preserve the private create-only boundary");
  }
  const afterSource = await boundedFile(projectPath(projectRoot, "arrangement.cut", "arrangement CUT locator"), maximumJsonBytes, "arrangement source after no-clobber");
  const afterManifest = await boundedFile(projectPath(projectRoot, "review/arrangement.manifest.json", "arrangement manifest locator"), maximumJsonBytes, "arrangement manifest after no-clobber");
  if (afterSource.size !== before.source.bytes || afterSource.sha256 !== before.source.sha256
    || afterManifest.size !== before.manifest.bytes || afterManifest.sha256 !== before.manifest.sha256) {
    fail("audio arrange no-clobber changed a published artifact");
  }
  await assertNoTransactionResidue(projectRoot);
  return Object.freeze({
    input: Object.freeze({ locator: "arrangement-input.json", bytes: inputBytes.byteLength, fileSha256: sha256(inputBytes), inputSha256: input.inputSha256 }),
    source: Object.freeze({ locator: "arrangement.cut", bytes: source.size, sha256: source.sha256 }),
    manifest: Object.freeze({ locator: "review/arrangement.manifest.json", bytes: manifest.size, fileSha256: manifest.sha256, manifestSha256 }),
    arrangementSha256: report.arrangementSha256,
    generatedSourceCheck: Object.freeze({ format: "cut-diagnostics", status: "pass" }),
    noClobber: Object.freeze({ status: "pass", diagnosticCode: "CUT_AUDIO_ARRANGEMENT_OUTPUT_EXISTS", artifactsUnchanged: true }),
  });
}

async function verifyNarrationPlatformBoundary(cutBinary, projectRoot) {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return Object.freeze({
      status: "not-run-on-supported-host",
      platform: "macos-arm64",
      inference: "unperformed",
      reason: "installed verifier does not fake narration inference or creative quality",
    });
  }
  await Promise.all([
    writeFile(projectPath(projectRoot, "narration-script.txt", "narration script locator"), "CUT narration platform boundary.\n", { flag: "wx" }),
    writeFile(projectPath(projectRoot, "narration-recipe.json", "narration recipe locator"), "{}\n", { flag: "wx" }),
  ]);
  const result = runCut(cutBinary, projectRoot, [
    "audio", "narrate", "narration-script.txt",
    "--recipe", "narration-recipe.json",
    "--out", "narration.wav",
    "--receipt", "narration.receipt.json",
    "--json",
  ]);
  if (result.error || result.signal || result.status !== 1) fail("unsupported-host narration must fail closed with exit 1 and no signal");
  let diagnostics;
  try { diagnostics = record(JSON.parse(result.stdout), "unsupported-host narration diagnostics"); }
  catch (error) { fail(`unsupported-host narration did not emit JSON diagnostics: ${error instanceof Error ? error.message : String(error)}`); }
  if (!Array.isArray(diagnostics.diagnostics)
    || !diagnostics.diagnostics.some((item) => item?.code === "CUT_KOKORO_MLX_PLATFORM")
    || result.stdout.includes(projectRoot) || result.stderr.includes(projectRoot)) {
    fail("unsupported-host narration did not preserve its platform or path-privacy boundary");
  }
  await Promise.all([
    absent(projectPath(projectRoot, "narration.wav", "narration output locator"), "unsupported-host narration WAVE"),
    absent(projectPath(projectRoot, "narration.receipt.json", "narration receipt locator"), "unsupported-host narration receipt"),
  ]);
  await assertNoTransactionResidue(projectRoot);
  return Object.freeze({
    status: "pass",
    platform: `${process.platform}-${process.arch}`,
    diagnosticCode: "CUT_KOKORO_MLX_PLATFORM",
    outputsPublished: 0,
    inference: "unperformed",
  });
}

async function verifySearch(cutBinary, projectRoot, fixtureFiles) {
  const indexArgs = ["audio", "index", "catalog.json", "--bindings", "bindings.json", "--out", "search-index.json", "--json"];
  const indexed = runCut(cutBinary, projectRoot, indexArgs), index = parseStdoutJson(indexed, "installed audio index");
  if (indexed.stderr !== "" || index.format !== "cut-audio-semantic-index" || index.version !== 1 || index.status !== "pass"
    || !Array.isArray(index.entries) || index.entries.length !== 1 || index.entries[0]?.id !== "bed") fail("installed audio index did not publish the exact fixture candidate");
  if (index.limitations?.emotion !== "no-emotion-inference-claim"
    || index.limitations?.rights !== "declared-metadata-filter-not-rights-clearance") fail("installed audio index overstates semantic or rights authority");
  const indexFile = await boundedFile(projectPath(projectRoot, "search-index.json", "search index locator"), maximumJsonBytes, "installed audio index");
  if (indexFile.bytes.toString("utf8") !== indexed.stdout || indexFile.sha256 !== sha256(indexed.stdout)) fail("installed audio index stdout and published bytes differ");
  if (index.entries[0]?.source?.sha256 !== fixtureFiles["assets/bed.wav"].sha256
    || index.entries[0]?.rightsEvidence?.sha256 !== fixtureFiles["rights/bed.txt"].sha256
    || index.entries[0]?.semanticAnalysis?.file?.sha256 !== fixtureFiles["bed.analysis.json"].sha256) fail("installed audio index does not bind the exact source, rights, and semantic bytes");

  const searchArgs = ["audio", "search", "search-index.json", "--query", "measured bed", "--role", "music", "--rights", "declared-commercial-sync", "--limit", "1", "--json"];
  const first = runCut(cutBinary, projectRoot, searchArgs), second = runCut(cutBinary, projectRoot, searchArgs);
  const report = parseStdoutJson(first, "installed audio search"), repeat = parseStdoutJson(second, "installed repeated audio search");
  if (first.stderr !== "" || second.stderr !== "" || first.stdout !== second.stdout
    || stableJsonStringify(report) !== stableJsonStringify(repeat)) fail("installed audio search is not byte-repeatable");
  if (report.format !== "cut-audio-semantic-search" || report.version !== 1 || report.status !== "pass"
    || !Array.isArray(report.results) || report.results.length !== 1 || report.results[0]?.id !== "bed"
    || report.results[0]?.rights?.declaredCommercialSync !== true
    || report.selection?.trust !== "candidate-only-authenticated-index-snapshot-not-cut-lock-or-rights-clearance") fail("installed audio search result changed its candidate-only contract");
  if (first.stdout.includes(projectRoot) || indexed.stdout.includes(projectRoot)) fail("installed audio index/search leaked the project root");

  const before = await boundedFile(projectPath(projectRoot, "search-index.json", "search index locator"), maximumJsonBytes, "search index before no-clobber");
  const occupied = runCut(cutBinary, projectRoot, indexArgs);
  if (occupied.error || occupied.signal || occupied.status !== 1) fail("installed audio index no-clobber rerun must exit 1 without a signal");
  let diagnostics;
  try { diagnostics = record(JSON.parse(occupied.stdout), "audio index no-clobber diagnostics"); }
  catch (error) { fail(`audio index no-clobber rerun did not emit JSON diagnostics: ${error instanceof Error ? error.message : String(error)}`); }
  if (!Array.isArray(diagnostics.diagnostics)
    || !diagnostics.diagnostics.some((item) => item?.code === "CUT_AUDIO_SEARCH_OUTPUT_EXISTS")) fail("audio index no-clobber did not preserve the create-only boundary");
  const after = await boundedFile(projectPath(projectRoot, "search-index.json", "search index locator"), maximumJsonBytes, "search index after no-clobber");
  if (before.sha256 !== after.sha256 || before.size !== after.size) fail("audio index no-clobber changed published bytes");
  return Object.freeze({
    index: Object.freeze({ locator: "search-index.json", bytes: indexFile.size, sha256: indexFile.sha256, indexSha256: index.indexSha256 }),
    search: Object.freeze({ sha256: sha256(first.stdout), searchSha256: report.searchSha256, resultId: "bed" }),
    noClobber: Object.freeze({ status: "pass", diagnosticCode: "CUT_AUDIO_SEARCH_OUTPUT_EXISTS", artifactUnchanged: true }),
  });
}

function selectionBody(receipt) {
  const body = { ...receipt };
  delete body.selectionSha256;
  return body;
}

function recomputePlanIdentity(receipt) {
  const dialogue = record(receipt.inputs.dialogue, "selection.inputs.dialogue");
  const dialogueFile = Object.fromEntries(Object.entries(dialogue).filter(([key]) => key !== "signal"));
  const candidates = receipt.ranking.candidates.map((candidate) => ({
    id: candidate.id,
    rank: candidate.rank,
    score: candidate.score,
    file: candidate.localAuthority.audio,
    rightsEvidence: candidate.localAuthority.rightsEvidence,
    semantic: candidate.localAuthority.semanticAnalysis,
    signal: candidate.measuredSignal,
    placement: candidate.placement,
    leveling: candidate.leveling,
  }));
  const plan = {
    format: "cut-audio-audition-plan",
    version: 1,
    inputs: {
      brief: {
        locator: receipt.inputs.brief.locator,
        fileSha256: receipt.inputs.brief.fileSha256,
        briefSha256: receipt.inputs.brief.briefSha256,
      },
      catalog: {
        locator: receipt.inputs.catalog.locator,
        fileSha256: receipt.inputs.catalog.fileSha256,
        catalogSha256: receipt.inputs.catalog.catalogSha256,
      },
      bindings: {
        locator: receipt.inputs.bindings.locator,
        fileSha256: receipt.inputs.bindings.fileSha256,
        bindingsSha256: receipt.inputs.bindings.bindingsSha256,
      },
      dialogue: dialogueFile,
    },
    range: {
      start: receipt.window.startSample,
      end: receipt.window.endSample,
      musicStartSample: receipt.window.musicStartSample,
    },
    candidates,
  };
  return sha256(stableJsonStringify(plan)).slice(0, 16);
}

async function assertStageRootsEmpty(projectRoot) {
  for (const locator of [".cut/audio-audition-staging", ".cut/review-staging"]) {
    const path = projectPath(projectRoot, locator, locator), metadata = await lstat(path).catch((error) => error?.code === "ENOENT" ? undefined : Promise.reject(error));
    if (!metadata) continue;
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail(`${locator} must be absent or one ordinary directory`);
    const names = await readdir(path);
    if (names.length) fail(`${locator} retained ${names.length} staging entries`);
  }
}

async function verifyWave(path, candidate) {
  const file = await boundedFile(path, maximumWaveBytes, "audition WAVE");
  if (file.sha256 !== exactDigest(candidate.audition.sha256, "candidate.audition.sha256") || file.size !== candidate.audition.bytes) fail("audition WAVE identity does not match the selection");
  const bytes = file.bytes;
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE"
    || bytes.toString("ascii", 12, 16) !== "fmt " || bytes.readUInt16LE(20) !== 1
    || bytes.readUInt16LE(22) !== 2 || bytes.readUInt32LE(24) !== sampleRate
    || bytes.readUInt16LE(34) !== 24 || bytes.toString("ascii", 36, 40) !== "data") fail("audition WAVE is not exact stereo PCM24 on the fixture clock");
  if (bytes.readUInt32LE(40) !== candidate.audition.samples * 2 * 3 || bytes.byteLength !== 44 + bytes.readUInt32LE(40)) fail("audition WAVE sample/byte count is inconsistent");
  return Object.freeze({ locator: candidate.audition.locator, bytes: file.size, sha256: file.sha256 });
}

async function verifyRun(cutBinary, projectRoot, fixtureFiles) {
  const args = [
    "audio", "audition", "brief.json",
    "--dialogue", "assets/dialogue.wav",
    "--catalog", "catalog.json",
    "--bindings", "bindings.json",
    "--samples", `0:${durationSamples}`,
    "--music-start-sample", String(musicStartSample),
    "--out", "review/audio",
    "--top", "1",
    "--json",
  ];
  const result = runCut(cutBinary, projectRoot, args), receipt = parseStdoutJson(result, "installed audio audition");
  if (result.stderr !== "") fail("successful installed audio audition wrote unexpected stderr");
  if (receipt.format !== "cut-audio-audition-selection" || receipt.version !== 1 || receipt.status !== "non-authoritative-candidate-review") fail("selection contract is invalid");
  if (receipt.review?.candidateTrust !== "exact-local-bytes-rights-evidence-and-semantic-derivation-verified-not-legal-clearance"
    || receipt.review?.loudnessDelivery !== "unperformed-draft-audition"
    || receipt.review?.humanListening !== "unperformed" || receipt.review?.humanRightsApproval !== "unperformed") {
    fail("selection must remain candidate-only with human listening and rights approval unperformed");
  }
  if (receipt.window?.semantics !== "half-open-samples" || receipt.window.startSample !== 0
    || receipt.window.endSample !== durationSamples || receipt.window.sampleRate !== sampleRate
    || receipt.window.musicStartSample !== musicStartSample) fail("selection window changed");
  exactDigest(receipt.selectionSha256, "selection.selectionSha256");
  if (receipt.selectionSha256 !== sha256(stableJsonStringify(selectionBody(receipt)))) fail("selectionSha256 does not match canonical selection content");
  if (receipt.planIdentity !== recomputePlanIdentity(receipt)) fail("planIdentity does not match canonical authenticated inputs and ranking");
  const selectionPath = projectPath(projectRoot, "review/audio/selection.json", "selection locator"), selection = await jsonFile(selectionPath, "selection.json");
  if (selection.bytes.toString("utf8") !== `${stableJsonStringify(receipt)}\n`) fail("selection.json bytes differ from canonical CLI stdout");
  if (JSON.stringify(selection.value) !== JSON.stringify(receipt)) fail("selection.json content differs from CLI stdout");

  for (const [name, locator, identityField] of [
    ["brief", "brief.json", "briefSha256"],
    ["catalog", "catalog.json", "catalogSha256"],
    ["bindings", "bindings.json", "bindingsSha256"],
  ]) {
    const input = record(receipt.inputs[name], `selection.inputs.${name}`), expected = fixtureFiles[locator];
    if (input.locator !== locator || input.bytes !== expected.bytes || input.fileSha256 !== expected.sha256) fail(`${name} file identity is not bound to the fixture`);
    const parsed = JSON.parse((await boundedFile(projectPath(projectRoot, locator, locator), maximumJsonBytes, locator)).bytes.toString("utf8"));
    if (name === "catalog") {
      if (input[identityField] !== sha256(stableJsonStringify(parsed))) fail("catalogSha256 is not bound to canonical catalog content");
    } else {
      const { [identityField]: declared, ...body } = parsed;
      if (declared !== input[identityField] || declared !== sha256(stableJsonStringify(body))) fail(`${identityField} is not bound to canonical ${name} content`);
    }
  }
  const dialogue = record(receipt.inputs.dialogue, "selection.inputs.dialogue");
  if (dialogue.locator !== "assets/dialogue.wav" || dialogue.bytes !== fixtureFiles["assets/dialogue.wav"].bytes
    || dialogue.sha256 !== fixtureFiles["assets/dialogue.wav"].sha256) fail("dialogue bytes are not bound to the selection");

  if (receipt.ranking?.policy !== "brief-catalog-exact-window-signal-and-bounded-semantic-advisory-v3"
    || !Array.isArray(receipt.ranking.candidates) || receipt.ranking.candidates.length !== 1
    || !Array.isArray(receipt.ranking.exclusions) || receipt.ranking.exclusions.length !== 0) fail("selection must contain exactly one measured candidate");
  if (receipt.ranking.semanticAdvisory?.modelReexecution !== "not-performed"
    || receipt.ranking.semanticAdvisory?.embeddedScoreAndTaxonomyDerivation !== "recomputed"
    || receipt.ranking.semanticAdvisory?.sourceNormalizationAndSignal !== "recomputed-from-authenticated-source-bytes") {
    fail("selection does not disclose the exact semantic replay boundary");
  }
  const candidate = record(receipt.ranking.candidates[0], "selection candidate");
  if (candidate.rank !== 1 || candidate.id !== "bed" || candidate.role !== "music") fail("selection candidate identity changed");
  if (candidate.localAuthority?.audio?.locator !== "assets/bed.wav"
    || candidate.localAuthority.audio.bytes !== fixtureFiles["assets/bed.wav"].bytes
    || candidate.localAuthority.audio.sha256 !== fixtureFiles["assets/bed.wav"].sha256
    || candidate.localAuthority?.rightsEvidence?.locator !== "rights/bed.txt"
    || candidate.localAuthority.rightsEvidence.bytes !== fixtureFiles["rights/bed.txt"].bytes
    || candidate.localAuthority.rightsEvidence.sha256 !== fixtureFiles["rights/bed.txt"].sha256) fail("candidate media/rights authority is not bound to exact fixture bytes");
  const semantic = record(candidate.localAuthority?.semanticAnalysis, "candidate semantic authority");
  if (semantic.contract !== "authenticated-source-and-embedded-semantic-derivation-recomputed-without-model-reexecution-v1"
    || semantic.file?.locator !== "bed.analysis.json"
    || semantic.file?.bytes !== fixtureFiles["bed.analysis.json"].bytes
    || semantic.file?.sha256 !== fixtureFiles["bed.analysis.json"].sha256
    || semantic.source?.sha256 !== fixtureFiles["assets/bed.wav"].sha256
    || candidate.score?.semanticAdvisory?.applicability !== "applied-exact-whole-source-music") {
    fail("candidate semantic authority and bounded score adjustment are not bound to the exact installed fixture");
  }
  if (candidate.catalog?.licenseId !== "CC-BY-4.0" || candidate.catalog?.licenseVersion !== "4.0") fail("candidate catalog rights declaration changed");

  const sourcePath = projectPath(projectRoot, candidate.source.locator, "candidate.source.locator"), source = await boundedFile(sourcePath, maximumJsonBytes, "generated CUT source");
  if (source.size !== exactPositiveInteger(candidate.source.bytes, "candidate.source.bytes") || source.sha256 !== exactDigest(candidate.source.sha256, "candidate.source.sha256")) fail("generated CUT source identity does not match selection");
  const sourceText = source.bytes.toString("utf8");
  if (!sourceText.includes("Non-authoritative listening candidate") || !sourceText.includes("Sidechain(source: dialogue") || !sourceText.includes("human clearance remains external")) fail("generated source lost its candidate-only or dialogue-ducking contract");
  const check = parseStdoutJson(runCut(cutBinary, projectRoot, ["check", candidate.source.locator, "--json"]), "installed check of generated source");
  if (check.status !== "pass" || check.format !== "cut-diagnostics") fail("installed check did not accept generated source");

  const lockPath = projectPath(projectRoot, candidate.lock.locator, "candidate.lock.locator"), lock = await jsonFile(lockPath, "generated cut.lock");
  if (lock.size !== exactPositiveInteger(candidate.lock.bytes, "candidate.lock.bytes") || lock.sha256 !== exactDigest(candidate.lock.sha256, "candidate.lock.sha256")
    || lock.value.sourceHash !== candidate.lock.sourceHash) fail("generated lock identity does not match selection");
  const inspect = parseStdoutJson(runCut(cutBinary, projectRoot, ["inspect", candidate.source.locator, "--lock", candidate.lock.locator, "--json"]), "installed inspect of generated source and lock");
  if (inspect.status !== "pass" || inspect.format !== "cut-inspect-report") fail("installed inspect did not revalidate generated source and lock");

  const waveEvidence = await verifyWave(projectPath(projectRoot, candidate.audition.locator, "candidate.audition.locator"), candidate);
  if (candidate.audition.sampleRate !== sampleRate || candidate.audition.samples !== durationSamples || candidate.audition.bytes !== 44 + durationSamples * 2 * 3) fail("selection audition sample contract changed");
  const manifestPath = projectPath(projectRoot, candidate.audition.manifest.locator, "candidate.audition.manifest.locator"), manifest = await jsonFile(manifestPath, "audition manifest");
  if (manifest.size !== exactPositiveInteger(candidate.audition.manifest.bytes, "candidate.audition.manifest.bytes")
    || manifest.sha256 !== exactDigest(candidate.audition.manifest.sha256, "candidate.audition.manifest.sha256")) fail("audition manifest identity does not match selection");
  if (manifest.value.format !== "cut-reference-audio-audition" || manifest.value.version !== 1
    || manifest.value.lock?.resourcesVerified !== true || manifest.value.lock?.sha256 !== candidate.lock.sha256
    || manifest.value.artifact?.file !== basename(candidate.audition.locator)
    || manifest.value.artifact?.sha256 !== candidate.audition.sha256 || manifest.value.artifact?.bytes !== candidate.audition.bytes
    || manifest.value.artifact?.sampleFormat !== "s24le" || manifest.value.artifact?.channels !== 2
    || manifest.value.artifact?.sampleRate !== sampleRate || manifest.value.artifact?.samples !== durationSamples
    || manifest.value.range?.semantics !== "half-open" || manifest.value.range?.startSample !== 0 || manifest.value.range?.endSample !== durationSamples) {
    fail("audition manifest does not bind the exact lock, WAVE, and sample interval");
  }
  await assertStageRootsEmpty(projectRoot);

  const artifacts = Object.freeze({
    selection: Object.freeze({ locator: "review/audio/selection.json", bytes: selection.size, sha256: selection.sha256, selectionSha256: receipt.selectionSha256 }),
    source: Object.freeze({ locator: candidate.source.locator, bytes: source.size, sha256: source.sha256 }),
    lock: Object.freeze({ locator: candidate.lock.locator, bytes: lock.size, sha256: lock.sha256, sourceHash: candidate.lock.sourceHash }),
    wave: waveEvidence,
    manifest: Object.freeze({ locator: candidate.audition.manifest.locator, bytes: manifest.size, sha256: manifest.sha256 }),
  });
  return Object.freeze({ receipt, artifacts, commandArgs: Object.freeze(args) });
}

async function snapshotArtifacts(projectRoot, artifacts) {
  return Object.freeze(Object.fromEntries(await Promise.all(Object.entries(artifacts).map(async ([name, artifact]) => {
    const file = await boundedFile(projectPath(projectRoot, artifact.locator, `${name}.locator`), name === "wave" ? maximumWaveBytes : maximumJsonBytes, `no-clobber ${name}`);
    return [name, Object.freeze({ bytes: file.size, sha256: file.sha256 })];
  }))));
}

async function verifyNoClobber(cutBinary, projectRoot, run) {
  const before = await snapshotArtifacts(projectRoot, run.artifacts), result = runCut(cutBinary, projectRoot, run.commandArgs);
  if (result.error || result.signal || result.status !== 1) fail(`no-clobber rerun must exit 1 without a signal: ${result.stdout}${result.stderr}`);
  let diagnostics;
  try { diagnostics = record(JSON.parse(result.stdout), "no-clobber diagnostics"); }
  catch (error) { fail(`no-clobber rerun did not emit JSON diagnostics: ${error instanceof Error ? error.message : String(error)}`); }
  if (diagnostics.format !== "cut-cli-diagnostics" || !Array.isArray(diagnostics.diagnostics)
    || !diagnostics.diagnostics.some((item) => item?.code === "CUT_AUDIO_AUDITION_OUTPUT_EXISTS")) fail("no-clobber rerun did not fail with CUT_AUDIO_AUDITION_OUTPUT_EXISTS");
  const after = await snapshotArtifacts(projectRoot, run.artifacts);
  if (stableJsonStringify(after) !== stableJsonStringify(before)) fail("no-clobber rerun changed a published artifact");
  await assertStageRootsEmpty(projectRoot);
  return Object.freeze({ status: "pass", diagnosticCode: "CUT_AUDIO_AUDITION_OUTPUT_EXISTS", artifactsUnchanged: true });
}

async function installedBinaryIdentity(cutBinary) {
  if (typeof cutBinary !== "string" || !isAbsolute(cutBinary)) fail("--cut-bin must be an absolute executable path");
  await access(cutBinary, constants.X_OK).catch((error) => fail(`--cut-bin is not executable: ${error.message}`));
  const canonical = await realpath(cutBinary), file = await boundedFile(canonical, maximumJsonBytes, "installed cut binary");
  return Object.freeze({ file: basename(canonical), bytes: file.size, sha256: file.sha256 });
}

async function prepareWorkRoot(workRoot) {
  if (typeof workRoot !== "string" || !isAbsolute(workRoot)) fail("--work-root must be an absolute path");
  const path = resolve(workRoot), current = await lstat(path).catch((error) => error?.code === "ENOENT" ? undefined : Promise.reject(error));
  if (!current) {
    const parent = await lstat(dirname(path));
    if (parent.isSymbolicLink() || !parent.isDirectory()) fail("--work-root parent must be one ordinary directory");
    await mkdir(path, { recursive: false });
  } else if (current.isSymbolicLink() || !current.isDirectory()) fail("--work-root must be absent or one ordinary directory");
  const names = await readdir(path);
  if (names.length) fail("--work-root must be empty so verification cannot clobber prior evidence");
  return path;
}

export async function verifyAudioAuditionInstalled({ cutBinary, workRoot }) {
  const root = await prepareWorkRoot(workRoot), binary = await installedBinaryIdentity(cutBinary);
  const helpResult = runCut(cutBinary, root, ["help", "--json"]), help = parseStdoutJson(helpResult, "installed cut help");
  if (helpResult.stderr !== "") fail("installed cut help wrote unexpected stderr");
  validateHelp(help);
  const runRoots = [resolve(root, "run-a"), resolve(root, "run-b")];
  await Promise.all(runRoots.map((path) => mkdir(path, { recursive: false })));
  const fixtures = [];
  for (const runRoot of runRoots) fixtures.push(await createProject(cutBinary, runRoot));
  const prosodies = [];
  for (let index = 0; index < runRoots.length; index += 1) {
    prosodies.push(await verifyProsody(cutBinary, runRoots[index], fixtures[index].files));
  }
  const arrangements = [];
  for (let index = 0; index < runRoots.length; index += 1) {
    arrangements.push(await verifyArrangement(cutBinary, runRoots[index], fixtures[index], prosodies[index].analysis));
  }
  const searches = [];
  for (let index = 0; index < runRoots.length; index += 1) searches.push(await verifySearch(cutBinary, runRoots[index], fixtures[index].files));
  const runs = [];
  for (let index = 0; index < runRoots.length; index += 1) runs.push(await verifyRun(cutBinary, runRoots[index], fixtures[index].files));
  const first = runs[0].artifacts, second = runs[1].artifacts;
  for (const field of ["selection", "source", "lock", "wave", "manifest"]) {
    if (first[field].sha256 !== second[field].sha256) fail(`deterministic repeat changed ${field} bytes`);
  }
  if (runs[0].receipt.selectionSha256 !== runs[1].receipt.selectionSha256) fail("deterministic repeat changed selectionSha256");
  if (stableJsonStringify(searches[0]) !== stableJsonStringify(searches[1])) fail("deterministic repeat changed audio index/search evidence");
  if (prosodies[0].evidence.output.fileSha256 !== prosodies[1].evidence.output.fileSha256
    || prosodies[0].evidence.output.analysisSha256 !== prosodies[1].evidence.output.analysisSha256) {
    fail("deterministic repeat changed prosody analysis bytes or identity");
  }
  for (const field of ["input", "source", "manifest"]) {
    const hashField = field === "manifest" ? "fileSha256" : field === "input" ? "fileSha256" : "sha256";
    if (arrangements[0][field][hashField] !== arrangements[1][field][hashField]) {
      fail(`deterministic repeat changed arrangement ${field} bytes`);
    }
  }
  if (arrangements[0].arrangementSha256 !== arrangements[1].arrangementSha256) fail("deterministic repeat changed arrangement identity");
  const noClobber = await verifyNoClobber(cutBinary, runRoots[0], runs[0]);
  const narrationPlatformBoundary = await verifyNarrationPlatformBoundary(cutBinary, runRoots[0]);
  for (const runRoot of runRoots) {
    await assertStageRootsEmpty(runRoot);
    await assertNoTransactionResidue(runRoot);
  }
  const body = {
    format: "cut-audio-audition-installed-verification",
    version: 1,
    status: "pass",
    installed: {
      binary,
      product: help.product,
      helpSha256: sha256(helpResult.stdout),
      commands: Object.freeze([
        "audio analyze-setup", "audio analyze-doctor", "audio analyze", "audio prosody", "audio narrate",
        "audio arrange", "audio index", "audio search", "audio audition",
      ]),
    },
    fixture: {
      sampleRate,
      durationSamples,
      musicStartSample,
      inputs: fixtures[0].files,
      semanticProvider: "deterministic-fake-provider-for-installed-wiring-not-model-quality-evidence",
      rightsScope: "candidate-metadata-and-exact-evidence-only-not-legal-clearance",
    },
    prosody: prosodies.map((item, index) => ({ id: `run-${index + 1}`, ...item.evidence })),
    arrangement: arrangements.map((item, index) => ({ id: `run-${index + 1}`, ...item })),
    narrationPlatformBoundary,
    runs: runs.map((run, index) => ({ id: `run-${index + 1}`, artifacts: run.artifacts })),
    search: searches,
    determinism: {
      status: "pass",
      exactSelectionSourceLockWaveAndManifestBytes: true,
      exactProsodyAnalysisBytes: true,
      exactArrangementInputSourceAndManifestBytes: true,
    },
    noClobber,
    cleanup: { status: "pass", cutStagingResidue: 0, transactionResidue: 0 },
    review: {
      generatedArtifact: "non-authoritative-candidate-review",
      humanListening: "unperformed",
      humanRightsApproval: "unperformed",
    },
  };
  const report = Object.freeze({ ...body, reportSha256: sha256(stableJsonStringify(body)) }), reportBytes = Buffer.from(`${stableJsonStringify(report)}\n`);
  const stage = resolve(root, ".AUDIO_AUDITION_INSTALLED_VERIFICATION.json.stage"), destination = resolve(root, "AUDIO_AUDITION_INSTALLED_VERIFICATION.json");
  try {
    await writeFile(stage, reportBytes, { flag: "wx" });
    await rename(stage, destination);
  } catch (error) {
    await rm(stage, { force: true });
    throw error;
  }
  const published = await boundedFile(destination, maximumJsonBytes, "installed verification report");
  if (!published.bytes.equals(reportBytes)) fail("published verification report bytes changed");
  return report;
}

function runSelfTest() {
  const first = { z: 1, a: { y: 2, x: [3, undefined] } }, second = { a: { x: [3, null], y: 2 }, z: 1 };
  assert.equal(stableJsonStringify(first), stableJsonStringify(second));
  const pcm = wave("dialogue");
  assert.equal(pcm.toString("ascii", 0, 4), "RIFF");
  assert.equal(pcm.readUInt32LE(24), sampleRate);
  assert.equal(pcm.readUInt16LE(22), 2);
  assert.equal(pcm.readUInt16LE(34), 16);
  assert.throws(() => projectPath("/tmp/cut-audio-self-test", "../escape", "hostile locator"), /CUT_AUDIO_AUDITION_INSTALLED/u);
  return { format: "cut-audio-audition-installed-verifier-self-test", version: 1, status: "pass", assertions: 7 };
}

function options(tokens) {
  const result = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const name = tokens[index], value = tokens[index + 1];
    if (!["--cut-bin", "--work-root"].includes(name) || !value || value.startsWith("--") || Object.hasOwn(result, name)) {
      fail("usage: verify-audio-audition-installed.mjs --cut-bin <absolute-installed-cut> --work-root <absolute-empty-directory>");
    }
    result[name] = value;
  }
  if (Object.keys(result).length !== 2) fail("usage: verify-audio-audition-installed.mjs --cut-bin <absolute-installed-cut> --work-root <absolute-empty-directory>");
  return result;
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === "--self-test") {
    process.stdout.write(`${stableJsonStringify(runSelfTest())}\n`);
    return;
  }
  const parsed = options(process.argv.slice(2));
  const report = await verifyAudioAuditionInstalled({ cutBinary: parsed["--cut-bin"], workRoot: parsed["--work-root"] });
  process.stdout.write(`${stableJsonStringify(report)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
