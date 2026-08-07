/**
 * Camera-independent, raster-independent 2D callout placement.
 *
 * Callers own source validation, anchor resolution, tile materialization,
 * diagnostics and cache/evidence identity. This module owns only the bounded
 * deterministic layout decision shared by map annotations and generic visual
 * callouts.
 */

export const referenceCalloutLayoutAlgorithmVersion = "cut-reference-callout-layout-v1" as const;

export const referenceCalloutLayoutLimits = Object.freeze({
  maximumEntries: 64,
  maximumPlacementsPerEntry: 4,
  maximumCandidateCollisionTests: 16_384,
  maximumLeaderSegmentsPerEntry: 3,
});

export type ReferenceCalloutPlacement = "right" | "above" | "below" | "left";
export type ReferenceCalloutLeaderKind = "none" | "straight" | "elbow";
export type ReferenceCalloutHiddenReason =
  | "opacity-zero"
  | "anchor-offscreen"
  | "collision-overflow";

export type ReferenceCalloutPoint = Readonly<{ x: number; y: number }>;

export type ReferenceCalloutRect = Readonly<{
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}>;

export type ReferenceCalloutLeader = Readonly<{
  kind: Exclude<ReferenceCalloutLeaderKind, "none">;
  color: string;
  width: number;
  lineCap: "round";
  lineJoin: "round";
  vertices: readonly ReferenceCalloutPoint[];
}>;

export type ReferenceCalloutLayoutEntry = Readonly<{
  id: string;
  /** Lexicographic source order used only after descending priority. */
  sourceOrder: readonly number[];
  priority: number;
  anchor: ReferenceCalloutPoint;
  width: number;
  height: number;
  placements: readonly ReferenceCalloutPlacement[];
  offset: number;
  safeArea: number;
  opacity: number;
  leader: ReferenceCalloutLeaderKind;
  leaderColor?: string;
  leaderWidth?: number;
}>;

export type ReferenceCalloutCandidate = Readonly<{
  placement: ReferenceCalloutPlacement;
  placementIndex: number;
  rect: ReferenceCalloutRect;
  safe: boolean;
  collisionWith?: string;
}>;

export type ReferenceCalloutLayoutDecision = Readonly<{
  id: string;
  sourceOrder: readonly number[];
  priority: number;
  resolutionOrder: number;
  paintOrder?: number;
  opacity: number;
  exactAnchor: ReferenceCalloutPoint;
  candidates: readonly ReferenceCalloutCandidate[];
  status: "accepted" | "hidden";
  reason?: ReferenceCalloutHiddenReason;
  chosenPlacement?: ReferenceCalloutPlacement;
  chosenPlacementIndex?: number;
  rect?: ReferenceCalloutRect;
  leader?: ReferenceCalloutLeader;
}>;

export type ReferenceCalloutLayoutPlan = Readonly<{
  algorithmVersion: typeof referenceCalloutLayoutAlgorithmVersion;
  decisions: readonly ReferenceCalloutLayoutDecision[];
  resolutionOrder: readonly string[];
  paintOrder: readonly string[];
  work: Readonly<{
    activeEntries: number;
    acceptedEntries: number;
    candidateEvaluations: number;
    candidateCollisionTests: number;
    leaderSegments: number;
  }>;
}>;

export type ReferenceCalloutLayoutFailureKind = "type" | "style" | "limit";

export type ReferenceCalloutLayoutOptions = Readonly<{
  maximumEntries?: number;
  maximumCandidateCollisionTests?: number;
  maximumLeaderSegmentsPerEntry?: number;
  fail?: (
    entry: ReferenceCalloutLayoutEntry | undefined,
    kind: ReferenceCalloutLayoutFailureKind,
    detail: string,
  ) => never;
}>;

function defaultFail(
  entry: ReferenceCalloutLayoutEntry | undefined,
  kind: ReferenceCalloutLayoutFailureKind,
  detail: string,
): never {
  throw new Error(`CUT callout layout ${kind}${entry ? ` for ${entry.id}` : ""}: ${detail}`);
}

function finite(
  value: number,
  label: string,
  entry: ReferenceCalloutLayoutEntry | undefined,
  fail: NonNullable<ReferenceCalloutLayoutOptions["fail"]>,
) {
  if (!Number.isFinite(value)) fail(entry, "type", `${label} must be finite.`);
  return Object.is(value, -0) ? 0 : value;
}

