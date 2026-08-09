export const cutProductVersion = "0.4.0-alpha.4";
export const cutLanguageVersion = "0.4";
export const cutCompilerIdentity = "cut-ts/0.4.0-alpha.4";
export const cutIrVersion = 3;
export const cutReferenceRuntimeIdentity = "cut-reference/0.4.0-alpha.4";
export const cutPackageAbi = 1;
export const cutBuiltinPackageVersion = cutProductVersion;

export function cutVersionLine() {
  return `cut ${cutProductVersion} (language ${cutLanguageVersion}, CutAVIR ${cutIrVersion}, package ABI ${cutPackageAbi}, ${cutReferenceRuntimeIdentity})`;
}
