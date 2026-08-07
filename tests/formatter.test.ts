import test from "node:test";
import assert from "node:assert/strict";
import { compileCutModule } from "../lib/language/compiler";
import { CutFormatError, formatCutSource } from "../lib/language/formatter";
import { parseCutLanguage } from "../lib/language/parser";
import type { CutAVIR } from "../lib/language/ir";

function parse(source: string) {
  const parsed = parseCutLanguage(source);
  assert.equal(parsed.diagnostics.length, 0, parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  assert.ok(parsed.module);
  return parsed.module;
}

function semanticIr(ir: CutAVIR): unknown {
  const identities = new Map<string, string>();
  ir.compositions.forEach((value, index) => identities.set(value.id, `composition:${index}`));
  Object.values(ir.scenes).forEach((value, index) => identities.set(value.id, `scene:${index}`));
  Object.values(ir.nodes).forEach((value, index) => identities.set(value.id, `node:${index}`));
  Object.values(ir.signals).forEach((value, index) => identities.set(value.id, `signal:${index}`));
  Object.values(ir.resources).forEach((value, index) => identities.set(value.id, `resource:${index}`));
  ir.jobs.forEach((value, index) => identities.set(value.id, `job:${index}`));
  ir.outputs.forEach((value, index) => identities.set(value.id, `output:${index}`));
  ir.assertions.forEach((value, index) => identities.set(value.id, `assertion:${index}`));

  const normalize = (value: unknown): unknown => {
    if (typeof value === "string") return identities.get(value) ?? value;
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
        if (key === "sourceHash" || key === "buildId" || key === "contentHash" || key === "provenance") return [];
        return [[key, normalize(child)]];
      }));
    }
    return value;
  };

  return normalize({
    ...ir,
    resources: Object.values(ir.resources),
    scenes: Object.values(ir.scenes),
    nodes: Object.values(ir.nodes),
    signals: Object.values(ir.signals),
  });
}

