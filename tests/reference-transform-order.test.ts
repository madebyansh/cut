import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import { parseCutLanguage } from "../lib/language/parser";
import { ReferenceVisualConfigError } from "../lib/runtime/reference/visual-config";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

function source(body: string) {
  return `cut 0.4;
project "unrelated transform proof";
import { Group, Rect } from "cut:visual";
timeline main(duration: 1s, fps: 24, width: 96px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    ${body}
  }
}
export out = render(main, width: 96px, height: 64px, codec: "h264");`;
}

function parse(program: string) {
  const parsed = parseCutLanguage(program);
  assert.ok(parsed.module);
  assert.deepEqual(parsed.diagnostics, []);
  return parsed.module;
}

async function render(program: string, frame = 0) {
  const cutModule = parse(program);
  const checked = checkCutModule(cutModule);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  const ir = compileCutModule(cutModule).ir;
  ir.determinism.semantic = "locked";
  const { composition } = validateReferenceSession(ir);
  const root = await mkdtemp(resolve(tmpdir(), "cut-transform-order-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  await renderer.prepare();
  try {
    return { ir, frame: await renderer.sceneFrame(ir.scenes[composition.sceneIds[0]], frame) };
  } finally {
    renderer.close();
  }
}

function hash(data: Uint8Array) {
  return createHash("sha256").update(data).digest("hex");
}

function redRowCenter(frame: { data: Uint8Array; width: number; height: number }, y: number) {
  const xs: number[] = [];
  for (let x = 0; x < frame.width; x += 1) {
    const offset = (y * frame.width + x) * 4;
    if (frame.data[offset] > 170 && frame.data[offset] > frame.data[offset + 1] * 1.8 && frame.data[offset] > frame.data[offset + 2] * 1.8) xs.push(x);
  }
  assert.ok(xs.length >= 4, `expected a visible red run on row ${y}`);
  return (xs[0] + xs[xs.length - 1]) / 2;
}

function redCentroid(frame: { data: Uint8Array; width: number; height: number }) {
  let total = 0, xTotal = 0, yTotal = 0;
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const offset = (y * frame.width + x) * 4;
      if (frame.data[offset] > 170 && frame.data[offset] > frame.data[offset + 1] * 1.8 && frame.data[offset] > frame.data[offset + 2] * 1.8) {
        total += 1; xTotal += x; yTotal += y;
      }
    }
  }
  assert.ok(total >= 16, "expected a visible red surface");
  return { x: xTotal / total, y: yTotal / total };
}

function redPixelCount(frame: { data: Uint8Array; width: number; height: number }) {
  let total = 0;
  for (let offset = 0; offset < frame.data.length; offset += 4) {
    if (frame.data[offset] > 170 && frame.data[offset] > frame.data[offset + 1] * 1.8 && frame.data[offset] > frame.data[offset + 2] * 1.8) total += 1;
  }
  return total;
}

test("Group anchor is a real centre-relative pivot in the public transform stack", async () => {
  const baseline = await render(source('Group() { Rect(width: 20px, height: 12px, fill: #ef233c); }'));
  const anchored = await render(source('Group(anchorX: 12px) { Rect(width: 20px, height: 12px, fill: #ef233c); }'));
  const compensated = await render(source('Group(x: 12px, anchorX: 12px) { Rect(width: 20px, height: 12px, fill: #ef233c); }'));
  const rotated = await render(source('Group(anchorX: 12px, rotation: 90deg) { Rect(width: 20px, height: 12px, fill: #ef233c); }'));
  const group = Object.values(anchored.ir.nodes).find((node) => node.op === "cut.visual.group")!;
  assert.equal(group.inputs.anchorX.kind, "quantity");
  assert.equal(redCentroid(baseline.frame).x - redCentroid(anchored.frame).x, 12);
  assert.equal(hash(baseline.frame.data), hash(compensated.frame.data), "position must name the destination of the authored pivot");
  const rotatedCenter = redCentroid(rotated.frame), baselineCenter = redCentroid(baseline.frame);
  assert.ok(Math.abs(rotatedCenter.x - baselineCenter.x) < 0.6, "90 degree pivot keeps the transformed anchor on the destination x");
  assert.ok(Math.abs(rotatedCenter.y - (baselineCenter.y - 12)) < 0.6, "90 degree pivot moves the source centre around the authored anchor");
});

