export type DiagnosticLevel = "error" | "warning" | "info";

export type Diagnostic = {
  line: number;
  level: DiagnosticLevel;
  message: string;
  hint?: string;
};

export type SourceDeclaration = {
  name: string;
  path: string;
  line: number;
};

export type StoryDirective =
  | { kind: "hook"; query: string; before: number; line: number }
  | { kind: "beat"; name: string; query: string; duration?: number; line: number }
  | { kind: "rule"; name: string; value?: string; line: number }
  | { kind: "caption"; style: string; line: number }
  | { kind: "music"; instruction: string; line: number }
  | { kind: "operation"; name: string; instruction: string; line: number }
  | { kind: "assertion"; name: string; value?: string; line: number };

export type ExportDeclaration = {
  name: string;
  width: number;
  height: number;
  duration?: number;
  line: number;
};

export type CutProgram = {
  project: string;
  duration: number;
  sources: SourceDeclaration[];
  directives: StoryDirective[];
  exports: ExportDeclaration[];
};

export type MediaMoment = {
  id: string;
  source: string;
  start: number;
  end: number;
  transcript: string;
  visual: string;
  emotion: "quiet" | "tense" | "hopeful" | "energetic" | "reflective";
  salience: number;
  speaker?: string;
};

export type TimelineClip = MediaMoment & {
  timelineStart: number;
  timelineEnd: number;
  role: "hook" | "problem" | "turn" | "proof" | "resolution" | "broll";
  rationale: string;
  sourceLine: number;
  color: string;
};

export type CompileResult = {
  program: CutProgram | null;
  diagnostics: Diagnostic[];
  clips: TimelineClip[];
  duration: number;
  model: string;
  buildId: string;
};

export type MediaAsset = {
  id: string;
  sourceName: string;
  path: string;
  sha256: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  scenes: Array<{
    id: string;
    start: number;
    end: number;
    visual?: {
      description: string;
      subjects: string[];
      setting: string;
      composition: string;
      camera: string;
      motion: string;
      visibleText: string;
      usability: "hero" | "broll" | "transition" | "weak";
      confidence: number;
    };
  }>;
  transcript?: Array<{
    id: string;
    start: number;
    end: number;
    text: string;
    speaker?: string;
    words?: Array<{ start: number; end: number; word: string }>;
  }>;
};

export type MediaIndex = {
  version: 1;
  createdAt: string;
  root: string;
  assets: MediaAsset[];
  indexHash: string;
};

export type VerificationResult = {
  rule: string;
  status: "pass" | "fail" | "warn";
  message: string;
  clipIds?: string[];
};

export type BuildArtifact = {
  format: "cut-ir";
  version: 2;
  buildId: string;
  sourceHash: string;
  indexHash: string;
  compiler: string;
  program: CutProgram;
  clips: TimelineClip[];
  duration: number;
  verification: VerificationResult[];
  provenance: Array<{
    clipId: string;
    source: string;
    sourceStart: number;
    sourceEnd: number;
    sourceLine: number;
    rationale: string;
  }>;
};
