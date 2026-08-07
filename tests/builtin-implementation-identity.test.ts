import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  createCutBuiltinImplementationIdentity,
  CutBuiltinImplementationIdentityError,
  readCutBuiltinImplementationClosure,
} from "../lib/language/builtin-implementation-identity";

const packageNames = ["@cut/audio", "@cut/data", "@cut/diagram", "@cut/documentary", "@cut/edit", "@cut/geo", "@cut/motion", "cut:core", "cut:visual"] as const;

function error(code: string) {
  return (value: unknown) => value instanceof CutBuiltinImplementationIdentityError && value.code === code;
}

function closure(modules: readonly string[]) {
  return {
    format: "cut-builtin-implementation-closure",
    version: 1,
    packages: Object.fromEntries(packageNames.map((name) => [name, modules])),
  };
}

async function implementationTree(extension: ".ts" | ".js", modules = ["core/stable", "language/leaf", "language/payload.json"]) {
  const root = await mkdtemp(resolve(tmpdir(), "cut-builtin-identity-")), libRoot = resolve(root, "lib"), language = resolve(libRoot, "language");
  await mkdir(resolve(libRoot, "core"), { recursive: true }); await mkdir(language, { recursive: true });
  await writeFile(resolve(language, "builtin-implementation-closure.json"), `${JSON.stringify(closure(modules), null, 2)}\n`);
  for (const id of modules) {
    const path = resolve(libRoot, id.endsWith(".json") ? id : `${id}${extension}`);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, id.endsWith(".json") ? '{"fixture":true}\n' : `export const fixture = ${JSON.stringify(id)};\n`);
  }
  return { root, libRoot, closurePath: resolve(language, "builtin-implementation-closure.json") };
}

test("committed closure is strict and every built-in identity is deterministic, path-independent, and mutation-sensitive", () => {
  const manifest = readCutBuiltinImplementationClosure();
  assert.deepEqual(Object.keys(manifest.packages), [...packageNames]);
  for (const name of packageNames) {
    const first = createCutBuiltinImplementationIdentity(name), second = createCutBuiltinImplementationIdentity(name);
    assert.equal(first.integrity, second.integrity);
    assert.match(first.integrity, /^[a-f0-9]{64}$/u);
    assert.ok(first.files.some((file) => file.id === "language/builtin-implementation-identity"));
    const target = first.files.find((file) => file.id === "runtime/reference/noop-contract") ?? first.files[0];
    const changed = createCutBuiltinImplementationIdentity(name, { sourceOverrides: new Map([[target.id, "mutation"]]) });
    assert.notEqual(changed.integrity, first.integrity);
  }
});

test("source and packed module selection is exact while identical packed trees ignore absolute install paths", async () => {
  const source = await implementationTree(".ts"), packedA = await implementationTree(".js"), packedB = await implementationTree(".js");
  try {
    const sourceIdentity = createCutBuiltinImplementationIdentity("@cut/audio", { libRoot: source.libRoot, closurePath: source.closurePath, implementationExtension: ".ts" });
    const packedIdentityA = createCutBuiltinImplementationIdentity("@cut/audio", { libRoot: packedA.libRoot, closurePath: packedA.closurePath, implementationExtension: ".js" });
    const packedIdentityB = createCutBuiltinImplementationIdentity("@cut/audio", { libRoot: packedB.libRoot, closurePath: packedB.closurePath, implementationExtension: ".js" });
    assert.notEqual(sourceIdentity.integrity, packedIdentityA.integrity);
    assert.equal(packedIdentityA.integrity, packedIdentityB.integrity);
    assert.ok(packedIdentityA.files.every((file) => !JSON.stringify(file).includes(packedA.root)));
    await rm(resolve(packedA.libRoot, "language/leaf.js"));
    assert.throws(
      () => createCutBuiltinImplementationIdentity("@cut/audio", { libRoot: packedA.libRoot, closurePath: packedA.closurePath, implementationExtension: ".js" }),
      error("CUT_IMPLEMENTATION_FILE_MISSING"),
    );
  } finally {
    await Promise.all([source, packedA, packedB].map((item) => rm(item.root, { recursive: true, force: true })));
  }
});

test("closure and file boundaries reject unknown overrides, unsorted IDs, links, and oversized bytes", async () => {
  const tree = await implementationTree(".js");
  try {
    assert.throws(
      () => createCutBuiltinImplementationIdentity("@cut/audio", { libRoot: tree.libRoot, closurePath: tree.closurePath, implementationExtension: ".js", sourceOverrides: new Map([["language/unknown", "x"]]) }),
      error("CUT_IMPLEMENTATION_OVERRIDE_UNKNOWN"),
    );
    const unsorted = closure(["language/leaf", "core/stable"]);
    await writeFile(tree.closurePath, `${JSON.stringify(unsorted)}\n`);
    assert.throws(() => readCutBuiltinImplementationClosure({ libRoot: tree.libRoot, closurePath: tree.closurePath }), error("CUT_IMPLEMENTATION_CLOSURE_SHAPE"));
    await writeFile(tree.closurePath, `${JSON.stringify(closure(["core/stable", "language/leaf", "language/payload.json"]))}\n`);
    await rm(resolve(tree.libRoot, "language/leaf.js"));
    await symlink(resolve(tree.libRoot, "core/stable.js"), resolve(tree.libRoot, "language/leaf.js"));
    assert.throws(
      () => createCutBuiltinImplementationIdentity("@cut/audio", { libRoot: tree.libRoot, closurePath: tree.closurePath, implementationExtension: ".js" }),
      error("CUT_IMPLEMENTATION_PATH_ESCAPE"),
    );
    await rm(resolve(tree.libRoot, "language/leaf.js"));
    await writeFile(resolve(tree.libRoot, "language/leaf.js"), Buffer.alloc(8 * 1024 * 1024 + 1));
    assert.throws(
      () => createCutBuiltinImplementationIdentity("@cut/audio", { libRoot: tree.libRoot, closurePath: tree.closurePath, implementationExtension: ".js" }),
      error("CUT_IMPLEMENTATION_FILE_BOUNDS"),
    );
  } finally { await rm(tree.root, { recursive: true, force: true }); }
});

test("closure JSON decoding is fatal rather than replacement-character tolerant", async () => {
  const tree = await implementationTree(".js");
  try {
    await writeFile(tree.closurePath, Buffer.from([0x7b, 0x22, 0x80, 0x22, 0x3a, 0x31, 0x7d]));
    assert.throws(
      () => readCutBuiltinImplementationClosure({ libRoot: tree.libRoot, closurePath: tree.closurePath }),
      error("CUT_IMPLEMENTATION_CLOSURE_JSON"),
    );
  } finally { await rm(tree.root, { recursive: true, force: true }); }
});

test("closure members are hashed as bytes and never imported", async () => {
  const tree = await implementationTree(".js"), marker = resolve(tree.root, "must-not-exist");
  try {
    await writeFile(resolve(tree.libRoot, "language/leaf.js"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");\n`);
    const before = Object.keys(require.cache);
    const identity = createCutBuiltinImplementationIdentity("@cut/edit", { libRoot: tree.libRoot, closurePath: tree.closurePath, implementationExtension: ".js" });
    assert.match(identity.integrity, /^[a-f0-9]{64}$/u);
    await assert.rejects(() => readFile(marker), (value: unknown) => (value as NodeJS.ErrnoException).code === "ENOENT");
    assert.deepEqual(Object.keys(require.cache), before);
  } finally { await rm(tree.root, { recursive: true, force: true }); }
});
