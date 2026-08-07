import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import Ajv from "ajv";
import sharp from "sharp";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRNode, IRValue } from "../lib/language/ir";
import { CutAvIrValidationError, loadCutAvIr } from "../lib/language/ir-loader";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { createIncrementalRenderPlan, finalizeGraphHashes } from "../lib/runtime/graph";
import { inspectCutIr } from "../lib/runtime/inspect";
import {
  decodeReferenceAnchoredPathGeometry,
  referenceAnchoredPathPolicyHiddenExecutionIdentity,
} from "../lib/runtime/reference/anchored-path";
import { renderReferenceFrameArtifact } from "../lib/runtime/reference/authoring-review";
import {
  createReferenceLocalSpaceStructuralValidationIndex,
  referenceLocalSpaceFrameEvidence,
  ReferenceLocalSpaceError,
  validateReferenceLocalSpaceGraph,
  type ReferenceLocalSpaceFrameEvidence,
} from "../lib/runtime/reference/local-space";
import {
  createReferenceComponentFragmentLocalSpaceAdmissionIndex,
  referenceComponentFragmentLocalSpaceAdmissionIssue,
  referenceLocalSpaceCompositionTransformPreflight,
} from "../lib/runtime/reference/component-fragment-local-space";
import {
  ReferenceLocalSpaceFrameEvidenceError,
  validateReferenceLocalSpaceRendererFrameExecutionSemantics,
} from "../lib/runtime/reference/local-space-frame-evidence";
import { validateReferenceStaticVisualGraphs } from "../lib/runtime/reference/static-visual-validation";
import { referenceLocalSpaceTransformWorkLimits } from "../lib/runtime/reference/local-space-transform-work";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import {
  ReferenceVisualRenderer,
  referenceLocalSpaceRendererFrameExecutionEvidence,
} from "../lib/runtime/reference/visual";

type Finish = "editorial" | "product";

type PlateControls = Readonly<{
  x: string;
  y: string;
  scale: string;
  rotation: string;
  opacity: string;
  seed: string;
  exposure: string;
  fit: "cover" | "contain" | "fill";
}>;

const neutralControls: PlateControls = Object.freeze({
  x: "0",
  y: "0",
  scale: "1",
  rotation: "0",
  opacity: "100",
  seed: "7",
  exposure: "0",
  fit: "fill",
});

const directedControls: PlateControls = Object.freeze({
  x: "2",
  y: "-1",
  scale: "1.5",
  rotation: "90",
  opacity: "50",
  seed: "7",
  exposure: "0",
  fit: "fill",
});

function finishBody(finish: Finish, controls?: PlateControls) {
  const source = controls ? "sourceImage" : "source";
  const fit = controls ? JSON.stringify(controls.fit) : "fit";
  const seed = controls?.seed ?? "seed";
  const exposure = controls?.exposure ?? "exposure";
  const media = `Image(source: ${source}, fit: ${fit})`;
  if (finish === "editorial") {
    return `Vignette(amount: 18%, radius: 72%, softness: 58%, color: #11131a) {
      Grain(amount: 2%, size: 1px, seed: ${seed}, mode: "static", monochrome: true) {
        ColorGrade(exposure: ${exposure}, contrast: 1.05, saturation: 0.9, temperature: 0.02) {
          ${media};
        }
      }
    }`;
  }
  return `Grain(amount: 3%, size: 1px, seed: ${seed}, mode: "static", monochrome: false) {
      ColorGrade(exposure: ${exposure}, contrast: 1.1, saturation: 1.08, temperature: -0.03) {
        ${media};
      }
    }`;
}

function plateBody(finish: Finish, controls?: PlateControls) {
  return `LocalSpace(width: 6px, height: 4px, origin: { x: 1.25px, y: 0.75px }) {
    ${finishBody(finish, controls)}
  }`;
}

function transformStatements(controls: PlateControls) {
  return [
    ...(controls.x === "0" ? [] : [`set plate.x = ${controls.x}px;`]),
    ...(controls.y === "0" ? [] : [`set plate.y = ${controls.y}px;`]),
    ...(controls.scale === "1" ? [] : [`set plate.scale = ${controls.scale};`]),
    ...(controls.rotation === "0" ? [] : [`set plate.rotation = ${controls.rotation}deg;`]),
    ...(controls.opacity === "100" ? [] : [`set plate.opacity = ${controls.opacity}%;`]),
  ].join("\n    ");
}

function componentProgram(
  controls: PlateControls = neutralControls,
  finish: Finish = "editorial",
  project = "component retained plate",
) {
  return `cut 0.4;
project ${JSON.stringify(project)};
import { ColorGrade, Grain, Image, LocalSpace, Rect, Vignette } from "cut:visual";
import { Tone } from "@cut/audio";
asset sourceImage: ImageAsset = image("assets/source.png");
component FinishedPlate(source: ImageAsset, seed: Number, exposure: Number, fit: String) -> Visual {
  ${plateBody(finish)}
}
timeline main(duration: 2s, fps: 4, width: 20px, height: 16px, sampleRate: 8khz) {
  scene feature(duration: 1s) {
    FinishedPlate(source: sourceImage, seed: ${controls.seed}, exposure: ${controls.exposure}, fit: ${JSON.stringify(controls.fit)}) as plate;
    ${transformStatements(controls)}
    Tone(frequency: 440hz, duration: 1s, amplitude: 1%);
  }
  scene tail(duration: 1s) {
    Rect(width: 3px, height: 3px, x: 6px, y: -4px, fill: #4c78ff);
    Tone(frequency: 330hz, duration: 1s, amplitude: 1%);
  }
}
export out = render(main, width: 20px, height: 16px, codec: "h264");`;
}

/** Existing unary Group -> LocalSpace is the independent pixel oracle for the
 * new owner. The only intended semantic difference is the placement owner and
 * its dedicated work receipt; the finished RGBA frame must remain exact. */
function inlineGroupProgram(
  controls: PlateControls = neutralControls,
  finish: Finish = "editorial",
) {
  return `cut 0.4;
project "inline retained plate oracle";
import { ColorGrade, Grain, Group, Image, LocalSpace, Rect, Vignette } from "cut:visual";
import { Tone } from "@cut/audio";
asset sourceImage: ImageAsset = image("assets/source.png");
timeline main(duration: 2s, fps: 4, width: 20px, height: 16px, sampleRate: 8khz) {
  scene feature(duration: 1s) {
    Group() as plate {
      ${plateBody(finish, controls)}
    }
    ${transformStatements(controls)}
    Tone(frequency: 440hz, duration: 1s, amplitude: 1%);
  }
  scene tail(duration: 1s) {
    Rect(width: 3px, height: 3px, x: 6px, y: -4px, fill: #4c78ff);
    Tone(frequency: 330hz, duration: 1s, amplitude: 1%);
  }
}
export out = render(main, width: 20px, height: 16px, codec: "h264");`;
}

function rectComponentProgram(body = plateBodyWithoutMedia()) {
  return `cut 0.4;
project "component LocalSpace hostile IR base";
import { LocalSpace, Rect } from "cut:visual";
component Tile() -> Visual { ${body} }
timeline main(duration: 1s, fps: 4, width: 20px, height: 16px, sampleRate: 8khz) {
  scene only(duration: 1s) { Tile(); }
}
export out = render(main, width: 20px, height: 16px, codec: "h264");`;
}

function manyComponentProgram(count: number, options: Readonly<{ width?: number; height?: number; opacityZero?: boolean }> = {}) {
  const width = options.width ?? 64, height = options.height ?? 64;
  const instances = Array.from({ length: count }, (_, index) => options.opacityZero
    ? `Tile() as tile${index}; set tile${index}.opacity = 0%;`
    : "Tile();").join("\n    ");
  return `cut 0.4;
project "component aggregate preflight";
import { LocalSpace, Rect } from "cut:visual";
component Tile() -> Visual {
  LocalSpace(width: 1px, height: 1px, origin: { x: 0px, y: 0px }) {
    Rect(width: 1px, height: 1px, x: 0px, y: 0px, fill: #ffffff);
  }
}
timeline main(duration: 1s, fps: 4, width: ${width}px, height: ${height}px, sampleRate: 8khz) {
  scene feature(duration: 1s) {
    ${instances}
  }
}
export out = render(main, width: ${width}px, height: ${height}px, codec: "h264");`;
}

