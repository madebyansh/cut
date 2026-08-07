import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import { parseCutLanguage } from "../lib/language/parser";
import { loadCutUserModuleGraph } from "../lib/language/user-modules";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { checkCutModule } from "../lib/language/checker";
import { applyCutLock, createCutLock, loadCutLock } from "../lib/language/lock";
import { loadCutAvIr } from "../lib/language/ir-loader";

const exec = promisify(execFile);

const entrySource = `cut 0.4;
project "User modules";
import { Card, palette, spacing, twice } from "./lib/theme.cut";

timeline main(duration: 1s, fps: 24, width: 320px, height: 180px) {
  scene proof(duration: 1s) {
    Card(size: twice(spacing), color: palette[0]);
  }
}

export final = render(main);
`;

const moduleSource = `cut 0.4;
import { Rect } from "cut:visual";

const base: Length = 20px;
function twice(value: Length) -> Length = value * 2;
component Card(size: Length, color: Color) -> Visual {
  Rect(width: size, height: size, fill: color);
}

export spacing = twice(base);
export twice = twice;
export palette = [#ff2200, #0044ff];
export Card = Card;
`;

async function project(entry = entrySource, module = moduleSource) {
  const root = await mkdtemp(resolve(tmpdir(), "cut-user-modules-"));
  await mkdir(resolve(root, "lib"));
  await writeFile(resolve(root, "main.cut"), entry);
  await writeFile(resolve(root, "lib/theme.cut"), module);
  const parsed = parseCutLanguage(entry);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const loaded = await loadCutUserModuleGraph(resolve(root, "main.cut"), parsed.module);
  return { root, module: parsed.module, loaded };
}

test("project-relative value, function, collection, and component exports lower into typed IR", async () => {
  const fixture = await project();
  assert.deepEqual(fixture.loaded.diagnostics, []);
  assert.ok(fixture.loaded.graph);
  const { ir } = compileCutModule(fixture.module, {}, undefined, fixture.loaded.graph);
  assert.deepEqual(ir.sourceModules?.map(({ specifier, bytes }) => ({ specifier, bytes })), [{ specifier: "./lib/theme.cut", bytes: Buffer.byteLength(moduleSource) }]);
  const card = Object.values(ir.nodes).find((node) => node.op === "cut.kernel.fragment");
  assert.ok(card);
  assert.equal(card.provenance.expandedFrom?.[0].module, "./lib/theme.cut");
  const rect = Object.values(ir.nodes).find((node) => node.op === "cut.visual.rect");
  assert.ok(rect);
  assert.deepEqual(rect.inputs.width, { kind: "quantity", dimension: "length", magnitude: { numerator: "80", denominator: "1" }, unit: "px" });
  assert.deepEqual(rect.inputs.fill, { kind: "color", value: "#ff2200" });
});

test("a project module can export a structurally transparent DiagramNode component", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-user-diagram-node-"));
  await mkdir(resolve(root, "lib"));
  const reusable = `cut 0.4;
import { DiagramNode } from "@cut/diagram";
import { Rect } from "cut:visual";
component FactNode(id: String, rank: Number, color: Color) -> DiagramNode {
  DiagramNode(id: id, width: 88px, height: 44px, rank: rank) {
    Rect(width: 88px, height: 44px, fill: color);
  }
}
export FactNode = FactNode;
`;
  const entry = `cut 0.4;
project "module diagram nodes";
import { DiagramLayout, diagramEdge, diagramState } from "@cut/diagram";
import { FactNode } from "./lib/diagram.cut";
const state: DiagramState = diagramState(
  id: "facts",
  nodes: ["cause", "effect"],
  edges: [diagramEdge(id: "cause-effect", from: "cause", to: "effect", stroke: #111111, width: 2px)]
);
timeline main(duration: 1s, fps: 24, width: 320px, height: 180px) {
  scene only(duration: 1s) {
    DiagramLayout(state: state, width: 280px, height: 140px) {
      FactNode(id: "cause", rank: 0, color: #f4d35e);
      FactNode(id: "effect", rank: 1, color: #25a18e);
    }
  }
}
export final = render(main);
`;
  await writeFile(resolve(root, "main.cut"), entry);
  await writeFile(resolve(root, "lib/diagram.cut"), reusable);
  const parsed = parseCutLanguage(entry);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const loaded = await loadCutUserModuleGraph(resolve(root, "main.cut"), parsed.module);
  assert.deepEqual(loaded.diagnostics, []);
  assert.ok(loaded.graph);
  const ir = compileCutModule(parsed.module, {}, undefined, loaded.graph).ir;
  const layout = Object.values(ir.nodes).find((node) => node.op === "cut.diagram.layout");
  assert.ok(layout);
  assert.deepEqual(layout.children.map((id) => ir.nodes[id]?.op), ["cut.diagram.node", "cut.diagram.node"]);
  assert.equal(Object.values(ir.nodes).filter((node) => node.op === "cut.kernel.fragment").length, 0);
  assert.ok(layout.children.every((id) => ir.nodes[id]?.provenance.expandedFrom?.some((entry_) => entry_.module === "./lib/diagram.cut")));
});

