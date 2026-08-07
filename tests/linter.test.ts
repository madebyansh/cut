import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { checkCutModule } from "../lib/language/checker";
import { lintCutModule } from "../lib/language/linter";
import { parseCutLanguage } from "../lib/language/parser";

const cli = resolve("dist-cli/cli/cut.js");

function parse(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module);
  assert.deepEqual(parsed.diagnostics, []);
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(checked.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
  return parsed.module;
}

const reachabilityFixture = `cut 0.4;
project "lint reachability";
import { Rect, Circle } from "cut:visual";
const size: Length = 24px;
const deadValue: Number = 7;
asset unusedData: DataAsset = data("media/unused.json");
component Card(side: Length) -> Visual {
  Rect(width: side, height: side, fill: #315c8c);
}
component Dead() -> Visual {
  Circle(radius: 8px, fill: #ff0000);
}
timeline main(duration: 1s, fps: 24, width: 64px, height: 64px) {
  scene only(duration: 1s) { Card(side: size); }
}
timeline unusedTimeline(duration: 1s, fps: 24) {
  scene empty(duration: 1s) {}
}
export out = render(main, width: 64px, height: 64px, codec: "h264");
`;

test("linter follows export reachability through values and components", () => {
  const diagnostics = lintCutModule(parse(reachabilityFixture));
  assert.deepEqual(diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.message]), [
    ["CUTL1001", "Imported symbol “Circle” is not reachable from any exported render target."],
    ["CUTL1002", "const “deadValue” is not reachable from any exported render target."],
    ["CUTL1002", "asset “unusedData” is not reachable from any exported render target."],
    ["CUTL1003", "Component “Dead” is not reachable from any exported render target."],
    ["CUTL1004", "Timeline “unusedTimeline” is not reachable from any exported render target."],
  ]);
  assert.ok(diagnostics.every((diagnostic) => diagnostic.severity === "warning" && diagnostic.span.start.line > 0 && diagnostic.hint));
  assert.ok(!diagnostics.some((diagnostic) => /Rect|size|Card|main/.test(diagnostic.message)), "reachable transitive graph must not be warned");
});

test("lexical shadowing cannot disguise an unused global import", () => {
  const source = `cut 0.4;
project "lint shadow";
import { Circle } from "cut:visual";
component Card(Circle: Length) -> Visual {
  importless(Circle);
}
timeline main(duration: 1s, fps: 24) { scene only(duration: 1s) {} }
export out = render(main);
`;
  // `importless` is intentionally not a legal symbol, so use an ordinary
  // length expression in a valid declaration while retaining the shadow.
  const valid = source.replace("importless(Circle);", "let local: Length = Circle;");
  const diagnostics = lintCutModule(parse(valid));
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "CUTL1001" && diagnostic.message.includes("Circle")));
});

test("nested lexical bindings do not leak into their parent or sibling scopes", () => {
  const source = `cut 0.4;
project "lint nested scopes";
import { Circle } from "cut:visual";
timeline main(duration: 1s, fps: 24, width: 64px, height: 64px) {
  scene only(duration: 1s) {
    at 0s { let Circle: Length = 3px; }
    Circle(radius: 8px, fill: #315c8c);
  }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");
`;
  assert.ok(!lintCutModule(parse(source)).some((diagnostic) => diagnostic.code === "CUTL1001"), "the outer imported Circle remains executable after the nested scope closes");
});

test("module without an export gets a stable module diagnostic", () => {
  const source = `cut 0.4; project "no output"; timeline main(duration: 1s, fps: 24) { scene only(duration: 1s) {} }`;
  assert.deepEqual(lintCutModule(parse(source)).map((diagnostic) => diagnostic.code), ["CUTL1005", "CUTL1004"]);
});

test("cut lint has stable JSON, policy exit codes, and preserves language errors", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "cut-lint-cli-"));
  await Promise.all([
    writeFile(resolve(directory, "warnings.cut"), reachabilityFixture),
    writeFile(resolve(directory, "clean.cut"), `cut 0.4; project "clean"; timeline main(duration: 1s, fps: 24) { scene only(duration: 1s) {} } export out = render(main);`),
    writeFile(resolve(directory, "invalid.cut"), "cut 0.4; project 42;"),
  ]);
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });

  const warnings = run(["lint", "warnings.cut", "--json"]);
  assert.equal(warnings.status, 0, warnings.stderr);
  const first = JSON.parse(warnings.stdout) as { format: string; status: string; summary: { warnings: number }; diagnostics: Array<{ code: string; source: { path: string; line: number } }> };
  assert.deepEqual({ format: first.format, status: first.status, warnings: first.summary.warnings }, { format: "cut-lint-report", status: "warnings", warnings: 5 });
  assert.ok(first.diagnostics.every((diagnostic) => diagnostic.code.startsWith("CUTL") && diagnostic.source.path === "warnings.cut" && diagnostic.source.line > 0));
  assert.equal(run(["lint", "warnings.cut", "--deny-warnings", "--json"]).status, 2);

  const clean = run(["lint", "clean.cut", "--deny-warnings", "--json"]);
  assert.equal(clean.status, 0, clean.stderr);
  assert.deepEqual(JSON.parse(clean.stdout).summary, { errors: 0, total: 0, warnings: 0 });

  const invalid = run(["lint", "invalid.cut", "--json"]);
  assert.equal(invalid.status, 1, invalid.stderr);
  const failed = JSON.parse(invalid.stdout) as { format: string; status: string; diagnostics: Array<{ code: string }> };
  assert.equal(failed.format, "cut-lint-report");
  assert.equal(failed.status, "fail");
  assert.equal(failed.diagnostics[0]?.code, "CUT1002");
});