function animatedComponentProgram(scaleEnd = "2", localWidth = 6, localHeight = 4) {
  return `cut 0.4;
project "dynamic component aggregate preflight";
import { LocalSpace, Rect } from "cut:visual";
import { linear } from "@cut/motion";
component Tile() -> Visual {
  LocalSpace(width: ${localWidth}px, height: ${localHeight}px, origin: { x: 1.25px, y: 0.75px }) {
    Rect(width: 4px, height: 1px, x: 1px, y: 0px, fill: #ef233c);
  }
}
timeline main(duration: 1s, fps: 4, width: 20px, height: 16px, sampleRate: 8khz) {
  scene feature(duration: 1s) {
    Tile() as plate;
    animate plate.x from 0px to 4px over 1s ease linear;
    animate plate.rotation from 0deg to 90deg over 1s ease linear;
    animate plate.scale from 1 to ${scaleEnd} over 1s ease linear;
  }
}
export out = render(main, width: 20px, height: 16px, codec: "h264");`;
}

function weightedStaggerComponentProgram() {
  const tiny = Array.from({ length: 16 }, () => "Tiny();").join("\n    ");
  const heavy = Array.from({ length: 5 }, (_, index) => `Heavy() as heavy${index}; set heavy${index}.scale = 2; set heavy${index}.rotation = 45deg;`).join("\n    ");
  return `cut 0.4;
project "weighted stagger component preflight";
import { LocalSpace, Rect } from "cut:visual";
component Tiny() -> Visual {
  LocalSpace(width: 1px, height: 1px, origin: { x: 0px, y: 0px }) { Rect(width: 1px, height: 1px, fill: #ffffff); }
}
component Heavy() -> Visual {
  LocalSpace(width: 1600px, height: 1000px, origin: { x: 800px, y: 500px }) { Rect(width: 1px, height: 1px, fill: #ef233c); }
}
timeline main(duration: 1s, fps: 4, width: 64px, height: 64px, sampleRate: 8khz) {
  scene feature(duration: 1s) {
    ${tiny}
    ${heavy}
  }
}
export out = render(main, codec: "h264");`;
}

function plateBodyWithoutMedia() {
  return `LocalSpace(width: 6px, height: 4px, origin: { x: 1.25px, y: 0.75px }) {
    Rect(width: 2px, height: 2px, x: 0px, y: 0px, fill: #ef233c);
  }`;
}

function anchoredMotionPolicyProgram() {
  return `cut 0.4;
project "authenticated transitive anchored policy";
import { LocalSpace, MotionPath, Path, Rect, Track2D, anchoredLineTo, anchoredPath, visualAnchor } from "cut:visual";
asset tracking: DataAsset = data("assets/subject.track.json");
timeline main(duration: 1s, fps: 4, width: 64px, height: 64px, sampleRate: 8khz) {
  scene feature(duration: 1s) {
    Track2D(
      source: tracking,
      minConfidence: 60%,
      lowConfidence: "hide",
      occluded: "hide",
      outOfFrame: "hide",
      interpolation: "hold"
    ) as tracked {
      LocalSpace(width: 8px, height: 8px, origin: { x: 4px, y: 4px }) {
        Rect(width: 4px, height: 4px, fill: #ef233c);
      }
    }
    MotionPath(
      geometry: anchoredPath(
        start: visualAnchor(owner: tracked, local: { x: 0px, y: 0px }),
        segments: [anchoredLineTo(to: { x: 60px, y: 60px })],
        closed: false
      ),
      progress: 50%
    ) {
      LocalSpace(width: 6px, height: 6px, origin: { x: 3px, y: 3px }) {
        Rect(width: 2px, height: 2px, fill: #ffcc33);
      }
    }
    Path(points: [{ x: 2px, y: 62px }, { x: 62px, y: 62px }], stroke: #ffffff, width: 1px);
  }
}
export out = render(main, codec: "h264");`;
}

function parse(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics.filter((item) => item.severity === "error"), [], JSON.stringify(parsed.diagnostics));
  return parsed.module;
}

function compile(source: string) {
  const parsedModule = parse(source), checked = checkCutModule(parsedModule);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), [], JSON.stringify(checked.diagnostics));
  return compileCutModule(parsedModule).ir;
}

