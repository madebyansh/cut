import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type CutProjectManifest = {
  format: "cut-project";
  version: 1;
  name: string;
  language: "0.4";
  entry: string;
  directories: {
    media: string;
    cache: string;
    output: string;
  };
  defaults: {
    width: number;
    height: number;
    fps: string;
    sampleRate: number;
  };
};

export class CutProjectError extends Error {
  constructor(readonly code: string, message: string, readonly path?: string) {
    super(message);
    this.name = "CutProjectError";
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CutProjectError("CUTP1001", `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: string[], label: string) {
  const extras = Object.keys(value).filter((key) => !expected.includes(key)).sort();
  const missing = expected.filter((key) => !(key in value));
  if (missing.length) throw new CutProjectError("CUTP1002", `${label} is missing ${missing.join(", ")}.`);
  if (extras.length) throw new CutProjectError("CUTP1003", `${label} has unknown field(s): ${extras.join(", ")}.`);
}

export function validateProjectLocator(value: unknown, label: string) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\") || isAbsolute(value)) {
    throw new CutProjectError("CUTP1004", `${label} must be a non-empty project-relative POSIX path.`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new CutProjectError("CUTP1004", `${label} cannot contain empty, dot, or parent segments.`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string, maximum: number) {
  if (!Number.isInteger(value) || Number(value) <= 0 || Number(value) > maximum) {
    throw new CutProjectError("CUTP1005", `${label} must be an integer from 1 to ${maximum}.`);
  }
  return Number(value);
}

export function validateCutProjectManifest(value: unknown): CutProjectManifest {
  const root = record(value, "project manifest");
  exactKeys(root, ["format", "version", "name", "language", "entry", "directories", "defaults"], "project manifest");
  if (root.format !== "cut-project" || root.version !== 1) throw new CutProjectError("CUTP1006", "Unsupported CUT project manifest format or version.");
  if (typeof root.name !== "string" || !root.name.trim() || root.name.length > 80) throw new CutProjectError("CUTP1007", "Project name must contain 1 to 80 characters.");
  if (root.language !== "0.4") throw new CutProjectError("CUTP1008", "This alpha supports project language 0.4 only.");
  const entry = validateProjectLocator(root.entry, "entry");
  if (!entry.endsWith(".cut")) throw new CutProjectError("CUTP1009", "Project entry must end in .cut.");

  const directories = record(root.directories, "directories");
  exactKeys(directories, ["media", "cache", "output"], "directories");
  const parsedDirectories = {
    media: validateProjectLocator(directories.media, "directories.media"),
    cache: validateProjectLocator(directories.cache, "directories.cache"),
    output: validateProjectLocator(directories.output, "directories.output"),
  };
  if (new Set(Object.values(parsedDirectories)).size !== 3) throw new CutProjectError("CUTP1010", "Project directories must be distinct.");

  const defaults = record(root.defaults, "defaults");
  exactKeys(defaults, ["width", "height", "fps", "sampleRate"], "defaults");
  const fps = typeof defaults.fps === "string" && /^\d+\/[1-9]\d*$/.test(defaults.fps) ? defaults.fps : undefined;
  if (!fps || Number(fps.split("/")[0]) <= 0) throw new CutProjectError("CUTP1011", "defaults.fps must be a positive rational such as 24/1 or 30000/1001.");

  return {
    format: "cut-project",
    version: 1,
    name: root.name,
    language: "0.4",
    entry,
    directories: parsedDirectories,
    defaults: {
      width: positiveInteger(defaults.width, "defaults.width", 16384),
      height: positiveInteger(defaults.height, "defaults.height", 16384),
      fps,
      sampleRate: positiveInteger(defaults.sampleRate, "defaults.sampleRate", 384000),
    },
  };
}

export function defaultProjectManifest(name: string): CutProjectManifest {
  return validateCutProjectManifest({
    format: "cut-project",
    version: 1,
    name,
    language: "0.4",
    entry: "main.cut",
    directories: { media: "media", cache: ".cut", output: "output" },
    defaults: { width: 1920, height: 1080, fps: "24/1", sampleRate: 48000 },
  });
}

function starterSource(name: string) {
  return `cut 0.4;

project ${JSON.stringify(name)};

import { Circle, Rect } from "cut:visual";

import { Gain, Limiter, Tone } from "@cut/audio";

import { linear, outCubic } from "@cut/motion";

timeline main(duration: 3s, fps: 24, width: 1920px, height: 1080px, sampleRate: 48khz) {
  scene card(duration: 3s) {
    Rect(width: 1920px, height: 1080px, x: 960px, y: 540px, fill: #071019);
    Circle(radius: 180px, x: 960px, y: 540px, fill: #55d6be) as pulse;
    animate pulse.scale from 0.7 to 1.15 over 3s ease outCubic;
    animate pulse.opacity from 35% to 100% over 3s ease linear;
    Limiter(ceiling: -1dbtp) {
      Gain(amount: -12db) {
        Tone(frequency: 220hz, duration: 3s, amplitude: 18%, fadeIn: 20ms, fadeOut: 120ms);
      }
    }
  }
  assert timelineDurationIs(main, 3s), "release timeline is exactly three seconds";
}

timeline previewTimeline(duration: 3s, fps: 24, width: 960px, height: 540px, sampleRate: 48khz) {
  scene card(duration: 3s) {
    Rect(width: 960px, height: 540px, x: 480px, y: 270px, fill: #071019);
    Circle(radius: 90px, x: 480px, y: 270px, fill: #55d6be) as pulse;
    animate pulse.scale from 0.7 to 1.15 over 3s ease outCubic;
    animate pulse.opacity from 35% to 100% over 3s ease linear;
    Limiter(ceiling: -1dbtp) {
      Gain(amount: -12db) {
        Tone(frequency: 220hz, duration: 3s, amplitude: 18%, fadeIn: 20ms, fadeOut: 120ms);
      }
    }
  }
}

export preview = render(previewTimeline, width: 960px, height: 540px, codec: "h264");

export release = render(main, width: 1920px, height: 1080px, codec: "h264");
`;
}

function starterReadme(name: string) {
  return `# ${name}

This project was created by CUT. The canonical edit is \`main.cut\`.

With \`cut-lang\` installed in this directory or a parent directory, these
commands resolve the local binary without downloading anything:

\`\`\`bash
npx --no-install cut fmt main.cut --check
npx --no-install cut check main.cut
npx --no-install cut lint main.cut --deny-warnings
npx --no-install cut lock main.cut --out cut.lock
npx --no-install cut inspect main.cut --lock cut.lock --json
npx --no-install cut test main.cut --lock cut.lock --json
npx --no-install cut preview main.cut --lock cut.lock
npx --no-install cut render main.cut --lock cut.lock --output release --out output/release.mp4
\`\`\`

For a local tarball, install it without lifecycle scripts in this project or
its parent: \`npm install --ignore-scripts /path/to/cut-lang-<version>.tgz\`.
If CUT is installed globally, \`cut\` may replace \`npx --no-install cut\`.

Media belongs in \`media/\`; generated caches and renders belong in \`.cut/\`
and \`output/\` and are not canonical source.
`;
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function pathExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function projectRoot(directory: string) {
  const requested = resolve(directory);
  try {
    return await realpath(requested);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
      throw new CutProjectError("CUTP1017", `Project root does not exist: ${requested}`, requested);
    }
    throw new CutProjectError(
      "CUTP1017",
      `Cannot resolve project root: ${error instanceof Error ? error.message : String(error)}`,
      requested,
    );
  }
}

export async function createCutProject(directory: string, requestedName?: string) {
  const root = resolve(directory);
  const name = (requestedName ?? basename(root)).trim();
  const manifest = defaultProjectManifest(name);
  const parent = dirname(root);

  await mkdir(parent, { recursive: true });
  if (await pathExists(root)) {
    throw new CutProjectError("CUTP1012", "Project initialization refuses to overwrite an existing target.", root);
  }

  // Build the complete project out of sight. Publishing is one directory
  // rename, so observers see either no project or the entire deterministic
  // project. On any failure, cleanup is confined to the staging directory that
  // this invocation created.
  const staging = await mkdtemp(resolve(parent, `.${basename(root)}.cut-init-`));
  let published = false;
  try {
    await Promise.all(Object.values(manifest.directories).map((path) => mkdir(resolve(staging, path), { recursive: true })));
    await Promise.all([
      writeFile(resolve(staging, "cut.project.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" }),
      writeFile(resolve(staging, manifest.entry), starterSource(name), { flag: "wx" }),
      writeFile(resolve(staging, ".gitignore"), ".cut/\noutput/\n", { flag: "wx" }),
      writeFile(resolve(staging, "README.md"), starterReadme(name), { flag: "wx" }),
    ]);

    // Recheck immediately before publish. rename() also refuses an existing
    // non-empty directory; translate all destination collisions into the
    // stable project error rather than leaking platform-specific errno values.
    if (await pathExists(root)) {
      throw new CutProjectError("CUTP1012", "Project initialization refuses to overwrite an existing target.", root);
    }
    try {
      await rename(staging, root);
    } catch (error) {
      if (["EEXIST", "ENOTEMPTY", "EISDIR", "ENOTDIR"].includes(errorCode(error) ?? "")) {
        throw new CutProjectError("CUTP1012", "Project initialization refuses to overwrite an existing target.", root);
      }
      throw error;
    }
    published = true;
    return { root, manifest };
  } finally {
    if (!published) await rm(staging, { recursive: true, force: true });
  }
}

export async function loadCutProject(directory: string) {
  const root = await projectRoot(directory);
  const path = await resolveProjectFile(root, "cut.project.json");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new CutProjectError("CUTP1013", `Cannot read a valid cut.project.json: ${error instanceof Error ? error.message : String(error)}`, path);
  }
  const manifest = validateCutProjectManifest(value);
  const entryPath = await resolveProjectFile(root, manifest.entry);
  let entry: { isFile(): boolean };
  try {
    entry = await stat(entryPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
      throw new CutProjectError("CUTP1015", `Project resource does not exist: ${manifest.entry}`, entryPath);
    }
    throw new CutProjectError(
      "CUTP1016",
      `Cannot inspect project entry ${manifest.entry}: ${error instanceof Error ? error.message : String(error)}`,
      entryPath,
    );
  }
  if (!entry.isFile()) {
    throw new CutProjectError("CUTP1018", `Project entry must resolve to a regular file: ${manifest.entry}`, entryPath);
  }
  return { root, path, entryPath, manifest };
}

export async function resolveProjectFile(projectDirectory: string, locator: string) {
  const safe = validateProjectLocator(locator, "resource locator");
  const root = await projectRoot(projectDirectory);
  const requested = resolve(root, safe);
  let candidate: string;
  try {
    candidate = await realpath(requested);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
      throw new CutProjectError("CUTP1015", `Project resource does not exist: ${safe}`, requested);
    }
    throw new CutProjectError(
      "CUTP1016",
      `Cannot resolve project resource ${safe}: ${error instanceof Error ? error.message : String(error)}`,
      requested,
    );
  }
  const fromRoot = relative(root, candidate);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new CutProjectError("CUTP1014", `Resource escapes the project root: ${safe}`, candidate);
  }
  return candidate;
}
