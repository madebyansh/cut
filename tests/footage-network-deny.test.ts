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
      import * as callbackDns from "node:dns";
      import * as promiseDns from "node:dns/promises";
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

      const queryMethods = (prototype) => Object.getOwnPropertyNames(prototype)
        .filter((name) => name === "reverse" || name.startsWith("resolve"))
        .sort();
      const callbackResolverMethods = queryMethods(callbackDns.Resolver.prototype);
      const promiseResolverMethods = queryMethods(promiseDns.Resolver.prototype);
      const callbackResolver = new callbackDns.Resolver();
      callbackResolver.setServers(["127.0.0.1:9"]);
      const promiseResolver = new promiseDns.Resolver();
      promiseResolver.setServers(["127.0.0.1:9"]);
      for (const name of callbackResolverMethods) {
        const query = name === "reverse" ? "127.0.0.1" : "cut-network-deny.invalid";
        attempts.push([
          "dns.Resolver." + name,
          () => callbackResolver[name](query, () => undefined),
        ]);
      }
      for (const name of promiseResolverMethods) {
        const query = name === "reverse" ? "127.0.0.1" : "cut-network-deny.invalid";
        attempts.push([
          "dns/promises.Resolver." + name,
          () => promiseResolver[name](query),
        ]);
      }

      const topLevelResolveTlsa = {
        callback: typeof callbackDns.resolveTlsa === "function",
        promise: typeof promiseDns.resolveTlsa === "function",
      };
      if (topLevelResolveTlsa.callback) {
        attempts.push(["dns.resolveTlsa", () => callbackDns.resolveTlsa("cut-network-deny.invalid", () => undefined)]);
      }
      if (topLevelResolveTlsa.promise) {
        attempts.push(["dns/promises.resolveTlsa", () => promiseDns.resolveTlsa("cut-network-deny.invalid")]);
      }

      const results = [];
      for (const [name, attempt] of attempts) {
        let outcome;
        try {
          outcome = attempt();
        } catch (error) {
          results.push({ name, code: error?.code ?? "missing", delivery: "sync" });
          continue;
        }
        try {
          await outcome;
          results.push({ name, code: "allowed", delivery: "none" });
        } catch (error) {
          results.push({ name, code: error?.code ?? "missing", delivery: "async" });
        }
      }
      callbackResolver.cancel();
      promiseResolver.cancel();
      process.stdout.write(JSON.stringify({
        results,
        callbackResolverMethods,
        promiseResolverMethods,
        topLevelResolveTlsa,
      }));
    `,
  ], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
    timeout: 10_000,
  });

  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
  const report = JSON.parse(child.stdout) as {
    results: Array<{ name: string; code: string; delivery: string }>;
    callbackResolverMethods: string[];
    promiseResolverMethods: string[];
    topLevelResolveTlsa: { callback: boolean; promise: boolean };
  };
  const resultNames = new Set(report.results.map((entry) => entry.name));
  assert.ok(report.callbackResolverMethods.includes("resolve4"));
  assert.ok(report.promiseResolverMethods.includes("resolve4"));
  if (process.versions.node.startsWith("24.")) {
    assert.ok(report.callbackResolverMethods.includes("resolveTlsa"));
    assert.ok(report.promiseResolverMethods.includes("resolveTlsa"));
    assert.deepEqual(report.topLevelResolveTlsa, { callback: true, promise: true });
  }
  for (const name of report.callbackResolverMethods) assert.ok(resultNames.has(`dns.Resolver.${name}`));
  for (const name of report.promiseResolverMethods) assert.ok(resultNames.has(`dns/promises.Resolver.${name}`));
  if (report.topLevelResolveTlsa.callback) assert.ok(resultNames.has("dns.resolveTlsa"));
  if (report.topLevelResolveTlsa.promise) assert.ok(resultNames.has("dns/promises.resolveTlsa"));
  assert.deepEqual(new Set(report.results.map((entry) => entry.code)), new Set([expectedCode]));
  assert.deepEqual(new Set(report.results.map((entry) => entry.delivery)), new Set(["sync"]));
});
