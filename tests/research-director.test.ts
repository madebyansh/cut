import test from "node:test";
import assert from "node:assert/strict";
import { assertSafeResearchUrl, isPublicResearchAddress } from "../lib/research/director";

test("research URL guard rejects local and credentialed targets", () => {
  assert.throws(() => assertSafeResearchUrl("https://localhost/admin"), /Unsafe/);
  assert.throws(() => assertSafeResearchUrl("https://127.0.0.1/admin"), /Unsafe/);
  assert.throws(() => assertSafeResearchUrl("https://10.0.0.1/admin"), /Unsafe/);
  assert.throws(() => assertSafeResearchUrl("https://[::1]/admin"), /Unsafe/);
  assert.throws(() => assertSafeResearchUrl("https://[::ffff:7f00:1]/admin"), /Unsafe/);
  assert.throws(() => assertSafeResearchUrl("https://user:pass@example.com/"), /Unsafe/);
  assert.throws(() => assertSafeResearchUrl("https://example.com:8443/"), /Unsafe/);
  assert.equal(assertSafeResearchUrl("https://www.eia.gov/report").hostname, "www.eia.gov");
});

test("research connection pinning classifies public addresses fail-closed", () => {
  for (const address of [
    "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.1.1", "172.16.0.1",
    "192.0.2.1", "192.168.0.1", "198.18.0.1", "224.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:7f00:1", "64:ff9b::7f00:1", "2001:db8::1", "fc00::1", "fe80::1", "ff02::1",
    "not-an-address",
  ]) assert.equal(isPublicResearchAddress(address), false, address);
  for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "2001:4860:4860::8888"]) {
    assert.equal(isPublicResearchAddress(address), true, address);
  }
});
