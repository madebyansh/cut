/** Public, persisted v1 operation identities for owner-resolved path values.
 * These are IRValue calls rather than runtime nodes. Keeping the version in
 * the operation name lets loaders refuse unknown semantics before rendering. */
export const cutAnchoredSpatialOps = Object.freeze({
  visualAnchor: "cut.visual.visual_anchor.v1",
  compositionOffset: "cut.visual.composition_offset.v1",
  anchoredLineTo: "cut.visual.anchored_line_to.v1",
  anchoredCubicTo: "cut.visual.anchored_cubic_to.v1",
  anchoredPath: "cut.visual.anchored_path.v1",
} as const);

export type CutAnchoredSpatialOp = typeof cutAnchoredSpatialOps[keyof typeof cutAnchoredSpatialOps];

export const cutAnchoredSpatialOpSet: ReadonlySet<string> = new Set(Object.values(cutAnchoredSpatialOps));

export const cutAnchoredPathLimits = Object.freeze({
  maximumSegments: 256,
  /** One start plus three point-bearing fields per maximum cubic segment. */
  maximumSpatialPoints: 769,
  maximumOffsetDepth: 64,
  maximumUniqueOwners: 769,
  maximumAbsoluteCoordinatePx: 65_536,
  /** MediaCamera2D source anchors address pixel centres in a locked,
   * post-crop raster. The runtime's 16,384px native-axis envelope therefore
   * has a greatest possible centre coordinate of 16,383px. */
  maximumMediaSourceCoordinatePx: 16_383,
});

export function isCutAnchoredSpatialOp(value: string): value is CutAnchoredSpatialOp {
  return cutAnchoredSpatialOpSet.has(value);
}