test("Group keeps the visible authored pivot at x/y through the hostile transform stack", async () => {
  const baseline = redCentroid((await render(source('Group() { Rect(width: 21px, height: 21px, fill: #ef233c); }'))).frame);
  const cases = [
    { scale: 1.7, skewX: 20, skewY: -15, rotation: 37 },
    { scale: .5, skewX: -30, skewY: 30, rotation: -73 },
    { scale: .66, skewX: -22.9, skewY: 24.4, rotation: -7_320 },
    { scale: 1.25, skewX: 30, skewY: 30, rotation: 10_000 },
    { scale: 1.25, skewX: 0, skewY: 0, rotation: -90 },
  ];
  for (const item of cases) {
    const rendered = await render(source(`Group(x: 7px, y: -5px, anchorX: 13px, anchorY: -9px, scale: ${item.scale}, skewX: ${item.skewX}deg, skewY: ${item.skewY}deg, rotation: ${item.rotation}deg) {
      Rect(x: 61px, y: 23px, width: 21px, height: 21px, fill: #ef233c);
    }`));
    const pivot = redCentroid(rendered.frame);
    assert.ok(Math.abs(pivot.x - (baseline.x + 7)) < .55, `pivot x drifted for ${JSON.stringify(item)}: ${pivot.x}`);
    assert.ok(Math.abs(pivot.y - (baseline.y - 5)) < .55, `pivot y drifted for ${JSON.stringify(item)}: ${pivot.y}`);
  }
});

test("explicit zero Group anchors preserve the omitted-anchor transform bytes", async () => {
  const omitted = await render(source('Group(scale: 1.7, rotation: 37deg) { Rect(width: 21px, height: 13px, fill: #ef233c); }'));
  const explicit = await render(source('Group(anchorX: 0px, anchorY: 0px, scale: 1.7, rotation: 37deg) { Rect(width: 21px, height: 13px, fill: #ef233c); }'));
  assert.equal(hash(explicit.frame.data), hash(omitted.frame.data));
});

test("Group anchor animates as a typed Length signal on the exact frame clock", async () => {
  const program = source(`Group() as card {
      Rect(width: 20px, height: 12px, fill: #ef233c);
    }
    animate card.anchorX from 0px to 24px over 1s;`);
  const initial = await render(program, 0);
  const middle = await render(program, 12);
  const group = Object.values(initial.ir.nodes).find((node) => node.op === "cut.visual.group")!;
  assert.ok("signal" in group.properties.anchorX);
  if ("signal" in group.properties.anchorX) assert.equal(initial.ir.signals[group.properties.anchorX.signal].valueType, "Length");
  assert.ok(Math.abs((redCentroid(initial.frame).x - redCentroid(middle.frame).x) - 12) < 0.6);
});

test("Group anchor is bounded and remains closed to kernels that do not execute it", () => {
  const cutModule = parse(source('Group(anchorY: 65537px) { Rect(width: 20px, height: 12px, fill: #ef233c); }'));
  assert.deepEqual(checkCutModule(cutModule).diagnostics.filter((item) => item.severity === "error"), []);
  const ir = compileCutModule(cutModule).ir;
  ir.determinism.semantic = "locked";
  assert.throws(
    () => validateReferenceSession(ir),
    (error) => error instanceof ReferenceVisualConfigError
      && error.code === "CUT_VISUAL_VALUE_RANGE"
      && /cut\.visual\.group at project\.cut:\d+:\d+ input “anchorY” must be between -65536 and 65536/.test(error.message),
  );
  const diagnostics = checkCutModule(parse(source('Rect(width: 20px, height: 12px, fill: #ef233c, anchorX: 4px);'))).diagnostics;
  assert.ok(diagnostics.some((item) => (item.code === "CUT2059" || item.code === "CUT2027") && /anchorX/.test(item.message)));
});

test("Group skew executes from public source through typed IR and changes pixels", async () => {
  const baseline = await render(source('Group() { Rect(width: 20px, height: 20px, fill: #ef233c); }'));
  const skewed = await render(source('Group(skewX: 20deg) { Rect(width: 20px, height: 20px, fill: #ef233c); }'));
  const group = Object.values(skewed.ir.nodes).find((node) => node.op === "cut.visual.group")!;
  assert.deepEqual(Object.keys(group.inputs), ["skewX"]);
  assert.equal(group.inputs.skewX.kind, "quantity");
  assert.notEqual(hash(baseline.frame.data), hash(skewed.frame.data));
  assert.ok(redRowCenter(skewed.frame, 23) < redRowCenter(skewed.frame, 40), "positive skewX must move lower pixels rightward");
});

