import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  BuiltinImplementationClosureError,
  checkBuiltinImplementationClosure,
  generateBuiltinImplementationClosure,
} from "./generate-builtin-implementation-closure.mjs";

const workspace = resolve(import.meta.dirname, "..");
const requireFromTest = createRequire(import.meta.url);

function failure(code) {
  return (error) => error instanceof BuiltinImplementationClosureError && error.code === code;
}

async function fixture(source, options = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "cut-implementation-closure-"));
  await mkdir(resolve(root, "lib/language"), { recursive: true });
  await writeFile(resolve(root, "lib/language/builtin-implementation-closure.json"), "{}\n");
  const roots = {
    format: "cut-builtin-implementation-roots",
    version: 1,
    externals: ["sharp"],
    shared: ["language/builtin-implementation-closure.json", "language/entry"],
    packages: { "@proof/package": options.packageRoots ?? [] },
  };
  await writeFile(resolve(root, "lib/language/builtin-implementation-roots.json"), `${JSON.stringify(roots, null, 2)}\n`);
  await writeFile(resolve(root, "lib/language/entry.ts"), source);
  for (const [path, bytes] of Object.entries(options.files ?? {})) {
    const destination = resolve(root, "lib", path);
    await mkdir(resolve(destination, ".."), { recursive: true });
    await writeFile(destination, bytes);
  }
  return root;
}

test("committed built-in implementation closure is current and closes known formerly omitted execution modules", () => {
  const result = checkBuiltinImplementationClosure({ workspaceRoot: workspace });
  for (const specifier of ["@cut/audio", "@cut/edit"]) {
    const modules = result.manifest.packages[specifier];
    for (const expected of [
      "core/stable",
      "package/context",
      "runtime/reference/delivery",
      "runtime/reference/noop-contract",
    ]) assert.ok(modules.includes(expected), `${specifier} is missing ${expected}`);
  }
  assert.ok(result.modules > 60);
  assert.ok(result.bytes > 100_000);
});

