import { createHash } from "node:crypto";

const diagnosticPreviewCodePoints = 96;
const diagnosticPreviewUtf8Bytes = diagnosticPreviewCodePoints * 6;

/**
 * Escape a string for a human diagnostic without letting an accepted hostile
 * value amplify into megabytes of terminal or JSON output. Array iteration
 * keeps valid surrogate pairs together, while JSON encoding makes controls
 * and lone surrogates explicit. Short ordinary values remain unchanged from
 * JSON.stringify so existing diagnostics stay readable.
 */
export function boundedDiagnosticString(value: string): string {
  const codePoints = [...value];
  const utf8Bytes = Buffer.byteLength(value, "utf8");
  if (codePoints.length <= diagnosticPreviewCodePoints && utf8Bytes <= diagnosticPreviewUtf8Bytes) return JSON.stringify(value);
  const preview = codePoints.slice(0, diagnosticPreviewCodePoints).join("");
  const digest = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
  return `${JSON.stringify(preview)}… [${codePoints.length} Unicode code points; ${utf8Bytes} UTF-8 bytes; sha256:${digest}]`;
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Canonical JSON for machine-facing reports.
 *
 * `stableStringify` above is deliberately also CUT's historical identity
 * encoding, including its treatment of `undefined`; changing it would rewrite
 * existing build identities. This serializer instead follows JSON semantics
 * (omit undefined object fields, encode undefined array slots as null) while
 * retaining deterministic object-key order.
 */
export function stableJsonStringify(value: unknown): string {
  const normalize = (item: unknown, inArray = false): unknown => {
    if (item === undefined || typeof item === "function" || typeof item === "symbol") return inArray ? null : undefined;
    if (typeof item === "bigint") throw new TypeError("Canonical JSON cannot encode BigInt values.");
    if (typeof item === "number" && !Number.isFinite(item)) return null;
    if (Array.isArray(item)) return item.map((entry) => normalize(entry, true));
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([key, entry]) => {
          const normalized = normalize(entry);
          return normalized === undefined ? [] : [[key, normalized]];
        }));
    }
    return item;
  };
  const encoded = JSON.stringify(normalize(value));
  if (encoded === undefined) throw new TypeError("Canonical JSON needs a JSON-serializable root value.");
  return encoded;
}

export function hash(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex");
}
