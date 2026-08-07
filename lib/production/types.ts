export type ProductionTheme = {
  fontFile: string;
  monoFontFile: string;
  background: string;
  foreground: string;
  muted: string;
  accent: string;
  signal: string;
};

export type ProductionShot = {
  source?: string;
  kind?: "video" | "image" | "title" | "metric" | "chart" | "timeline" | "map" | "flow-map" | "network" | "causal-map";
  start?: number;
  crop?: { x: number; y: number; width: number; height: number };
  duration: number;
  title?: string;
  subtitle?: string;
  motion?: "none" | "source" | "push" | "pull" | "reveal" | "flow";
  composition?: "editorial" | "hero" | "evidence-left" | "evidence-right" | "minimal";
  citations?: Array<{ label: string; url: string }>;
  graphic?: {
    kicker?: string;
    body?: string;
    metric?: { value: string; label: string; context?: string; method?: string; sourceLabel?: string; status?: "reported" | "estimated" | "modeled" | "derived" };
    chart?: { labels: string[]; values: number[]; unit?: string; context?: string; highlight?: number };
    timeline?: { events: Array<{ date: string; label: string }> };
    map?: {
      points?: Array<{ latitude: number; longitude: number; label: string; emphasis?: boolean }>;
      routes?: Array<{ from: [number, number]; to: [number, number]; label?: string }>;
    };
    network?: {
      nodes: Array<{ id: string; label: string; metric: { value: string; label: string; context?: string; method?: string; sourceLabel?: string; status?: "reported" | "estimated" | "modeled" | "derived" } }>;
      edges: Array<{ fromId: string; toId: string; label?: string }>;
    };
  };
};

export type ProductionNarration = {
  text: string;
  start: number;
  audio?: string;
  voice?: string;
  rate?: number;
};

export type ProductionPlan = {
  format: "cut-production";
  version: 1;
  title: string;
  canvas: { width: number; height: number; fps: number };
  theme: ProductionTheme;
  shots: ProductionShot[];
  narration?: ProductionNarration[];
  audio?: {
    narrationVoice?: string;
    narrationRate?: number;
    dialogueLufs?: number;
    masterLufs?: number;
    truePeakDb?: number;
    music?: {
      kind: "procedural-tone";
      frequencies: number[];
      volume: number;
      fadeIn?: number;
      fadeOut?: number;
      impactOnCuts?: boolean;
    };
  };
  captions?: { enabled: boolean; burn?: boolean; fontSize?: number; margin?: number };
  output?: { filename?: string; thumbnail?: { sourceShot: number; title: string; emphasis?: string; strapline?: string } };
};

export type ProductionManifest = {
  format: "cut-production-manifest";
  version: 1;
  title: string;
  duration: number;
  planHash: string;
  export: { file: string; width: number; height: number; fps: number; video: string; audio: string };
  sources: Array<{ file: string; sha256: string }>;
  shots: Array<ProductionShot & { order: number }>;
  narration: Array<ProductionNarration & { duration: number }>;
};
