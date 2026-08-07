# Retained media viewport v1, ordered composition v2, and local compositor V2

Status: executable pre-1.0 slice. This is engineering evidence, not a creative
review pass.

`LocalSpace` can retain one or more locked `Image` or `Video` branches directly
in its declared viewport and compose them with ordinary bounded local visual
siblings in authored order. Each media branch remains deliberately closed:

```cut
LocalSpace(width: 640px, height: 360px, origin: { x: 320px, y: 180px }) {
  Group(x: 24px, scale: 1.08) {
    ColorGrade(exposure: 0.25, saturation: 0.92) {
      Video(
        source: footage,
        range: 2s ..< 6s,
        crop: { x: 8%, y: 0%, width: 84%, height: 100% },
        fit: "cover"
      );
    }
  }
}
```

One historical direct media-bearing child is one branch: up to eight unary `Group`
wrappers, at most one unary `ColorGrade`, and exactly one childless `Image` or
`Video` leaf. Every wrapper and leaf retains its public transform/property
tracks. A LocalSpace may contain up to sixteen such direct branches plus its
ordinary executable Rect/Circle/Path/Text/FlowText/Group/nested-LocalSpace
siblings. Source order is paint order.

The additive local-compositor V2 also admits these maximal unchanged media
islands beneath existing public `Composite`, `Mask`, `ClipPath`, graphical
`ColorGrade`, `Blur`, `Vignette`, `Sharpen`, `Grain`, and `Duotone` nodes. This
is an execution extension, not alternate syntax or a hidden renderer:

```cut
LocalSpace(width: 640px, height: 360px, origin: { x: 320px, y: 180px }) {
  Mask(mode: "alpha", feather: 2px) {
    Blur(radius: 1px) { Video(source: footage, range: 2s ..< 6s, fit: "cover"); }
    ClipPath(points: [
      { x: 40px, y: 30px }, { x: 600px, y: 30px },
      { x: 600px, y: 330px }, { x: 40px, y: 330px }
    ]) { Rect(width: 640px, height: 360px, fill: #ffffff); }
  }
}
```

A media-bearing V2 direct child must actually contain one admitted compositor
operation; a multi-child `Group` alone does not acquire new media semantics.
`Shadow` and `Glow` remain source-located refusals because halo expansion and
clipping are not public. Precomp, ChromaKey, MotionBlur, LUT, TonalCurve,
ColorConvert and all other media-bearing wrappers also fail closed.

`cut check` closes this topology without requiring a lockfile: it validates
the same maximal-island grammar, wrapper set, cycles, operation admission and
per-LocalSpace/per-execution-domain materialization counts. It deliberately
does not invent native dimensions or decode work. `cut lock`, `cut inspect`
against a locked project, preview and render still require the exact resource
SHA-256, selected stream/proxy, probe dimensions, crop/fit result and complete
work/allocation preflight. Asset-free checking therefore improves the normal
authoring order without weakening runtime admission.

## Execution order

The runtime performs one deterministic path:

1. Resolve the exact locked resource, selected master/proxy variant and video
   stream. Validate native dimensions and work budgets before opening bytes.
2. Decode the selected video frame at native selected-stream dimensions, or
   decode the single locked image. Apply the normalized crop in native pixels.
3. Apply the optional `ColorGrade` to the cropped pixels.
4. Resize to the admitted contain/cover/fill dimensions. Cover overscan remains
   retained until the final viewport clip.
5. Compose the leaf/wrapper affine stack and opacity. Sample it once into the
   LocalSpace viewport with CUT's Q16 matrix boundary and alpha-associated
   bilinear filter, returning straight RGBA with hidden RGB cleared.
6. For V2, execute inner local effects, mask/clip/composite and finishing
   wrappers child-first on exact LocalSpace-sized surfaces. For historical
   direct branches this step is absent, preserving their pixels and identity.
7. Source-over each completed direct child in exact authored order using CUT's
   linear-light straight-alpha compositor. Opacity is applied once. Skipped
   children allocate and composite nothing.
