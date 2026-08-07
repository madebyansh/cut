import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import Ajv from "ajv";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { IRNode, IRValue } from "../lib/language/ir";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { finalizeGraphHashes } from "../lib/runtime/graph";
import { inspectCutIr } from "../lib/runtime/inspect";
import {
  ReferenceCalloutError,
  ReferenceCalloutFrameEvidenceError,
  referenceCalloutDecisionIdentity,
  referenceCalloutExecutionIdentity,
  type ReferenceCalloutRenderedFrameEvidence,
  validateReferenceCalloutFrameEvidenceSemantics,
  validateReferenceCalloutGraph,
} from "../lib/runtime/reference/callout";
import { renderReferenceFrameArtifact } from "../lib/runtime/reference/authoring-review";
import { validateReferenceLocalSpaceGraph } from "../lib/runtime/reference/local-space";
import {
  ReferenceLocalSpaceFrameEvidenceError,
  validateCurrentReferenceFrameLocalSpaceExecutionTree,
} from "../lib/runtime/reference/local-space-frame-evidence";
import { validateReferenceStaticVisualGraphs } from "../lib/runtime/reference/static-visual-validation";
import { referenceReachableCompositionNodes, validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

function singleCalloutSource(options: {
  anchor?: string;
  opacityAnimation?: string;
  ignoredArgument?: boolean;
} = {}) {
  return `cut 0.4;
project "public generic Callout renderer proof";
import { CalloutLayer, Callout, LocalSpace, Rect } from "cut:visual";
${options.opacityAnimation ? 'import { linear } from "@cut/motion";' : ""}

timeline main(duration: 1s, fps: 4, width: 192px, height: 128px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    CalloutLayer() {
      Callout(
        anchor: ${options.anchor ?? "{ x: 96px, y: 64px }"},
        placements: ["right", "left"],
        offset: 6px,
        safeArea: 8px,${options.ignoredArgument ? "\n        ignored: 1," : ""}
        leader: "straight",
        leaderColor: #f8fafc,
        leaderWidth: 2px
      ) as label {
        LocalSpace(width: 48px, height: 20px, origin: { x: 0px, y: 0px }) {
          Rect(width: 48px, height: 20px, x: 24px, y: 10px, fill: #f59e0b);
        }
      }
      ${options.opacityAnimation ?? ""}
    }
  }
}
export out = render(main, width: 192px, height: 128px, codec: "h264");`;
}

function collisionSource() {
  return `cut 0.4;
project "public generic Callout collision proof";
import { CalloutLayer, Callout, LocalSpace, Rect } from "cut:visual";

timeline main(duration: 1s, fps: 4, width: 192px, height: 128px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    CalloutLayer() {
      Callout(
        anchor: { x: 96px, y: 64px },
        placements: ["right", "left"],
        offset: 6px,
        safeArea: 8px,
        leader: "none"
      ) {
        LocalSpace(width: 48px, height: 20px, origin: { x: 0px, y: 0px }) {
          Rect(width: 48px, height: 20px, x: 24px, y: 10px, fill: #10b981);
        }
      }
      Callout(
        anchor: { x: 96px, y: 64px },
        placements: ["right"],
        offset: 6px,
        safeArea: 8px,
        priority: 10,
        leader: "none"
      ) {
        LocalSpace(width: 48px, height: 20px, origin: { x: 0px, y: 0px }) {
          Rect(width: 48px, height: 20px, x: 24px, y: 10px, fill: #f59e0b);
        }
      }
    }
  }
}
export out = render(main, width: 192px, height: 128px, codec: "h264");`;
}

function policyHiddenCalloutSource() {
  return `cut 0.4;
project "public policy-hidden Callout proof";
import { CalloutLayer, Callout, LocalSpace, Rect, Track2D, visualAnchor } from "cut:visual";
asset observations: DataAsset = data("assets/hidden.track.json");

timeline main(duration: 1s, fps: 4, width: 96px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Track2D(
      source: observations,
      minConfidence: 60%,
      lowConfidence: "fail",
      occluded: "fail",
      outOfFrame: "hide",
      interpolation: "hold"
    ) as tracked {
      LocalSpace(width: 20px, height: 12px, origin: { x: 10px, y: 6px }) {
        Rect(width: 18px, height: 10px, x: 10px, y: 6px, fill: #294c73);
      }
    }
    CalloutLayer() {
      Callout(
        anchor: visualAnchor(owner: tracked, local: { x: 0px, y: 0px }),
        placements: ["right"],
        offset: 6px,
        safeArea: 4px,
        leader: "straight",
        leaderColor: #ffcc33ff,
        leaderWidth: 1px
      ) {
        LocalSpace(width: 32px, height: 14px, origin: { x: 0px, y: 0px }) {
          Rect(width: 32px, height: 14px, x: 16px, y: 7px, fill: #ffcc33);
        }
      }
    }
  }
}
export proof = render(main);`;
}

function hiddenTrackSidecar() {
  const q = (numerator: string) => ({ numerator, denominator: "1" });
  return {
    format: "cut-track-2d",
    version: 1,
    coordinateSpace: "composition-pixels",
    width: 96,
    height: 64,
    samples: [
      { at: q("0"), x: q("20"), y: q("30"), confidence: q("1"), status: "out-of-frame" },
      { at: q("1"), x: q("20"), y: q("30"), confidence: q("1"), status: "out-of-frame" },
    ],
  };
}

function anchoredCalloutSource(groupX: number) {
  return `cut 0.4;
project "public owner-bound generic Callout proof";
import { CalloutLayer, Callout, Group, LocalSpace, Rect, visualAnchor } from "cut:visual";

timeline main(duration: 1s, fps: 4, width: 192px, height: 128px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    Group(x: ${groupX}px, y: 5px) as evidence {
      LocalSpace(width: 40px, height: 30px, origin: { x: 20px, y: 15px }) {
        Rect(width: 40px, height: 30px, x: 20px, y: 15px, fill: #2563eb);
      }
    }
    CalloutLayer() {
      Callout(
        anchor: visualAnchor(owner: evidence, local: { x: 0px, y: 0px }),
        placements: ["right"],
        offset: 6px,
        safeArea: 4px,
        leader: "straight",
        leaderColor: #f8fafc,
        leaderWidth: 2px
      ) {
        LocalSpace(width: 32px, height: 16px, origin: { x: 0px, y: 0px }) {
          Rect(width: 32px, height: 16px, x: 16px, y: 8px, fill: #f59e0b);
        }
      }
    }
  }
}
export out = render(main, width: 192px, height: 128px, codec: "h264");`;
}

function offscreenSource() {
  return singleCalloutSource({ anchor: "{ x: -4px, y: 64px }" });
}

function collisionOverflowSource() {
  return `cut 0.4;
project "public generic Callout collision overflow proof";
import { CalloutLayer, Callout, LocalSpace, Rect } from "cut:visual";

timeline main(duration: 1s, fps: 4, width: 192px, height: 128px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    CalloutLayer() {
      Callout(
        anchor: { x: 96px, y: 64px },
        placements: ["right"],
        offset: 6px,
        safeArea: 8px,
        leader: "none"
      ) {
        LocalSpace(width: 48px, height: 20px, origin: { x: 0px, y: 0px }) {
          Rect(width: 48px, height: 20px, x: 24px, y: 10px, fill: #10b981);
        }
      }
      Callout(
        anchor: { x: 96px, y: 64px },
        placements: ["right"],
        offset: 6px,
        safeArea: 8px,
        priority: 10,
        leader: "none"
      ) {
        LocalSpace(width: 48px, height: 20px, origin: { x: 0px, y: 0px }) {
          Rect(width: 48px, height: 20px, x: 24px, y: 10px, fill: #f59e0b);
        }
      }
    }
  }
}
export out = render(main, width: 192px, height: 128px, codec: "h264");`;
}

function priorityOrderSource() {
  return `cut 0.4;
project "public generic Callout priority order proof";
import { CalloutLayer, Callout, LocalSpace, Rect } from "cut:visual";

timeline main(duration: 1s, fps: 4, width: 192px, height: 128px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    CalloutLayer() {
      Callout(
        anchor: { x: 36px, y: 64px },
        placements: ["right"],
        offset: 6px,
        safeArea: 4px,
        leader: "none"
      ) {
        LocalSpace(width: 32px, height: 16px, origin: { x: 0px, y: 0px }) {
          Rect(width: 32px, height: 16px, x: 16px, y: 8px, fill: #10b981);
        }
      }
      Callout(
        anchor: { x: 116px, y: 64px },
        placements: ["right"],
        offset: 6px,
        safeArea: 4px,
        priority: 10,
        leader: "none"
      ) {
        LocalSpace(width: 32px, height: 16px, origin: { x: 0px, y: 0px }) {
          Rect(width: 32px, height: 16px, x: 16px, y: 8px, fill: #f59e0b);
        }
      }
    }
  }
}
export out = render(main, width: 192px, height: 128px, codec: "h264");`;
}

function nestedCalloutSource() {
  return `cut 0.4;
project "nested generic Callout evidence proof";
import { CalloutLayer, Callout, LocalSpace, Rect, Precomp } from "cut:visual";

timeline insert(duration: 1s, fps: 4, width: 192px, height: 128px, sampleRate: 48khz) {
  scene nested(duration: 1s) {
    CalloutLayer() {
      Callout(
        anchor: { x: 96px, y: 64px },
        placements: ["right"],
        offset: 6px,
        safeArea: 8px,
        leader: "none"
      ) {
        LocalSpace(width: 48px, height: 20px, origin: { x: 0px, y: 0px }) {
          Rect(width: 48px, height: 20px, x: 24px, y: 10px, fill: #f59e0b);
        }
      }
    }
  }
}

timeline main(duration: 1s, fps: 4, width: 192px, height: 128px, sampleRate: 48khz) {
  scene host(duration: 1s) {
    Precomp(source: insert);
    Precomp(source: insert);
  }
}
export out = render(main, width: 192px, height: 128px, codec: "h264");`;
}

function compile(program = singleCalloutSource()) {
  const parsed = parseCutLanguage(program);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const diagnostics = [
    ...parsed.diagnostics,
    ...checkCutModule(parsed.module).diagnostics,
  ].filter((item) => item.severity === "error");
  assert.deepEqual(diagnostics, [], JSON.stringify(diagnostics));
  const ir = compileCutModule(parsed.module).ir;
  ir.determinism.semantic = "locked";
  finalizeGraphHashes(ir);
  return { ir, session: validateReferenceSession(ir) };
}

async function frameSchemaValidator() {
  const schema = JSON.parse(
    await readFile(resolve("schemas/cut-reference-frame-v2.schema.json"), "utf8"),
  );
  return new Ajv({
    schemaId: "auto",
    meta: false,
    validateSchema: false,
    allErrors: true,
    jsonPointers: true,
  }).compile(schema);
}

async function renderFrameManifest(program: string, prefix: string) {
  const { ir } = compile(program);
  const root = await mkdtemp(resolve(tmpdir(), prefix));
  const output = resolve(root, "review/frame.png");
  const manifest = await renderReferenceFrameArtifact(
    ir,
    root,
    output,
    { frame: 0, mediaProfile: "master" },
  );
  return {
    ir,
    manifest,
    persisted: JSON.parse(await readFile(`${output}.manifest.json`, "utf8")),
  };
}

async function render(program = singleCalloutSource(), frameIndex = 0) {
  const { ir, session } = compile(program);
  const root = await mkdtemp(resolve(tmpdir(), "cut-reference-callout-"));
  const renderer = new ReferenceVisualRenderer(
    ir,
    session.composition,
    root,
    resolve(root, ".cut-cache"),
  );
  await renderer.prepare();
  try {
    const scene = ir.scenes[session.composition.sceneIds[0]!]!;
    const frame = await renderer.sceneFrame(scene, frameIndex, false);
    return {
      frame,
      evidence: renderer.referenceCalloutLayerEvidence(),
    };
  } finally {
    await renderer.closeAndWait();
  }
}

function rgba(
  frame: Readonly<{ data: Uint8Array; width: number }>,
  x: number,
  y: number,
) {
  const offset = (y * frame.width + x) * 4;
  return [...frame.data.subarray(offset, offset + 4)];
}

function scalar(value: number): IRValue {
  return {
    kind: "quantity",
    dimension: "scalar",
    unit: "scalar",
    magnitude: { numerator: String(value), denominator: "1" },
  };
}

function manifestCalloutLayers(manifest: unknown) {
  return (manifest as {
    execution: {
      calloutLayers?: readonly ReferenceCalloutRenderedFrameEvidence[];
    };
  }).execution.calloutLayers ?? [];
}

function refreshCalloutExecutionIdentity(
  evidence: ReferenceCalloutRenderedFrameEvidence,
) {
  const { executionIdentity: priorExecutionIdentity, ...body } = evidence;
  void priorExecutionIdentity;
  (evidence as { executionIdentity: string }).executionIdentity =
    referenceCalloutExecutionIdentity(body);
  return evidence;
}

function refreshCalloutDecisionAndExecutionIdentities(
  evidence: ReferenceCalloutRenderedFrameEvidence,
) {
  (evidence as { decisionIdentity: string }).decisionIdentity =
    referenceCalloutDecisionIdentity(
      evidence.layerSemanticIdentity,
      evidence.sceneLocalTime,
      evidence.decisions,
    );
  return refreshCalloutExecutionIdentity(evidence);
}

test("public composition-point Callout executes retained tile, leader, pixels, and complete same-render evidence", async () => {
  const rendered = await render();
  assert.equal(rendered.evidence.length, 1);
  const evidence = rendered.evidence[0]!;
  assert.equal(evidence.format, "cut-reference-callout-frame-decisions");
  assert.equal(evidence.algorithmVersion, "cut-reference-callout-v1");
  assert.equal(evidence.layoutAlgorithmVersion, "cut-reference-callout-layout-v1");
  assert.equal(evidence.outputFrame, "0");
  assert.equal(evidence.decisions.length, 1);
  const decision = evidence.decisions[0]!;
  assert.equal(decision.status, "accepted");
  assert.deepEqual(decision.exactAnchor, { x: 96, y: 64 });
  assert.equal(decision.chosenPlacement, "right");
  assert.equal(decision.paintOrder, 0);
  assert.deepEqual(
    decision.rect && {
      left: decision.rect.left,
      top: decision.rect.top,
      width: decision.rect.width,
      height: decision.rect.height,
    },
    { left: 102, top: 54, width: 48, height: 20 },
  );
  assert.equal(decision.leader?.kind, "straight");
  assert.equal(decision.renderedDecision?.status, "painted");
  assert.equal(decision.renderedDecision?.work.calloutOverlayPlacements, 1);
  assert.match(decision.renderedDecision?.tile.rgbaSha256 ?? "", /^[a-f0-9]{64}$/u);
  assert.match(
    decision.renderedDecision?.tile.admittedPlacementIdentity ?? "",
    /^[a-f0-9]{64}$/u,
  );
  assert.match(
    decision.renderedDecision?.tile.affinePlanIdentity ?? "",
    /^[a-f0-9]{64}$/u,
  );
  assert.match(
    decision.renderedDecision?.tile.transformWorkIdentity ?? "",
    /^[a-f0-9]{64}$/u,
  );
  assert.match(decision.renderedDecision?.overlayRgbaSha256 ?? "", /^[a-f0-9]{64}$/u);
  assert.ok((decision.visibleAlpha?.visiblePixels ?? 0) > 0);
  assert.equal(evidence.work.anchorResolutions, 1);
  assert.equal(evidence.work.tileRequests, 1);
  assert.equal(evidence.work.paintedCallouts, 1);
  assert.equal(evidence.work.leaderRasterizations, 1);
  assert.match(evidence.outputRgbaSha256, /^[a-f0-9]{64}$/u);
  assert.match(evidence.decisionIdentity, /^[a-f0-9]{64}$/u);
  assert.match(evidence.executionIdentity, /^[a-f0-9]{64}$/u);

  const tilePixel = rgba(rendered.frame, 110, 60);
  assert.ok(
    tilePixel[0] > 200 && tilePixel[1] > 100 && tilePixel[2] < 80 && tilePixel[3] === 255,
    `expected amber retained tile pixel, observed ${tilePixel}`,
  );
  const leaderPixel = rgba(rendered.frame, 99, 64);
  assert.ok(
    leaderPixel[0] > 180 && leaderPixel[1] > 180 && leaderPixel[2] > 180 && leaderPixel[3] > 0,
    `expected leader pixel, observed ${leaderPixel}`,
  );
});

test("one CalloutLayer executes priority-first collision fallback and reverse-resolution paint order", async () => {
  const rendered = await render(collisionSource());
  const evidence = rendered.evidence[0]!;
  assert.equal(evidence.decisions.length, 2);
  const high = evidence.decisions.find((decision) => decision.priority === 10)!;
  const low = evidence.decisions.find((decision) => decision.priority === 0)!;
  assert.equal(high.status, "accepted");
  assert.equal(high.chosenPlacement, "right");
  assert.equal(high.resolutionOrder, 0);
  assert.equal(high.paintOrder, 1, "higher priority resolves first and paints last");
  assert.equal(low.status, "accepted");
  assert.equal(low.chosenPlacement, "left");
  assert.equal(low.chosenPlacementIndex, 1);
  assert.equal(low.candidates[0]?.collisionWith, high.nodeId);
  assert.equal(low.resolutionOrder, 1);
  assert.equal(low.paintOrder, 0);
  assert.deepEqual(evidence.resolutionOrder, [high.nodeId, low.nodeId]);
  assert.deepEqual(evidence.paintOrder, [low.nodeId, high.nodeId]);
  assert.equal(evidence.work.acceptedCallouts, 2);
  assert.equal(evidence.work.tileRequests, 2);
  assert.equal(evidence.work.paintedCallouts, 2);
  assert.ok(evidence.work.candidateCollisionTests > 0);
});

test("visualAnchor follows an earlier sibling LocalSpace owner and moves layout, evidence, and pixels together", async () => {
  const leftSource = anchoredCalloutSource(-30);
  const rightSource = anchoredCalloutSource(20);
  const leftGraph = compile(leftSource);
  const rightGraph = compile(rightSource);
  const leftOwner = Object.values(leftGraph.ir.nodes).find(
    (node) => node.op === "cut.visual.group",
  )!;
  const rightOwner = Object.values(rightGraph.ir.nodes).find(
    (node) => node.op === "cut.visual.group",
  )!;
  const leftOwnerLocal = leftGraph.ir.nodes[leftOwner.children[0]!]!;
  const rightOwnerLocal = rightGraph.ir.nodes[rightOwner.children[0]!]!;
  const left = await render(leftSource);
  const right = await render(rightSource);
  const leftDecision = left.evidence[0]!.decisions[0]!;
  const rightDecision = right.evidence[0]!.decisions[0]!;
  assert.equal(leftDecision.status, "accepted");
  assert.equal(rightDecision.status, "accepted");
  assert.deepEqual(leftDecision.exactAnchor, { x: 66, y: 69 });
  assert.deepEqual(rightDecision.exactAnchor, { x: 116, y: 69 });
  assert.equal(rightDecision.exactAnchor.x - leftDecision.exactAnchor.x, 50);
  assert.equal(rightDecision.rect!.left - leftDecision.rect!.left, 50);
  assert.equal(rightDecision.rect!.top, leftDecision.rect!.top);
  assert.equal(leftDecision.anchors?.length, 1);
  assert.equal(rightDecision.anchors?.length, 1);
  const leftAnchor = leftDecision.anchors![0]!;
  const rightAnchor = rightDecision.anchors![0]!;
  assert.equal(leftAnchor.ownerNodeId, leftOwner.id);
  assert.equal(rightAnchor.ownerNodeId, rightOwner.id);
  assert.equal(leftAnchor.localSpaceNodeId, leftOwnerLocal.id);
  assert.equal(rightAnchor.localSpaceNodeId, rightOwnerLocal.id);
  assert.equal(leftAnchor.ownerStatus, "visible");
  assert.equal(rightAnchor.ownerStatus, "visible");
  assert.deepEqual(leftAnchor.localPoint, { x: 0, y: 0 });
  assert.deepEqual(rightAnchor.localPoint, { x: 0, y: 0 });
  assert.deepEqual(leftAnchor.compositionPoint, leftDecision.exactAnchor);
  assert.deepEqual(rightAnchor.compositionPoint, rightDecision.exactAnchor);
  assert.match(leftAnchor.affineIdentity, /^[a-f0-9]{64}$/u);
  assert.match(rightAnchor.affineIdentity, /^[a-f0-9]{64}$/u);
  assert.match(leftAnchor.ownerPlanIdentity, /^[a-f0-9]{64}$/u);
  assert.match(rightAnchor.ownerPlanIdentity, /^[a-f0-9]{64}$/u);
  assert.notEqual(
    leftDecision.anchorExecutionIdentity,
    rightDecision.anchorExecutionIdentity,
    "the exact anchor execution identity must bind the sampled owner transform",
  );
  const leftTile = leftDecision.renderedDecision?.tile;
  const rightTile = rightDecision.renderedDecision?.tile;
  assert.ok(leftTile);
  assert.ok(rightTile);
  assert.equal(
    leftTile.tileIdentity,
    rightTile.tileIdentity,
    "moving only the anchor owner must preserve reusable retained Callout tile identity",
  );
  assert.equal(
    leftTile.rgbaSha256,
    rightTile.rgbaSha256,
    "moving only the anchor owner must preserve exact retained tile pixels",
  );
  assert.notEqual(
    leftTile.admittedPlacementIdentity,
    rightTile.admittedPlacementIdentity,
    "the admitted placement identity must bind the moved accepted rectangle",
  );
  assert.notEqual(
    left.evidence[0]!.decisionIdentity,
    right.evidence[0]!.decisionIdentity,
    "layout decision identity must bind the moved owner-resolved anchor",
  );
  assert.notEqual(
    left.evidence[0]!.executionIdentity,
    right.evidence[0]!.executionIdentity,
    "whole execution identity must bind changed layout while tile content remains reusable",
  );

  const leftTilePixel = rgba(
    left.frame,
    leftDecision.rect!.left + 6,
    leftDecision.rect!.top + 6,
  );
  const rightTilePixel = rgba(
    right.frame,
    rightDecision.rect!.left + 6,
    rightDecision.rect!.top + 6,
  );
  for (const pixel of [leftTilePixel, rightTilePixel]) {
    assert.ok(
      pixel[0] > 200 && pixel[1] > 100 && pixel[2] < 80 && pixel[3] === 255,
      `expected moved amber Callout pixel, observed ${pixel}`,
    );
  }
  assert.deepEqual(
    rgba(right.frame, leftDecision.rect!.left + 6, leftDecision.rect!.top + 6),
    [0, 0, 0, 0],
    "the moved frame must not leave a stale Callout tile at the old accepted rectangle",
  );
});

test("anchor-offscreen is schema-valid and performs zero tile, placement, leader, and overlay work", async () => {
  const rendered = await renderFrameManifest(
    offscreenSource(),
    "cut-reference-callout-offscreen-",
  );
  const validate = await frameSchemaValidator();
  assert.equal(validate(rendered.persisted), true, JSON.stringify(validate.errors));
  const evidence = manifestCalloutLayers(rendered.manifest)[0]!;
  const decision = evidence.decisions[0]!;
  assert.equal(decision.status, "hidden");
  assert.equal(decision.reason, "anchor-offscreen");
  assert.deepEqual(decision.exactAnchor, { x: -4, y: 64 });
  assert.deepEqual(decision.candidates, []);
  assert.deepEqual(decision.anchors, []);
  assert.match(decision.anchorExecutionIdentity ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(decision.renderedDecision, undefined);
  assert.equal(decision.visibleAlpha, undefined);
  assert.deepEqual(evidence.paintOrder, []);
  assert.deepEqual(evidence.work, {
    activeCallouts: 1,
    acceptedCallouts: 0,
    anchorResolutions: 1,
    ownerPolicySkips: 0,
    candidateEvaluations: 0,
    candidateCollisionTests: 0,
    leaderSegments: 0,
    tileRequests: 0,
    tilePixels: 0,
    paintedCallouts: 0,
    opacityQuantizedTransparentCallouts: 0,
    leaderRasterizations: 0,
    calloutOverlayPlacements: 0,
    calloutOverlayComposites: 0,
    layerSourceOverComposites: 0,
    overlayCanvasPixels: 0,
    overlayCanvasBytes: 0,
  });
});

test("collision-overflow is schema-valid and the hidden Callout performs no tile or overlay work", async () => {
  const rendered = await renderFrameManifest(
    collisionOverflowSource(),
    "cut-reference-callout-overflow-",
  );
  const validate = await frameSchemaValidator();
  assert.equal(validate(rendered.persisted), true, JSON.stringify(validate.errors));
  const evidence = manifestCalloutLayers(rendered.manifest)[0]!;
  const hidden = evidence.decisions.find(
    (decision) => decision.reason === "collision-overflow",
  )!;
  const accepted = evidence.decisions.find(
    (decision) => decision.status === "accepted",
  )!;
  assert.equal(hidden.status, "hidden");
  assert.equal(hidden.candidates.length, 1);
  assert.equal(hidden.candidates[0]?.collisionWith, accepted.nodeId);
  assert.match(hidden.anchorExecutionIdentity ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(hidden.renderedDecision, undefined);
  assert.equal(hidden.visibleAlpha, undefined);
  assert.equal(accepted.renderedDecision?.status, "painted");
  assert.deepEqual(evidence.paintOrder, [accepted.nodeId]);
  assert.equal(evidence.work.activeCallouts, 2);
  assert.equal(evidence.work.acceptedCallouts, 1);
  assert.equal(evidence.work.anchorResolutions, 2);
  assert.equal(evidence.work.tileRequests, 1);
  assert.equal(evidence.work.tilePixels, 48 * 20);
  assert.equal(evidence.work.paintedCallouts, 1);
  assert.equal(evidence.work.calloutOverlayPlacements, 1);
  assert.equal(evidence.work.calloutOverlayComposites, 1);
  assert.equal(evidence.work.layerSourceOverComposites, 1);
});

test("an exact opacity-zero sample performs no anchor resolution, layout candidate, tile, leader, or overlay work", async () => {
  const rendered = await renderFrameManifest(
    singleCalloutSource({
      opacityAnimation: "animate label.opacity from 0% to 50% over 1s ease linear;",
    }),
    "cut-reference-callout-opacity-zero-",
  );
  const validate = await frameSchemaValidator();
  assert.equal(validate(rendered.persisted), true, JSON.stringify(validate.errors));
  assert.equal(
    validateCurrentReferenceFrameLocalSpaceExecutionTree(rendered.persisted),
    rendered.persisted,
  );
  const evidence = manifestCalloutLayers(rendered.manifest)[0]!;
  const decision = evidence.decisions[0]!;
  assert.equal(decision.status, "hidden");
  assert.equal(decision.reason, "opacity-zero");
  assert.equal(decision.opacity, 0);
  assert.deepEqual(decision.candidates, []);
  assert.equal(decision.exactAnchor, undefined);
  assert.equal(decision.anchorExecutionIdentity, undefined);
  assert.equal(decision.renderedDecision, undefined);
  assert.equal(decision.visibleAlpha, undefined);
  assert.deepEqual(evidence.paintOrder, []);
  assert.deepEqual(evidence.work, {
    activeCallouts: 1,
    acceptedCallouts: 0,
    anchorResolutions: 0,
    ownerPolicySkips: 0,
    candidateEvaluations: 0,
    candidateCollisionTests: 0,
    leaderSegments: 0,
    tileRequests: 0,
    tilePixels: 0,
    paintedCallouts: 0,
    opacityQuantizedTransparentCallouts: 0,
    leaderRasterizations: 0,
    calloutOverlayPlacements: 0,
    calloutOverlayComposites: 0,
    layerSourceOverComposites: 0,
    overlayCanvasPixels: 0,
    overlayCanvasBytes: 0,
  });
});

test("Track2D hide policy suppresses a dependent Callout through authenticated preflight and zero-work evidence", async () => {
  const program = policyHiddenCalloutSource();
  const parsed = parseCutLanguage(program);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const checked = checkCutModule(parsed.module);
  assert.deepEqual(
    [...parsed.diagnostics, ...checked.diagnostics].filter(
      (diagnostic) => diagnostic.severity === "error",
    ),
    [],
  );
  const ir = compileCutModule(parsed.module).ir;
  const root = await mkdtemp(resolve(tmpdir(), "cut-reference-callout-policy-hidden-"));
  await mkdir(resolve(root, "assets"));
  await writeFile(
    resolve(root, "assets/hidden.track.json"),
    JSON.stringify(hiddenTrackSidecar()),
  );
  const lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  const output = resolve(root, "review/frame.png");
  const manifest = await renderReferenceFrameArtifact(
    ir,
    root,
    output,
    { frame: 0, mediaProfile: "master" },
  );
  const persisted = JSON.parse(await readFile(`${output}.manifest.json`, "utf8"));
  const validate = await frameSchemaValidator();
  assert.equal(validate(persisted), true, JSON.stringify(validate.errors));
  assert.equal(validateCurrentReferenceFrameLocalSpaceExecutionTree(persisted), persisted);
  const evidence = manifestCalloutLayers(manifest)[0]!;
  const decision = evidence.decisions[0]!;
  assert.equal(decision.status, "hidden");
  assert.equal(decision.reason, "owner-policy-hidden");
  assert.equal(decision.renderedDecision, undefined);
  assert.equal(decision.anchorExecutionIdentity?.length, 64);
  assert.equal(decision.suppressedBy?.length, 1);
  assert.deepEqual(evidence.paintOrder, []);
  assert.equal(evidence.work.ownerPolicySkips, 1);
  assert.equal(evidence.work.tileRequests, 0);
  const renderer = persisted.execution.localSpaceExecutions[0];
  const calloutSkip = renderer.preflight.skips.find(
    (entry: { ownerKind: string }) => entry.ownerKind === "callout",
  );
  assert.equal(calloutSkip?.status, "policy-hidden");
  assert.equal(calloutSkip?.policyHiddenBy?.executionIdentity, decision.anchorExecutionIdentity);
  assert.deepEqual(
    calloutSkip?.policyHiddenBy?.trackOwnerNodeIds,
    decision.suppressedBy?.map((entry) => entry.ownerNodeId).sort(),
  );
  assert.ok(
    renderer.execution.skips.some(
      (entry: { kind: string; reason: string; ownerNodeId?: string }) =>
        entry.kind === "owner-policy"
        && entry.reason === "tracking-policy-hidden"
        && entry.ownerNodeId === decision.nodeId,
    ),
  );
  assert.equal(
    renderer.execution.placements.some(
      (entry: { owner: string }) => entry.owner === "callout",
    ),
    false,
  );
});

test("an executing sub-RGBA opacity sample retains tile admission but performs zero placement, overlay, and leader raster work", async () => {
  const program = singleCalloutSource({
    opacityAnimation: "animate label.opacity from 0.1% to 0.3% over 1s ease linear;",
  });
  const rendered = await renderFrameManifest(
    program,
    "cut-reference-callout-quantized-opacity-",
  );
  const validate = await frameSchemaValidator();
  assert.equal(validate(rendered.persisted), true, JSON.stringify(validate.errors));
  assert.equal(
    validateCurrentReferenceFrameLocalSpaceExecutionTree(rendered.persisted),
    rendered.persisted,
  );
  const evidence = manifestCalloutLayers(rendered.manifest)[0]!;
  const decision = evidence.decisions[0]!;
  assert.equal(decision.status, "accepted");
  assert.equal(decision.opacity, 0.001);
  assert.equal(decision.renderedDecision?.status, "opacity-quantized-transparent");
  assert.equal(decision.renderedDecision?.maximumQuantizedAlpha, 0);
  assert.equal(decision.visibleAlpha, undefined);
  assert.match(
    decision.renderedDecision?.tile.tileIdentity ?? "",
    /^[a-f0-9]{64}$/u,
  );
  assert.match(
    decision.renderedDecision?.tile.admittedPlacementIdentity ?? "",
    /^[a-f0-9]{64}$/u,
  );
  assert.match(
    decision.renderedDecision?.tile.affinePlanIdentity ?? "",
    /^[a-f0-9]{64}$/u,
  );
  assert.match(
    decision.renderedDecision?.tile.transformWorkIdentity ?? "",
    /^[a-f0-9]{64}$/u,
  );
  assert.deepEqual(decision.renderedDecision?.work, {
    calloutOverlayPlacements: 0,
    calloutOverlayComposites: 0,
    overlayCanvasPixels: 0,
    overlayCanvasBytes: 0,
  });
  assert.equal(evidence.work.tileRequests, 1);
  assert.equal(evidence.work.tilePixels, 48 * 20);
  assert.equal(evidence.work.paintedCallouts, 0);
  assert.equal(evidence.work.opacityQuantizedTransparentCallouts, 1);
  assert.equal(evidence.work.leaderRasterizations, 0);
  assert.equal(evidence.work.calloutOverlayPlacements, 0);
  assert.equal(evidence.work.calloutOverlayComposites, 0);
  assert.equal(evidence.work.layerSourceOverComposites, 0);
  assert.equal(evidence.work.overlayCanvasPixels, 0);
  assert.equal(evidence.work.overlayCanvasBytes, 0);

  const rendererReceipt = rendered.persisted.execution.localSpaceExecutions[0];
  const tile = decision.renderedDecision!.tile;
  const admission = rendererReceipt.preflight.admissions.find(
    (entry: {
      ownerKind: string;
      ownerNodeId: string;
      localSpaceNodeId: string;
    }) => entry.ownerKind === "callout"
      && entry.ownerNodeId === decision.nodeId
      && entry.localSpaceNodeId === decision.localSpaceNodeId,
  );
  assert.ok(admission);
  assert.equal(admission.planIdentity, tile.affinePlanIdentity);
  assert.equal(admission.work.workIdentity, tile.transformWorkIdentity);
  assert.ok(
    rendererReceipt.execution.tiles.some(
      (entry: { nodeId: string; tileIdentity: string }) =>
        entry.nodeId === decision.localSpaceNodeId
        && entry.tileIdentity === tile.tileIdentity,
    ),
  );
  assert.equal(
    rendererReceipt.execution.placements.some(
      (entry: { owner: string; nodeId: string }) =>
        entry.owner === "callout" && entry.nodeId === decision.localSpaceNodeId,
    ),
    false,
    "quantized-transparent execution must not rasterize the admitted placement",
  );
});

test("public and hostile loaded Callout fields fail with stable source-located diagnostics", () => {
  const publicProgram = singleCalloutSource({ ignoredArgument: true });
  const parsed = parseCutLanguage(publicProgram);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const diagnostic = checkCutModule(parsed.module).diagnostics.find(
    (item) => item.code === "CUT_CALLOUT_TYPE",
  );
  assert.ok(diagnostic, JSON.stringify(checkCutModule(parsed.module).diagnostics));
  assert.ok(diagnostic.span.start.line > 0);
  assert.ok(diagnostic.span.start.column > 0);
  assert.match(diagnostic.message, /ignored/u);

  const { ir, session } = compile();
  const callout = Object.values(ir.nodes).find(
    (node): node is IRNode => node.op === "cut.visual.callout",
  )!;
  callout.inputs.ignored = scalar(1);
  const reachable = referenceReachableCompositionNodes(ir, session.composition);
  const localSpaces = validateReferenceLocalSpaceGraph(ir, session.composition, reachable);
  assert.throws(
    () => validateReferenceCalloutGraph(
      ir,
      session.composition,
      reachable,
      localSpaces,
    ),
    (error: unknown) => {
      assert.ok(error instanceof ReferenceCalloutError, String(error));
      assert.equal(error.code, "CUT_CALLOUT_TYPE");
      assert.equal(error.source.module, "project.cut");
      assert.ok(error.source.line > 0);
      assert.ok(error.source.column > 0);
      assert.equal(error.source.nodeId, callout.id);
      assert.match(error.message, /input “ignored”/u);
      return true;
    },
  );
});

test("static check enforces the public Callout graph contract without opening assets", () => {
  const { ir } = compile();
  assert.deepEqual(
    validateReferenceStaticVisualGraphs(ir).filter((item) => item.severity === "error"),
    [],
  );
  const hostile = compile();
  const hostileCallout = Object.values(hostile.ir.nodes).find(
    (node): node is IRNode => node.op === "cut.visual.callout",
  )!;
  hostileCallout.inputs.ignored = scalar(1);
  const staticDiagnostic = validateReferenceStaticVisualGraphs(hostile.ir).find(
    (item) => item.code === "CUT_CALLOUT_TYPE",
  );
  assert.ok(staticDiagnostic, JSON.stringify(validateReferenceStaticVisualGraphs(hostile.ir)));
  assert.ok(staticDiagnostic.span.start.line > 0);
  assert.ok(staticDiagnostic.span.start.column > 0);
});

test("inspect exposes the public Callout graph and zero-work policy without opening assets", () => {
  const { ir } = compile();
  const layer = Object.values(ir.nodes).find((node) => node.op === "cut.visual.callout_layer")!;
  const inspected = inspectCutIr(ir, "callout-proof.cut") as {
    graph: {
      nodes: Array<{
        id: string;
        calloutLayer?: {
          algorithmVersion: string;
          layoutAlgorithmVersion: string;
          callouts: Array<{
            nodeId: string;
            viewport: { width: number; height: number };
            placements: string[];
            anchorOwnerNodeIds: string[];
          }>;
          policy: {
            opacityZero: string;
            anchorInference: string;
          };
        };
      }>;
    };
  };
  const value = inspected.graph.nodes.find((node) => node.id === layer.id)?.calloutLayer;
  assert.ok(value, JSON.stringify(inspected.graph.nodes.find((node) => node.id === layer.id)));
  assert.equal(value.algorithmVersion, "cut-reference-callout-v1");
  assert.equal(value.layoutAlgorithmVersion, "cut-reference-callout-layout-v1");
  assert.equal(value.callouts.length, 1);
  assert.deepEqual(value.callouts[0]?.viewport, { width: 48, height: 20 });
  assert.deepEqual(value.callouts[0]?.placements, ["right", "left"]);
  assert.deepEqual(value.callouts[0]?.anchorOwnerNodeIds, []);
  assert.equal(value.policy.opacityZero, "zero-anchor-and-raster-work");
  assert.equal(value.policy.anchorInference, "not-claimed-explicit-spatial-point-only");
});

test("frame v2 publishes schema-closed Callout evidence while legacy manifests remain valid without the optional branch", async () => {
  const { ir } = compile();
  const root = await mkdtemp(resolve(tmpdir(), "cut-reference-callout-frame-"));
  const output = resolve(root, "review/frame.png");
  const manifest = await renderReferenceFrameArtifact(
    ir,
    root,
    output,
    { frame: 0, mediaProfile: "master" },
  );
  const persisted = JSON.parse(await readFile(`${output}.manifest.json`, "utf8"));
  const calloutLayers = (manifest.execution as unknown as {
    calloutLayers?: Array<Record<string, unknown>>;
  }).calloutLayers;
  assert.equal(calloutLayers?.length, 1);
  assert.equal(calloutLayers?.[0]?.format, "cut-reference-callout-frame-decisions");
  assert.equal(
    (calloutLayers?.[0]?.decisions as Array<{ renderedDecision?: { status: string } }>)[0]
      ?.renderedDecision?.status,
    "painted",
  );

  const schema = JSON.parse(
    await readFile(resolve("schemas/cut-reference-frame-v2.schema.json"), "utf8"),
  );
  const validate = new Ajv({
    schemaId: "auto",
    meta: false,
    validateSchema: false,
    allErrors: true,
    jsonPointers: true,
  }).compile(schema);
  assert.equal(validate(persisted), true, JSON.stringify(validate.errors));

  const unknownNested = structuredClone(persisted);
  unknownNested.execution.calloutLayers[0].silentlyIgnored = true;
  assert.equal(validate(unknownNested), false, "unknown nested Callout evidence must fail closed");

  const missingRendered = structuredClone(persisted);
  delete missingRendered.execution.calloutLayers[0].decisions[0].renderedDecision;
  assert.equal(validate(missingRendered), false, "accepted Callout evidence must retain raster execution");

  const missingAdmissionIdentity = structuredClone(persisted);
  delete missingAdmissionIdentity.execution.calloutLayers[0].decisions[0]
    .renderedDecision.tile.admittedPlacementIdentity;
  assert.equal(
    validate(missingAdmissionIdentity),
    false,
    "painted tile evidence must bind the admitted placement used by the raster path",
  );

  const contradictoryHidden = structuredClone(persisted);
  contradictoryHidden.execution.calloutLayers[0].decisions[0].status = "hidden";
  contradictoryHidden.execution.calloutLayers[0].decisions[0].reason = "opacity-zero";
  contradictoryHidden.execution.calloutLayers[0].decisions[0].candidates = [];
  assert.equal(
    validate(contradictoryHidden),
    false,
    "hidden Callout evidence cannot retain accepted-only geometry or raster fields",
  );

  const legacy = structuredClone(persisted);
  delete legacy.execution.calloutLayers;
  assert.equal(validate(legacy), true, JSON.stringify(validate.errors));
});

test("persisted semantic validation cross-binds Callout admission, transform work, placement, and transparent zero-work claims", async () => {
  const rendered = await renderFrameManifest(
    singleCalloutSource(),
    "cut-reference-callout-semantic-",
  );
  const validate = await frameSchemaValidator();
  assert.equal(validate(rendered.persisted), true, JSON.stringify(validate.errors));
  assert.equal(
    validateCurrentReferenceFrameLocalSpaceExecutionTree(rendered.persisted),
    rendered.persisted,
  );

  for (const field of [
    "admittedPlacementIdentity",
    "affinePlanIdentity",
    "transformWorkIdentity",
  ] as const) {
    const hostile = structuredClone(rendered.persisted);
    const hostileCallout = hostile.execution.calloutLayers[0] as
      ReferenceCalloutRenderedFrameEvidence;
    (
      hostileCallout.decisions[0]!.renderedDecision!.tile as unknown as
        Record<typeof field, string>
    )[field] = "0".repeat(64);
    refreshCalloutDecisionAndExecutionIdentities(hostileCallout);
    assert.equal(
      validate(hostile),
      true,
      `${field} mutation must remain structurally valid so semantic validation is exercised`,
    );
    assert.throws(
      () => validateCurrentReferenceFrameLocalSpaceExecutionTree(hostile),
      (error: unknown) => error instanceof ReferenceLocalSpaceFrameEvidenceError
        && error.path.endsWith(".renderedDecision.tile"),
      field,
    );
  }

  const falseTransparent = structuredClone(rendered.persisted);
  const decision = falseTransparent.execution.calloutLayers[0].decisions[0];
  decision.renderedDecision.status = "opacity-quantized-transparent";
  decision.renderedDecision.maximumQuantizedAlpha = 0;
  delete decision.renderedDecision.overlayRgbaSha256;
  decision.renderedDecision.work = {
    calloutOverlayPlacements: 0,
    calloutOverlayComposites: 0,
    overlayCanvasPixels: 0,
    overlayCanvasBytes: 0,
  };
  delete decision.visibleAlpha;
  const falseTransparentCallout =
    falseTransparent.execution.calloutLayers[0] as
      ReferenceCalloutRenderedFrameEvidence;
  const falseTransparentWork = falseTransparentCallout.work as unknown as {
    calloutOverlayPlacements: number;
    calloutOverlayComposites: number;
    layerSourceOverComposites: number;
    leaderRasterizations: number;
    opacityQuantizedTransparentCallouts: number;
    overlayCanvasPixels: number;
    overlayCanvasBytes: number;
    paintedCallouts: number;
  };
  falseTransparentWork.calloutOverlayPlacements = 0;
  falseTransparentWork.calloutOverlayComposites = 0;
  falseTransparentWork.layerSourceOverComposites = 0;
  falseTransparentWork.leaderRasterizations = 0;
  falseTransparentWork.opacityQuantizedTransparentCallouts = 1;
  falseTransparentWork.overlayCanvasPixels = 0;
  falseTransparentWork.overlayCanvasBytes = 0;
  falseTransparentWork.paintedCallouts = 0;
  refreshCalloutDecisionAndExecutionIdentities(falseTransparentCallout);
  assert.equal(
    validate(falseTransparent),
    true,
    JSON.stringify(validate.errors),
  );
  assert.throws(
    () => validateCurrentReferenceFrameLocalSpaceExecutionTree(falseTransparent),
    (error: unknown) => error instanceof ReferenceLocalSpaceFrameEvidenceError
      && error.path.endsWith(".renderedDecision")
      && /opacity-quantized-transparent while a Callout placement was rasterized/u.test(
        error.message,
      ),
  );
});

test("direct Callout semantic validation rejects rehashed layout forgeries and stale rendered-work identities", async () => {
  const ordinary = structuredClone((await render()).evidence[0]!);
  assert.equal(
    validateReferenceCalloutFrameEvidenceSemantics(ordinary),
    ordinary,
  );

  const staleWorkIdentity = structuredClone(ordinary);
  const staleRendered = staleWorkIdentity.decisions[0]!.renderedDecision!;
  assert.equal(staleRendered.status, "painted");
  const nestedWork = staleRendered.work as {
    overlayCanvasPixels: number;
    overlayCanvasBytes: number;
  };
  nestedWork.overlayCanvasPixels += 1;
  nestedWork.overlayCanvasBytes = nestedWork.overlayCanvasPixels * 4;
  const aggregateWork = staleWorkIdentity.work as {
    overlayCanvasPixels: number;
    overlayCanvasBytes: number;
  };
  aggregateWork.overlayCanvasPixels += 1;
  aggregateWork.overlayCanvasBytes = aggregateWork.overlayCanvasPixels * 4;
  assert.throws(
    () => validateReferenceCalloutFrameEvidenceSemantics(staleWorkIdentity),
    (error: unknown) => error instanceof ReferenceCalloutFrameEvidenceError
      && error.path === "$.executionIdentity",
    "work that remains internally summed must still invalidate the whole receipt identity",
  );

  const tileRectMismatch = structuredClone(ordinary);
  const mismatchedTile = tileRectMismatch.decisions[0]!.renderedDecision!.tile as {
    width: number;
  };
  mismatchedTile.width += 1;
  refreshCalloutExecutionIdentity(tileRectMismatch);
  assert.throws(
    () => validateReferenceCalloutFrameEvidenceSemantics(tileRectMismatch),
    (error: unknown) => error instanceof ReferenceCalloutFrameEvidenceError
      && error.path === "$.decisions[0].renderedDecision.tile"
      && /dimensions do not match/u.test(error.message),
  );

  const collision = structuredClone((await render(collisionSource())).evidence[0]!);
  const collided = collision.decisions.find(
    (decision) => decision.candidates.some(
      (candidate) => candidate.collisionWith !== undefined,
    ),
  )!;
  const collidedCandidate = collided.candidates.find(
    (candidate) => candidate.collisionWith !== undefined,
  )!;
  (collidedCandidate as { collisionWith: string }).collisionWith = collided.nodeId;
  refreshCalloutDecisionAndExecutionIdentities(collision);
  assert.throws(
    () => validateReferenceCalloutFrameEvidenceSemantics(collision),
    (error: unknown) => error instanceof ReferenceCalloutFrameEvidenceError
      && /\.candidates\[[0-9]+\]\.collisionWith$/u.test(error.path),
    "collisionWith must be re-derived from prior accepted half-open rectangles",
  );

  const reordered = structuredClone(
    (await render(priorityOrderSource())).evidence[0]!,
  );
  const reversed = [...reordered.decisions].reverse();
  for (const [index, decision] of reversed.entries()) {
    (decision as { resolutionOrder: number }).resolutionOrder = index;
  }
  const reversedPaintOrder = [...reversed].reverse().map(
    (decision) => decision.nodeId,
  );
  for (const decision of reversed) {
    (decision as { paintOrder?: number }).paintOrder =
      reversedPaintOrder.indexOf(decision.nodeId);
  }
  (reordered as {
    decisions: typeof reordered.decisions;
    resolutionOrder: readonly string[];
    paintOrder: readonly string[];
  }).decisions = reversed;
  (reordered as { resolutionOrder: readonly string[] }).resolutionOrder =
    reversed.map((decision) => decision.nodeId);
  (reordered as { paintOrder: readonly string[] }).paintOrder =
    reversedPaintOrder;
  refreshCalloutDecisionAndExecutionIdentities(reordered);
  assert.throws(
    () => validateReferenceCalloutFrameEvidenceSemantics(reordered),
    (error: unknown) => error instanceof ReferenceCalloutFrameEvidenceError
      && error.path === "$.resolutionOrder"
      && /priority.*source/u.test(error.message),
    "recomputing public hashes cannot legitimize a priority/source-order forgery",
  );
});

test("nested Precomp Callout evidence is path-rekeyed per instance, schema-valid, and replay-stable", async () => {
  const first = await renderFrameManifest(
    nestedCalloutSource(),
    "cut-reference-callout-nested-",
  );
  const validate = await frameSchemaValidator();
  assert.equal(validate(first.persisted), true, JSON.stringify(validate.errors));
  assert.equal(
    validateCurrentReferenceFrameLocalSpaceExecutionTree(first.persisted),
    first.persisted,
  );
  const main = first.ir.compositions.find((composition) => composition.name === "main")!;
  const insert = first.ir.compositions.find((composition) => composition.name === "insert")!;
  const layers = manifestCalloutLayers(first.manifest);
  assert.equal(layers.length, 2);
  assert.equal(new Set(layers.map((layer) => layer.layerNodeId)).size, 1);
  assert.equal(new Set(layers.map((layer) => layer.decisionIdentity)).size, 1);
  assert.equal(new Set(layers.map((layer) => layer.executionIdentity)).size, 2);
  const executionIdentities = layers.map((layer) => layer.executionIdentity);
  assert.deepEqual(
    executionIdentities,
    [...executionIdentities].sort(),
    "nested evidence must use a total path-bound ordering rather than completion order",
  );
  const instanceIds = new Set<string>();
  for (const layer of layers) {
    assert.equal(layer.compositionId, insert.id);
    assert.equal(layer.executionPath.length, 2);
    const outer = layer.executionPath[0]!;
    const inner = layer.executionPath[1]!;
    assert.equal(outer.compositionId, main.id);
    assert.ok(outer.instanceNodeId);
    assert.equal(outer.sourceCompositionId, insert.id);
    instanceIds.add(outer.instanceNodeId);
    assert.deepEqual(inner, { compositionId: insert.id });
    assert.equal(layer.decisions[0]?.status, "accepted");
    assert.equal(layer.decisions[0]?.renderedDecision?.status, "painted");
  }
  assert.equal(instanceIds.size, 2);

  const replay = await renderFrameManifest(
    nestedCalloutSource(),
    "cut-reference-callout-nested-replay-",
  );
  assert.deepEqual(
    manifestCalloutLayers(replay.manifest).map((layer) => layer.executionIdentity),
    executionIdentities,
  );
});

test("a failed Callout frame leaves the previous completed evidence transaction untouched", async () => {
  const { ir, session } = compile();
  const root = await mkdtemp(resolve(tmpdir(), "cut-reference-callout-transaction-"));
  const renderer = new ReferenceVisualRenderer(
    ir,
    session.composition,
    root,
    resolve(root, ".cut-cache"),
  );
  await renderer.prepare();
  const scene = ir.scenes[session.composition.sceneIds[0]!]!;
  const internals = renderer as unknown as {
    calloutOverlay: (...args: unknown[]) => Promise<unknown>;
  };
  const original = internals.calloutOverlay;
  try {
    await renderer.sceneFrame(scene, 0, false);
    const completed = structuredClone(renderer.referenceCalloutLayerEvidence());
    assert.equal(completed.length, 1);
    internals.calloutOverlay = async () => {
      throw new Error("forced Callout overlay failure");
    };
    await assert.rejects(
      () => renderer.sceneFrame(scene, 1, false),
      /forced Callout overlay failure/u,
    );
    assert.deepEqual(
      renderer.referenceCalloutLayerEvidence(),
      completed,
      "partial failed-frame decisions must not replace the last fully completed receipt",
    );
  } finally {
    internals.calloutOverlay = original;
    await renderer.closeAndWait();
  }
});

test("Callout execution identity binds rendered decisions, tile hashes, output pixels, and execution path", async () => {
  const first = (await render()).evidence[0]!;
  const replay = (await render()).evidence[0]!;
  assert.equal(replay.decisionIdentity, first.decisionIdentity);
  assert.equal(replay.outputRgbaSha256, first.outputRgbaSha256);
  assert.equal(replay.executionIdentity, first.executionIdentity);
  const { executionIdentity: _executionIdentity, ...body } = first;
  void _executionIdentity;

  const outputMutation = referenceCalloutExecutionIdentity({
    ...body,
    outputRgbaSha256: "0".repeat(64),
  });
  assert.notEqual(outputMutation, first.executionIdentity);

  const decisions = structuredClone(first.decisions);
  const rendered = decisions[0]?.renderedDecision;
  assert.ok(rendered);
  (rendered.tile as { rgbaSha256: string }).rgbaSha256 = "f".repeat(64);
  const tileMutation = referenceCalloutExecutionIdentity({
    ...body,
    decisions,
  });
  assert.notEqual(tileMutation, first.executionIdentity);

  const pathMutation = referenceCalloutExecutionIdentity({
    ...body,
    executionPath: [{
      compositionId: first.compositionId,
      instanceNodeId: "instance",
      sourceCompositionId: first.compositionId,
    }],
  });
  assert.notEqual(pathMutation, first.executionIdentity);
});
