# CUT Language Support for VS Code

This extension provides the deliberately small, reliable editor surface for
typed `.cut` audiovisual source:

- `.cut` file association and TextMate syntax highlighting;
- comments, brackets, indentation, folding behavior, and generic snippets;
- **Format Document** through the installed `cut fmt` implementation;
- source-located Problems from the installed `cut check --json` contract; and
- **CUT: Check Current Document** for an explicit check.

It does not contain a second parser or formatter. CUT source remains canonical,
and the same CLI used by agents and CI owns formatting and diagnostics.

## Requirements

Install a matching pre-1.0 CUT CLI and make its executable visible to the VS
Code workspace extension host. If a terminal can run `cut --version` but VS
Code cannot, set `cut.cli.path` to the executable's absolute path. The setting
accepts one executable path, not a shell command such as `npx cut`.

Open a trusted local folder and a `.cut` file. Diagnostics appear in the
Problems panel after edits and saves. Run **Format Document** or enable the
standard `editor.formatOnSave` setting. Run **CUT: Check Current Document** from
the Command Palette when you want an immediate result.

For a file-backed document, the extension sends the in-memory bytes over stdin
while retaining the real document path: `cut check <path> --stdin --json` and
`cut fmt <path> --stdin --stdout`. That preserves verified package imports and
project-relative identity without writing the dirty buffer behind VS Code's
back. Untitled buffers use a private mode-0600 temporary identity and remove it
in a `finally` path. Every invocation is shell-free and source/output bounded.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `cut.cli.path` | `cut` | Installed CUT executable or absolute executable path |
| `cut.cli.timeout` | `15000` | Bounded formatter/checker runtime in milliseconds |
| `cut.diagnostics.enabled` | `true` | Publish `cut check` results to Problems |
| `cut.diagnostics.delay` | `350` | Debounce after buffer edits in milliseconds |

## Packaging and development

From this directory:

```bash
npm test
npm run package:dry-run
```

The first command validates the manifest, grammar, snippets, CLI bridge,
security invariants, and package whitelist. The second shows the exact clean npm
package payload. A release engineer can build a VSIX with a separately installed
official `@vscode/vsce` tool after the repository release audit. Do not publish
the extension or CUT itself without project-owner approval.

## Honest limitations

This is lexical highlighting plus deterministic CLI integration, not a language
server. There is no hover, semantic completion, rename, or go-to-definition.
Diagnostics require a working local CUT CLI. The Node/CLI bridge and packed
payload are exercised on macOS; an installed VSIX in a real extension host is
not yet proven. Linux should use the same shell-free executable contract but
still needs CI proof, and Windows executable/shim behavior is not yet
release-certified.
Virtual and untrusted workspaces are intentionally disabled because the
extension launches a local tool.

See the repository's `docs/EDITOR_VSCODE.md` for the complete edit/check/preview/
render workflow and troubleshooting guide.
