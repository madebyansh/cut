import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { stableJsonStringify } from "../lib/core/stable";
import { compileCutModule } from "../lib/language/compiler";
import { parseCutLanguage } from "../lib/language/parser";
import { createCutExternalPackageContext } from "../lib/package/context";
import { CutPackageError } from "../lib/package/diagnostics";
import { parseStrictPackageJson } from "../lib/package/json";
import {
  cutPackageContentIntegrity,
  loadCutPackageManifest,
  validateCutPackageManifest,
  type CutPackageDependency,
  type CutPackageExport,
} from "../lib/package/manifest";
import {
  addCutPackageDependency,
  initCutPackage,
  listCutPackageDependencies,
  readCutPackageManifestFile,
  removeCutPackageDependency,
  updateCutPackageDependencies,
} from "../lib/package/project";
import {
  loadCutPackageLock,
  readResolvedCutPackage,
  resolveCutPackageGraph,
  resolveVerifiedCutPackageGraph,
  verifyCutPackageLock,
} from "../lib/package/resolver";
import { cutSemVerSatisfies, parseCutSemVer } from "../lib/package/semver";
import { finalizeGraphHashes } from "../lib/runtime/graph";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const resignLock = <T extends { integrity: string }>(lock: T): T => {
  const body = structuredClone(lock) as Record<string, unknown>; delete body.integrity;
  return { ...body, integrity: `sha256-${digest(stableJsonStringify(body))}` } as T;
};

