import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  BuiltinImplementationClosureError,
  generateBuiltinImplementationClosure,
} from "./generate-builtin-implementation-closure.mjs";

const workspace = resolve(import.meta.dirname, "..");
const dependencyIdentityPath = resolve(workspace, "lib/language/dependency-identity.ts");
const complexRuntimePath = resolve(workspace, "lib/runtime/reference/complex-text-shaping.ts");

function failure(code) {
  return (error) =>
    error instanceof BuiltinImplementationClosureError
    && error.code === code;
}

async function sources() {
  return {
    dependencyIdentity: await readFile(dependencyIdentityPath, "utf8"),
    complexRuntime: await readFile(complexRuntimePath, "utf8"),
  };
}

test("the implementation closure admits the exact disjoint base and complex-text literal dependency sets", async () => {
  const { dependencyIdentity } = await sources();
  assert.match(
    dependencyIdentity,
    /export const referenceDependencyNames = \[\s*"d3-geo",\s*"opentype\.js",\s*"sharp",\s*"topojson-client",\s*"world-atlas",\s*\] as const;/u,
  );
  assert.match(
    dependencyIdentity,
    /export const referenceComplexTextDependencyNames = \[\s*"bidi-js",\s*"harfbuzzjs",\s*\] as const;/u,
  );
  assert.doesNotThrow(() => generateBuiltinImplementationClosure({
    workspaceRoot: workspace,
    sourceOverrides: new Map([["language/dependency-identity", dependencyIdentity]]),
  }));
});

test("computed, duplicated, or incomplete complex-text dependency declarations fail closed", async (context) => {
  const { dependencyIdentity } = await sources();
  const literal = `export const referenceComplexTextDependencyNames = [
  "bidi-js",
  "harfbuzzjs",
] as const;`;
  assert.ok(dependencyIdentity.includes(literal));
  const cases = Object.freeze([
    Object.freeze({
      name: "computed",
      replacement: 'export const referenceComplexTextDependencyNames = [...["bidi-js", "harfbuzzjs"]] as const;',
    }),
    Object.freeze({
      name: "duplicate base dependency",
      replacement: 'export const referenceComplexTextDependencyNames = ["bidi-js", "harfbuzzjs", "sharp"] as const;',
    }),
    Object.freeze({
      name: "missing executable",
      replacement: 'export const referenceComplexTextDependencyNames = ["harfbuzzjs"] as const;',
    }),
  ]);
  for (const row of cases) await context.test(row.name, () => {
    const override = dependencyIdentity.replace(literal, row.replacement);
    assert.notEqual(override, dependencyIdentity);
    assert.throws(
      () => generateBuiltinImplementationClosure({
        workspaceRoot: workspace,
        sourceOverrides: new Map([["language/dependency-identity", override]]),
      }),
      failure("CUT_IMPLEMENTATION_CREATE_REQUIRE"),
    );
  });
});

test("the sole createRequire construction keeps its exact bounded authority and unrelated closure modules cannot create a loader", async () => {
  const { dependencyIdentity, complexRuntime } = await sources();
  const boundedConstruction = "const requireFromHere = createRequire(__filename);";
  assert.ok(dependencyIdentity.includes(boundedConstruction));
  const computedConstruction = dependencyIdentity.replace(
    boundedConstruction,
    "const requireFromHere = createRequire(import.meta.url);",
  );
  assert.throws(
    () => generateBuiltinImplementationClosure({
      workspaceRoot: workspace,
      sourceOverrides: new Map([["language/dependency-identity", computedConstruction]]),
    }),
    failure("CUT_IMPLEMENTATION_CREATE_REQUIRE"),
  );

  const unrelatedLoader = `import { createRequire as untrackedCreateRequire } from "node:module";
const untrackedResolver = untrackedCreateRequire(__filename);
void untrackedResolver;
${complexRuntime}`;
  assert.throws(
    () => generateBuiltinImplementationClosure({
      workspaceRoot: workspace,
      sourceOverrides: new Map([["runtime/reference/complex-text-shaping", unrelatedLoader]]),
    }),
    failure("CUT_IMPLEMENTATION_CREATE_REQUIRE"),
  );
});
