import type { MediaMoment } from "./types";

export const demoSource = `# Cut v0.1 — the film is a program
project "One impossible week"

source "Founder interview" from "interview.mov"
source "Workshop rushes" from "workshop/*.mov"
source "Launch day" from "launch/*.mov"

story "From doubt to first flight" in 42s:
  hook strongest surprising claim before 3s
  beat problem: the moment the plan looked impossible for 9s
  beat turn: the decision to try anyway for 8s
  beat proof: machine moving for the first time for 12s
  beat resolution: quiet human reaction for 8s

  rule preserve_meaning
  rule no_synthetic_quotes
  rule avoid_jump_cuts
  captions editorial lower-third
  music restrained, rising after proof

export vertical 1080x1920 in 42s
export landscape 1920x1080 in 60s`;

export const demoMoments: MediaMoment[] = [
  { id: "m01", source: "Founder interview", start: 18.2, end: 22.8, transcript: "Everyone told us the machine would take a year. We had seven days.", visual: "Mara, direct to camera; workshop lights behind her", emotion: "tense", salience: 0.99, speaker: "Mara" },
  { id: "m02", source: "Workshop rushes", start: 4.0, end: 9.8, transcript: "", visual: "Empty workbench at dawn; untouched components", emotion: "quiet", salience: 0.72 },
  { id: "m03", source: "Founder interview", start: 41.4, end: 48.6, transcript: "By Tuesday, the arm still could not find the part. That was the moment I thought we were done.", visual: "Mara looks away, then back toward lens", emotion: "reflective", salience: 0.91, speaker: "Mara" },
  { id: "m04", source: "Workshop rushes", start: 63.0, end: 69.2, transcript: "", visual: "Robot arm misses component; team freezes", emotion: "tense", salience: 0.94 },
  { id: "m05", source: "Founder interview", start: 72.1, end: 77.4, transcript: "We stopped trying to make it perfect. We made it learn from every miss.", visual: "Tight profile; monitor reflections", emotion: "hopeful", salience: 0.96, speaker: "Mara" },
  { id: "m06", source: "Workshop rushes", start: 114.0, end: 121.5, transcript: "", visual: "Hands annotate failures; rapid cuts of code and calibration", emotion: "energetic", salience: 0.87 },
  { id: "m07", source: "Launch day", start: 16.3, end: 25.7, transcript: "", visual: "Robot recognizes component, reaches, and locks it into place", emotion: "energetic", salience: 1.0 },
  { id: "m08", source: "Launch day", start: 27.0, end: 31.8, transcript: "Did it just—? It did.", visual: "Engineer laughs in disbelief; room remains still", emotion: "hopeful", salience: 0.95, speaker: "Noah" },
  { id: "m09", source: "Founder interview", start: 96.0, end: 101.9, transcript: "The important part was not that it worked. It was that we finally knew how to teach it.", visual: "Mara alone beside the machine after launch", emotion: "reflective", salience: 0.98, speaker: "Mara" },
];