async function fixturePackage(
  root: string,
  options: {
    name: string;
    version?: string;
    dependencies?: Record<string, CutPackageDependency>;
    source?: string;
    capabilities?: string[];
    exports?: Record<string, CutPackageExport>;
  },
) {
  await mkdir(root, { recursive: true });
  const source = options.source ?? `cut 0.4;\nproject ${JSON.stringify(options.name)};\n`;
  await writeFile(resolve(root, "index.cut"), source);
  const manifest = validateCutPackageManifest({
    format: "cut-package",
    manifestVersion: 1,
    name: options.name,
    version: options.version ?? "1.0.0",
    language: "0.4",
    entry: "index.cut",
    capabilities: options.capabilities ?? [],
    dependencies: options.dependencies ?? {},
    exports: options.exports ?? {},
    integrity: { algorithm: "sha256", files: { "index.cut": digest(source) } },
  });
  await writeFile(resolve(root, "cut.package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, contentIntegrity: cutPackageContentIntegrity(manifest), root };
}

function dependency(source: string, version: string, integrity: string): CutPackageDependency { return { source, version, integrity }; }

function visualSource(name = "ImpactCard") {
  return `cut 0.4;
project "Third-party package";
import { Rect } from "cut:visual";
component ${name}(width: Length, height: Length, fill: Color) -> Visual {
  Rect(width: width, height: height, fill: fill);
}
`;
}

const visualExport = (declaration = "ImpactCard"): Record<string, CutPackageExport> => ({ ImpactCard: { kind: "component", declaration, documentation: "A public visual component assembled from CUT primitives." } });

test("package manifest is closed, versioned, semantic, capability-declared, and duplicate-key safe", () => {
  const source = visualSource(), manifest = validateCutPackageManifest({
    format: "cut-package", manifestVersion: 1, name: "@proof/impact-cards", version: "1.2.3-beta.1+build.9", language: "0.4", entry: "index.cut",
    capabilities: ["visual"], dependencies: {}, exports: visualExport(), integrity: { algorithm: "sha256", files: { "index.cut": digest(source) } },
  });
  assert.equal(manifest.name, "@proof/impact-cards");
  assert.equal(loadCutPackageManifest(`${JSON.stringify(manifest)}\n`).version, "1.2.3-beta.1+build.9");
  assert.throws(() => validateCutPackageManifest({ ...manifest, mystery: true }), (error: unknown) => error instanceof CutPackageError && error.code === "CUT_PACKAGE_UNKNOWN_FIELD");
  assert.throws(() => validateCutPackageManifest({ ...manifest, version: "01.2.3" }), (error: unknown) => error instanceof CutPackageError && error.code === "CUT_PACKAGE_SEMVER");
  assert.throws(() => parseStrictPackageJson('{"format":"cut-package","format":"again"}'), (error: unknown) => error instanceof CutPackageError && error.code === "CUT_PACKAGE_JSON_DUPLICATE_KEY");
  assert.throws(() => validateCutPackageManifest({ ...manifest, capabilities: ["network"] }), (error: unknown) => error instanceof CutPackageError && error.code === "CUT_PACKAGE_CAPABILITY");
  assert.throws(() => validateCutPackageManifest({ ...manifest, entry: "../escape.cut" }), (error: unknown) => error instanceof CutPackageError && error.code === "CUT_PACKAGE_PATH");
  assert.throws(() => validateCutPackageManifest({ ...manifest, dependencies: { "@proof/dep": dependency("file:packages/../dep", "1.0.0", `sha256-${"0".repeat(64)}`) } }), (error: unknown) => error instanceof CutPackageError && error.code === "CUT_PACKAGE_PATH");
});

test("CUT SemVer exact, caret, tilde, zero-major, and prerelease rules are deterministic", () => {
  assert.equal(parseCutSemVer("1.2.3-alpha.1+linux").prerelease[1], 1);
  assert.equal(cutSemVerSatisfies("1.9.0", "^1.2.3"), true);
  assert.equal(cutSemVerSatisfies("2.0.0", "^1.2.3"), false);
  assert.equal(cutSemVerSatisfies("0.2.9", "^0.2.3"), true);
  assert.equal(cutSemVerSatisfies("0.3.0", "^0.2.3"), false);
  assert.equal(cutSemVerSatisfies("1.2.9", "~1.2.3"), true);
  assert.equal(cutSemVerSatisfies("1.3.0", "~1.2.3"), false);
  assert.equal(cutSemVerSatisfies("1.2.3-beta.2", "^1.2.3-beta.1"), true);
  assert.equal(cutSemVerSatisfies("1.2.4-beta.1", "^1.2.3-beta.1"), false);
});

test("resolver creates a path-stable deterministic transitive lock with exact package identities", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-package-graph-"));
  const palette = await fixturePackage(resolve(root, "palette"), { name: "@proof/palette" });
  const cards = await fixturePackage(resolve(root, "cards"), {
    name: "@proof/cards",
    source: visualSource(), capabilities: ["visual"], exports: visualExport(),
    dependencies: { "@proof/palette": dependency("file:../palette", "^1.0.0", palette.contentIntegrity) },
  });
  await fixturePackage(resolve(root, "project"), {
    name: "proof-project",
    dependencies: { "@proof/cards": dependency("file:../cards", "^1.0.0", cards.contentIntegrity) },
  });
  const first = await resolveCutPackageGraph(resolve(root, "project")), second = await resolveCutPackageGraph(resolve(root, "project"));
  assert.equal(stableJsonStringify(first.lock), stableJsonStringify(second.lock));
  assert.deepEqual(first.lock.packages.map((item) => item.name), ["@proof/cards", "@proof/palette"]);
  assert.ok(first.lock.packages.every((item) => !item.source.includes(root)));
  assert.equal(loadCutPackageLock(`${JSON.stringify(first.lock)}\n`).integrity, first.lock.integrity);
  await verifyCutPackageLock(resolve(root, "project"), first.lock);
  const tampered = structuredClone(first.lock); tampered.packages[0].version = "9.9.9";
  assert.throws(() => loadCutPackageLock(`${JSON.stringify(tampered)}\n`), (error: unknown) => error instanceof CutPackageError && error.code === "CUT_PACKAGE_LOCK_TAMPERED");
});

test("lock loader rejects semantic graph damage even when an attacker recomputes the outer digest", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-package-lock-hostile-"));
  const leaf = await fixturePackage(resolve(root, "leaf"), { name: "@proof/leaf" });
  const parent = await fixturePackage(resolve(root, "parent"), { name: "@proof/parent", dependencies: { "@proof/leaf": dependency("file:../leaf", "^1.0.0", leaf.contentIntegrity) } });
  await fixturePackage(resolve(root, "project"), { name: "lock-hostile-project", dependencies: { "@proof/parent": dependency("file:../parent", "^1.0.0", parent.contentIntegrity) } });
  const lock = (await resolveCutPackageGraph(resolve(root, "project"))).lock;

  const dangling = structuredClone(lock); dangling.packages.find((item) => item.name === "@proof/parent")!.dependencies[0].name = "@proof/missing";
  assert.throws(() => loadCutPackageLock(JSON.stringify(resignLock(dangling))), (error: unknown) => error instanceof CutPackageError && error.code === "CUT_PACKAGE_LOCK_REFERENCE");

  const cyclic = structuredClone(lock), leafLock = cyclic.packages.find((item) => item.name === "@proof/leaf")!, parentLock = cyclic.packages.find((item) => item.name === "@proof/parent")!;
  leafLock.dependencies.push({ name: parentLock.name, version: "^1.0.0", integrity: parentLock.contentIntegrity });
  assert.throws(() => loadCutPackageLock(JSON.stringify(resignLock(cyclic))), (error: unknown) => error instanceof CutPackageError && error.code === "CUT_PACKAGE_LOCK_CYCLE");

  const capability = structuredClone(lock); capability.packages[0].capabilities = ["network"] as never;
  assert.throws(() => loadCutPackageLock(JSON.stringify(resignLock(capability))), (error: unknown) => error instanceof CutPackageError && error.code === "CUT_PACKAGE_LOCK_CAPABILITY");

  const invalidProjectVersion = structuredClone(lock); invalidProjectVersion.project.version = "01.0.0";
  assert.throws(() => loadCutPackageLock(JSON.stringify(resignLock(invalidProjectVersion))), (error: unknown) => error instanceof CutPackageError && error.code === "CUT_PACKAGE_LOCK_SEMVER");

  const invalidRange = structuredClone(lock); invalidRange.packages.find((item) => item.name === "@proof/parent")!.dependencies[0].version = "1.x";
  assert.throws(() => loadCutPackageLock(JSON.stringify(resignLock(invalidRange))), (error: unknown) => error instanceof CutPackageError && error.code === "CUT_PACKAGE_LOCK_SEMVER");

  const noncanonicalSource = structuredClone(lock); noncanonicalSource.packages[0].source = "file:packages/../leaf";
  assert.throws(() => loadCutPackageLock(JSON.stringify(resignLock(noncanonicalSource))), (error: unknown) => error instanceof CutPackageError && error.code === "CUT_PACKAGE_LOCK_PATH");

  const incompatibleRange = structuredClone(lock); incompatibleRange.packages.find((item) => item.name === "@proof/parent")!.dependencies[0].version = "2.0.0";
  assert.throws(() => loadCutPackageLock(JSON.stringify(resignLock(incompatibleRange))), (error: unknown) => error instanceof CutPackageError && error.code === "CUT_PACKAGE_LOCK_CONFLICT");

  const wrongPinnedContent = structuredClone(lock); wrongPinnedContent.packages.find((item) => item.name === "@proof/parent")!.dependencies[0].integrity = `sha256-${"f".repeat(64)}`;
  assert.throws(() => loadCutPackageLock(JSON.stringify(resignLock(wrongPinnedContent))), (error: unknown) => error instanceof CutPackageError && error.code === "CUT_PACKAGE_LOCK_CONFLICT");
});

