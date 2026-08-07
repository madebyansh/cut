export class CutPackageError extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
    message: string,
  ) {
    super(`${code} at ${path}: ${message}`);
    this.name = "CutPackageError";
  }
}

export function packageFail(code: string, path: string, message: string): never {
  throw new CutPackageError(code, path, message);
}
