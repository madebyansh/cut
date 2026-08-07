import { hash } from "../core/stable";
import type { CutAVIR, IRNode, IRValue } from "./ir";

export const cutTypedDataAssetKinds = Object.freeze(["caption", "transcript", "lut"] as const);
export type CutTypedDataAssetKind = (typeof cutTypedDataAssetKinds)[number];

export const cutTypedDataAssetFormats = Object.freeze({
  caption: Object.freeze(["webvtt", "srt"] as const),
  transcript: Object.freeze(["cut-transcript-v1"] as const),
  lut: Object.freeze(["cube"] as const),
});

export const cutTypedDataAssetPolicies = Object.freeze({
  caption: "strict-caption-sidecar-v1",
  transcript: "strict-cut-transcript-sidecar-v1",
  lut: "strict-cube-encoded-srgb-v1",
} as const);

type CaptionAuthority = Readonly<{
  version: 1;
  kind: "caption";
  format: "webvtt" | "srt";
  policy: typeof cutTypedDataAssetPolicies.caption;
  identity: string;
}>;

type TranscriptAuthority = Readonly<{
  version: 1;
  kind: "transcript";
  format: "cut-transcript-v1";
  policy: typeof cutTypedDataAssetPolicies.transcript;
  identity: string;
}>;

type LutAuthority = Readonly<{
  version: 1;
  kind: "lut";
  format: "cube";
  policy: typeof cutTypedDataAssetPolicies.lut;
  identity: string;
}>;

/**
 * Compiler-owned semantic authority for one typed byte asset. The surrounding
 * resource deliberately remains `kind: "data"`; omission is the exact legacy
 * `data()` representation. Authors never supply `policy` or `identity`.
 */
export type CutTypedDataAssetAuthorityV1 = CaptionAuthority | TranscriptAuthority | LutAuthority;

export class CutTypedDataAssetAuthorityError extends Error {
  readonly code = "CUT_TYPED_DATA_ASSET_AUTHORITY" as const;

  constructor(readonly path: string, message: string) {
    super(`${"CUT_TYPED_DATA_ASSET_AUTHORITY"} at ${path}: ${message}`);
    this.name = "CutTypedDataAssetAuthorityError";
  }
}

function authorityIdentity(value: Omit<CutTypedDataAssetAuthorityV1, "identity">) {
  return hash({ contract: "cut-typed-data-asset-authority", ...value });
}

export function createCutTypedDataAssetAuthority(
  kind: "caption",
  format: "webvtt" | "srt",
): CaptionAuthority;
export function createCutTypedDataAssetAuthority(
  kind: "transcript",
  format?: "cut-transcript-v1",
): TranscriptAuthority;
export function createCutTypedDataAssetAuthority(kind: "lut", format?: "cube"): LutAuthority;
export function createCutTypedDataAssetAuthority(
  kind: CutTypedDataAssetKind,
  authoredFormat?: "webvtt" | "srt" | "cut-transcript-v1" | "cube",
): CutTypedDataAssetAuthorityV1 {
  const format = kind === "caption"
    ? authoredFormat
    : kind === "transcript"
      ? "cut-transcript-v1"
      : "cube";
  const formats = cutTypedDataAssetFormats[kind] as readonly string[];
  if (typeof format !== "string" || !formats.includes(format)) {
    throw new CutTypedDataAssetAuthorityError(
      "$.format",
      `${kind} format must be one of ${formats.join(", ")}.`,
    );
  }
  const base = Object.freeze({
    version: 1 as const,
    kind,
    format,
    policy: cutTypedDataAssetPolicies[kind],
  }) as Omit<CutTypedDataAssetAuthorityV1, "identity">;
  return Object.freeze({ ...base, identity: authorityIdentity(base) }) as CutTypedDataAssetAuthorityV1;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CutTypedDataAssetAuthorityError(path, "must be one object.");
  }
  return value as Record<string, unknown>;
}

