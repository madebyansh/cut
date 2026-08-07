import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { checkServerIdentity } from "node:tls";
import { BlockList, isIP } from "node:net";
import { runCodex } from "../core/planner";
import type { ResearchPack } from "./types";
import { validateResearchPack } from "./validate";

const id = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$" };
const ids = { type: "array", minItems: 1, maxItems: 20, items: id };

export const researchPackSchema = {
  type: "object", additionalProperties: false,
  required: ["format", "version", "topic", "sources", "claims", "locations", "series", "timelines", "metrics", "assets"],
  properties: {
    format: { type: "string", const: "cut-research" }, version: { type: "integer", const: 1 }, topic: { type: "string", minLength: 1, maxLength: 240 },
    sources: { type: "array", minItems: 3, maxItems: 20, items: { type: "object", additionalProperties: false, required: ["id", "title", "url", "publisher", "shortLabel", "retrievedAt"], properties: {
      id, title: { type: "string", minLength: 1, maxLength: 240 }, url: { type: "string", pattern: "^https://" }, publisher: { type: "string", minLength: 1, maxLength: 160 }, shortLabel: { type: "string", minLength: 1, maxLength: 30 }, retrievedAt: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
    } } },
    claims: { type: "array", minItems: 8, maxItems: 40, items: { type: "object", additionalProperties: false, required: ["id", "text", "sourceIds"], properties: { id, text: { type: "string", minLength: 1, maxLength: 600 }, sourceIds: ids } } },
    locations: { type: "array", maxItems: 30, items: { type: "object", additionalProperties: false, required: ["id", "label", "latitude", "longitude", "sourceIds"], properties: { id, label: { type: "string", minLength: 1, maxLength: 100 }, latitude: { type: "number", minimum: -90, maximum: 90 }, longitude: { type: "number", minimum: -180, maximum: 180 }, sourceIds: ids } } },
    series: { type: "array", maxItems: 8, items: { type: "object", additionalProperties: false, required: ["id", "title", "labels", "values", "unit", "highlight", "sourceIds"], properties: { id, title: { type: "string", minLength: 1, maxLength: 180 }, labels: { type: "array", minItems: 2, maxItems: 12, items: { type: "string", maxLength: 80 } }, values: { type: "array", minItems: 2, maxItems: 12, items: { type: "number" } }, unit: { type: "string", maxLength: 40 }, highlight: { type: "integer", minimum: 0, maximum: 11 }, sourceIds: ids } } },
    timelines: { type: "array", maxItems: 6, items: { type: "object", additionalProperties: false, required: ["id", "events"], properties: { id, events: { type: "array", minItems: 2, maxItems: 8, items: { type: "object", additionalProperties: false, required: ["id", "date", "label", "claimIds"], properties: { id, date: { type: "string", maxLength: 60 }, label: { type: "string", maxLength: 120 }, claimIds: ids } } } } } },
    metrics: { type: "array", minItems: 2, maxItems: 15, items: { type: "object", additionalProperties: false, required: ["id", "value", "label", "context", "method", "status", "sourceIds"], properties: { id, value: { type: "string", minLength: 1, maxLength: 40 }, label: { type: "string", minLength: 1, maxLength: 160 }, context: { type: "string", maxLength: 160 }, method: { type: "string", minLength: 1, maxLength: 180 }, status: { type: "string", enum: ["reported", "estimated", "modeled", "derived"] }, sourceIds: ids } } },
    // Web research establishes facts and visual data. Media stays empty until
    // licensed files are explicitly ingested, so a model can never make the
    // renderer fetch or execute an invented remote asset.
    assets: { type: "array", maxItems: 0, items: { type: "object", additionalProperties: false, required: [], properties: {} } },
  },
};

const nonPublicAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as Array<[string, number]>) nonPublicAddresses.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48],
  ["100::", 64], ["2001::", 32], ["2001:2::", 48], ["2001:10::", 28],
  ["2001:20::", 28], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7],
  ["fe80::", 10], ["ff00::", 8],
] as Array<[string, number]>) nonPublicAddresses.addSubnet(network, prefix, "ipv6");

function unbracket(value: string) { return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value; }

function mappedIpv4(value: string) {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value);
  if (dotted) return dotted[1];
  const hexadecimal = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(value);
  if (!hexadecimal) return undefined;
  const high = Number.parseInt(hexadecimal[1], 16), low = Number.parseInt(hexadecimal[2], 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

export function isPublicResearchAddress(value: string) {
  const address = unbracket(value).toLowerCase();
  const family = isIP(address);
  const mapped = family === 6 ? mappedIpv4(address) : undefined;
  if (mapped) return isPublicResearchAddress(mapped);
  return family !== 0 && !nonPublicAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
}

export function assertSafeResearchUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname.endsWith(".local")) throw new Error(`Unsafe research URL: ${value}`);
  const literal = unbracket(url.hostname);
  if (isIP(literal) && !isPublicResearchAddress(literal)) throw new Error(`Unsafe research URL: ${value}`);
  return url;
}

type SafeResearchResponse = { ok: boolean; status: number; location?: string };

