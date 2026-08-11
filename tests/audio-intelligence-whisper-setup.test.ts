import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  collectCutWhisperLocalSetup,
  cutWhisperLocalSetupTestOnly,
  type CutWhisperLocalSetupCollectorInput,
} from "../lib/audio-intelligence/whisper-setup";
import { stableJsonStringify } from "../lib/core/stable";
import {
  cutWhisperLocalWorkflowContract,
  cutWhisperLocalWorkflowTestOnly,
  CutWhisperLocalWorkflowError,
  type CutWhisperLocalWorkflowErrorCode,
} from "../lib/audio-intelligence/whisper-workflow";

const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

type Fixture = Readonly<{
  root: string;
  input: CutWhisperLocalSetupCollectorInput;
  modelPath: string;
}>;

function ffmpegSource(version: string, mode: "valid" | "descendant" | "bad-launch" = "valid") {
  if (mode === "bad-launch") return "#!/definitely/missing/cut-node\n";
  return `#!${process.execPath}
const { spawn } = require("node:child_process");
if (${JSON.stringify(mode)} === "descendant") {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
  child.unref();
}
process.stdout.write(${JSON.stringify(`ffmpeg version ${version} fixture\n`)});
`;
}

function whisperSource(modelPath: string, mutate = false) {
  return `#!${process.execPath}
const { appendFileSync } = require("node:fs");
if (${JSON.stringify(mutate)}) appendFileSync(${JSON.stringify(modelPath)}, "mutation\\n");
process.stdout.write(${JSON.stringify(`whisper.cpp version: ${cutWhisperLocalWorkflowContract.whisperVersion}\n`)});
`;
}

async function fixture(options: Readonly<{
  ffmpegVersion?: string;
  ffmpegMode?: "valid" | "descendant" | "bad-launch";
  mutateModel?: boolean;
}> = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cut-whisper-setup-")));
  const ffmpegPath = resolve(root, "ffmpeg");
  const whisperPath = resolve(root, "whisper-cli");
  const modelPath = resolve(root, "base.en-q5_1.bin");
  const version = options.ffmpegVersion ?? "7.1.1";
  const ffmpeg = Buffer.from(ffmpegSource(version, options.ffmpegMode), "utf8");
  const whisper = Buffer.from(whisperSource(modelPath, options.mutateModel), "utf8");
  await Promise.all([
    writeFile(ffmpegPath, ffmpeg, { flag: "wx", mode: 0o700 }),
    writeFile(whisperPath, whisper, { flag: "wx", mode: 0o700 }),
    writeFile(modelPath, Buffer.from("fixture model bytes\n"), { flag: "wx" }),
  ]);
  await Promise.all([chmod(ffmpegPath, 0o700), chmod(whisperPath, 0o700)]);
  return Object.freeze({
    root,
    modelPath,
    input: Object.freeze({
      ffmpeg: Object.freeze({ path: ffmpegPath, version, revision: `ffmpeg-n${version}` }),
      whisperCli: Object.freeze({
        path: whisperPath,
        revision: cutWhisperLocalWorkflowContract.whisperSourceRevision,
        sourceArchiveSha256: cutWhisperLocalWorkflowContract.whisperSourceArchiveSha256,
        buildPolicy: cutWhisperLocalWorkflowContract.whisperBuildPolicy,
      }),
      model: Object.freeze({
        path: modelPath,
        locator: "models/base.en-q5_1.bin",
        name: "base.en-q5_1",
        revision: "fixture-model-r1",
        license: "MIT",
      }),
    }),
  });
}

const collectFixture = (input: CutWhisperLocalSetupCollectorInput) => cutWhisperLocalSetupTestOnly.collectWithDoctor(
  input,
  cutWhisperLocalWorkflowTestOnly.doctorWithFixtureClosure,
);

async function expectFailure(action: () => Promise<unknown>, code: CutWhisperLocalWorkflowErrorCode, message?: RegExp) {
  await assert.rejects(action, (error: unknown) => error instanceof CutWhisperLocalWorkflowError
    && error.code === code && (!message || message.test(error.message)));
}