test("module comments/formatting change exact module evidence but not semantic identity or diff", async () => {
  const first = await project();
  const second = await project(entrySource, `// source evidence only\n${moduleSource.replace("const base: Length = 20px;", "const   base:Length=20px;")}`);
  assert.ok(first.loaded.graph && second.loaded.graph);
  const before = compileCutModule(first.module, {}, undefined, first.loaded.graph).ir;
  const after = compileCutModule(second.module, {}, undefined, second.loaded.graph).ir;
  assert.equal(before.buildId, after.buildId);
  assert.notEqual(before.sourceModules?.[0].sha256, after.sourceModules?.[0].sha256);
  assert.deepEqual(diffCutAVIR(before, after).changes, []);

  const semantic = await project(entrySource, moduleSource.replace("20px", "24px"));
  assert.ok(semantic.loaded.graph);
  assert.notEqual(before.buildId, compileCutModule(semantic.module, {}, undefined, semantic.loaded.graph).ir.buildId);
});

test("loader fails closed for escapes, symlinks, cycles, duplicates, private and missing symbols", async (context) => {
  await context.test("dot-dot escape", async () => {
    const fixture = await project(entrySource.replace("./lib/theme.cut", "../theme.cut"));
    assert.equal(fixture.loaded.diagnostics[0]?.code, "CUT_MODULE_ESCAPE");
    assert.equal(fixture.loaded.diagnostics[0]?.module, "project.cut");
  });
  await context.test("symlink", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "cut-user-module-link-"));
    await mkdir(resolve(root, "lib"));
    await writeFile(resolve(root, "actual.cut"), moduleSource);
    await symlink(resolve(root, "actual.cut"), resolve(root, "lib/theme.cut"));
    await writeFile(resolve(root, "main.cut"), entrySource);
    const parsed = parseCutLanguage(entrySource); assert.ok(parsed.module);
    const loaded = await loadCutUserModuleGraph(resolve(root, "main.cut"), parsed.module);
    assert.equal(loaded.diagnostics[0]?.code, "CUT_MODULE_SYMLINK");
  });
  await context.test("cycle", async () => {
    const fixture = await project(entrySource, `cut 0.4;\nimport { value } from "./lib/other.cut";\nexport theme = value;\n`);
    await writeFile(resolve(fixture.root, "lib/other.cut"), `cut 0.4;\nimport { theme } from "./lib/theme.cut";\nexport value = theme;\n`);
    const loaded = await loadCutUserModuleGraph(resolve(fixture.root, "main.cut"), fixture.module);
    assert.ok(loaded.diagnostics.some((item) => item.code === "CUT_MODULE_CYCLE"));
  });
  await context.test("duplicate import", async () => {
    const duplicated = entrySource.replace(
      'import { Card, palette, spacing, twice } from "./lib/theme.cut";',
      'import { Card, palette } from "./lib/theme.cut";\nimport { spacing, twice } from "./lib/theme.cut";',
    );
    const fixture = await project(duplicated);
    assert.ok(fixture.loaded.diagnostics.some((item) => item.code === "CUT_MODULE_DUPLICATE_IMPORT"));
  });
  await context.test("private and missing symbols", async () => {
    const privateEntry = entrySource.replace("Card, palette, spacing, twice", "Card, palette, spacing, twice, base, absent");
    const fixture = await project(privateEntry);
    assert.ok(fixture.loaded.graph);
    const checked = checkCutModule(fixture.module, { userModules: fixture.loaded.graph.contracts });
    assert.ok(checked.diagnostics.some((item) => item.code === "CUT_MODULE_PRIVATE_SYMBOL"));
    assert.ok(checked.diagnostics.some((item) => item.code === "CUT_MODULE_MISSING_SYMBOL"));
  });
});

