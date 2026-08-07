import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import type { CutModule } from "../lib/language/ast";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import { formatCutSource } from "../lib/language/formatter";
import { parseCutLanguage } from "../lib/language/parser";

type ManifestEntry = { path: string; purpose?: string; reason?: string; sha256?: string };
type PublicExamplesManifest = {
  format: string;
  version: number;
  active: ManifestEntry[];
  legacy: ManifestEntry[];
  historical: ManifestEntry[];
};

type Probe = {
  format?: { duration?: string };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    sample_rate?: string;
    channels?: number;
  }>;
};

const repository = resolve(".");
const cli = resolve(repository, "dist-cli/cli/cut.js");
const digest = (source: string | Buffer) => createHash("sha256").update(source).digest("hex");

async function manifest() {
  return JSON.parse(await readFile(resolve(repository, "examples/public-examples.manifest.json"), "utf8")) as PublicExamplesManifest;
}

async function topLevelCutFiles(directory: string) {
  return (await readdir(resolve(repository, directory), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".cut"))
    .map((entry) => `${directory}/${entry.name}`)
    .sort();
}

async function run(command: string, args: string[], cwd = repository, expectedCodes = [0], timeoutMs = 120_000) {
  return new Promise<{ stdout: string; stderr: string }>((accept, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error, result?: { stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else accept(result!);
    };
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) {
        child.kill("SIGKILL");
        finish(new Error(`${command} exceeded the public-example output budget.`));
      } else {
        target.push(Buffer.from(chunk));
      }
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", finish);
    child.on("exit", (code, signal) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code !== null && expectedCodes.includes(code)) finish(undefined, result);
      else finish(new Error(`${command} ${args.join(" ")} exited ${code ?? signal}.\n${result.stderr}${result.stdout}`));
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`${command} ${args.join(" ")} exceeded ${timeoutMs}ms.`));
    }, timeoutMs);
  });
}

function checkedModule(source: string, label: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, `${label}: ${parsed.diagnostics.map((item) => `${item.code} ${item.message}`).join("; ")}`);
  const diagnostics = [...parsed.diagnostics, ...checkCutModule(parsed.module).diagnostics]
    .filter((item) => item.severity === "error");
  assert.deepEqual(diagnostics, [], `${label}: ${diagnostics.map((item) => `${item.code} ${item.message}`).join("; ")}`);
  return parsed.module;
}

function assetLocators(cutModule: CutModule) {
  return cutModule.declarations.flatMap((declaration) => {
    if (declaration.kind !== "asset" || declaration.value.kind !== "call") return [];
    const locator = declaration.value.positional[0];
    return locator?.kind === "string" ? [locator.value] : [];
  });
}

