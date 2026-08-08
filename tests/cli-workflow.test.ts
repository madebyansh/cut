import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cutProductVersion } from "../lib/version";

const cli = resolve("dist-cli/cli/cut.js");

const invalidComponentLocalSpace = `cut 0.4;
project "Invalid component surface";
import { LocalSpace, Rect } from "cut:visual";
component InvalidSurface() -> Visual {
  LocalSpace(width: 64px, height: 36px, origin: { x: 32px, y: 18px }) {
    Rect(width: 64px, height: 36px, x: 32px, y: 18px, fill: #071019);
  }
  Rect(width: 1px, height: 1px, fill: #ffffff);
}
timeline main(duration: 1s, fps: 24, width: 64px, height: 36px, sampleRate: 48khz) {
  scene only(duration: 1s) { InvalidSurface(); }
}
export release = render(main, width: 64px, height: 36px, codec: "h264");
`;

const validComponentLocalSpace = `cut 0.4;
project "Public component surface";
import { LocalSpace, Rect } from "cut:visual";
component Tile() -> Visual {
  LocalSpace(width: 6px, height: 4px, origin: { x: 1.25px, y: 0.75px }) {
    Rect(width: 2px, height: 2px, x: 0px, y: 0px, fill: #ef233c);
  }
}
timeline main(duration: 1s, fps: 4, width: 20px, height: 16px, sampleRate: 8khz) {
  scene only(duration: 1s) {
    Tile() as plate;
    set plate.x = 2px;
    set plate.y = -1px;
    set plate.scale = 1.5;
    set plate.rotation = 90deg;
    set plate.opacity = 50%;
  }
}
export release = render(main, width: 20px, height: 16px, codec: "h264");
`;

async function run(args: string[], cwd = process.cwd(), expectedCode = 0, stdin?: string | Buffer) {
  return new Promise<{ stdout: string; stderr: string }>((accept, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0, settled = false;
    const finish = (error?: Error, value?: { stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else accept(value!);
    };
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) {
        child.kill("SIGKILL");
        finish(new Error("CLI test output exceeded 2 MiB"));
      } else target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.stdin.on("error", (error) => finish(error));
    child.on("error", finish);
    child.on("exit", (code, signal) => {
      const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (code === expectedCode) finish(undefined, result);
      else finish(new Error(`cut ${args.join(" ")} exited ${code ?? signal}, expected ${expectedCode}\n${result.stderr}${result.stdout}`));
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`cut ${args.join(" ")} timed out`));
    }, 30_000);
    child.stdin.end(stdin);
  });
}

test("installed CLI exposes coherent product identity and machine-readable doctor", { timeout: 30_000 }, async () => {
  const version = await run(["--version"]);
  assert.match(version.stdout, new RegExp(`^cut ${cutProductVersion.replaceAll(".", "\\.")}`));
  const doctor = JSON.parse((await run(["doctor", "--json"])).stdout) as { format: string; status: string };
  assert.deepEqual({ format: doctor.format, status: doctor.status }, { format: "cut-doctor-report", status: "pass" });
});

