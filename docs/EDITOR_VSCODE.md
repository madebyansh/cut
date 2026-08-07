# Editing CUT in VS Code

Status: executable pre-1.0 editor support for the formal CUT 0.4 language.

The extension under [`editors/vscode/`](../editors/vscode/) deliberately keeps
one source of truth. TextMate handles lexical colorization; the installed CUT
CLI handles formatting and checking. There is no private editor parser, hidden
IR, remote model call, or claimed language server.

## Install for a local release candidate

First install the exact audited CUT CLI artifact. For example, after the root
clean-room pack step has produced a tarball:

```bash
npm install --global /absolute/path/to/cut-lang-0.4.0-alpha.1.tgz
cut --version
cut doctor
```

Then validate the extension source:

```bash
cd editors/vscode
npm test
npm run package:dry-run
```

Use the official `@vscode/vsce` package separately to produce a VSIX for the
release-candidate audit. The repository intentionally does not download or
silently execute a packaging dependency, and no VSIX or Marketplace release may
be published without explicit approval.

After installing the audited VSIX, open a trusted local CUT project. If the VS
Code extension host cannot inherit the same `PATH` as your terminal, set
`cut.cli.path` to the absolute CUT executable. Do not put command arguments,
shell redirects, or `npx` in that setting.

## Exact authoring workflow

1. Edit the canonical `.cut` source. Lexical highlighting, line comments,
   brackets, indentation, and snippets work without starting the compiler.
2. Read live Problems. After a short debounce, the extension sends the current
   buffer over stdin and runs `cut check <actual-document-path> --stdin --json`.
   Retaining the real path keeps project-relative and verified package context
   intact without overwriting the saved file. Stable diagnostic codes and spans
   are mapped back to the current buffer.
3. Run **Format Document**. The extension runs `cut fmt file.cut --stdin --stdout` on the
   stdin buffer and returns one VS Code text edit. The project file is changed
   only through VS Code, so undo, dirty-buffer state, package identity, and save
   hooks remain coherent.
4. Run **CUT: Check Current Document** for an immediate, explicit check. A valid
   source reports success; failures remain visible in Problems.
5. Use the integrated terminal for project-level work:

   ```bash
   cut asset search catalog.json --query "interview room tone" --kind audio
   cut fmt main.cut --check
   cut check main.cut
   cut lint main.cut --deny-warnings
   cut lock main.cut --out cut.lock
   cut inspect main.cut --lock cut.lock --json
   cut preview main.cut --lock cut.lock
   cut preview main.cut --lock cut.lock --range 2s:5s --width 640 \
     --out review/range.mp4 --json
   cut render main.cut --lock cut.lock --output release --out output/release.mp4
   cut test main.cut --lock cut.lock --json
   ```

   Asset search returns provenance-bearing candidates only. Copy an authorized
   selection into the project, verify its declared bytes and SHA-256, run
   `cut probe` for media, declare the explicit typed asset, and only then run
   `cut lock`; see [Asset catalog and search](ASSET_CATALOG.md). Keep reusable
   components in project modules or locked CUT packages rather than duplicating
   generated graph JSON. The same source-located diagnostics apply to the entry,
   imported modules, and package source.

   `preview` is an ordinary canonical runtime workflow, not an editor-only
   shortcut. The source must declare the selected preview output and its exact
   dimensions; explicitly authored video/audio proxies are locked and selected,
   and absent proxies report master fallback. `--range` evaluates a selected
   exact half-open interval directly; `--width` requests the public versioned
   review resize with no upscaling or aspect drift. Neither rewrites the CUT
   timeline. The editor extension does not add a private preview backend.

## What the package provides

- `.cut` association and `source.cut` TextMate grammar;
- documented `//` comments, strings and escapes, color literals, exact numeric
  units, declaration/control keywords, types, named arguments, function calls,
  and operators;
- bracket pairing, quote pairing, indentation, and brace-aware enter behavior;
- project, timeline, scene, component, asset, animation, and assertion snippets
  built from generic public language constructs;
- one formatting provider backed by `cut fmt <path> --stdin --stdout`; and
- one diagnostic collection backed by the versioned
  `cut check <path> --stdin --json` report.

No hover, completion, semantic tokens, references, rename, or go-to-definition
is advertised. Those features should arrive only with a tested language server
that reuses the compiler's symbol and diagnostic semantics.

## Security and failure behavior

The extension runs as a workspace extension and declares untrusted and virtual
workspaces unsupported. It passes an argument array directly to the configured
executable with `shell: false`, disables color, caps source at 8 MiB and combined
output at 4 MiB, enforces a configurable 1–120 second timeout, cancels obsolete
checks, validates the JSON report before publishing it, and removes private
temporary directories for untitled buffers in `finally` paths. File-backed
buffers use stdin plus the actual document path and never stage source bytes in
the project directory. Diagnostics from the current module retain their exact
range; a diagnostic owned by an imported package is identified by package path
and source coordinates at the start of the current document instead of being
misrepresented as a range in unrelated source.

An unknown executable, timeout, malformed JSON contract, output overflow, or
unexpected exit becomes an actionable `CUT_EDITOR_*` Problem at the start of
the document. It is never interpreted as a successful check. Diagnostic runs
are generation-guarded so a result from an older buffer is not applied to a
newer edit.

## Troubleshooting

**CUT executable not found.** Run `cut --version` in a terminal, locate the
executable, and set `cut.cli.path` to that absolute file. Restart the extension
host or invoke **CUT: Check Current Document**.

**Formatting refuses malformed syntax.** Fix parser errors first. Type errors do
not prevent deterministic formatting and remain visible through `cut check`.
`cut fmt` is intentionally the only formatter and does not guess around an
unparseable token stream.

**No Problems appear.** Confirm the file language mode is CUT and
`cut.diagnostics.enabled` is true. Run the explicit check command to surface
CLI installation or JSON-contract errors.

**Remote/virtual folder.** The extension is intentionally local-workspace-only
because it must launch the CUT executable next to the workspace environment.

## Release evidence and current exclusions

`tests/vscode-extension.test.ts` runs the real built CLI through the same pure
Node bridge to prove formatter output, language diagnostics, and pre-analysis
`CUT_PACKAGE_*` failures without replacing their stable codes. The extension
validator inspects its manifest, grammar, snippets, shell-free bridge, package
whitelist, private-path hygiene, and secret hygiene; npm's dry-run pack listing
proves the intended extension payload. The root packed-artifact verifier also
runs both checks from the exact installed CUT tarball.

This slice has macOS Node/CLI-bridge and packed-payload evidence. It does not yet
have an installed VSIX or real VS Code extension-host test. Linux editor-host
execution and Windows executable/shim behavior remain explicit release-audit
items. Syntax highlighting is lexical, not proof of a compiler-aware language
server.