async function requestPinned(url: URL, method: "HEAD" | "GET", address: string, timeoutMs: number) {
  const tlsName = unbracket(url.hostname);
  return new Promise<SafeResearchResponse>((accept, reject) => {
    let settled = false;
    const finish = (error?: Error, result?: SafeResearchResponse) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else accept(result!);
    };
    const request = httpsRequest({
      protocol: "https:",
      hostname: address,
      port: 443,
      method,
      path: `${url.pathname}${url.search}`,
      headers: { Host: url.host, Connection: "close", ...(method === "GET" ? { Range: "bytes=0-1023" } : {}) },
      servername: isIP(tlsName) ? undefined : tlsName,
      checkServerIdentity: (_hostname, certificate) => checkServerIdentity(tlsName, certificate),
      signal: AbortSignal.timeout(timeoutMs),
    }, (response) => {
      const status = response.statusCode ?? 0;
      const rawLocation = response.headers.location;
      const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
      response.destroy();
      finish(undefined, { ok: status >= 200 && status < 300, status, ...(location ? { location } : {}) });
    });
    request.on("error", (error) => finish(error));
    request.end();
  });
}

async function safeRequest(value: string, method: "HEAD" | "GET") {
  let url = assertSafeResearchUrl(value);
  const deadline = Date.now() + 15_000;
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    const literal = unbracket(url.hostname);
    const addresses = isIP(literal)
      ? [{ address: literal, family: isIP(literal) }]
      : await lookup(literal, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((item) => !isPublicResearchAddress(item.address))) throw new Error(`Research URL resolves to a non-public address: ${url.hostname}`);
    let response: SafeResearchResponse | undefined, lastError: unknown;
    for (const item of [...addresses].sort((left, right) => left.address.localeCompare(right.address))) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Research URL timed out: ${value}`);
      try { response = await requestPinned(url, method, item.address, remaining); break; }
      catch (error) { lastError = error; }
    }
    if (!response) throw lastError ?? new Error(`Research URL could not be reached: ${url.hostname}`);
    if (response.status >= 300 && response.status < 400 && response.location) {
      url = assertSafeResearchUrl(new URL(response.location, url).toString());
      continue;
    }
    return response;
  }
  throw new Error(`Research URL exceeded five redirects: ${value}`);
}

async function reachable(url: string) {
  let response = await safeRequest(url, "HEAD").catch(() => undefined);
  if (!response?.ok) response = await safeRequest(url, "GET").catch(() => undefined);
  return Boolean(response?.ok);
}

export async function verifyResearchSources(pack: ResearchPack) {
  const checks = await Promise.all(pack.sources.map(async (source) => ({ id: source.id, ok: await reachable(source.url) })));
  const failed = checks.filter((item) => !item.ok).map((item) => item.id);
  if (failed.length) throw new Error(`Unreachable source URLs: ${failed.join(", ")}`);
  return pack;
}

function prompt(topic: string, retrievedAt: string) {
  return `Act only as CUT's evidence researcher. Use live web search to build a compact, source-grounded research pack for a 60-90 second explanatory documentary about: ${topic}\n\nUse 3-8 authoritative primary sources whenever possible: government agencies, international organizations, official datasets, or original research. Every source URL must be the exact HTTPS page you opened, never a search-results URL. Prefer the most recent complete data, state every time window and denominator, and never infer a number. Every metric must classify status as reported, estimated, derived, or modeled and include a concise method explaining direct reporting, denominator, calculation, or scenario assumptions. Produce at least eight atomic claims that together support a causal arc: hook, mechanism, scale, stakes, complication, consequence, and non-obvious payoff. Build metrics, comparable series, locations, and timelines only when directly supported. Every data object must cite sourceIds. Use concise stable IDs. retrievedAt must be ${retrievedAt}. Leave assets as an empty array; remote media is a separate licensed-ingest stage. Return only the requested structured object.`;
}

export async function researchWithCodex(topic: string, retrievedAt = new Date().toISOString().slice(0, 10)) {
  if (!topic.trim() || topic.length > 240) throw new Error("research topic must contain 1-240 characters.");
  const directory = await mkdtemp(join(tmpdir(), "cut-research-"));
  const schemaPath = join(directory, "schema.json"); const outputPath = join(directory, "research.json");
  await writeFile(schemaPath, JSON.stringify(researchPackSchema));
  try {
    let instruction = prompt(topic, retrievedAt); let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await runCodex(["--search", "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--sandbox", "read-only", "--model", "gpt-5.6-luna", "--config", `model_reasoning_effort=\"${attempt === 1 ? "high" : "medium"}\"`, "--output-schema", schemaPath, "-o", outputPath, instruction], directory);
      const raw = await readFile(outputPath, "utf8");
      try { return await verifyResearchSources(validateResearchPack(JSON.parse(raw))); }
      catch (error) {
        lastError = error;
        instruction = `${prompt(topic, retrievedAt)}\n\nThe previous pack failed deterministic validation. Correct the pack and replace any broken URLs with exact source pages you open. ERROR: ${error instanceof Error ? error.message : String(error)}\nPREVIOUS PACK:\n${raw}`;
      }
    }
    throw lastError;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