/** Strictly revalidate hostile JSON/IR/lock input and recompute its identity. */
export function validateCutTypedDataAssetAuthority(
  value: unknown,
  path = "$.byteAuthority",
): CutTypedDataAssetAuthorityV1 {
  const object = record(value, path);
  const expectedKeys = ["format", "identity", "kind", "policy", "version"];
  const keys = Object.keys(object).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new CutTypedDataAssetAuthorityError(path, `must contain exactly ${expectedKeys.join(", ")}.`);
  }
  if (object.version !== 1) throw new CutTypedDataAssetAuthorityError(`${path}.version`, "must equal 1.");
  if (typeof object.kind !== "string" || !cutTypedDataAssetKinds.includes(object.kind as CutTypedDataAssetKind)) {
    throw new CutTypedDataAssetAuthorityError(`${path}.kind`, `must be one of ${cutTypedDataAssetKinds.join(", ")}.`);
  }
  const kind = object.kind as CutTypedDataAssetKind;
  const formats = cutTypedDataAssetFormats[kind] as readonly string[];
  if (typeof object.format !== "string" || !formats.includes(object.format)) {
    throw new CutTypedDataAssetAuthorityError(`${path}.format`, `must be one of ${formats.join(", ")}.`);
  }
  if (object.policy !== cutTypedDataAssetPolicies[kind]) {
    throw new CutTypedDataAssetAuthorityError(`${path}.policy`, `must equal ${JSON.stringify(cutTypedDataAssetPolicies[kind])}.`);
  }
  if (typeof object.identity !== "string" || !/^[a-f0-9]{64}$/u.test(object.identity)) {
    throw new CutTypedDataAssetAuthorityError(`${path}.identity`, "must be one lowercase SHA-256 digest.");
  }
  const base = {
    version: 1 as const,
    kind,
    format: object.format,
    policy: cutTypedDataAssetPolicies[kind],
  } as Omit<CutTypedDataAssetAuthorityV1, "identity">;
  const expected = authorityIdentity(base);
  if (object.identity !== expected) {
    throw new CutTypedDataAssetAuthorityError(`${path}.identity`, "does not match the exact kind, format, and policy tuple.");
  }
  return Object.freeze({ ...base, identity: expected }) as CutTypedDataAssetAuthorityV1;
}

export function cutTypedDataAssetAuthorityForConstructor(
  op: string,
  format?: string,
): CutTypedDataAssetAuthorityV1 | undefined {
  if (op === "cut.asset.caption") return createCutTypedDataAssetAuthority("caption", format as "webvtt" | "srt");
  if (op === "cut.asset.transcript") return createCutTypedDataAssetAuthority("transcript");
  if (op === "cut.asset.lut") return createCutTypedDataAssetAuthority("lut");
  return undefined;
}

export function cutTypedDataAssetNominalKind(type: string): CutTypedDataAssetKind | undefined {
  return type === "CaptionAsset" ? "caption"
    : type === "TranscriptAsset" ? "transcript"
      : type === "LUTAsset" ? "lut"
        : undefined;
}

function directResourceId(value: IRValue | undefined) {
  return value?.kind === "resource-ref" ? value.id : undefined;
}

function typedAuthority(ir: CutAVIR, resourceId: string | undefined) {
  return resourceId ? ir.resources[resourceId]?.byteAuthority : undefined;
}

function consumerFailure(path: string, message: string): never {
  throw new CutTypedDataAssetAuthorityError(path, message);
}

function assertDedicatedNodeInput(ir: CutAVIR, node: IRNode, path: string) {
  if (node.op !== "cut.visual.captions" && node.op !== "cut.visual.lut") return;
  const id = directResourceId(node.inputs.source);
  const authority = typedAuthority(ir, id);
  if (!authority) return; // Exact legacy DataAsset omission remains valid.
  const expected = node.op === "cut.visual.captions" ? "caption" : "lut";
  if (authority.kind !== expected) {
    consumerFailure(`${path}.inputs.source`, `${node.op} cannot consume ${authority.kind} byte authority ${JSON.stringify(id)}.`);
  }
  if (authority.kind === "caption") {
    const format = node.inputs.format;
    if (format?.kind !== "string" || format.value !== authority.format) {
      consumerFailure(`${path}.inputs.format`, `must exactly match CaptionAsset format ${JSON.stringify(authority.format)}.`);
    }
  }
}