test("collects exact file authorities, proves the doctor, and returns canonical setup bytes without publication", async () => {
  const value = await fixture();
  try {
    const before = (await readFile(value.modelPath)).toString("utf8");
    const result = await collectFixture(value.input);
    assert.equal(result.doctor.status, "caller-authority-ready");
    assert.equal(result.doctor.whisperCli.verifiedLinkagePolicy, cutWhisperLocalWorkflowContract.whisperLinkagePolicy);
    assert.equal(result.setup.ffmpeg.revision, "ffmpeg-n7.1.1");
    assert.equal(result.setup.whisperCli.sha256, hash(await readFile(value.input.whisperCli.path)));
    assert.equal(result.setup.model.sha256, hash(await readFile(value.modelPath)));
    assert.deepEqual(result.canonicalSetupBytes, Buffer.from(`${stableJsonStringify(result.setup)}\n`, "utf8"));
    assert.equal((await readFile(value.modelPath)).toString("utf8"), before);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("production collector does not replace exact Mach-O linkage proof with the fixture hook", async () => {
  const value = await fixture();
  try {
    await expectFailure(() => collectCutWhisperLocalSetup(value.input), "CUT_WHISPER_WORKFLOW_AUTHORITY", /Mach-O/u);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("rejects symlinks and noncanonical paths before returning setup authority", async () => {
  const value = await fixture();
  try {
    const alias = resolve(value.root, "model-alias.bin");
    await symlink(value.modelPath, alias);
    await expectFailure(() => collectFixture({ ...value.input, model: { ...value.input.model, path: alias } }), "CUT_WHISPER_WORKFLOW_AUTHORITY", /symlink-free/u);
    await expectFailure(() => collectFixture({ ...value.input, model: { ...value.input.model, path: `${value.root}/folder/../base.en-q5_1.bin` } }), "CUT_WHISPER_WORKFLOW_CONTRACT", /canonical absolute/u);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("closed collector input rejects unknown, accessor, hidden, symbol, and proxy fields before I/O", async () => {
  const value = await fixture();
  try {
    const accessor = { ...value.input } as Record<string, unknown>;
    Object.defineProperty(accessor, "ffmpeg", { enumerable: true, get: () => value.input.ffmpeg });
    const hidden = { ...value.input } as Record<string, unknown>;
    Object.defineProperty(hidden, "hidden", { enumerable: false, value: true });
    for (const input of [
      { ...value.input, unknown: true },
      accessor,
      hidden,
      Object.assign({ ...value.input }, { [Symbol("hidden")]: true }),
      new Proxy({ ...value.input }, {}),
      { ...value.input, model: { ...value.input.model, unknown: true } },
    ]) {
      await expectFailure(() => cutWhisperLocalSetupTestOnly.collectWithDoctor(input, async () => assert.fail("doctor must not run")), "CUT_WHISPER_WORKFLOW_CONTRACT");
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("doctor rejects wrong executable version and asynchronous launch failure", async () => {
  const wrong = await fixture({ ffmpegVersion: "7.1.1" });
  const launch = await fixture({ ffmpegMode: "bad-launch" });
  try {
    await expectFailure(() => collectFixture({ ...wrong.input, ffmpeg: { ...wrong.input.ffmpeg, version: "7.2.0" } }), "CUT_WHISPER_WORKFLOW_AUTHORITY", /version/u);
    await expectFailure(() => collectFixture(launch.input), "CUT_WHISPER_WORKFLOW_PROCESS", /failed after launch|unsuccessfully|did not expose one identity/u);
  } finally {
    await Promise.all([rm(wrong.root, { recursive: true, force: true }), rm(launch.root, { recursive: true, force: true })]);
  }
});

test("mutation and a successful process with a surviving descendant fail closed", async () => {
  const mutation = await fixture({ mutateModel: true });
  const descendant = await fixture({ ffmpegMode: "descendant" });
  try {
    await expectFailure(() => collectFixture(mutation.input), "CUT_WHISPER_WORKFLOW_AUTHORITY", /changed during/u);
    await expectFailure(() => collectFixture(descendant.input), "CUT_WHISPER_WORKFLOW_PROCESS", /descendant/u);
  } finally {
    await Promise.all([rm(mutation.root, { recursive: true, force: true }), rm(descendant.root, { recursive: true, force: true })]);
  }
});

test("collector propagates a bounded doctor timeout refusal and never returns unproved bytes", async () => {
  const value = await fixture();
  try {
    await expectFailure(() => cutWhisperLocalSetupTestOnly.collectWithDoctor(value.input, async () => {
      throw new CutWhisperLocalWorkflowError("CUT_WHISPER_WORKFLOW_PROCESS", "local process exceeded its bounded timeout.");
    }), "CUT_WHISPER_WORKFLOW_PROCESS", /timeout/u);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