test("resolver rejects tampering, version mismatches, cycles, conflicts, symlinks, and package budgets", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-package-hostile-"));
  const target = await fixturePackage(resolve(root, "target"), { name: "@proof/target", source: visualSource(), capabilities: ["visual"], exports: visualExport() });
  await fixturePackage(resolve(root, "project"), { name: "proof-project", dependencies: { "@proof/target": dependency("file:../target", "^1.0.0", target.contentIntegrity) } });
  const lock = (await resolveCutPackageGraph(resolve(root, "project"))).lock;
  await writeFile(resolve(root, "target", "index.cut"), `${visualSource()}\n// tampered\n`);
  await assert.rejects(verifyCutPackageLock(resolve(root, "project"), lock), (error: unknown) => error instanceof CutPackageError && error.code === "CUT_PACKAGE_TAMPERED");

  const mismatchRoot = resolve(root, "mismatch"), mismatch = await fixturePackage(resolve(root, "mismatch-target"), { name: "@proof/mismatch", version: "2.0.0" });
  await fixturePackage(mismatchRoot, { name: "mismatch-project", dependencies: { "@proof/mismatch": dependency("file:../mismatch-target", "^1.0.0", mismatch.contentIntegrity) } });
  await assert.rejects(resolveCutPackageGraph(mismatchRoot), (error: unknown) => error instanceof CutPackageError && error.code === "CUT_PACKAGE_VERSION_CONFLICT");

  const aPlaceholder = dependency("file:../b", "^1.0.0", `sha256-${"1".repeat(64)}`);
  const b = await fixturePackage(resolve(root, "b"), { name: "@proof/b", dependencies: { "@proof/a": dependency("file:../a", "^1.0.0", `sha256-${"2".repeat(64)}`) } });
  const a = await fixturePackage(resolve(root, "a"), { name: "@proof/a", dependencies: { "@proof/b": { ...aPlaceholder, integrity: b.contentIntegrity } } });
  await fixturePackage(resolve(root, "cycle-project"), { name: "cycle-project", dependencies: { "@proof/a": dependency("file:../a", "^1.0.0", a.contentIntegrity) } });
  await assert.rejects(resolveCutPackageGraph(resolve(root, "cycle-project")), (error: unknown) => error instanceof CutPackageError && error.code === "CUT_PACKAGE_CYCLE");

  const sharedOne = await fixturePackage(resolve(root, "shared-one"), { name: "@proof/shared", version: "1.0.0" });
  const sharedTwo = await fixturePackage(resolve(root, "shared-two"), { name: "@proof/shared", version: "2.0.0" });
  const left = await fixturePackage(resolve(root, "left"), { name: "@proof/left", dependencies: { "@proof/shared": dependency("file:../shared-one", "1.0.0", sharedOne.contentIntegrity) } });
  const right = await fixturePackage(resolve(root, "right"), { name: "@proof/right", dependencies: { "@proof/shared": dependency("file:../shared-two", "2.0.0", sharedTwo.contentIntegrity) } });
  await fixturePackage(resolve(root, "conflict-project"), { name: "conflict-project", dependencies: { "@proof/left": dependency("file:../left", "1.0.0", left.contentIntegrity), "@proof/right": dependency("file:../right", "1.0.0", right.contentIntegrity) } });
  await assert.rejects(resolveCutPackageGraph(resolve(root, "conflict-project")), (error: unknown) => error instanceof CutPackageError && error.code === "CUT_PACKAGE_CONFLICT");

  const linkRoot = resolve(root, "link-project"); await fixturePackage(linkRoot, { name: "link-project", dependencies: { "@proof/link": dependency("file:../package-link", "1.0.0", sharedOne.contentIntegrity) } });
  await symlink(resolve(root, "shared-one"), resolve(root, "package-link"));
  await assert.rejects(resolveCutPackageGraph(linkRoot), (error: unknown) => error instanceof CutPackageError && error.code === "CUT_PACKAGE_SYMLINK");
  await assert.rejects(readResolvedCutPackage(resolve(root, "package-link")), (error: unknown) => error instanceof CutPackageError && error.code === "CUT_PACKAGE_SYMLINK");

  await fixturePackage(resolve(root, "budget-project"), { name: "budget-project", dependencies: { "@proof/left": dependency("file:../left", "1.0.0", left.contentIntegrity), "@proof/right": dependency("file:../right", "1.0.0", right.contentIntegrity) } });
  await assert.rejects(resolveCutPackageGraph(resolve(root, "budget-project"), { limits: { maxPackages: 1 } }), (error: unknown) => error instanceof CutPackageError && error.code === "CUT_PACKAGE_LIMIT");
});

