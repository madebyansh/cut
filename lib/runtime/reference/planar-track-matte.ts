import { hash } from "../../core/stable";
import type { CutAVIR, IRNode } from "../../language/ir";
import { referenceMaskConfig, ReferenceMaskError, type ReferenceMaskConfig } from "./mask-config";

export const referencePlanarTrackMatteAlgorithmVersion = "cut-reference-planar-track-matte-v1" as const;

export const referencePlanarTrackMatteLimits = Object.freeze({
  maximumMasksPerPlanarTile: 1,
});

export type ReferencePlanarTrackMatteErrorCode =
  | "CUT_PLANAR_TRACK_MATTE_GRAPH"
  | "CUT_PLANAR_TRACK_MATTE_MODE"
  | "CUT_PLANAR_TRACK_MATTE_LIMIT";

export class ReferencePlanarTrackMatteError extends Error {
  readonly source: Readonly<{ module: string; line: number; column: number; nodeId: string }>;

  constructor(
    readonly code: ReferencePlanarTrackMatteErrorCode,
    readonly node: IRNode,
    readonly pathSuffix: "children" | "inputs.mode" | "op",
    detail: string,
  ) {
    const { module, span } = node.provenance;
    super(`${code}: ${node.op} at ${module}:${span.start.line}:${span.start.column} ${detail}`);
    this.name = "ReferencePlanarTrackMatteError";
    this.source = Object.freeze({ module, line: span.start.line, column: span.start.column, nodeId: node.id });
  }
}

export type ReferencePlanarTrackMatteConfig = Readonly<{
  algorithmVersion: typeof referencePlanarTrackMatteAlgorithmVersion;
  ownerNodeId: string;
  localSpaceNodeId: string;
  maskNodeId: string;
  targetNodeId: string;
  matteNodeId: string;
  mode: "alpha";
  invert: boolean;
  featherPx: number;
  expandPx: number;
  coordinateSpace: "direct-planar-local-pixels";
  evaluationStage: "before-projective-warp";
  authoring: "manual";
  semanticIdentity: string;
}>;

function fail(
  node: IRNode,
  code: ReferencePlanarTrackMatteErrorCode,
  pathSuffix: ReferencePlanarTrackMatteError["pathSuffix"],
  detail: string,
): never {
  throw new ReferencePlanarTrackMatteError(code, node, pathSuffix, detail);
}

function maskConfig(ir: CutAVIR, node: IRNode): ReferenceMaskConfig {
  try {
    const config = referenceMaskConfig(ir, node);
    if (!config) fail(node, "CUT_PLANAR_TRACK_MATTE_GRAPH", "op", "did not resolve to the public Mask kernel.");
    return config;
  } catch (error) {
    if (!(error instanceof ReferenceMaskError)) throw error;
    // Preserve the public Mask diagnostic for malformed target/matte topology
    // and inputs. The contextual PlanarTrack contract adds only the stricter
    // alpha-mode and one-matte rules.
    throw error;
  }
}

/**
 * Resolve the optional bounded partial-occlusion matte for one PlanarTrack.
 *
 * The matte is not a new hidden channel or renderer. It is exactly one
 * existing public Mask operation in the directly owned LocalSpace
 * compositor. Nested LocalSpace islands are separate coordinate contexts and
 * therefore cannot masquerade as the plane-local matte.
 */
