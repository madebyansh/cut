#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = path.resolve(scriptDirectory, "..");

function walkFiles(directory, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const locator = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkFiles(locator, output);
    } else if (entry.isFile()) {
      output.push(locator);
    }
  }
  return output;
}

function sourceCandidates(repositoryRoot, compiledLocator) {
  const relative = path.relative(
    path.join(repositoryRoot, "dist-cli"),
    compiledLocator,
  );
  const stem = relative.slice(0, -".js".length);
  return [".ts", ".mts", ".cts"].map((extension) =>
    path.join(repositoryRoot, `${stem}${extension}`),
  );
}

export function auditDistCliOrphans(repositoryRoot = defaultRepositoryRoot) {
  const absoluteRoot = path.resolve(repositoryRoot);
  const distCliRoot = path.join(absoluteRoot, "dist-cli");
  if (!fs.existsSync(distCliRoot) || !fs.statSync(distCliRoot).isDirectory()) {
    throw new Error(
      `CUT_DIST_CLI_ORPHAN: compiled directory is missing: ${distCliRoot}`,
    );
  }

  const files = walkFiles(distCliRoot).sort();
  const missingSources = [];
  const detachedSidecars = [];

  for (const locator of files) {
    if (locator.endsWith(".js")) {
      const candidates = sourceCandidates(absoluteRoot, locator);
      if (!candidates.some((candidate) => fs.existsSync(candidate))) {
        missingSources.push({
          compiled: path.relative(absoluteRoot, locator),
          expectedSources: candidates.map((candidate) =>
            path.relative(absoluteRoot, candidate),
          ),
        });
      }
      continue;
    }

    const compiledSibling = locator.endsWith(".d.ts")
      ? locator.slice(0, -".d.ts".length) + ".js"
      : locator.endsWith(".js.map")
        ? locator.slice(0, -".map".length)
        : undefined;
    if (compiledSibling !== undefined && !fs.existsSync(compiledSibling)) {
      detachedSidecars.push({
        sidecar: path.relative(absoluteRoot, locator),
        expectedCompiled: path.relative(absoluteRoot, compiledSibling),
      });
    }
  }

  return Object.freeze({
    format: "cut-dist-cli-orphan-audit",
    version: 1,
    status:
      missingSources.length === 0 && detachedSidecars.length === 0
        ? "PASS"
        : "FAIL",
    compiledJavaScriptFiles: files.filter((locator) =>
      locator.endsWith(".js"),
    ).length,
    missingSources,
    detachedSidecars,
  });
}

function selfTest() {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "cut-dist-cli-orphan-audit-"),
  );
  try {
    fs.mkdirSync(path.join(temporaryRoot, "lib"), { recursive: true });
    fs.mkdirSync(path.join(temporaryRoot, "dist-cli", "lib"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(temporaryRoot, "lib", "current.ts"), "");
    fs.writeFileSync(
      path.join(temporaryRoot, "dist-cli", "lib", "current.js"),
      "",
    );
    fs.writeFileSync(
      path.join(temporaryRoot, "dist-cli", "lib", "current.d.ts"),
      "",
    );
    fs.writeFileSync(
      path.join(temporaryRoot, "dist-cli", "lib", "current.js.map"),
      "",
    );

    const passing = auditDistCliOrphans(temporaryRoot);
    assert.equal(passing.status, "PASS");
    assert.equal(passing.compiledJavaScriptFiles, 1);

    fs.writeFileSync(
      path.join(temporaryRoot, "dist-cli", "lib", "orphan.js"),
      "",
    );
    fs.writeFileSync(
      path.join(temporaryRoot, "dist-cli", "lib", "detached.d.ts"),
      "",
    );
    const failing = auditDistCliOrphans(temporaryRoot);
    assert.equal(failing.status, "FAIL");
    assert.deepEqual(
      failing.missingSources.map((entry) => entry.compiled),
      ["dist-cli/lib/orphan.js"],
    );
    assert.deepEqual(
      failing.detachedSidecars.map((entry) => entry.sidecar),
      ["dist-cli/lib/detached.d.ts"],
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.includes("--self-test")) {
    selfTest();
  }
  const result = auditDistCliOrphans(defaultRepositoryRoot);
  if (result.status !== "PASS") {
    process.stderr.write(
      `CUT_DIST_CLI_ORPHAN: ${JSON.stringify(result)}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
