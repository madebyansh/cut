# Changelog

## 0.4.0-alpha.3

- Align the bundled editor support with the CUT 0.4.0-alpha.3 compiler and runtime identities.

## 0.4.0-alpha.2

- Align the bundled editor support with the CUT 0.4.0-alpha.2 compiler and runtime identities.

## 0.4.0-alpha.1

- Associate `.cut` files with a CUT language mode and lexical grammar.
- Add comments, brackets, indentation, and generic authoring snippets.
- Delegate formatting to `cut fmt <path> --stdin --stdout`.
- Publish stable `cut check <path> --stdin --json` diagnostics in VS Code Problems.
- Preserve real project/package identity for dirty file-backed buffers through
  a bounded, shell-free stdin bridge; untitled buffers retain a private
  temporary identity.

This is pre-1.0 editor support. It does not claim language-server features.