function assertPortableSource(source: string, label: string) {
  assert.doesNotMatch(source, /(?:^|["'])\/(?:Users|System|Library|home|private|var|tmp)\//m, `${label} contains an absolute machine path`);
  assert.doesNotMatch(source, /(?:file:\/\/|[A-Za-z]:\\|\\\\)/, `${label} contains a non-portable locator`);
  const cutModule = checkedModule(source, label);
  for (const locator of assetLocators(cutModule)) {
    assert.equal(isAbsolute(locator), false, `${label} asset locator must be relative: ${locator}`);
    assert.ok(!locator.split("/").includes(".."), `${label} asset locator escapes its project: ${locator}`);
    assert.ok(!locator.includes("\\") && !locator.includes("\0"), `${label} asset locator is not portable: ${locator}`);
  }
  return cutModule;
}

async function lockPublicProgram(program: string, directory: string) {
  await mkdir(directory, { recursive: true });
  // macOS exposes the temporary root through both /var and /private/var.
  // Publish using the resolved spelling that Node also reports as cwd so the
  // lexical ownership check and the physical boundary name the same tree.
  const physicalDirectory = await realpath(directory);
  const stem = basename(program, ".cut");
  const lock = join(physicalDirectory, `${stem}.lock`);
  const output = join(physicalDirectory, `${stem}.mp4`);
  const check = JSON.parse((await run(process.execPath, [cli, "check", program, "--json"])).stdout) as {
    status: string;
    diagnostics: unknown[];
  };
  assert.deepEqual({ status: check.status, diagnostics: check.diagnostics }, { status: "pass", diagnostics: [] });
  // Publication is intentionally confined to the source project or the
  // caller's working directory. These clean-room proofs keep artifacts in a
  // separate temporary workspace, so make that workspace the explicit CLI
  // ownership boundary instead of weakening the production guardrail.
  await run(process.execPath, [cli, "lock", program, "--out", lock], physicalDirectory);
  return { lock, output };
}

async function renderLockedPublicProgram(program: string, lock: string, output: string) {
  await run(process.execPath, [cli, "render", program, "--lock", lock, "--out", output], dirname(output), [0], 180_000);
  assert.ok((await stat(output)).size > 1_000, `${program} render is unexpectedly empty`);
  const probe = JSON.parse((await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,sample_rate,channels",
    "-of", "json",
    output,
  ])).stdout) as Probe;
  assert.ok(Number(probe.format?.duration) > 0, `${program} has no positive decoded duration`);
  const picture = probe.streams?.find((stream) => stream.codec_type === "video");
  const sound = probe.streams?.find((stream) => stream.codec_type === "audio");
  assert.equal(picture?.codec_name, "h264", `${program} has no H.264 picture stream`);
  assert.ok((picture?.width ?? 0) > 0 && (picture?.height ?? 0) > 0, `${program} has no decoded picture dimensions`);
  assert.equal(sound?.codec_name, "aac", `${program} has no AAC audio stream`);
  assert.equal(sound?.sample_rate, "48000", `${program} audio is not 48 kHz`);
  assert.ok((sound?.channels ?? 0) > 0, `${program} has no decoded audio channels`);
}

async function renderPublicProgram(program: string, directory: string) {
  const { lock, output } = await lockPublicProgram(program, directory);
  await renderLockedPublicProgram(program, lock, output);
}

function materializeSnippet(body: string[]) {
  return body.join("\n")
    .replace(/\$\{\d+\|([^|}]*)\|\}/g, (_match, choices: string) => choices.split(",")[0]!)
    .replace(/\$\{\d+:([^}]*)\}/g, "$1")
    .replace(/\$0/g, "");
}

function cutFences(markdown: string) {
  return [...markdown.matchAll(/```cut\s*\n([\s\S]*?)```/g)].map((match) => match[1]!);
}

test("active public examples are exhaustive, checked, compilable, and canonically formatted", async () => {
  const inventory = await manifest();
  assert.equal(inventory.format, "cut-public-examples");
  assert.equal(inventory.version, 1);

  const active = inventory.active.map((entry) => entry.path);
  const legacy = inventory.legacy.map((entry) => entry.path);
  const historical = inventory.historical.map((entry) => entry.path);
  const all = [...active, ...legacy, ...historical];
  assert.equal(new Set(all).size, all.length, "public example classifications must be disjoint");
  assert.deepEqual(
    [...active.filter((path) => path.startsWith("examples/")), ...legacy].sort(),
    await topLevelCutFiles("examples"),
    "every top-level example CUT source must be classified as active or legacy",
  );
  const packageJson = JSON.parse(await readFile(resolve(repository, "package.json"), "utf8")) as { files: string[] };
  const packagedPrograms = packageJson.files.filter((entry) => entry.endsWith(".cut")).sort();
  assert.deepEqual(packagedPrograms, [
    "examples/agent-guide-pulse.cut",
    "examples/local-motion-path-camera.cut",
    "examples/product-card-effects.cut",
  ]);
  assert.ok(packagedPrograms.every((path) => active.includes(path)), "every packed CUT program must be active");

  for (const entry of inventory.active) {
    assert.ok(entry.purpose, `${entry.path} needs a public purpose`);
    const source = await readFile(resolve(repository, entry.path), "utf8");
    assert.equal(formatCutSource(source), source, `${entry.path} is not canonically formatted`);
    const cutModule = assertPortableSource(source, entry.path);
    assert.doesNotThrow(() => compileCutModule(cutModule), `${entry.path} did not compile`);
  }
});

