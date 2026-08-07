import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import { parseCutLanguage } from "../lib/language/parser";
import {
  ReferenceStackConfigError,
  referenceStackDiagnosticCode,
  referenceStackPlacements,
  type ReferenceAlphaBounds,
  type ReferenceStackConfig,
} from "../lib/runtime/reference/layout";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

function program(stack: string) {
  return `cut 0.4;
project "unrelated layout proof";
import { Rect, Stack } from "cut:visual";
timeline main(duration: 1s, fps: 24, width: 96px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Stack(${stack}) as layout {
      Rect(width: 12px, height: 12px, fill: #ef233c);
      Rect(width: 20px, height: 8px, fill: #2ec4b6);
    }
  }
}
export out = render(main, width: 96px, height: 64px, codec: "h264");`;
}

function parse(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module);
  assert.deepEqual(parsed.diagnostics, []);
  return parsed.module;
}

async function frame(stack: string) {
  const cutModule = parse(program(stack)), checked = checkCutModule(cutModule);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  const ir = compileCutModule(cutModule).ir;
  ir.determinism.semantic = "locked";
  const { composition } = validateReferenceSession(ir);
  const root = await mkdtemp(resolve(tmpdir(), "cut-layout-")), renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  await renderer.prepare();
  try { return { frame: await renderer.sceneFrame(ir.scenes[composition.sceneIds[0]], 0), ir }; }
  finally { renderer.close(); }
}

type Bounds = { left: number; right: number; top: number; bottom: number };

function colorBounds(surface: { data: Uint8Array; width: number; height: number }, color: "red" | "green"): Bounds {
  let left = surface.width, right = -1, top = surface.height, bottom = -1;
  for (let y = 0; y < surface.height; y += 1) for (let x = 0; x < surface.width; x += 1) {
    const offset = (y * surface.width + x) * 4, r = surface.data[offset], g = surface.data[offset + 1], b = surface.data[offset + 2];
    const match = color === "red" ? r > 180 && r > g * 2 && r > b * 1.2 : g > 120 && g > r * 1.2 && g > b;
    if (!match) continue;
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  assert.ok(right >= left && bottom >= top, `${color} pixels must exist`);
  return { left, right, top, bottom };
}

function center(bounds: Bounds) { return { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 }; }

test("Stack direction and gap execute through source, typed IR, layout runtime, and pixels", async () => {
  const horizontal = await frame('direction: "horizontal", gap: 8px');
  const stack = Object.values(horizontal.ir.nodes).find((node) => node.op === "cut.visual.stack")!;
  assert.deepEqual(Object.keys(stack.inputs).sort(), ["direction", "gap"]);
  assert.equal(stack.children.length, 2);
  const red = colorBounds(horizontal.frame, "red"), green = colorBounds(horizontal.frame, "green");
  assert.ok(center(red).x < center(green).x);
  assert.ok(green.left - red.right - 1 >= 7, "authored horizontal gap must remain visible in output pixels");
  assert.ok(Math.abs(center(red).y - center(green).y) <= 1, "default cross-axis alignment is centered");

  const vertical = await frame('direction: "vertical", gap: 8px');
  const verticalRed = colorBounds(vertical.frame, "red"), verticalGreen = colorBounds(vertical.frame, "green");
  assert.ok(center(verticalRed).y < center(verticalGreen).y);
  assert.ok(verticalGreen.top - verticalRed.bottom - 1 >= 7, "authored vertical gap must remain visible in output pixels");
});

test("Stack alignment, distribution, padding, safe area, and frame constraints have exact placements", () => {
  const bounds: ReferenceAlphaBounds[] = [
    { left: 0, top: 0, right: 11, bottom: 11, width: 12, height: 12, centerX: 6, centerY: 6 },
    { left: 0, top: 0, right: 19, bottom: 7, width: 20, height: 8, centerX: 10, centerY: 4 },
  ];
  const config: ReferenceStackConfig = { direction: "horizontal", gap: 8, align: "start", distribution: "space-between", padding: 4, safeArea: 2, width: 80, height: 48, canvasWidth: 96, canvasHeight: 64 };
  const placements = referenceStackPlacements(bounds, config);
  assert.deepEqual(placements, [{ x: 14, y: 14 }, { x: 62, y: 14 }]);
});

test("Stack rejects unknown properties, invalid enum literals, and invalid runtime bounds", () => {
  const invalidEnum = checkCutModule(parse(program('direction: "diagonal", gap: 8px'))).diagnostics;
  assert.ok(invalidEnum.some((item) => item.code === "CUT2068" && /horizontal, vertical/.test(item.message)));
  const unknown = checkCutModule(parse(program('direction: "horizontal", invented: 1'))).diagnostics;
  assert.ok(unknown.some((item) => item.code === "CUT2059" || item.code === "CUT2027"));

  const cutModule = parse(program('direction: "horizontal", gap: -1px'));
  const ir = compileCutModule(cutModule).ir;
  ir.determinism.semantic = "locked";
  assert.throws(
    () => validateReferenceSession(ir),
    (error) => error instanceof ReferenceStackConfigError
      && error.code === referenceStackDiagnosticCode
      && /cut\.visual\.stack.*project\.cut:\d+:\d+.*input “gap” must be at least 0px and at most 65536px/.test(error.message),
  );
});
