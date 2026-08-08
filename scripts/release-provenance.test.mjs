import assert from "node:assert/strict";
import test from "node:test";
import { createReleaseProvenance } from "./release-provenance.mjs";

const hash = (character) => character.repeat(64);
const tool = (policyLabel, character, version = "1.0.0") => ({
  policyLabel,
  version,
  canonicalPathStringSha256: hash(character),
  bytes: 123,
  sha256: hash(character),
});
const fixture = (overrides = {}) => ({
  packageName: "cut-lang",
  packageVersion: "0.4.0-alpha.2",
  artifactProfile: "runtime",
  artifact: { name: "cut-lang-0.4.0-alpha.2.tgz", bytes: 1234, sha256: hash("a") },
  payloadPaths: ["README.md", "dist-cli/cli/cut.js", "package.json"],
  materials: { shrinkwrapSha256: hash("b"), sbomSha256: hash("c") },
  reproducibility: { byteIdentical: true, sameSourceReplaySha256: hash("a") },
  builder: {
    platform: "darwin",
    architecture: "arm64",
    tools: {
      node: tool("frozen-node20", "d", "v20.20.2"),
      npm: tool("path-npm", "e", "10.8.2"),
      ffmpeg: tool("path-ffmpeg", "f", "ffmpeg 7.1.1"),
      ffprobe: tool("path-ffprobe", "1", "ffprobe 7.1.1"),
    },
  },
  networkMode: "offline-cache-only",
  ...overrides,
});

test("release provenance is deterministic, path-free, and binds artifact, materials, and payload", () => {
  const first = createReleaseProvenance(fixture());
  const second = createReleaseProvenance(fixture({ payloadPaths: ["package.json", "README.md", "dist-cli/cli/cut.js"] }));
  assert.equal(first.encoded, second.encoded);
  assert.equal(first.summary.subjectSha256, hash("a"));
  assert.equal(first.summary.payloadEntries, 3);
  assert.match(first.summary.payloadManifestSha256, /^[0-9a-f]{64}$/);
  assert.equal(first.statement.signature.status, "unsigned");
  assert.equal(first.summary.toolIdentities, 4);
  assert.deepEqual(Object.keys(first.statement.build.builder.tools), ["ffmpeg", "ffprobe", "node", "npm"]);
  assert.doesNotMatch(first.encoded, /\/Users\/|\\Users\\|private\/var|tmp\//);
});

test("release provenance rejects a non-reproducible subject and unsafe payload identity", () => {
  assert.throws(() => createReleaseProvenance(fixture({ reproducibility: { byteIdentical: true, sameSourceReplaySha256: hash("d") } })), /byte-identical/);
  assert.throws(() => createReleaseProvenance(fixture({ payloadPaths: ["README.md", "../secret"] })), /package-relative/);
  assert.throws(() => createReleaseProvenance(fixture({ payloadPaths: ["README.md", "README.md"] })), /duplicates/);
  assert.throws(() => createReleaseProvenance(fixture({ materials: { shrinkwrapSha256: "bad", sbomSha256: hash("c") } })), /SHA-256/);
  assert.throws(() => createReleaseProvenance(fixture({ builder: { ...fixture().builder, tools: { ...fixture().builder.tools, node: { ...fixture().builder.tools.node, sha256: "bad" } } } })), /SHA-256/);
  assert.throws(() => createReleaseProvenance(fixture({ builder: { ...fixture().builder, tools: { ...fixture().builder.tools, extra: tool("extra", "2") } } })), /exactly node, npm, ffmpeg, and ffprobe/);
});