8. Place the completed LocalSpace tile through its existing owner semantics,
   including the closed direct scene-root pure Visual-component owner. That
   owner is unary and equal-interval and accepts only fragment
   `opacity`/`x`/`y`/`scale`/`rotation`; component nesting,
   LocalSpace/body siblings, composition-root use, anchor, and skew remain
   unsupported.

Before this tile path is requested, its affine placement participates in the
single composition-frame LocalSpace aggregate with every other retained affine
owner, including actual nested parent-LocalSpace destinations and each executed
MotionBlur shutter sample. The aggregate admits at most 256 visible transforms,
1 GiB of live outputs, and 2 GiB of unscheduled peak work. Zero-skew requests
preserve V2 identity; a nonzero-skew request uses the installed V3
scale -> simultaneous-shear -> rotation work model. This does not admit the
otherwise unsupported ordinary `MotionBlur -> Group -> LocalSpace` chain.

The source is never rasterized at delivery-composition dimensions on this
path. Off-interval, zero-opacity and fully off-viewport states are resolved
before decode/allocation for the frame. An active affine is quantized and
checked for singularity before a source is opened; an eight-level small-scale
chain that collapses at Q16 therefore fails source-located instead of decoding
media and failing late.

`Video.crop` is also available outside LocalSpace and shares `Image.crop`'s
exact `NormalizedCrop` type and pixel quantization. A crop must contain exactly
`x`, `y`, `width`, and `height` ratios, stay inside the source, and have positive
extent. `{ x: 0%, y: 0%, width: 100%, height: 100% }` is rejected as a no-op.

## Identity and inspection

For an exact singular legacy topology, `cut inspect` continues to expose the
native dimensions, normalized and decoded crop, selected variant, source
SHA-256, viewport, fit result, wrapper grammar, resampling algorithm, work
ceiling and semantic identity under `localSpace.retainedMediaViewport` through
the current direct-media planner. One branch plus overlays keeps that singular
alias, and preserved V1 receipts remain readable through the closed historical
schema branch. The repository does not contain provenance-backed pre-V2 direct
Image and Video plan-hash goldens, so byte-identical historical plan-identity
compatibility remains partial and unclaimed. Any mixed or multi-media graph also
exposes `localSpace.retainedMediaComposition`: ordered child roles/content
hashes, every independent branch plan, aggregate native/crop/fit/viewport/work
admission, straight-alpha source-over policy, zero delivery-composition
preraster and its additive v2 identity.

An exact-frame render additionally writes
`execution.retainedMediaViewports[]` in the public
`cut-reference-frame` v2 manifest. Unlike inspect's conservative estimate,
this is same-invocation evidence. It records the selected variant and hash,
selected absolute video stream plus a full executable video-config identity
(range, cadence, color interpretation, fit/crop, loop/hold and timing),
native/crop/fitted/viewport geometry, sampled Q16 affine, actual output bounds,
source opens and decoded-frame/surface counts, exact RGBA allocation bytes,
fit plus final-affine resample invocations, zero composition-preraster
allocations, plan/work identities and the resulting viewport RGBA hash. The
closed JSON schema rejects unknown, missing and out-of-range counter fields;
runtime receipt construction records the reference renderer's supplied logical
counters, but JSON validation does not recompute them.

Mixed/multi-layer execution additionally writes
`execution.retainedMediaCompositions[]`. Each completed receipt binds the
admitted source order, rendered/skipped outcome and RGBA hash for every media
or ordinary child, each rendered media child's v1 execution identity, actual
source-over step count, the final bounded LocalSpace tile RGBA hash, and zero
delivery-composition preraster. Branch and composition receipts are staged and
published only after the whole frame succeeds; a later sibling failure cannot
leak partial evidence.

