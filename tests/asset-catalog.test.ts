import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  CutAssetCatalogError,
  loadCutAssetCatalogFile,
  parseCutAssetCatalog,
  searchCutAssetCatalog,
} from "../lib/project/asset-catalog";

const fixture = () => ({
  format: "cut-asset-catalog",
  version: 1,
  name: "Public production candidates",
  description: "Searchable candidate metadata only; selection remains explicit.",
  entries: [
    {
      id: "harbour-cargo-wide",
      label: "Harbour cargo vessel wide shot",
      kind: "video",
      description: "A steady wide view of one cargo vessel crossing frame.",
      tags: ["harbour", "cargo", "ship", "wide"],
      downloadUrl: "https://assets.example.test/harbour-cargo-wide.mov",
      sha256: "1".repeat(64),
      bytes: 123456,
      provenance: {
        creator: "Example Archive",
        license: "CC BY 4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        sourceUrl: "https://archive.example.test/items/harbour-cargo-wide",
        attribution: "Harbour Cargo Wide — Example Archive — CC BY 4.0",
      },
    },
    {
      id: "harbour-water-bed",
      label: "Harbour water ambience",
      kind: "audio",
      description: "Stereo water and distant terminal ambience.",
      tags: ["harbour", "water", "ambience"],
      downloadUrl: "https://assets.example.test/harbour-water-bed.wav",
      sha256: "2".repeat(64),
      bytes: 654321,
      provenance: {
        creator: "Example Recordist",
        license: "CC0 1.0",
        licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
        sourceUrl: "https://archive.example.test/items/harbour-water-bed",
        attribution: "Harbour Water Bed — Example Recordist — CC0 1.0",
      },
    },
  ],
});

test("closed asset catalog search is deterministic, provenance-bearing, and explicitly non-authoritative", () => {
  const source = `${JSON.stringify(fixture(), null, 2)}\n`;
  const first = parseCutAssetCatalog(source), second = parseCutAssetCatalog(source);
  assert.equal(first.catalogSha256, second.catalogSha256);
  const report = searchCutAssetCatalog(first, { query: "cargo harbour", kind: "video", limit: 10 });
  assert.deepEqual(report.results.map((entry) => entry.id), ["harbour-cargo-wide"]);
  assert.equal(report.results[0]!.provenance.license, "CC BY 4.0");
  assert.equal(report.selection.trust, "candidate-only-not-runtime-authority");
  assert.deepEqual(report.selection.requiredSteps, [
    "download-or-copy-selected-bytes-into-project",
    "verify-declared-bytes-and-sha256",
    "run-cut-probe-for-media",
    "declare-explicit-project-local-asset",
    "run-cut-lock",
  ]);
  assert.deepEqual(
    searchCutAssetCatalog(first, { query: "harbour", limit: 10 }).results.map((entry) => entry.id),
    ["harbour-cargo-wide", "harbour-water-bed"],
  );
});

test("catalog and query boundaries fail closed without filename or URL trust", () => {
  const base = fixture();
  assert.throws(
    () => parseCutAssetCatalog(JSON.stringify({ ...base, unknown: true })),
    (error: unknown) => error instanceof CutAssetCatalogError && error.code === "CUT_ASSET_CATALOG_UNKNOWN_FIELD",
  );
  assert.throws(
    () => parseCutAssetCatalog(JSON.stringify({ ...base, entries: [{ ...base.entries[0], downloadUrl: "http://assets.example.test/a.mov" }] })),
    (error: unknown) => error instanceof CutAssetCatalogError && error.code === "CUT_ASSET_CATALOG_URL",
  );
  assert.throws(
    () => parseCutAssetCatalog(JSON.stringify({ ...base, entries: [base.entries[0], base.entries[0]] })),
    (error: unknown) => error instanceof CutAssetCatalogError && error.code === "CUT_ASSET_CATALOG_DUPLICATE",
  );
  assert.throws(
    () => parseCutAssetCatalog('{"format":"cut-asset-catalog","format":"forged","version":1,"name":"x","entries":[]}'),
    (error: unknown) => error instanceof CutAssetCatalogError && error.code === "CUT_ASSET_CATALOG_JSON",
  );
  const catalog = parseCutAssetCatalog(JSON.stringify(base));
  assert.throws(
    () => searchCutAssetCatalog(catalog, { query: "harbour", kind: "executable" as never }),
    (error: unknown) => error instanceof CutAssetCatalogError && error.code === "CUT_ASSET_CATALOG_KIND",
  );
  assert.throws(
    () => searchCutAssetCatalog(catalog, { query: "one two three four five six seven eight nine" }),
    (error: unknown) => error instanceof CutAssetCatalogError && error.code === "CUT_ASSET_CATALOG_LIMIT",
  );
});

test("asset catalog file loading refuses symlinks and the public CLI emits the exact candidate contract", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-asset-catalog-"));
  try {
    const catalogPath = resolve(root, "catalog.json"), linkPath = resolve(root, "catalog-link.json");
    await writeFile(catalogPath, `${JSON.stringify(fixture(), null, 2)}\n`);
    await symlink("catalog.json", linkPath);
    await assert.rejects(
      () => loadCutAssetCatalogFile(linkPath),
      (error: unknown) => error instanceof CutAssetCatalogError && error.code === "CUT_ASSET_CATALOG_FILE",
    );
    const loaded = await loadCutAssetCatalogFile(catalogPath);
    assert.equal(loaded.entries.length, 2);

    const result = spawnSync(process.execPath, [
      resolve("dist-cli/cli/cut.js"), "asset", "search", catalogPath,
      "--query", "harbour cargo", "--kind", "video", "--limit", "5", "--json",
    ], { cwd: resolve("."), encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.format, "cut-asset-catalog-search");
    assert.deepEqual(report.results.map((entry: { id: string }) => entry.id), ["harbour-cargo-wide"]);
    assert.equal(report.selection.trust, "candidate-only-not-runtime-authority");

    const rejected = spawnSync(process.execPath, [
      resolve("dist-cli/cli/cut.js"), "asset", "search", catalogPath,
      "--query", "harbour", "--kind", "executable", "--json",
    ], { cwd: resolve("."), encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    assert.equal(rejected.status, 1, rejected.stderr);
    const diagnostic = JSON.parse(rejected.stdout);
    assert.equal(diagnostic.format, "cut-cli-diagnostics");
    assert.equal(diagnostic.command, "asset search");
    assert.equal(diagnostic.status, "fail");
    assert.equal(diagnostic.diagnostics[0].code, "CUT_ASSET_CATALOG_KIND");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
