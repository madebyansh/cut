# MapCamera

`MapCamera` is CUT's bounded retained geographic camera. It projects maps,
routes, route subjects, markers, wavefronts and geographic annotations through
one deterministic Natural Earth coordinate system.

```cut
MapCamera(latitude: 20, longitude: 85, scale: 1.2, bearing: 0deg) {
  Map(detail: "countries")
  Route(points: [[103.8, 1.2], [114.1, 22.3]], stroke: #f97316)
  Marker(longitude: 103.8, latitude: 1.2, radius: 7px)
}
```

## Authoring contract

- `MapCamera` is a scene-root retained owner.
- Geography is expressed as longitude/latitude pairs.
- `scale`, `bearing` and bounded planar `pitch` are animatable.
- Delivery-pixel strokes and marker radii stay visually stable as geography
  moves beneath them.
- `GeoAnnotation` may attach canonical `LocalSpace` content to a geographic
  point.
- `RouteSubject` moves along a route by spherical distance, not projected-path
  percentage.

The camera uses a flat deterministic projection. It is not terrain, a globe,
building geometry, occlusion or lighting.

## Safety and determinism

CUT validates projection denominators, preimage expansion, point-event work,
route samples and raster budgets before allocation. Invalid, non-finite,
off-contract or over-budget graphs fail closed. Pitch zero preserves the exact
north-up arithmetic path; nonzero pitch uses the bounded projective path.

Inspect, diff, lock, frame and render evidence bind the map data, projection
policy, camera state and renderer implementation identity. Static inspect is
planning evidence; it is not a pixel or creative-quality verdict.

## Current limits

MapCamera cannot be nested or precomposed. It does not provide terrain,
arbitrary child transforms, marker text shaping, automatic route selection or
persistent map-camera caching. See [SPEC.md](SPEC.md) for the exact signature,
closed child grammar and numeric ceilings.

Public map-camera tests cover bearing and pitch, inverse bounds, route and
subject execution, annotation placement, cache identity, hostile graphs and
exact frame evidence. These tests prove the mechanics, not editorial taste or
professional-output quality.
