import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import { parseCutLanguage } from "../lib/language/parser";

const cli = resolve("dist-cli/cli/cut.js");

function program(spans: string, base = "size: 54.0px, color: #f5f1e8") {
  return `cut 0.4;
project "FlowText static check";
import { FlowText, Rect, textSpan } from "cut:visual";
asset face: FontAsset = font("font.ttf");
timeline main(duration: 1s, fps: 24, width: 640px, height: 360px) {
  scene one(duration: 1s) {
    Rect(width: 640px, height: 360px, fill: #000000);
    FlowText(
      spans: ${spans},
      font: face,
      ${base},
      layoutX: 20px,
      baselineY: 80px,
      maxWidth: 500px,
      lineHeight: 60px,
      maxLines: 2
    );
  }
}
export release = render(main, width: 640px, height: 360px, codec: "h264");
`;
}

function diagnostics(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return checkCutModule(parsed.module).diagnostics;
}

test("checker rejects direct literal textSpan overrides equal to literal FlowText bases and omitted zero defaults", () => {
  const source = program(`[
        textSpan(
          id: "lead",
          content: "AV",
          size: 54px,
          color: #f5f1e8ff,
          tracking: 0.0px,
          baselineShift: -0px
        )
      ]`);
  const failures = diagnostics(source).filter(({ code }) => code === "CUT_FLOW_TEXT_INPUT_SHAPE");
  assert.deepEqual(failures.map(({ message }) => message), [
    "spans[0].size redundantly repeats the FlowText base size.",
    "spans[0].tracking redundantly repeats the FlowText base tracking.",
    "spans[0].baselineShift redundantly repeats the FlowText base baselineShift.",
    "spans[0].color redundantly repeats the FlowText base color.",
  ]);
  for (const failure of failures) {
    assert.ok(failure.span.start.line > 0 && failure.span.start.column > 0);
    assert.match(failure.hint ?? "", /^Omit (?:size|tracking|baselineShift|color): from this textSpan/u);
  }
});

test("checker handles positional literals but does not claim equality for const or indirect span expressions", () => {
  const positional = program('[textSpan("lead", "AV", 54px, #f5f1e8ff, 1px, 2px)]', "size: 54px, color: #f5f1e8, tracking: 1.0px, baselineShift: 2.00px");
  assert.deepEqual(
    diagnostics(positional).filter(({ code }) => code === "CUT_FLOW_TEXT_INPUT_SHAPE").map(({ message }) => message),
    [
      "spans[0].size redundantly repeats the FlowText base size.",
      "spans[0].tracking redundantly repeats the FlowText base tracking.",
      "spans[0].baselineShift redundantly repeats the FlowText base baselineShift.",
      "spans[0].color redundantly repeats the FlowText base color.",
    ],
  );
  const positionalCompilable = program(
    '[textSpan("lead", "AV", 54px, #f5f1e8ff, 1px, 2px)]',
    "size: 60px, color: #ffffff, tracking: 0px, baselineShift: 0px",
  );
  const parsedPositional = parseCutLanguage(positionalCompilable);
  assert.ok(parsedPositional.module);
  const positionalIr = compileCutModule(parsedPositional.module).ir;
  const positionalFlow = Object.values(positionalIr.nodes).find((node) => node.op === "cut.visual.flow_text");
  assert.ok(positionalFlow);
  assert.equal(positionalFlow.inputs.spans?.kind, "array");
  const positionalSpan = (positionalFlow.inputs.spans as Extract<typeof positionalFlow.inputs.spans, { kind: "array" }>).items[0];
  assert.equal(positionalSpan.kind, "object");
  assert.deepEqual(
    Object.keys((positionalSpan as Extract<typeof positionalSpan, { kind: "object" }>).entries),
    ["id", "content", "size", "color", "tracking", "baselineShift"],
    "adding the optional trailing font parameter must not reinterpret the established six-argument textSpan positional ABI",
  );
  assert.equal((positionalSpan as Extract<typeof positionalSpan, { kind: "object" }>).entries.font, undefined);

  const unresolved = program('[textSpan(id: "lead", content: "AV", size: sharedSize, color: sharedColor, tracking: sharedTracking)]', "size: sharedSize, color: sharedColor, tracking: sharedTracking").replace(
    'asset face: FontAsset = font("font.ttf");',
    'asset face: FontAsset = font("font.ttf");\nconst sharedSize: Length = 54px;\nconst sharedColor: Color = #f5f1e8;\nconst sharedTracking: Length = 1px;',
  );
  assert.equal(diagnostics(unresolved).filter(({ code }) => code === "CUT_FLOW_TEXT_INPUT_SHAPE").length, 0, "identifier/const equivalence remains a runtime validation concern");

  const indirect = program("sharedSpans").replace(
    'asset face: FontAsset = font("font.ttf");',
    'asset face: FontAsset = font("font.ttf");\nconst sharedSpans: List<TextSpan> = [textSpan(id: "lead", content: "AV", size: 54px)];',
  );
  assert.equal(diagnostics(indirect).filter(({ code }) => code === "CUT_FLOW_TEXT_INPUT_SHAPE").length, 0, "an indirect span collection is not reinterpreted as a literal array");
});

