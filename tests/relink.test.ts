import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import sharp from "sharp";
import { compileCutModule } from "../lib/language/compiler";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import {
  CutRelinkError,
  relinkCutSource,
  type CutRelinkReport,
} from "../lib/project/relink";

const exec = promisify(execFile);
const cli = resolve("dist-cli/cli/cut.js");

function program(declaration: string) {
  return `cut 0.4;\nproject "Relink proof";\n${declaration}\n`;
}

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  return compileCutModule(parsed.module).ir;
}

async function expectCode(action: () => Promise<unknown>, code: string) {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof CutRelinkError);
    assert.equal(error.code, code);
    return true;
  });
}

async function runCli(args: string[], cwd: string, expectedCode = 0) {
  return new Promise<{ stdout: string; stderr: string }>((accept, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let settled = false, bytes = 0;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (error) reject(error);
      else accept(result);
    };
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > 2 * 1024 * 1024) {
        child.kill("SIGKILL");
        finish(new Error("relink CLI output exceeded 2 MiB"));
      } else target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", finish);
    child.on("exit", (code, signal) => {
      if (code === expectedCode) finish();
      else finish(new Error(`cut ${args.join(" ")} exited ${code ?? signal}, expected ${expectedCode}`));
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`cut ${args.join(" ")} timed out`));
    }, 30_000);
  });
}

