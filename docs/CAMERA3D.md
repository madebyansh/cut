# Camera3D: bounded retained planar 3D

`Camera3D` is CUT's first executable 3D camera slice. It perspective-projects
two through sixteen retained rectangular `Plane3D` surfaces through one typed
look-at camera and composites the resulting pixels in a deterministic
far-to-near order.

This is useful for spatial journalism, product exploded views, multiplane
titles, diagram fly-throughs and other work made from designed planes. It is
not a mesh renderer, a lighting system, a depth buffer, a camera solver or a
claim of complete 3D.

```cut
import { Camera3D, LocalSpace, Plane3D, Rect } from "cut:visual";
import { inOutCubic } from "@cut/motion";

Camera3D(focalLength: 900px, targetZ: 1200px) as camera {
  Plane3D(x: -180px, z: 900px, rotationY: -8deg, edge: "transparent") as evidence {
    LocalSpace(width: 640px, height: 360px, origin: { x: 320px, y: 180px }) {
      Rect(width: 640px, height: 360px, fill: #f0eadc);
    }
  }
  Plane3D(x: 120px, z: 480px, edge: "transparent") as annotation {
    LocalSpace(width: 240px, height: 96px, origin: { x: 120px, y: 48px }) {
      Rect(width: 240px, height: 96px, fill: #e1523d);
    }
  }
  animate evidence.rotationY from -8deg to 10deg over 4s ease inOutCubic;
  animate annotation.x from 120px to 40px over 4s ease inOutCubic;
}
animate camera.x from -80px to 90px over 4s ease inOutCubic;
```

The fragment assumes an enclosing scene whose duration is `4s`. A camera is
bound in the enclosing scene scope, so camera automation follows its completed
block. A `Plane3D` binding is available inside the camera body after that plane
has been declared; plane automation stays there. `Plane3D` itself contains
exactly one direct `LocalSpace` statement and no automation or siblings.

## Public graph

- `Camera3D` is a direct scene-root visual. It cannot be nested in a Group,
  Precomp, component output, `MotionBlur` or another camera in v1.
- It owns 2 through 16 direct `Plane3D` children.
- Every plane owns exactly one direct `LocalSpace`. The tile may use the
  descendants admitted by the LocalSpace contract; it cannot mix retained and
  delivery-canvas siblings.
- Camera, planes and tiles share one exact half-open interval on the owning
  composition frame grid.
- `focalLength` is required. Camera `x`, `y`, `z`, `targetX`, `targetY`,
  `targetZ` and `roll` are optional typed properties and may be animated.
- Plane `z` and `edge: "transparent"` are required. Plane `x`, `y`,
  `rotationX`, `rotationY`, `rotationZ`, `scale` and `opacity` are optional
  typed properties and may be animated. `edge` is closed and static.
- A plane that has zero opacity or no output intersection on every exact
  output frame is a compile-time no-op error.

Unknown inputs/properties, wrong units, invalid signal payloads, duplicate
ownership and interval mismatch fail with source-located diagnostics. Loaded
CutAVIR is revalidated against the same closed contract; source checking is not
a trust boundary.

## Coordinates and transforms

World and camera coordinates use `x` right, `y` down and `z` away from the
camera. The default camera position is `(0,0,0)` and its default target is
`(0,0,1000)`, so it looks along `+z`. The delivery origin is the composition
centre. Positive roll is clockwise on screen.

The look basis is fixed:

```text
forward = normalize(target - position)
right   = normalize(cross(worldDown, forward))
down    = cross(forward, right)
```

Roll rotates `right` toward `down`. A look direction too nearly parallel to
world-down is refused rather than choosing an implicit alternate up axis.

For a `LocalSpace(width: W, height: H, origin: { x: ox, y: oy })`, the physical
outer-edge rectangle is exactly `[-ox,-oy]..[W-ox,H-oy]`. The transform order
is registration, uniform scale, rotation X, rotation Y, rotation Z, then world
translation. CUT projects each camera-space corner `(x,y,z)` as:

