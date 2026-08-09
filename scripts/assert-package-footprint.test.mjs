import assert from "node:assert/strict";
import test from "node:test";
import { assertPackageFootprint } from "./assert-package-footprint.mjs";

const adapterFiles = [
  "adapters/footage-local/NOTICE.md",
  "adapters/footage-local/local-clip-sidecar.mjs",
  "adapters/footage-local/model.json",
  "adapters/footage-local/package-lock.json",
  "adapters/footage-local/package.json",
];

const dependencies = {
  ajv: "6.15.0",
  "bidi-js": "1.0.3",
  "d3-geo": "3.1.1",
  harfbuzzjs: "1.4.0",
  "opentype.js": "1.3.4",
  sharp: "0.35.3",
  "topojson-client": "3.1.0",
  "world-atlas": "2.0.2",
};

function fixture() {
  const files = ["package.json", "dist-cli/cli/cut.js", "dist-cli/lib/footage/index.js", ...adapterFiles]
    .map((path) => ({ path, size: 100, mode: 0o644 }));
  const packageManifest = {
    name: "cut-lang", version: "0.4.0-alpha.4", scripts: { prepack: "npm run cli:build" }, dependencies: { ...dependencies },
    optionalDependencies: { "@img/sharp-wasm32": "0.35.3" },
  };
  const shrinkwrap = { packages: { "": {
    name: packageManifest.name, version: packageManifest.version, dependencies: { ...packageManifest.dependencies },
    optionalDependencies: { ...packageManifest.optionalDependencies },
  } } };
  const pack = [{ name: packageManifest.name, version: packageManifest.version, size: 3_900_000, unpackedSize: 20_000_000, entryCount: files.length, files }];
  return { pack, packageManifest, shrinkwrap };
}

test("package footprint admits only the small five-file adapter recipe", () => {
  const value = fixture();
  const report = assertPackageFootprint(value.pack, value.packageManifest, value.shrinkwrap);
  assert.deepEqual(report, {
    format: "cut-package-footprint-report", version: 1, status: "pass",
    package: "cut-lang@0.4.0-alpha.4", size: 3_900_000, unpackedSize: 20_000_000,
    entryCount: 8, adapterFiles,
  });
});

test("package footprint rejects bloat, hidden model payloads, ML root dependencies, and lifecycle installs", () => {
  for (const mutate of [
    (value) => { value.pack[0].size = 4_031_018; },
    (value) => { value.pack[0].unpackedSize = 21_451_007; },
    (value) => { value.pack[0].entryCount = 984; },
    (value) => { value.pack[0].files.push({ path: "adapters/footage-local/models/model.onnx", size: 1, mode: 0o644 }); value.pack[0].entryCount += 1; },
    (value) => { value.packageManifest.dependencies["@huggingface/transformers"] = "4.2.0"; },
    (value) => { value.shrinkwrap.packages["node_modules/onnxruntime-node"] = { version: "1.24.3" }; },
    (value) => { value.packageManifest.scripts.postinstall = "node install.mjs"; },
    (value) => { value.pack[0].files = value.pack[0].files.filter((entry) => entry.path !== adapterFiles[0]); value.pack[0].entryCount -= 1; },
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => assertPackageFootprint(value.pack, value.packageManifest, value.shrinkwrap), /CUT_PACKAGE_FOOTPRINT/u);
  }
});

test("package footprint requires the audited package and shrinkwrap roots to agree exactly", () => {
  const value = fixture();
  value.shrinkwrap.packages[""].dependencies.ajv = "8.17.1";
  assert.throws(() => assertPackageFootprint(value.pack, value.packageManifest, value.shrinkwrap), /CUT_PACKAGE_FOOTPRINT/u);
});
