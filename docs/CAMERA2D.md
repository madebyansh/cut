# Retained Camera2D

Status: executable 0.4-alpha engineering slice. This is not a `Camera3D`,
perspective-camera, or creative-quality claim.

`Camera2D` has two explicit execution paths. Existing children keep the legacy
delivery-canvas compositor. A camera whose body contains exactly one direct
`LocalSpace` and no siblings uses the retained local path: CUT materializes the
bounded local tile before applying the camera transform, so local pixels may
begin outside the delivery frame without being clipped by a canvas-sized
temporary.

This component is distinct from
[`MediaCamera2D`](MEDIA_CAMERA2D.md). `Camera2D` transforms a composed visual
container or one retained `LocalSpace`; `MediaCamera2D` reframes one native
post-crop Image/Video branch directly through a single source-resolution
affine sample. Neither name is an alias for the other.

The retained form is a `Camera2D` with optional `x`, `y`, `scale`, `rotation`,
and `opacity` arguments whose only direct child is
`LocalSpace(width:, height:, origin:)`. All five camera properties are public
typed controls and may be driven by CUT signals. No accepted camera property is
ignored. `x` and `y` place the local registration point relative to the
delivery composition centre. `LocalSpace` `origin` identifies that registration
point in the local raster.

The normative transform order is:

1. register the local tile at its authored `origin`;
2. apply uniform `scale`;
3. apply `rotation`;
4. translate the registration point to composition centre plus camera `x/y`;
5. apply `opacity`.

Camera2D does not accept anchor or skew. A forged IR that supplies either fails
with `CUT_CAMERA2D_LOCAL_TRANSFORM`. A retained camera with siblings, an
indirect LocalSpace, or another unsupported graph shape fails source-located
with `CUT_LOCAL_SPACE_GRAPH` or `CUT_CAMERA2D_LOCAL_GRAPH`; it never falls back
silently to delivery-canvas composition. Allocation and transform admission use
the documented LocalSpace limits and `CUT_LOCAL_SPACE_TRANSFORM_LIMIT`.

For a real uniform resize with fractional final Q16 placement, the retained
path samples the original straight-RGBA tile directly into its exact clipped
destination and then places that tight result on delivery. It does not resize
an intermediate and filter it again during translation. An admitted
integer-phase resize preserves the historical Sharp/libvips byte path. If that
historical RGB16 intermediate alone would exceed the unchanged 512 MiB
per-transform ceiling, zero-rotation scale/translation instead uses the same
destination-clipped direct sampler, with conservative work admission followed
by exact clip accounting before raster allocation. Rotation and skew do not
enter that fallback; their existing bounded paths remain explicit.

## Identity and evidence

The algorithm identity is `cut-reference-camera2d-local-space-v1`. Tile identity
depends on local content and exact sample time, but not camera placement.
Changing only camera placement therefore preserves the local-tile identity and
changes the placement identity; changing local paint invalidates both. Current
direct-sampler identity is
`cut-reference-local-space-scale-translation-v2`; the ceiling-triggered
allocator receipt is
`cut-reference-local-space-destination-clipped-transform-work-v1`. Static
inspect reports the local-space node, dimensions, registration, controls,
transform order, work limits, and cache boundary. Completed frame evidence uses
owner `camera-2d` and binds both the placement transform and admitted transform
work.

Executable evidence lives in `tests/reference-camera2d-local-space.test.ts`
and adjacent retained-camera fixtures. The tests prove
off-delivery pixel recovery, animation of every public control, hostile-graph
refusal, localized identity, exact frame-schema receipts, and byte-identical
legacy Camera2D output.

## Honest boundaries

- The retained form is exactly one direct LocalSpace child. Arbitrary nested
  camera graphs, siblings, masks, precompositions, and multiple local tiles are
  not accepted by this branch.
- It is a two-dimensional affine camera: no z coordinate, perspective, orbit,
  lighting, occlusion, lens model, or depth sorting is claimed.
- The bounded tile may contain only the public LocalSpace grammar documented in
  `RETAINED_MEDIA_VIEWPORT.md`; unsupported descendants fail.
- Tile reuse is identity-separated, but persistent cross-frame/cross-process
  local-tile memoization is not claimed.
- An outer legacy materialization boundary may still clip its completed camera
  surface.
- The two fixtures are conformance evidence. Full-speed playback, headphone
  review, independent creative review, and professional-film proof remain
  unperformed.
