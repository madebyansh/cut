import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPackageFootprint,
  cutAudioIntelligenceRequiredFiles,
  cutAudioKokoroMlxAdapterFiles,
  cutAudioYamnetAdapterFiles,
} from "./assert-package-footprint.mjs";

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
  const files = [
    "package.json",
    "dist-cli/cli/cut.js",
    "dist-cli/lib/footage/index.js",
    ...adapterFiles,
    ...cutAudioYamnetAdapterFiles,
    ...cutAudioKokoroMlxAdapterFiles,
    ...cutAudioIntelligenceRequiredFiles,
  ]
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

test("package footprint admits only the audited footage, YAMNet, and Kokoro MLX adapter recipes", () => {
  const value = fixture();
  const report = assertPackageFootprint(value.pack, value.packageManifest, value.shrinkwrap);
  assert.deepEqual(report, {
    format: "cut-package-footprint-report", version: 1, status: "pass",
    package: "cut-lang@0.4.0-alpha.4", size: 3_900_000, unpackedSize: 20_000_000,
    entryCount: 3 + adapterFiles.length + cutAudioYamnetAdapterFiles.length
      + cutAudioKokoroMlxAdapterFiles.length + cutAudioIntelligenceRequiredFiles.length,
    adapterFiles,
    audioAdapterFiles: [...cutAudioYamnetAdapterFiles],
    kokoroMlxAdapterFiles: [...cutAudioKokoroMlxAdapterFiles],
  });
});

test("package footprint requires the public audio-intelligence contract", () => {
  for (const required of cutAudioIntelligenceRequiredFiles) {
    const value = fixture();
    value.pack[0].files = value.pack[0].files.filter((entry) => entry.path !== required);
    value.pack[0].entryCount -= 1;
    assert.throws(
      () => assertPackageFootprint(value.pack, value.packageManifest, value.shrinkwrap),
      new RegExp(`CUT_PACKAGE_FOOTPRINT: tarball is missing ${required.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"),
    );
  }
});

test("package footprint rejects unaudited audio adapters and providers", () => {
  for (const path of [
    "adapters/audio-kokoro-local/setup.mjs",
    "adapters/audio-unreviewed/README.md",
  ]) {
    const value = fixture();
    value.pack[0].files.push({ path, size: 100, mode: 0o644 });
    value.pack[0].entryCount += 1;
    assert.throws(
      () => assertPackageFootprint(value.pack, value.packageManifest, value.shrinkwrap),
      /CUT_PACKAGE_FOOTPRINT: unaudited adapter entered the tarball/u,
    );
  }
  for (const path of [
    "dist-cli/lib/audio-intelligence/kokoro-local.d.ts",
    "dist-cli/lib/audio-intelligence/kokoro-local.js",
    "dist-cli/lib/audio-intelligence/kokoro-local.js.map",
    "dist-cli/lib/audio-intelligence/kokoro-local/provider.json",
    "dist-cli/lib/audio-intelligence/unreviewed-local.js",
    "dist-cli/lib/audio-intelligence/speech-provider.js",
    "dist-cli/lib/audio-intelligence/kokoro-mlx-local/provider.json",
  ]) {
    const value = fixture();
    value.pack[0].files.push({ path, size: 100, mode: 0o644 });
    value.pack[0].entryCount += 1;
    assert.throws(
      () => assertPackageFootprint(value.pack, value.packageManifest, value.shrinkwrap),
      /CUT_PACKAGE_FOOTPRINT: unaudited audio provider entered the tarball/u,
    );
  }
});

test("package footprint requires the exact audited Kokoro MLX adapter inventory", () => {
  for (const required of cutAudioKokoroMlxAdapterFiles) {
    const value = fixture();
    value.pack[0].files = value.pack[0].files.filter((entry) => entry.path !== required);
    value.pack[0].entryCount -= 1;
    assert.throws(
      () => assertPackageFootprint(value.pack, value.packageManifest, value.shrinkwrap),
      /CUT_PACKAGE_FOOTPRINT: tarball must contain exactly the audited Kokoro MLX adapter inventory/u,
    );
  }
  const value = fixture();
  value.pack[0].files.push({ path: "adapters/audio-kokoro-mlx-local/unreviewed.py", size: 100, mode: 0o644 });
  value.pack[0].entryCount += 1;
  assert.throws(
    () => assertPackageFootprint(value.pack, value.packageManifest, value.shrinkwrap),
    /CUT_PACKAGE_FOOTPRINT: tarball must contain exactly the audited Kokoro MLX adapter inventory/u,
  );
});

test("package footprint requires the exact audited YAMNet adapter inventory", () => {
  for (const required of cutAudioYamnetAdapterFiles) {
    const value = fixture();
    value.pack[0].files = value.pack[0].files.filter((entry) => entry.path !== required);
    value.pack[0].entryCount -= 1;
    assert.throws(
      () => assertPackageFootprint(value.pack, value.packageManifest, value.shrinkwrap),
      /CUT_PACKAGE_FOOTPRINT: tarball must contain exactly the three audited YAMNet adapter files/u,
    );
  }
  const value = fixture();
  value.pack[0].files.push({ path: "adapters/audio-yamnet-local/unreviewed.py", size: 100, mode: 0o644 });
  value.pack[0].entryCount += 1;
  assert.throws(
    () => assertPackageFootprint(value.pack, value.packageManifest, value.shrinkwrap),
    /CUT_PACKAGE_FOOTPRINT: tarball must contain exactly the three audited YAMNet adapter files/u,
  );
});

test("package footprint rejects bloat, hidden model payloads, ML root dependencies, and lifecycle installs", () => {
  for (const mutate of [
    (value) => { value.pack[0].size = 4_114_072; },
    (value) => { value.pack[0].unpackedSize = 21_894_583; },
    (value) => { value.pack[0].entryCount = 1_022; },
    (value) => { value.pack[0].files.push({ path: "adapters/footage-local/models/model.onnx", size: 1, mode: 0o644 }); value.pack[0].entryCount += 1; },
    (value) => { value.pack[0].files.push({ path: "models/yamnet.tflite", size: 1, mode: 0o644 }); value.pack[0].entryCount += 1; },
    (value) => { value.pack[0].files.push({ path: "runtime/ai_edge_litert.whl", size: 1, mode: 0o644 }); value.pack[0].entryCount += 1; },
    (value) => { value.pack[0].files.push({ path: "runtime/site-packages/ai_edge_litert/__init__.py", size: 1, mode: 0o644 }); value.pack[0].entryCount += 1; },
    (value) => { value.pack[0].files.find((entry) => entry.path === cutAudioYamnetAdapterFiles[0]).size = 65_536; },
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