test("all active examples lock and the shipped/demo surface passes real render-probe", { timeout: 360_000 }, async () => {
  const inventory = await manifest();
  const packageJson = JSON.parse(await readFile(resolve(repository, "package.json"), "utf8")) as { files: string[] };
  const renderPaths = new Set(packageJson.files.filter((entry) => entry.endsWith(".cut")));
  assert.ok([...renderPaths].every((path) => inventory.active.some((entry) => entry.path === path)), "every mandatory render must be active");
  const workspace = await mkdtemp(join(tmpdir(), "cut-public-examples-"));
  try {
    for (const entry of inventory.active) {
      const program = resolve(repository, entry.path);
      const { lock, output } = await lockPublicProgram(program, join(workspace, entry.path.replaceAll("/", "-")));
      if (renderPaths.has(entry.path)) {
        await renderLockedPublicProgram(program, lock, output);
      }
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("cut init and the VS Code project snippet produce portable renderable programs", { timeout: 240_000 }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cut-public-starters-"));
  try {
    await run(process.execPath, [cli, "init", "generated", "--name", "Generated public starter"], workspace);
    const generatedEntry = join(workspace, "generated", "main.cut");
    assertPortableSource(await readFile(generatedEntry, "utf8"), "cut init starter");
    await renderPublicProgram(generatedEntry, join(workspace, "generated-proof"));

    const snippets = JSON.parse(await readFile(resolve(repository, "editors/vscode/snippets/cut.code-snippets"), "utf8")) as Record<string, { body: string[] }>;
    const snippetSource = materializeSnippet(snippets["CUT project"]!.body);
    assertPortableSource(snippetSource, "VS Code CUT project snippet");
    await run(process.execPath, [cli, "init", "snippet", "--name", "VS Code snippet host"], workspace);
    const snippetEntry = join(workspace, "snippet", "main.cut");
    await writeFile(snippetEntry, snippetSource, "utf8");
    await renderPublicProgram(snippetEntry, join(workspace, "snippet-proof"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("every public documentation CUT fence is explicitly classified", async () => {
  type Classification = "checked-program" | "fragment";
  const expected: Readonly<Record<string, readonly Classification[]>> = {
    "README.md": ["checked-program"],
    "docs/AGENT_GUIDE.md": ["checked-program", "fragment", "fragment", "fragment", "fragment", "fragment", "fragment", "fragment", "fragment", "fragment", "fragment", "fragment", "fragment"],
    "docs/AUDIO_REACTIVE.md": ["checked-program"],
    "docs/AUDIO_STEMS.md": ["checked-program", "fragment", "fragment", "fragment", "fragment", "fragment"],
    "docs/AUDIO_REGIONS.md": ["checked-program", "fragment", "fragment"],
    "docs/AUDIO_TIME_STRETCH.md": ["fragment", "fragment"],
    "docs/CAPTIONS.md": ["fragment"],
    "docs/CALLOUT_LAYOUT.md": ["checked-program", "fragment", "fragment"],
    "docs/CAMERA3D.md": ["fragment"],
    "docs/CHARTS.md": ["checked-program", "fragment"],
    "docs/CHROMA_KEY.md": ["fragment"],
    "docs/COLOR.md": ["fragment", "fragment", "fragment"],
    "docs/DATA_LAYOUT.md": ["fragment", "checked-program"],
    "docs/DIAGRAM_LAYOUT.md": ["fragment", "fragment"],
    "docs/DEESSER.md": ["fragment"],
    "docs/EDITORIAL_AUDIO_OPERATIONS.md": ["fragment"],
    "docs/EDITORIAL_AUDIO_TRACK.md": ["fragment", "fragment", "fragment"],
    "docs/EDITORIAL_ANNOTATIONS.md": ["checked-program", "fragment"],
    "docs/EDITORIAL_OPERATIONS.md": ["fragment", "fragment", "fragment"],
    "docs/EDITORIAL_SEQUENCE.md": ["fragment"],
    "docs/EDITORIAL_TIME_MAP.md": ["fragment"],
    "docs/EDITORIAL_TRANSITIONS.md": ["fragment", "fragment", "fragment"],
    "docs/FLOW_TEXT.md": ["fragment", "fragment"],
    "docs/FIRST_USE.md": ["fragment", "fragment", "fragment"],
    "docs/IMAGE_SEQUENCE.md": ["fragment"],
    "docs/GEO_ANNOTATION.md": ["fragment"],
    "docs/GEO_LABELS.md": ["fragment"],
    "docs/LUTS.md": ["fragment"],
    "docs/MAP_CAMERA.md": ["fragment"],
    "docs/MEDIA_CAMERA2D.md": ["fragment", "checked-program"],
    "docs/LIMITER.md": ["fragment"],
    "docs/MASKS.md": ["fragment", "fragment"],
    "docs/MOTION_BLUR.md": ["fragment"],
    "docs/MOTION_PATH.md": ["fragment", "fragment"],
    "docs/PARALLAX_CAMERA.md": ["fragment"],
    "docs/PLANAR_TRACKING.md": ["fragment", "fragment"],
    "docs/PRECOMPOSITIONS.md": ["fragment", "fragment"],
    "docs/PROXIES.md": ["fragment", "fragment", "fragment"],
    "docs/RESPONSIVE_LAYOUT.md": ["fragment"],
    "docs/RETAINED_MEDIA_VIEWPORT.md": ["fragment", "fragment"],
    "docs/SEMANTIC_MATCH.md": ["fragment"],
    "docs/SIDECHAIN.md": ["fragment"],
    "docs/SPEC.md": Array.from({ length: 20 }, () => "fragment" as const),
    "docs/SYNTH.md": ["fragment", "fragment", "fragment"],
    "docs/TEMPO_DELAY.md": ["fragment"],
    "docs/TRACE.md": ["fragment", "fragment", "fragment"],
    "docs/TRACKING_2D.md": ["fragment"],
    "docs/TRANSCRIPT_EDITING.md": ["fragment", "fragment", "fragment"],
    "docs/TRANSCRIPT_MEDIA_AUTHORITY.md": ["fragment"],
    "docs/TIMELINE_EDIT.md": ["fragment", "fragment"],
    "docs/USER_MODULES.md": ["fragment", "fragment", "fragment", "fragment"],
    "docs/VECTOR_PATH.md": ["fragment", "fragment", "fragment"],
  };
  const markdown = [
    "README.md",
    "CONTRIBUTING.md",
    ...(await readdir(resolve(repository, "docs")))
      .filter((file) => file.endsWith(".md"))
      .map((file) => `docs/${file}`),
    "editors/vscode/README.md",
  ].sort();
  const actualWithFences: string[] = [];
  for (const file of markdown) {
    const fences = cutFences(await readFile(resolve(repository, file), "utf8"));
    if (!fences.length) continue;
    actualWithFences.push(file);
    const classifications = expected[file];
    assert.ok(classifications, `${file} has unclassified public CUT fences`);
    assert.equal(classifications.length, fences.length, `${file} CUT fence count changed without classification`);
    for (const [index, classification] of classifications.entries()) {
      if (classification === "checked-program") {
        assertPortableSource(fences[index]!, `${file} CUT fence ${index}`);
      }
    }
  }
  assert.deepEqual(actualWithFences.sort(), Object.keys(expected).sort());
});

test("legacy and frozen public sources stay byte-preserved and excluded from active conformance", async () => {
  const inventory = await manifest();
  for (const entry of [...inventory.legacy, ...inventory.historical]) {
    assert.match(entry.sha256 ?? "", /^[0-9a-f]{64}$/, `${entry.path} needs a frozen SHA-256`);
    assert.ok(entry.reason, `${entry.path} needs an exclusion reason`);
    assert.equal(digest(await readFile(resolve(repository, entry.path))), entry.sha256, `${entry.path} bytes changed`);
  }

  for (const entry of inventory.legacy) {
    const parsed = parseCutLanguage(await readFile(resolve(repository, entry.path), "utf8"));
    assert.ok(parsed.diagnostics.length > 0, `${entry.path} unexpectedly became formal CUT source`);
  }
});

test("redistributable fixed font and license identities are pinned", async () => {
  const font = await readFile(resolve(repository, "examples/fixtures/Geist-Regular.ttf"));
  const license = await readFile(resolve(repository, "examples/fixtures/Geist-LICENSE.txt"));
  assert.equal(digest(font), "bde046ddd9f20be35b0bd56cc79eb752b967fb6661a3fe76cb067bb09f871d76");
  assert.equal(digest(license), "930853ee1daa68554d9e35c8a9175affb74f699fad9a5da6ee5ebe76379d9137");
  assert.match(license.toString("utf8"), /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(await readFile(resolve(repository, "examples/fixtures/README.md"), "utf8"), /fixed-instance Geist font/);
});
