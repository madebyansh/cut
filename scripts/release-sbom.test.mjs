import assert from "node:assert/strict";
import test from "node:test";
import { auditReleaseSbom, ReleaseSbomAuditError } from "./release-sbom.mjs";

const packageJson = Object.freeze({
  name: "cut-lang",
  version: "0.4.0-alpha.2",
  dependencies: { alpha: "1.0.0" },
});
const alphaIntegrity = `sha512-${Buffer.from("a".repeat(64)).toString("base64")}`;
const optionalIntegrity = `sha512-${Buffer.from("b".repeat(64)).toString("base64")}`;
const shrinkwrap = Object.freeze({
  name: "cut-lang",
  version: "0.4.0-alpha.2",
  lockfileVersion: 3,
  packages: {
    "": { name: "cut-lang", version: "0.4.0-alpha.2", dependencies: { alpha: "1.0.0" } },
    "node_modules/alpha": {
      version: "1.0.0",
      integrity: alphaIntegrity,
      license: "MIT",
      optionalDependencies: { "optional-native": "2.0.0" },
    },
    "node_modules/optional-native": {
      version: "2.0.0",
      integrity: optionalIntegrity,
      license: "Apache-2.0",
      optional: true,
    },
  },
});

function hex(byte) {
  return byte.repeat(64);
}

function component(name, version, extras = {}) {
  const content = name === "alpha" ? hex("61") : hex("62");
  return {
    "bom-ref": `${name}@${version}`,
    type: "library",
    name,
    version,
    scope: name === "optional-native" ? "optional" : "required",
    purl: `pkg:npm/${name}@${version}`,
    properties: [],
    hashes: [{ alg: "SHA-512", content }],
    licenses: [{ license: { id: name === "alpha" ? "MIT" : "Apache-2.0" } }],
    ...extras,
  };
}

function fixture() {
  const alpha = component("alpha", "1.0.0");
  const optional = component("optional-native", "2.0.0");
  const development = component("dev-only", "3.0.0", {
    properties: [{ name: "cdx:npm:package:development", value: "true" }],
  });
  return {
    "$schema": "http://cyclonedx.org/schema/bom-1.5.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: "urn:uuid:first",
    version: 1,
    metadata: {
      timestamp: "2026-01-01T00:00:00.000Z",
      component: {
        "bom-ref": "cut-lang@0.4.0-alpha.2",
        type: "library",
        name: "cut-lang",
        version: "0.4.0-alpha.2",
        purl: "pkg:npm/cut-lang@0.4.0-alpha.2",
      },
    },
    components: [development, optional, alpha],
    dependencies: [
      { ref: "dev-only@3.0.0", dependsOn: [] },
      { ref: "optional-native@2.0.0", dependsOn: [] },
      { ref: "alpha@1.0.0", dependsOn: ["optional-native@2.0.0"] },
      { ref: "cut-lang@0.4.0-alpha.2", dependsOn: ["dev-only@3.0.0", "alpha@1.0.0"] },
    ],
  };
}

function expectCode(run, code) {
  assert.throws(run, (error) => error instanceof ReleaseSbomAuditError && error.code === code);
}

test("release SBOM exactly reconciles the shrinkwrap closure and canonicalizes generation noise", () => {
  const first = auditReleaseSbom(fixture(), packageJson, shrinkwrap);
  const reordered = fixture();
  reordered.serialNumber = "urn:uuid:second";
  reordered.metadata.timestamp = "2030-12-31T23:59:59.000Z";
  reordered.components.reverse();
  reordered.dependencies.reverse();
  const second = auditReleaseSbom(reordered, packageJson, shrinkwrap);

  assert.equal(first.encoded, second.encoded);
  assert.equal(first.summary.components, 2);
  assert.equal(first.summary.lockedLocators, 2);
  assert.equal(first.summary.graphEdges, 2);
  assert.equal(first.summary.directComponents, 1);
  assert.equal(first.summary.optionalComponents, 1);
  assert.equal(first.summary.developmentComponentsExcluded, 1);
  assert.equal(first.summary.exactShrinkwrapGraph, true);
  assert.doesNotMatch(first.encoded, /dev-only|serialNumber|timestamp/);
});

test("a production-reachable component is retained even when npm conflates it with a development bom-ref", () => {
  const value = fixture();
  value.components.find((entry) => entry.name === "alpha").properties.push({
    name: "cdx:npm:package:development",
    value: "true",
  });
  value.components.find((entry) => entry.name === "alpha").scope = "optional";
  const result = auditReleaseSbom(value, packageJson, shrinkwrap);
  const canonical = JSON.parse(result.encoded);
  const alpha = canonical.components.find((entry) => entry.name === "alpha");
  assert.equal(alpha.scope, "required");
  assert.deepEqual(alpha.properties, []);
});

test("an identical development-only path duplicate is admitted only with identical metadata and graph edges", () => {
  const value = fixture();
  const development = value.components.find((entry) => entry.name === "dev-only");
  development.properties.push({ name: "cdx:npm:package:path", value: "node_modules/first/node_modules/dev-only" });
  value.components.push(structuredClone(development));
  value.components.at(-1).properties.find((entry) => entry.name === "cdx:npm:package:path").value = "node_modules/second/node_modules/dev-only";
  value.dependencies.push({ ref: "dev-only@3.0.0", dependsOn: [] });

  const result = auditReleaseSbom(value, packageJson, shrinkwrap);
  assert.equal(result.summary.developmentComponentsExcluded, 2);
  assert.doesNotMatch(result.encoded, /dev-only|node_modules\/first|node_modules\/second/);
});

