import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const expectedCode = "CUT_FOOTAGE_NETWORK_DENIED";

test("the offline preload denies fetch and every supported Node network transport before use", () => {
  const guardPath = resolve("dist-cli", "lib", "footage", "network-deny.js");
  const child = spawnSync(process.execPath, [
    "--import",
    guardPath,
    "--input-type=module",
    "--eval",
    `
      import { createSocket } from "node:dgram";
      import { get as httpGet, request as httpRequest, Agent as HttpAgent } from "node:http";
      import { get as httpsGet, request as httpsRequest, Agent as HttpsAgent } from "node:https";
      import { connect as netConnect, createConnection, Socket } from "node:net";
      import { connect as tlsConnect } from "node:tls";

      const attempts = [
        ["fetch", () => fetch("http://127.0.0.1:9/")],
        ["net.connect", () => netConnect(9, "127.0.0.1")],
        ["net.createConnection", () => createConnection(9, "127.0.0.1")],
        ["net.Socket.connect", () => new Socket().connect(9, "127.0.0.1")],
        ["tls.connect", () => tlsConnect(9, "127.0.0.1")],
        ["http.request", () => httpRequest("http://127.0.0.1:9/")],
        ["http.get", () => httpGet("http://127.0.0.1:9/")],
        ["http.Agent.createConnection", () => new HttpAgent().createConnection({ host: "127.0.0.1", port: 9 })],
        ["https.request", () => httpsRequest("https://127.0.0.1:9/")],
        ["https.get", () => httpsGet("https://127.0.0.1:9/")],
        ["https.Agent.createConnection", () => new HttpsAgent().createConnection({ host: "127.0.0.1", port: 9 })],
        ["dgram.createSocket", () => createSocket("udp4")],
      ];

      const results = [];
      for (const [name, attempt] of attempts) {
        try {
          await attempt();
          results.push({ name, code: "allowed" });
        } catch (error) {
          results.push({ name, code: error?.code ?? "missing" });
        }
      }
      process.stdout.write(JSON.stringify(results));
    `,
  ], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
    timeout: 10_000,
  });

  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
  const results = JSON.parse(child.stdout) as Array<{ name: string; code: string }>;
  assert.equal(results.length, 12);
  assert.deepEqual(new Set(results.map((entry) => entry.code)), new Set([expectedCode]));
});