Media beneath admitted local wrappers additionally writes
`execution.retainedMediaLocalCompositors[]`. Its static plan binds direct-child
roles, every maximal historical media island, the wrapper tree, public local
operation identities, source-over work and a deliberately conservative live-
surface/byte ceiling. Inspection order is authored preorder; execution is
child-first postorder. The completed receipt requires one runtime-derived
status for every planned island and operation. Rendered entries bind RGBA and
execution identities; skipped entries bind one of the closed inactivity,
opacity or output-bounds reasons. A mixed direct-V1 plus V2 tile must link the
separate ordered-composition execution and allocation identity to the exact
same final-tile hash.

Inside the reference renderer, the viewport receipt is issued by the same
high-level operation that performs the final affine raster, and the ordered-
composition receipt is issued by the operation that performs the actual
source-over loop. Their live links are process-local, exact-object and one-use;
a cloned, rehashed or reused branch/composition receipt cannot authorize a V2
aggregate receipt. This is runtime self-consistency, not a cryptographic media
attestation. The exported final V2 aggregation helper still accepts operation
records and a final-tile hash from its renderer caller; a persisted receipt or
JSON Schema validation alone therefore does not authenticate wrapper pixels,
decoder provenance or native allocation history. Cold rendering from the
locked source with exact pixel/frame assertions remains the proof boundary.

The conservative live-surface estimate intentionally assumes all admitted
tree-node tile surfaces plus the named logical crop/fit/viewport/operator RGBA8
surfaces may coexist. The serialized runtime normally releases children
earlier, so this can reject a graph whose actual logical peak would be lower.
Sharp/libvips/native scratch is governed by separate native-dimension and work
bounds and is not byte-accounted by this number. This is therefore a bounded
logical-surface estimate, not a proof of total process peak memory.

Render/build/cache identity binds:

- selected resource bytes, absolute stream, complete executable Video config,
  decoded-cadence witness and master/proxy variant;
- normalized and integer crop;
- contain/cover/fill result and viewport;
- every retained transform/property signal and the optional grade;
- algorithm and Sharp/libvips backend identities.

Changing crop, fit, source, stream, cadence, color interpretation, proxy
selection, grade or affine invalidates the affected branch and picture graph.
An ordinary overlay edit leaves unrelated v1 branch identities stable while
invalidating the ordered-composition and final LocalSpace tile identities.
Audio-only changes retain the existing picture-cache projection. Executable
tests prove those identities participate in scene-local picture-cache
invalidation. They do not yet prove a dedicated persistent V2 tile cache trace
or a generalized V2 semantic-diff contract.

Admission is bounded before a verified locator, image decode, or FFmpeg reader
opens: sixteen media materialization islands per LocalSpace, sixty-four per
concurrently renderable scene/composition-root domain, and aggregate
native/crop/fit/viewport-byte/pixel-work ceilings. Sequential scenes are
separate execution domains. When one renderer is reused across scenes, CUT
awaits closure of the prior scene's ordinary and retained video readers and
clears scene-owned static media caches; same-scene frames keep decoder clocks
and hold reuse.

## Current boundary

This slice now executes masks/mattes, the documented blend modes, static
ClipPath and the admitted local finishing chain around retained media. It does
not claim LUT wrappers, nested precomposition media leaves, tracked-media
solve/extraction, motion blur, perspective inside the media island,
focal-aware auto-crop, HDR/log finishing or cross-platform pixel equality.
Excluded forms fail closed rather than falling back to a delivery-sized hidden
render. The retained-media compositor remains pre-1.0 until concrete shot
studies expose and close those boundaries. The current source/test suite proves
direct retained Image/Video viewports, source-ordered legacy composition and V2
wrapper execution with generated redistributable fixtures. It does **not** yet
contain two unrelated public, rights-cleared study projects that exercise V2
media beneath those wrappers. The preserved `line-in-dispatch` generated-source
iteration is engineering/failure evidence only and has an explicit rights
failure; vector-only or ordinary LocalSpace studies are not V2 media proof.
Accordingly the public-study/generality proof is missing, and no execution
receipt substitutes for full-speed playback, headphone listening or creative
review.
