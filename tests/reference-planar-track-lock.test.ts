import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { compileCutModule } from "../lib/language/compiler";
import {
  applyCutLock,
  applyCutLockForVerifiedInputSession,
  createCutLock,
  verifyLockedIrResources,
} from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { ReferencePlanarTrackError } from "../lib/runtime/reference/planar-tracking";
import { prepareReferenceVerifiedInputSession } from "../lib/runtime/reference/verified-input-session";

const source = `cut 0.4;
project "planar lock proof";
import { LocalSpace, PlanarTrack, Rect } from "cut:visual";
asset plane: DataAsset = data("plane.planar.json");
timeline main(duration: 1s, fps: 4, width: 64px, height: 48px, sampleRate: 8khz) {
  scene only(duration: 1s) {
    PlanarTrack(
      source: plane,
      minConfidence: 75%,
      lowConfidence: "fail",
      occluded: "hold",
      outOfFrame: "hide",
      interpolation: "linear",
      opacity: 100%
    ) {
      LocalSpace(width: 16px, height: 8px, origin: { x: 0px, y: 0px }) {
        Rect(width: 16px, height: 8px, x: 8px, y: 4px, fill: #ff5533);
      }
    }
  }
}
export out = render(main, width: 64px, height: 48px, codec: "h264");`;

function compile() {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics.filter((item) => item.severity === "error"), []);
  const compiled = compileCutModule(parsed.module);
  assert.deepEqual(compiled.check.diagnostics.filter((item) => item.severity === "error"), []);
  return compiled.ir;
}

function sidecar(overrides: Record<string, unknown> = {}) {
  return `${JSON.stringify({
    format: "cut-planar-track",
    version: 1,
    coordinateSpace: "composition-pixel-edges",
    width: 64,
    height: 48,
    samples: [
      {
        at: { numerator: "0", denominator: "1" },
        confidence: { numerator: "1", denominator: "1" },
        status: "visible",
        corners: {
          topLeft: { x: { numerator: "8", denominator: "1" }, y: { numerator: "8", denominator: "1" } },
          topRight: { x: { numerator: "24", denominator: "1" }, y: { numerator: "7", denominator: "1" } },
          bottomRight: { x: { numerator: "25", denominator: "1" }, y: { numerator: "17", denominator: "1" } },
          bottomLeft: { x: { numerator: "7", denominator: "1" }, y: { numerator: "16", denominator: "1" } },
        },
      },
      {
        at: { numerator: "1", denominator: "1" },
        confidence: { numerator: "9", denominator: "10" },
        status: "visible",
        corners: {
          topLeft: { x: { numerator: "18", denominator: "1" }, y: { numerator: "11", denominator: "1" } },
          topRight: { x: { numerator: "37", denominator: "1" }, y: { numerator: "9", denominator: "1" } },
          bottomRight: { x: { numerator: "39", denominator: "1" }, y: { numerator: "21", denominator: "1" } },
          bottomLeft: { x: { numerator: "17", denominator: "1" }, y: { numerator: "22", denominator: "1" } },
        },
      },
    ],
    ...overrides,
  }, null, 2)}\n`;
}

test("cut.lock parses and binds PlanarTrack semantics before publishing semantic determinism", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-planar-lock-"));
  await writeFile(resolve(root, "plane.planar.json"), sidecar(), "utf8");
  const ir = compile(), lock = await createCutLock(ir, root);
  assert.equal(lock.resources.plane.kind, "data");
  assert.match(lock.resources.plane.sha256, /^[0-9a-f]{64}$/u);
  await applyCutLock(ir, lock, root);
  assert.equal(ir.resources.plane.state, "locked");
  await verifyLockedIrResources(ir, root);
  const verified = await prepareReferenceVerifiedInputSession(ir, root, "master");
  await verified.cleanup();

  const sameLengthTamper = sidecar().replace('"numerator": "18"', '"numerator": "19"');
  assert.equal(Buffer.byteLength(sameLengthTamper), lock.resources.plane.bytes);
  await writeFile(resolve(root, "plane.planar.json"), sameLengthTamper, "utf8");
  await assert.rejects(
    verifyLockedIrResources(ir, root),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error
      && error.code === "CUT_LOCK_INTEGRITY"),
  );
});

test("verified-input snapshots revalidate forged PlanarTrack semantics before rendering", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-planar-session-"));
  await writeFile(resolve(root, "plane.planar.json"), sidecar(), "utf8");
  const canonical = await createCutLock(compile(), root);
  const invalidBytes = Buffer.from(sidecar({ version: 2 }), "utf8"), invalidSha256 = createHash("sha256").update(invalidBytes).digest("hex");
  await writeFile(resolve(root, "plane.planar.json"), invalidBytes);

  // Model an internally coherent hostile lock whose generic byte probe agrees
  // with the changed file. The deferred apply path deliberately leaves native
  // and semantic byte checks to the sealed verified-input session.
  const forged = structuredClone(canonical), resource = forged.resources.plane;
  resource.bytes = invalidBytes.byteLength;
  resource.sha256 = invalidSha256;
  assert.equal(resource.probe.kind, "bytes");
  if (resource.probe.kind !== "bytes") return;
  resource.probe.identity.file.bytes = invalidBytes.byteLength;
  resource.probe.identity.file.sha256 = invalidSha256;

  const deferred = compile();
  await applyCutLockForVerifiedInputSession(deferred, forged, root);
  await assert.rejects(
    prepareReferenceVerifiedInputSession(deferred, root, "master"),
    (error: unknown) => error instanceof ReferencePlanarTrackError
      && error.code === "CUT_PLANAR_TRACK_SCHEMA",
  );
});

test("lock creation refuses invalid PlanarTrack schema and canvas binding with source locations", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-planar-lock-invalid-"));
  await writeFile(resolve(root, "plane.planar.json"), sidecar({ version: 2 }), "utf8");
  await assert.rejects(
    createCutLock(compile(), root),
    (error: unknown) => error instanceof ReferencePlanarTrackError
      && error.code === "CUT_PLANAR_TRACK_SCHEMA"
      && error.source.line > 0
      && error.source.column > 0,
  );

  await writeFile(resolve(root, "plane.planar.json"), sidecar({ width: 65 }), "utf8");
  await assert.rejects(
    createCutLock(compile(), root),
    (error: unknown) => error instanceof ReferencePlanarTrackError
      && error.code === "CUT_PLANAR_TRACK_DIMENSIONS"
      && /does not match composition 64×48/u.test(error.message),
  );
});
