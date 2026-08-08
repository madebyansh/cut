import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  createReferenceDependencyIdentity,
  referenceDependencyIdentity,
  referenceDependencyNames,
  type ReferenceDependencyName,
} from "../lib/language/dependency-identity";
import { compileCutModule } from "../lib/language/compiler";
import { builtinPackageImplementationFiles, fingerprintPackageImplementation } from "../lib/language/packages";
import { parseCutLanguage } from "../lib/language/parser";
import { createIncrementalRenderPlan } from "../lib/runtime/graph";
import {
  collectReferenceBackendIdentity,
  createReferenceBackendIdentity,
  type CutReferenceCompositorIdentity,
  type CutReferenceNativeIdentity,
} from "../lib/runtime/reference/runtime-identity";
import { cutReferenceRuntimeIdentity } from "../lib/version";

function versionMap() {
  return Object.fromEntries(referenceDependencyIdentity.packages.map(({ name, version }) => [name, version])) as Record<ReferenceDependencyName, string>;
}

function native(overrides: Partial<CutReferenceNativeIdentity> = {}): CutReferenceNativeIdentity {
  return {
    platform: process.platform,
    architecture: process.arch,
    nodeAbi: process.versions.modules!,
    sharp: versionMap().sharp,
    libvips: "8.17.3",
    ...overrides,
  };
}

function nativeCompositor(overrides: Partial<Extract<CutReferenceCompositorIdentity, { mode: "native" }>> = {}): Extract<CutReferenceCompositorIdentity, { mode: "native" }> {
  return {
    mode: "native",
    platform: process.platform,
    architecture: process.arch,
    algorithm: "cut-reference-private-straight-rgba-native-pixel-kernels-v2",
    binarySha256: "1".repeat(64),
    ...overrides,
  };
}

function javascriptCompositor(overrides: Partial<Extract<CutReferenceCompositorIdentity, { mode: "javascript" }>> = {}): Extract<CutReferenceCompositorIdentity, { mode: "javascript" }> {
  return {
    mode: "javascript",
    platform: process.platform,
    architecture: process.arch,
    algorithm: "cut-reference-private-straight-rgba-native-pixel-kernels-v2",
    implementation: "cut-reference-javascript-source-over-v1",
    ...overrides,
  };
}

