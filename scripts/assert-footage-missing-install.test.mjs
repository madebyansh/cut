import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertFootageMissingInstall } from "./assert-footage-missing-install.mjs";

const missingReport = Object.freeze({
  backend: "local",
  checks: [Object.freeze({
    code: "CUTFD1001",
    detail: "The local footage backend is not installed.",
    name: "Local footage backend",
    remedy: "Run cut footage setup --backend local, then rerun footage doctor.",
    status: "fail",
  })],
  format: "cut-footage-local-doctor-report",
  status: "fail",
  version: 1,
});

test("missing-install assertion accepts the exact doctor report without creating the footage home", async () => {
  const root = await mkdtemp(join(tmpdir(), "cut-footage-missing-"));
  const report = join(root, "doctor.json"), home = join(root, "absent-home");
  await writeFile(report, `${JSON.stringify(missingReport)}\n`);
  assert.deepEqual(await assertFootageMissingInstall(report, home), {
    format: "cut-footage-missing-install-smoke-report", version: 1, status: "pass",
  });
});

test("missing-install assertion rejects report drift, private path leaks, and a created home", async () => {
  for (const mutate of [
    (report) => ({ ...report, status: "pass" }),
    (report) => ({ ...report, checks: [{ ...report.checks[0], code: "CUTFD1000" }] }),
  ]) {
    const root = await mkdtemp(join(tmpdir(), "cut-footage-missing-bad-"));
    const reportPath = join(root, "doctor.json"), home = join(root, "absent-home");
    await writeFile(reportPath, `${JSON.stringify(mutate(missingReport))}\n`);
    await assert.rejects(assertFootageMissingInstall(reportPath, home), /CUT_FOOTAGE_MISSING_INSTALL/u);
  }
  const leaked = await mkdtemp(join(tmpdir(), "cut-footage-missing-leak-"));
  const leakedReport = join(leaked, "doctor.json"), leakedHome = join(leaked, "private-home");
  await writeFile(leakedReport, `${JSON.stringify({ ...missingReport, note: leakedHome })}\n`);
  await assert.rejects(assertFootageMissingInstall(leakedReport, leakedHome), /CUT_FOOTAGE_MISSING_INSTALL/u);

  const created = await mkdtemp(join(tmpdir(), "cut-footage-missing-created-"));
  const createdReport = join(created, "doctor.json"), createdHome = join(created, "private-home");
  await writeFile(createdReport, `${JSON.stringify(missingReport)}\n`);
  await mkdir(createdHome);
  await assert.rejects(assertFootageMissingInstall(createdReport, createdHome), /CUT_FOOTAGE_MISSING_INSTALL/u);
});
