import {
  defaultCaptionLimits,
  parseSubRip,
  parseWebVtt,
} from "../interchange/captions";
import {
  defaultTranscriptLimits,
  parseCutTranscript,
} from "../interchange/transcript";
import {
  parseReferenceCubeLut,
  referenceCubeLutLimits,
} from "../runtime/reference/lut-config";
import type { IRNode } from "./ir";
import { rational, zeroRational } from "./rational";
import type {
  CutTypedDataAssetAuthorityV1,
  CutTypedDataAssetKind,
} from "./typed-data-asset";

export const cutTypedDataAssetMaximumBytes: Readonly<Record<CutTypedDataAssetKind, number>> = Object.freeze({
  caption: defaultCaptionLimits.maxBytes,
  transcript: defaultTranscriptLimits.maxBytes,
  lut: referenceCubeLutLimits.maxBytes,
});

export type CutTypedDataAssetPayloadSource = Readonly<{
  id: string;
  module: string;
  line: number;
  column: number;
}>;

export class CutTypedDataAssetPayloadError extends Error {
  readonly code = "CUT_TYPED_DATA_ASSET_BYTES" as const;

  constructor(readonly path: string, message: string, options: ErrorOptions = {}) {
    super(`CUT_TYPED_DATA_ASSET_BYTES at ${path}: ${message}`, options);
    this.name = "CutTypedDataAssetPayloadError";
  }
}

function lutErrorNode(source: CutTypedDataAssetPayloadSource | undefined): IRNode {
  const line = source?.line ?? 1;
  const column = source?.column ?? 1;
  return {
    id: source?.id ?? "typed_lut_asset",
    op: "cut.asset.lut",
    domain: "visual",
    ownership: "reference",
    interval: { start: zeroRational, duration: rational(1) },
    inputs: {},
    properties: {},
    children: [],
    effects: [],
    contentHash: "0".repeat(64),
    provenance: {
      module: source?.module ?? "project.cut",
      span: {
        start: { offset: 0, line, column },
        end: { offset: 0, line, column },
      },
    },
  };
}

/** Parse one exact typed byte payload through CUT's existing strict parser. */
export function validateCutTypedDataAssetPayload(
  authority: CutTypedDataAssetAuthorityV1,
  bytes: Uint8Array,
  path = "$.byteAuthority",
  source?: CutTypedDataAssetPayloadSource,
) {
  const maximum = cutTypedDataAssetMaximumBytes[authority.kind];
  if (bytes.byteLength < 1 || bytes.byteLength > maximum) {
    throw new CutTypedDataAssetPayloadError(
      path,
      `${authority.kind} payload must contain 1 through ${maximum} bytes; found ${bytes.byteLength}.`,
    );
  }
  try {
    if (authority.kind === "caption") {
      if (authority.format === "webvtt") parseWebVtt(bytes);
      else parseSubRip(bytes);
    } else if (authority.kind === "transcript") {
      parseCutTranscript(bytes);
    } else {
      parseReferenceCubeLut(lutErrorNode(source), bytes);
    }
  } catch (error) {
    throw new CutTypedDataAssetPayloadError(
      path,
      `${authority.kind}/${authority.format} payload does not satisfy ${authority.policy}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
