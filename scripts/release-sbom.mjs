import { createHash } from "node:crypto";

export class ReleaseSbomAuditError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "ReleaseSbomAuditError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ReleaseSbomAuditError(code, message);
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => canonicalize(entry))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

function record(value, code, label) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(code, `${label} must be a plain dependency record.`);
  }
  const result = {};
  for (const [name, range] of Object.entries(value)) {
    if (typeof name !== "string" || !name || typeof range !== "string" || !range) {
      fail(code, `${label} contains an invalid package name or version range.`);
    }
    result[name] = range;
  }
  return result;
}

function sameRecord(left, right) {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function locatorPackageName(locator) {
  if (typeof locator !== "string" || !locator.startsWith("node_modules/")) {
    fail("CUT_RELEASE_SBOM_LOCK_STRUCTURE", `Shrinkwrap contains an unsupported package locator ${JSON.stringify(locator)}.`);
  }
  const lastNodeModules = locator.lastIndexOf("/node_modules/");
  const tail = lastNodeModules >= 0 ? locator.slice(lastNodeModules + "/node_modules/".length) : locator.slice("node_modules/".length);
  const parts = tail.split("/");
  const name = tail.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  if (!name || (tail.startsWith("@") && parts.length !== 2) || (!tail.startsWith("@") && parts.length !== 1)) {
    fail("CUT_RELEASE_SBOM_LOCK_STRUCTURE", `Shrinkwrap locator is not a canonical npm package path: ${locator}.`);
  }
  return name;
}

function parentPackageLocator(locator) {
  const marker = locator.lastIndexOf("/node_modules/");
  return marker < 0 ? "" : locator.slice(0, marker);
}

function resolveDependency(packages, parentLocator, dependencyName) {
  let current = parentLocator;
  if (current) {
    while (current) {
      const candidate = `${current}/node_modules/${dependencyName}`;
      if (Object.hasOwn(packages, candidate)) return candidate;
      current = parentPackageLocator(current);
    }
  }
  const rootCandidate = `node_modules/${dependencyName}`;
  return Object.hasOwn(packages, rootCandidate) ? rootCandidate : undefined;
}

function npmPurl(name, version) {
  const encodedName = name.startsWith("@")
    ? `%40${encodeURIComponent(name.slice(1).split("/")[0])}/${encodeURIComponent(name.split("/")[1])}`
    : encodeURIComponent(name);
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function integrityHashes(integrity, reference) {
  if (typeof integrity !== "string" || !integrity.trim()) {
    fail("CUT_RELEASE_SBOM_LOCK_INTEGRITY", `Shrinkwrap production component ${reference} has no integrity value.`);
  }
  const hashes = new Map();
  for (const token of integrity.trim().split(/\s+/)) {
    const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(token);
    if (!match) fail("CUT_RELEASE_SBOM_LOCK_INTEGRITY", `Shrinkwrap production component ${reference} has unsupported integrity ${JSON.stringify(token)}.`);
    const bytes = Buffer.from(match[2], "base64");
    if (!bytes.length || bytes.toString("base64").replace(/=+$/, "") !== match[2].replace(/=+$/, "")) {
      fail("CUT_RELEASE_SBOM_LOCK_INTEGRITY", `Shrinkwrap production component ${reference} has malformed base64 integrity.`);
    }
    const expectedBytes = { sha256: 32, sha384: 48, sha512: 64 }[match[1]];
    if (bytes.length !== expectedBytes) {
      fail("CUT_RELEASE_SBOM_LOCK_INTEGRITY", `Shrinkwrap production component ${reference} has a ${match[1]} digest with the wrong byte length.`);
    }
    const algorithm = match[1].toUpperCase().replace(/^SHA(\d+)$/, "SHA-$1");
    hashes.set(`${algorithm}:${bytes.toString("hex")}`, { alg: algorithm, content: bytes.toString("hex") });
  }
  return hashes;
}

function packageIdentity(locator, entry) {
  const name = typeof entry?.name === "string" && entry.name ? entry.name : locatorPackageName(locator);
  if (typeof entry?.version !== "string" || !entry.version) {
    fail("CUT_RELEASE_SBOM_LOCK_STRUCTURE", `Shrinkwrap production locator ${locator} has no exact version.`);
  }
  return { name, version: entry.version, reference: `${name}@${entry.version}` };
}

function dependencyDeclarations(entry, locator) {
  const dependencies = record(entry?.dependencies, "CUT_RELEASE_SBOM_LOCK_STRUCTURE", `${locator}.dependencies`);
  const optionalDependencies = record(entry?.optionalDependencies, "CUT_RELEASE_SBOM_LOCK_STRUCTURE", `${locator}.optionalDependencies`);
  return {
    declarations: { ...dependencies, ...optionalDependencies },
    optionalNames: new Set(Object.keys(optionalDependencies)),
  };
}

function buildExpectedGraph(packageJson, shrinkwrap) {
  if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)
    || typeof packageJson.name !== "string" || !packageJson.name
    || typeof packageJson.version !== "string" || !packageJson.version) {
    fail("CUT_RELEASE_SBOM_PACKAGE_STRUCTURE", "Packed package.json must contain a non-empty name and exact version.");
  }
  if (shrinkwrap?.lockfileVersion !== 3 || !shrinkwrap.packages || typeof shrinkwrap.packages !== "object" || Array.isArray(shrinkwrap.packages)) {
    fail("CUT_RELEASE_SBOM_LOCK_STRUCTURE", "npm-shrinkwrap.json must be a lockfileVersion 3 document with a packages record.");
  }
  const packages = shrinkwrap.packages;
  const root = packages[""];
  if (!root || root.name !== packageJson.name || root.version !== packageJson.version
    || shrinkwrap.name !== packageJson.name || shrinkwrap.version !== packageJson.version) {
    fail("CUT_RELEASE_SBOM_LOCK_ROOT", `Shrinkwrap root identity must exactly match ${packageJson.name}@${packageJson.version}.`);
  }
  const packageDependencies = record(packageJson.dependencies, "CUT_RELEASE_SBOM_PACKAGE_STRUCTURE", "package.json.dependencies");
  const packageOptionalDependencies = record(packageJson.optionalDependencies, "CUT_RELEASE_SBOM_PACKAGE_STRUCTURE", "package.json.optionalDependencies");
  const rootDependencies = record(root.dependencies, "CUT_RELEASE_SBOM_LOCK_STRUCTURE", "shrinkwrap root dependencies");
  const rootOptionalDependencies = record(root.optionalDependencies, "CUT_RELEASE_SBOM_LOCK_STRUCTURE", "shrinkwrap root optionalDependencies");
  if (!sameRecord(packageDependencies, rootDependencies) || !sameRecord(packageOptionalDependencies, rootOptionalDependencies)) {
    fail("CUT_RELEASE_SBOM_LOCK_ROOT", "Shrinkwrap root dependencies and optionalDependencies must exactly match packed package.json.");
  }

  const locatorEdges = new Map();
  const rootEdges = [];
  const queue = [];
  const enqueueRoot = (name, optional) => {
    const locator = resolveDependency(packages, "", name);
    if (!locator) fail("CUT_RELEASE_SBOM_LOCK_RESOLUTION", `Shrinkwrap cannot resolve root production dependency ${name}.`);
    rootEdges.push({ locator, optional });
    queue.push(locator);
  };
  for (const name of Object.keys(packageDependencies).filter((name) => !Object.hasOwn(packageOptionalDependencies, name)).sort()) enqueueRoot(name, false);
  for (const name of Object.keys(packageOptionalDependencies).sort()) enqueueRoot(name, true);

  const locators = new Set();
  while (queue.length) {
    const locator = queue.shift();
    if (locators.has(locator)) continue;
    locators.add(locator);
    if (locators.size > 10_000) fail("CUT_RELEASE_SBOM_RESOURCE_LIMIT", "Production shrinkwrap closure exceeds 10,000 locators.");
    const entry = packages[locator];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail("CUT_RELEASE_SBOM_LOCK_STRUCTURE", `Shrinkwrap production locator ${locator} is not a package record.`);
    }
    packageIdentity(locator, entry);
    const { declarations, optionalNames } = dependencyDeclarations(entry, locator);
    const edges = [];
    for (const name of Object.keys(declarations).sort()) {
      const child = resolveDependency(packages, locator, name);
      if (!child) fail("CUT_RELEASE_SBOM_LOCK_RESOLUTION", `Shrinkwrap cannot resolve ${name} required by ${locator}.`);
      edges.push({ locator: child, optional: optionalNames.has(name) });
      queue.push(child);
    }
    locatorEdges.set(locator, edges);
  }

  // A package is optional only when every path from the root to it crosses an
  // optional edge. Required reachability wins and is propagated transitively.
  const requiredLocators = new Set(rootEdges.filter((edge) => !edge.optional).map((edge) => edge.locator));
  const requiredQueue = [...requiredLocators];
  while (requiredQueue.length) {
    const locator = requiredQueue.shift();
    for (const edge of locatorEdges.get(locator) ?? []) {
      if (edge.optional || requiredLocators.has(edge.locator)) continue;
      requiredLocators.add(edge.locator);
      requiredQueue.push(edge.locator);
    }
  }

  const components = new Map();
  const locatorReference = new Map();
  for (const locator of [...locators].sort()) {
    const entry = packages[locator];
    const identity = packageIdentity(locator, entry);
    locatorReference.set(locator, identity.reference);
    const hashes = integrityHashes(entry.integrity, identity.reference);
    const license = typeof entry.license === "string" && entry.license ? entry.license : undefined;
    const existing = components.get(identity.reference);
    if (existing) {
      if (existing.name !== identity.name || existing.version !== identity.version
        || JSON.stringify([...existing.hashes.keys()].sort()) !== JSON.stringify([...hashes.keys()].sort())
        || existing.license !== license) {
        fail("CUT_RELEASE_SBOM_LOCK_CONFLICT", `Shrinkwrap locators for ${identity.reference} disagree on artifact integrity or license.`);
      }
      existing.locators.push(locator);
      if (requiredLocators.has(locator)) existing.optional = false;
    } else {
      components.set(identity.reference, {
        ...identity,
        hashes,
        license,
        optional: !requiredLocators.has(locator),
        locators: [locator],
      });
    }
  }

  const edges = new Map([...components.keys()].map((reference) => [reference, new Set()]));
  for (const [locator, children] of locatorEdges) {
    const parentReference = locatorReference.get(locator);
    for (const child of children) edges.get(parentReference).add(locatorReference.get(child.locator));
  }
  const rootReferences = new Set(rootEdges.map((edge) => locatorReference.get(edge.locator)));
  return { components, edges, rootReferences, locatorCount: locators.size };
}