test("pure functions reject type errors, recursion, effects, and bounded expansion", async (context) => {
  await context.test("return type and recursion", async () => {
    const fixture = await project(entrySource, moduleSource
      .replace("function twice(value: Length) -> Length = value * 2;", "function twice(value: Length) -> Length = twice(value);"));
    assert.ok(fixture.loaded.diagnostics.some((item) => item.code === "CUT_MODULE_FUNCTION_CYCLE"));
  });
  await context.test("node/effect call", async () => {
    const fixture = await project(entrySource, moduleSource
      .replace("function twice(value: Length) -> Length = value * 2;", "function twice(value: Length) -> Visual = Rect(width: value, height: value, fill: #ffffff);"));
    assert.ok(fixture.loaded.diagnostics.some((item) => item.code === "CUT_MODULE_FUNCTION_TYPE"));
    assert.ok(fixture.loaded.diagnostics.some((item) => item.code === "CUT_MODULE_FUNCTION_EFFECT"));
  });
  await context.test("call budget has stable located diagnostic", async () => {
    const fixture = await project(); assert.ok(fixture.loaded.graph);
    assert.throws(
      () => compileCutModule(fixture.module, { maxFunctionCalls: 1 }, undefined, fixture.loaded.graph),
      (error) => error instanceof CutCompileError && error.result.diagnostics.some((item) => item.code === "CUT_MODULE_FUNCTION_LIMIT" && item.span.start.line > 0),
    );
  });
});

test("single-file compilation remains free of user-module fields", async () => {
  const source = `cut 0.4;\nproject "Legacy";\ntimeline main(duration: 1s, fps: 24) {}\nexport final = render(main);\n`;
  const parsed = parseCutLanguage(source); assert.ok(parsed.module);
  const ir = compileCutModule(parsed.module).ir;
  assert.equal(Object.hasOwn(ir, "sourceModules"), false);
  assert.equal(JSON.stringify(ir).includes("sourceModules"), false);
});

test("CutAVIR and cut.lock validate and independently pin exact user-module bytes", async () => {
  const fixture = await project(); assert.ok(fixture.loaded.graph);
  const ir = compileCutModule(fixture.module, {}, undefined, fixture.loaded.graph).ir;
  const loadedIr = loadCutAvIr(JSON.stringify(ir));
  assert.deepEqual(loadedIr.sourceModules, ir.sourceModules);
  const lock = await createCutLock(ir, fixture.root);
  assert.deepEqual(lock.sourceModules, ir.sourceModules);
  await applyCutLock(compileCutModule(fixture.module, {}, undefined, fixture.loaded.graph).ir, loadCutLock(JSON.stringify(lock)), fixture.root);
  await writeFile(resolve(fixture.root, "lib/theme.cut"), `${moduleSource}\n// exact byte change\n`);
  await assert.rejects(
    applyCutLock(compileCutModule(fixture.module, {}, undefined, fixture.loaded.graph).ir, lock, fixture.root),
    /CUT_LOCK_SOURCE_MISMATCH/,
  );
});

test("installed-style CLI check/build/inspect carries module context and located JSON failures", async () => {
  const fixture = await project();
  const cli = resolve("dist-cli/cli/cut.js"), entry = resolve(fixture.root, "main.cut"), artifact = resolve(fixture.root, "graph.cutir.json");
  const checked = JSON.parse((await exec(process.execPath, [cli, "check", entry, "--json"], { cwd: process.cwd() })).stdout);
  assert.equal(checked.status, "pass");
  const built = JSON.parse((await exec(process.execPath, [cli, "build", entry, "--out", artifact, "--json"], { cwd: process.cwd() })).stdout);
  assert.equal(built.summary.sourceModules, 1);
  const inspected = JSON.parse((await exec(process.execPath, [cli, "inspect", entry, "--json"], { cwd: process.cwd() })).stdout);
  assert.equal(inspected.summary.sourceModules, 1);
  assert.equal(inspected.sourceModules[0].specifier, "./lib/theme.cut");

  await writeFile(entry, entrySource.replace("Card, palette, spacing, twice", "Card, palette, spacing, twice, privateBase"));
  await assert.rejects(exec(process.execPath, [cli, "check", entry, "--json"], { cwd: process.cwd() }), (error: unknown) => {
    const stdout = (error as { stdout?: string }).stdout ?? "", report = JSON.parse(stdout);
    const diagnostic = report.diagnostics.find((item: { code: string }) => item.code === "CUT_MODULE_MISSING_SYMBOL");
    return diagnostic?.source.path === entry || diagnostic?.source.path === "project.cut";
  });
});
