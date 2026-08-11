import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { verifyAudioAuditionInstalled } from "./verify-audio-audition-installed.mjs";

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function installedFixture(root) {
  const binary = resolve(root, "installed", "bin", "cut"), cli = resolve("dist-cli/cli/cut.js");
  await mkdir(resolve(root, "installed", "bin"), { recursive: true });
  await writeFile(binary, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cli)} "$@"\n`, { flag: "wx" });
  await chmod(binary, 0o755);
  return binary;
}

test("audio installed verifier exercises prosody, arrangement, semantic search, audition, cleanup, and no-clobber", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-audition-installed-test-"));
  try {
    const binary = await installedFixture(root), workRoot = resolve(root, "evidence");
    const report = await verifyAudioAuditionInstalled({ cutBinary: binary, workRoot });
    assert.equal(report.format, "cut-audio-audition-installed-verification");
    assert.equal(report.version, 1);
    assert.equal(report.status, "pass");
    assert.deepEqual(report.installed.commands, [
      "audio analyze-setup", "audio analyze-doctor", "audio analyze", "audio prosody", "audio narrate",
      "audio arrange", "audio index", "audio search", "audio audition",
    ]);
    assert.equal(report.prosody.length, 2);
    assert.equal(report.prosody[0].output.fileSha256, report.prosody[1].output.fileSha256);
    assert.equal(report.prosody[0].output.analysisSha256, report.prosody[1].output.analysisSha256);
    assert.equal(report.prosody[0].measured.words, 2);
    assert.equal(report.arrangement.length, 2);
    assert.equal(report.arrangement[0].source.sha256, report.arrangement[1].source.sha256);
    assert.equal(report.arrangement[0].manifest.fileSha256, report.arrangement[1].manifest.fileSha256);
    assert.match(report.arrangement[0].arrangementSha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(report.arrangement[0].generatedSourceCheck, { format: "cut-diagnostics", status: "pass" });
    assert.deepEqual(report.arrangement[0].noClobber, {
      status: "pass",
      diagnosticCode: "CUT_AUDIO_ARRANGEMENT_OUTPUT_EXISTS",
      artifactsUnchanged: true,
    });
    if (process.platform === "darwin" && process.arch === "arm64") {
      assert.equal(report.narrationPlatformBoundary.status, "not-run-on-supported-host");
      assert.equal(report.narrationPlatformBoundary.inference, "unperformed");
    } else {
      assert.deepEqual(report.narrationPlatformBoundary, {
        status: "pass",
        platform: `${process.platform}-${process.arch}`,
        diagnosticCode: "CUT_KOKORO_MLX_PLATFORM",
        outputsPublished: 0,
        inference: "unperformed",
      });
    }
    assert.equal(report.search.length, 2);
    assert.equal(report.search[0].search.resultId, "bed");
    assert.deepEqual(report.search[0].noClobber, { status: "pass", diagnosticCode: "CUT_AUDIO_SEARCH_OUTPUT_EXISTS", artifactUnchanged: true });
    assert.equal(report.determinism.exactSelectionSourceLockWaveAndManifestBytes, true);
    assert.equal(report.determinism.exactProsodyAnalysisBytes, true);
    assert.equal(report.determinism.exactArrangementInputSourceAndManifestBytes, true);
    assert.deepEqual(report.noClobber, { status: "pass", diagnosticCode: "CUT_AUDIO_AUDITION_OUTPUT_EXISTS", artifactsUnchanged: true });
    assert.deepEqual(report.cleanup, { status: "pass", cutStagingResidue: 0, transactionResidue: 0 });
    assert.deepEqual(report.review, {
      generatedArtifact: "non-authoritative-candidate-review",
      humanListening: "unperformed",
      humanRightsApproval: "unperformed",
    });
    assert.equal(JSON.stringify(report).includes(root), false);
    const persisted = JSON.parse(await readFile(resolve(workRoot, "AUDIO_AUDITION_INSTALLED_VERIFICATION.json"), "utf8"));
    assert.deepEqual(persisted, report);
    assert.match(report.reportSha256, /^[a-f0-9]{64}$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installed audio audition verifier refuses a nonempty evidence root before invoking CUT", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-audition-installed-noclobber-"));
  try {
    const workRoot = resolve(root, "evidence");
    await mkdir(workRoot);
    await writeFile(resolve(workRoot, "foreign.txt"), "preserve me\n");
    await assert.rejects(
      verifyAudioAuditionInstalled({ cutBinary: resolve(root, "not-needed"), workRoot }),
      /--work-root must be empty/u,
    );
    assert.equal(await readFile(resolve(workRoot, "foreign.txt"), "utf8"), "preserve me\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