test("a development-only duplicate with a conflicting artifact fails closed", () => {
  const value = fixture();
  const development = value.components.find((entry) => entry.name === "dev-only");
  development.properties.push({ name: "cdx:npm:package:path", value: "node_modules/first/node_modules/dev-only" });
  value.components.push(structuredClone(development));
  value.components.at(-1).properties.find((entry) => entry.name === "cdx:npm:package:path").value = "node_modules/second/node_modules/dev-only";
  const conflictingComponent = structuredClone(value);
  conflictingComponent.components.at(-1).hashes[0].content = hex("ff");
  expectCode(() => auditReleaseSbom(conflictingComponent, packageJson, shrinkwrap), "CUT_RELEASE_SBOM_COMPONENT_REFERENCE");
});

test("a development-only duplicate with conflicting graph edges fails closed", () => {
  const value = fixture();
  const development = value.components.find((entry) => entry.name === "dev-only");
  value.components.push(structuredClone(development));
  value.dependencies.push({ ref: "dev-only@3.0.0", dependsOn: ["alpha@1.0.0"] });
  const conflictingGraph = structuredClone(value);
  expectCode(() => auditReleaseSbom(conflictingGraph, packageJson, shrinkwrap), "CUT_RELEASE_SBOM_GRAPH_RECORD");
});

test("an identical expected-production duplicate fails closed", () => {
  const value = fixture();
  value.components.push(structuredClone(value.components.find((entry) => entry.name === "alpha")));
  expectCode(() => auditReleaseSbom(value, packageJson, shrinkwrap), "CUT_RELEASE_SBOM_COMPONENT_DUPLICATE");

  const graphDuplicate = fixture();
  graphDuplicate.dependencies.push(structuredClone(
    graphDuplicate.dependencies.find((entry) => entry.ref === "alpha@1.0.0"),
  ));
  expectCode(() => auditReleaseSbom(graphDuplicate, packageJson, shrinkwrap), "CUT_RELEASE_SBOM_GRAPH_RECORD");
});

test("a mixed development and non-development duplicate fails closed", () => {
  const value = fixture();
  const development = structuredClone(value.components.find((entry) => entry.name === "dev-only"));
  development.properties = development.properties.filter((property) => property.name !== "cdx:npm:package:development");
  value.components.push(development);
  expectCode(() => auditReleaseSbom(value, packageJson, shrinkwrap), "CUT_RELEASE_SBOM_COMPONENT_DUPLICATE");
});

test("release SBOM rejects missing, extra, and drifted production components with stable codes", () => {
  {
    const value = fixture();
    value.components = value.components.filter((entry) => entry.name !== "optional-native");
    expectCode(() => auditReleaseSbom(value, packageJson, shrinkwrap), "CUT_RELEASE_SBOM_COMPONENT_MISSING");
  }
  {
    const value = fixture();
    value.components.push(component("undeclared", "9.0.0", {
      hashes: [{ alg: "SHA-512", content: hex("63") }],
      licenses: [{ license: { id: "MIT" } }],
    }));
    expectCode(() => auditReleaseSbom(value, packageJson, shrinkwrap), "CUT_RELEASE_SBOM_COMPONENT_EXTRANEOUS");
  }
  {
    const value = fixture();
    value.components.find((entry) => entry.name === "alpha").version = "1.0.1";
    expectCode(() => auditReleaseSbom(value, packageJson, shrinkwrap), "CUT_RELEASE_SBOM_COMPONENT_IDENTITY");
  }
  {
    const value = fixture();
    value.components.find((entry) => entry.name === "alpha").hashes[0].content = hex("ff");
    expectCode(() => auditReleaseSbom(value, packageJson, shrinkwrap), "CUT_RELEASE_SBOM_COMPONENT_INTEGRITY");
  }
});

test("release SBOM rejects every missing or extra production graph edge", () => {
  {
    const value = fixture();
    value.dependencies.find((entry) => entry.ref === "cut-lang@0.4.0-alpha.2").dependsOn = [];
    expectCode(() => auditReleaseSbom(value, packageJson, shrinkwrap), "CUT_RELEASE_SBOM_GRAPH_MISMATCH");
  }
  {
    const value = fixture();
    value.dependencies.find((entry) => entry.ref === "optional-native@2.0.0").dependsOn = ["alpha@1.0.0"];
    expectCode(() => auditReleaseSbom(value, packageJson, shrinkwrap), "CUT_RELEASE_SBOM_GRAPH_MISMATCH");
  }
  {
    const value = fixture();
    value.dependencies = value.dependencies.filter((entry) => entry.ref !== "alpha@1.0.0");
    expectCode(() => auditReleaseSbom(value, packageJson, shrinkwrap), "CUT_RELEASE_SBOM_GRAPH_MISSING");
  }
});

test("release SBOM refuses package/shrinkwrap declaration drift and unresolved lock entries", () => {
  expectCode(
    () => auditReleaseSbom(fixture(), { ...packageJson, dependencies: { alpha: "2.0.0" } }, shrinkwrap),
    "CUT_RELEASE_SBOM_LOCK_ROOT",
  );
  const broken = structuredClone(shrinkwrap);
  delete broken.packages["node_modules/optional-native"];
  expectCode(() => auditReleaseSbom(fixture(), packageJson, broken), "CUT_RELEASE_SBOM_LOCK_RESOLUTION");
});