function node(ir: CutAVIR, op: string, index = 0) {
  const found = Object.values(ir.nodes).filter((candidate) => candidate.op === op)[index];
  assert.ok(found, `missing ${op}[${index}]`);
  return found;
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function generatedFixture(kind: Finish) {
  const root = await mkdtemp(resolve(tmpdir(), `cut-component-local-space-${kind}-`));
  const assets = resolve(root, "assets");
  await mkdir(assets);
  if (kind === "editorial") {
    const rgba = Buffer.alloc(6 * 4 * 4);
    for (let y = 0; y < 4; y += 1) for (let x = 0; x < 6; x += 1) {
      const offset = (y * 6 + x) * 4;
      rgba[offset] = x < 2 ? 238 : x < 4 ? 24 : 36;
      rgba[offset + 1] = x < 2 ? 31 : x < 4 ? 210 : 45;
      rgba[offset + 2] = x < 4 ? 28 : 225;
      rgba[offset + 3] = 255 - y * 18;
    }
    await sharp(rgba, { raw: { width: 6, height: 4, channels: 4 } }).png().toFile(resolve(assets, "source.png"));
  } else {
    const rgba = Buffer.alloc(4 * 6 * 4);
    for (let y = 0; y < 6; y += 1) for (let x = 0; x < 4; x += 1) {
      const offset = (y * 4 + x) * 4, checker = (x + y) % 2 === 0;
      rgba[offset] = checker ? 246 : 42;
      rgba[offset + 1] = checker ? 189 : 72;
      rgba[offset + 2] = checker ? 38 : 220;
      rgba[offset + 3] = x === 0 || y === 0 ? 96 : 255;
    }
    await sharp(rgba, { raw: { width: 4, height: 6, channels: 4 } }).png().toFile(resolve(assets, "source.png"));
  }
  return root;
}

async function locked(root: string, source: string) {
  const ir = compile(source), lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  return ir;
}

async function renderScene(ir: CutAVIR, root: string, sceneName = "feature", frame = 0) {
  const { composition } = validateReferenceSession(ir, "out");
  const scene = Object.values(ir.scenes).find((candidate) => candidate.name === sceneName);
  assert.ok(scene, `missing scene ${sceneName}`);
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut", "component-local-space-cache"));
  try {
    await renderer.prepare();
    const surface = await renderer.sceneFrame(scene, frame, false);
    return {
      surface: { ...surface, data: Buffer.from(surface.data) },
      local: renderer.referenceLocalSpaceEvidence(),
      retained: renderer.referenceRetainedMediaViewportEvidence(),
      localCompositors: renderer.referenceRetainedMediaLocalCompositorEvidence(),
      componentPreflight: renderer.referenceComponentFragmentLocalSpacePreflightEvidence(),
      compositionPreflight: renderer.referenceLocalSpaceCompositionTransformPreflightEvidence(),
    };
  } finally { await renderer.closeAndWait(); }
}

function onePlacement(evidence: ReferenceLocalSpaceFrameEvidence | undefined) {
  assert.ok(evidence);
  assert.equal(evidence.tiles.length, 1);
  assert.equal(evidence.placements.length, 1);
  return { evidence, tile: evidence.tiles[0]!, placement: evidence.placements[0]! };
}

test("public Visual components lower to one exact unary LocalSpace owner and survive lock, strict load, and inspect for two unrelated PNGs", { timeout: 90_000 }, async () => {
  for (const finish of ["editorial", "product"] as const) {
    const root = await generatedFixture(finish);
    try {
      const source = componentProgram(directedControls, finish, `${finish} public component`);
      const unlocked = compile(source);
      assert.deepEqual(validateReferenceStaticVisualGraphs(unlocked), [], `${finish} asset-free topology must close before lock`);

      const ir = await locked(root, source), fragment = node(ir, "cut.kernel.fragment"), local = node(ir, "cut.visual.local_space");
      const image = node(ir, "cut.visual.image"), resource = Object.values(ir.resources)[0]!;
      assert.deepEqual({ domain: fragment.domain, ownership: fragment.ownership, effects: fragment.effects, inputs: fragment.inputs }, {
        domain: "visual", ownership: "root", effects: ["pure"], inputs: {},
      });
      assert.ok(fragment.sceneId);
      assert.deepEqual(fragment.children, [local.id]);
      assert.equal(local.ownership, "child");
      assert.equal(local.sceneId, fragment.sceneId);
      assert.deepEqual(local.interval, fragment.interval);
      assert.equal(fragment.provenance.expandedFrom?.length, 2);
      assert.equal(local.provenance.expandedFrom?.length, 2);
      assert.equal(image.inputs.source?.kind, "resource-ref");
      if (image.inputs.source?.kind === "resource-ref") assert.equal(image.inputs.source.id, resource.id);
      assert.equal(resource.state, "locked");
      assert.equal(resource.sha256, sha256(await readFile(resolve(root, "assets/source.png"))));

      const loaded = loadCutAvIr(JSON.stringify(ir));
      assert.equal(loaded.buildId, ir.buildId);
      const configs = validateReferenceLocalSpaceGraph(loaded, loaded.compositions[0]!);
      const config = configs.get(local.id);
      assert.ok(config);
      assert.deepEqual({ owner: config.owner, ownerNodeId: config.ownerNodeId }, {
        owner: "component-fragment", ownerNodeId: fragment.id,
      });
      const inspection = inspectCutIr(loaded, "project.cut").graph.nodes.find((candidate) => candidate.id === local.id)?.localSpace;
      assert.deepEqual(inspection?.owner, { kind: "component-fragment", nodeId: fragment.id });
      assert.ok(inspection?.executionSupport.owners.includes("cut.kernel.fragment-direct-scene-root-unary"));
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("component-fragment placement executes exact pixels, V2 finishing, Q16 registration, and bounded transform work", { timeout: 90_000 }, async () => {
  for (const finish of ["editorial", "product"] as const) {
    const root = await generatedFixture(finish);
    try {
      const component = await locked(root, componentProgram(directedControls, finish, `${finish} component pixels`));
      const oracle = await locked(root, inlineGroupProgram(directedControls, finish));
      const rendered = await renderScene(component, root), control = await renderScene(oracle, root);
      assert.deepEqual(rendered.surface.data, control.surface.data, `${finish} component must be pixel-identical to the established unary Group placement`);
      assert.notEqual(sha256(rendered.surface.data), sha256(Buffer.alloc(20 * 16 * 4)), `${finish} fixture must paint non-transparent evidence`);

      const { evidence, tile, placement } = onePlacement(rendered.local);
      assert.equal(placement.owner, "component-fragment");
      assert.deepEqual(placement.transform, {
        destinationX: 12,
        destinationY: 7,
        registrationRasterX: 1.25,
        registrationRasterY: 0.75,
        scale: 1.5,
        skewX: 0,
        skewY: 0,
        rotation: 90,
        opacity: 0.5,
      });
      assert.match(placement.transformWork?.workIdentity ?? "", /^[a-f0-9]{64}$/u);
      assert.deepEqual(placement.transformWork && { ...placement.transformWork, workIdentity: "<bound>" }, {
        workIdentity: "<bound>",
        algorithmVersion: "cut-reference-local-space-transform-work-v2",
        rendererHandoff: "connected-reference-visual-renderer",
        schedulingEnforcement: "reference-visual-renderer-fifo-v1",
        source: { width: 6, height: 4 },
        requestedResize: { width: 9, height: 6 },
        sharpCover: { width: 9, height: 6 },
        rotation: { width: 6, height: 9, canonicalDegrees: 90 },
        destination: { width: 20, height: 16 },
        opacityDestinationCopies: 1,
      });
      assert.equal(evidence.counters.transformExecutions, 1);
      assert.equal(evidence.counters.maximumConcurrentTransforms, 1);
      assert.equal(evidence.counters.tileRasterizations, 1);
      assert.equal(evidence.counters.placementRasterizations, 1);
      assert.equal(evidence.counters.placementDestinationPixels, 20 * 16);
      assert.equal(rendered.localCompositors.length, 1);
      const compositor = rendered.localCompositors[0]!;
      assert.equal(compositor.version, 2);
      assert.equal(compositor.localSpaceNodeId, tile.nodeId);
      assert.equal(compositor.materializations.length, 1);
      assert.equal(compositor.materializations[0]?.status, "rendered");
      assert.deepEqual(
        compositor.operations.map((operation) => operation.op),
        finish === "editorial"
          ? ["cut.visual.grain", "cut.visual.vignette"]
          : ["cut.visual.grain"],
      );
      assert.ok(compositor.operations.every((operation) => operation.status === "rendered"));
      assert.equal(compositor.allocations.colorGradeSurfaces, 1, "the retained Image island must execute its nested ColorGrade before local operators");
      assert.equal(compositor.allocations.deliveryPrerasterSurfaces, 0);
      assert.equal(compositor.allocations.deliveryPrerasterRgbaBytes, 0);
      assert.equal(compositor.finalLocalTile.rgbaSha256, tile.localCompositing?.finalRgbaSha256);
      assert.match(tile.tileIdentity, /^[a-f0-9]{64}$/u);
      assert.match(placement.placementIdentity, /^[a-f0-9]{64}$/u);
      assert.notEqual(tile.tileIdentity, placement.placementIdentity);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("x, y, scale, rotation, and opacity each change placement pixels but never the retained tile identity", { timeout: 120_000 }, async () => {
  const root = await generatedFixture("editorial");
  try {
    const baseline = await renderScene(await locked(root, componentProgram(neutralControls)), root);
    const base = onePlacement(baseline.local);
    const variants: Array<readonly [keyof Pick<PlateControls, "x" | "y" | "scale" | "rotation" | "opacity">, string]> = [
      ["x", "2"], ["y", "2"], ["scale", "1.5"], ["rotation", "90"], ["opacity", "50"],
    ];
    const outputHashes = new Set([sha256(baseline.surface.data)]);
    for (const [property, value] of variants) {
      const controls = { ...neutralControls, [property]: value };
      const rendered = await renderScene(await locked(root, componentProgram(controls)), root);
      const proof = onePlacement(rendered.local);
      assert.equal(proof.tile.tileIdentity, base.tile.tileIdentity, `${property} must not invalidate local tile materialization`);
      assert.notEqual(proof.placement.placementIdentity, base.placement.placementIdentity, `${property} must invalidate exact placement identity`);
      assert.notEqual(sha256(rendered.surface.data), sha256(baseline.surface.data), `${property} must have observable pixels`);
      outputHashes.add(sha256(rendered.surface.data));
    }
    assert.equal(outputHashes.size, variants.length + 1, "the asymmetric fixture must distinguish every public fragment transform control");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("zero fragment opacity terminates before Image open, LocalSpace tile raster, finishing, or placement work", { timeout: 60_000 }, async () => {
  const root = await generatedFixture("editorial");
  try {
    const controls = { ...directedControls, opacity: "0" };
    const ir = await locked(root, componentProgram(controls)), rendered = await renderScene(ir, root);
    assert.equal(sha256(rendered.surface.data), sha256(Buffer.alloc(20 * 16 * 4)));
    assert.ok(rendered.surface.data.every((byte) => byte === 0));
    assert.equal(rendered.retained.length, 0);
    assert.equal(rendered.localCompositors.length, 0);
    assert.ok(rendered.local);
    assert.deepEqual({
      tileRequests: rendered.local.counters.tileRequests,
      tileRasterizations: rendered.local.counters.tileRasterizations,
      placementRequests: rendered.local.counters.placementRequests,
      placementRasterizations: rendered.local.counters.placementRasterizations,
      transformExecutions: rendered.local.counters.transformExecutions,
      ownerOpacitySkips: rendered.local.counters.ownerOpacitySkips,
    }, {
      tileRequests: 0,
      tileRasterizations: 0,
      placementRequests: 0,
      placementRasterizations: 0,
      transformExecutions: 0,
      ownerOpacitySkips: 1,
    });
    assert.deepEqual(rendered.local.tiles, []);
    assert.deepEqual(rendered.local.placements, []);
    assert.equal(rendered.local.skips.length, 1);
    assert.deepEqual({ kind: rendered.local.skips[0]?.kind, reason: rendered.local.skips[0]?.reason }, {
      kind: "owner-opacity", reason: "opacity-zero",
    });
    assert.equal(rendered.local.skips[0]?.ownerNodeId, node(ir, "cut.kernel.fragment").id);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("placement, child finish, scene, audio, and formatting identities remain correctly localized", { timeout: 120_000 }, async () => {
  const root = await generatedFixture("editorial");
  try {
    const source = componentProgram(neutralControls), placementSource = componentProgram({ ...neutralControls, x: "2" });
    const finishSource = componentProgram({ ...neutralControls, seed: "9" });
    const before = await locked(root, source), placementEdit = await locked(root, placementSource), finishEdit = await locked(root, finishSource);

    const beforeFrame = onePlacement((await renderScene(before, root)).local);
    const placementFrame = onePlacement((await renderScene(placementEdit, root)).local);
    const finishFrame = onePlacement((await renderScene(finishEdit, root)).local);
    assert.equal(beforeFrame.tile.tileIdentity, placementFrame.tile.tileIdentity);
    assert.notEqual(beforeFrame.placement.placementIdentity, placementFrame.placement.placementIdentity);
    assert.equal(beforeFrame.placement.contextIdentity, placementFrame.placement.contextIdentity, "sampled transforms belong to placement identity without over-invalidating the stable owner context");
    assert.notEqual(beforeFrame.tile.tileIdentity, finishFrame.tile.tileIdentity);
    assert.equal(beforeFrame.placement.contextIdentity, finishFrame.placement.contextIdentity, "a child-only finish edit must not leak into the parent placement context");
    assert.deepEqual(beforeFrame.placement.transform, finishFrame.placement.transform);
    assert.notEqual(beforeFrame.placement.placementIdentity, finishFrame.placement.placementIdentity, "the child tile identity remains a placement input");

    const previous = createIncrementalRenderPlan(before, "main").manifest;
    const placementPlan = createIncrementalRenderPlan(placementEdit, "main", previous);
    const finishPlan = createIncrementalRenderPlan(finishEdit, "main", previous);
    const sceneStatus = (ir: CutAVIR, plan: ReturnType<typeof createIncrementalRenderPlan>, name: string) => {
      const id = Object.values(ir.scenes).find((candidate) => candidate.name === name)?.id;
      assert.ok(id); return plan.scenes.find((candidate) => candidate.id === id)?.status;
    };
    assert.equal(sceneStatus(placementEdit, placementPlan, "feature"), "miss");
    assert.equal(sceneStatus(placementEdit, placementPlan, "tail"), "hit");
    assert.equal(sceneStatus(finishEdit, finishPlan, "feature"), "miss");
    assert.equal(sceneStatus(finishEdit, finishPlan, "tail"), "hit");
    const placementLocal = node(placementEdit, "cut.visual.local_space");
    const finishLocal = node(finishEdit, "cut.visual.local_space");
    assert.equal(placementPlan.nodes.find((candidate) => candidate.id === placementLocal.id)?.status, "hit");
    assert.equal(finishPlan.nodes.find((candidate) => candidate.id === finishLocal.id)?.status, "miss");
    assert.ok(placementPlan.nodes.filter((candidate) => placementEdit.nodes[candidate.id]?.domain === "audio").every((candidate) => candidate.status === "hit"));
    assert.ok(finishPlan.nodes.filter((candidate) => finishEdit.nodes[candidate.id]?.domain === "audio").every((candidate) => candidate.status === "hit"));

    const respelledSource = source
      .replace("cut 0.4;", "// formatting-only module header\ncut 0.4; // same language")
      .replace("component FinishedPlate", "// reusable locked plate\ncomponent   FinishedPlate")
      .replace("timeline main", "// unchanged edit\ntimeline   main");
    const respelled = await locked(root, respelledSource);
    assert.notEqual(respelled.sourceHash, before.sourceHash);
    assert.equal(respelled.buildId, before.buildId);
    assert.deepEqual(diffCutAVIR(before, respelled).changes, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("animated component placement consumes one exact aggregate-preflight plan per frame while retaining its local tile", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-component-dynamic-"));
  try {
    const ir = compile(animatedComponentProgram());
    assert.deepEqual(validateReferenceStaticVisualGraphs(ir), []);
    const start = await renderScene(ir, root, "feature", 0), middle = await renderScene(ir, root, "feature", 2);
    const staticMiddleIr = compile(animatedComponentProgram()
      .replace("animate plate.x from 0px to 4px over 1s ease linear;", "set plate.x = 2px;")
      .replace("animate plate.rotation from 0deg to 90deg over 1s ease linear;", "set plate.rotation = 45deg;")
      .replace("animate plate.scale from 1 to 2 over 1s ease linear;", "set plate.scale = 1.5;"));
    const staticMiddle = await renderScene(staticMiddleIr, root, "feature", 2);
    const startPlacement = onePlacement(start.local), middlePlacement = onePlacement(middle.local);
    const staticMiddlePlacement = onePlacement(staticMiddle.local);
    assert.notEqual(startPlacement.tile.tileIdentity, middlePlacement.tile.tileIdentity, "exact frame time remains a local-tile identity input");
    assert.equal(middlePlacement.tile.tileIdentity, staticMiddlePlacement.tile.tileIdentity, "owner animation does not leak into the same-time retained tile");
    assert.notEqual(startPlacement.placement.placementIdentity, middlePlacement.placement.placementIdentity);
    assert.equal(middlePlacement.placement.placementIdentity, staticMiddlePlacement.placement.placementIdentity);
    assert.notEqual(sha256(start.surface.data), sha256(middle.surface.data));
    assert.equal(sha256(middle.surface.data), sha256(staticMiddle.surface.data));
    assert.equal(start.componentPreflight?.plans.length, 1);
    assert.equal(middle.componentPreflight?.plans.length, 1);
    assert.equal(start.componentPreflight?.aggregate?.transformCount, 1);
    assert.equal(middle.componentPreflight?.aggregate?.transformCount, 1);
    assert.deepEqual(middle.componentPreflight?.plans[0]?.plan.exactTime, rational(1, 2));
    assert.deepEqual(middle.componentPreflight?.plans[0]?.plan.placement, {
      owner: "component-fragment",
      contextIdentity: middlePlacement.placement.contextIdentity,
      destinationX: middlePlacement.placement.transform?.destinationX,
      destinationY: middlePlacement.placement.transform?.destinationY,
      registrationRasterX: middlePlacement.placement.transform?.registrationRasterX,
      registrationRasterY: middlePlacement.placement.transform?.registrationRasterY,
      scale: middlePlacement.placement.transform?.scale,
      skewX: middlePlacement.placement.transform?.skewX,
      skewY: middlePlacement.placement.transform?.skewY,
      rotation: middlePlacement.placement.transform?.rotation,
      opacity: middlePlacement.placement.transform?.opacity,
    });
    assert.notEqual(start.componentPreflight?.preflightIdentity, middle.componentPreflight?.preflightIdentity);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("composition affine preflight aggregates every MotionBlur shutter sample before retained pixels", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-local-space-shutter-aggregate-"));
  try {
    const ir = compile(`cut 0.4;
project "motion-blurred retained affine aggregate";
import { Camera2D, LocalSpace, MotionBlur, Rect } from "cut:visual";
timeline main(duration: 1s, fps: 4, width: 40px, height: 30px, sampleRate: 8khz) {
  scene feature(duration: 1s) {
    MotionBlur(shutterAngle: 360deg, samples: 4, startEdge: "hold") {
      Camera2D(x: 4px, rotation: 17deg) {
        LocalSpace(width: 12px, height: 8px, origin: { x: 2px, y: 6px }) {
          Rect(width: 3px, height: 3px, x: 5px, y: 1px, fill: #ef233c);
        }
      }
    }
  }
}
export out = render(main, codec: "h264");`);
    assert.deepEqual(validateReferenceStaticVisualGraphs(ir), []);
    const rendered = await renderScene(ir, root, "feature", 2);
    const preflight = rendered.compositionPreflight;
    assert.ok(preflight);
    assert.deepEqual(preflight.exactTime, rational(1, 2));
    assert.equal(preflight.aggregate?.transformCount, 4);
    assert.equal(preflight.admissions.length, 4);
    assert.equal(new Set(preflight.admissions.map((entry) => `${entry.sampleTime.numerator}/${entry.sampleTime.denominator}`)).size, 4);
    assert.ok(preflight.admissions.every((entry) => entry.ownerKind === "camera-2d"));
    assert.equal(rendered.local?.counters.placementRequests, 4);
    assert.equal(rendered.local?.counters.transformExecutions, 4);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("affine skip evidence consumes every MotionBlur shutter sample exactly once in linear reconciliation", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-local-space-shutter-skip-closure-"));
  const ir = compile(`cut 0.4;
project "motion-blurred retained affine skip closure";
import { Camera2D, LocalSpace, MotionBlur, Rect } from "cut:visual";
timeline main(duration: 1s, fps: 4, width: 40px, height: 30px, sampleRate: 8khz) {
  scene feature(duration: 1s) {
    MotionBlur(shutterAngle: 360deg, samples: 4, startEdge: "hold") {
      Camera2D(opacity: 0%) {
        LocalSpace(width: 12px, height: 8px, origin: { x: 2px, y: 6px }) {
          Rect(width: 3px, height: 3px, x: 5px, y: 1px, fill: #ef233c);
        }
      }
    }
  }
}
export out = render(main, codec: "h264");`);
  const { composition } = validateReferenceSession(ir, "out"), scene = Object.values(ir.scenes)[0]!;
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut", "shutter-skip-cache"));
  try {
    await renderer.prepare();
    await renderer.sceneFrame(scene, 2, false);
    const receipt = renderer.referenceLocalSpaceRendererFrameExecutionEvidence()[0]!;
    assert.equal(receipt.preflight.skips.length, 4);
    assert.equal(receipt.execution.skips.length, 4);
    assert.equal(new Set(receipt.execution.skips.map((skip) =>
      `${skip.sampleTime?.numerator}/${skip.sampleTime?.denominator}`)).size, 4);

    const forgedExecution = referenceLocalSpaceFrameEvidence({
      compositionId: receipt.execution.compositionId,
      exactTime: receipt.execution.exactTime,
      outputFrame: receipt.execution.outputFrame,
      backendIdentity: receipt.execution.backendIdentity,
      counters: Object.freeze({ ...receipt.execution.counters, ownerOpacitySkips: 1 }),
      tiles: receipt.execution.tiles,
      placements: receipt.execution.placements,
      skips: Object.freeze([receipt.execution.skips[0]!]),
    });
    const forged = referenceLocalSpaceRendererFrameExecutionEvidence({
      executionPath: receipt.executionPath,
      execution: forgedExecution,
      preflight: receipt.preflight,
    });
    assert.throws(() => validateReferenceLocalSpaceRendererFrameExecutionSemantics(
      forged,
      Object.freeze({ authority: "locked-ir-and-live-frame-execution" as const, expected: forged }),
      { ir, rootCompositionId: composition.id },
    ), (error: unknown) => error instanceof ReferenceLocalSpaceFrameEvidenceError
      && /one-to-one executed owner skip at the same exact sample time/u.test(error.message));
  } finally {
    await renderer.closeAndWait();
    await rm(root, { recursive: true, force: true });
  }
});

test("composition affine preflight combines root, nested parent-local, Group, and Camera2D destinations", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-local-space-mixed-affine-"));
  try {
    const ir = compile(`cut 0.4;
project "mixed affine retained aggregate";
import { Camera2D, Group, LocalSpace, Rect } from "cut:visual";
timeline main(duration: 1s, fps: 4, width: 40px, height: 30px, sampleRate: 8khz) {
  scene feature(duration: 1s) {
    LocalSpace(width: 10px, height: 8px, origin: { x: 5px, y: 4px }) {
      LocalSpace(width: 4px, height: 3px, origin: { x: 2px, y: 1px }) {
        Rect(width: 2px, height: 2px, fill: #ef233c);
      }
    }
    Group(x: -8px, skewX: 11deg) {
      LocalSpace(width: 6px, height: 4px, origin: { x: 3px, y: 2px }) {
        Rect(width: 2px, height: 2px, fill: #33aa77);
      }
    }
    Camera2D(x: 8px, rotation: 9deg) {
      LocalSpace(width: 5px, height: 5px, origin: { x: 2px, y: 2px }) {
        Rect(width: 2px, height: 2px, fill: #4c78ff);
      }
    }
  }
}
export out = render(main, codec: "h264");`);
    assert.deepEqual(validateReferenceStaticVisualGraphs(ir), []);
    const rendered = await renderScene(ir, root, "feature", 0), preflight = rendered.compositionPreflight;
    assert.ok(preflight);
    assert.equal(preflight.aggregate?.transformCount, 4);
    assert.deepEqual(preflight.admissions.map((entry) => entry.ownerKind).sort(), [
      "camera-2d",
      "group",
      "local-space",
      "scene-root",
    ]);
    const nested = preflight.admissions.find((entry) => entry.ownerKind === "local-space");
    assert.ok(nested);
    assert.deepEqual(nested.work.compositionLiveOutput, { surfaces: 1, pixels: 80, rgba8Bytes: 320 });
    const skewed = preflight.admissions.find((entry) => entry.ownerKind === "group");
    assert.equal(skewed?.work.version, 3);
    assert.equal(rendered.local?.placements.length, 4);
    assert.equal(rendered.local?.counters.transformExecutions, 4);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("component aggregate preflight rejects transform-count and live-output overflow before any retained tile", { timeout: 90_000 }, async () => {
  const cases = [
    { label: "257 transforms", source: manyComponentProgram(257), pattern: /composition transform count exceeds 256/u },
    { label: "live output bytes", source: manyComponentProgram(17, { width: 4096, height: 4096 }), pattern: /composition-live outputs require 1140850688 bytes/u },
  ] as const;
  for (const candidate of cases) {
    const root = await mkdtemp(resolve(tmpdir(), "cut-component-aggregate-refusal-"));
    const ir = compile(candidate.source), diagnostics = validateReferenceStaticVisualGraphs(ir);
    try {
      const diagnostic = diagnostics.find((item) => item.code === "CUT_LOCAL_SPACE_TRANSFORM_AGGREGATE");
      assert.ok(diagnostic, `${candidate.label}: ${JSON.stringify(diagnostics)}`);
      assert.match(diagnostic.message, candidate.pattern);
      const { composition } = validateReferenceSession(ir, "out"), scene = Object.values(ir.scenes)[0]!;
      const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut", "aggregate-refusal"));
      const instrumented = renderer as unknown as { localSpaceTile: (...args: unknown[]) => Promise<unknown> };
      const original = instrumented.localSpaceTile.bind(renderer);
      let tileRequests = 0;
      instrumented.localSpaceTile = (...args: unknown[]) => { tileRequests += 1; return original(...args); };
      try {
        await renderer.prepare();
        await assert.rejects(() => renderer.sceneFrame(scene, 0, false), candidate.pattern);
        assert.equal(tileRequests, 0, candidate.label);
        assert.equal(renderer.referenceLocalSpaceEvidence(), undefined);
        assert.equal(renderer.referenceComponentFragmentLocalSpacePreflightEvidence(), undefined);
      } finally { await renderer.closeAndWait(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("static component sweep samples a lower-count heavier overlap instead of only maximum owner count", () => {
  const ir = compile(weightedStaggerComponentProgram());
  const visit = (id: string, interval: IRNode["interval"]) => {
    const current = ir.nodes[id];
    assert.ok(current);
    current.interval = Object.freeze({ start: Object.freeze({ ...interval.start }), duration: Object.freeze({ ...interval.duration }) });
    for (const childId of current.children) visit(childId, interval);
  };
  for (const fragment of Object.values(ir.nodes).filter((candidate) => candidate.op === "cut.kernel.fragment")) {
    const local = ir.nodes[fragment.children[0]!]!, width = local.inputs.width;
    assert.equal(width?.kind, "quantity");
    const heavy = width?.kind === "quantity" && width.magnitude.numerator === "1600";
    visit(fragment.id, heavy
      ? { start: rational(1, 2), duration: rational(1, 2) }
      : { start: rational(0), duration: rational(1, 2) });
  }
  const diagnostics = validateReferenceStaticVisualGraphs(ir);
  const failure = diagnostics.find((candidate) => candidate.code === "CUT_LOCAL_SPACE_TRANSFORM_AGGREGATE");
  assert.ok(failure, JSON.stringify(diagnostics));
  assert.match(failure.message, /unscheduled transform peaks total 2166439480 bytes/u);
  assert.doesNotMatch(failure.message, /transform count exceeds/u);
});

test("opacity-zero components consume no aggregate transform capacity or tile work", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-component-opacity-aggregate-"));
  try {
    const ir = compile(manyComponentProgram(257, { opacityZero: true }));
    assert.deepEqual(validateReferenceStaticVisualGraphs(ir), []);
    const rendered = await renderScene(ir, root);
    assert.ok(rendered.surface.data.every((byte) => byte === 0));
    assert.equal(rendered.componentPreflight?.plans.length, 257);
    assert.equal(rendered.componentPreflight?.aggregate, undefined);
    assert.equal(rendered.local?.tiles.length, 0);
    assert.equal(rendered.local?.placements.length, 0);
    assert.equal(rendered.local?.counters.ownerOpacitySkips, 257);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a later invalid animated component sample fails pre-raster and preserves the previous completed receipts", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-component-late-preflight-refusal-"));
  const ir = compile(animatedComponentProgram("8", 3000, 1)), { composition } = validateReferenceSession(ir, "out");
  const scene = Object.values(ir.scenes)[0]!;
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut", "late-refusal"));
  const instrumented = renderer as unknown as { localSpaceTile: (...args: unknown[]) => Promise<unknown> };
  const original = instrumented.localSpaceTile.bind(renderer);
  let tileRequests = 0;
  instrumented.localSpaceTile = (...args: unknown[]) => { tileRequests += 1; return original(...args); };
  try {
    await renderer.prepare();
    await renderer.sceneFrame(scene, 0, false);
    const completedLocal = renderer.referenceLocalSpaceEvidence(), completedPreflight = renderer.referenceComponentFragmentLocalSpacePreflightEvidence();
    const completedCompositionPreflight = renderer.referenceLocalSpaceCompositionTransformPreflightEvidence();
    assert.ok(completedLocal && completedPreflight && completedCompositionPreflight);
    tileRequests = 0;
    await assert.rejects(() => renderer.sceneFrame(scene, 3, false), /CUT_LOCAL_SPACE_TRANSFORM_LIMIT/u);
    assert.equal(tileRequests, 0);
    assert.equal(renderer.referenceLocalSpaceEvidence()?.executionIdentity, completedLocal.executionIdentity);
    assert.equal(renderer.referenceComponentFragmentLocalSpacePreflightEvidence()?.preflightIdentity, completedPreflight.preflightIdentity);
    assert.equal(renderer.referenceLocalSpaceCompositionTransformPreflightEvidence()?.preflightIdentity, completedCompositionPreflight.preflightIdentity);
  } finally {
    await renderer.closeAndWait();
    await rm(root, { recursive: true, force: true });
  }
});

test("indexed component admission performs no graph rescans after its one linear construction", () => {
  const ir = compile(rectComponentProgram()), fragment = hostileFragment(ir), local = hostileLocal(ir), composition = ir.compositions[0]!;
  const selected = new Set(Object.keys(ir.nodes));
  const index = createReferenceComponentFragmentLocalSpaceAdmissionIndex(ir);
  const structural = createReferenceLocalSpaceStructuralValidationIndex(ir);
  assert.deepEqual(Object.keys(index).sort(), [
    "compositionIdsForScene",
    "compositionRootIdsForNode",
    "parentIdsForChild",
    "sceneMembershipsForNode",
  ]);
  assert.equal((index as unknown as { set?: unknown }).set, undefined);
  assert.equal((index.parentIdsForChild as unknown as { set?: unknown }).set, undefined);
  assert.equal((structural as unknown as { set?: unknown }).set, undefined);
  assert.ok(Object.isFrozen(index.parentIdsForChild(local.id)));
  assert.ok(Object.isFrozen(structural.parentNodesForChild(local.id)));
  assert.throws(() => (index.parentIdsForChild(local.id) as string[]).push("hostile-parent"), TypeError);
  const poison = () => { throw new Error("unexpected post-index graph scan"); };
  ir.nodes = new Proxy(ir.nodes, { ownKeys: poison });
  ir.scenes = new Proxy(ir.scenes, { ownKeys: poison });
  ir.compositions = new Proxy(ir.compositions, { ownKeys: poison });
  assert.equal(referenceComponentFragmentLocalSpaceAdmissionIssue(index, fragment, local, composition), undefined);
  assert.equal(validateReferenceLocalSpaceGraph(ir, composition, selected, { structuralIndex: structural }).get(local.id)?.owner, "component-fragment");
});

test("general affine preflight closes its public record, exact-time uniqueness, skips, and derived work", () => {
  const ir = compile(rectComponentProgram()), composition = ir.compositions[0]!, fragment = hostileFragment(ir), localNode = hostileLocal(ir);
  const localSpace = validateReferenceLocalSpaceGraph(ir, composition).get(localNode.id);
  assert.ok(localSpace && fragment.sceneId);
  const visible = Object.freeze({
    owner: fragment,
    localSpace,
    ownerKind: "component-fragment" as const,
    exactTime: rational(0),
    status: "visible" as const,
    transform: Object.freeze({
      source: Object.freeze({ width: localSpace.width, height: localSpace.height }),
      destination: Object.freeze({ width: composition.width, height: composition.height }),
      scale: 1,
      skewX: 0,
      skewY: 0,
      rotation: 0,
      opacity: 1,
    }),
  });
  const context = Object.freeze({ sceneId: fragment.sceneId, exactTime: rational(0), outputFrame: "0" });
  const one = referenceLocalSpaceCompositionTransformPreflight(ir, composition, context, [visible]);
  assert.equal(one.status, "admitted");
  assert.equal(one.admissions.length, 1);
  assert.equal(one.aggregate?.transformCount, 1);
  assert.equal(one.admissions[0]?.work.version, 2, "zero-skew public admission must preserve V2 identity");
  for (const [label, exactTime, pattern] of [
    ["negative zero", { numerator: "-0", denominator: "1" }, /canonical exact rational/u],
    ["unreduced", { numerator: "2", denominator: "4" }, /lowest terms/u],
    ["oversized", { numerator: "1".repeat(257), denominator: "1" }, /256-digit exact-rational budget/u],
  ] as const) {
    assert.throws(
      () => referenceLocalSpaceCompositionTransformPreflight(ir, composition, { ...context, exactTime }, [visible]),
      pattern,
      label,
    );
  }
  for (const outputFrame of ["00", "1".repeat(257)]) {
    assert.throws(
      () => referenceLocalSpaceCompositionTransformPreflight(ir, composition, { ...context, outputFrame }, [visible]),
      /canonical nonnegative integer within 256 digits/u,
    );
  }
  assert.throws(
    () => referenceLocalSpaceCompositionTransformPreflight(ir, composition, { ...context, exactTime: rational(1) }, [visible]),
    /half-open local duration/u,
  );
  assert.throws(
    () => referenceLocalSpaceCompositionTransformPreflight(ir, composition, context, [visible, visible]),
    /duplicates owner\/LocalSpace pair/u,
  );
  const secondTime = Object.freeze({ ...visible, exactTime: rational(1, 4) });
  const shutterLike = referenceLocalSpaceCompositionTransformPreflight(ir, composition, context, [visible, secondTime]);
  assert.equal(shutterLike.aggregate?.transformCount, 2);
  assert.deepEqual(shutterLike.admissions.map((entry) => entry.sampleTime), [rational(0), rational(1, 4)]);
  assert.throws(
    () => referenceLocalSpaceCompositionTransformPreflight(ir, composition, context, [{
      ...visible,
      planIdentity: "forged-small-work",
    } as unknown as typeof visible]),
    /does not accept property "planIdentity"/u,
  );
  assert.throws(
    () => referenceLocalSpaceCompositionTransformPreflight(ir, composition, context, [{
      owner: fragment,
      localSpace,
      ownerKind: "component-fragment",
      exactTime: rational(0),
      status: "policy-hidden",
    }]),
    /only Track2D may claim a policy-hidden/u,
  );
  const skipped = referenceLocalSpaceCompositionTransformPreflight(ir, composition, context, [{
    owner: fragment,
    localSpace,
    ownerKind: "component-fragment",
    exactTime: rational(0),
    status: "opacity-zero",
  }]);
  assert.equal(skipped.status, "zero-visible-affine-placements");
  assert.equal(skipped.aggregate, undefined);
  assert.equal(skipped.skips[0]?.status, "opacity-zero");
  assert.throws(
    () => referenceLocalSpaceCompositionTransformPreflight(
      ir,
      composition,
      context,
      Array(referenceLocalSpaceTransformWorkLimits.maximumCompositionPreflightEntries + 1).fill(skipped) as never,
    ),
    /entry count 100001 exceeds 100000/u,
  );
});

test("transitive MotionPath policy skips authenticate their exact anchored Track2D cause", () => {
  const ir = compile(anchoredMotionPolicyProgram()), composition = ir.compositions[0]!;
  const motion = node(ir, "cut.visual.motion_path"), track = node(ir, "cut.visual.track_2d");
  const localSpaces = validateReferenceLocalSpaceGraph(ir, composition);
  const motionLocal = [...localSpaces.values()].find((candidate) => candidate.owner === "motion-path" && candidate.ownerNodeId === motion.id);
  const trackLocal = [...localSpaces.values()].find((candidate) => candidate.owner === "track-2d" && candidate.ownerNodeId === track.id);
  assert.ok(motion.sceneId && motionLocal && trackLocal);
  const exactTime = rational(0);
  const geometry = decodeReferenceAnchoredPathGeometry(motion, motion.inputs.geometry, "input \u201cgeometry\u201d");
  const executionIdentity = referenceAnchoredPathPolicyHiddenExecutionIdentity(
    geometry.semanticIdentity,
    exactTime,
    [{ ownerNodeId: track.id, ownerKind: "track-2d", localSpaceNodeId: trackLocal.nodeId }],
  );
  const context = Object.freeze({ sceneId: motion.sceneId, exactTime, outputFrame: "0" });
  const entry = Object.freeze({
    owner: motion,
    localSpace: motionLocal,
    ownerKind: "motion-path" as const,
    exactTime,
    status: "policy-hidden" as const,
    policyHiddenBy: Object.freeze({
      kind: "anchored-path-owner-policy" as const,
      executionIdentity,
      trackOwnerNodeIds: Object.freeze([track.id]),
    }),
  });
  const admitted = referenceLocalSpaceCompositionTransformPreflight(ir, composition, context, [entry]);
  assert.equal(admitted.status, "zero-visible-affine-placements");
  assert.deepEqual(admitted.skips[0]?.policyHiddenBy, entry.policyHiddenBy);

  assert.throws(
    () => referenceLocalSpaceCompositionTransformPreflight(ir, composition, context, [{ ...entry, policyHiddenBy: undefined }]),
    /requires one canonical anchored-path Track2D suppression cause/u,
  );
  assert.throws(
    () => referenceLocalSpaceCompositionTransformPreflight(ir, composition, context, [{
      ...entry,
      policyHiddenBy: { ...entry.policyHiddenBy, executionIdentity: "a".repeat(64) },
    }]),
    /unauthenticated anchored-path execution identity/u,
  );
  assert.throws(
    () => referenceLocalSpaceCompositionTransformPreflight(ir, composition, context, [{
      ...entry,
      policyHiddenBy: { ...entry.policyHiddenBy, ignored: true },
    } as unknown as typeof entry]),
    /does not accept property "ignored"/u,
  );
  const unrelated = structuredClone(track);
  unrelated.id = "unrelated-track-cause";
  ir.nodes[unrelated.id] = unrelated;
  assert.throws(
    () => referenceLocalSpaceCompositionTransformPreflight(ir, composition, context, [{
      ...entry,
      policyHiddenBy: {
        ...entry.policyHiddenBy,
        trackOwnerNodeIds: [unrelated.id],
      },
    }]),
    /is not referenced by its anchored geometry/u,
  );
});

test("public source rejects composition-root, nested-owner, sibling, and unknown fragment-property forms at authored spans", () => {
  const component = `component Tile() -> Visual { ${plateBodyWithoutMedia()} }`;
  const prefix = `cut 0.4; project "component owner source refusals"; import { Group, LocalSpace, Rect } from "cut:visual"; ${component}`;
  const programs = [
    `${prefix} timeline main(duration: 1s, fps: 4, width: 20px, height: 16px) { Tile(); } export out = render(main);`,
    `${prefix} component Outer() -> Visual { Tile(); } timeline main(duration: 1s, fps: 4, width: 20px, height: 16px) { scene only(duration: 1s) { Outer(); } } export out = render(main);`,
    `${prefix} timeline main(duration: 1s, fps: 4, width: 20px, height: 16px) { scene only(duration: 1s) { Group() { Tile(); } } } export out = render(main);`,
    `cut 0.4; project "component sibling refusal"; import { LocalSpace, Rect } from "cut:visual"; component Tile() -> Visual { ${plateBodyWithoutMedia()} Rect(width: 1px, height: 1px); } timeline main(duration: 1s, fps: 4, width: 20px, height: 16px) { scene only(duration: 1s) { Tile(); } } export out = render(main);`,
  ];
  for (const source of programs) {
    const ir = compile(source), diagnostics = validateReferenceStaticVisualGraphs(ir);
    const failure = diagnostics.find((candidate) => candidate.code === "CUT_LOCAL_SPACE_UNSUPPORTED" || candidate.code === "CUT_LOCAL_SPACE_GRAPH");
    assert.ok(failure, JSON.stringify(diagnostics));
    assert.ok(failure.span.start.line > 0 && failure.span.start.column > 0);
  }

  const unknown = `${prefix} timeline main(duration: 1s, fps: 4, width: 20px, height: 16px) { scene only(duration: 1s) { Tile() as plate; set plate.skewX = 1px; } } export out = render(main);`;
  const checked = checkCutModule(parse(unknown));
  const diagnostic = checked.diagnostics.find((candidate) => candidate.code === "CUT2060");
  assert.ok(diagnostic, JSON.stringify(checked.diagnostics));
  assert.match(diagnostic.message, /skewX/u);
  assert.ok(diagnostic.span.start.line > 0 && diagnostic.span.start.column > 0);
});

function hostileClone() {
  return structuredClone(compile(rectComponentProgram()));
}

function hostileFragment(ir: CutAVIR) { return node(ir, "cut.kernel.fragment"); }
function hostileLocal(ir: CutAVIR) { return node(ir, "cut.visual.local_space"); }

function assertHostileRejected(
  label: string,
  mutate: (ir: CutAVIR, fragment: IRNode, local: IRNode) => void,
  expectedLoaderCodes: readonly CutAvIrValidationError["code"][],
) {
  const ir = hostileClone(), fragment = hostileFragment(ir), local = hostileLocal(ir);
  mutate(ir, fragment, local);
  finalizeGraphHashes(ir);
  assert.throws(() => loadCutAvIr(JSON.stringify(ir)), (error: unknown) => {
    assert.ok(error instanceof CutAvIrValidationError, `${label}: ${String(error)}`);
    assert.ok(expectedLoaderCodes.includes(error.code), `${label}: unexpected ${error.code} at ${error.path}`);
    assert.ok(error.path.includes("nodes") || error.path.includes("scenes") || error.path.includes("compositions"), `${label}: ${error.path}`);
    return true;
  });
  assert.throws(() => validateReferenceLocalSpaceGraph(ir, ir.compositions[0]!), (error: unknown) => {
    assert.ok(error instanceof ReferenceLocalSpaceError, `${label}: ${String(error)}`);
    assert.ok(error.source.line > 0 && error.source.column > 0, label);
    return true;
  });
}

test("strict loader and runtime reject every forged component-fragment owner boundary before pixels", () => {
  const booleanValue: IRValue = { kind: "boolean", value: true };
  const lengthValue: IRValue = { kind: "quantity", dimension: "length", magnitude: rational(1), unit: "px" };

  assertHostileRejected("fragment inputs", (_ir, fragment) => { fragment.inputs.hidden = booleanValue; }, ["CUT_IR_UNKNOWN_FIELD", "CUT_IR_IDENTITY"]);
  assertHostileRejected("unknown fragment property", (_ir, fragment) => { fragment.properties.skewX = lengthValue; }, ["CUT_IR_UNKNOWN_FIELD", "CUT_IR_IDENTITY"]);
  assertHostileRejected("non-pure fragment", (_ir, fragment) => { fragment.effects = ["read"]; }, ["CUT_IR_UNKNOWN_FIELD", "CUT_IR_IDENTITY"]);
  assertHostileRejected("zero children", (_ir, fragment) => { fragment.children = []; }, ["CUT_IR_IDENTITY", "CUT_IR_UNKNOWN_FIELD"]);
  assertHostileRejected("two children", (ir, fragment, local) => {
    const sibling = structuredClone(ir.nodes[local.children[0]!]!);
    sibling.id = "hostile-component-sibling";
    sibling.provenance = { ...sibling.provenance, symbol: "hostile-component-sibling" };
    ir.nodes[sibling.id] = sibling;
    fragment.children.push(sibling.id);
  }, ["CUT_IR_IDENTITY", "CUT_IR_UNKNOWN_FIELD", "CUT_IR_TYPE"]);
  assertHostileRejected("unequal interval", (_ir, _fragment, local) => {
    local.interval = { start: rational(0), duration: rational(1, 2) };
  }, ["CUT_IR_TIMING"]);
  assertHostileRejected("child also root", (ir, _fragment, local) => {
    const scene = ir.scenes[local.sceneId!]!;
    scene.rootVisualIds.push(local.id);
    scene.items.push({ id: local.id, domain: "visual" });
  }, ["CUT_IR_IDENTITY"]);
  assertHostileRejected("duplicate parent", (ir, fragment, local) => {
    const duplicate = structuredClone(fragment);
    duplicate.id = "hostile-duplicate-fragment-parent";
    duplicate.provenance = { ...duplicate.provenance, symbol: "hostile-duplicate-fragment-parent" };
    duplicate.children = [local.id];
    ir.nodes[duplicate.id] = duplicate;
    const scene = ir.scenes[fragment.sceneId!]!;
    scene.rootVisualIds.push(duplicate.id);
    scene.items.push({ id: duplicate.id, domain: "visual" });
  }, ["CUT_IR_IDENTITY"]);
  assertHostileRejected("nested fragment", (ir, fragment, local) => {
    const inner = structuredClone(fragment);
    inner.id = "hostile-nested-fragment";
    inner.ownership = "child";
    inner.provenance = { ...inner.provenance, symbol: "hostile-nested-fragment" };
    inner.children = [local.id];
    ir.nodes[inner.id] = inner;
    fragment.children = [inner.id];
  }, ["CUT_IR_UNKNOWN_FIELD", "CUT_IR_IDENTITY"]);
  for (const domain of ["audio", "av"] as const) {
    assertHostileRejected(`${domain} fragment`, (ir, fragment) => {
      const scene = ir.scenes[fragment.sceneId!]!;
      scene.rootVisualIds = scene.rootVisualIds.filter((id) => id !== fragment.id);
      if (domain === "audio") scene.rootAudioIds.push(fragment.id);
      else scene.rootAVIds.push(fragment.id);
      scene.items = scene.items.map((item) => item.id === fragment.id ? { ...item, domain } : item);
      fragment.domain = domain;
    }, ["CUT_IR_TYPE", "CUT_IR_IDENTITY", "CUT_IR_UNKNOWN_FIELD"]);
  }
});

test("frame-v2 schema requires the closed component-fragment owner plus transform and transform-work proof", { timeout: 90_000 }, async () => {
  const root = await generatedFixture("product");
  try {
    const ir = await locked(root, componentProgram(directedControls, "product", "component frame schema"));
    const output = resolve(root, "review", "component.png");
    const report = await renderReferenceFrameArtifact(ir, root, output, { frame: 0, mediaProfile: "master" });
    assert.equal(report.execution.localSpaces.length, 1);
    const receipt = report.execution.localSpaces[0]!, placement = receipt.placements[0]!;
    assert.equal(placement.owner, "component-fragment");
    assert.ok(placement.transform);
    assert.ok(placement.transformWork);
    assert.equal(report.execution.localSpaceTransformPreflight.status, "admitted");
    assert.equal(report.execution.localSpaceTransformPreflight.outputFrame, "0");
    assert.equal(report.execution.localSpaceTransformPreflight.admissions.length, 1);
    assert.equal(report.execution.localSpaceTransformPreflight.admissions[0]?.ownerKind, "component-fragment");
    assert.equal(report.execution.localSpaceTransformPreflight.aggregate?.transformCount, 1);

    const persisted = JSON.parse(await readFile(`${output}.manifest.json`, "utf8"));
    const schema = JSON.parse(await readFile(resolve("schemas/cut-reference-frame-v2.schema.json"), "utf8"));
    const validate = new Ajv({ schemaId: "auto", meta: false, validateSchema: false, allErrors: true, jsonPointers: true }).compile(schema);
    assert.equal(validate(persisted), true, JSON.stringify(validate.errors));

    const missingAggregateReceipt = structuredClone(persisted);
    delete missingAggregateReceipt.execution.localSpaceTransformPreflight;
    assert.equal(validate(missingAggregateReceipt), false, "component placement evidence requires its same-frame composition admission receipt");
    const forgedAggregateReceipt = structuredClone(persisted);
    forgedAggregateReceipt.execution.localSpaceTransformPreflight.silentlyIgnored = true;
    assert.equal(validate(forgedAggregateReceipt), false, "component aggregate evidence must remain closed");
    const falseZeroVisibleReceipt = structuredClone(persisted);
    falseZeroVisibleReceipt.execution.localSpaceTransformPreflight = {
      ...falseZeroVisibleReceipt.execution.localSpaceTransformPreflight,
      status: "zero-visible-affine-placements",
      admissions: [],
      skips: [],
    };
    delete falseZeroVisibleReceipt.execution.localSpaceTransformPreflight.aggregate;
    assert.equal(validate(falseZeroVisibleReceipt), false, "a visible component placement cannot be certified by an empty preflight");
    const missingComponentAdmission = structuredClone(persisted);
    missingComponentAdmission.execution.localSpaceTransformPreflight.admissions[0].ownerKind = "group";
    assert.equal(validate(missingComponentAdmission), false, "a visible component placement requires a component-fragment admission");

    const unknownOwner = structuredClone(persisted);
    unknownOwner.execution.localSpaces[0].placements[0].owner = "future-fragment-owner";
    assert.equal(validate(unknownOwner), false);
    const missingTransform = structuredClone(persisted);
    delete missingTransform.execution.localSpaces[0].placements[0].transform;
    assert.equal(validate(missingTransform), false);
    const missingWork = structuredClone(persisted);
    delete missingWork.execution.localSpaces[0].placements[0].transformWork;
    assert.equal(validate(missingWork), false);
    for (const counter of [
      "transformExecutions",
      "maximumConcurrentTransforms",
      "ownerPolicySkips",
      "localPaintSurfaceCacheHits",
      "localPaintSurfaceCacheMisses",
      "localPaintSurfaceCacheBypasses",
      "localPaintSurfaceCacheEvictions",
      "localPaintSurfaceCacheResidentBytes",
    ] as const) {
      const missingCounter = structuredClone(persisted);
      delete missingCounter.execution.localSpaces[0].counters[counter];
      assert.equal(validate(missingCounter), false, counter);
      const missingTreeCounter = structuredClone(persisted);
      delete missingTreeCounter.execution.localSpaceExecutions[0].execution.counters[counter];
      assert.equal(validate(missingTreeCounter), false, `renderer-tree ${counter}`);
    }
    for (const axis of ["skewX", "skewY"] as const) {
      const nonzeroSkew = structuredClone(persisted);
      nonzeroSkew.execution.localSpaces[0].placements[0].transform[axis] = 1;
      assert.equal(validate(nonzeroSkew), false, axis);
    }
    const invalidWork = structuredClone(persisted);
    invalidWork.execution.localSpaces[0].placements[0].transformWork.source.width = 0;
    assert.equal(validate(invalidWork), false);
    const extraWork = structuredClone(persisted);
    extraWork.execution.localSpaces[0].placements[0].transformWork.silentlyIgnored = true;
    assert.equal(validate(extraWork), false);

    const zeroOutput = resolve(root, "review", "component-zero.png");
    const zeroIr = await locked(root, componentProgram({ ...directedControls, opacity: "0" }, "product", "component zero schema"));
    await renderReferenceFrameArtifact(zeroIr, root, zeroOutput, { frame: 0, mediaProfile: "master" });
    const zeroPersisted = JSON.parse(await readFile(`${zeroOutput}.manifest.json`, "utf8"));
    assert.equal(validate(zeroPersisted), true, JSON.stringify(validate.errors));
    assert.equal(zeroPersisted.execution.localSpaceTransformPreflight.status, "zero-visible-affine-placements");
    assert.equal(zeroPersisted.execution.localSpaceTransformPreflight.admissions.length, 0);
    assert.equal(zeroPersisted.execution.localSpaceTransformPreflight.skips[0].ownerKind, "component-fragment");
    assert.equal(zeroPersisted.execution.localSpaces[0].skips[0].kind, "owner-opacity");
    const missingOwnerAttribution = structuredClone(zeroPersisted);
    delete missingOwnerAttribution.execution.localSpaces[0].skips[0].ownerNodeId;
    assert.equal(validate(missingOwnerAttribution), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
