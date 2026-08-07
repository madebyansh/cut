import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { parseLockedOpenTypeFont } from "../lib/runtime/reference/locked-font";

const fixture = {
  font: "examples/fixtures/Geist-Regular.ttf",
  license: "examples/fixtures/Geist-LICENSE.txt",
  provenance: "examples/fixtures/README.md",
  fontSha256: "bde046ddd9f20be35b0bd56cc79eb752b967fb6661a3fe76cb067bb09f871d76",
  licenseSha256: "930853ee1daa68554d9e35c8a9175affb74f699fad9a5da6ee5ebe76379d9137",
} as const;

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("the packed Geist fixture has pinned bytes, fixed outlines, provenance, and its exact upstream OFL", async () => {
  const [fontBytes, licenseBytes, provenance, packageSource] = await Promise.all([
    readFile(resolve(fixture.font)),
    readFile(resolve(fixture.license)),
    readFile(resolve(fixture.provenance), "utf8"),
    readFile(resolve("package.json"), "utf8"),
  ]);

  assert.equal(sha256(fontBytes), fixture.fontSha256);
  assert.equal(sha256(licenseBytes), fixture.licenseSha256);
  const font = parseLockedOpenTypeFont(fontBytes, fixture.font, { maxBytes: 8 * 1024 * 1024, maxGlyphs: 100_000 });
  assert.equal(font.font.names.fontFamily.en, "Geist");
  assert.equal(font.font.names.fontSubfamily.en, "Regular");
  assert.match(font.font.names.copyright.en ?? "", /Geist Project Authors/);
  assert.match(font.font.names.license.en ?? "", /SIL Open Font License, Version 1\.1/);

  const license = licenseBytes.toString("utf8");
  assert.match(license, /^Copyright \(c\) 2023 Vercel, in collaboration with basement\.studio/m);
  assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1 - 26 February 2007/);
  assert.match(provenance, new RegExp(fixture.fontSha256));
  assert.match(provenance, new RegExp(fixture.licenseSha256));
  assert.match(provenance, /10dc7658f13c38a474cde201bb09a4617267545b/);

  const packageJson = JSON.parse(packageSource) as { files?: string[] };
  for (const path of [fixture.font, fixture.license, fixture.provenance]) {
    assert.ok(packageJson.files?.includes(path), `packed artifact omits ${path}`);
  }
});