export function referenceCalloutSnap(value: number) {
  if (!Number.isFinite(value)) throw new Error("CUT callout layout snap value must be finite.");
  return Math.floor(value + 0.5);
}

export function referenceCalloutCandidateRect(
  anchor: ReferenceCalloutPoint,
  width: number,
  height: number,
  offset: number,
  placement: ReferenceCalloutPlacement,
): ReferenceCalloutRect {
  if (![anchor.x, anchor.y, width, height, offset].every(Number.isFinite)) {
    throw new Error("CUT callout candidate geometry must be finite.");
  }
  let left: number;
  let top: number;
  if (placement === "right") {
    left = referenceCalloutSnap(anchor.x + offset);
    top = referenceCalloutSnap(anchor.y - height / 2);
  } else if (placement === "above") {
    left = referenceCalloutSnap(anchor.x - width / 2);
    top = referenceCalloutSnap(anchor.y - offset - height);
  } else if (placement === "below") {
    left = referenceCalloutSnap(anchor.x - width / 2);
    top = referenceCalloutSnap(anchor.y + offset);
  } else {
    left = referenceCalloutSnap(anchor.x - offset - width);
    top = referenceCalloutSnap(anchor.y - height / 2);
  }
  return Object.freeze({ left, top, right: left + width, bottom: top + height, width, height });
}

export function referenceCalloutRectsCollide(left: ReferenceCalloutRect, right: ReferenceCalloutRect) {
  return Math.min(left.right, right.right) - Math.max(left.left, right.left) > 0
    && Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 0;
}

function viewportIsSafe(
  viewport: Readonly<{ width: number; height: number }>,
  rect: ReferenceCalloutRect,
  safeArea: number,
) {
  return rect.left >= safeArea
    && rect.top >= safeArea
    && rect.right <= viewport.width - safeArea
    && rect.bottom <= viewport.height - safeArea;
}

function anchorIsOnscreen(
  viewport: Readonly<{ width: number; height: number }>,
  anchor: ReferenceCalloutPoint,
) {
  return anchor.x >= 0 && anchor.x < viewport.width
    && anchor.y >= 0 && anchor.y < viewport.height;
}

function directionalEdgePoint(
  anchor: ReferenceCalloutPoint,
  rect: ReferenceCalloutRect,
  placement: ReferenceCalloutPlacement,
  crossAxis?: number,
): ReferenceCalloutPoint {
  const clamp = (value: number, minimum: number, maximum: number) =>
    Math.max(minimum, Math.min(maximum, value));
  if (placement === "right") {
    return Object.freeze({ x: rect.left, y: clamp(crossAxis ?? anchor.y, rect.top, rect.bottom) });
  }
  if (placement === "above") {
    return Object.freeze({ x: clamp(crossAxis ?? anchor.x, rect.left, rect.right), y: rect.bottom });
  }
  if (placement === "below") {
    return Object.freeze({ x: clamp(crossAxis ?? anchor.x, rect.left, rect.right), y: rect.top });
  }
  return Object.freeze({ x: rect.right, y: clamp(crossAxis ?? anchor.y, rect.top, rect.bottom) });
}

function equalPoint(left: ReferenceCalloutPoint, right: ReferenceCalloutPoint) {
  return left.x === right.x && left.y === right.y;
}