export function referencePlanarTrackMatteConfig(
  ir: CutAVIR,
  owner: IRNode,
): ReferencePlanarTrackMatteConfig | undefined {
  if (owner.op !== "cut.visual.planar_track") return undefined;
  const localSpace = owner.children.length === 1 ? ir.nodes[owner.children[0]!] : undefined;
  if (!localSpace || localSpace.op !== "cut.visual.local_space") {
    fail(
      owner,
      "CUT_PLANAR_TRACK_MATTE_GRAPH",
      "children",
      "requires exactly one direct LocalSpace before a plane-local matte can be admitted.",
    );
  }

  const visiting = new Set<string>();
  const matches: IRNode[] = [];
  const visit = (nodeId: string) => {
    const node = ir.nodes[nodeId];
    if (!node) {
      fail(localSpace, "CUT_PLANAR_TRACK_MATTE_GRAPH", "children", `references missing direct-tile descendant ${JSON.stringify(nodeId)}.`);
    }
    if (visiting.has(node.id)) {
      fail(node, "CUT_PLANAR_TRACK_MATTE_GRAPH", "children", "direct plane-local matte graph cycles.");
    }
    // A nested LocalSpace owns a different authoring coordinate basis. Its
    // internal masks remain ordinary LocalSpace composition, but do not count
    // as PlanarTrack's bounded partial-occlusion matte.
    if (node.op === "cut.visual.local_space") return;
    if (node.op === "cut.visual.mask") {
      matches.push(node);
      if (matches.length > referencePlanarTrackMatteLimits.maximumMasksPerPlanarTile) {
        fail(
          node,
          "CUT_PLANAR_TRACK_MATTE_LIMIT",
          "op",
          `direct PlanarTrack LocalSpace admits at most ${referencePlanarTrackMatteLimits.maximumMasksPerPlanarTile} plane-local Mask.`,
        );
      }
    }
    visiting.add(node.id);
    node.children.forEach(visit);
    visiting.delete(node.id);
  };
  localSpace.children.forEach(visit);
  const mask = matches[0];
  if (!mask) return undefined;

  const config = maskConfig(ir, mask);
  if (config.mode !== "alpha") {
    fail(
      mask,
      "CUT_PLANAR_TRACK_MATTE_MODE",
      "inputs.mode",
      `plane-local partial occlusion accepts alpha Mask only; found ${JSON.stringify(config.mode)}.`,
    );
  }
  if (mask.children.length !== 2) {
    // referenceMaskConfig normally owns this diagnostic. Keep the contextual
    // assertion explicit for callers that narrow or replace that validator.
    fail(mask, "CUT_PLANAR_TRACK_MATTE_GRAPH", "children", "requires exactly one target followed by one alpha matte child.");
  }
  const target = ir.nodes[mask.children[0]!], matte = ir.nodes[mask.children[1]!];
  if (!target || !matte) {
    fail(mask, "CUT_PLANAR_TRACK_MATTE_GRAPH", "children", "target and alpha matte must resolve to public visual nodes.");
  }

  const signalIdentities = Object.entries(mask.properties)
    .flatMap(([property, value]) => {
      if (!("signal" in value)) return [];
      const signal = ir.signals[value.signal];
      if (!signal) fail(mask, "CUT_PLANAR_TRACK_MATTE_GRAPH", "op", `property ${JSON.stringify(property)} references missing signal ${value.signal}.`);
      return [Object.freeze({ property, signalId: signal.id, contentHash: signal.contentHash })];
    })
    .sort((left, right) => left.property.localeCompare(right.property) || left.signalId.localeCompare(right.signalId));
  const semanticIdentity = hash({
    algorithmVersion: referencePlanarTrackMatteAlgorithmVersion,
    ownerNodeId: owner.id,
    localSpaceNodeId: localSpace.id,
    maskNodeId: mask.id,
    maskContentHash: mask.contentHash,
    targetNodeId: target.id,
    targetContentHash: target.contentHash,
    matteNodeId: matte.id,
    matteContentHash: matte.contentHash,
    signalIdentities,
    mode: config.mode,
    invert: config.invert,
    featherPx: config.featherPx,
    expandPx: config.expandPx,
    coordinateSpace: "direct-planar-local-pixels",
    evaluationStage: "before-projective-warp",
    authoring: "manual",
  });
  return Object.freeze({
    algorithmVersion: referencePlanarTrackMatteAlgorithmVersion,
    ownerNodeId: owner.id,
    localSpaceNodeId: localSpace.id,
    maskNodeId: mask.id,
    targetNodeId: target.id,
    matteNodeId: matte.id,
    mode: "alpha" as const,
    invert: config.invert,
    featherPx: config.featherPx,
    expandPx: config.expandPx,
    coordinateSpace: "direct-planar-local-pixels" as const,
    evaluationStage: "before-projective-warp" as const,
    authoring: "manual" as const,
    semanticIdentity,
  });
}