test("init, add, list, update, and remove form a coherent local package workflow", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-package-ops-")), projectRoot = resolve(root, "project"), packageRoot = resolve(root, "impact-cards");
  await fixturePackage(packageRoot, { name: "@proof/impact-cards", source: visualSource(), capabilities: ["visual"], exports: visualExport() });
  const initialized = await initCutPackage(projectRoot, { name: "package-ops-project" });
  assert.equal(initialized.lock.packages.length, 0);
  const added = await addCutPackageDependency(projectRoot, "../impact-cards");
  assert.equal(added.dependency, "@proof/impact-cards");
  assert.equal((await readCutPackageManifestFile(projectRoot)).dependencies["@proof/impact-cards"].source, "file:../impact-cards");
  const listed = await listCutPackageDependencies(projectRoot);
  assert.deepEqual(listed.packages.map((item) => [item.name, item.direct]), [["@proof/impact-cards", true]]);

  const changedSource = `${visualSource()}\n// compatible local update\n`;
  const changedManifest = validateCutPackageManifest({ ...(await readCutPackageManifestFile(packageRoot)), version: "1.1.0", integrity: { algorithm: "sha256", files: { "index.cut": digest(changedSource) } } });
  await writeFile(resolve(packageRoot, "index.cut"), changedSource);
  await writeFile(resolve(packageRoot, "cut.package.json"), `${JSON.stringify(changedManifest, null, 2)}\n`);
  await assert.rejects(resolveCutPackageGraph(projectRoot), (error: unknown) => error instanceof CutPackageError && error.code === "CUT_PACKAGE_INTEGRITY_CONFLICT");
  const updated = await updateCutPackageDependencies(projectRoot, ["@proof/impact-cards"]);
  assert.equal(updated.lock.packages[0].version, "1.1.0");
  assert.equal((await readCutPackageManifestFile(projectRoot)).dependencies["@proof/impact-cards"].version, "^1.1.0");

  const removed = await removeCutPackageDependency(projectRoot, "@proof/impact-cards");
  assert.equal(removed.lock.packages.length, 0);
  assert.equal((await listCutPackageDependencies(projectRoot)).packages.length, 0);
  assert.ok((await readFile(resolve(projectRoot, "cut.package.lock"), "utf8")).endsWith("\n"));
});