test("TypeScript traversal is deterministic across cycles, value re-exports, side effects, literal lazy loads, and type-only exclusions", async () => {
  const root = await fixture(`
    import type { OnlyType } from "./types";
    import { type MixedType, value } from "./branch";
    import "./side-effect";
    export { cycle } from "./cycle";
    export type { Hidden } from "./hidden";
    const decoy = 'require("./ghost")';
    // import "./comment-ghost";
    export async function lazy() { return import("./lazy"); }
    require.resolve("./resolved");
    void value; void decoy;
  `, { files: {
    "language/branch.ts": "export const value = 1; export type MixedType = number;\n",
    "language/cycle.ts": "import { value } from './branch'; import './entry'; export const cycle = value;\n",
    "language/side-effect.ts": "export const sideEffect = true;\n",
    "language/lazy.ts": "export const lazy = true;\n",
    "language/resolved.ts": "export const resolved = true;\n",
  } });
  try {
    const first = generateBuiltinImplementationClosure({ workspaceRoot: root });
    const second = generateBuiltinImplementationClosure({ workspaceRoot: root });
    assert.equal(first.text, second.text);
    assert.deepEqual(first.manifest.packages["@proof/package"], [
      "language/branch",
      "language/builtin-implementation-closure.json",
      "language/cycle",
      "language/entry",
      "language/lazy",
      "language/resolved",
      "language/side-effect",
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("tracked external modules do not enter or initialize the local closure", async () => {
  const root = await fixture('export async function backend() { return import("sharp"); }\n');
  try {
    const result = generateBuiltinImplementationClosure({ workspaceRoot: root });
    assert.deepEqual(result.manifest.packages["@proof/package"], [
      "language/builtin-implementation-closure.json",
      "language/entry",
    ]);
    assert.equal(Object.keys(requireFromTest.cache).some((path) => /node_modules[\\/]sharp[\\/]/u.test(path)), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing, ambiguous, escaping, computed, and untracked imports fail closed", async (context) => {
  const cases = [
    ["missing", 'import "./missing";\n', {}, "CUT_IMPLEMENTATION_IMPORT_MISSING"],
    ["computed", "const name = './local'; void import(name);\n", {}, "CUT_IMPLEMENTATION_DYNAMIC_IMPORT"],
    ["untracked external", 'import thing from "untracked-package"; void thing;\n', {}, "CUT_IMPLEMENTATION_EXTERNAL"],
    ["ambiguous", 'import "./both";\n', {
      "language/both.ts": "export const file = true;\n",
      "language/both/index.ts": "export const directory = true;\n",
    }, "CUT_IMPLEMENTATION_IMPORT_AMBIGUOUS"],
  ];
  for (const [name, source, files, code] of cases) await context.test(name, async () => {
    const root = await fixture(source, { files });
    try { assert.throws(() => generateBuiltinImplementationClosure({ workspaceRoot: root }), failure(code)); }
    finally { await rm(root, { recursive: true, force: true }); }
  });

  await context.test("lexical escape", async () => {
    const root = await fixture('import "../../../outside";\n');
    try { assert.throws(() => generateBuiltinImplementationClosure({ workspaceRoot: root }), failure("CUT_IMPLEMENTATION_PATH_ESCAPE")); }
    finally { await rm(root, { recursive: true, force: true }); }
  });

  await context.test("symbolic escape", async () => {
    const root = await fixture('import "./linked";\n'), outside = resolve(root, "outside.ts");
    await writeFile(outside, "export const escaped = true;\n");
    await symlink(outside, resolve(root, "lib/language/linked.ts"));
    try { assert.throws(() => generateBuiltinImplementationClosure({ workspaceRoot: root }), failure("CUT_IMPLEMENTATION_PATH_ESCAPE")); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
});

test("source overrides participate in discovery and unused override keys are refused", async () => {
  const root = await fixture("export const original = true;\n", { files: { "language/added.ts": "export const added = true;\n" } });
  try {
    const changed = generateBuiltinImplementationClosure({
      workspaceRoot: root,
      sourceOverrides: new Map([["language/entry", 'export { added } from "./added";\n']]),
    });
    assert.ok(changed.manifest.packages["@proof/package"].includes("language/added"));
    assert.throws(
      () => generateBuiltinImplementationClosure({ workspaceRoot: root, sourceOverrides: new Map([["language/not-reachable", "x"]]) }),
      failure("CUT_IMPLEMENTATION_OVERRIDE_UNUSED"),
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("createRequire cannot hide local execution and the sole dependency-identity exception stays closed", async () => {
  const root = await fixture(`
    import { createRequire } from "node:module";
    const hidden = createRequire(import.meta.url);
    hidden("./local");
  `, { files: { "language/local.ts": "export const local = true;\n" } });
  try {
    assert.throws(() => generateBuiltinImplementationClosure({ workspaceRoot: root }), failure("CUT_IMPLEMENTATION_CREATE_REQUIRE"));
  } finally { await rm(root, { recursive: true, force: true }); }

  const dependencyIdentity = await readFile(resolve(workspace, "lib/language/dependency-identity.ts"), "utf8");
  assert.throws(
    () => generateBuiltinImplementationClosure({
      workspaceRoot: workspace,
      sourceOverrides: new Map([["language/dependency-identity", `${dependencyIdentity}\nrequireFromHere("./hidden");\n`]]),
    }),
    failure("CUT_IMPLEMENTATION_CREATE_REQUIRE"),
  );
});

test("check mode refuses stale generated bytes", async () => {
  const root = await fixture("export const value = true;\n");
  try {
    assert.throws(() => checkBuiltinImplementationClosure({ workspaceRoot: root }), failure("CUT_IMPLEMENTATION_CLOSURE_STALE"));
    assert.notEqual((await readFile(resolve(root, "lib/language/builtin-implementation-closure.json"), "utf8")).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
