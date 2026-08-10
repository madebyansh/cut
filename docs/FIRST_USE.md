# First use from an installed CUT package

This is the shortest supported authoring loop for the installed CUT alpha. It
uses the public `cut` executable and ordinary `.cut` source only. VS Code is an
optional text editor around the same CLI; there is no required GUI, private
editor graph, repository checkout, or source-tree runtime import.

## Install and run the asset-free starter

Start in a fresh consumer directory with an exact, hash-verified release
tarball. The acceptance receipt beside a candidate—not its filename or alpha
version—is the authority for `CUT_TARBALL`.

```sh
mkdir cut-consumer && cd cut-consumer
export CONSUMER_ROOT="$PWD"
export CUT_TARBALL=/absolute/path/to/cut-lang-0.4.0-alpha.4.tgz

npm init -y
npm install --ignore-scripts --omit=dev --save-exact "$CUT_TARBALL"
export PATH="$CONSUMER_ROOT/node_modules/.bin:$PATH"
export CUT_PACKAGE_ROOT="$CONSUMER_ROOT/node_modules/cut-lang"

cut --version
cut help --json
cut doctor --json
cut init film --name "First installed CUT project"
cd film

cut project .
cut fmt main.cut --check --json
cut check main.cut --json
cut lint main.cut --deny-warnings --json
cut lock main.cut --out cut.lock --json
cut build main.cut --lock cut.lock --out .cut/graph.cutir.json --json
cut inspect main.cut --lock cut.lock --json
cut test main.cut --lock cut.lock --json

mkdir -p review output
cut frame main.cut --lock cut.lock --output preview --frame 0 \
  --out review/frame-0.png --json
cut contact main.cut --lock cut.lock --output preview --frames 0,12,23 \
  --out review/contact.png --json
cut audition main.cut --lock cut.lock --output preview --samples 0:48000 \
  --out review/first-second.wav --json
cut preview main.cut --lock cut.lock --out review/preview.mp4 --json
cut render main.cut --lock cut.lock --output release \
  --out output/release-cold.mp4 --json > .cut/render-cold.json
cut render main.cut --lock cut.lock --output release \
  --out output/release-warm.mp4 --json > .cut/render-warm.json

cut build main.cut --lock cut.lock --out .cut/replay.cutir.json --json
cut diff .cut/graph.cutir.json .cut/replay.cutir.json --json
```

## Optional local semantic footage search

The default package stays lightweight. It ships a locked setup recipe, not the
ML runtime or model weights. On supported macOS or Linux with Node/npm already
installed, explicitly install the local CPU backend once:

```sh
export CUT_FOOTAGE_HOME="$CONSUMER_ROOT/.cut-footage-home" # optional automation isolation
cut footage setup --backend local --json
cut footage doctor --json
```

This setup step requires network access and can install several hundred MB.
Homebrew is not required. Normal indexing and searching are offline and bind the
exact verified runtime, q8 model revision, source hashes, and vector bytes.
Indexing and extraction still need working FFmpeg and ffprobe executables from
any supported installation, so run `cut doctor --json` before real media work.

Copy authorized MP4/MOV source files into the project, then run the complete
candidate-to-clip handoff:

```sh
mkdir -p media .cut/footage selects
cp /absolute/path/to/authorized/dog-source.mp4 media/dog-source.mp4

cut footage index media/ --out .cut/footage/index.json --json
cut footage search .cut/footage/index.json --query "a dog outdoors" \
  --out .cut/footage/search.json --json
cut footage extract .cut/footage/search.json --match 1 --handles 1s \
  --out selects/dog.mp4 --json
```

Inspect `.cut/footage/search.json` before extraction when editorial judgement
matters. Search results are candidates, not timeline edits. Extraction writes a
new clip plus `selects/dog.mp4.cut-footage.json`; it refuses to replace either
leaf. The extracted candidate is deliberately picture-only: source audio is
removed so editorial audio must be selected and authored explicitly. Run
`cut footage index` again after source bytes change, and rerun setup
when doctor says the immutable backend is missing. If doctor reports an invalid
or identity-mismatched immutable backend, point `CUT_FOOTAGE_HOME` at a new
empty absolute directory, then run setup again; CUT deliberately does not
delete or overwrite an existing backend tree automatically.

