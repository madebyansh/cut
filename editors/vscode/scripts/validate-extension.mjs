import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (path) => JSON.parse(await readFile(join(root, path), "utf8"));
const manifest = await readJson("package.json");
const language = await readJson("language-configuration.json");
const grammar = await readJson("syntaxes/cut.tmLanguage.json");
const snippets = await readJson("snippets/cut.code-snippets");

assert.match(manifest.version, /^0\./, "editor support must remain pre-1.0 until CUT earns 1.0");
assert.equal(manifest.main, "./extension.js");
assert.deepEqual(manifest.contributes.languages[0].extensions, [".cut"]);
assert.equal(manifest.contributes.grammars[0].scopeName, "source.cut");
assert.equal(manifest.contributes.configurationDefaults["[cut]"]["editor.defaultFormatter"], `${manifest.publisher}.${manifest.name}`);
assert.equal(manifest.capabilities.untrustedWorkspaces.supported, false);
assert.equal(manifest.capabilities.virtualWorkspaces, false);

assert.equal(language.comments.lineComment, "//");
assert.ok(language.brackets.length >= 3);
assert.ok(language.indentationRules.increaseIndentPattern);
assert.ok(language.indentationRules.decreaseIndentPattern);
new RegExp(language.wordPattern);
new RegExp(language.indentationRules.increaseIndentPattern);
new RegExp(language.indentationRules.decreaseIndentPattern);

assert.equal(grammar.scopeName, "source.cut");
for (const required of ["comments", "strings", "colors", "language-version", "declarations", "keywords", "numbers", "types", "named-arguments", "function-calls"]) {
  assert.ok(grammar.repository[required], `grammar repository is missing ${required}`);
}
for (const entry of Object.values(grammar.repository)) {
  for (const pattern of entry.patterns || []) {
    if (pattern.match) new RegExp(pattern.match);
    if (pattern.begin) new RegExp(pattern.begin);
    if (pattern.end) new RegExp(pattern.end);
  }
}

assert.ok(Object.keys(snippets).length >= 6);
const snippetText = JSON.stringify(snippets);
for (const projectSpecific of ["GPS", "Planet Has Ears", "Caspian", "Neo"]) {
  assert.ok(!snippetText.includes(projectSpecific), `generic snippets must not contain ${projectSpecific}`);
}

const extensionSource = await readFile(join(root, "extension.js"), "utf8");
const runnerSource = await readFile(join(root, "lib/cut-cli.js"), "utf8");
assert.ok(extensionSource.includes("registerDocumentFormattingEditProvider"));
assert.ok(extensionSource.includes("createDiagnosticCollection"));
assert.ok(runnerSource.includes('["check", path, "--stdin", "--json"]'));
assert.ok(runnerSource.includes('["fmt", path, "--stdin", "--stdout"]'));
assert.ok(!runnerSource.includes("shell: true"), "the editor must not invoke a shell");
assert.ok(!/\beval\s*\(/.test(`${extensionSource}\n${runnerSource}`));

const packagedTopLevel = new Set(manifest.files.map((item) => item.split("/")[0]));
for (const required of ["extension.js", "lib", "syntaxes", "snippets", "language-configuration.json", "README.md", "CHANGELOG.md", "LICENSE"]) {
  assert.ok(packagedTopLevel.has(required), `package files omit ${required}`);
}
const actualTopLevel = new Set(await readdir(root));
for (const entry of packagedTopLevel) assert.ok(actualTopLevel.has(entry), `package entry ${entry} does not exist`);

const packageText = `${JSON.stringify(manifest)}\n${extensionSource}\n${runnerSource}\n${await readFile(join(root, "README.md"), "utf8")}`;
const macUserHomePrefix = `/${"Users"}/`;
assert.ok(!packageText.includes(macUserHomePrefix));
assert.ok(!/(?:sk-|OPENAI_API_KEY\s*=|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY)/.test(packageText));
const vscodeIgnore = await readFile(join(root, ".vscodeignore"), "utf8");
for (const ignored of ["scripts/**", "node_modules/**", "*.tgz", "*.vsix"]) assert.ok(vscodeIgnore.includes(ignored));

console.log(`CUT VS Code support ${manifest.version}: manifest, grammar, snippets, CLI bridge, and package whitelist validated.`);
