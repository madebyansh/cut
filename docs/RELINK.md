# Deterministic asset relinking

`cut relink` changes the project-relative locator of exactly one file-backed
asset declaration. It parses and type-checks the canonical `.cut` source,
probes the replacement as the declared asset kind, and defaults to a dry run.
It does not search for media, copy files, update a lock behind the author's
back, or interpret natural language.

```bash
# Validate the intended one-literal edit. main.cut is not changed.
cut relink main.cut --asset interview --to media/interview-v2.mkv

# Emit the same result as stable JSON for an editor or agent.
cut relink main.cut --asset interview --to media/interview-v2.mkv --json

# Commit only after reviewing the dry run.
cut relink main.cut --asset interview --to media/interview-v2.mkv --write

# For a project without cut.package.json, freeze a new media lock explicitly.
cut check main.cut
cut lock main.cut --out cut.lock

# A packaged entry changes package identity too. Restore trust in this order:
cut package lock --project .
cut check main.cut
cut lock main.cut --out cut.lock
```

The declaration must use one inline locator string:

```text
asset interview: VideoAsset = video("media/interview-v1.mkv");
```

The checked named-argument spelling is also supported:

```text
asset interview: VideoAsset = video(path: "media/interview-v1.mkv");
```

An indirect locator such as `video(INTERVIEW_PATH)` is valid in other parts of
the alpha toolchain but is deliberately refused by relink. Editing a shared
constant could silently change more than the selected asset; relink's public
contract is one declaration and one string literal.

## What is validated

| Constructor | Replacement proof before an edit |
| --- | --- |
| `video` | Bounded `ffprobe`; a video stream with exact positive time base and duration plus dimensions |
| `audio` | Bounded `ffprobe`; an audio stream with exact positive time base and duration plus sample rate/channels |
| `image` | Bounded Sharp/libvips decode; one static image within image limits |
| `font` | Stable regular-file bytes and SHA-256 only, matching the honest lock-v3 coverage |
| `data` | Stable regular-file bytes and SHA-256 only; the consuming component owns schema validation |

The old locator may be missing: repairing an offline or moved source is the
point of relinking. The replacement must already exist as a direct regular file
under the directory containing the `.cut` program. Absolute paths, backslashes,
control characters, empty/dot/parent segments, lexical escape, physical escape,
and every symlink segment are refused. CUT probes and hashes the target before
reporting success.

The source itself must be a regular non-symlink UTF-8 file no larger than 4 MiB.
The operation rechecks the source identity and bytes immediately before commit,
writes and syncs a same-directory staging file with the original permission
mode, and atomically renames it over the source. Observed concurrent source
changes fail with `CUT_RELINK_SOURCE_CHANGED`; CUT never merges them.

## Dry-run and JSON contract

Dry-run is the default and does not create a staging file. A successful report
has `format: "cut-relink-report"`, `version: 1`, and status `dry-run`,
`written`, or `unchanged`. It includes:

- the program basename, asset name/kind/type, and literal line/column;
- old and replacement locators;
- the exact UTF-16 code-unit source span replaced by the compiler frontend;
- source SHA-256 before/after and whether source would change;
- the bounded media/image/byte probe and replacement SHA-256.

Reports intentionally omit the absolute project path and timestamps. JSON is
written to stdout; human diagnostics use stderr. Successful dry-run/write/
unchanged operations exit `0`; validation or write failures exit `1` as a
`cut-cli-diagnostics` document when `--json` is present.

## Stable refusal boundary

The relink layer uses stable `CUT_RELINK_*` diagnostics, including:

- `CUT_RELINK_ASSET_MISSING`, `CUT_RELINK_ASSET_AMBIGUOUS`, and
  `CUT_RELINK_NOT_ASSET` for target selection;
- `CUT_RELINK_LITERAL_REQUIRED` and `CUT_RELINK_SOURCE_INVALID` for source
  shape/type failures;
- `CUT_RELINK_LOCATOR_UNSAFE`, `CUT_RELINK_TARGET_MISSING`,
  `CUT_RELINK_TARGET_SYMLINK`, `CUT_RELINK_KIND_MISMATCH`, and
  `CUT_RELINK_TARGET_INVALID` for replacement validation;
- `CUT_RELINK_SOURCE_UTF8`, `CUT_RELINK_SOURCE_TOO_LARGE`,
  `CUT_RELINK_SOURCE_NOT_REGULAR`, and `CUT_RELINK_SOURCE_CHANGED` for source
  safety;
- `CUT_RELINK_WRITE_FAILED` for an atomic commit failure.

Language diagnostics retain their existing parser/checker codes and exact
spans. Relink errors point at the selected asset locator whenever one exists.

## Lock and cache consequences

`--write` changes canonical source, so an existing audiovisual `cut.lock` is
stale and CUT will refuse it. When the program is the entry of a
`cut.package.json`, the root manifest integrity and `cut.package.lock` are also
stale. Relink never mutates or deletes either trust artifact. For a packaged
entry, run `cut package lock --project .` before `cut check`, then create the
new audiovisual lock with `cut lock`. That new media lock identifies the
replacement source hash, locator, probe, byte length, and SHA-256. Downstream
graph/cache identity changes through ordinary compiler and lock semantics;
there is no private relink cache path or project-specific behavior.

Relink currently covers the five public file-backed asset constructors. It is
not an asset database, proxy manager, package resolver, numbered-sequence
matcher, or bulk rewrite command.
