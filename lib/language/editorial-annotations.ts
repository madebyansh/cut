import {
  compareRational,
  multiplyRational,
  rational,
  type Rational,
  zeroRational,
} from "./rational";

export const editorialAnnotationGrids = ["frame", "sample"] as const;
export type EditorialAnnotationGrid = typeof editorialAnnotationGrids[number];

export const editorialAnnotationRoles = [
  "beat",
  "chapter",
  "cue",
  "edit",
  "note",
  "review",
  "sync",
  "transcript",
  "custom",
] as const;
export type EditorialAnnotationRole = typeof editorialAnnotationRoles[number];

export const editorialAnnotationLimits = Object.freeze({
  maximumAnnotations: 4_096,
  maximumIdBytes: 128,
  maximumNameBytes: 1_024,
  maximumCommentBytes: 16_384,
  maximumTotalMetadataBytes: 16 * 1024 * 1024,
});

export type EditorialAnnotationMetadata = {
  id: string;
  name: string;
  color: string;
  role: EditorialAnnotationRole;
  comment: string;
  grid: EditorialAnnotationGrid;
};

export type EditorialAnnotationMetadataInput = {
  id: string;
  name?: string;
  color?: string;
  role?: string;
  comment?: string;
  grid?: string;
};

export type EditorialMarker<Provenance = unknown> = EditorialAnnotationMetadata & {
  kind: "marker";
  compositionId: string;
  sceneId?: string;
  at: Rational;
  provenance: Provenance;
};

export type EditorialRegion<Provenance = unknown> = EditorialAnnotationMetadata & {
  kind: "region";
  compositionId: string;
  sceneId?: string;
  range: { start: Rational; duration: Rational };
  provenance: Provenance;
};

export type EditorialAnnotations<Provenance = unknown> = {
  markers: Array<EditorialMarker<Provenance>>;
  regions: Array<EditorialRegion<Provenance>>;
};

export type EditorialAnnotationClock = {
  fps: Rational;
  sampleRate: number;
  duration: Rational;
};

export type EditorialAnnotationErrorCode =
  | "CUT_ANNOTATION_ID"
  | "CUT_ANNOTATION_METADATA"
  | "CUT_ANNOTATION_ROLE"
  | "CUT_ANNOTATION_GRID"
  | "CUT_ANNOTATION_TIMING"
  | "CUT_ANNOTATION_DUPLICATE"
  | "CUT_ANNOTATION_LIMIT";

export class EditorialAnnotationError extends Error {
  constructor(readonly code: EditorialAnnotationErrorCode, message: string) {
    super(message);
    this.name = "EditorialAnnotationError";
  }
}

const idPattern = /^[A-Za-z][A-Za-z0-9._-]*$/;
const colorPattern = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/;