test("relink dry-run preserves source and --write changes only one literal while invalidating the old lock", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cut-relink-lock-"));
  const path = join(root, "main.cut"), media = join(root, "media");
  const source = 'cut 0.4;\nproject "Byte exact";\n// spacing and comments are canonical user source\nasset facts:DataAsset=data("media/old.bin"); // do not format\n';
  try {
    await mkdir(media);
    await Promise.all([writeFile(join(media, "old.bin"), "old"), writeFile(join(media, "new.bin"), "replacement")]);
    await writeFile(path, source);
    await chmod(path, 0o640);
    const oldLock = await createCutLock(compile(source), root);
    const beforeEntries = (await readdir(root)).sort();

    const preview = await relinkCutSource({ programPath: path, assetName: "facts", locator: "media/new.bin" });
    assert.equal(preview.status, "dry-run");
    assert.deepEqual(preview.locator, { from: "media/old.bin", to: "media/new.bin" });
    assert.equal(preview.probe.kind, "bytes");
    assert.equal(preview.probe.identity.file.locator, "media/new.bin");
    assert.equal(await readFile(path, "utf8"), source);
    assert.deepEqual((await readdir(root)).sort(), beforeEntries, "dry-run cannot create staging files");

    const written = await relinkCutSource({ programPath: path, assetName: "facts", locator: "media/new.bin", write: true });
    const expected = source.replace('"media/old.bin"', '"media/new.bin"');
    assert.equal(written.status, "written");
    assert.equal(await readFile(path, "utf8"), expected);
    assert.equal((await stat(path)).mode & 0o777, 0o640);
    assert.deepEqual((await readdir(root)).sort(), beforeEntries, "atomic staging file must be removed");
    assert.notEqual(written.source.sha256Before, written.source.sha256After);

    const newIr = compile(expected);
    await assert.rejects(applyCutLock(newIr, oldLock, root), /created for different CUT source/);
    const newLock = await createCutLock(newIr, root);
    assert.equal(newLock.resources.facts.locator, "media/new.bin");
    assert.equal(newLock.resources.facts.sha256, written.probe.identity.file.sha256);
    await applyCutLock(newIr, newLock, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("relink accepts the checked named path form and reports an honest unchanged result", async () => {
  const root = await mkdtemp(join(tmpdir(), "cut-relink-named-"));
  const path = join(root, "main.cut");
  const source = program('asset facts: DataAsset = data(path: "media/facts.bin");');
  try {
    await mkdir(join(root, "media"));
    await writeFile(join(root, "media", "facts.bin"), "facts");
    await writeFile(path, source);
    const result = await relinkCutSource({ programPath: path, assetName: "facts", locator: "media/facts.bin", write: true });
    assert.equal(result.status, "unchanged");
    assert.equal(result.source.changed, false);
    assert.equal(await readFile(path, "utf8"), source);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("relink fails closed on missing, duplicate, non-asset, indirect, and ill-typed declarations", async () => {
  const root = await mkdtemp(join(tmpdir(), "cut-relink-select-"));
  const path = join(root, "main.cut");
  try {
    await mkdir(join(root, "media"));
    await writeFile(join(root, "media", "new.bin"), "new");
    const attempt = (source: string, assetName = "facts") => writeFile(path, source)
      .then(() => relinkCutSource({ programPath: path, assetName, locator: "media/new.bin" }));

    await expectCode(() => attempt(program('asset other: DataAsset = data("media/old.bin");')), "CUT_RELINK_ASSET_MISSING");
    await expectCode(() => attempt(program('const facts: String = "media/old.bin";')), "CUT_RELINK_NOT_ASSET");
    await expectCode(() => attempt(program('asset facts: DataAsset = data("media/a.bin");\nasset facts: DataAsset = data("media/b.bin");')), "CUT_RELINK_ASSET_AMBIGUOUS");
    await expectCode(() => attempt(program('const PATH = "media/old.bin";\nasset facts: DataAsset = data(PATH);')), "CUT_RELINK_LITERAL_REQUIRED");

    await assert.rejects(
      () => attempt(program('asset facts: VideoAsset = data("media/old.bin");')),
      (error: unknown) => {
        assert.ok(error instanceof CutRelinkError);
        assert.equal(error.code, "CUT_RELINK_SOURCE_INVALID");
        assert.ok(error.diagnostics?.some((diagnostic) => diagnostic.code === "CUT2044"));
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("relink enforces project, symlink, UTF-8, regular-file, and source-size boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "cut-relink-safety-"));
  const path = join(root, "main.cut"), source = program('asset facts: DataAsset = data("media/old.bin");');
  try {
    await mkdir(join(root, "media"));
    await writeFile(join(root, "media", "new.bin"), "new");
    await writeFile(path, source);
    const attempt = (locator: string) => relinkCutSource({ programPath: path, assetName: "facts", locator });
    for (const locator of ["../outside.bin", "/tmp/outside.bin", "media\\new.bin", "media//new.bin", "./media/new.bin", "media/\nnew.bin"]) {
      await expectCode(() => attempt(locator), "CUT_RELINK_LOCATOR_UNSAFE");
    }
    await expectCode(() => attempt("media/missing.bin"), "CUT_RELINK_TARGET_MISSING");

    await symlink("new.bin", join(root, "media", "linked.bin"));
    await expectCode(() => attempt("media/linked.bin"), "CUT_RELINK_TARGET_SYMLINK");
    await mkdir(join(root, "media", "directory"));
    await expectCode(() => attempt("media/directory"), "CUT_RELINK_TARGET_INVALID");

    const sourceLink = join(root, "linked.cut");
    await symlink("main.cut", sourceLink);
    await expectCode(
      () => relinkCutSource({ programPath: sourceLink, assetName: "facts", locator: "media/new.bin" }),
      "CUT_RELINK_SOURCE_NOT_REGULAR",
    );

    const invalid = join(root, "invalid.cut");
    await writeFile(invalid, Buffer.concat([Buffer.from('cut 0.4; project "bad"; // '), Buffer.from([0xff])]));
    await expectCode(
      () => relinkCutSource({ programPath: invalid, assetName: "facts", locator: "media/new.bin" }),
      "CUT_RELINK_SOURCE_UTF8",
    );
    await expectCode(
      () => relinkCutSource({ programPath: path, assetName: "facts", locator: "media/new.bin", maxSourceBytes: 8 }),
      "CUT_RELINK_SOURCE_TOO_LARGE",
    );
    assert.equal((await lstat(path)).isFile(), true);
    assert.equal(await readFile(path, "utf8"), source);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("relink probes constructor-compatible video, audio, and image resources", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cut-relink-kinds-"));
  const media = join(root, "media"), path = join(root, "main.cut");
  try {
    await mkdir(media);
    await exec("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=blue:s=32x32:r=4:d=1",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
      "-shortest", "-c:v", "ffv1", "-pix_fmt", "yuv420p", "-c:a", "pcm_s24le", join(media, "av.mkv"),
    ]);
    await exec("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=1",
      "-c:a", "pcm_s24le", join(media, "audio.wav"),
    ]);
    await sharp({ create: { width: 4, height: 3, channels: 4, background: "#ff3366" } }).png().toFile(join(media, "still.png"));
    await writeFile(join(media, "bytes.bin"), "not an image");

    const probe = async (kind: "video" | "audio" | "image", type: "VideoAsset" | "AudioAsset" | "ImageAsset", locator: string) => {
      await writeFile(path, program(`asset source: ${type} = ${kind}("media/old.bin");`));
      return relinkCutSource({ programPath: path, assetName: "source", locator });
    };
    const video = await probe("video", "VideoAsset", "media/av.mkv");
    const videoProbe = video.probe;
    assert.equal(videoProbe.kind, "media");
    if (videoProbe.kind !== "media") assert.fail("expected a media probe");
    assert.equal(videoProbe.identity.streams.find((stream) => stream.index === videoProbe.selectedStreamIndex)?.type, "video");
    const audio = await probe("audio", "AudioAsset", "media/av.mkv");
    const audioProbe = audio.probe;
    assert.equal(audioProbe.kind, "media");
    if (audioProbe.kind !== "media") assert.fail("expected a media probe");
    assert.equal(audioProbe.identity.streams.find((stream) => stream.index === audioProbe.selectedStreamIndex)?.type, "audio");
    const image = await probe("image", "ImageAsset", "media/still.png");
    assert.equal(image.probe.kind, "image");
    assert.deepEqual(image.probe.kind === "image" && [image.probe.identity.image.width, image.probe.identity.image.height], [4, 3]);

    await expectCode(() => probe("video", "VideoAsset", "media/audio.wav"), "CUT_RELINK_KIND_MISMATCH");
    await expectCode(() => probe("image", "ImageAsset", "media/bytes.bin"), "CUT_RELINK_KIND_MISMATCH");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cut relink has a closed CLI, deterministic JSON, and source-located failure diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "cut-relink-cli-"));
  const path = join(root, "main.cut"), source = program('asset facts: DataAsset = data("media/old.bin");');
  try {
    await mkdir(join(root, "media"));
    await writeFile(join(root, "media", "new.bin"), "new");
    await writeFile(path, source);

    const dry = JSON.parse((await runCli(["relink", "main.cut", "--asset", "facts", "--to", "media/new.bin", "--json"], root)).stdout) as CutRelinkReport;
    assert.equal(dry.status, "dry-run");
    assert.equal(dry.program, "main.cut");
    assert.doesNotMatch(JSON.stringify(dry), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(await readFile(path, "utf8"), source);

    const unsafe = JSON.parse((await runCli(["relink", "main.cut", "--asset", "facts", "--to", "../outside.bin", "--json"], root, 1)).stdout) as {
      format: string;
      command: string;
      diagnostics: Array<{ code: string; source?: { path?: string; line?: number; column?: number } }>;
    };
    assert.equal(unsafe.format, "cut-cli-diagnostics");
    assert.equal(unsafe.command, "relink");
    assert.equal(unsafe.diagnostics[0]?.code, "CUT_RELINK_LOCATOR_UNSAFE");
    assert.deepEqual(unsafe.diagnostics[0]?.source, { path: "main.cut", module: "main.cut", line: 3, column: 31 });
    assert.doesNotMatch(JSON.stringify(unsafe), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const missingSource = JSON.parse((await runCli(["relink", "missing.cut", "--asset", "facts", "--to", "media/new.bin", "--json"], root, 1)).stdout) as {
      diagnostics: Array<{ code: string; source?: { path?: string } }>;
    };
    assert.equal(missingSource.diagnostics[0]?.code, "CUT_RELINK_SOURCE_MISSING");
    assert.equal(missingSource.diagnostics[0]?.source?.path, "missing.cut");
    assert.doesNotMatch(JSON.stringify(missingSource), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const unknown = await runCli(["relink", "missing.cut", "--asset", "facts", "--to", "media/new.bin", "--bogus"], root, 1);
    assert.match(unknown.stderr, /CUTC1001: Unknown option "--bogus" for relink/);
    assert.doesNotMatch(unknown.stderr, /ENOENT|no such file/i);
    const required = JSON.parse((await runCli(["relink", "main.cut", "--to", "media/new.bin", "--json"], root, 1)).stdout) as { diagnostics: Array<{ code: string }> };
    assert.equal(required.diagnostics[0]?.code, "CUTC1006");

    const written = JSON.parse((await runCli(["relink", "main.cut", "--asset", "facts", "--to", "media/new.bin", "--write", "--json"], root)).stdout) as CutRelinkReport;
    assert.equal(written.status, "written");
    assert.equal(await readFile(path, "utf8"), source.replace("media/old.bin", "media/new.bin"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cut relink validates a package-enabled entry against its verified external package contracts", { timeout: 60_000 }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cut-relink-package-"));
  const project = join(workspace, "package-proof"), dependency = join(workspace, "packages", "impact-cards");
  try {
    await cp(resolve("examples/package-proof"), project, { recursive: true });
    await cp(resolve("examples/packages/impact-cards"), dependency, { recursive: true });
    await rm(join(project, ".cut"), { recursive: true, force: true });
    await mkdir(join(project, "media"));
    await Promise.all([
      writeFile(join(project, "media", "old.bin"), "old package asset"),
      writeFile(join(project, "media", "new.bin"), "new package asset"),
    ]);
    const sourcePath = join(project, "main.cut"), original = await readFile(sourcePath, "utf8");
    const authored = original.replace(
      'import { Rect } from "cut:visual";',
      'import { Rect } from "cut:visual";\n\nasset facts: DataAsset = data("media/old.bin");',
    );
    assert.notEqual(authored, original, "package proof fixture must retain its public Rect import");
    await writeFile(sourcePath, authored);
    await runCli(["package", "lock", "--project", project], workspace);

    const dry = JSON.parse((await runCli(["relink", "main.cut", "--asset", "facts", "--to", "media/new.bin", "--json"], project)).stdout) as CutRelinkReport;
    assert.equal(dry.status, "dry-run");
    assert.equal(await readFile(sourcePath, "utf8"), authored);

    const written = JSON.parse((await runCli(["relink", "main.cut", "--asset", "facts", "--to", "media/new.bin", "--write", "--json"], project)).stdout) as CutRelinkReport;
    assert.equal(written.status, "written");
    const rewritten = await readFile(sourcePath, "utf8");
    assert.equal(rewritten, authored.replace('"media/old.bin"', '"media/new.bin"'));
    assert.match(rewritten, /import \{ ImpactCard \} from "@cut-proof\/impact-cards";/);

    const stale = JSON.parse((await runCli(["check", "main.cut", "--json"], project, 1)).stdout) as { diagnostics: Array<{ code: string }> };
    assert.match(stale.diagnostics[0]?.code ?? "", /^CUT_PACKAGE_(?:TAMPERED|LOCK_STALE)$/);
    await runCli(["package", "lock", "--project", project], workspace);
    const repaired = JSON.parse((await runCli(["check", "main.cut", "--json"], project)).stdout) as { status: string };
    assert.equal(repaired.status, "pass");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
