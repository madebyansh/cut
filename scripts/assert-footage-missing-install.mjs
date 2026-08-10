#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const expected = Object.freeze({
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

function fail(message) { throw new Error(`CUT_FOOTAGE_MISSING_INSTALL: ${message}`); }

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export async function assertFootageMissingInstall(reportPath, footageHome) {
  if (typeof reportPath !== "string" || !isAbsolute(reportPath) || typeof footageHome !== "string" || !isAbsolute(footageHome)) {
    fail("report and footage home paths must be absolute");
  }
  const bytes = await readFile(resolve(reportPath));
  if (bytes.byteLength < 1 || bytes.byteLength > 1024 * 1024) fail("doctor report size is invalid");
  const text = bytes.toString("utf8"), canonicalExpected = `${JSON.stringify(canonical(expected))}\n`;
  if (text !== canonicalExpected || text.includes(resolve(footageHome))) fail("doctor report is not the exact missing-install contract");
  try {
    await lstat(resolve(footageHome));
    fail("doctor created the optional footage home");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return Object.freeze({ format: "cut-footage-missing-install-smoke-report", version: 1, status: "pass" });
}

async function main() {
  const [report, home, extra] = process.argv.slice(2);
  if (!report || !home || extra) fail("usage: assert-footage-missing-install.mjs <doctor-report> <absent-footage-home>");
  process.stdout.write(`${JSON.stringify(await assertFootageMissingInstall(resolve(report), resolve(home)))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
