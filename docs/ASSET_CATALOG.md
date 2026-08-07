# Asset catalog and search

CUT asset discovery is an explicit candidate-selection workflow. It is not a
network downloader, a stock-media service, or runtime authority. A human or
coding agent can search a provenance-bearing local catalog, select exact bytes,
copy them into a project, probe them, declare them in typed CUT source, and
then create the only authority the runtime trusts: `cut.lock`.

```sh
cut asset search company-catalog.json --query "cargo ship wake" --kind video
cut asset search company-catalog.json --query "harbour ambience" --kind audio --json
```

The installed package also ships
[`fixtures/asset-catalog.example.json`](fixtures/asset-catalog.example.json), a
runnable search-format fixture with synthetic candidate metadata and no media
bytes or rights grant:

```sh
cut asset search node_modules/cut-lang/docs/fixtures/asset-catalog.example.json \
  --query "cargo ship wake" --kind video --json
```

Use it to verify the CLI contract only. Select real bytes only from a catalog
whose publisher and rights process you have independently approved.

The command performs no network request and writes nothing. It no-follow reads
one bounded strict-JSON file, rejects decoded duplicate keys and unknown fields,
normalizes the query deterministically, and returns at most the requested
number of candidates in stable order. Version 1 admits at most 1 MiB, 1,000
entries, 32 tags per entry, eight query tokens, and 100 returned rows.

## Closed catalog format

The root is `cut-asset-catalog` version 1:

```json
{
  "format": "cut-asset-catalog",
  "version": 1,
  "name": "Production-cleared candidates",
  "description": "Catalog ownership and review policy belongs to its publisher.",
  "entries": [
    {
      "id": "cargo-wake-wide",
      "label": "Cargo vessel and wake, wide",
      "kind": "video",
      "description": "A stable wide shot with clear forward motion.",
      "tags": ["cargo", "ship", "wake", "wide"],
      "downloadUrl": "https://media.example.org/cargo-wake-wide.mov",
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "bytes": 12345678,
      "provenance": {
        "creator": "Example Archive",
        "license": "CC BY 4.0",
        "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
        "sourceUrl": "https://archive.example.org/items/cargo-wake-wide",
        "attribution": "Cargo Wake Wide — Example Archive — CC BY 4.0"
      }
    }
  ]
}
```

`kind` is one of `video`, `audio`, `image`, `font`, `data`, `caption`,
`transcript`, `lut`, or `sequence`. Every entry must carry an exact positive
byte count, lowercase SHA-256, credential-free HTTPS download/source/license
URLs, creator, license and attribution. The catalog identity covers the
normalized complete content. CUT never infers a kind, license, or trust level
from a filename, URL, search rank, or tag.

## Selection to runtime authority

1. Search the catalog and inspect the source page, license, attribution and
   intended use. Search output says `candidate-only-not-runtime-authority`.
2. A human or authorized acquisition tool downloads or copies the selected
   bytes. CUT does not silently fetch them.
3. Verify the downloaded byte count and SHA-256 against the selected catalog
   row. Rights approval remains a human/legal gate.
4. Put the exact bytes under the CUT project, for example
   `assets/cargo-wake-wide.mov`.
5. For media, run `cut probe assets/cargo-wake-wide.mov --project .` and choose
   explicit stream selectors when necessary.
6. Declare the project-local typed asset in concise `.cut` source, then run
   `cut fmt --check`, `cut check`, `cut lint --deny-warnings`, `cut lock`, and
   `cut build`.
7. Commit the source, catalog selection/provenance record when your workflow
   requires it, exact asset bytes or an approved acquisition mechanism, and
   `cut.lock` according to project policy.

Changing catalog metadata does not mutate a project lock. Changing selected
bytes makes the lock stale or fails verification. `cut relink` remains the
explicit dry-run/write path for replacing an already declared project asset.

## VS Code and coding-agent loop

Open the project directory in VS Code, use the shipped CUT syntax package and
snippets, keep reusable components in project modules or locked CUT packages,
and run the commands above in the integrated terminal. Compiler diagnostics are
source-located and stable; an agent should repair the `.cut` source rather than
injecting hidden JSON into the execution graph. See [Editing CUT in VS
Code](EDITOR_VSCODE.md), [Agent guide](AGENT_GUIDE.md), [Packages](PACKAGES.md),
and [CLI reference](CLI.md).

## Deliberate limitations

- No bundled remote marketplace, web crawler, credential store, downloader, or
  license adjudicator.
- No automatic acceptance of a catalog publisher or candidate.
- No filename/co-location guessing and no system-font fallback.
- Search proves deterministic filtering of declared metadata, not suitability,
  factual relevance, sync, visual quality, listening quality, or rights.
