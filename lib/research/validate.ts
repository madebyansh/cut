import type { ResearchPack } from "./types";

const researchId = /^[a-z0-9][a-z0-9_-]{0,79}$/i;

function strictRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object.`);
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string) {
  const accepted = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.hasOwn(record, key));
  const unknown = Object.keys(record).filter((key) => !accepted.has(key));
  if (missing.length) throw new Error(`${label} is missing required field${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`);
  if (unknown.length) throw new Error(`${label} has unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
}

function strictString(value: unknown, label: string, maximum: number, minimum = 1) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || (minimum > 0 && !value.trim())) {
    throw new Error(`${label} must contain ${minimum}-${maximum} characters.`);
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) throw new Error(`${label} contains unsupported control characters.`);
  return value;
}

function strictId(value: unknown, label: string) {
  const id = strictString(value, label, 80);
  if (!researchId.test(id)) throw new Error(`${label} must be a stable CUT research ID.`);
  return id;
}

function strictArray(value: unknown, label: string, maximum: number, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new Error(`${label} must contain ${minimum}-${maximum} items.`);
  return value;
}

function strictIds(value: unknown, label: string, valid: ReadonlySet<string>, maximum = 20) {
  const values = strictArray(value, label, maximum, 1).map((item, index) => strictId(item, `${label}[${index}]`));
  if (new Set(values).size !== values.length) throw new Error(`${label} must not repeat IDs.`);
  const missing = values.find((id) => !valid.has(id));
  if (missing) throw new Error(`${label} references missing research source ${missing}.`);
  return values;
}

function uniqueIds(records: readonly Record<string, unknown>[], label: string) {
  const ids = records.map((record, index) => strictId(record.id, `${label}[${index}].id`));
  if (new Set(ids).size !== ids.length) throw new Error(`${label} IDs must be unique.`);
  return new Set(ids);
}

function isIsoCalendarDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]), date = new Date(0);
  date.setUTCHours(0, 0, 0, 0); date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Validate the complete, closed `cut-research` v1 data contract.
 *
 * The older `validateResearchPack` entry point remains intentionally tolerant
 * of historical producer output. Reference rendering uses this strict form so
 * locked data cannot smuggle unbounded or silently ignored fields into a
 * visible integrity primitive.
 */