test("different literal span styles pass the narrow redundancy check", () => {
  const source = program('[textSpan(id: "lead", content: "AV", size: 53px, color: #ffcf66, tracking: 1px, baselineShift: 1px)]');
  assert.deepEqual(diagnostics(source), []);
});

test("textSpan font is a trailing nominal FontAsset and direct base-face repetition is source-located", () => {
  const explicit = program('[textSpan(id: "lead", content: "A "), textSpan(id: "accent", content: "V", font: alternate)]').replace(
    'asset face: FontAsset = font("font.ttf");',
    'asset face: FontAsset = font("font.ttf");\nasset alternate: FontAsset = font("alternate.ttf");',
  );
  assert.deepEqual(diagnostics(explicit), []);

  const wrong = diagnostics(program('[textSpan(id: "lead", content: "AV", font: "Arial Bold")]'));
  assert.ok(wrong.some((item) => item.code === "CUT2029" && /expects FontAsset, found String/u.test(item.message) && item.span.start.line > 0));

  const redundant = diagnostics(program('[textSpan(id: "lead", content: "AV", font: face)]')).filter(({ code }) => code === "CUT_FLOW_TEXT_INPUT_SHAPE");
  assert.equal(redundant.length, 1);
  assert.match(redundant[0].message, /redundantly repeats the FlowText base font/u);
  assert.match(redundant[0].hint ?? "", /Omit font:/u);
  assert.ok(redundant[0].span.start.line > 0 && redundant[0].span.start.column > 0);
});

test("static redundancy inference defers when the FlowText base fails runtime value precedence", () => {
  const invalidBase = program(
    '[textSpan(id: "lead", content: "AV", size: 0px, color: #f5f1e800, tracking: 1025px, baselineShift: 4097px)]',
    "size: 0px, color: #f5f1e800, tracking: 1025px, baselineShift: 4097px",
  );
  assert.equal(
    diagnostics(invalidBase).filter(({ code }) => code === "CUT_FLOW_TEXT_INPUT_SHAPE").length,
    0,
    "runtime VALUE_RANGE validation precedes any span redundancy diagnosis for invalid bases",
  );
});

test("check and lint publish matching stable JSON diagnostics before pixel execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "cut-flow-text-check-"));
  try {
    const source = program('[textSpan(id: "lead", content: "AV", size: 54px, color: #f5f1e8, tracking: 0px, baselineShift: 0px)]');
    await writeFile(join(root, "invalid.cut"), source);
    const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    const checked = run(["check", "invalid.cut", "--json"]), linted = run(["lint", "invalid.cut", "--deny-warnings", "--json"]);
    assert.equal(checked.status, 1, checked.stderr); assert.equal(linted.status, 1, linted.stderr);
    type Report = { status: string; diagnostics: Array<{ code: string; message: string; source: { path: string; line: number; column: number } }> };
    const checkReport = JSON.parse(checked.stdout) as Report, lintReport = JSON.parse(linted.stdout) as Report;
    const select = (report: Report) => report.diagnostics.filter(({ code }) => code === "CUT_FLOW_TEXT_INPUT_SHAPE");
    const checkFailures = select(checkReport), lintFailures = select(lintReport);
    assert.equal(checkReport.status, "fail"); assert.equal(lintReport.status, "fail");
    assert.equal(checkFailures.length, 4); assert.deepEqual(lintFailures, checkFailures);
    assert.ok(checkFailures.every(({ source }) => /invalid\.cut$/u.test(source.path) && source.line > 0 && source.column > 0));
  } finally { await rm(root, { recursive: true, force: true }); }
});
