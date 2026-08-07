import { hash } from "../../core/stable";
import {
  referenceDependencyIdentity,
  type ReferenceDependencyIdentity,
} from "../../language/dependency-identity";
import { cutReferenceRuntimeIdentity } from "../../version";

export type CutReferenceNativeIdentity = Readonly<{
  platform: NodeJS.Platform;
  architecture: string;
  nodeAbi: string;
  sharp: string;
  libvips: string;
}>;

export type CutReferenceCompositorIdentity =
  | Readonly<{
    mode: "native";
    platform: NodeJS.Platform;
    architecture: string;
    algorithm: string;
    binarySha256: string;
  }>
  | Readonly<{
    mode: "javascript";
    platform: NodeJS.Platform;
    architecture: string;
    algorithm: string;
    implementation: string;
  }>;

export type CutReferenceBackendIdentity = Readonly<{
  format: "cut-reference-backend";
  version: 2;
  runtime: string;
  dependencies: ReferenceDependencyIdentity;
  native: CutReferenceNativeIdentity;
  compositor: CutReferenceCompositorIdentity;
  integrity: string;
}>;

const tokenPattern = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/;
const digestPattern = /^[a-f0-9]{64}$/;

function token(value: unknown, label: string) {
  if (typeof value !== "string" || !tokenPattern.test(value)) {
    throw new Error(`CUT cannot identify the reference backend: ${label} is missing or invalid.`);
  }
  return value;
}

function compositorIdentity(
  value: CutReferenceCompositorIdentity,
  native: CutReferenceNativeIdentity,
): CutReferenceCompositorIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("CUT cannot identify the reference backend: compositor identity is missing or invalid.");
  }
  const mode = value.mode;
  const required = mode === "native"
    ? ["algorithm", "architecture", "binarySha256", "mode", "platform"]
    : mode === "javascript"
      ? ["algorithm", "architecture", "implementation", "mode", "platform"]
      : [];
  if (!required.length || Object.keys(value).sort().join(",") !== required.join(",")) {
    throw new Error("CUT cannot identify the reference backend: compositor identity has an invalid closed shape.");
  }
  const common = {
    platform: token(value.platform, "compositor platform") as NodeJS.Platform,
    architecture: token(value.architecture, "compositor architecture"),
    algorithm: token(value.algorithm, "compositor algorithm"),
  };
  if (common.platform !== native.platform || common.architecture !== native.architecture) {
    throw new Error("CUT cannot identify the reference backend: compositor host does not match the native runtime host.");
  }
  if (mode === "native") {
    if (!digestPattern.test(value.binarySha256)) {
      throw new Error("CUT cannot identify the reference backend: compositor native binary SHA-256 is missing or invalid.");
    }
    return Object.freeze({ mode, ...common, binarySha256: value.binarySha256 });
  }
  return Object.freeze({
    mode,
    ...common,
    implementation: token(value.implementation, "JavaScript compositor implementation"),
  });
}

/** Create a canonical backend identity without importing a native module. */
export function createReferenceBackendIdentity(
  dependencies: ReferenceDependencyIdentity,
  native: CutReferenceNativeIdentity,
  compositor: CutReferenceCompositorIdentity,
): CutReferenceBackendIdentity {
  const dependencyContent = { format: dependencies.format, version: dependencies.version, packages: dependencies.packages };
  if (dependencies.integrity !== hash(dependencyContent)) {
    throw new Error("CUT cannot identify the reference backend: dependency integrity is invalid.");
  }
  const dependencySharp = dependencies.packages.find((entry) => entry.name === "sharp")?.version;
  const canonicalNative = Object.freeze({
    platform: token(native.platform, "platform") as NodeJS.Platform,
    architecture: token(native.architecture, "architecture"),
    nodeAbi: token(native.nodeAbi, "Node ABI"),
    sharp: token(native.sharp, "Sharp version"),
    libvips: token(native.libvips, "libvips version"),
  });
  if (!dependencySharp || canonicalNative.sharp !== dependencySharp) {
    throw new Error(`CUT reference backend Sharp ${canonicalNative.sharp} does not match installed package Sharp ${dependencySharp ?? "unknown"}.`);
  }
  const canonicalCompositor = compositorIdentity(compositor, canonicalNative);
  const content = {
    format: "cut-reference-backend" as const,
    version: 2 as const,
    runtime: cutReferenceRuntimeIdentity,
    dependencies,
    native: canonicalNative,
    compositor: canonicalCompositor,
  };
  return Object.freeze({ ...content, integrity: hash(content) });
}

let collectedIdentity: Promise<CutReferenceBackendIdentity> | undefined;

/**
 * Load the actual native compositor only on lock/render paths. Compiler-only
 * imports use the dependency identity and never initialize Sharp.
 */
export function collectReferenceBackendIdentity() {
  collectedIdentity ??= Promise.all([
    import("sharp"),
    import("./native-source-over.js"),
  ]).then(([sharpModule, nativeSourceOver]) => {
    const sharp = sharpModule.default ?? sharpModule;
    const versions = sharp.versions as Record<string, string | undefined> | undefined;
    if (!versions) throw new Error("CUT cannot identify the reference backend: Sharp exposed no native version map.");
    const nodeAbi = process.versions.modules;
    if (!nodeAbi) throw new Error("CUT cannot identify the reference backend: Node exposed no native module ABI.");
    return createReferenceBackendIdentity(
      referenceDependencyIdentity,
      {
        platform: process.platform,
        architecture: process.arch,
        nodeAbi,
        sharp: versions.sharp ?? "",
        libvips: versions.vips ?? "",
      },
      nativeSourceOver.referenceNativeSourceOverBackend(),
    );
  });
  return collectedIdentity;
}