function utf8Bytes(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function rejectUnsafeString(value: string, label: string) {
  if (value.includes("\0") || /[\uD800-\uDFFF]/u.test(value)) {
    throw new EditorialAnnotationError("CUT_ANNOTATION_METADATA", `${label} must be valid Unicode without NUL bytes or unpaired surrogates.`);
  }
}

/**
 * Canonicalize one authored marker/region metadata record. Defaults are
 * executable language semantics rather than documentation-only suggestions.
 */
export function normalizeEditorialAnnotationMetadata(input: EditorialAnnotationMetadataInput): EditorialAnnotationMetadata {
  rejectUnsafeString(input.id, "Annotation id");
  if (!idPattern.test(input.id) || utf8Bytes(input.id) > editorialAnnotationLimits.maximumIdBytes) {
    throw new EditorialAnnotationError(
      "CUT_ANNOTATION_ID",
      `Annotation id must match ${idPattern} and use at most ${editorialAnnotationLimits.maximumIdBytes} UTF-8 bytes.`,
    );
  }

  const name = input.name ?? input.id;
  const comment = input.comment ?? "";
  const color = (input.color ?? "#808080").toLowerCase();
  const role = input.role ?? "note";
  const grid = input.grid ?? "frame";
  rejectUnsafeString(name, "Annotation name");
  rejectUnsafeString(comment, "Annotation comment");
  if (!name.trim() || utf8Bytes(name) > editorialAnnotationLimits.maximumNameBytes) {
    throw new EditorialAnnotationError("CUT_ANNOTATION_METADATA", `Annotation name must contain text and use at most ${editorialAnnotationLimits.maximumNameBytes} UTF-8 bytes.`);
  }
  if (utf8Bytes(comment) > editorialAnnotationLimits.maximumCommentBytes) {
    throw new EditorialAnnotationError("CUT_ANNOTATION_METADATA", `Annotation comment must use at most ${editorialAnnotationLimits.maximumCommentBytes} UTF-8 bytes.`);
  }
  if (!colorPattern.test(color)) {
    throw new EditorialAnnotationError("CUT_ANNOTATION_METADATA", "Annotation color must be a canonical six- or eight-digit CUT color literal.");
  }
  if (!(editorialAnnotationRoles as readonly string[]).includes(role)) {
    throw new EditorialAnnotationError("CUT_ANNOTATION_ROLE", `Annotation role must be one of: ${editorialAnnotationRoles.join(", ")}.`);
  }
  if (!(editorialAnnotationGrids as readonly string[]).includes(grid)) {
    throw new EditorialAnnotationError("CUT_ANNOTATION_GRID", `Annotation grid must be one of: ${editorialAnnotationGrids.join(", ")}.`);
  }
  return { id: input.id, name, color, role: role as EditorialAnnotationRole, comment, grid: grid as EditorialAnnotationGrid };
}

function assertClock(clock: EditorialAnnotationClock) {
  if (!Number.isSafeInteger(clock.sampleRate) || clock.sampleRate <= 0 || compareRational(clock.fps, zeroRational) <= 0 || compareRational(clock.duration, zeroRational) <= 0) {
    throw new EditorialAnnotationError("CUT_ANNOTATION_TIMING", "Annotation clock needs positive exact fps, sample rate, and timeline duration.");
  }
}

export function assertEditorialAnnotationBoundary(
  value: Rational,
  grid: EditorialAnnotationGrid,
  clock: EditorialAnnotationClock,
  label: string,
) {
  assertClock(clock);
  if (compareRational(value, zeroRational) < 0 || compareRational(value, clock.duration) > 0) {
    throw new EditorialAnnotationError("CUT_ANNOTATION_TIMING", `${label} lies outside the owning timeline.`);
  }
  const rate = grid === "frame" ? clock.fps : rational(clock.sampleRate);
  if (multiplyRational(value, rate).denominator !== "1") {
    const description = grid === "frame"
      ? `${clock.fps.numerator}/${clock.fps.denominator} fps frame`
      : `${clock.sampleRate} Hz sample`;
    throw new EditorialAnnotationError("CUT_ANNOTATION_TIMING", `${label} must land on an exact ${description} boundary.`);
  }
}

export function assertEditorialMarkerTime(at: Rational, metadata: EditorialAnnotationMetadata, clock: EditorialAnnotationClock) {
  assertEditorialAnnotationBoundary(at, metadata.grid, clock, `Marker “${metadata.id}” time`);
}

export function assertEditorialRegionRange(
  start: Rational,
  duration: Rational,
  metadata: EditorialAnnotationMetadata,
  clock: EditorialAnnotationClock,
) {
  if (compareRational(duration, zeroRational) <= 0) {
    throw new EditorialAnnotationError("CUT_ANNOTATION_TIMING", `Region “${metadata.id}” duration must be positive.`);
  }
  assertEditorialAnnotationBoundary(start, metadata.grid, clock, `Region “${metadata.id}” start`);
  const end = {
    numerator: String(BigInt(start.numerator) * BigInt(duration.denominator) + BigInt(duration.numerator) * BigInt(start.denominator)),
    denominator: String(BigInt(start.denominator) * BigInt(duration.denominator)),
  };
  // Normalize through rational so equality/grid checks cannot depend on a
  // non-reduced caller representation.
  assertEditorialAnnotationBoundary(rational(end.numerator, end.denominator), metadata.grid, clock, `Region “${metadata.id}” end`);
}

export function editorialAnnotationMetadataBytes(metadata: EditorialAnnotationMetadata) {
  return utf8Bytes(metadata.id) + utf8Bytes(metadata.name) + utf8Bytes(metadata.color) + utf8Bytes(metadata.role) + utf8Bytes(metadata.comment) + utf8Bytes(metadata.grid);
}