function fixture() {
  const parsed = parseCutLanguage(`cut 0.4;
project "runtime identity";
import { Rect } from "cut:visual";
timeline main(duration: 1s, fps: 24, width: 64px, height: 64px) {
  scene only(duration: 1s) { Rect(width: 64px, height: 64px, fill: #102030); }
}
export out = render(main);`);
  assert.ok(parsed.module);
  assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

test("installed reference dependency identity is closed, canonical, and version-sensitive", () => {
  assert.deepEqual(referenceDependencyIdentity.packages.map(({ name }) => name), [...referenceDependencyNames]);
  assert.match(referenceDependencyIdentity.integrity, /^[a-f0-9]{64}$/);
  const baseline = versionMap();
  assert.deepEqual(createReferenceDependencyIdentity(baseline), referenceDependencyIdentity);
  for (const name of referenceDependencyNames) {
    const changed = { ...baseline, [name]: `${baseline[name]}-identity-test` };
    assert.notEqual(createReferenceDependencyIdentity(changed).integrity, referenceDependencyIdentity.integrity, name);
  }
  assert.throws(
    () => createReferenceDependencyIdentity({ ...baseline, invented: "1.0.0" } as Record<ReferenceDependencyName, string>),
    /must contain exactly/,
  );
});

test("package implementation fingerprints include installed runtime dependency versions", () => {
  const baseline = fingerprintPackageImplementation("@cut/audio");
  const versions = versionMap();
  const changed = createReferenceDependencyIdentity({ ...versions, "d3-geo": `${versions["d3-geo"]}-identity-test` });
  assert.notEqual(fingerprintPackageImplementation("@cut/audio", changed), baseline);
});

test("built-in package fingerprints close over source acceptance and loaded-IR execution boundaries", () => {
  for (const specifier of ["cut:visual", "@cut/audio"] as const) {
    const files = builtinPackageImplementationFiles(specifier);
    for (const required of ["language/checker", "language/compiler", "language/packages", "language/resolution", "language/ir-loader", "runtime/reference/validate"]) {
      assert.ok(files.includes(required), `${required} must participate in ${specifier} implementation identity`);
    }
  }
  assert.ok(builtinPackageImplementationFiles("cut:visual").includes("runtime/reference/trace"));
  assert.ok(builtinPackageImplementationFiles("@cut/audio").includes("runtime/reference/synth"));
  for (const [specifier, required] of [
    ["@cut/audio", "language/audio-role"],
    ["@cut/audio", "runtime/reference/stems"],
    ["@cut/audio", "runtime/reference/audio-resource"],
    ["@cut/audio", "runtime/reference/audio-parametric-eq"],
    ["@cut/edit", "runtime/reference/audio-resource"],
  ] as const) {
    const files = builtinPackageImplementationFiles(specifier);
    assert.ok(files.includes(required), `${required} must participate in ${specifier} implementation identity`);
    const baseline = fingerprintPackageImplementation(specifier);
    const changed = fingerprintPackageImplementation(specifier, referenceDependencyIdentity, new Map([[required, `identity mutation for ${required}`]]));
    assert.notEqual(changed, baseline, `changing ${required} must change ${specifier} implementation identity`);
  }
  for (const required of ["language/audio-edit-operations", "runtime/reference/audio-edit-operations"]) {
    assert.ok(builtinPackageImplementationFiles("@cut/edit").includes(required), `${required} must participate in @cut/edit implementation identity`);
  }
  for (const specifier of ["@cut/audio", "@cut/edit"] as const) {
    const files = builtinPackageImplementationFiles(specifier), required = "core/stable";
    assert.ok(files.includes(required), `${required} must participate in ${specifier} implementation identity`);
    const baseline = fingerprintPackageImplementation(specifier);
    const changed = fingerprintPackageImplementation(specifier, referenceDependencyIdentity, new Map([[required, "hostile stable identity mutation"]]));
    assert.notEqual(changed, baseline, `changing ${required} must change ${specifier} implementation identity`);
  }
});

test("formerly omitted transitive implementation modules invalidate every affected built-in package", () => {
  const required = "runtime/reference/noop-contract";
  const specifiers = ["@cut/audio", "@cut/data", "@cut/diagram", "@cut/documentary", "@cut/edit", "@cut/geo", "@cut/motion", "cut:core", "cut:visual"] as const;
  for (const specifier of specifiers) {
    assert.ok(builtinPackageImplementationFiles(specifier).includes(required), `${required} must be in ${specifier}'s generated transitive closure`);
    const baseline = fingerprintPackageImplementation(specifier);
    const changed = fingerprintPackageImplementation(
      specifier,
      referenceDependencyIdentity,
      new Map([[required, `hostile transitive implementation mutation for ${specifier}`]]),
    );
    assert.notEqual(changed, baseline, `changing ${required} must change ${specifier} implementation identity`);
  }
});

test("compiler package loading does not initialize the native Sharp module", () => {
  const packagesPath = resolve(__dirname, "../lib/language/packages.js");
  const result = spawnSync(process.execPath, ["-e", `
    require(${JSON.stringify(packagesPath)});
    const loaded = Object.keys(require.cache);
    process.stdout.write(JSON.stringify({
      sharp: loaded.some((path) => /node_modules[\\/]sharp[\\/]/.test(path)),
      compositor: loaded.some((path) => /runtime[\\/]reference[\\/]native-source-over\\.js$/.test(path)),
      nativeBinary: loaded.some((path) => /reference-retained-source-over-darwin-arm64\\.node$/.test(path)),
    }));
  `], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { sharp: false, compositor: false, nativeBinary: false });
});

test("native Sharp/libvips and selected compositor identity are collected lazily", async () => {
  const actual = await collectReferenceBackendIdentity();
  assert.equal(actual.version, 2);
  assert.equal(actual.runtime, cutReferenceRuntimeIdentity);
  assert.equal(actual.dependencies.integrity, referenceDependencyIdentity.integrity);
  assert.equal(actual.native.sharp, versionMap().sharp);
  assert.match(actual.native.libvips, /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/);
  assert.equal(actual.compositor.platform, process.platform);
  assert.equal(actual.compositor.architecture, process.arch);
  assert.equal(actual.compositor.mode, process.platform === "darwin" && process.arch === "arm64" ? "native" : "javascript");
  assert.match(actual.compositor.algorithm, /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/);
  if (actual.compositor.mode === "native") assert.match(actual.compositor.binarySha256, /^[a-f0-9]{64}$/);
  else assert.equal(actual.compositor.implementation, "cut-reference-javascript-source-over-v1");
  assert.match(actual.integrity, /^[a-f0-9]{64}$/);
});

test("backend integrity and render cache close over compositor mode and native binary hash", () => {
  const first = createReferenceBackendIdentity(referenceDependencyIdentity, native({ libvips: "8.17.3" }), nativeCompositor());
  const changedNativeHash = createReferenceBackendIdentity(
    referenceDependencyIdentity,
    native({ libvips: "8.17.3" }),
    nativeCompositor({ binarySha256: "2".repeat(64) }),
  );
  const changedMode = createReferenceBackendIdentity(referenceDependencyIdentity, native({ libvips: "8.17.3" }), javascriptCompositor());
  assert.notEqual(first.integrity, changedNativeHash.integrity);
  assert.notEqual(first.integrity, changedMode.integrity);

  const previous = createIncrementalRenderPlan(fixture(), "main", undefined, cutReferenceRuntimeIdentity, first.integrity).manifest;
  for (const changed of [changedNativeHash, changedMode]) {
    const plan = createIncrementalRenderPlan(fixture(), "main", previous, cutReferenceRuntimeIdentity, changed.integrity);
    assert.ok(plan.scenes.every((scene) => scene.status === "miss"));
    assert.equal(plan.manifest.backendIntegrity, changed.integrity);
  }
});
