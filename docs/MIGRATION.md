# Migrating to CUT 0.4 alpha

CUT 0.4 is the first public source release. It deliberately uses a single
visible version boundary:

| Surface | Current value |
| --- | --- |
| Package | `cut-lang@0.4.0-alpha.2` |
| Source header | `cut 0.4;` |
| Compiler | `cut-ts/0.4.0-alpha.2` |
| Reference runtime | `cut-reference/0.4.0-alpha.2` |
| CutAVIR | version 3, language `0.4` |
| Project/package lock | `cut.lock` v3, language `0.4` |

Pre-public 0.3 source is not rewritten automatically. Change the source header
deliberately, then run the complete source and authority loop:

```sh
cut fmt main.cut --check
cut check main.cut
cut lint main.cut --deny-warnings
cut lock main.cut --out cut.lock
cut build main.cut --lock cut.lock --out .cut/graph.cutir.json
cut test main.cut --lock cut.lock
```

Do not hand-edit old CutAVIR, locks, manifests, or caches to make their version
look current. Regenerate them from the reviewed 0.4 source and exact resources.
If the current checker rejects a removed or changed input, decide the authored
meaning in source; an automatic migration cannot safely invent it.

Because this is alpha software, future releases may require the same explicit
source review and relock process. Compatibility guarantees will be documented
before 1.0.
