import { createReadStream } from "node:fs";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MediaAsset, MediaIndex } from "../types";
import { hash } from "./stable";

const run = promisify(execFile);
const extensions = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v"]);

export function mediaIndexHash(index: Pick<MediaIndex, "assets">) {
  return hash(index.assets.map(({ path, sha256, duration, scenes, transcript }) => ({ path, sha256, duration, scenes, transcript })));
}

async function filesWithin(path: string): Promise<string[]> {
  const info = await stat(path);
  if (info.isFile()) return extensions.has(extname(path).toLowerCase()) ? [path] : [];
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => filesWithin(resolve(path, entry.name))));
  return nested.flat().sort();
}

async function fileHash(path: string): Promise<string> {
  return new Promise((accept, reject) => {
    const digest = createHash("sha256");
    createReadStream(path).on("data", (chunk) => digest.update(chunk)).on("error", reject).on("end", () => accept(digest.digest("hex")));
  });
}

async function probe(path: string) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,r_frame_rate", "-of", "json", path], { maxBuffer: 4_000_000, timeout: 30_000 });
  const data = JSON.parse(stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type: string; width?: number; height?: number; r_frame_rate?: string }> };
  const video = data.streams?.find((stream) => stream.codec_type === "video");
  const [numerator, denominator] = (video?.r_frame_rate ?? "0/1").split("/").map(Number);
  return {
    duration: Number(data.format?.duration ?? 0), width: video?.width ?? 0, height: video?.height ?? 0,
    fps: denominator ? numerator / denominator : 0, hasAudio: Boolean(data.streams?.some((stream) => stream.codec_type === "audio")),
  };
}

async function detectScenes(path: string, duration: number) {
  if (duration <= 0) return [];
  try {
    const { stderr } = await run("ffmpeg", ["-hide_banner", "-i", path, "-filter:v", "select='gt(scene,0.14)',showinfo", "-an", "-f", "null", "-"], { maxBuffer: 16_000_000, timeout: 120_000 });
    const cuts = [...stderr.matchAll(/pts_time:([0-9.]+)/g)].map((match) => Number(match[1])).filter((time) => time > .15 && time < duration - .15);
    const boundaries = [0, ...new Set(cuts), duration].sort((a, b) => a - b);
    return boundaries.slice(0, -1).map((start, index) => ({ id: `s${String(index + 1).padStart(3, "0")}`, start, end: boundaries[index + 1] }));
  } catch {
    return [{ id: "s001", start: 0, end: duration }];
  }
}

export async function createMediaIndex(input: string): Promise<MediaIndex> {
  const root = resolve(input);
  const paths = await filesWithin(root);
  if (!paths.length) throw new Error(`No supported video files found in ${root}`);
  const assets: MediaAsset[] = [];
  for (const path of paths) {
    const [sha256, metadata] = await Promise.all([fileHash(path), probe(path)]);
    assets.push({ id: sha256.slice(0, 12), sourceName: basename(path), path: relative(root, path) || basename(path), sha256, ...metadata, scenes: await detectScenes(path, metadata.duration) });
  }
  const indexHash = mediaIndexHash({ assets });
  return { version: 1, createdAt: new Date().toISOString(), root, assets, indexHash };
}

function pathForAsset(index: MediaIndex, asset: MediaAsset) {
  const base = index.assets.length === 1 && basename(index.root) === asset.path ? dirname(index.root) : index.root;
  return resolve(base, asset.path);
}

export async function transcribeMediaIndex(index: MediaIndex, apiKey: string): Promise<MediaIndex> {
  for (const asset of index.assets) {
    if (!asset.hasAudio) continue;
    const temp = await mkdtemp(join(tmpdir(), "cut-transcribe-"));
    const audioPath = join(temp, `${asset.id}.mp3`);
    await run("ffmpeg", ["-y", "-v", "error", "-i", pathForAsset(index, asset), "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", audioPath], { maxBuffer: 8_000_000, timeout: 120_000 });
    const audio = new Uint8Array(await readFile(audioPath));
    const form = new FormData();
    form.append("file", new Blob([audio], { type: "audio/mpeg" }), `${asset.id}.mp3`);
    form.append("model", "whisper-1");
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    form.append("timestamp_granularities[]", "word");
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Transcription failed for ${asset.path}: ${response.status} ${await response.text()}`);
    const data = await response.json() as { segments?: Array<{ id?: number; start: number; end: number; text: string }>; words?: Array<{ start: number; end: number; word: string }> };
    asset.transcript = (data.segments ?? []).map((segment, segmentIndex) => ({
      id: `t${String(segment.id ?? segmentIndex + 1).padStart(4, "0")}`, start: segment.start, end: segment.end, text: segment.text.trim(),
      words: (data.words ?? []).filter((word) => word.end > segment.start && word.start < segment.end),
    }));
  }
  index.indexHash = mediaIndexHash(index);
  return index;
}