export function validateStrictResearchPack(value: unknown): ResearchPack {
  const root = strictRecord(value, "Research pack");
  exactKeys(root, ["format", "version", "topic", "sources", "claims", "locations", "series", "timelines"], ["metrics", "assets"], "Research pack");
  if (root.format !== "cut-research" || root.version !== 1) throw new Error("Research pack must use format cut-research version 1.");
  strictString(root.topic, "Research pack topic", 240);

  const sources = strictArray(root.sources, "Research pack sources", 200, 1).map((value, index) => {
    const source = strictRecord(value, `Research source[${index}]`);
    exactKeys(source, ["id", "title", "url", "publisher", "retrievedAt"], ["shortLabel"], `Research source[${index}]`);
    strictId(source.id, `Research source[${index}].id`);
    strictString(source.title, `Research source[${index}].title`, 240);
    strictString(source.publisher, `Research source[${index}].publisher`, 160);
    if (source.shortLabel !== undefined) strictString(source.shortLabel, `Research source[${index}].shortLabel`, 30);
    const retrievedAt = strictString(source.retrievedAt, `Research source[${index}].retrievedAt`, 10);
    if (!isIsoCalendarDate(retrievedAt)) throw new Error(`Research source[${index}].retrievedAt must be an ISO calendar date.`);
    const urlValue = strictString(source.url, `Research source[${index}].url`, 2_048);
    let url: URL;
    try { url = new URL(urlValue); } catch { throw new Error(`Research source[${index}].url must be an absolute HTTPS URL.`); }
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) throw new Error(`Research source[${index}].url must be an uncredentialed HTTPS URL.`);
    return source;
  });
  const sourceIds = uniqueIds(sources, "Research source");

  const claims = strictArray(root.claims, "Research pack claims", 1_000, 1).map((value, index) => {
    const claim = strictRecord(value, `Research claim[${index}]`);
    exactKeys(claim, ["id", "text", "sourceIds"], [], `Research claim[${index}]`);
    strictId(claim.id, `Research claim[${index}].id`);
    strictString(claim.text, `Research claim[${index}].text`, 600);
    strictIds(claim.sourceIds, `Research claim[${index}].sourceIds`, sourceIds);
    return claim;
  });
  const claimIds = uniqueIds(claims, "Research claim");

  const locations = strictArray(root.locations, "Research pack locations", 30).map((value, index) => {
    const location = strictRecord(value, `Research location[${index}]`);
    exactKeys(location, ["id", "label", "latitude", "longitude", "sourceIds"], [], `Research location[${index}]`);
    strictId(location.id, `Research location[${index}].id`);
    strictString(location.label, `Research location[${index}].label`, 100);
    if (typeof location.latitude !== "number" || !Number.isFinite(location.latitude) || location.latitude < -90 || location.latitude > 90) throw new Error(`Research location[${index}].latitude must be from -90 through 90.`);
    if (typeof location.longitude !== "number" || !Number.isFinite(location.longitude) || location.longitude < -180 || location.longitude > 180) throw new Error(`Research location[${index}].longitude must be from -180 through 180.`);
    strictIds(location.sourceIds, `Research location[${index}].sourceIds`, sourceIds);
    return location;
  });
  uniqueIds(locations, "Research location");

  const series = strictArray(root.series, "Research pack series", 20).map((value, index) => {
    const item = strictRecord(value, `Research series[${index}]`);
    exactKeys(item, ["id", "title", "labels", "values", "unit", "sourceIds"], ["highlight"], `Research series[${index}]`);
    strictId(item.id, `Research series[${index}].id`);
    strictString(item.title, `Research series[${index}].title`, 180);
    const labels = strictArray(item.labels, `Research series[${index}].labels`, 20, 1);
    labels.forEach((label, labelIndex) => strictString(label, `Research series[${index}].labels[${labelIndex}]`, 80));
    const values = strictArray(item.values, `Research series[${index}].values`, 20, 1);
    if (values.length !== labels.length || values.some((number) => typeof number !== "number" || !Number.isFinite(number))) throw new Error(`Research series[${index}] values must be finite numbers paired with every label.`);
    strictString(item.unit, `Research series[${index}].unit`, 40, 0);
    if (item.highlight !== undefined && (typeof item.highlight !== "number" || !Number.isSafeInteger(item.highlight) || item.highlight < 0 || item.highlight >= labels.length)) throw new Error(`Research series[${index}].highlight must select one label.`);
    strictIds(item.sourceIds, `Research series[${index}].sourceIds`, sourceIds);
    return item;
  });
  uniqueIds(series, "Research series");

  const timelines = strictArray(root.timelines, "Research pack timelines", 20).map((value, index) => {
    const timeline = strictRecord(value, `Research timeline[${index}]`);
    exactKeys(timeline, ["id", "events"], [], `Research timeline[${index}]`);
    strictId(timeline.id, `Research timeline[${index}].id`);
    const events = strictArray(timeline.events, `Research timeline[${index}].events`, 12, 1).map((eventValue, eventIndex) => {
      const event = strictRecord(eventValue, `Research timeline[${index}].event[${eventIndex}]`);
      exactKeys(event, ["id", "date", "label", "claimIds"], [], `Research timeline[${index}].event[${eventIndex}]`);
      strictId(event.id, `Research timeline[${index}].event[${eventIndex}].id`);
      strictString(event.date, `Research timeline[${index}].event[${eventIndex}].date`, 60);
      strictString(event.label, `Research timeline[${index}].event[${eventIndex}].label`, 120);
      const ids = strictArray(event.claimIds, `Research timeline[${index}].event[${eventIndex}].claimIds`, 20, 1).map((id, claimIndex) => strictId(id, `Research timeline[${index}].event[${eventIndex}].claimIds[${claimIndex}]`));
      if (new Set(ids).size !== ids.length || ids.some((id) => !claimIds.has(id))) throw new Error(`Research timeline[${index}].event[${eventIndex}] must reference unique existing claims.`);
      return event;
    });
    uniqueIds(events, `Research timeline[${index}] event`);
    return timeline;
  });
  uniqueIds(timelines, "Research timeline");

  const metrics = strictArray(root.metrics ?? [], "Research pack metrics", 200).map((value, index) => {
    const metric = strictRecord(value, `Research metric[${index}]`);
    exactKeys(metric, ["id", "value", "label", "sourceIds"], ["context", "method", "status"], `Research metric[${index}]`);
    strictId(metric.id, `Research metric[${index}].id`);
    strictString(metric.value, `Research metric[${index}].value`, 40);
    strictString(metric.label, `Research metric[${index}].label`, 160);
    if (metric.context !== undefined) strictString(metric.context, `Research metric[${index}].context`, 160, 0);
    if (metric.method !== undefined) strictString(metric.method, `Research metric[${index}].method`, 180, 0);
    if (metric.status !== undefined && !["reported", "estimated", "modeled", "derived"].includes(String(metric.status))) throw new Error(`Research metric[${index}].status is unsupported.`);
    strictIds(metric.sourceIds, `Research metric[${index}].sourceIds`, sourceIds);
    return metric;
  });
  uniqueIds(metrics, "Research metric");

  const assets = strictArray(root.assets ?? [], "Research pack assets", 200).map((value, index) => {
    const asset = strictRecord(value, `Research asset[${index}]`);
    exactKeys(asset, ["id", "label", "kind", "file", "sourceIds"], ["start", "crop", "usage", "license", "creator"], `Research asset[${index}]`);
    strictId(asset.id, `Research asset[${index}].id`);
    strictString(asset.label, `Research asset[${index}].label`, 240);
    if (asset.kind !== "image" && asset.kind !== "video") throw new Error(`Research asset[${index}].kind must be image or video.`);
    const file = strictString(asset.file, `Research asset[${index}].file`, 1_024);
    if (file.startsWith("/") || file.startsWith("\\") || file.split(/[\\/]/).some((segment) => segment === "..")) throw new Error(`Research asset[${index}].file must stay project-local.`);
    if (asset.start !== undefined && (typeof asset.start !== "number" || !Number.isFinite(asset.start) || asset.start < 0 || asset.start > 86_400)) throw new Error(`Research asset[${index}].start is outside the supported range.`);
    if (asset.crop !== undefined) {
      const crop = strictRecord(asset.crop, `Research asset[${index}].crop`);
      exactKeys(crop, ["x", "y", "width", "height"], [], `Research asset[${index}].crop`);
      const values = [crop.x, crop.y, crop.width, crop.height];
      if (values.some((number) => typeof number !== "number" || !Number.isFinite(number)) || (crop.x as number) < 0 || (crop.y as number) < 0 || (crop.width as number) <= 0 || (crop.height as number) <= 0 || (crop.x as number) + (crop.width as number) > 1 || (crop.y as number) + (crop.height as number) > 1) throw new Error(`Research asset[${index}].crop must be a normalized rectangle inside the source.`);
    }
    if (asset.usage !== undefined && asset.usage !== "evidence" && asset.usage !== "illustrative") throw new Error(`Research asset[${index}].usage is unsupported.`);
    if (asset.license !== undefined) strictString(asset.license, `Research asset[${index}].license`, 240, 0);
    if (asset.creator !== undefined) strictString(asset.creator, `Research asset[${index}].creator`, 240, 0);
    strictIds(asset.sourceIds, `Research asset[${index}].sourceIds`, sourceIds);
    return asset;
  });
  uniqueIds(assets, "Research asset");

  return value as ResearchPack;
}

