import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { BuildArtifact, MediaIndex } from "../types";

const run = promisify(execFile);

function assetPath(index: MediaIndex, source: string): string {
  const asset = index.assets.find((item) => item.sourceName === source);
  if (!asset) throw new Error(`Build references unknown source: ${source}`);
  const root = index.assets.length === 1 && basename(index.root) === asset.path ? dirname(index.root) : index.root;
  const path = resolve(root, asset.path);
  const local = relative(root, path);
  if (local.startsWith("..") || isAbsolute(local)) throw new Error(`Locked asset escapes the media root: ${asset.path}`);
  return path;
}

async function sha256(path: string): Promise<string> {
  return new Promise((accept, reject) => {
    const digest = createHash("sha256");
    createReadStream(path).on("data", (chunk) => digest.update(chunk)).on("error", reject).on("end", () => accept(digest.digest("hex")));
  });
}

function srtTime(seconds: number) {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1000);
  const ms = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

export function createCaptions(build: BuildArtifact, index: MediaIndex) {
  const cues: Array<{ start: number; end: number; text: string }> = [];
  for (const clip of build.clips) {
    const asset = index.assets.find((item) => item.sourceName === clip.source);
    const words = (asset?.transcript ?? []).flatMap((segment) => segment.words ?? []).filter((word) => word.end > clip.start && word.start < clip.end);
    for (let offset = 0; offset < words.length; offset += 5) {
      const phrase = words.slice(offset, offset + 5);
      if (!phrase.length) continue;
      cues.push({
        start: clip.timelineStart + Math.max(0, phrase[0].start - clip.start),
        end: Math.min(clip.timelineEnd, clip.timelineStart + phrase.at(-1)!.end - clip.start),
        text: phrase.map((word) => word.word.trim()).join(" ").replaceAll("-->", "→"),
      });
    }
  }
  return cues.map((cue, index) => `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(Math.max(cue.start + .25, cue.end))}\n${cue.text}\n`).join("\n");
}

export async function renderArtifact(build: BuildArtifact, index: MediaIndex, output: string): Promise<void> {
  if (!build.clips.length) throw new Error("Build contains no clips.");
  const failures = build.verification.filter((result) => result.status === "fail");
  if (failures.length) throw new Error(`Refusing to render a failed build: ${failures.map((result) => result.rule).join(", ")}`);
  const target = build.program.exports[0] ?? { width: 1920, height: 1080 };
  const temp = await mkdtemp(join(tmpdir(), "cut-render-"));
  const parts: string[] = [];
  const verified = new Set<string>();
  for (let i = 0; i < build.clips.length; i += 1) {
    const clip = build.clips[i];
    const input = assetPath(index, clip.source);
    if (!verified.has(input)) {
      const asset = index.assets.find((item) => item.sourceName === clip.source)!;
      if (await sha256(input) !== asset.sha256) throw new Error(`Asset changed after ingest: ${asset.path}. Run cut ingest again.`);
      verified.add(input);
    }
    const part = join(temp, `${String(i).padStart(4, "0")}.mp4`);
    const duration = clip.timelineEnd - clip.timelineStart;
    const asset = index.assets.find((item) => item.sourceName === clip.source)!;
    const args = ["-y", "-v", "error", "-ss", clip.start.toFixed(3), "-t", duration.toFixed(3), "-i", input];
    if (!asset.hasAudio) args.push("-f", "lavfi", "-t", duration.toFixed(3), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000", "-map", "0:v:0", "-map", "1:a:0");
    args.push("-vf", `scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease,pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`);
    if (asset.hasAudio) args.push("-af", "loudnorm=I=-16:LRA=11:TP=-1.5");
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-c:a", "aac", "-ar", "48000", "-shortest", part);
    await run("ffmpeg", args, { maxBuffer: 8_000_000, timeout: 180_000 });
    parts.push(part);
  }
  const concat = join(temp, "concat.txt");
  await writeFile(concat, parts.map((part) => `file '${part.replaceAll("'", "'\\''")}'`).join("\n"));
  const wantsCaptions = build.program.directives.some((item) => item.kind === "caption");
  const captions = wantsCaptions ? createCaptions(build, index) : "";
  const assembled = captions ? join(temp, "assembled.mp4") : output;
  await run("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", concat, "-c", "copy", assembled], { maxBuffer: 8_000_000, timeout: 180_000 });
  if (captions) {
    const subtitle = join(temp, "captions.srt");
    const sidecar = output.replace(/\.[^.]+$/, ".srt");
    await Promise.all([writeFile(subtitle, captions), writeFile(sidecar, captions)]);
    const escaped = subtitle.replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("'", "\\'");
    await run("ffmpeg", ["-y", "-v", "error", "-i", assembled, "-vf", `subtitles=filename='${escaped}':force_style='FontName=Arial,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00101010,BorderStyle=1,Outline=3,Shadow=0,Alignment=2,MarginV=52'`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-c:a", "copy", "-movflags", "+faststart", output], { maxBuffer: 8_000_000, timeout: 180_000 });
  }
}
