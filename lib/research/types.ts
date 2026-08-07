export type ResearchSource = { id: string; title: string; url: string; publisher: string; shortLabel?: string; retrievedAt: string };
export type ResearchClaim = { id: string; text: string; sourceIds: string[] };
export type ResearchLocation = { id: string; label: string; latitude: number; longitude: number; sourceIds: string[] };
export type ResearchSeries = { id: string; title: string; labels: string[]; values: number[]; unit: string; highlight?: number; sourceIds: string[] };
export type ResearchTimeline = { id: string; events: Array<{ id: string; date: string; label: string; claimIds: string[] }> };
export type ResearchMetric = { id: string; value: string; label: string; context?: string; method?: string; status?: "reported" | "estimated" | "modeled" | "derived"; sourceIds: string[] };
export type ResearchAsset = {
  id: string;
  label: string;
  kind: "image" | "video";
  file: string;
  start?: number;
  crop?: { x: number; y: number; width: number; height: number };
  sourceIds: string[];
  usage?: "evidence" | "illustrative";
  license?: string;
  creator?: string;
};

export type ResearchPack = {
  format: "cut-research";
  version: 1;
  topic: string;
  sources: ResearchSource[];
  claims: ResearchClaim[];
  locations: ResearchLocation[];
  series: ResearchSeries[];
  timelines: ResearchTimeline[];
  metrics?: ResearchMetric[];
  assets?: ResearchAsset[];
};