export function validateResearchPack(value: unknown): ResearchPack {
  if (!value || typeof value !== "object") throw new Error("Research pack must be an object.");
  const pack = value as ResearchPack;
  if (pack.format !== "cut-research" || pack.version !== 1 || typeof pack.topic !== "string" || !pack.topic.trim()) throw new Error("Unsupported or invalid research pack.");
  if (!Array.isArray(pack.sources) || !pack.sources.length || pack.sources.length > 200 || !Array.isArray(pack.claims) || !pack.claims.length || pack.claims.length > 1_000) throw new Error("Research pack has invalid source or claim counts.");
  const sourceIds = new Set(pack.sources.map((source) => source.id));
  if (sourceIds.size !== pack.sources.length) throw new Error("Research source IDs must be unique.");
  for (const source of pack.sources) {
    if (!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(source.id) || typeof source.title !== "string" || typeof source.publisher !== "string" || (source.shortLabel !== undefined && (typeof source.shortLabel !== "string" || source.shortLabel.length > 30)) || typeof source.retrievedAt !== "string") throw new Error(`Invalid research source: ${source.id}`);
    const url = new URL(source.url);
    if (url.protocol !== "https:") throw new Error(`Research source must use HTTPS: ${source.id}`);
  }
  const claimIds = new Set(pack.claims.map((claim) => claim.id));
  if (claimIds.size !== pack.claims.length) throw new Error("Research claim IDs must be unique.");
  for (const claim of pack.claims) if (!claim.text.trim() || !claim.sourceIds.length || claim.sourceIds.some((id) => !sourceIds.has(id))) throw new Error(`Claim ${claim.id} lacks valid provenance.`);
  const locationIds = new Set((pack.locations ?? []).map((location) => location.id));
  for (const location of pack.locations ?? []) if (!Number.isFinite(location.latitude) || location.latitude < -90 || location.latitude > 90 || !Number.isFinite(location.longitude) || location.longitude < -180 || location.longitude > 180 || location.sourceIds.some((id) => !sourceIds.has(id))) throw new Error(`Invalid research location: ${location.id}`);
  const seriesIds = new Set((pack.series ?? []).map((series) => series.id));
  for (const series of pack.series ?? []) if (!series.labels.length || series.labels.length !== series.values.length || series.labels.length > 20 || series.values.some((value) => !Number.isFinite(value)) || (series.highlight !== undefined && (!Number.isInteger(series.highlight) || series.highlight < 0 || series.highlight >= series.values.length)) || series.sourceIds.some((id) => !sourceIds.has(id))) throw new Error(`Invalid research series: ${series.id}`);
  const timelineIds = new Set((pack.timelines ?? []).map((timeline) => timeline.id));
  for (const timeline of pack.timelines ?? []) if (!timeline.events.length || timeline.events.length > 12 || timeline.events.some((event) => event.claimIds.some((id) => !claimIds.has(id)))) throw new Error(`Invalid research timeline: ${timeline.id}`);
  if (locationIds.size !== (pack.locations ?? []).length || seriesIds.size !== (pack.series ?? []).length || timelineIds.size !== (pack.timelines ?? []).length) throw new Error("Research data IDs must be unique within their types.");
  const metricIds = new Set((pack.metrics ?? []).map((metric) => metric.id));
  for (const metric of pack.metrics ?? []) if (!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(metric.id) || !metric.value?.trim() || metric.value.length > 40 || !metric.label?.trim() || metric.label.length > 160 || (metric.context !== undefined && metric.context.length > 160) || (metric.method !== undefined && metric.method.length > 180) || (metric.status !== undefined && !["reported", "estimated", "modeled", "derived"].includes(metric.status)) || metric.sourceIds.some((id) => !sourceIds.has(id))) throw new Error(`Invalid research metric: ${metric.id}`);
  if (metricIds.size !== (pack.metrics ?? []).length) throw new Error("Research metric IDs must be unique.");
  const assetIds = new Set((pack.assets ?? []).map((asset) => asset.id));
  for (const asset of pack.assets ?? []) {
    const crop = asset.crop;
    if (!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(asset.id) || !asset.label?.trim() || !["image", "video"].includes(asset.kind) || (asset.usage !== undefined && !["evidence", "illustrative"].includes(asset.usage)) || !asset.file?.trim() || asset.file.startsWith("/") || asset.file.includes("..") || (asset.start !== undefined && (!Number.isFinite(asset.start) || asset.start < 0 || asset.start > 86_400)) || (crop && (![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0 || crop.x + crop.width > 1 || crop.y + crop.height > 1)) || !asset.sourceIds.length || asset.sourceIds.some((id) => !sourceIds.has(id))) throw new Error(`Invalid research asset: ${asset.id}`);
  }
  if (assetIds.size !== (pack.assets ?? []).length) throw new Error("Research asset IDs must be unique.");
  return pack;
}
