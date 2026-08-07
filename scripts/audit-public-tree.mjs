#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const forbiddenRoots = new Set([
  "evidence", "production", "releases", "submission", "studies", "node_modules", "dist-cli", ".cut",
]);
const forbiddenNames = /^(?:\.env(?:\..+)?|id_(?:rsa|ed25519)|.*\.(?:pem|p12|pfx|key|tgz|cpuprofile))$/iu;
const privatePath = /(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|[A-Z]:\\Users\\[^\\\s]+)/u;
const secrets = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bgh[opusr]_[A-Za-z0-9_]{30,}\b/u,
  /\bsk-[A-Za-z0-9_-]{32,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
];

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function candidateFiles() {
  const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error("CUT_PUBLIC_AUDIT_GIT: git candidate enumeration failed");
  return result.stdout.toString("utf8").split("\0").filter(Boolean).sort();
}

const files = candidateFiles();
const violations = [];
let bytes = 0;
for (const path of files) {
  const parts = path.split("/");
  const state = await lstat(path);
  if (state.isSymbolicLink()) violations.push({ code: "CUTSEC1001", path, reason: "public candidate contains a symbolic link" });
  if (!state.isFile()) continue;
  bytes += state.size;
  if (forbiddenRoots.has(parts[0])) violations.push({ code: "CUTSEC1002", path, reason: "private/generated root is not public source" });
  if (forbiddenNames.test(parts.at(-1) ?? "")) violations.push({ code: "CUTSEC1003", path, reason: "credential, archive, or forensic filename is not public source" });
  if (state.size > 8 * 1024 * 1024) violations.push({ code: "CUTSEC1004", path, reason: "unexpected public source file exceeds 8 MiB" });
  if (state.size > 2 * 1024 * 1024 || path.endsWith(".node") || path.endsWith(".ttf")) continue;
  const content = await readFile(path, "utf8").catch(() => null);
  if (content === null) continue;
  if (privatePath.test(content)) violations.push({ code: "CUTSEC1005", path, reason: "machine-private absolute path" });
  if (secrets.some((pattern) => pattern.test(content))) violations.push({ code: "CUTSEC1006", path, reason: "high-confidence credential material" });
}

const report = {
  format: "cut-public-tree-audit",
  version: 1,
  status: violations.length === 0 ? "pass" : "fail",
  candidate: { files: files.length, bytes, pathListSha256: sha256(files.join("\n")) },
  violations,
  limitations: [
    "Opaque binary files are inventoried but not decoded for embedded text.",
    "This audit does not replace Git history secret scanning or human license review.",
  ],
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (violations.length) process.exitCode = 1;