test("formatter is deterministic and idempotent", () => {
  const source = 'cut 0.4;project "format";import{Text as Label}from"cut:visual";const config={size:42px,colors:[#AABBCC,#112233]};timeline main(duration:2s,fps:24){scene one(duration:2s){Label(content:"Hello",fontSize:config.size)as title;animate title.opacity from 0% to 100% over 1s;}}export out=render(main);';
  const first = formatCutSource(source);
  const second = formatCutSource(source);
  assert.equal(first, second);
  assert.equal(formatCutSource(first), first);
  assert.match(first, /import \{ Text as Label \} from "cut:visual";/);
  assert.match(first, /timeline main\(duration: 2s, fps: 24\) \{\n  scene one/);
});

test("formatter preserves leading, trailing, nested, and string-like line comments", () => {
  const source = `// module reason
cut 0.4; // language reason
project "https://example.test//inside-string";
import { Text, // first symbol
  Stack as Layout // alias reason
} from "cut:visual";
const settings = { // object reason
  label: "not // a comment", // label reason
  color: #ABCDEF
};
// timeline reason
timeline main(duration: 1s, fps: 24) {
  scene one(duration: 1s) { // scene reason
    Text(content: settings.label); // node reason
  }
  }
  export out = render(main); // export reason
`;
  const formatted = formatCutSource(source);
  const comments = [
    "// module reason",
    "// language reason",
    "// first symbol",
    "// alias reason",
    "// object reason",
    "// label reason",
    "// timeline reason",
    "// scene reason",
    "// node reason",
    "// export reason",
  ];
  for (const comment of comments) {
    assert.ok(formatted.includes(comment), `missing ${comment}`);
  }
  assert.ok(formatted.includes('"https://example.test//inside-string"'));
  assert.ok(formatted.includes('"not // a comment"'));
  assert.equal(formatCutSource(formatted), formatted);
});

test("formatter preserves CRLF comment text without swallowing the next token", () => {
  const source = 'cut 0.4; // keep CRLF\r\nproject "windows";\r\nconst value = 1;\r\n';
  const formatted = formatCutSource(source);
  assert.ok(formatted.includes("// keep CRLF\r\n"));
  assert.ok(formatted.includes('project "windows";'));
  assert.equal(parse(formatted).declarations.length, 3);
  assert.equal(formatCutSource(formatted), formatted);
});

test("formatter keeps import and object braces inline while statement blocks are structural", () => {
  const source = 'cut 0.4; project "braces"; import { Text, Video as Picture } from "cut:visual"; const style = { title: { color: #FFEEAA, shadow: { x: 2px, y: 4px } }, safe: true }; component Card(label: String) -> Visual { Text(content: label); } timeline main(duration: 1s, fps: 24) { scene one(duration: 1s) { Card(label: "A") { Text(content: "B"); } } } export out = render(main);';
  const formatted = formatCutSource(source);
  assert.ok(formatted.includes('import { Text, Video as Picture } from "cut:visual";'));
  assert.ok(formatted.includes('const style = { title: { color: #FFEEAA, shadow: { x: 2px, y: 4px } }, safe: true };'));
  assert.match(formatted, /component Card\(label: String\) -> Visual \{\n  Text/);
  assert.match(formatted, /Card\(label: "A"\) \{\n      Text/);
  assert.doesNotMatch(formatted, /import \{\n/);
  assert.doesNotMatch(formatted, /const style = \{\n/);
});

test("formatter handles nested control and node blocks without collapsing them into object syntax", () => {
  const source = 'cut 0.4; project "nested"; import { Text } from "cut:visual"; timeline main(duration: 2s, fps: 24) { scene one(duration: 2s) { if true { at 0s { for label in ["A", "B"] { Text(content: label); } } } else { Text(content: "fallback"); } } } export out = render(main);';
  const formatted = formatCutSource(source);
  assert.match(formatted, /if true \{\n      at 0s \{\n        for label in \["A", "B"\] \{\n          Text/);
  assert.match(formatted, /\n    \} else \{\n      Text\(content: "fallback"\);/);
  assert.equal(formatCutSource(formatted), formatted);
});

test("formatter preserves authored string, number, unit, and color literal spellings", () => {
  const source = 'cut 0.4; project "literals"; const text = "line\\nquote: \\" and slash: \\\\ and // text"; const duration = 01.500S; const tint = #AaBbCcDd; const amount = .500DB;';
  const formatted = formatCutSource(source);
  assert.ok(formatted.includes('"line\\nquote: \\" and slash: \\\\ and // text"'));
  assert.ok(formatted.includes("01.500S"));
  assert.ok(formatted.includes("#AaBbCcDd"));
  assert.ok(formatted.includes(".500DB"));
  assert.equal(formatCutSource(formatted), formatted);
});

test("formatter returns a typed source diagnostic for malformed CUT", () => {
  assert.throws(
    () => formatCutSource('cut 0.4; project "broken"'),
    (error) => {
      assert.ok(error instanceof CutFormatError);
      assert.equal(error.code, "CUT_FORMAT_SYNTAX");
      assert.equal(error.diagnostic?.code, "CUT1002");
      assert.match(error.message, /1:\d+.*Expected/);
      assert.match(error.diagnostic?.hint ?? "", /semicolon/i);
      return true;
    },
  );
});

test("formatter enforces explicit UTF-8 input and output bounds", () => {
  assert.throws(
    () => formatCutSource('cut 0.4; project "é";', { maxInputBytes: 10 }),
    (error) => error instanceof CutFormatError
      && error.code === "CUT_FORMAT_INPUT_LIMIT"
      && error.actual === Buffer.byteLength('cut 0.4; project "é";', "utf8")
      && error.limit === 10,
  );
  assert.throws(
    () => formatCutSource('cut 0.4; project "x";', { maxOutputBytes: 8 }),
    (error) => error instanceof CutFormatError && error.code === "CUT_FORMAT_OUTPUT_LIMIT" && error.limit === 8,
  );
  assert.throws(
    () => formatCutSource("", { indentWidth: 0 }),
    (error) => error instanceof CutFormatError && error.code === "CUT_FORMAT_INVALID_OPTIONS",
  );
});

test("formatting preserves compiled audiovisual IR exactly", () => {
  const source = `// compiler equivalence fixture
cut 0.4;project "equivalence";import{Text}from"cut:visual";import{outCubic}from"@cut/motion";
asset face:FontAsset=font("fixtures/InterVariable.ttf");
const COPY={headline:"Signal",accent:#FFCC00};
timeline main(duration:2s,fps:24){scene reveal(duration:2s){Text(content:COPY.headline,font:face,color:COPY.accent,opacity:0%)as title;animate title.opacity from 0% to 100% over 1s ease outCubic;at 1s{set title.x=24px;}}}export out=render(main);`;
  const before = compileCutModule(parse(source)).ir;
  const formatted = formatCutSource(source);
  const after = compileCutModule(parse(formatted)).ir;
  assert.deepEqual(semanticIr(after), semanticIr(before));
  assert.notEqual(after.sourceHash, before.sourceHash, "the fixture must exercise a real source rewrite");
  assert.equal(after.buildId, before.buildId, "source spelling must not change audiovisual build identity");
  assert.deepEqual(Object.keys(after.scenes), Object.keys(before.scenes));
  assert.deepEqual(Object.keys(after.nodes), Object.keys(before.nodes));
  assert.deepEqual(Object.keys(after.signals), Object.keys(before.signals));
  assert.deepEqual(after.outputs.map((output) => output.id), before.outputs.map((output) => output.id));
  const semanticEdit = compileCutModule(parse(source.replace('headline:"Signal"', 'headline:"Different"'))).ir;
  assert.notEqual(semanticEdit.buildId, before.buildId, "a real audiovisual edit must still change build identity");
});
