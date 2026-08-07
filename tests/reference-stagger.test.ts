import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR, IRSignal, IRValue } from "../lib/language/ir";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

function source(body: string) {
  return `cut 0.4;
project "unrelated stagger proof";
import { Group, Rect } from "cut:visual";
import { stagger } from "@cut/motion";
timeline main(duration: 1s, fps: 24, width: 100px, height: 100px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    ${body}
  }
}
export out = render(main, width: 100px, height: 100px, codec: "h264");`;
}

function compile(program: string) {
  const parsed = parseCutLanguage(program);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  const ir = compileCutModule(parsed.module).ir;
  ir.determinism.semantic = "locked";
  return { ir, composition: validateReferenceSession(ir).composition };
}

const staggered = source(`for item in [
      { index: 0, x: -20px },
      { index: 1, x: 0px },
      { index: 2, x: 20px }
    ] {
      Group(x: item.x, opacity: 0%) as card {
        Rect(width: 8px, height: 8px, fill: #ef233c);
      }
      animate card.opacity from 0% to 100% over 1f delay stagger(index: item.index, each: 3f);
    }`);

function animationEvents(ir: CutAVIR) {
  return Object.values(ir.signals)
    .filter((signal): signal is Extract<IRSignal, { kind: "track" }> => signal.kind === "track")
    .flatMap((signal) => signal.events)
    .filter((event): event is Extract<Extract<IRSignal, { kind: "track" }>["events"][number], { kind: "animate" }> => event.kind === "animate")
    .sort((left, right) => Number(left.start.numerator) / Number(left.start.denominator) - Number(right.start.numerator) / Number(right.start.denominator));
}

test("stagger lowers loop-derived indices to exact rational animation delays and disappears from IR", () => {
  const { ir } = compile(staggered);
  const events = animationEvents(ir);
  assert.deepEqual(events.map((event) => event.start), [rational(0), rational(1, 8), rational(1, 4)]);
  assert.deepEqual(events.map((event) => event.end), [rational(1, 24), rational(1, 6), rational(7, 24)]);
  const containsIntrinsic = (value: IRValue): boolean => value.kind === "call"
    ? value.op === "cut.motion.stagger" || value.positional.some(containsIntrinsic) || Object.values(value.named).some(containsIntrinsic)
    : value.kind === "array" ? value.items.some(containsIntrinsic)
      : value.kind === "object" ? Object.values(value.entries).some(containsIntrinsic)
        : value.kind === "range" ? containsIntrinsic(value.start) || containsIntrinsic(value.end)
          : value.kind === "member" ? containsIntrinsic(value.object)
            : value.kind === "index" ? containsIntrinsic(value.object) || containsIntrinsic(value.index)
              : value.kind === "unary" ? containsIntrinsic(value.value)
                : value.kind === "binary" ? containsIntrinsic(value.left) || containsIntrinsic(value.right)
                  : false;
  assert.ok(Object.values(ir.signals).every((signal) => !signalValues(signal).some(containsIntrinsic)));
});

test("stagger optional offset stays exact and drives ordinary at placement", () => {
  const { ir } = compile(source(`at stagger(index: 2, each: 3f, offset: 1f) {
    Rect(width: 8px, height: 8px, fill: #ef233c);
  }`));
  const rect = Object.values(ir.nodes).find((node) => node.op === "cut.visual.rect");
  assert.ok(rect);
  assert.deepEqual(rect.interval.start, rational(7, 24));
});

test("staggered delays cause progressive rendered reveals on exact frames", async () => {
  const { ir, composition } = compile(staggered);
  const root = await mkdtemp(resolve(tmpdir(), "cut-stagger-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  await renderer.prepare();
  const scene = ir.scenes[composition.sceneIds[0]];
  try {
    const visible = async (frame: number) => {
      const surface = await renderer.sceneFrame(scene, frame, false);
      return [30, 50, 70].map((x) => surface.data[(50 * surface.width + x) * 4 + 3] > 240);
    };
    assert.deepEqual(await visible(0), [false, false, false]);
    assert.deepEqual(await visible(1), [true, false, false]);
    assert.deepEqual(await visible(4), [true, true, false]);
    assert.deepEqual(await visible(7), [true, true, true]);
  } finally {
    renderer.close();
  }
});

test("stagger refuses fractional, negative and over-budget indices plus nonpositive/negative times with a stable source code", () => {
  const invalid = [
    "stagger(index: 0.5, each: 1f)",
    "stagger(index: -1, each: 1f)",
    "stagger(index: 4096, each: 1f)",
    "stagger(index: 1, each: 0s)",
    "stagger(index: 1, each: -1f)",
    "stagger(index: 1, each: 1f, offset: -1f)",
  ];
  for (const expression of invalid) {
    const parsed = parseCutLanguage(source(`at ${expression} { Rect(width: 1px, height: 1px); }`));
    assert.ok(parsed.module);
    const checked = checkCutModule(parsed.module);
    assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
    assert.throws(
      () => compileCutModule(parsed.module!),
      (error) => error instanceof CutCompileError && error.result.diagnostics.some((item) => item.code === "CUT_MOTION_STAGGER" && item.span.start.line > 0),
    );
  }
});

test("stagger argument types remain closed at the public checker boundary", () => {
  const parsed = parseCutLanguage(source("at stagger(index: 1s, each: 1) { Rect(width: 1px, height: 1px); }"));
  assert.ok(parsed.module);
  const errors = checkCutModule(parsed.module).diagnostics.filter((item) => item.severity === "error");
  assert.ok(errors.some((item) => /index/.test(item.message) && /Number/.test(item.message)));
  assert.ok(errors.some((item) => /each/.test(item.message) && /Time/.test(item.message)));
});

function signalValues(signal: IRSignal): IRValue[] {
  if (signal.kind === "constant") return [signal.value];
  if (signal.kind === "step") return signal.points.map((point) => point.value);
  if (signal.kind === "keyframes") return signal.keyframes.flatMap((point) => [point.value, point.curve]);
  return [signal.initial, ...signal.events.flatMap((event) => event.kind === "set" ? [event.value] : [event.from, event.to, event.curve])];
}