test("canonical init, project, check, lint, lock, build, inspect, and test use only typed CUT source", { timeout: 60_000 }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cut-cli-workflow-"));
  const project = join(workspace, "film");
  try {
    const initialized = await run(["init", project, "--name", "CLI Proof"], workspace);
    assert.match(initialized.stdout, /npx --no-install cut check main\.cut/);
    const starterReadme = await readFile(join(project, "README.md"), "utf8");
    assert.match(starterReadme, /npx --no-install cut check main\.cut/);
    assert.match(starterReadme, /npm install --ignore-scripts \/path\/to\/cut-lang-<version>\.tgz/);
    await run(["project", "."], project);
    const check = JSON.parse((await run(["check", "main.cut", "--json"], project)).stdout) as { format: string; status: string; diagnostics: unknown[] };
    assert.deepEqual({ format: check.format, status: check.status, diagnostics: check.diagnostics }, { format: "cut-diagnostics", status: "pass", diagnostics: [] });
    const lint = JSON.parse((await run(["lint", "main.cut", "--deny-warnings", "--json"], project)).stdout) as { format: string; status: string; diagnostics: unknown[] };
    assert.deepEqual({ format: lint.format, status: lint.status, diagnostics: lint.diagnostics }, { format: "cut-lint-report", status: "pass", diagnostics: [] });
    const lockReport = JSON.parse((await run(["lock", "main.cut", "--out", "cut.lock", "--json"], project)).stdout) as { format: string; status: string; output: string; summary: { resources: number; packages: number } };
    assert.deepEqual({ format: lockReport.format, status: lockReport.status, output: lockReport.output }, { format: "cut-lock-report", status: "pass", output: "cut.lock" });
    assert.ok(lockReport.summary.resources >= 0 && lockReport.summary.packages > 0);
    const buildReport = JSON.parse((await run(["build", "main.cut", "--lock", "cut.lock", "--json"], project)).stdout) as { format: string; status: string; output: string; determinism: { semantic: string }; summary: { nodes: number; outputs: number } };
    assert.equal(buildReport.format, "cut-build-report");
    assert.equal(buildReport.status, "pass");
    assert.equal(buildReport.determinism.semantic, "locked");
    assert.ok(buildReport.summary.nodes > 0 && buildReport.summary.outputs >= 2);
    const inspect = JSON.parse((await run(["inspect", "main.cut", "--lock", "cut.lock", "--json"], project)).stdout) as {
      format: string;
      status: string;
      determinism: { semantic: string };
      summary: { compositions: number; nodes: number; outputs: number };
      compositions: Array<{ graph: { reachableNodes: number } }>;
      graph: { nodes: Array<{ id: string; op: string; source: { line: number } }> };
    };
    assert.equal(inspect.format, "cut-inspect-report");
    assert.equal(inspect.status, "pass");
    assert.equal(inspect.determinism.semantic, "locked");
    assert.ok(inspect.summary.compositions >= 2 && inspect.summary.nodes > 0 && inspect.summary.outputs >= 2);
    assert.ok(inspect.compositions.every((composition) => composition.graph.reachableNodes > 0));
    assert.ok(inspect.graph.nodes.every((node) => node.id && node.op && node.source.line > 0));
    const assertions = JSON.parse((await run(["test", "main.cut", "--lock", "cut.lock", "--json"], project)).stdout) as {
      summary: { total: number; pass: number; fail: number; deferred: number };
    };
    assert.deepEqual(assertions.summary, { deferred: 0, fail: 0, pass: 1, total: 1 });
    const lock = JSON.parse(await readFile(join(project, "cut.lock"), "utf8")) as { format: string };
    assert.equal(lock.format, "cut-lock");
    const source = await readFile(join(project, "main.cut"), "utf8");
    assert.match(source, /assert timelineDurationIs\(main, 3s\), "release timeline is exactly three seconds";/);
    assert.match(source, /export preview = render\(previewTimeline, width: 960px, height: 540px, codec: "h264"\);/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("machine diagnostics fail cleanly and model-assisted commands are not top-level", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cut-cli-diagnostic-"));
  try {
    await writeFile(join(workspace, "bad.cut"), "cut 0.4; project 42;");
    const failed = await run(["check", "bad.cut", "--json"], workspace, 1);
    const report = JSON.parse(failed.stdout) as { status: string; diagnostics: Array<{ code: string }> };
    assert.equal(report.status, "fail");
    assert.equal(report.diagnostics[0]?.code, "CUT1002");
    const legacyBoundary = await run(["direct", "bad.cut"], workspace, 1);
    assert.match(legacyBoundary.stderr, /unknown command.*direct.*cut help/);
    assert.doesNotMatch(legacyBoundary.stderr, /OPENAI_API_KEY|Codex is planning|source-grounded model/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("check publishes bounded recovered syntax diagnostics in source order without allocating project artifacts", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cut-cli-multi-diagnostic-"));
  const source = 'cut 0.4; project "multi"; const first = ; const second = f(x: 1, 2);';
  try {
    await writeFile(join(workspace, "main.cut"), source);
    const failed = JSON.parse((await run(["check", "main.cut", "--json"], workspace, 1)).stdout) as {
      status: string;
      diagnostics: Array<{ code: string; span: { start: { offset: number } } }>;
    };
    assert.equal(failed.status, "fail");
    assert.deepEqual(failed.diagnostics.map((diagnostic) => diagnostic.code), ["CUT1002", "CUT1002"]);
    assert.deepEqual(failed.diagnostics.map((diagnostic) => diagnostic.span.start.offset), [source.indexOf(";", source.indexOf("const first")), source.lastIndexOf("2")]);
    assert.deepEqual(await readdir(workspace), ["main.cut"], "syntax recovery must not allocate lock, build, cache, or output state");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("check and formatter accept bounded stdin bytes without losing the authored path identity", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cut-cli-stdin-"));
  const valid = 'cut 0.4;project "Stdin Proof";timeline main(duration:1s,fps:24){scene one(duration:1s){}}export release=render(main);';
  try {
    await writeFile(join(workspace, "main.cut"), "cut 0.4; project 42;\n");
    const checked = JSON.parse((await run(["check", "main.cut", "--stdin", "--json"], workspace, 0, valid)).stdout) as {
      status: string;
      diagnostics: unknown[];
      program: string;
    };
    assert.deepEqual({ status: checked.status, diagnostics: checked.diagnostics, program: checked.program }, { status: "pass", diagnostics: [], program: "main.cut" });

    const formatted = await run(["fmt", "main.cut", "--stdin", "--stdout"], workspace, 0, valid);
    assert.match(formatted.stdout, /^cut 0\.4;\n\nproject "Stdin Proof";/);
    assert.equal(await readFile(join(workspace, "main.cut"), "utf8"), "cut 0.4; project 42;\n", "stdin formatting must not mutate the saved file");

    const invalidCombination = JSON.parse((await run(["fmt", "main.cut", "--stdin", "--json"], workspace, 1)).stdout) as {
      diagnostics: Array<{ code: string }>;
    };
    assert.equal(invalidCombination.diagnostics[0]?.code, "CUTC1007");
    const invalidUtf8 = JSON.parse((await run(["check", "main.cut", "--stdin", "--json"], workspace, 1, Buffer.from([0xc3, 0x28]))).stdout) as {
      diagnostics: Array<{ code: string }>;
    };
    assert.equal(invalidUtf8.diagnostics[0]?.code, "CUT_STDIN_UTF8");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("check includes source-located lowering diagnostics used by lock and render", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cut-cli-lowering-diagnostic-"));
  const source = `cut 0.4;
project "Invalid transition";
import { Clip, Transition } from "@cut/edit";
asset outgoing: VideoAsset = video("outgoing.mkv");
asset incoming: VideoAsset = video("incoming.mkv");
timeline main(duration: 1500ms, fps: 4, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1500ms) {
    Transition(kind: "cross-dissolve", duration: 250ms) {
      at 0s { Clip(source: outgoing, range: 0s ..< 1s, duration: 1s); }
      at 500ms { Clip(source: incoming, range: 0s ..< 1s, duration: 1s); }
    }
  }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");
`;
  try {
    await writeFile(join(workspace, "invalid-transition.cut"), source);
    const failed = await run(["check", "invalid-transition.cut", "--json"], workspace, 1);
    const report = JSON.parse(failed.stdout) as {
      status: string;
      diagnostics: Array<{ code: string; span: { start: { line: number; column: number } } }>;
    };
    assert.equal(report.status, "fail");
    const diagnostic = report.diagnostics.find((item) => item.code === "CUT2084");
    assert.ok(diagnostic, failed.stdout);
    assert.deepEqual(diagnostic.span.start, { offset: 314, line: 8, column: 5 });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("check rejects a let-bound responsive annotation ghost before producing build or lock artifacts", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cut-cli-responsive-ghost-"));
  const source = `cut 0.4;
project "Responsive ghost rejection";
import { Callout, CalloutLayer, Image, LocalSpace, MediaCamera2D, Rect, ResponsiveSlot, ResponsiveStack, responsiveStackPlan, visualAnchor } from "cut:visual";
component AnnotatedShot(still: ImageAsset) -> Visual {
  let ghost = Rect(width: 1px, height: 1px, fill: #ffffff);
  let plan = responsiveStackPlan(weights: [2, 1], safeX: 0%, safeY: 0%, gap: 4px);
  ResponsiveStack(plan: plan) {
    ResponsiveSlot() {
      MediaCamera2D(zoom: 1.1) as shot {
        Image(source: still, fit: "cover");
      }
    }
    ResponsiveSlot() {
      Rect(width: 24px, height: 24px, fill: #f59e0b);
    }
  }
  CalloutLayer() {
    Callout(
      anchor: visualAnchor(owner: shot, local: { x: 2px, y: 2px }),
      placements: ["right"],
      offset: 2px,
      safeArea: 1px,
      leader: "straight",
      leaderColor: #ffffff,
      leaderWidth: 1px
    ) {
      LocalSpace(width: 8px, height: 4px, origin: { x: 0px, y: 0px }) {
        Rect(width: 8px, height: 4px, x: 4px, y: 2px, fill: #111827);
      }
    }
  }
}
asset still: ImageAsset = image("missing-but-unprobed.png");
timeline main(duration: 1s, fps: 24, width: 64px, height: 36px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    AnnotatedShot(still);
  }
}
export out = render(main, width: 64px, height: 36px, codec: "h264");
`;
  try {
    await writeFile(join(workspace, "main.cut"), source);
    const failed = await run(["check", "main.cut", "--json"], workspace, 1);
    const report = JSON.parse(failed.stdout) as {
      format: string;
      status: string;
      diagnostics: Array<{
        code: string;
        severity: string;
        message: string;
        source?: { path?: string; line?: number; column?: number };
      }>;
    };
    const diagnostic = report.diagnostics.find(
      (item) => item.code === "CUT_RESPONSIVE_STACK_GRAPH",
    );
    assert.equal(report.format, "cut-diagnostics");
    assert.equal(report.status, "fail");
    assert.ok(diagnostic, failed.stdout);
    assert.equal(diagnostic.severity, "error");
    assert.match(
      diagnostic.message,
      /let-bound Visual\/Audio\/AV node/u,
    );
    assert.deepEqual(diagnostic.source, {
      path: "main.cut",
      line: 5,
      column: 3,
    });
    assert.equal(failed.stderr, "");
    assert.deepEqual(
      (await readdir(workspace)).sort(),
      ["main.cut"],
      "check failure must retain only authored source, with no lock, build, cache, or staging artifact",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("all source-compiling commands reject the same invalid static visual graph before artifacts or locked I/O", { timeout: 60_000 }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cut-cli-static-visual-parity-"));
  const project = join(workspace, "film");
  try {
    await run(["init", project, "--name", "Static visual parity"], workspace);
    await writeFile(join(project, "main.cut"), invalidComponentLocalSpace);

    type StaticDiagnostic = {
      code: string;
      severity: string;
      message: string;
      hint?: string;
      source?: { path?: string; line?: number; column?: number };
    };
    const normalize = (diagnostic: StaticDiagnostic) => ({
      code: diagnostic.code,
      severity: diagnostic.severity,
      message: diagnostic.message,
      hint: diagnostic.hint ?? null,
      source: diagnostic.source,
    });
    const check = JSON.parse((await run(["check", "main.cut", "--json"], project, 1)).stdout) as {
      status: string;
      diagnostics: StaticDiagnostic[];
    };
    const expected = check.diagnostics.find((item) => item.code === "CUT_LOCAL_SPACE_UNSUPPORTED");
    assert.equal(check.status, "fail");
    assert.equal(expected?.source?.path, "main.cut");
    assert.ok((expected?.source?.line ?? 0) > 0 && (expected?.source?.column ?? 0) > 0, JSON.stringify(expected));

    const commands = [
      ["lint", "main.cut", "--json"],
      ["lock", "main.cut", "--out", "invalid.lock", "--json"],
      ["build", "main.cut", "--lock", "missing.lock", "--out", "invalid.cutir.json", "--json"],
      ["inspect", "main.cut", "--lock", "missing.lock", "--json"],
      ["test", "main.cut", "--lock", "missing.lock", "--json"],
      ["frame", "main.cut", "--lock", "missing.lock", "--frame", "0", "--out", "invalid-frame.png", "--json"],
      ["contact", "main.cut", "--lock", "missing.lock", "--frames", "0", "--out", "invalid-contact.png", "--json"],
      ["audition", "main.cut", "--lock", "missing.lock", "--samples", "0:1", "--out", "invalid-audition.wav", "--json"],
      ["preview", "main.cut", "--lock", "missing.lock", "--out", "invalid-preview.mp4", "--json"],
      ["render", "main.cut", "--lock", "missing.lock", "--out", "invalid-render.mp4", "--json"],
      ["av-build", "main.cut", "--lock", "missing.lock", "--out", "invalid-av.cutir.json", "--json"],
      ["av-inspect", "main.cut", "--lock", "missing.lock", "--json"],
      ["av-test", "main.cut", "--lock", "missing.lock", "--json"],
      ["av-render", "main.cut", "--lock", "missing.lock", "--out", "invalid-av.mp4", "--json"],
    ] as const;
    for (const args of commands) {
      const report = JSON.parse((await run([...args], project, 1)).stdout) as {
        status: string;
        diagnostics: StaticDiagnostic[];
      };
      assert.equal(report.status, "fail", args[0]);
      const diagnostic = report.diagnostics.find((item) => item.code === "CUT_LOCAL_SPACE_UNSUPPORTED");
      assert.ok(diagnostic && expected, args[0]);
      assert.deepEqual(normalize(diagnostic), normalize(expected), args[0]);
    }

    const projectFailure = await run(["project", "."], project, 1);
    assert.match(projectFailure.stderr, /main\.cut:\d+:\d+.*CUT_LOCAL_SPACE_UNSUPPORTED/s);
    const otioFailure = await run([
      "otio", "export", "main.cut", "--lock", "missing.lock", "--out", "invalid.otio", "--report", "invalid.otio.report.json",
    ], project, 1);
    assert.match(otioFailure.stderr, /main\.cut:\d+:\d+.*CUT_LOCAL_SPACE_UNSUPPORTED/s);

    for (const artifact of [
      "invalid.lock",
      "invalid.cutir.json",
      "invalid-frame.png",
      "invalid-contact.png",
      "invalid-audition.wav",
      "invalid-preview.mp4",
      "invalid-render.mp4",
      "invalid-av.cutir.json",
      "invalid-av.mp4",
      "invalid.otio",
      "invalid.otio.report.json",
    ]) {
      await assert.rejects(() => readFile(join(project, artifact)), /ENOENT/, artifact);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("public unary Visual component owns a smaller LocalSpace through check, lock, inspect, and exact frame CLI evidence", { timeout: 60_000 }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cut-cli-component-local-space-"));
  const project = join(workspace, "film");
  try {
    await run(["init", project, "--name", "Component LocalSpace CLI"], workspace);
    await writeFile(join(project, "main.cut"), validComponentLocalSpace);

    const check = JSON.parse((await run(["check", "main.cut", "--json"], project)).stdout) as {
      status: string;
      diagnostics: unknown[];
    };
    assert.deepEqual({ status: check.status, diagnostics: check.diagnostics }, { status: "pass", diagnostics: [] });

    const lock = JSON.parse((await run(["lock", "main.cut", "--out", "cut.lock", "--json"], project)).stdout) as {
      status: string;
      summary: { resources: number };
    };
    assert.deepEqual({ status: lock.status, resources: lock.summary.resources }, { status: "pass", resources: 0 });

    const inspected = JSON.parse((await run(["inspect", "main.cut", "--lock", "cut.lock", "--json"], project)).stdout) as {
      status: string;
      graph: { nodes: Array<{
        id: string;
        op: string;
        componentFragmentLocalSpace?: {
          localSpaceNodeId: string;
          dimensions: { width: number; height: number };
          initialPreflight: {
            status: string;
            placement: {
              owner: string;
              destinationX: number;
              destinationY: number;
              registrationRasterX: number;
              registrationRasterY: number;
              scale: number;
              skewX: number;
              skewY: number;
              rotation: number;
              opacity: number;
            };
            transformWork?: {
              source: { width: number; height: number; pixels: number; retainedRgba8Bytes: number };
              compositionLiveOutput: { surfaces: number; pixels: number; rgba8Bytes: number };
            };
          };
        };
        localSpace?: { owner: { kind: string; nodeId: string } };
      }> };
    };
    assert.equal(inspected.status, "pass");
    const fragment = inspected.graph.nodes.find((node) => node.op === "cut.kernel.fragment");
    const local = inspected.graph.nodes.find((node) => node.op === "cut.visual.local_space");
    assert.ok(fragment?.componentFragmentLocalSpace && local?.localSpace);
    assert.equal(fragment.componentFragmentLocalSpace.localSpaceNodeId, local.id);
    assert.deepEqual(fragment.componentFragmentLocalSpace.dimensions, { width: 6, height: 4 });
    assert.deepEqual(local.localSpace.owner, { kind: "component-fragment", nodeId: fragment.id });
    assert.equal(fragment.componentFragmentLocalSpace.initialPreflight.status, "visible");
    const preflightPlacement = fragment.componentFragmentLocalSpace.initialPreflight.placement;
    assert.deepEqual({
      owner: preflightPlacement.owner,
      destinationX: preflightPlacement.destinationX,
      destinationY: preflightPlacement.destinationY,
      registrationRasterX: preflightPlacement.registrationRasterX,
      registrationRasterY: preflightPlacement.registrationRasterY,
      scale: preflightPlacement.scale,
      skewX: preflightPlacement.skewX,
      skewY: preflightPlacement.skewY,
      rotation: preflightPlacement.rotation,
      opacity: preflightPlacement.opacity,
    }, {
      owner: "component-fragment",
      destinationX: 12,
      destinationY: 7,
      registrationRasterX: 1.25,
      registrationRasterY: 0.75,
      scale: 1.5,
      skewX: 0,
      skewY: 0,
      rotation: 90,
      opacity: 0.5,
    });
    assert.deepEqual(fragment.componentFragmentLocalSpace.initialPreflight.transformWork && {
      source: fragment.componentFragmentLocalSpace.initialPreflight.transformWork.source,
      compositionLiveOutput: fragment.componentFragmentLocalSpace.initialPreflight.transformWork.compositionLiveOutput,
    }, {
      source: { width: 6, height: 4, pixels: 24, retainedRgba8Bytes: 96 },
      compositionLiveOutput: { surfaces: 1, pixels: 20 * 16, rgba8Bytes: 20 * 16 * 4 },
    });

    const frame = JSON.parse((await run([
      "frame", "main.cut", "--lock", "cut.lock", "--frame", "0", "--out", "review/component.png", "--json",
    ], project)).stdout) as {
      status: string;
      manifest: {
        format: string;
        canvas: { width: number; height: number };
        artifact: { file: string; bytes: number };
        execution: {
          localSpaceTransformPreflight: {
            status: string;
            outputFrame: string;
            admissions: Array<{ ownerKind: string; work: { workIdentity: string } }>;
            aggregate?: { transformCount: number; workIdentity: string };
          };
          localSpaces: Array<{
          counters: { tileRasterizations: number; placementRasterizations: number; transformExecutions: number };
          tiles: Array<{ width: number; height: number }>;
          placements: Array<{
            owner: string;
            transform: { destinationX: number; destinationY: number; registrationRasterX: number; registrationRasterY: number; scale: number; skewX: number; skewY: number; rotation: number; opacity: number };
            transformWork?: { source: { width: number; height: number }; destination: { width: number; height: number } };
          }>;
          }>;
        };
      };
    };
    assert.equal(frame.status, "pass");
    assert.deepEqual({ format: frame.manifest.format, width: frame.manifest.canvas.width, height: frame.manifest.canvas.height, file: frame.manifest.artifact.file }, {
      format: "cut-reference-frame",
      width: 20,
      height: 16,
      file: "component.png",
    });
    const receipt = frame.manifest.execution.localSpaces[0], placement = receipt?.placements[0];
    assert.ok(receipt && placement);
    assert.deepEqual(receipt.counters && {
      tileRasterizations: receipt.counters.tileRasterizations,
      placementRasterizations: receipt.counters.placementRasterizations,
      transformExecutions: receipt.counters.transformExecutions,
    }, { tileRasterizations: 1, placementRasterizations: 1, transformExecutions: 1 });
    assert.deepEqual(receipt.tiles[0] && { width: receipt.tiles[0].width, height: receipt.tiles[0].height }, { width: 6, height: 4 });
    assert.equal(placement.owner, "component-fragment");
    assert.deepEqual({
      status: frame.manifest.execution.localSpaceTransformPreflight.status,
      outputFrame: frame.manifest.execution.localSpaceTransformPreflight.outputFrame,
      admissions: frame.manifest.execution.localSpaceTransformPreflight.admissions.length,
      owner: frame.manifest.execution.localSpaceTransformPreflight.admissions[0]?.ownerKind,
      transforms: frame.manifest.execution.localSpaceTransformPreflight.aggregate?.transformCount,
    }, { status: "admitted", outputFrame: "0", admissions: 1, owner: "component-fragment", transforms: 1 });
    assert.match(frame.manifest.execution.localSpaceTransformPreflight.admissions[0]?.work.workIdentity ?? "", /^[a-f0-9]{64}$/u);
    assert.match(frame.manifest.execution.localSpaceTransformPreflight.aggregate?.workIdentity ?? "", /^[a-f0-9]{64}$/u);
    assert.deepEqual(placement.transform, {
      destinationX: 12,
      destinationY: 7,
      registrationRasterX: 1.25,
      registrationRasterY: 0.75,
      scale: 1.5,
      skewX: 0,
      skewY: 0,
      rotation: 90,
      opacity: 0.5,
    });
    assert.deepEqual(placement.transformWork && {
      source: placement.transformWork.source,
      destination: placement.transformWork.destination,
    }, { source: { width: 6, height: 4 }, destination: { width: 20, height: 16 } });
    assert.ok(frame.manifest.artifact.bytes > 0);
    assert.ok((await readFile(join(project, "review/component.png"))).byteLength > 0);
    assert.ok((await readFile(join(project, "review/component.png.manifest.json"))).byteLength > 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("preview requires an explicitly authored output and fails with stable JSON", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cut-cli-preview-contract-"));
  const source = `cut 0.4;
project "No implicit preview";
import { Rect } from "cut:visual";
timeline main(duration: 1s, fps: 24, width: 160px, height: 90px, sampleRate: 48khz) {
  scene card(duration: 1s) {
    Rect(width: 160px, height: 90px, x: 80px, y: 45px, fill: #071019);
  }
}
export release = render(main, width: 160px, height: 90px, codec: "h264");
`;
  try {
    await writeFile(join(workspace, "main.cut"), source);
    await run(["lock", "main.cut", "--out", "cut.lock"], workspace);
    const failed = JSON.parse((await run(["preview", "main.cut", "--lock", "cut.lock", "--json"], workspace, 1)).stdout) as {
      format: string;
      command: string;
      status: string;
      diagnostics: Array<{ code: string }>;
    };
    assert.deepEqual({ format: failed.format, command: failed.command, status: failed.status, code: failed.diagnostics[0]?.code }, {
      format: "cut-cli-diagnostics",
      command: "preview",
      status: "fail",
      code: "CUT_PREVIEW_OUTPUT_MISSING",
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("preview exposes exact range and width through the closed JSON CLI", { timeout: 60_000 }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cut-cli-range-preview-"));
  const source = `cut 0.4;
project "CLI range preview";
import { Rect } from "cut:visual";
import { Tone } from "@cut/audio";
timeline main(duration: 1s, fps: 4, width: 128px, height: 72px, sampleRate: 48khz) {
  Tone(frequency: 440hz, duration: 1s, amplitude: 5%);
  scene card(duration: 1s) { Rect(width: 128px, height: 72px, x: 64px, y: 36px, fill: #071019); }
}
export preview = render(main, width: 128px, height: 72px, codec: "h264");
`;
  try {
    await writeFile(join(workspace, "main.cut"), source);
    await run(["lock", "main.cut", "--out", "cut.lock"], workspace);
    const report = JSON.parse((await run([
      "preview", "main.cut", "--lock", "cut.lock", "--range", "250ms:750ms", "--width", "64", "--out", "review/range.mp4", "--json",
    ], workspace)).stdout) as { format: string; status: string; manifest: { format: string; range: { firstFrame: number; endFrameExclusive: number; frames: number; startSample: number; endSampleExclusive: number; samples: number }; canvas: { width: number; height: number }; media: { requested: string } } };
    assert.equal(report.format, "cut-preview-report");
    assert.equal(report.status, "pass");
    assert.equal(report.manifest.format, "cut-reference-range-preview");
    assert.deepEqual(report.manifest.range, { semantics: "half-open", start: { numerator: "1", denominator: "4" }, end: { numerator: "3", denominator: "4" }, duration: { numerator: "1", denominator: "2" }, firstFrame: 1, endFrameExclusive: 3, frames: 2, startSample: 12_000, endSampleExclusive: 36_000, samples: 24_000 });
    assert.deepEqual(report.manifest.canvas, { sourceWidth: 128, sourceHeight: 72, width: 64, height: 36, resize: "lanczos3-v1", aspect: "preserved-exactly" });
    assert.equal(report.manifest.media.requested, "proxy");
    assert.ok((await readFile(join(workspace, "review/range.mp4"))).byteLength > 0);
    assert.ok((await readFile(join(workspace, "review/range.mp4.manifest.json"))).byteLength > 0);
    const legacy = JSON.parse((await run(["preview", "main.cut", "--lock", "cut.lock", "--out", "review/full.mp4", "--json"], workspace)).stdout) as { manifest: { format: string; version: number; lock: { sha256: string }; duration: number; canvas: { width: number; height: number } } };
    const lockSha256 = createHash("sha256").update(await readFile(join(workspace, "cut.lock"))).digest("hex");
    assert.deepEqual({ format: legacy.manifest.format, version: legacy.manifest.version, lock: legacy.manifest.lock, duration: legacy.manifest.duration, width: legacy.manifest.canvas.width, height: legacy.manifest.canvas.height }, { format: "cut-reference-render", version: 11, lock: { sha256: lockSha256 }, duration: 1, width: 128, height: 72 }, "preview without range/width must retain the lock-bound full-render path");
    for (const flag of ["--range", "--width"]) {
      const rejected = await run(["render", "missing.cut", flag, flag === "--range" ? "0s:1s" : "64", "--out", "x.mp4"], workspace, 1);
      assert.match(rejected.stderr, new RegExp(`CUTC1001: Unknown option "${flag}" for render`));
      assert.doesNotMatch(rejected.stderr, /ENOENT|no such file/i, "render must reject preview-only options before file access");
    }
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("fmt offers deterministic check, stdout, and atomic in-place workflows", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cut-cli-format-"));
  const path = join(workspace, "ugly.cut");
  const source = 'cut 0.4;project "Format CLI";import{Text}from"cut:visual";timeline main(duration:1s,fps:24){scene one(duration:1s){Text(content:"Hello");}}export out=render(main);';
  try {
    await writeFile(path, source);
    const needed = JSON.parse((await run(["fmt", "ugly.cut", "--check", "--json"], workspace, 2)).stdout) as { format: string; status: string; changed: boolean };
    assert.deepEqual(needed, { changed: true, format: "cut-format-report", program: "ugly.cut", status: "needs-format", version: 1 });
    const stdout = await run(["fmt", "ugly.cut", "--stdout"], workspace);
    assert.match(stdout.stdout, /timeline main\(duration: 1s, fps: 24\) \{/);
    assert.equal(await readFile(path, "utf8"), source, "stdout mode must not edit source");
    const written = JSON.parse((await run(["fmt", "ugly.cut", "--json"], workspace)).stdout) as { status: string };
    assert.equal(written.status, "formatted");
    assert.equal(await readFile(path, "utf8"), stdout.stdout);
    const clean = JSON.parse((await run(["fmt", "ugly.cut", "--check", "--json"], workspace)).stdout) as { status: string; changed: boolean };
    assert.deepEqual(clean, { changed: false, format: "cut-format-report", program: "ugly.cut", status: "unchanged", version: 1 });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("every canonical command rejects unknown options before doing work", async () => {
  const cases: Array<{ command: string; args: string[] }> = [
    { command: "help", args: ["help", "--bogus"] },
    { command: "version", args: ["--version", "--bogus"] },
    { command: "init", args: ["init", "film", "--bogus"] },
    { command: "project", args: ["project", ".", "--bogus"] },
    { command: "fmt", args: ["fmt", "missing.cut", "--bogus"] },
    { command: "check", args: ["check", "missing.cut", "--bogus"] },
    { command: "lint", args: ["lint", "missing.cut", "--bogus"] },
    { command: "migrate", args: ["migrate", "missing.cut", "--bogus"] },
    { command: "relink", args: ["relink", "missing.cut", "--bogus"] },
    { command: "probe", args: ["probe", "missing.mov", "--bogus"] },
    { command: "lock", args: ["lock", "missing.cut", "--bogus"] },
    { command: "build", args: ["build", "missing.cut", "--bogus"] },
    { command: "inspect", args: ["inspect", "missing.cut", "--bogus"] },
    { command: "test", args: ["test", "missing.cut", "--bogus"] },
    { command: "diff", args: ["diff", "before.cutir.json", "after.cutir.json", "--bogus"] },
    { command: "otio export", args: ["otio", "export", "missing.cut", "--bogus"] },
    { command: "otio import", args: ["otio", "import", "missing.otio", "--bogus"] },
    { command: "preview", args: ["preview", "missing.cut", "--bogus"] },
    { command: "render", args: ["render", "missing.cut", "--bogus"] },
    { command: "package init", args: ["package", "init", "missing", "--bogus"] },
    { command: "package add", args: ["package", "add", "missing", "--bogus"] },
    { command: "package remove", args: ["package", "remove", "missing", "--bogus"] },
    { command: "package list", args: ["package", "list", "--bogus"] },
    { command: "package update", args: ["package", "update", "--bogus"] },
    { command: "package lock", args: ["package", "lock", "--bogus"] },
    { command: "package verify", args: ["package", "verify", "--bogus"] },
  ];
  for (const item of cases) {
    const result = await run(item.args, process.cwd(), 1);
    assert.equal(result.stdout, "", `${item.command} should reserve stdout for successful output`);
    assert.match(result.stderr, /CUTC1001: Unknown option "--bogus"/);
    assert.match(result.stderr, new RegExp(`for ${item.command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\n$`));
    assert.doesNotMatch(result.stderr, /ENOENT|no such file|OPENAI_API_KEY|FFmpeg/i, `${item.command} must reject options before doing work`);
  }
});

test("CLI option diagnostics have stable codes and JSON form", async () => {
  const unknown = JSON.parse((await run(["doctor", "--bogus", "--json"], process.cwd(), 1)).stdout) as {
    format: string;
    version: number;
    command: string;
    status: string;
    diagnostics: Array<{ code: string; severity: string; message: string }>;
  };
  assert.deepEqual(unknown, {
    format: "cut-cli-diagnostics",
    version: 1,
    command: "doctor",
    status: "fail",
    diagnostics: [{ code: "CUTC1001", severity: "error", message: 'Unknown option "--bogus" for doctor.' }],
  });

  const duplicate = JSON.parse((await run(["doctor", "--json", "--json"], process.cwd(), 1)).stdout) as { diagnostics: Array<{ code: string }> };
  assert.equal(duplicate.diagnostics[0]?.code, "CUTC1002");
  assert.match((await run(["probe", "media.mov", "--out"], process.cwd(), 1)).stderr, /CUTC1003/);
  assert.match((await run(["doctor", "surprise"], process.cwd(), 1)).stderr, /CUTC1004/);
  const missing = JSON.parse((await run(["check", "--json"], process.cwd(), 1)).stdout) as { diagnostics: Array<{ code: string }> };
  assert.equal(missing.diagnostics[0]?.code, "CUTC1005");
});

test("legacy namespace options are closed before model or media work", async () => {
  const result = await run(["legacy", "ingest", "missing.mov", "--bogus"], process.cwd(), 1);
  assert.match(result.stderr, /^cut: CUTC1001: Unknown option "--bogus" for legacy ingest\.\n$/);
  assert.doesNotMatch(result.stderr, /ENOENT|OPENAI_API_KEY|probing|indexing/i);
});