## Transparent cold-to-warm cache workflow

The two `render` commands above are the installed cache workflow; CUT does not
require a separate cache-management command. In the fresh project, the first
JSON report has `status: "pass"`, picture `manifest.cache.hits: 0`, one or more
`manifest.cache.misses`, and only `"miss"` scene rows. The second command must
also exit 0, produce byte-identical media, and report zero picture misses with
the corresponding verified `"hit"` rows. A corrupt or identity-stale cache
artifact is never a hit: CUT either rebuilds it under the closed runtime policy
or fails without publishing the requested output. The JSON field names and
success/failure exit behavior are part of the installed CLI contract; cache
reuse does not change the source, lock, IR, or output meaning.

The release verifier recomputes both output SHA-256 values and the cold/warm
cache counters from the exact installed tarball. Do not infer a hit from faster
wall time or from a cache file merely being present.

Open `film` in VS Code if desired. Install the separately audited VSIX, or use
the bundled extension source only for local development. Problems delegates to
`cut check <actual-path> --stdin --json`; Format Document delegates to
`cut fmt <actual-path> --stdin --stdout`. If the extension host does not inherit
the terminal `PATH`, set `cut.cli.path` to the absolute installed executable.
Do not put `npx`, arguments, redirects, or a repository script in that setting.

## Discover, select, declare, and lock an asset

`cut asset search` returns candidates. It does not download bytes, decide
rights, or grant runtime authority. The selection boundary is deliberately
explicit:

```sh
# Exercise deterministic search immediately from installed, synthetic metadata.
cut asset search "$CUT_PACKAGE_ROOT/docs/fixtures/asset-catalog.example.json" \
  --query "cargo ship wake" --kind video --json

# For real work, search the provenance catalog approved by your organization.
export CUT_ASSET_CATALOG=/absolute/path/to/approved/catalog.json
cut asset search "$CUT_ASSET_CATALOG" \
  --query "cargo ship wake" --kind video --json

# After reviewing the chosen row's creator, source, license and attribution,
# copy its already-authorized exact bytes into this project.
export AUTHORIZED_SOURCE=/absolute/path/to/authorized/cargo-wake.mov
mkdir -p assets .cut
cp "$AUTHORIZED_SOURCE" assets/cargo-wake.mov

# Compare both values with the selected catalog row before continuing.
wc -c < assets/cargo-wake.mov
shasum -a 256 assets/cargo-wake.mov

# Probe the project-local copy and choose the reported absolute stream index.
cut probe assets/cargo-wake.mov --project . \
  --out .cut/cargo-wake.probe.json --json
```

The installed example proves the search format and stable candidate contract;
its rows are deliberately synthetic and authorize no acquisition or use. Never
copy their placeholder URL, hash, byte count, creator, or license into a real
project. The subsequent selection steps apply only to the row chosen from your
approved catalog.

Declare the copied bytes in `main.cut`; do not paste a catalog URL or generated
IR into the graph. For a probe that selected video stream `0`, the declaration
and ordinary visual use are:

```cut
asset cargoWake: VideoAsset = video("assets/cargo-wake.mov", videoStream: 0);

// Inside an authored scene whose duration and source range admit three seconds:
Video(source: cargoWake, range: 0s..<3s, fit: "cover");
```

Then re-establish source and byte authority:

```sh
cut fmt main.cut --check --json
cut check main.cut --json
cut lint main.cut --deny-warnings --json
cut lock main.cut --out cut.lock --json
cut build main.cut --lock cut.lock --out .cut/with-asset.cutir.json --json
cut inspect main.cut --lock cut.lock --json
```

The catalog row remains discovery metadata. `cut.lock` is the runtime
authority. Rights approval remains a separate human/legal decision.

Structured sidecars should use their public nominal declarations—`caption(...)`,
`transcript(...)`, and `lut(...)`—so lock and diagnostics retain the exact
parser policy. Ordered still sequences use `imageSequence(...)` with one
explicit hash-bound manifest and declared `ImageAsset` members; CUT never
guesses an order from filenames or a directory glob. See
[Image sequences](IMAGE_SEQUENCE.md).

