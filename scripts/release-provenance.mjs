import { createHash } from "node:crypto";

const sha256Pattern = /^[0-9a-f]{64}$/;

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function text(value, field, maximum = 512) {
  if (typeof value !== "string" || !value || value.length > maximum || value.includes("\0")) {
    throw new Error(`Release provenance ${field} must be a non-empty bounded string.`);
  }
  return value;
}

function digest(value, field) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new Error(`Release provenance ${field} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function packagePath(value, field) {
  const path = text(value, field, 1_024);
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.includes("\\")) {
    throw new Error(`Release provenance ${field} must be a canonical package-relative path.`);
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Release provenance ${field} must be a canonical package-relative path.`);
  }
  return path;
}

function toolIdentity(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([
      "bytes", "canonicalPathStringSha256", "policyLabel", "sha256", "version",
    ])) {
    throw new Error(`Release provenance ${field} must have the exact closed tool-identity shape.`);
  }
  const policyLabel = text(value.policyLabel, `${field}.policyLabel`, 128);
  if (!/^[a-z][a-z0-9-]{0,127}$/u.test(policyLabel)) {
    throw new Error(`Release provenance ${field}.policyLabel is invalid.`);
  }
  const bytes = value.bytes;
  if (!Number.isSafeInteger(bytes) || bytes < 1) {
    throw new Error(`Release provenance ${field}.bytes must be a positive safe integer.`);
  }
  return {
    policyLabel,
    version: text(value.version, `${field}.version`, 256),
    canonicalPathStringSha256: digest(value.canonicalPathStringSha256, `${field}.canonicalPathStringSha256`),
    bytes,
    sha256: digest(value.sha256, `${field}.sha256`),
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

/**
 * Build CUT's deterministic, path-free release evidence statement. This is
 * deliberately not described as signed or SLSA-certified: an approved final
 * release still needs an external signature over these exact bytes.
 */
export function createReleaseProvenance(input) {
  const packageName = text(input?.packageName, "packageName", 214);
  const packageVersion = text(input?.packageVersion, "packageVersion", 128);
  const artifactName = packagePath(input?.artifact?.name, "artifact.name");
  const artifactSha256 = digest(input?.artifact?.sha256, "artifact.sha256");
  const replaySha256 = digest(input?.reproducibility?.sameSourceReplaySha256, "reproducibility.sameSourceReplaySha256");
  if (artifactSha256 !== replaySha256 || input?.reproducibility?.byteIdentical !== true) {
    throw new Error("Release provenance requires an independently staged byte-identical same-source replay.");
  }
  const artifactBytes = input?.artifact?.bytes;
  if (!Number.isSafeInteger(artifactBytes) || artifactBytes < 1) {
    throw new Error("Release provenance artifact.bytes must be a positive safe integer.");
  }
  if (input?.artifactProfile !== "runtime") {
    throw new Error("Release provenance only accepts CUT's audited runtime artifact profile.");
  }
  const paths = input?.payloadPaths;
  if (!Array.isArray(paths) || !paths.length || paths.length > 100_000) {
    throw new Error("Release provenance payloadPaths must be a non-empty bounded array.");
  }
  const canonicalPaths = [...new Set(paths.map((path) => packagePath(path, "payloadPaths[]")))].sort();
  if (canonicalPaths.length !== paths.length) throw new Error("Release provenance payloadPaths must not contain duplicates.");
  const payloadManifest = `${canonicalPaths.join("\n")}\n`;
  const shrinkwrapSha256 = digest(input?.materials?.shrinkwrapSha256, "materials.shrinkwrapSha256");
  const sbomSha256 = digest(input?.materials?.sbomSha256, "materials.sbomSha256");
  const builder = input?.builder;
  const tools = builder?.tools;
  if (!tools || typeof tools !== "object" || Array.isArray(tools)
    || JSON.stringify(Object.keys(tools).sort()) !== JSON.stringify(["ffmpeg", "ffprobe", "node", "npm"])) {
    throw new Error("Release provenance builder.tools must contain exactly node, npm, ffmpeg, and ffprobe.");
  }
  const statement = canonicalize({
    format: "cut-release-provenance",
    version: 1,
    subject: {
      name: artifactName,
      bytes: artifactBytes,
      digest: { sha256: artifactSha256 },
    },
    package: {
      name: packageName,
      version: packageVersion,
      artifactProfile: "runtime",
    },
    build: {
      type: "cut-runtime-npm-pack-v1",
      builder: {
        id: "cut-reference-release-builder-v1",
        platform: text(builder?.platform, "builder.platform", 64),
        architecture: text(builder?.architecture, "builder.architecture", 64),
        tools: {
          node: toolIdentity(tools.node, "builder.tools.node"),
          npm: toolIdentity(tools.npm, "builder.tools.npm"),
          ffmpeg: toolIdentity(tools.ffmpeg, "builder.tools.ffmpeg"),
          ffprobe: toolIdentity(tools.ffprobe, "builder.tools.ffprobe"),
        },
      },
      networkMode: input?.networkMode === "offline-cache-only" ? "offline-cache-only" : input?.networkMode === "registry-allowed" ? "registry-allowed" : (() => { throw new Error("Release provenance has an unsupported networkMode."); })(),
    },
    materials: {
      npmShrinkwrap: { sha256: shrinkwrapSha256 },
      cyclonedxSbom: { sha256: sbomSha256 },
      packedPayload: {
        entries: canonicalPaths.length,
        manifestSha256: sha256Text(payloadManifest),
      },
    },
    reproducibility: {
      byteIdenticalSameSourceReplay: true,
      sameSourceReplaySha256: replaySha256,
    },
    signature: {
      status: "unsigned",
      reason: "External release signing requires explicit maintainer approval and is not performed by the verifier.",
    },
  });
  const encoded = `${JSON.stringify(statement, null, 2)}\n`;
  return {
    statement,
    encoded,
    summary: {
      format: statement.format,
      version: statement.version,
      semanticSha256: sha256Text(encoded),
      subjectSha256: artifactSha256,
      payloadEntries: canonicalPaths.length,
      payloadManifestSha256: statement.materials.packedPayload.manifestSha256,
      signature: "unsigned",
      toolIdentities: 4,
    },
  };
}
