import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

function source(failing: boolean) {
  return `cut 0.4;
project "formal assertions";
timeline main(duration: 1s, fps: 24) {
  assert 2s == 2s, "duration identity";
  assert 1 == ${failing ? 2 : 1}, "scalar contract";
  scene only(duration: 1s) {}
}
export out = render(main);
`;
}

function cut(args: string[]) {
  return spawnSync(process.execPath, [resolve("dist-cli/cli/cut.js"), ...args], { encoding: "utf8" });
}

test("av-test exposes stable machine assertions and uses exit 2 for contract failures", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "cut-av-test-"));
  const passing = resolve(directory, "passing.cut");
  const failing = resolve(directory, "failing.cut");
  await Promise.all([writeFile(passing, source(false)), writeFile(failing, source(true))]);

  const first = cut(["av-test", passing, "--json"]);
  const replay = cut(["av-test", passing, "--json"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, "");
  assert.equal(first.stdout, replay.stdout);
  assert.doesNotMatch(first.stdout, /\x1b/);
  const passReport = JSON.parse(first.stdout) as { format: string; summary: Record<string, number>; assertions: Array<{ status: string; message: string }> };
  assert.equal(passReport.format, "cut-av-test-report");
  assert.deepEqual(passReport.summary, { deferred: 0, fail: 0, pass: 2, total: 2 });
  assert.deepEqual(passReport.assertions.map((item) => [item.status, item.message]), [["pass", "duration identity"], ["pass", "scalar contract"]]);

  const failed = cut(["av-test", failing, "--json"]);
  assert.equal(failed.status, 2, failed.stderr);
  assert.equal(failed.stderr, "");
  const failReport = JSON.parse(failed.stdout) as { summary: Record<string, number>; assertions: Array<{ status: string }> };
  assert.deepEqual(failReport.summary, { deferred: 0, fail: 1, pass: 1, total: 2 });
  assert.deepEqual(failReport.assertions.map((item) => item.status), ["pass", "fail"]);
});

test("av-test reports an empty authored assertion set without pretending it failed", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "cut-av-test-empty-"));
  const path = resolve(directory, "empty.cut");
  await writeFile(path, 'cut 0.4; project "empty"; timeline main(duration: 1s, fps: 24) { scene only(duration: 1s) {} } export out = render(main);');
  const result = cut(["av-test", path, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).summary, { deferred: 0, fail: 0, pass: 0, total: 0 });
});