test("resolver parses exported third-party component source and refuses manifest/source disagreement", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-package-component-"));
  const valid = await fixturePackage(resolve(root, "valid"), { name: "@proof/impact-cards", source: visualSource(), capabilities: ["visual"], exports: visualExport() });
  const resolved = await readResolvedCutPackage(valid.root);
  assert.equal(resolved.module.declarations.some((item) => item.kind === "component" && item.name === "ImpactCard"), true);
  await fixturePackage(resolve(root, "context-project"), { name: "context-project", dependencies: { "@proof/impact-cards": dependency("file:../valid", "^1.0.0", valid.contentIntegrity) } });
  const context = createCutExternalPackageContext(await resolveCutPackageGraph(resolve(root, "context-project")));
  const symbol = context.packages.get("@proof/impact-cards")!.symbols.ImpactCard;
  assert.deepEqual(symbol.parameters?.map((parameter) => [parameter.name, parameter.type]), [["width", "Length"], ["height", "Length"], ["fill", "Color"]]);
  assert.equal(symbol.returns, "Visual");
  assert.equal(context.implementations.get("@proof/impact-cards\0ImpactCard")!.moduleName, "@proof/impact-cards/index.cut");
  assert.equal(context.packages.get("@proof/impact-cards")!.implementationIntegrity, valid.contentIntegrity.slice("sha256-".length));
  const invalid = await fixturePackage(resolve(root, "invalid"), { name: "@proof/broken", source: visualSource(), capabilities: ["visual"], exports: visualExport("MissingCard") });
  await assert.rejects(readResolvedCutPackage(invalid.root), (error: unknown) => error instanceof CutPackageError && error.code === "CUT_PACKAGE_EXPORT_MISSING");
  const underdeclared = await fixturePackage(resolve(root, "underdeclared"), { name: "@proof/underdeclared", source: visualSource(), capabilities: [], exports: visualExport() });
  await assert.rejects(readResolvedCutPackage(underdeclared.root), (error: unknown) => error instanceof CutPackageError && error.code === "CUT_PACKAGE_CAPABILITY");

  const mediaSource = `cut 0.4;
project "Underdeclared media package";
import { Shader } from "cut:visual";
component WrappedShader(module: String) -> Visual {
  Shader(module: module);
}
`, media = await fixturePackage(resolve(root, "media"), {
    name: "@proof/media", source: mediaSource, capabilities: ["visual"],
    exports: { WrappedShader: { kind: "component", declaration: "WrappedShader", documentation: "Intentionally underdeclared test package." } },
  });
  await fixturePackage(resolve(root, "media-project"), { name: "media-project", dependencies: { "@proof/media": dependency("file:../media", "1.0.0", media.contentIntegrity) } });
  await assert.rejects(async () => createCutExternalPackageContext(await resolveCutPackageGraph(resolve(root, "media-project"))), (error: unknown) => error instanceof CutPackageError && error.code === "CUT_PACKAGE_CAPABILITY_DENIED");

  const assetSource = `cut 0.4;
project "Underdeclared asset consumer";
import { Video } from "cut:visual";
component WrappedVideo(source: VideoAsset) -> Visual {
  Video(source: source);
}
`, assetPackage = await fixturePackage(resolve(root, "asset-consumer"), {
    name: "@proof/asset-consumer", source: assetSource, capabilities: ["visual"],
    exports: { WrappedVideo: { kind: "component", declaration: "WrappedVideo", documentation: "Intentionally missing media-read." } },
  });
  await fixturePackage(resolve(root, "asset-project"), { name: "asset-project", dependencies: { "@proof/asset-consumer": dependency("file:../asset-consumer", "1.0.0", assetPackage.contentIntegrity) } });
  await assert.rejects(
    async () => createCutExternalPackageContext(await resolveCutPackageGraph(resolve(root, "asset-project"))),
    (error: unknown) => error instanceof CutPackageError && error.code === "CUT_PACKAGE_CAPABILITY_DENIED" && /media-read/.test(error.message),
  );
});

