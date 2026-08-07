# Impact Cards

`@cut-proof/impact-cards` is a third-party-style local CUT package. Its public
`ImpactCard` component is implemented only with the documented `Rect` and
`Circle` components from `cut:visual`; it has no compiler hook, native module,
hidden JSON graph, network access, or media asset.

The package manifest pins every executable/documentation file by SHA-256. The
consumer in `examples/package-proof` is intentionally outside this directory.