test("nested Group transforms have deterministic inner-to-outer order", async () => {
  const skewThenRotate = await render(source('Group(rotation: 24deg) { Group(skewX: 20deg) { Rect(width: 18px, height: 28px, fill: #ef233c); } }'));
  const rotateThenSkew = await render(source('Group(skewX: 20deg) { Group(rotation: 24deg) { Rect(width: 18px, height: 28px, fill: #ef233c); } }'));
  assert.notEqual(hash(skewThenRotate.frame.data), hash(rotateThenSkew.frame.data), "nested transform order must remain semantically observable");
});

test("nested anchored Groups remain ordered and output clipping cannot wrap pixels", async () => {
  const innerFirst = await render(source('Group(anchorX: 12px, rotation: 31deg) { Group(anchorY: -8px, scale: 0.8) { Rect(x: 58px, y: 25px, width: 14px, height: 9px, fill: #ef233c); } }'));
  const outerFirst = await render(source('Group(anchorY: -8px, scale: 0.8) { Group(anchorX: 12px, rotation: 31deg) { Rect(x: 58px, y: 25px, width: 14px, height: 9px, fill: #ef233c); } }'));
  assert.ok(redPixelCount(innerFirst.frame) > 0 && redPixelCount(outerFirst.frame) > 0);
  assert.notEqual(hash(innerFirst.frame.data), hash(outerFirst.frame.data));

  const clipped = await render(source('Group(anchorX: 65536px, anchorY: -65536px) { Rect(width: 20px, height: 12px, fill: #ef233c); }'));
  assert.equal(redPixelCount(clipped.frame), 0, "an entirely off-canvas anchored surface must clip to transparent instead of wrapping");
});

test("Group skew properties animate through a typed signal", async () => {
  const program = source(`Group() as card {
      Rect(width: 20px, height: 20px, fill: #ef233c);
    }
    animate card.skewX from 0deg to 20deg over 1s;`);
  const initial = await render(program, 0);
  const middle = await render(program, 12);
  const group = Object.values(initial.ir.nodes).find((node) => node.op === "cut.visual.group")!;
  assert.ok("signal" in group.properties.skewX);
  assert.notEqual(hash(initial.frame.data), hash(middle.frame.data));
});

test("Group skew refuses out-of-contract angles with a stable source-located diagnostic", () => {
  const cutModule = parse(source('Group(skewY: 31deg) { Rect(width: 20px, height: 20px, fill: #ef233c); }'));
  assert.deepEqual(checkCutModule(cutModule).diagnostics.filter((item) => item.severity === "error"), []);
  const ir = compileCutModule(cutModule).ir;
  ir.determinism.semantic = "locked";
  assert.throws(
    () => validateReferenceSession(ir),
    (error) => error instanceof ReferenceVisualConfigError
      && error.code === "CUT_VISUAL_VALUE_RANGE"
      && /cut\.visual\.group at project\.cut:\d+:\d+ input “skewY” must be between -30 and 30/.test(error.message),
  );
});

test("combined scale, skew, and rotation refuse oversized intermediates before pixel allocation", async () => {
  const program = source('Group(scale: 2, skewX: 30deg, skewY: 30deg, rotation: 45deg) { Rect(width: 20px, height: 20px, fill: #ef233c); }')
    .replace("width: 96px, height: 64px", "width: 4096px, height: 4096px")
    .replace("width: 96px, height: 64px", "width: 4096px, height: 4096px");
  const cutModule = parse(program);
  assert.deepEqual(checkCutModule(cutModule).diagnostics.filter((item) => item.severity === "error"), []);
  const ir = compileCutModule(cutModule).ir;
  ir.determinism.semantic = "locked";
  const { composition } = validateReferenceSession(ir);
  const group = Object.values(ir.nodes).find((node) => node.op === "cut.visual.group")!;
  const root = await mkdtemp(resolve(tmpdir(), "cut-transform-budget-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  try {
    await assert.rejects(
      () => renderer.sceneFrame(ir.scenes[composition.sceneIds[0]], 0),
      (error) => error instanceof ReferenceVisualConfigError
        && error.code === "CUT_VISUAL_VALUE_RANGE"
        && /combined scale\/skew\/rotation would allocate.*estimated/.test(error.message),
    );
  } finally {
    renderer.close();
  }
  assert.ok(group.inputs.skewX && group.inputs.skewY, "the refusal must cover the authored typed transform inputs");
});

test("skew remains closed to kernels that do not execute it", () => {
  const diagnostics = checkCutModule(parse(source('Rect(width: 20px, height: 20px, fill: #ef233c, skewX: 10deg);'))).diagnostics;
  assert.ok(diagnostics.some((item) => (item.code === "CUT2059" || item.code === "CUT2027") && /skewX/.test(item.message)));
});