function visitResourceReferences(value: unknown, path: string, visit: (id: string, path: string) => void) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => visitResourceReferences(item, `${path}[${index}]`, visit));
    return;
  }
  const object = value as Record<string, unknown>;
  if (object.kind === "resource-ref" && typeof object.id === "string") {
    visit(object.id, path);
    return;
  }
  for (const [key, item] of Object.entries(object)) visitResourceReferences(item, `${path}.${key}`, visit);
}

/**
 * Enforce the nominal byte authority after hostile IR loading. Typed resources
 * may be unused, but any executable reference must be the exact dedicated
 * consumer. Legacy data resources remain governed by their historical
 * consumer-owned parser and are not changed by this pass.
 */
export function assertCutTypedDataAssetConsumerCompatibility(ir: CutAVIR) {
  for (const [nodeId, node] of Object.entries(ir.nodes)) {
    const nodePath = `$.nodes.${nodeId}`;
    assertDedicatedNodeInput(ir, node, nodePath);
    for (const [input, value] of Object.entries(node.inputs)) {
      visitResourceReferences(value, `${nodePath}.inputs.${input}`, (resourceId, path) => {
        const authority = typedAuthority(ir, resourceId);
        if (!authority) return;
        const allowed = value.kind === "resource-ref"
          && input === "source"
          && ((node.op === "cut.visual.captions" && authority.kind === "caption")
            || (node.op === "cut.visual.lut" && authority.kind === "lut"));
        if (!allowed) consumerFailure(path, `${authority.kind} byte authority ${JSON.stringify(resourceId)} cannot be consumed by ${node.op}.`);
      });
    }
    visitResourceReferences(node.properties, `${nodePath}.properties`, (resourceId, path) => {
      const authority = typedAuthority(ir, resourceId);
      if (authority) consumerFailure(path, `${authority.kind} byte authority ${JSON.stringify(resourceId)} cannot be used as a mutable property value.`);
    });
    visitResourceReferences(node.editorial, `${nodePath}.editorial`, (resourceId, path) => {
      const authority = typedAuthority(ir, resourceId);
      if (authority) consumerFailure(path, `${authority.kind} byte authority ${JSON.stringify(resourceId)} cannot be reinterpreted by editorial materialization.`);
    });
  }

  const transcriptUse = (resourceId: string, path: string) => {
    const authority = typedAuthority(ir, resourceId);
    if (authority && authority.kind !== "transcript") {
      consumerFailure(path, `transcript semantics cannot consume ${authority.kind} byte authority ${JSON.stringify(resourceId)}.`);
    }
  };
  (ir.transcriptMediaAuthorities ?? []).forEach((authority, index) =>
    transcriptUse(authority.transcriptResourceId, `$.transcriptMediaAuthorities[${index}].transcriptResourceId`));
  (ir.transcriptBindings ?? []).forEach((binding, index) =>
    transcriptUse(binding.transcriptResourceId, `$.transcriptBindings[${index}].transcriptResourceId`));

  for (const [label, value] of [
    ["$.signals", ir.signals],
    ["$.jobs", ir.jobs],
    ["$.outputs", ir.outputs],
    ["$.assertions", ir.assertions],
  ] as const) {
    visitResourceReferences(value, label, (resourceId, path) => {
      const authority = typedAuthority(ir, resourceId);
      if (authority) consumerFailure(path, `${authority.kind} byte authority ${JSON.stringify(resourceId)} is not valid in this execution surface.`);
    });
  }
}