export function referenceCalloutLeader(
  entry: ReferenceCalloutLayoutEntry,
  rect: ReferenceCalloutRect,
  placement: ReferenceCalloutPlacement,
  options: ReferenceCalloutLayoutOptions = {},
): ReferenceCalloutLeader | undefined {
  if (entry.leader === "none") return undefined;
  const fail = options.fail ?? defaultFail;
  const maximumSegments = options.maximumLeaderSegmentsPerEntry
    ?? referenceCalloutLayoutLimits.maximumLeaderSegmentsPerEntry;
  const anchor = Object.freeze({
    x: finite(entry.anchor.x, "leader anchor x", entry, fail),
    y: finite(entry.anchor.y, "leader anchor y", entry, fail),
  });
  const vertices: ReferenceCalloutPoint[] = [anchor];
  if (entry.leader === "straight") {
    vertices.push(directionalEdgePoint(anchor, rect, placement));
  } else {
    const direction = placement === "right" ? { x: 1, y: 0 }
      : placement === "below" ? { x: 0, y: 1 }
        : placement === "left" ? { x: -1, y: 0 }
          : { x: 0, y: -1 };
    const perpendicular = { x: -direction.y, y: direction.x };
    const perpendicularSpan = placement === "right" || placement === "left"
      ? entry.height
      : entry.width;
    const jog = Math.min(12, entry.offset / 2, perpendicularSpan / 4);
    const first = Object.freeze({
      x: anchor.x + direction.x * entry.offset / 2,
      y: anchor.y + direction.y * entry.offset / 2,
    });
    const second = Object.freeze({
      x: first.x + perpendicular.x * jog,
      y: first.y + perpendicular.y * jog,
    });
    const crossAxis = placement === "right" || placement === "left" ? second.y : second.x;
    vertices.push(first, second, directionalEdgePoint(anchor, rect, placement, crossAxis));
  }
  if (vertices.some((point, index) => index > 0 && equalPoint(point, vertices[index - 1]!))) {
    fail(entry, "style", `${entry.leader} leader geometry contains consecutive duplicate vertices.`);
  }
  if (vertices.length - 1 > maximumSegments) {
    fail(entry, "limit", `leader exceeds ${maximumSegments} segments.`);
  }
  const leaderColor = entry.leaderColor;
  const leaderWidth = entry.leaderWidth;
  if (leaderColor === undefined) fail(entry, "style", `${entry.leader} leader requires a color.`);
  if (leaderWidth === undefined) fail(entry, "style", `${entry.leader} leader requires a width.`);
  return Object.freeze({
    kind: entry.leader,
    color: leaderColor!,
    width: leaderWidth!,
    lineCap: "round",
    lineJoin: "round",
    vertices: Object.freeze(vertices),
  });
}

