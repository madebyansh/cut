export const cutFootageErrorCodes = Object.freeze([
  "CUT_FOOTAGE_BACKEND_MISSING",
  "CUT_FOOTAGE_BACKEND_PROTOCOL",
  "CUT_FOOTAGE_MODEL_MISMATCH",
  "CUT_FOOTAGE_INDEX_STALE",
  "CUT_FOOTAGE_UNSUPPORTED_MEDIA",
  "CUT_FOOTAGE_RANGE",
  "CUT_FOOTAGE_MATCH",
  "CUT_FOOTAGE_NO_MATCH",
  "CUT_FOOTAGE_OUTPUT_EXISTS",
  "CUT_FOOTAGE_PUBLISH",
] as const);
export type CutFootageErrorCode = (typeof cutFootageErrorCodes)[number];

export class CutFootageError extends Error {
  constructor(readonly code: CutFootageErrorCode, readonly path: string, message: string) {
    super(`${code} at ${path}: ${message}`);
    this.name = "CutFootageError";
  }
}

export function footageFail(code: CutFootageErrorCode, path: string, message: string): never {
  throw new CutFootageError(code, path, message);
}
