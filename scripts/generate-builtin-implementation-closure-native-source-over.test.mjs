import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { generateBuiltinImplementationClosure } from "./generate-builtin-implementation-closure.mjs";

const root = resolve(import.meta.dirname, "..");
const moduleId = "runtime/reference/native-source-over";
const source = readFileSync(resolve(root, "lib/runtime/reference/native-source-over.ts"), "utf8");
const failure = code => error => error?.code === code;

test("the exact native source-over module owns one admitted authenticated loader", () => {
  assert.doesNotThrow(() => generateBuiltinImplementationClosure({ workspaceRoot: root }));
});

test("native loader authority rejects computed, duplicate, and renamed loader surfaces", () => {
  for (const mutation of [
    source.replace("require(locator)", "require(`${locator}`)"),
    source.replace("require(locator) as Partial<NativeModule>", "require(locator) as Partial<NativeModule>; const extra = require(locator)"),
    source.replace("const candidate = require(locator)", "const loadedCandidate = require(locator)"),
  ]) {
    assert.throws(
      () => generateBuiltinImplementationClosure({ workspaceRoot: root, sourceOverrides: new Map([[moduleId, mutation]]) }),
      failure("CUT_IMPLEMENTATION_DYNAMIC_IMPORT"),
    );
  }
});

test("unrelated implementation modules still cannot gain computed native loaders", () => {
  const visual = readFileSync(resolve(root, "lib/runtime/reference/visual.ts"), "utf8");
  assert.throws(
    () => generateBuiltinImplementationClosure({
      workspaceRoot: root,
      sourceOverrides: new Map([["runtime/reference/visual", `${visual}\nconst locator = __filename; const candidate = require(locator);\n`]]),
    }),
    failure("CUT_IMPLEMENTATION_DYNAMIC_IMPORT"),
  );
});