```text
screen.x = composition.width  / 2 + focalLength * x / z
screen.y = composition.height / 2 + focalLength * y / z
```

The four outer corners retain their source TL, TR, BR, BL correspondence. The
existing CUT-owned exact-Q16 homography/raster kernel maps the complete local
tile into that quadrilateral with straight-alpha bilinear sampling and a
transparent edge.

## Visibility and occlusion

All four corners must remain strictly beyond the `1px` camera near plane. v1
does not clip or split a plane crossing the camera. The projected TL, TR, BR,
BL winding must remain positive clockwise in x-right/y-down screen space;
edge-on and back-facing planes fail before allocation.

Occlusion is intentionally conservative and deterministic:

- Exact-Q16 projected quadrilaterals that are disjoint need no depth
  arbitration and retain source-stable ordering.
- Projected quadrilaterals that touch or overlap must have strictly disjoint
  camera-depth intervals. The plane whose entire interval is farther paints
  first.
- Crossing/interpenetrating depth intervals fail with
  `CUT_CAMERA3D_OCCLUSION_UNSUPPORTED`; CUT does not fake a z-buffer.

This admits useful retained multiplane motion while making the missing geometry
class explicit. It does not claim correct self-occlusion, intersecting planes,
meshes, shadows or depth-of-field.

## Work and failure limits

Before frame allocation, CUT validates all exact camera and plane samples,
look basis, near plane, winding, projective coefficients, overlap order and
aggregate work. The current bounded contract includes:

- 2..16 planes per camera;
- focal length `1px..65536px`;
- coordinates within `+/-65536px`, angles within `+/-360000deg`, scale
  `1/1024..64` and opacity `0%..100%`;
- at most 250,000 compile-time camera-frame samples per composition;
- at most 268,435,456 admitted destination pixel tests and 1 GiB of admitted
  destination RGBA bytes per camera frame.

The stable public diagnostic families are `CUT_CAMERA3D_TYPE`,
`CUT_CAMERA3D_GRAPH`, `CUT_CAMERA3D_RANGE`,
`CUT_CAMERA3D_LOOK_AT_UNSUPPORTED`, `CUT_CAMERA3D_NEAR_PLANE_UNSUPPORTED`,
`CUT_CAMERA3D_BACKFACE_UNSUPPORTED`, `CUT_CAMERA3D_OCCLUSION_UNSUPPORTED`,
`CUT_CAMERA3D_PROJECTIVE`, `CUT_CAMERA3D_MOTION_BLUR_UNSUPPORTED`,
`CUT_CAMERA3D_LIMIT` and `CUT_CAMERA3D_NOOP`.

## Inspect, evidence and cache identity

`cut inspect --json` reports `kind: "planar-3d"`, coordinate and transform
conventions, the first exact-frame plan, limits and explicit limitations.
Semantic diff observes camera, plane, signal and retained-tile changes.

For each completed exact frame, frame-manifest v2 may contain a closed
`execution.camera3Ds[]` receipt with sampled camera/plane states, view/world
matrices, exact-Q16 quads and homographies, depth/paint decisions, admitted and
observed pixel work, per-plane tile/warp/canvas hashes and the final RGBA hash.
A failed frame never replaces the last completed receipt with partial work.

Cache dependencies are split deliberately:

- the retained tile identity depends on LocalSpace content, exact time and its
  raster backend;
- projection identity adds sampled camera/plane transforms, opacity,
  homography, output size and backend;
- composite identity adds resolved paint order and projected planes;
- audio identity is unaffected.

Moving a camera therefore does not invalidate independent tile content. Editing
the tile does.

## Honest limitations and review status

The v1 planar slice has no meshes, lights, shadows, z-buffer, near-plane
clipping, backfaces, intersecting geometry, depth-of-field, projective shutter
sampling or outer `MotionBlur`. Color remains within the reference
compositor's documented 8-bit straight-alpha pipeline. It does not solve or
track a camera from footage.

The public regression studies are engineering evidence. Until their complete
full-speed playback, headphone listening where applicable and independent
creative review are recorded, they do not prove a professional film or satisfy
the CUT 1.0 output gate.
