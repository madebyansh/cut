import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const cli = resolve("dist-cli/cli/cut.js");

async function runCheck(source: string) {
  const root = await mkdtemp(resolve(tmpdir(), "cut-geo-check-"));
  try {
    await writeFile(resolve(root, "main.cut"), source);
    return await new Promise<{ code: number | null; stdout: string; stderr: string }>((accept, reject) => {
      const child = spawn(process.execPath, [cli, "check", "main.cut", "--json"], {
        cwd: root,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      });
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
      child.on("error", reject);
      child.on("exit", (code) => accept({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}

function source(placements = '["right"]', mapArguments = "") {
  return `cut 0.4;
project "GeoAnnotation static check";
import { ParallaxCamera, DepthLayer, Rect } from "cut:visual";
import { GeoAnnotation, Map } from "@cut/geo";
timeline main(duration: 1s, fps: 4, width: 192px, height: 128px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    ParallaxCamera(focalLength: 100px) {
      DepthLayer(depth: 100px, edge: "transparent") {
        Map(${mapArguments});
        GeoAnnotation(anchor: { latitude: 0, longitude: 0 }, width: 48px, height: 20px, placements: ${placements}, offset: 6px, safeArea: 8px, leader: "none") {
          Rect(width: 48px, height: 20px, x: 96px, y: 64px, fill: #f59e0b);
        }
      }
      DepthLayer(depth: 0px, edge: "transparent") {
        Rect(width: 8px, height: 8px, x: 8px, y: 8px, fill: #2563eb);
      }
    }
  }
}
export out = render(main, width: 192px, height: 128px, codec: "h264");`;
}

function invalidEasingSource() {
  return source()
    .replace('import { GeoAnnotation, Map } from "@cut/geo";', 'import { GeoAnnotation, Map } from "@cut/geo";\nimport { cubicBezier } from "@cut/motion";')
    .replace('ParallaxCamera(focalLength: 100px) {', 'ParallaxCamera(focalLength: 100px) as camera {')
    .replace('      }\n    }\n  }', '      }\n    }\n    animate camera.x from 0px to 10px over 1s ease cubicBezier(1.2, 0, 0.5, 1);\n  }');
}

test("cut check executes asset-free GeoAnnotation no-op analysis with source-located stable JSON", async () => {
  const result = await runCheck(source('["right", "left"]'));
  assert.equal(result.code, 1, `${result.stderr}${result.stdout}`);
  const report = JSON.parse(result.stdout) as {
    format: string;
    status: string;
    diagnostics: Array<{ code: string; source: { path: string; line: number; column: number } }>;
  };
  assert.equal(report.format, "cut-diagnostics");
  assert.equal(report.status, "fail");
  assert.equal(report.diagnostics[0]?.code, "CUT_GEO_ANNOTATION_NOOP");
  assert.equal(report.diagnostics[0]?.source.path, "main.cut");
  assert.ok(report.diagnostics[0]?.source.line > 0 && report.diagnostics[0]?.source.column > 0);
});

test("cut check refuses transformed base-map projection before lock or render", async () => {
  const result = await runCheck(source('["right"]', "scale: 1.1"));
  assert.equal(result.code, 1, `${result.stderr}${result.stdout}`);
  const report = JSON.parse(result.stdout) as { status: string; diagnostics: Array<{ code: string; source: { path: string } }> };
  assert.equal(report.status, "fail");
  assert.equal(report.diagnostics[0]?.code, "CUT_GEO_ANNOTATION_PROJECTION");
  assert.equal(report.diagnostics[0]?.source.path, "main.cut");
});

test("cut check accepts the executable GeoAnnotation graph without resources or a lock", async () => {
  const result = await runCheck(source());
  assert.equal(result.code, 0, `${result.stderr}${result.stdout}`);
  const report = JSON.parse(result.stdout) as { status: string; diagnostics: unknown[] };
  assert.equal(report.status, "pass");
  assert.deepEqual(report.diagnostics, []);
});

test("cut check returns a stable easing diagnostic without sampling the invalid camera signal", async () => {
  const result = await runCheck(invalidEasingSource());
  assert.equal(result.code, 1, `${result.stderr}${result.stdout}`);
  const report = JSON.parse(result.stdout) as { status: string; diagnostics: Array<{ code: string; source: { path: string; line: number; column: number } }> };
  assert.equal(report.status, "fail");
  assert.equal(report.diagnostics[0]?.code, "CUT_EASING_INVALID");
  assert.equal(report.diagnostics[0]?.source.path, "main.cut");
  assert.ok(report.diagnostics[0]?.source.line > 0 && report.diagnostics[0]?.source.column > 0);
});
