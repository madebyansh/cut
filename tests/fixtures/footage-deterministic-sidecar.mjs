#!/usr/bin/env node

const mode = process.argv[2] ?? "valid";
const digest = (digit) => digit.repeat(64);
const handshake = {
  format: "cut-footage-sidecar-handshake", version: 1, protocolVersion: 1,
  provider: "fixture", model: "deterministic-clip", revision: "r1", dimensions: 4,
  normalization: "l2", modalities: ["image", "text"], hardware: "cpu",
  adapterSha256: digest("a"), selfTestSha256: digest("b"),
};
const line = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const request = (id, operation) => ({ format: "cut-footage-sidecar-response", version: 1, id, operation });

if (mode === "partial-handshake") {
  process.stdout.write('{"format":"cut-footage-sidecar-handshake"');
  process.exit(0);
} else if (mode === "bad-handshake") line({ ...handshake, model: "wrong" });
else line(handshake);

if (mode === "stderr-overflow") process.stderr.write("x".repeat(16_384));
if (mode === "stdout-overflow") process.stdout.write("x".repeat(16_384));
if (mode === "unsolicited") line({ ...request("unsolicited", "searchText"), candidates: [] });
if (mode === "malformed") process.stdout.write("not-json\n");

let input = "";
const requestIds = new Set();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  while (true) {
    const end = input.indexOf("\n");
    if (end < 0) return;
    const raw = input.slice(0, end);
    input = input.slice(end + 1);
    const value = JSON.parse(raw);
    if (!/^footage-[1-9][0-9]*$/u.test(value.id) || requestIds.has(value.id)) {
      line({ format: "cut-footage-sidecar-response", version: 1, id: "bad", operation: "close" });
      continue;
    }
    requestIds.add(value.id);
    if (mode === "timeout" || mode === "signal") continue;
    if (mode === "crash") process.exit(17);
    if (mode === "partial") {
      process.stdout.write(`{"format":"cut-footage-sidecar-response","version":1,"id":${JSON.stringify(value.id)}`);
      process.exit(0);
    }
    if (value.operation === "index") {
      const response = { ...request(value.id, "index"), artifact: { bytes: 12, sha256: digest("c"), recordCount: 3, dimensions: 4 } };
      if (mode === "duplicate") process.stdout.write(`${JSON.stringify(response)}\n${JSON.stringify(response)}\n`);
      else line(mode === "unknown" ? { ...response, surprise: true } : response);
      continue;
    }
    if (value.operation === "searchText") {
      const candidates = mode === "bad-search" ? [{ chunkId: "chunk-1", score: 2 }]
        : mode === "duplicate-search" ? [{ chunkId: "chunk-1", score: 0.75 }, { chunkId: "chunk-1", score: 0.5 }]
          : mode === "many-search" ? [{ chunkId: "chunk-1", score: 0.75 }, { chunkId: "chunk-2", score: 0.5 }]
            : [{ chunkId: "chunk-1", score: 0.75 }];
      line({ ...request(value.id, "searchText"), candidates });
      continue;
    }
    if (value.operation === "close") {
      line(request(value.id, "close"));
      process.exit(0);
    }
  }
});