function compareSourceOrder(left: readonly number[], right: readonly number[]) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? -1) - (right[index] ?? -1);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function resolveReferenceCalloutLayout(
  viewportValue: Readonly<{ width: number; height: number }>,
  entriesValue: readonly ReferenceCalloutLayoutEntry[],
  options: ReferenceCalloutLayoutOptions = {},
): ReferenceCalloutLayoutPlan {
  const fail = options.fail ?? defaultFail;
  const maximumEntries = options.maximumEntries ?? referenceCalloutLayoutLimits.maximumEntries;
  const maximumCollisionTests = options.maximumCandidateCollisionTests
    ?? referenceCalloutLayoutLimits.maximumCandidateCollisionTests;
  const viewport = Object.freeze({
    width: finite(viewportValue.width, "viewport width", undefined, fail),
    height: finite(viewportValue.height, "viewport height", undefined, fail),
  });
  if (viewport.width <= 0 || viewport.height <= 0) {
    fail(undefined, "type", "viewport width and height must be positive.");
  }
  if (entriesValue.length > maximumEntries) {
    fail(entriesValue[0], "limit", `layout has ${entriesValue.length} active entries; maximum is ${maximumEntries}.`);
  }
  const ids = new Set<string>();
  for (const entry of entriesValue) {
    if (!entry.id || ids.has(entry.id)) fail(entry, "type", `entry id ${JSON.stringify(entry.id)} must be non-empty and unique.`);
    ids.add(entry.id);
    for (const [value, label] of [
      [entry.priority, "priority"],
      [entry.anchor.x, "anchor x"],
      [entry.anchor.y, "anchor y"],
      [entry.width, "width"],
      [entry.height, "height"],
      [entry.offset, "offset"],
      [entry.safeArea, "safe area"],
      [entry.opacity, "opacity"],
    ] as const) finite(value, label, entry, fail);
    if (entry.width <= 0 || entry.height <= 0 || entry.offset <= 0 || entry.safeArea < 0) {
      fail(entry, "type", "width, height and offset must be positive; safe area must be non-negative.");
    }
    if (entry.opacity < 0 || entry.opacity > 1) fail(entry, "type", "opacity must be from 0 through 1.");
    if (entry.placements.length < 1
      || entry.placements.length > referenceCalloutLayoutLimits.maximumPlacementsPerEntry
      || new Set(entry.placements).size !== entry.placements.length) {
      fail(entry, "type", `placements must contain 1 through ${referenceCalloutLayoutLimits.maximumPlacementsPerEntry} unique directions.`);
    }
  }

  const entries = [...entriesValue].sort((left, right) =>
    right.priority - left.priority
    || compareSourceOrder(left.sourceOrder, right.sourceOrder));
  const occupied: Array<{ id: string; rect: ReferenceCalloutRect }> = [];
  const decisions: ReferenceCalloutLayoutDecision[] = [];
  let collisionTests = 0;

  for (const [resolutionOrder, entry] of entries.entries()) {
    const exactAnchor = Object.freeze({
      x: finite(entry.anchor.x, "anchor x", entry, fail),
      y: finite(entry.anchor.y, "anchor y", entry, fail),
    });
    const base = {
      id: entry.id,
      sourceOrder: Object.freeze([...entry.sourceOrder]),
      priority: entry.priority,
      resolutionOrder,
      opacity: entry.opacity,
      exactAnchor,
    } as const;
    if (entry.opacity === 0) {
      decisions.push(Object.freeze({
        ...base,
        candidates: Object.freeze([]),
        status: "hidden" as const,
        reason: "opacity-zero" as const,
      }));
      continue;
    }
    if (!anchorIsOnscreen(viewport, exactAnchor)) {
      decisions.push(Object.freeze({
        ...base,
        candidates: Object.freeze([]),
        status: "hidden" as const,
        reason: "anchor-offscreen" as const,
      }));
      continue;
    }

    const candidates: ReferenceCalloutCandidate[] = [];
    let chosen: ReferenceCalloutCandidate | undefined;
    for (const [placementIndex, placement] of entry.placements.entries()) {
      const rect = referenceCalloutCandidateRect(
        exactAnchor,
        entry.width,
        entry.height,
        entry.offset,
        placement,
      );
      const safe = viewportIsSafe(viewport, rect, entry.safeArea);
      let collisionWith: string | undefined;
      if (safe) {
        for (const accepted of occupied) {
          collisionTests += 1;
          if (collisionTests > maximumCollisionTests) {
            fail(entry, "limit", `layout exceeds ${maximumCollisionTests} candidate collision tests.`);
          }
          if (referenceCalloutRectsCollide(rect, accepted.rect)) {
            collisionWith = accepted.id;
            break;
          }
        }
      }
      const candidate = Object.freeze({
        placement,
        placementIndex,
        rect,
        safe,
        ...(collisionWith === undefined ? {} : { collisionWith }),
      });
      candidates.push(candidate);
      if (safe && collisionWith === undefined) {
        chosen = candidate;
        break;
      }
    }
    if (!chosen) {
      decisions.push(Object.freeze({
        ...base,
        candidates: Object.freeze(candidates),
        status: "hidden" as const,
        reason: "collision-overflow" as const,
      }));
      continue;
    }
    occupied.push({ id: entry.id, rect: chosen.rect });
    decisions.push(Object.freeze({
      ...base,
      candidates: Object.freeze(candidates),
      status: "accepted" as const,
      chosenPlacement: chosen.placement,
      chosenPlacementIndex: chosen.placementIndex,
      rect: chosen.rect,
      ...(entry.leader === "none"
        ? {}
        : { leader: referenceCalloutLeader(entry, chosen.rect, chosen.placement, options) }),
    }));
  }

  const accepted = decisions.filter((decision) => decision.status === "accepted");
  const paintOrder = [...accepted].reverse().map((decision) => decision.id);
  const paintOrderById = new Map(paintOrder.map((id, index) => [id, index]));
  const finalized = decisions.map((decision) => decision.status === "accepted"
    ? Object.freeze({ ...decision, paintOrder: paintOrderById.get(decision.id)! })
    : decision);
  return Object.freeze({
    algorithmVersion: referenceCalloutLayoutAlgorithmVersion,
    decisions: Object.freeze(finalized),
    resolutionOrder: Object.freeze(finalized.map((decision) => decision.id)),
    paintOrder: Object.freeze(paintOrder),
    work: Object.freeze({
      activeEntries: entries.length,
      acceptedEntries: accepted.length,
      candidateEvaluations: finalized.reduce(
        (total, decision) => total + decision.candidates.length,
        0,
      ),
      candidateCollisionTests: collisionTests,
      leaderSegments: accepted.reduce(
        (total, decision) =>
          total + (decision.leader?.vertices.length ? decision.leader.vertices.length - 1 : 0),
        0,
      ),
    }),
  });
}
