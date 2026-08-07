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

export type CutReferenceBackendIdentity = Readonly<{
  format: "cut-reference-backend";
  version: 1;
  runtime: string;
  dependencies: ReferenceDependencyIdentity;
  native: CutReferenceNativeIdentity;
  integrity: string;
}>;

const tokenPattern = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/;

function token(value: unknown, label: string) {
  if (typeof value !== "string" || !tokenPattern.test(value)) {
    throw new Error(`CUT cannot identify the reference backend: ${label} is missing or invalid.`);
  }
  return value;
}

/** Create a canonical backend identity without importing a native module. */
export function createReferenceBackendIdentity(
  dependencies: ReferenceDependencyIdentity,
  native: CutReferenceNativeIdentity,
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
  const content = {
    format: "cut-reference-backend" as const,
    version: 1 as const,
    runtime: cutReferenceRuntimeIdentity,
    dependencies,
    native: canonicalNative,
  };
  return Object.freeze({ ...content, integrity: hash(content) });
}

let collectedIdentity: Promise<CutReferenceBackendIdentity> | undefined;

/**
 * Load the actual native compositor only on lock/render paths. Compiler-only
 * imports use the dependency identity and never initialize Sharp.
 */
export function collectReferenceBackendIdentity() {
  collectedIdentity ??= import("sharp").then((sharpModule) => {
    const sharp = sharpModule.default ?? sharpModule;
    const versions = sharp.versions as Record<string, string | undefined> | undefined;
    if (!versions) throw new Error("CUT cannot identify the reference backend: Sharp exposed no native version map.");
    const nodeAbi = process.versions.modules;
    if (!nodeAbi) throw new Error("CUT cannot identify the reference backend: Node exposed no native module ABI.");
    return createReferenceBackendIdentity(referenceDependencyIdentity, {
      platform: process.platform,
      architecture: process.arch,
      nodeAbi,
      sharp: versions.sharp ?? "",
      libvips: versions.vips ?? "",
    });
  });
  return collectedIdentity;
}