test("committed third-party source package verifies, expands, invalidates identity, and renders through public CUT primitives", async () => {
  const projectRoot = resolve("examples/package-proof"), declaredLock = loadCutPackageLock(await readFile(resolve(projectRoot, "cut.package.lock")));
  const graph = await resolveVerifiedCutPackageGraph(projectRoot, declaredLock), context = createCutExternalPackageContext(graph);
  assert.deepEqual(graph.lock.packages.map((item) => `${item.name}@${item.version}`), ["@cut-proof/impact-cards@1.0.0"]);
  assert.equal(graph.packages.get("@cut-proof/impact-cards")!.manifest.integrity.files["index.cut"], "75ca02a5e2ce608ff37f821f918fa73a92ee40e3fd4fadffcaff084f0d085e35");
  assert.equal(context.packages.get("@cut-proof/impact-cards")!.symbols.ImpactCard.native, undefined);
  assert.equal(context.implementations.get("@cut-proof/impact-cards\0ImpactCard")!.declaration.body.length, 3);
  assert.ok(graph.lock.packages.every((item) => !item.source.startsWith("file:/")));

  const parsed = parseCutLanguage(await readFile(resolve(projectRoot, "main.cut"), "utf8"));
  assert.ok(parsed.module);
  const { ir } = compileCutModule(parsed.module!, {}, context);
  assert.deepEqual(ir.modules.map((item) => item.specifier), ["@cut-proof/impact-cards", "cut:core", "cut:visual"]);
  assert.deepEqual(Object.values(ir.nodes).map((item) => item.op).sort(), ["cut.kernel.fragment", "cut.visual.circle", "cut.visual.rect", "cut.visual.rect", "cut.visual.rect"].sort());
  const fragment = Object.values(ir.nodes).find((item) => item.op === "cut.kernel.fragment")!;
  assert.equal(fragment.children.length, 3);
  assert.equal(fragment.provenance.expandedFrom?.[0]?.module, "@cut-proof/impact-cards/index.cut");
  assert.ok(fragment.children.every((id) => ir.nodes[id].provenance.module === "@cut-proof/impact-cards/index.cut"));

  const changedPackageIdentity = structuredClone(ir), changedModule = changedPackageIdentity.modules.find((item) => item.specifier === "@cut-proof/impact-cards")!;
  changedModule.integrity = "0".repeat(64);
  finalizeGraphHashes(changedPackageIdentity);
  assert.notEqual(changedPackageIdentity.nodes[fragment.id].contentHash, fragment.contentHash);
  assert.notEqual(changedPackageIdentity.buildId, ir.buildId);

  const composition = ir.compositions[0], scene = ir.scenes[composition.sceneIds[0]], cacheRoot = await mkdtemp(resolve(tmpdir(), "cut-package-pixels-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, projectRoot, cacheRoot);
  try {
    const surface = await renderer.sceneFrame(scene, 0);
    const pixel = (x: number, y: number) => [...surface.data.subarray((y * surface.width + x) * 4, (y * surface.width + x) * 4 + 4)];
    assert.deepEqual(pixel(10, 10), [24, 34, 43, 255], "consumer-authored dark background");
    assert.deepEqual(pixel(160, 90), [242, 234, 219, 255], "package-authored warm card");
    assert.deepEqual(pixel(26, 90), [239, 111, 77, 255], "package-authored coral rail");
    assert.deepEqual(pixel(256, 90), [239, 111, 77, 255], "package-authored coral circle");
  } finally { renderer.close(); }
});

test("package manifest and lock schemas are shipped machine-readable references", async () => {
  const manifestSchema = JSON.parse(await readFile(resolve("schemas/cut-package-v1.schema.json"), "utf8")) as { $id: string; properties: Record<string, unknown> };
  const lockSchema = JSON.parse(await readFile(resolve("schemas/cut-package-lock-v1.schema.json"), "utf8")) as { $id: string; properties: Record<string, unknown> };
  assert.equal(manifestSchema.$id, "urn:cut:schema:package-manifest:1");
  assert.equal(lockSchema.$id, "urn:cut:schema:package-lock:1");
  assert.deepEqual(Object.keys(manifestSchema.properties).sort(), ["capabilities", "dependencies", "entry", "exports", "format", "integrity", "language", "manifestVersion", "name", "version"]);
  assert.deepEqual(Object.keys(lockSchema.properties).sort(), ["format", "integrity", "language", "packages", "project", "version"]);
});