function componentLicenses(component) {
  if (!Array.isArray(component?.licenses)) return [];
  return component.licenses.flatMap((entry) => [entry?.license?.id, entry?.license?.name, entry?.expression])
    .filter((value) => typeof value === "string" && value);
}

function hasProperty(component, name, value = "true") {
  return component?.properties?.some((property) => property?.name === name && String(property?.value).toLowerCase() === value);
}

function duplicateComponentProjection(component) {
  return canonicalize({
    ...component,
    properties: Array.isArray(component?.properties)
      ? component.properties.filter((property) => property?.name !== "cdx:npm:package:path")
      : component?.properties,
  });
}

function sameSet(left, right) {
  if (left.size !== right.size) return false;
  return [...left].every((value) => right.has(value));
}

export function auditReleaseSbom(rawSbom, packageJson, shrinkwrap) {
  if (rawSbom?.bomFormat !== "CycloneDX" || rawSbom?.specVersion !== "1.5") {
    fail("CUT_RELEASE_SBOM_FORMAT", `npm produced an unsupported CycloneDX document: ${JSON.stringify({ bomFormat: rawSbom?.bomFormat, specVersion: rawSbom?.specVersion })}.`);
  }
  const expected = buildExpectedGraph(packageJson, shrinkwrap);
  const root = rawSbom?.metadata?.component;
  const expectedRootPurl = npmPurl(packageJson.name, packageJson.version);
  if (root?.version !== packageJson.version || root?.purl !== expectedRootPurl || typeof root?.["bom-ref"] !== "string" || !root["bom-ref"]) {
    fail("CUT_RELEASE_SBOM_ROOT_IDENTITY", `CycloneDX root component must identify exact packed package ${expectedRootPurl}.`);
  }

  const allComponents = Array.isArray(rawSbom?.components) ? rawSbom.components : [];
  const expectedReferences = new Set(expected.components.keys());
  const rawByReference = new Map();
  const rawComponentOccurrences = new Map();
  for (const component of allComponents) {
    const reference = component?.["bom-ref"];
    if (typeof reference !== "string" || !reference) {
      fail("CUT_RELEASE_SBOM_COMPONENT_REFERENCE", `CycloneDX has a missing bom-ref ${JSON.stringify(reference)}.`);
    }
    const occurrences = rawComponentOccurrences.get(reference) ?? [];
    occurrences.push(component);
    rawComponentOccurrences.set(reference, occurrences);
    const existing = rawByReference.get(reference);
    if (existing) {
      // npm may emit one semantically identical development-only component for
      // each installed path. That is the sole duplicate-component exception:
      // production identities and mixed development/production identities stay
      // one-to-one, while the path locator itself is non-semantic generation
      // metadata. The graph pass below independently proves exact shared edges.
      if (expectedReferences.has(reference)) {
        fail("CUT_RELEASE_SBOM_COMPONENT_DUPLICATE", `CycloneDX repeats expected production bom-ref ${JSON.stringify(reference)}.`);
      }
      if (!occurrences.every((entry) => hasProperty(entry, "cdx:npm:package:development"))) {
        fail("CUT_RELEASE_SBOM_COMPONENT_DUPLICATE", `CycloneDX repeats bom-ref ${JSON.stringify(reference)} across development and non-development components.`);
      }
      if (JSON.stringify(duplicateComponentProjection(existing)) !== JSON.stringify(duplicateComponentProjection(component))) {
        fail("CUT_RELEASE_SBOM_COMPONENT_REFERENCE", `CycloneDX repeats bom-ref ${JSON.stringify(reference)} for different component artifacts.`);
      }
      continue;
    }
    rawByReference.set(reference, component);
  }

  const missing = [...expectedReferences].filter((reference) => !rawByReference.has(reference)).sort();
  if (missing.length) fail("CUT_RELEASE_SBOM_COMPONENT_MISSING", `CycloneDX omitted locked production components: ${missing.join(", ")}.`);
  const unexpectedProduction = [...rawByReference]
    .filter(([reference, component]) => !expectedReferences.has(reference) && !hasProperty(component, "cdx:npm:package:development"))
    .map(([reference]) => reference)
    .sort();
  if (unexpectedProduction.length) {
    fail("CUT_RELEASE_SBOM_COMPONENT_EXTRANEOUS", `CycloneDX contains components outside the shrinkwrap production closure: ${unexpectedProduction.join(", ")}.`);
  }

  const components = [];
  const licenseIds = new Set();
  const hashAlgorithms = new Set();
  let optionalComponents = 0;
  for (const [reference, locked] of [...expected.components].sort(([left], [right]) => left.localeCompare(right))) {
    const component = rawByReference.get(reference);
    if (hasProperty(component, "cdx:npm:package:extraneous")) {
      fail("CUT_RELEASE_SBOM_COMPONENT_EXTRANEOUS", `CycloneDX marks locked production component ${reference} as extraneous.`);
    }
    if (component?.name !== locked.name || component?.version !== locked.version || component?.purl !== npmPurl(locked.name, locked.version)) {
      fail("CUT_RELEASE_SBOM_COMPONENT_IDENTITY", `CycloneDX component ${reference} does not match locked ${locked.name}@${locked.version}.`);
    }
    if (!Array.isArray(component.hashes) || !component.hashes.length) {
      fail("CUT_RELEASE_SBOM_COMPONENT_INTEGRITY", `CycloneDX component ${reference} has no artifact hashes.`);
    }
    const actualHashes = new Set();
    for (const hash of component.hashes) {
      if (typeof hash?.alg !== "string" || typeof hash?.content !== "string" || !/^[0-9a-f]+$/i.test(hash.content)) {
        fail("CUT_RELEASE_SBOM_COMPONENT_INTEGRITY", `CycloneDX component ${reference} has a malformed artifact hash.`);
      }
      const algorithm = hash.alg.toUpperCase();
      const expectedHexLength = { "SHA-256": 64, "SHA-384": 96, "SHA-512": 128 }[algorithm];
      if (!expectedHexLength || hash.content.length !== expectedHexLength) {
        fail("CUT_RELEASE_SBOM_COMPONENT_INTEGRITY", `CycloneDX component ${reference} has an unsupported algorithm or wrong-length artifact hash.`);
      }
      const key = `${algorithm}:${hash.content.toLowerCase()}`;
      actualHashes.add(key);
      hashAlgorithms.add(algorithm);
    }
    const missingHashes = [...locked.hashes.keys()].filter((hash) => !actualHashes.has(hash));
    if (missingHashes.length) {
      fail("CUT_RELEASE_SBOM_COMPONENT_INTEGRITY", `CycloneDX component ${reference} does not contain its exact shrinkwrap integrity hash.`);
    }
    const licenses = componentLicenses(component);
    if (!licenses.length) fail("CUT_RELEASE_SBOM_COMPONENT_LICENSE", `CycloneDX component ${reference} has no declared license.`);
    if (locked.license && !licenses.includes(locked.license)) {
      fail("CUT_RELEASE_SBOM_COMPONENT_LICENSE", `CycloneDX component ${reference} license does not match shrinkwrap license ${JSON.stringify(locked.license)}.`);
    }
    for (const license of licenses) licenseIds.add(license);
    if (locked.optional) optionalComponents += 1;
    components.push({
      ...component,
      scope: locked.optional ? "optional" : "required",
      properties: (Array.isArray(component.properties) ? component.properties : []).filter((property) =>
        property?.name !== "cdx:npm:package:development" && property?.name !== "cdx:npm:package:extraneous"),
    });
  }

  const rawDependencies = Array.isArray(rawSbom?.dependencies) ? rawSbom.dependencies : [];
  const rawDependencyByReference = new Map();
  for (const entry of rawDependencies) {
    if (typeof entry?.ref !== "string" || !entry.ref
      || !Array.isArray(entry.dependsOn) || entry.dependsOn.some((reference) => typeof reference !== "string")
      || new Set(entry.dependsOn).size !== entry.dependsOn.length) {
      fail("CUT_RELEASE_SBOM_GRAPH_RECORD", `CycloneDX has a malformed dependency record for ${JSON.stringify(entry?.ref)}.`);
    }
    const existing = rawDependencyByReference.get(entry.ref);
    if (existing) {
      const componentOccurrences = rawComponentOccurrences.get(entry.ref) ?? [];
      if (expectedReferences.has(entry.ref) || componentOccurrences.length < 2
        || !componentOccurrences.every((component) => hasProperty(component, "cdx:npm:package:development"))) {
        fail("CUT_RELEASE_SBOM_GRAPH_RECORD", `CycloneDX repeats dependency record ${JSON.stringify(entry.ref)} outside the identical development-only duplicate policy.`);
      }
      if (!sameSet(new Set(existing.dependsOn), new Set(entry.dependsOn))) {
        fail("CUT_RELEASE_SBOM_GRAPH_RECORD", `CycloneDX repeats dependency record ${JSON.stringify(entry.ref)} with different edges.`);
      }
      continue;
    }
    rawDependencyByReference.set(entry.ref, entry);
  }
  const rootReference = root["bom-ref"];
  const knownRawReferences = new Set([rootReference, ...rawByReference.keys()]);
  for (const entry of rawDependencies) {
    const unknown = entry.dependsOn.filter((reference) => !knownRawReferences.has(reference));
    if (unknown.length) fail("CUT_RELEASE_SBOM_GRAPH_RECORD", `CycloneDX dependency record ${entry.ref} targets unknown components: ${unknown.join(", ")}.`);
  }

  const canonicalDependencies = [];
  const verifyEdges = (reference, expectedEdges) => {
    const raw = rawDependencyByReference.get(reference);
    if (!raw) fail("CUT_RELEASE_SBOM_GRAPH_MISSING", `CycloneDX has no dependency record for production component ${reference}.`);
    const actualProductionEdges = new Set(raw.dependsOn.filter((target) => expectedReferences.has(target)));
    if (!sameSet(actualProductionEdges, expectedEdges)) {
      const missingEdges = [...expectedEdges].filter((target) => !actualProductionEdges.has(target)).sort();
      const extraEdges = [...actualProductionEdges].filter((target) => !expectedEdges.has(target)).sort();
      fail("CUT_RELEASE_SBOM_GRAPH_MISMATCH", `CycloneDX dependency record ${reference} differs from shrinkwrap (missing: ${missingEdges.join(", ") || "none"}; extra: ${extraEdges.join(", ") || "none"}).`);
    }
    canonicalDependencies.push({ ref: reference, dependsOn: [...expectedEdges].sort() });
  };
  verifyEdges(rootReference, expected.rootReferences);
  for (const [reference, edges] of [...expected.edges].sort(([left], [right]) => left.localeCompare(right))) verifyEdges(reference, edges);

  const canonical = canonicalize({
    ...rawSbom,
    serialNumber: undefined,
    metadata: { ...rawSbom.metadata, timestamp: undefined, component: root },
    components,
    dependencies: canonicalDependencies,
  });
  const encoded = `${JSON.stringify(canonical, null, 2)}\n`;
  return {
    encoded,
    summary: {
      format: canonical.bomFormat,
      specification: canonical.specVersion,
      semanticSha256: sha256Text(encoded),
      components: components.length,
      lockedLocators: expected.locatorCount,
      graphEdges: canonicalDependencies.reduce((sum, entry) => sum + entry.dependsOn.length, 0),
      directComponents: expected.rootReferences.size,
      optionalComponents,
      developmentComponentsExcluded: allComponents.filter((component) => !expectedReferences.has(component?.["bom-ref"])).length,
      extraneousComponents: 0,
      licenses: [...licenseIds].sort(),
      hashAlgorithms: [...hashAlgorithms].sort(),
      exactShrinkwrapGraph: true,
      canonicalization: "serial number and generation timestamp removed; production components/scopes/graph reconciled to shrinkwrap; object keys and set-like arrays sorted",
    },
  };
}