## Reuse source instead of copying graph JSON

For one project, put a component in a project-local module:

`lib/badge.cut`:

```cut
cut 0.4;
import { Rect } from "cut:visual";

component Badge(width: Length, color: Color) -> Visual {
  Rect(width: width, height: 36px, fill: color, radius: 8px);
}

export Badge = Badge;
```

Import it from the entry source with the canonical project-root-relative
specifier and invoke it like any other public component:

```cut
import { Badge } from "./lib/badge.cut";

// Inside a scene:
Badge(width: 180px, color: #ef6f4d);
```

Run `cut check`, `cut lint`, `cut lock`, and `cut build` again. CUT records the
module bytes and expanded component provenance; it never executes the module as
JavaScript.

For reuse across projects, the installed package ships a complete local-package
component example. Copy only its installed public bytes into a new consumer
workspace and execute it through package and audiovisual locks:

```sh
cd "$CONSUMER_ROOT"
mkdir -p reuse-demo/packages
cp -R "$CUT_PACKAGE_ROOT/examples/package-proof" reuse-demo/app
cp -R "$CUT_PACKAGE_ROOT/examples/packages/impact-cards" \
  reuse-demo/packages/impact-cards
cd reuse-demo/app

cut package verify --project . --json
cut fmt main.cut --check --json
cut check main.cut --json
cut lint main.cut --deny-warnings --json
cut lock main.cut --out cut.lock --json
cut build main.cut --lock cut.lock --out graph.cutir.json --json
mkdir -p review
cut frame main.cut --lock cut.lock --output preview --frame 0 \
  --out review/package-component.png --json
```

This proves the shipped `@cut-proof/impact-cards` CUT component is expanded and
executed. It does not grant native code execution or imply a registry.

## Recover by diagnostic code

Do not edit CutAVIR, a lock, or a cache entry to silence a failure. Recover at
the authority that owns the diagnostic:

| Diagnostic | Recovery |
| --- | --- |
| `CUTC1001`–`CUTC1007` | The CLI rejected its arguments before project work. Read `cut help --json`, correct the command, and retry. |
| `CUT_EDITOR_CLI_NOT_FOUND`, `CUT_EDITOR_CLI_PATH`, `CUT_EDITOR_CLI_TIMEOUT` | Prove `cut --version` in the integrated terminal, set one absolute `cut.cli.path` if needed, and retry **CUT: Check Current Document**. A timeout remains a failure. |
| `CUT1002`, `CUT2003`, `CUT2004`, `CUT2010`, `CUT2028`, `CUT2029` | Repair the parser, package export, symbol, required argument, or typed quantity at the exact reported source span. Run `cut check <entry> --json` again; do not replace source with generated IR. |
| Source-located parser/type/check diagnostics | Edit the named `.cut` entry, module, or package source at the reported span. Run `cut fmt --check`, `cut check --json`, then strict lint; never patch generated IR. |
| `CUT_PACKAGE_LOCK_MISSING` | Run `cut package lock --project .`, then `cut package verify --project .`. |
| `CUT_PACKAGE_LOCK_STALE` | Restore the declared package bytes, or deliberately accept their change with `cut package update --project .`; then verify and rebuild the audiovisual lock. |
| `CUT_LOCK_IDENTITY`, `CUT_LOCK_INTEGRITY`, `CUT_LOCK_STATE` | Restore the exact source/resource/backend bytes, or make one explicit compatible `cut relink ... --write`/source edit and run `cut lock` again. Never hand-edit `cut.lock`. |
| `CUT_RELINK_*` | The candidate replacement or source edit was refused. Fix the named compatibility/path problem; the default relink is a dry run and `--write` is explicit. |

Commands that create evidence or delivery files refuse unsafe or conflicting
publication. Choose a new output path or preserve/remove the old artifact under
your project policy; do not convert a no-clobber failure into overwrite.

## Current boundary

This path proves installed CLI authoring, not an installed VSIX, a language
server, registry packages, automatic acquisition, rights approval, Windows
media execution, independent-user usability, or human playback. Those remain
separate gates while the package is `0.4.0-alpha.4`.
