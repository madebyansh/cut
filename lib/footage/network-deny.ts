import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

const denialCode = "CUT_FOOTAGE_NETWORK_DENIED";
const denialMessage = "local footage inference is offline; network access is disabled.";

function denyNetwork(): never {
  const error = new Error(denialMessage);
  Object.defineProperty(error, "code", {
    value: denialCode,
    enumerable: true,
    configurable: false,
    writable: false,
  });
  throw error;
}

function blockedNetworkCall(..._arguments: unknown[]): never {
  return denyNetwork();
}

function replaceWithBlock(target: object, property: PropertyKey) {
  const current = Object.getOwnPropertyDescriptor(target, property);
  if (!current || current.configurable !== true) {
    throw new Error("local footage offline network guard could not be installed.");
  }
  Object.defineProperty(target, property, {
    value: blockedNetworkCall,
    enumerable: current.enumerable ?? false,
    configurable: false,
    writable: false,
  });
}

function blockOwnDnsQueryMethods(target: object) {
  for (const name of Object.getOwnPropertyNames(target)) {
    const isQuery = name === "reverse" || name.startsWith("lookup") || name.startsWith("resolve");
    if (!isQuery || typeof Object.getOwnPropertyDescriptor(target, name)?.value !== "function") continue;
    replaceWithBlock(target, name);
  }
}

replaceWithBlock(globalThis, "fetch");

replaceWithBlock(net, "connect");
replaceWithBlock(net, "createConnection");
replaceWithBlock(net.Socket.prototype, "connect");
replaceWithBlock(tls, "connect");

replaceWithBlock(http, "request");
replaceWithBlock(http, "get");
replaceWithBlock(http.Agent.prototype, "createConnection");
replaceWithBlock(https, "request");
replaceWithBlock(https, "get");
replaceWithBlock(https.Agent.prototype, "createConnection");
replaceWithBlock(http2, "connect");

replaceWithBlock(dgram, "createSocket");
replaceWithBlock(dgram.Socket.prototype, "bind");
replaceWithBlock(dgram.Socket.prototype, "connect");
replaceWithBlock(dgram.Socket.prototype, "send");

blockOwnDnsQueryMethods(dns);
blockOwnDnsQueryMethods(dnsPromises);
blockOwnDnsQueryMethods(dns.Resolver.prototype);
blockOwnDnsQueryMethods(dnsPromises.Resolver.prototype);

// Built-in ESM named imports are snapshots of the CommonJS module exports.
// Synchronize only after every replacement so later adapter imports see blocks.
syncBuiltinESMExports();

export {};
